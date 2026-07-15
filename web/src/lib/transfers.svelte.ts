// Upload + download transfer queue + engine (spec §5.1/§7.4/§5.2). Owns the
// reactive per-file rows the TransferPanel renders, the scheduler (<=3
// files transferring at once, shared across both directions [B6]), the
// multipart part loop (<=3 parts in flight, upload-only), and the download
// reader loop that streams straight into a caller-acquired writable sink.
//
// Heavy/non-serializable bookkeeping (the `File`, the download `writable`,
// in-flight `AbortController`s, per-part progress) is kept OUT of the
// reactive `$state` items — it lives in the `internals` side map, keyed by
// transfer id, so the proxied `Transfer` rows stay plain, cheap-to-diff
// data.
import { partRanges, putWithProgress, type PartRange, type PutProgress } from "./upload";
import { session } from "./session.svelte";
import { previewKind } from "./preview";
import { generateThumbFor, uploadThumb } from "./thumbs";
import { displayName } from "./listing";
import { shouldWriteProgress, type ProgressPoint } from "./progressThrottle";
import type { PresignedRequest, UploadPlan, WasmClient } from "./core";

// Mirrors core/src/manifest.rs's `RESERVED_PREFIX` ([B10]) — no shared
// export exists across the wasm boundary for it (it's a plain string
// constant, not manifest-mutation logic), so it's duplicated here, same
// convention as this module's other standalone constants.
const RESERVED_PREFIX = ".bare-bucket/";

/** [B5][B10] Decides whether a just-finished upload should trigger the
 * on-upload thumbnail hook: kind must be image/pdf (per `previewKind`) and
 * the key must not be under the reserved prefix. Pulled out as a pure,
 * directly-testable function — rather than folded into `finalize` — so
 * engine tests can assert the hook is skipped entirely for non-previewable
 * kinds/reserved keys without needing to fake canvas/pdf.js internals (see
 * `engineDeps.generateAndUploadThumb`, the seam for the part that DOES need
 * faking). */
export function shouldGenerateThumb(key: string, contentType: string): boolean {
  if (key.startsWith(RESERVED_PREFIX)) return false;
  const kind = previewKind({ key, content_type: contentType });
  return kind === "image" || kind === "pdf";
}

/** Indirection seam for the engine's live-only dependencies — the XHR PUT
 * driver, the download presign + fetch calls, and "the currently connected
 * client" — so tests can swap in mocks without needing a real wasm client or
 * network access. Production code never overrides this; it's read fresh on
 * every call so a test can reassign any field per-test without re-importing
 * the module. */
export const engineDeps = {
  putWithProgress: (
    url: string,
    body: Blob,
    contentType: string,
    onProgress: PutProgress,
    signal: AbortSignal,
  ): Promise<string> => putWithProgress(url, body, contentType, onProgress, signal),
  getClient: (): WasmClient | null => session.client,
  /** [B10] Wraps `WasmClient.presign_get` — kept behind the seam (rather
   * than called directly like `presign_put`/`presign_upload_part`) so
   * download races can be pinned with a fully controllable deferred promise,
   * the same way `putWithProgress` is faked. */
  presignGet: (key: string, expiresSecs: number, attachmentName: string | null): Promise<PresignedRequest> => {
    const client = engineDeps.getClient();
    if (!client) return Promise.reject(new Error("not connected"));
    return Promise.resolve(client.presign_get(key, expiresSecs, attachmentName) as PresignedRequest);
  },
  /** [B10] Wraps `fetch` for the download reader loop. */
  fetchStream: (url: string, signal: AbortSignal): Promise<Response> => fetch(url, { signal }),
  /** [B5] The real on-upload thumbnail pipeline: generate from the local
   * `File` (no re-download), upload it, `set_thumbnail`, then mirror the
   * change onto the live manifest row. `finalize()` only calls this once
   * `shouldGenerateThumb` (a plain function, not part of this seam) has
   * already said yes — kept behind `engineDeps` anyway so tests can swap in
   * a controllable mock without touching canvas/createImageBitmap/pdf.js,
   * matching every other live-only dependency in this object. */
  generateAndUploadThumb: async (
    client: WasmClient,
    key: string,
    contentType: string,
    file: File,
  ): Promise<void> => {
    const kind = previewKind({ key, content_type: contentType }) as "image" | "pdf"; // caller already gated via shouldGenerateThumb
    const blob = await generateThumbFor(kind, file);
    const { thumbnailKey, updated } = await uploadThumb(client, key, blob);
    if (updated) session.applyThumbnail(key, thumbnailKey);
  },
};

