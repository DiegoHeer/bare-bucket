// Upload transfer queue + engine (spec §5.1/§7.4). Owns the reactive
// per-file rows the TransferPanel renders, the scheduler (<=3 files
// uploading at once), and the multipart part loop (<=3 parts in flight).
//
// Heavy/non-serializable bookkeeping (the `File`, in-flight
// `AbortController`s, per-part progress) is kept OUT of the reactive
// `$state` items — it lives in the `internals` side map, keyed by transfer
// id, so the proxied `Transfer` rows stay plain, cheap-to-diff data.
import { partRanges, putWithProgress, type PartRange } from "./upload";
import { session } from "./session.svelte";
import type { PresignedRequest, UploadPlan, WasmClient } from "./core";

export interface Transfer {
  id: string;
  key: string;
  name: string;
  size: number;
  kind: "single" | "multipart";
  status: "queued" | "uploading" | "paused" | "done" | "error" | "cancelled";
  uploaded: number; // bytes, reactive
  error: string | null;
  uploadId: string | null; // multipart only
}

interface InternalState {
  file: File;
  contentType: string;
  /** Remaining part ranges not yet dispatched (multipart only). */
  pending: PartRange[];
  /** `{ part_number, etag }` for parts that have finished (multipart only). */
  completedParts: { part_number: number; etag: string }[];
  /** Bytes from fully-completed parts — `Transfer.uploaded` adds the
   * in-flight parts' loaded bytes on top so retries never double-count. */
  completedBytes: number;
  controllers: Set<AbortController>;
  inFlightLoaded: Map<AbortController, number>;
  /** Set by pause(); the part-dispatch loop stops picking up new parts but
   * lets in-flight parts finish (and count) — see brief's engine algorithm. */
  paused: boolean;
  /** Set by cancel(); distinguishes a deliberate abort from a genuine
   * network failure inside the retry loop. */
  cancelled: boolean;
}

const MAX_CONCURRENT_FILES = 3;
const MAX_CONCURRENT_PARTS = 3;
const PRESIGN_EXPIRES_SECS = 3600;
const COMPLETE_RETRY_DELAYS_MS = [1000, 2000]; // [B2]: 3 attempts total, 1s/2s backoff between them

const internals = new Map<string, InternalState>();

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recomputeUploaded(transfer: Transfer, internal: InternalState): void {
  let inFlight = 0;
  for (const loaded of internal.inFlightLoaded.values()) inFlight += loaded;
  transfer.uploaded = internal.completedBytes + inFlight;
}

/** Retries `complete_multipart_upload` up to 3 times (1s/2s backoff)
 * on ANY rejection [B2] — the UI owns this retry, not the core. */
