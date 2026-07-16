// Pure helpers backing the upload conflict-check pipeline (spec §8.3) and
// the drag-drop overlay's folder label. Kept separate from BrowseScreen.svelte
// so this logic is unit-testable without a DOM/Svelte-component harness.
import type { ManifestObject } from "./core";
import { childEntries } from "./listing";

/**
 * True when `key` names a live (non-tombstoned) object in `objects`, OR
 * matches an in-flight transfer's target key — the trigger for the
 * conflict modal (spec §8.3: any name collision with an existing manifest
 * key, or with an upload already headed to that key, prompts a choice
 * before upload starts). `inFlightKeys` should be the queued/uploading/
 * paused transfers' keys (the same set passed to `takenNamesInPrefix`) —
 * without it, two files named alike, dropped in the same batch before the
 * first has finished (and so before it appears in the manifest), would
 * silently collide instead of prompting.
 */
export function hasConflict(
  objects: ManifestObject[],
  key: string,
  inFlightKeys: string[] = [],
): boolean {
  return objects.some((o) => o.key === key && o.deleted_at === null) || inFlightKeys.includes(key);
}

/**
 * Names (not full keys) already occupied directly under `prefix`, combining
 * the live manifest with any transfer keys already targeting this prefix.
 * The latter covers same-batch "Save as a copy" collisions: the manifest
 * itself only reflects an upload after it finishes, so without this a
 * second same-named conflict resolved moments after the first could
 * recompute the same "(1)" suffix. Callers should pass transfer keys that
 * exclude cancelled/error rows — a cancelled or given-up-on transfer never
 * lands, so its key isn't actually taken.
 */
export function takenNamesInPrefix(
  objects: ManifestObject[],
  transferKeys: string[],
  prefix: string,
): Set<string> {
  const manifestNames = childEntries(objects, prefix).files.map((f) => f.key.slice(prefix.length));
  const transferNames = transferKeys
    .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
    .map((key) => key.slice(prefix.length));
  return new Set([...manifestNames, ...transferNames]);
}

/**
 * Human label for the drag-drop overlay ("Drop to upload to {label}") — the
 * current folder's own name, or "All files" at the root.
 */
export function folderLabel(prefix: string): string {
  const trimmed = prefix.replace(/\/$/, "");
  if (trimmed === "") return "All files";
  const slash = trimmed.lastIndexOf("/");
  return trimmed.slice(slash + 1);
}