export interface Transfer {
  id: string;
  key: string;
  name: string;
  size: number;
  /** Upload-only; downloads never go multipart, so this is always "single"
   * for a download row (dispatch branches on `direction` first — see
   * `processFile` — so the value is otherwise unused there). */
  kind: "single" | "multipart";
  direction: "upload" | "download"; // [B4]
  status: "queued" | "uploading" | "downloading" | "paused" | "done" | "error" | "cancelled";
  transferred: number; // bytes moved so far, either direction, reactive [B4]
  error: string | null;
  uploadId: string | null; // multipart upload only
}

interface InternalState {
  /** Nulled once the transfer settles into a terminal status (done/error/
   * cancelled) — see `freeInternal`. Only ever read while a run is active
   * (before the terminal free), so reads elsewhere use `!` to assert
   * non-null; that invariant is enforced by construction (nothing re-enters
   * `runSingle`/`uploadPart` for a transfer that already left "uploading"). */
  file: File | null;
  contentType: string;
  /** Remaining part ranges not yet dispatched (multipart only). */
  pending: PartRange[];
  /** `{ part_number, etag }` for parts that have finished (multipart only). */
  completedParts: { part_number: number; etag: string }[];
  /** Bytes from fully-completed parts — `Transfer.transferred` adds the
   * in-flight parts' loaded bytes on top so retries never double-count. */
  completedBytes: number;
  controllers: Set<AbortController>;
  inFlightLoaded: Map<AbortController, number>;
  /** Download-only: the caller-acquired sink to write chunks into. Never
   * touched for uploads. Lives here (not on the reactive `Transfer`) per
   * the same non-serializable-bookkeeping rule as `file`/`controllers`. */
  writable: FileSystemWritableFileStream | null;
  /** True while `processFile` is on the stack for this transfer (from entry
   * until its `finally` clears it, right before that `finally` calls
   * `pump()`). Lets `pump()` refuse to dispatch a second, concurrent
   * `runMultipart`/`runSingle` for the same transfer while an earlier one is
   * still unwinding after a pause/resume race. */
  running: boolean;
  /** Set by pause(); the part-dispatch loop stops picking up new parts but
   * lets in-flight parts finish (and count) — see brief's engine algorithm. */
  paused: boolean;
  /** Set by cancel(); distinguishes a deliberate abort from a genuine
   * network failure inside the retry loop. */
  cancelled: boolean;
  /** Set once the part loop finishes and the Complete phase starts.
   * pause() no-ops while this is set (there's nothing left to pause), and
   * it gates whether a cancel needs to abort the multipart upload at all. */
  completing: boolean;
  /** Set right after `complete_multipart_upload` succeeds. Once true, the
   * object exists remotely under this uploadId — cancel() must never call
   * `abort_multipart_upload` afterwards (it would either no-op against an
   * already-completed upload or, worse, race a S3-side cleanup). */
  completed: boolean;
}

const MAX_CONCURRENT_FILES = 3;
const MAX_CONCURRENT_PARTS = 3;
// Polish item 2: the one exported copy of this constant — BrowseScreen.svelte
// imports it instead of keeping its own local duplicate. The other sites
// (GridThumb.svelte/Lightbox.svelte/generateMissing.svelte.ts/thumbs.ts) keep
// their own copies per their own comments; consolidating those is out of
// this fix's scope.
export const PRESIGN_EXPIRES_SECS = 3600;
const COMPLETE_RETRY_DELAYS_MS = [1000, 2000]; // [B2]: 3 attempts total, 1s/2s backoff between them
const CANCEL_POLL_MS = 100; // tick size for interruptible backoff sleeps during Complete retry

const internals = new Map<string, InternalState>();

/** Keys currently occupied by a transfer whose status is in `statuses` —
 * shared basis for both the upload conflict pipeline's in-flight set
 * (queued/uploading/paused) and delete's in-flight guard [B7]
 * (queued/uploading/paused/downloading), so the two call sites can't drift
 * on what counts as "in flight"; only the status list passed in differs.
 * Pure and takes `items` explicitly (rather than reading `transfers.items`
 * itself) so it's trivially unit-testable without touching reactive state. */