async function completeWithRetry(
  client: WasmClient,
  key: string,
  uploadId: string,
  parts: { part_number: number; etag: string }[],
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= COMPLETE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await client.complete_multipart_upload(key, uploadId, parts);
    } catch (e) {
      lastError = e;
      const delay = COMPLETE_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await sleep(delay);
    }
  }
  throw lastError;
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
  try {
    await client.upsert_object(transfer.key, transfer.size, etag, internal.contentType);
    session.applyUpsert({
      key: transfer.key,
      size: transfer.size,
      etag,
      last_modified: new Date().toISOString(),
      content_type: internal.contentType,
      favorite: false,
      thumbnail_key: null,
      deleted_at: null,
    });
    transfer.status = "done";
  } catch (e) {
    transfer.status = "error";
    transfer.error = `upload finished but failed to record it: ${errMsg(e)}`;
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
    const etag = await putWithProgress(
      presigned.url,
      internal.file,
      internal.contentType,
      (loaded) => {
        transfer.uploaded = loaded;
      },
      controller.signal,
    );
    internal.controllers.delete(controller);
    await finalize(client, transfer, internal, etag);
  } catch (e) {
    internal.controllers.delete(controller);
    if (internal.cancelled) return; // cancel() already set status + message
    transfer.status = "error";
    transfer.error = errMsg(e);
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
    try {
      // [B1] lazy per-part presign, right before this attempt's dispatch.
      const presigned = client.presign_upload_part(
        transfer.key,
        transfer.uploadId as string,
        part.partNumber,
        PRESIGN_EXPIRES_SECS,
      ) as PresignedRequest;
      const blob = internal.file.slice(part.start, part.end);
      const etag = await putWithProgress(
        presigned.url,
        blob,
        internal.contentType,
        (loaded) => {
          internal.inFlightLoaded.set(controller, loaded);
          recomputeUploaded(transfer, internal);
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
      if (internal.cancelled || attempt === 1) throw e;
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
        failure = e;
        return;
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_PARTS, internal.pending.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // cancel()/pause() already set the row's status themselves; just stop.
  if (internal.cancelled || internal.paused) return;

  if (failure) {
    transfer.status = "error";
    transfer.error = errMsg(failure);
    return;
  }

  try {
    const parts = internal.completedParts.slice().sort((a, b) => a.part_number - b.part_number);
    const etag = await completeWithRetry(client, transfer.key, transfer.uploadId, parts);
    await finalize(client, transfer, internal, etag);
  } catch (e) {
    transfer.status = "error";
    transfer.error = errMsg(e);
  }
}

async function processFile(transfer: Transfer, internal: InternalState): Promise<void> {
  transfer.status = "uploading";
  const client = session.client;
  if (!client) {
    transfer.status = "error";
    transfer.error = "not connected";
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
    pump();
  }
}

/** Promotes queued transfers to "uploading" while under the file-
 * concurrency cap. Called after enqueue and after every transfer leaves
 * "uploading" (done/error/cancelled/paused) so the next one starts. */
function pump(): void {
  const uploading = transfers.items.filter((t) => t.status === "uploading").length;
  let free = MAX_CONCURRENT_FILES - uploading;
  if (free <= 0) return;
  for (const transfer of transfers.items) {
    if (free <= 0) break;
    if (transfer.status !== "queued") continue;
    const internal = internals.get(transfer.id);
    if (!internal) continue;
    free--;
    void processFile(transfer, internal);
  }
}

export const transfers: {
  items: Transfer[];
  readonly active: boolean;
  activeUploadIds(): string[];
  enqueue(file: File, key: string): void;
  pause(id: string): void;
  resume(id: string): void;
  cancel(id: string): Promise<void>;
  clearFinished(): void;
} = $state({
  items: [],

  get active() {
    return transfers.items.some(
      (t) => t.status === "queued" || t.status === "uploading" || t.status === "paused",
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
      .filter((t) => t.uploadId !== null && (t.status === "uploading" || t.status === "paused"))
      .map((t) => t.uploadId as string);
  },

  enqueue(file: File, key: string) {
    const contentType = file.type || "application/octet-stream"; // [B4]
    let kind: "single" | "multipart" = "single";
    let partSize = 0;
    const client = session.client;
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
      name: file.name,
      size: file.size,
      kind,
      status: "queued",
      uploaded: 0,
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
      paused: false,
      cancelled: false,
    });
    transfers.items.push(transfer);
    pump();
  },

  pause(id: string) {
    const transfer = transfers.items.find((t) => t.id === id);
    const internal = internals.get(id);
    if (!transfer || !internal) return;
    if (transfer.kind !== "multipart" || transfer.status !== "uploading") return;
    internal.paused = true;
    transfer.status = "paused";
    pump(); // frees this file's concurrency slot for the next queued upload
  },

  resume(id: string) {
    const transfer = transfers.items.find((t) => t.id === id);
    const internal = internals.get(id);
    if (!transfer || !internal || transfer.status !== "paused") return;
    internal.paused = false;
    transfer.status = "uploading";
    const client = session.client;
    if (!client) {
      transfer.status = "error";
      transfer.error = "not connected";
      return;
    }
    void (async () => {
      try {
        await runMultipart(client, transfer, internal);
      } finally {
        pump();
      }
    })();
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

    if (uploadId) {
      const client = session.client;
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
    }
  });
}
