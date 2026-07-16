// Lightbox preview routing (spec §7.5, PR 13 [B5]) and sibling-stepping
// helpers ([B3]/[B4]) — kept pure/DOM-free so the routing table and the
// stepping/advance-or-close decisions are unit-testable without a component
// harness (this project has no jsdom/testing-library harness; see
// tests/preview.test.ts).
//
// [B5]'s image-detection half is deliberately generic, not just for the
// lightbox: PR 14 (thumbnails) reuses `previewKind`'s image branch for its
// own presigned-GET plumbing, so nothing here should assume it's only ever
// called from Lightbox.svelte.
import type { ManifestObject } from "./core";

export type PreviewKind = "image" | "pdf" | "text" | "none";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]);

// Deliberately the exact extension list from plan [B5] — not a broader
// "anything text-ish" guess. Content types (`text/*`, `application/json`)
// cover the rest (e.g. a correctly-labeled .txt upload) without needing an
// extension entry.
const TEXT_EXTENSIONS = new Set(["md", "json", "log", "csv", "yaml", "toml", "xml"]);

/** Ranged text preview cap [B5]/[B6]: Task 2's text renderer fetches at most
 * this many bytes (`Range: bytes=0-262143`) and shows a truncation notice
 * when the object is larger. Exported now so the routing/cap decision lives
 * in one place before the renderer that consumes it exists. */
export const TEXT_PREVIEW_CAP_BYTES = 256 * 1024;

function extensionOf(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Routes a manifest object to the lightbox body it should render [B5]:
 * matched by EITHER the manifest's `content_type` OR the key's extension —
 * either signal alone is enough, so a file uploaded with a generic
 * `application/octet-stream` content_type (browser/tool didn't guess) still
 * gets the right renderer off its extension, and vice versa.
 */
export function previewKind(object: Pick<ManifestObject, "key" | "content_type">): PreviewKind {
  const ext = extensionOf(object.key);
  const contentType = object.content_type.toLowerCase();

  if (contentType.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (contentType === "application/pdf" || ext === "pdf") return "pdf";
  if (contentType.startsWith("text/") || contentType === "application/json" || TEXT_EXTENSIONS.has(ext)) {
    return "text";
  }
  return "none";
}

/**
 * Ordered, tombstone-free key list for lightbox sibling navigation [B3]:
 * takes a file array already in listing order (e.g. `Listing.files` from
 * `childEntries`, or a flat Recent/Favorites/Search file list) and drops any
 * tombstoned rows. Kept as a plain `ManifestObject[]` parameter (not a
 * `Listing`) so it works for both the folder-listing case and the flat
 * section views.
 */
export function siblingKeys(files: ManifestObject[]): string[] {
  return files.filter((f) => f.deleted_at === null).map((f) => f.key);
}

/**
 * Steps from `currentKey` to its neighbor in `keys` (already listing-order,
 * tombstone-free — see `siblingKeys`): `direction` `1` for next/→, `-1` for
 * previous/←. Returns `null` at either end (wrapping is not required per
 * [B3]) or if `currentKey` isn't present in `keys` at all (e.g. it was just
 * deleted out from under the lightbox by another client).
 */
export function nextSiblingKey(keys: string[], currentKey: string, direction: 1 | -1): string | null {
  const index = keys.indexOf(currentKey);
  if (index === -1) return null;
  const next = index + direction;
  return next >= 0 && next < keys.length ? keys[next] : null;
}

/**
 * Decides the lightbox's new open key after a delete initiated FROM the
 * lightbox resolves successfully [B4]: if the deleted file wasn't the one
 * currently open, nothing changes; otherwise the lightbox advances to
 * `nextKey` (which closes the lightbox when `nextKey` is `null`, i.e. the
 * deleted file had no next sibling).
 *
 * Pure on purpose so this is unit-testable without mounting BrowseScreen.
 * The caller MUST capture `nextKey` (via `siblingKeys`/`nextSiblingKey`)
 * BEFORE awaiting the delete — once the delete resolves and the manifest's
 * tombstone is applied, `deletedKey` is no longer in the (now
 * tombstone-filtered) listing, so it can't be looked up against the
 * post-delete sibling list.
 */
export function advanceOrClose(
  deletedKey: string,
  currentLightboxKey: string | null,
  nextKey: string | null,
): string | null {
  if (currentLightboxKey !== deletedKey) return currentLightboxKey;
  return nextKey;
}