export function keysInStatus(items: Transfer[], statuses: Transfer["status"][]): string[] {
  return items.filter((t) => statuses.includes(t.status)).map((t) => t.key);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleeps `ms` in `CANCEL_POLL_MS` ticks, bailing out early the moment
 * `internal.cancelled` flips — makes the Complete-retry backoff cheaply
 * interruptible without a real cancellation-token/promise-race plumbing. */
async function interruptibleSleep(ms: number, internal: InternalState): Promise<void> {
  let remaining = ms;
  while (remaining > 0 && !internal.cancelled) {
    const tick = Math.min(CANCEL_POLL_MS, remaining);
    await sleep(tick);
    remaining -= tick;
  }
}

function recomputeUploaded(transfer: Transfer, internal: InternalState): void {
  let inFlight = 0;
  for (const loaded of internal.inFlightLoaded.values()) inFlight += loaded;
  transfer.transferred = internal.completedBytes + inFlight;
}

/** Releases an item's heavy engine-only bookkeeping once its `Transfer.
 * status` has settled into a terminal state ("done" | "error" |
 * "cancelled") — the `File` handle (uploads), the `writable` sink
 * (downloads), any `AbortController`s, and the per-part queue/progress data
 * are never touched again for a terminal transfer, so drop the references
 * and let the GC reclaim them (this matters for many-file, large-file
 * sessions left in the panel via `clearFinished()` not yet having run).
 * `Transfer.uploadId` lives on the reactive row itself (not here) and is
 * deliberately left alone — it's still useful for diagnostics after the row
 * settles. [B9]
 *
 * Must only be called as the LAST step of whichever branch finally settles
 * a transfer — `abortEagerly` and `cancel()`'s own abort call still need
 * `internal.completed`/`internal.controllers` to do their job, so this runs
 * after them, never before. Safe to call more than once and safe if some
 * fields were already read earlier in that same settling branch. */
function freeInternal(id: string): void {
  const internal = internals.get(id);
  if (!internal) return;
  internal.file = null;
  internal.writable = null;
  internal.controllers.clear();
  internal.inFlightLoaded.clear();
  internal.pending = [];
  internal.completedParts = [];
}

/** Retries `complete_multipart_upload` up to 3 times (1s/2s backoff)
 * on ANY rejection [B2] — the UI owns this retry, not the core.
 *
 * Checks `internal.cancelled` before every attempt and again right after
 * each backoff sleep, so a cancel() that lands mid-backoff doesn't have to
 * wait out the remaining delay before the transfer settles. On a detected
 * cancel, throws a sentinel `AbortError` so the caller can tell it apart
 * from a genuine Complete failure. */
async function completeWithRetry(
  client: WasmClient,
  key: string,
  uploadId: string,
  parts: { part_number: number; etag: string }[],
  internal: InternalState,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= COMPLETE_RETRY_DELAYS_MS.length; attempt++) {
    if (internal.cancelled) throw new DOMException("cancelled", "AbortError");
    try {
      return await client.complete_multipart_upload(key, uploadId, parts);
    } catch (e) {
      lastError = e;
      const delay = COMPLETE_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        await interruptibleSleep(delay, internal);
        if (internal.cancelled) throw new DOMException("cancelled", "AbortError");
      }
    }
  }
  throw lastError;
}

/** Best-effort `abort_multipart_upload` fired when a multipart transfer
 * gives up for good (per-part retries exhausted, or Complete retries
 * exhausted) — Fix 3: without this the orphaned upload would sit until
 * reconcile's age-based cleanup catches it. Never called once `completed`
 * is set (Complete already succeeded — there's nothing to abort). Failures
 * here are appended to the row's error message rather than surfaced any
 * other way; this is a courtesy cleanup, not something the user acts on. */
async function abortEagerly(
  client: WasmClient,
  transfer: Transfer,
  internal: InternalState,
): Promise<void> {
  if (internal.completed || !transfer.uploadId) return;
  try {
    await client.abort_multipart_upload(transfer.key, transfer.uploadId);
  } catch (e) {
    transfer.error = `${transfer.error} (also failed to abort the multipart upload: ${errMsg(e)})`;
  }
}

