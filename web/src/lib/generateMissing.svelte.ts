// "Generate missing thumbnails" runner (spec §9, plan [B6]): sequentially
// backfills `thumbnail_key` for live, previewable rows that don't have one
// yet, fetching each ORIGINAL via a presigned GET (these are out-of-band
// files — no local `File` the way the on-upload hook has). Sequential by
// design [B6] — one item in flight at a time — so a large backfill doesn't
// saturate the main thread with concurrent canvas/pdf.js work.
import { previewKind } from "./preview";
import { generateThumbFor, uploadThumb } from "./thumbs";
import { session } from "./session.svelte";
import { keysInStatus, transfers } from "./transfers.svelte";
import type { Manifest, ManifestObject, PresignedRequest, WasmClient } from "./core";

// Mirrors core/src/manifest.rs's `RESERVED_PREFIX` — see transfers.svelte.ts's
// own copy/comment for why this isn't a shared export.
const RESERVED_PREFIX = ".bare-bucket/";

// Mirrors the transfer engine's/BrowseScreen's/Lightbox's own copies of this
// constant; no shared export exists for it (see their comments).
const PRESIGN_EXPIRES_SECS = 3600;

/** Indirection seam for this runner's live-only dependencies — the presigned
 * GET, the generate+upload pipeline, and the local-manifest mirror — so
 * tests can swap in fully controllable mocks (per-item resolve/reject) the
 * same way `engineDeps` does for the transfer engine, without needing a real
 * wasm client, canvas, or network. Production code never overrides this. */
export const generateMissingDeps = {
  presignGet: (client: WasmClient, key: string): PresignedRequest =>
    client.presign_get(key, PRESIGN_EXPIRES_SECS, null) as PresignedRequest,
  generateThumb: (kind: "image" | "pdf", source: string): Promise<Blob> => generateThumbFor(kind, source),
  uploadThumb: (
    client: WasmClient,
    key: string,
    blob: Blob,
  ): Promise<{ thumbnailKey: string; updated: boolean }> => uploadThumb(client, key, blob),
  applyThumbnail: (key: string, thumbnailKey: string): void => session.applyThumbnail(key, thumbnailKey),
};

/**
 * Pure candidate filter [B6][B10]: live (not tombstoned), previewable
 * (image/pdf per `previewKind`), missing a thumbnail, not under the reserved
 * prefix, and not currently occupied by an in-flight transfer (`inFlightKeys`
 * — same wider queued/uploading/paused/downloading set as delete's guard,
 * passed in explicitly so this stays a plain function over plain data).
 */
export function missingThumbCandidates(
  objects: ManifestObject[],
  inFlightKeys: string[],
): ManifestObject[] {
  const inFlight = new Set(inFlightKeys);
  return objects.filter((o) => {
    if (o.deleted_at !== null) return false;
    if (o.thumbnail_key !== null) return false;
    if (o.key.startsWith(RESERVED_PREFIX)) return false;
    if (inFlight.has(o.key)) return false;
    const kind = previewKind(o);
    return kind === "image" || kind === "pdf";
  });
}

export const generateMissing: {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  currentKey: string | null;
  cancelled: boolean;
  start(client: WasmClient, manifest: Manifest): Promise<void>;
  cancel(): void;
} = $state({
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  currentKey: null,
  cancelled: false,

  /** Scans `manifest.objects` for candidates, then processes them ONE AT A
   * TIME [B6]: per-item failures are counted and skipped (never abort the
   * whole run), and `cancel()` stops the loop between items (never
   * mid-item). A no-op if a run is already active, or if there's nothing to
   * do (in which case `total` stays 0 so the UI shows no stray summary). */
  async start(client, manifest) {
    if (generateMissing.running) return;
    // `inFlightKeys` is a snapshot taken once, here, at scan time — not
    // re-read as the run progresses. This is a deliberate, self-healing
    // race, not an oversight: if a key starts an upload mid-run (after this
    // snapshot), that upload's own on-upload hook sets its thumbnail via the
    // same idempotent `set_thumbnail` this runner uses, so there's no
    // duplicate-work hazard; and if a key's in-flight transfer completes and
    // it grows a thumbnail after being excluded here, a later `reconcile`
    // pass — not this runner — sweeps any orphaned thumb objects it left
    // behind. See missingThumbCandidates' own doc comment for the filter.
    const inFlightKeys = keysInStatus(transfers.items, [
      "queued",
      "uploading",
      "paused",
      "downloading",
    ]);
    const candidates = missingThumbCandidates(manifest.objects, inFlightKeys);

    generateMissing.total = candidates.length;
    generateMissing.done = 0;
    generateMissing.failed = 0;
    generateMissing.cancelled = false;
    generateMissing.currentKey = null;
    if (candidates.length === 0) return;

    generateMissing.running = true;
    try {
      for (const object of candidates) {
        if (generateMissing.cancelled) break;
        generateMissing.currentKey = object.key;
        try {
          const kind = previewKind(object) as "image" | "pdf"; // guaranteed by missingThumbCandidates's filter
          const presigned = generateMissingDeps.presignGet(client, object.key);
          const blob = await generateMissingDeps.generateThumb(kind, presigned.url);
          const { thumbnailKey, updated } = await generateMissingDeps.uploadThumb(client, object.key, blob);
          if (updated) generateMissingDeps.applyThumbnail(object.key, thumbnailKey);
          generateMissing.done++;
        } catch (e) {
          console.warn(`failed to generate a thumbnail for "${object.key}":`, e);
          generateMissing.failed++;
        }
      }
    } finally {
      generateMissing.currentKey = null;
      generateMissing.running = false;
    }
  },

  /** Signals the loop to stop before its NEXT item (never mid-item) — see
   * `start`'s loop guard. */
  cancel() {
    generateMissing.cancelled = true;
  },
});
