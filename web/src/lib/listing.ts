// Pure derivation over the manifest: folder structure is computed from key
// prefixes at render time (design spec §4.1 — no stored folder rows).
import type { ManifestObject } from "./core";

export interface FolderEntry {
  name: string;
  prefix: string;
}

export interface Listing {
  folders: FolderEntry[];
  files: ManifestObject[];
}

const byName = new Intl.Collator(undefined, { sensitivity: "base" });

function live(objects: ManifestObject[]): ManifestObject[] {
  return objects.filter((o) => o.deleted_at === null);
}

/** Direct children of `prefix` ("" = root): sub-folders and files. */
export function childEntries(objects: ManifestObject[], prefix: string): Listing {
  const folders = new Map<string, FolderEntry>();
  const files: ManifestObject[] = [];
  for (const object of live(objects)) {
    if (!object.key.startsWith(prefix)) continue;
    const rest = object.key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push(object);
    } else {
      const name = rest.slice(0, slash);
      if (!folders.has(name)) {
        folders.set(name, { name, prefix: `${prefix}${name}/` });
      }
    }
  }
  return {
    folders: [...folders.values()].sort((a, b) => byName.compare(a.name, b.name)),
    files: files.sort((a, b) => byName.compare(a.key, b.key)),
  };
}

export interface TreeNode {
  name: string;
  prefix: string;
  children: TreeNode[];
}

/** Full folder tree (folders only), recursively sorted. */
export function buildTree(objects: ManifestObject[]): TreeNode[] {
  const build = (prefix: string): TreeNode[] =>
    childEntries(objects, prefix).folders.map((folder) => ({
      name: folder.name,
      prefix: folder.prefix,
      children: build(folder.prefix),
    }));
  return build("");
}

export function breadcrumbSegments(
  prefix: string,
): { label: string; prefix: string }[] {
  const segments = [{ label: "All files", prefix: "" }];
  let acc = "";
  for (const part of prefix.split("/").filter(Boolean)) {
    acc += `${part}/`;
    segments.push({ label: part, prefix: acc });
  }
  return segments;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  let unitIndex = -1;
  for (let i = 0; i < units.length; i++) {
    if (value < 1024) break;
    value /= 1024;
    unit = units[i];
    unitIndex = i;
  }
  let rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;

  // Rollover at boundaries: if rounded reaches 1024 and next unit exists
  while (rounded === 1024 && unitIndex + 1 < units.length) {
    rounded /= 1024;
    unitIndex++;
    unit = units[unitIndex];
    rounded = rounded >= 100 ? Math.round(rounded) : Math.round(rounded * 10) / 10;
  }

  const roundedStr = rounded.toString();
  return `${roundedStr.endsWith(".0") ? roundedStr.slice(0, -2) : roundedStr} ${unit}`;
}

export function formatModified(iso: string, now: Date = new Date()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const seconds = Math.max(0, (now.getTime() - time) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(time).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function totalSize(objects: ManifestObject[]): number {
  return live(objects).reduce((sum, o) => sum + o.size, 0);
}