/** Records the completed upload locally (no full refresh) and flips the
 * row to "done". Leaves the transfer in "error" if the metadata write
 * fails even though the bytes are already on the provider — a retry means
 * re-uploading (no partial-recovery UI per the brief's YAGNI list). */
async function finalize(
  client: WasmClient,
  transfer: Transfer,
  internal: InternalState,
  etag: string,
): Promise<void> {
  if (internal.cancelled) return; // Complete succeeded but the user cancelled — leave status "cancelled"; the object exists remotely and the next refresh surfaces it
  // Captured before `freeInternal()` nulls `internal.file` below — the
  // on-upload thumbnail hook needs the LOCAL file's bytes (no re-download,
  // per plan [B5]), so it must be grabbed before the terminal-state cleanup
  // that follows a successful upsert.
  const file = internal.file;
  const contentType = internal.contentType;
  try {
    await client.upsert_object(transfer.key, transfer.size, etag, contentType);
    session.applyUpsert({
      key: transfer.key,
      size: transfer.size,
      etag,
      last_modified: new Date().toISOString(),
      content_type: contentType,
      favorite: false,
      thumbnail_key: null,
      deleted_at: null,
    });
    transfer.status = "done";
    freeInternal(transfer.id);
    // [B5] Fired AFTER the transfer has already settled to "done" so a
    // slow or failing thumbnail pipeline never delays or errors the upload
    // itself; any rejection is swallowed here (console.warn only) rather
    // than touching the transfer row, which is the whole point of the
    // non-fatal contract.
    if (file && shouldGenerateThumb(transfer.key, contentType)) {
      void engineDeps.generateAndUploadThumb(client, transfer.key, contentType, file).catch((e) => {
        console.warn(`thumbnail generation failed for "${transfer.key}":`, e);
      });
    }
  } catch (e) {
    transfer.status = "error";
    transfer.error = `upload finished but failed to record it: ${errMsg(e)}`;
    freeInternal(transfer.id);
  }
}

async function runSingle(
  client: WasmClient,
  transfer: Transfer,
  internal: InternalState,
): Promise<void> {
  const controller = new AbortController();
  internal.controllers.add(controller);
  try {
    // [B1] presign immediately before dispatch, never ahead of time.
    const presigned = client.presign_put(transfer.key, PRESIGN_EXPIRES_SECS) as PresignedRequest;
    // [B2, item 13] Throttles the reactive `transfer.transferred` write —
    // the terminal value is always asserted explicitly right after this
    // resolves (below), regardless of what the throttle let through.
    let lastWrite: ProgressPoint = { bytes: 0, at: Date.now() };
    const etag = await engineDeps.putWithProgress(
      presigned.url,
      internal.file!, // set at enqueue(), only nulled after this transfer is terminal
      internal.contentType,
      (loaded) => {
        const next: ProgressPoint = { bytes: loaded, at: Date.now() };
        if (shouldWriteProgress(lastWrite, next, transfer.size)) {
          transfer.transferred = loaded;
          lastWrite = next;
        }
      },
      controller.signal,
    );
    internal.controllers.delete(controller);
    // The final upload-progress event isn't guaranteed to report the full
    // byte count before `onload` fires — assert it explicitly so the panel
    // never shows a stuck sub-100% bar for a transfer that's actually done.
    transfer.transferred = transfer.size;
    await finalize(client, transfer, internal, etag);
  } catch (e) {
    internal.controllers.delete(controller);
    if (internal.cancelled) return; // cancel() already set status + message
    transfer.status = "error";
    transfer.error = errMsg(e);
    freeInternal(transfer.id);
  }
}

/** Uploads one part, re-presigning and retrying ONCE more on failure
 * before giving up (2 attempts total) — per the brief's per-part retry
 * rule. A deliberate cancel is never retried. */
