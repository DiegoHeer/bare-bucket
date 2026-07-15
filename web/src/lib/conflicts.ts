// Pure helpers backing the upload conflict-check pipeline (spec §8.3) and
// the drag-drop overlay's folder label. Kept separate from BrowseScreen.svelte
// so this logic is unit-testable without a DOM/Svelte-component harness.
import type { ManifestObject } from "./core";
import { childEntries } from "./listing";

/**
 * True when `key` names a live (non-tombstoned) object in `objects` — the
 * trigger for the conflict modal (spec §8.3: any name collision with an
 * existing manifest key prompts a choice before upload starts).
 */
export function hasConflict(objects: ManifestObject[], key: string): boolean {
  return objects.some((o) => o.key === key && o.deleted_at === null);
}

/**
 * Names (not full keys) already occupied directly under `prefix`, combining
 * the live manifest with any transfer keys already targeting this prefix.
 * The latter covers same-batch "Save as a copy" collisions: the manifest
 * itself only reflects an upload after it finishes, so without this a
 * second same-named conflict resolved moments after the first could
 * recompute the same "(1)" suffix.
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