async function uploadPart(
  client: WasmClient,
  transfer: Transfer,
  internal: InternalState,
  part: PartRange,
): Promise<{ part_number: number; etag: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    internal.controllers.add(controller);
    internal.inFlightLoaded.set(controller, 0);
    // [B2, item 13] Throttles the reactive `recomputeUploaded` write, scoped
    // to THIS part's own byte count (not the whole transfer's) since `loaded`
    // here is this part's XHR progress only. `internal.inFlightLoaded` — the
    // non-reactive bookkeeping `recomputeUploaded` sums across parts — is
    // still updated on every event regardless of the throttle, so the eventual
    // (possibly-delayed) reactive write stays byte-accurate.
    let lastWrite: ProgressPoint = { bytes: 0, at: Date.now() };
    try {
      // [B1] lazy per-part presign, right before this attempt's dispatch.
      const presigned = client.presign_upload_part(
        transfer.key,
        transfer.uploadId as string,
        part.partNumber,
        PRESIGN_EXPIRES_SECS,
      ) as PresignedRequest;
      const blob = internal.file!.slice(part.start, part.end); // set at enqueue(), only nulled after this transfer is terminal
      const etag = await engineDeps.putWithProgress(
        presigned.url,
        blob,
        internal.contentType,
        (loaded) => {
          internal.inFlightLoaded.set(controller, loaded);
          const next: ProgressPoint = { bytes: loaded, at: Date.now() };
          if (shouldWriteProgress(lastWrite, next, part.end - part.start)) {
            recomputeUploaded(transfer, internal);
            lastWrite = next;
          }
        },
        controller.signal,
      );
      internal.inFlightLoaded.delete(controller);
      internal.controllers.delete(controller);
      internal.completedBytes += part.end - part.start;
      recomputeUploaded(transfer, internal);
      return { part_number: part.partNumber, etag };
    } catch (e) {
      internal.inFlightLoaded.delete(controller);
      internal.controllers.delete(controller);
      recomputeUploaded(transfer, internal);
      if (internal.cancelled || internal.paused || attempt === 1) throw e;
      // else: loop again for the single allowed retry.
    }
  }
  /* istanbul ignore next -- unreachable: loop always returns or throws */
  throw new Error("unreachable");
}

async function runMultipart(
  client: WasmClient,
  transfer: Transfer,
  internal: InternalState,
): Promise<void> {
  if (!transfer.uploadId) {
    try {
      transfer.uploadId = await client.create_multipart_upload(transfer.key, internal.contentType);
    } catch (e) {
      transfer.status = "error";
      transfer.error = errMsg(e);
      freeInternal(transfer.id);
      return;
    }
  }

  let failure: unknown = null;

  async function worker(): Promise<void> {
    for (;;) {
      if (internal.cancelled || internal.paused || failure) return;
      const part = internal.pending.shift();
      if (!part) return;
      try {
        const result = await uploadPart(client, transfer, internal, part);
        internal.completedParts.push(result);
      } catch (e) {
        // Re-push the failed part so it can be retried on resume; if paused,
        // the part stays queued for when the transfer resumes; if not paused,
        // the transfer errors anyway and the re-push is harmless.
        internal.pending.unshift(part);
        failure = e;
        return;
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_PARTS, internal.pending.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // cancel()/pause() already set the row's status themselves; just stop.
  // A resume that lands mid-unwind (before this instance's `finally` clears
  // `running`) re-queues the transfer — `transfer.status` flips back to
  // "queued" while this stale instance is still on the stack. That instance
  // must not complete or error the transfer; the scheduler will re-dispatch
  // a fresh run once `running` clears. This also covers the `failure`
  // branch below: the gate returns first, so a re-pushed part with
  // `failure` set never gets a chance to flip a re-queued transfer to
  // "error".
  if (internal.cancelled || internal.paused || transfer.status === "queued") return;

  if (failure) {
    transfer.status = "error";
    transfer.error = errMsg(failure);
    await abortEagerly(client, transfer, internal); // per-part retries exhausted: give up on the upload
    freeInternal(transfer.id);
    return;
  }

  internal.completing = true; // part loop is done; Complete is starting — pause() no-ops from here on
  try {
    const parts = internal.completedParts.slice().sort((a, b) => a.part_number - b.part_number);
    const etag = await completeWithRetry(client, transfer.key, transfer.uploadId, parts, internal);
    internal.completed = true;
    if (internal.cancelled) return; // the object exists remotely and the next refresh will surface it
    await finalize(client, transfer, internal, etag);
  } catch (e) {
    if (internal.cancelled) return; // cancel() already set status "cancelled" + any message; don't clobber it
    transfer.status = "error";
    transfer.error = errMsg(e);
    await abortEagerly(client, transfer, internal); // Complete retries exhausted: give up on the upload
    freeInternal(transfer.id);
  }
}

/** Streams a presigned GET straight into the caller-acquired `writable`
 * sink [B2] — no in-memory accumulation. Mirrors the upload engine's unwind
 * discipline: `internal.controllers` holds the fetch's `AbortController` so
 * `cancel()`'s existing abort loop covers it for free, and `writable.abort()`
 * on the cancel path is cancel()'s own responsibility (mirrors how
 * `abort_multipart_upload` lives in cancel(), not here) [B8]. No pause/
 * resume for downloads [B5]. */
async function runDownload(transfer: Transfer, internal: InternalState): Promise<void> {
  const controller = new AbortController();
  internal.controllers.add(controller);
  try {
    // [B1] presign immediately before dispatch, never ahead of time; the
    // URL is a bearer token — it's never logged and lives only in this
    // function's local scope for the duration of the fetch.
    const presigned = await engineDeps.presignGet(transfer.key, PRESIGN_EXPIRES_SECS, transfer.name);
    const response = await engineDeps.fetchStream(presigned.url, controller.signal);
    if (!response.ok || !response.body) {
      throw new Error(`download failed with status ${response.status}`);
    }
    const writable = internal.writable!; // set at enqueueDownload(), only nulled after this transfer is terminal; captured once here (mirrors how the upload engine captures `internal.file` per attempt) so a chunk landing after a cancel can't dereference a nulled field
    const reader = response.body.getReader();
    // [B2, item 13] `receivedBytes` is the true running total, updated on
    // EVERY chunk regardless of the throttle (`writable.write` and the
    // terminal `transfer.transferred = transfer.size` below both need it to
    // be byte-accurate); only the reactive `transfer.transferred` write
    // itself is throttled.
    let receivedBytes = 0;
    let lastWrite: ProgressPoint = { bytes: 0, at: Date.now() };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        receivedBytes += value.byteLength;
        const next: ProgressPoint = { bytes: receivedBytes, at: Date.now() };
        if (shouldWriteProgress(lastWrite, next, transfer.size)) {
          transfer.transferred = receivedBytes;
          lastWrite = next;
        }
        await writable.write(value);
      }
    }
    internal.controllers.delete(controller);
    if (internal.cancelled) return; // cancel() already aborted the writable; close() must never follow an abort()
    await writable.close();
    // As with the upload path, assert the full byte count explicitly rather
    // than trusting the last chunk to land exactly on `transfer.size`.
    transfer.transferred = transfer.size;
    transfer.status = "done";
    freeInternal(transfer.id);
  } catch (e) {
    internal.controllers.delete(controller);
    if (internal.cancelled) return; // cancel() already set status "cancelled", aborted the writable, and aborted the fetch controller itself
    transfer.status = "error";
    transfer.error = errMsg(e);
    // A write failure or a non-OK response means the response body (if any)
    // was never fully consumed — abort the fetch too, or the browser is left
    // pulling bytes into a reader nobody's reading from anymore. Aborting an
    // already-settled/never-started fetch is a harmless no-op, so this is
    // safe to call unconditionally on this (non-cancel) branch.
    controller.abort();
    try {
      await internal.writable?.abort();
    } catch {
      // best-effort cleanup; the row is already in "error" regardless.
    }
    freeInternal(transfer.id);
  }
}

async function processFile(transfer: Transfer, internal: InternalState): Promise<void> {
  if (transfer.direction === "download") {
    transfer.status = "downloading";
    internal.running = true;
    try {
      await runDownload(transfer, internal);
    } finally {
      internal.running = false; // must clear before pump() re-dispatches, else pump would see this run as still active
      pump();
    }
    return;
  }
  transfer.status = "uploading";
  internal.running = true;
  const client = engineDeps.getClient();
  if (!client) {
    transfer.status = "error";
    transfer.error = "not connected";
    internal.running = false;
    pump();
    return;
  }
  try {
    if (transfer.kind === "single") {
      await runSingle(client, transfer, internal);
    } else {
      await runMultipart(client, transfer, internal);
    }
  } finally {
    internal.running = false; // must clear before pump() re-dispatches, else pump would see this run as still active
    pump();
  }
}

/** Promotes queued transfers to "uploading"/"downloading" while under the
 * shared file-concurrency cap [B6]. Called after enqueue and after every
 * transfer leaves an active state (done/error/cancelled/paused) so the next
 * one starts. */
function pump(): void {
  const uploading = transfers.items.filter(
    (t) => t.status === "uploading" || t.status === "downloading",
  ).length;
  let free = MAX_CONCURRENT_FILES - uploading;
  if (free <= 0) return;
  for (const transfer of transfers.items) {
    if (free <= 0) break;
    if (transfer.status !== "queued") continue;
    const internal = internals.get(transfer.id);
    if (!internal) continue;
    if (internal.running) continue; // the previous run is still unwinding; its finally will re-pump
    free--;
    void processFile(transfer, internal);
  }
}

export const transfers: {
  items: Transfer[];
  readonly active: boolean;
  activeUploadIds(): string[];
  enqueue(file: File, key: string): void;
  enqueueDownload(key: string, name: string, size: number, writable: FileSystemWritableFileStream): void;
  pause(id: string): void;
  resume(id: string): void;
  cancel(id: string): Promise<void>;
  cancelAll(): Promise<void>;
  clearFinished(): void;
} = $state({
  items: [],

  get active() {
    return transfers.items.some(
      (t) =>
        t.status === "queued" ||
        t.status === "uploading" ||
        t.status === "downloading" ||
        t.status === "paused",
    );
  },

  /** Multipart uploadIds this session still owns and hasn't finished with
   * (not yet completed via `complete_multipart_upload`, not aborted via
   * cancel) — threaded into `reconcile()` so it doesn't clean these up out
   * from under an in-progress upload. Deliberately excludes "error" rows:
   * an upload the app has given up retrying is no longer protected, so
   * reconcile's age-based cleanup can reclaim it. */
  activeUploadIds() {
    return transfers.items
      .filter((t) => t.uploadId !== null && (t.status === "uploading" || t.status === "paused" || t.status === "queued"))
      .map((t) => t.uploadId as string);
  },

  enqueue(file: File, key: string) {
    const contentType = file.type || "application/octet-stream"; // [B4]
    let kind: "single" | "multipart" = "single";
    let partSize = 0;
    const client = engineDeps.getClient();
    if (client) {
      const plan = client.upload_plan(file.size) as UploadPlan;
      if (plan.kind === "multipart") {
        kind = "multipart";
        partSize = plan.part_size;
      }
    }
    const transfer: Transfer = {
      id: crypto.randomUUID(),
      key,
      // Polish item 1: derived from the TARGET key's basename, not the
      // source File's own name — for the common case these are identical,
      // but a "Save as a copy" conflict resolution enqueues under a renamed
      // key (see resolveSaveAsCopy in BrowseScreen.svelte), and the panel row
      // must show that renamed name, not the original file's.
      name: displayName(key).name,
      size: file.size,
      kind,
      direction: "upload", // [B4]
      status: "queued",
      transferred: 0,
      error: null,
      uploadId: null,
    };
    internals.set(transfer.id, {
      file,
      contentType,
      pending: kind === "multipart" ? partRanges(file.size, partSize) : [],
      completedParts: [],
      completedBytes: 0,
      controllers: new Set(),
      inFlightLoaded: new Map(),
      writable: null,
      running: false,
      paused: false,
      cancelled: false,
      completing: false,
      completed: false,
    });
    transfers.items.push(transfer);
    pump();
  },

  /** Enqueues a download row for a caller-acquired `writable` sink (Task 3
   * owns picking it via `showSaveFilePicker`/FSA). Presign is lazy, at
   * dispatch time [B1]; the row shares the same <=3 concurrent-transfer
   * slots as uploads [B6] and supports cancel only, never pause/resume
   * [B5]. */
  enqueueDownload(key: string, name: string, size: number, writable: FileSystemWritableFileStream) {
    const transfer: Transfer = {
      id: crypto.randomUUID(),
      key,
      name,
      size,
      kind: "single", // unused for downloads; direction gates dispatch first
      direction: "download", // [B4]
      status: "queued",
      transferred: 0,
      error: null,
      uploadId: null,
    };
    internals.set(transfer.id, {
      file: null,
      contentType: "",
      pending: [],
      completedParts: [],
      completedBytes: 0,
      controllers: new Set(),
      inFlightLoaded: new Map(),
      writable,
      running: false,
      paused: false,
      cancelled: false,
      completing: false,
      completed: false,
    });
    transfers.items.push(transfer);
    pump();
  },

  /** Pause aborts in-flight part requests; interrupted parts return to the
   * queue and re-upload on resume. Progress may visibly drop slightly when
   * pausing (the in-flight parts' loaded-but-uncommitted bytes are
   * discarded along with the abort) — that's expected. */
  pause(id: string) {
    const transfer = transfers.items.find((t) => t.id === id);
    const internal = internals.get(id);
    if (!transfer || !internal) return;
    if (internal.completing) return; // no-op: the part loop is done, there's nothing left to pause
    if (transfer.kind !== "multipart" || transfer.status !== "uploading") return;
    internal.paused = true;
    transfer.status = "paused";
    for (const controller of internal.controllers) controller.abort();
    pump(); // frees this file's concurrency slot for the next queued upload
  },

  /** Re-queues rather than re-entering `runMultipart` directly — routes
   * back through `pump()`/the scheduler so a resume can't transiently push
   * the uploading count past `MAX_CONCURRENT_FILES`, and so there's never
   * a second concurrent `runMultipart` racing the one already in flight.
   * `internal.pending` already has completed parts shifted out (see
   * `worker()`), so the part loop picks up exactly where it left off. */
  resume(id: string) {
    const transfer = transfers.items.find((t) => t.id === id);
    const internal = internals.get(id);
    if (!transfer || !internal || transfer.status !== "paused") return;
    internal.paused = false;
    transfer.status = "queued";
    pump();
  },

  async cancel(id: string) {
    const transfer = transfers.items.find((t) => t.id === id);
    const internal = internals.get(id);
    if (!transfer || !internal) return;
    if (transfer.status === "done" || transfer.status === "cancelled") return;

    internal.cancelled = true;
    internal.paused = false;
    for (const controller of internal.controllers) controller.abort();
    const uploadId = transfer.uploadId;
    transfer.status = "cancelled";
    pump(); // frees this file's concurrency slot for the next queued upload

    // Skip the abort call once Complete has already succeeded (`completed`)
    // — the object exists remotely under this uploadId and there's nothing
    // left to abort. If Complete is mid-flight or never started, abort as
    // before.
    if (uploadId && !internal.completed) {
      const client = engineDeps.getClient();
      if (client) {
        try {
          await client.abort_multipart_upload(transfer.key, uploadId);
        } catch (e) {
          // Row error note; status stays "cancelled" (NotFound already
          // counts as success in core — this only fires on a real error).
          transfer.error = errMsg(e);
        }
      }
    }
    // [B8] Downloads have no uploadId to abort remotely; instead abort the
    // writable so no partial file survives on disk. `runDownload`'s own
    // catch skips this (it no-ops on `internal.cancelled`), so this is the
    // one place it happens — mirrors `abort_multipart_upload` living here
    // rather than in `runMultipart`.
    if (transfer.direction === "download" && internal.writable) {
      try {
        await internal.writable.abort();
      } catch (e) {
        transfer.error = errMsg(e);
      }
    }
    freeInternal(id);
  },

  /** Cancels every non-terminal transfer (queued/uploading/downloading/
   * paused) — e.g. when switching profiles, where letting transfers keep
   * running against the about-to-be-torn-down session/client makes no
   * sense [B8]. Snapshots the id list before cancelling since `cancel()`
   * mutates `transfers.items` (via `pump()`) as it goes. Reuses `cancel(id)`
   * so every abort/status/error-note rule stays in exactly one place. */
  async cancelAll() {
    const ids = transfers.items
      .filter(
        (t) =>
          t.status === "queued" ||
          t.status === "uploading" ||
          t.status === "downloading" ||
          t.status === "paused",
      )
      .map((t) => t.id);
    await Promise.all(ids.map((id) => transfers.cancel(id)));
  },

  clearFinished() {
    const finished = new Set(
      transfers.items
        .filter((t) => t.status === "done" || t.status === "error" || t.status === "cancelled")
        .map((t) => t.id),
    );
    for (const id of finished) internals.delete(id);
    transfers.items = transfers.items.filter((t) => !finished.has(t.id));
  },
});

// [B9] Warn before leaving the page while any transfer is queued/
// uploading/paused — matches the beforeunload contract in the brief.
// Guarded for non-browser environments (unit tests import pure modules
// only, but this module is reactive/live-only so guard defensively).
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (transfers.active) {
      e.preventDefault();
      // Legacy contract some browsers still require alongside
      // preventDefault() to actually show the "leave site?" prompt.
      e.returnValue = "";
    }
  });
}
