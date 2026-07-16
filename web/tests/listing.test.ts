import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../src/lib/core";
import {
  breadcrumbSegments,
  buildTree,
  childEntries,
  displayName,
  favoriteFiles,
  formatModified,
  formatSize,
  recentFiles,
  searchFiles,
  totalSize,
} from "../src/lib/listing";

function obj(key: string, extra: Partial<ManifestObject> = {}): ManifestObject {
  return {
    key,
    size: 100,
    etag: '"e"',
    last_modified: "2026-07-14T18:22:00Z",
    content_type: "application/octet-stream",
    favorite: false,
    thumbnail_key: null,
    deleted_at: null,
    ...extra,
  };
}

const objects = [
  obj("readme.txt"),
  obj("photos/2026/trip/IMG_0142.jpg"),
  obj("photos/2026/trip/IMG_0143.jpg"),
  obj("photos/2026/other.png"),
  obj("docs/plan.pdf"),
  obj("Docs-2/z.txt"), // exercises case-insensitive sort
];

describe("childEntries", () => {
  it("lists root folders and files, folders first, case-insensitive sort", () => {
    const { folders, files } = childEntries(objects, "");
    expect(folders.map((f) => f.name)).toEqual(["docs", "Docs-2", "photos"]);
    expect(folders.map((f) => f.prefix)).toEqual(["docs/", "Docs-2/", "photos/"]);
    expect(files.map((f) => f.key)).toEqual(["readme.txt"]);
  });

  it("lists a nested prefix without duplicating deeper folders", () => {
    const { folders, files } = childEntries(objects, "photos/");
    expect(folders.map((f) => f.name)).toEqual(["2026"]);
    expect(files).toEqual([]);
    const deeper = childEntries(objects, "photos/2026/");
    expect(deeper.folders.map((f) => f.name)).toEqual(["trip"]);
    expect(deeper.files.map((f) => f.key)).toEqual(["photos/2026/other.png"]);
  });

  it("excludes tombstoned objects entirely", () => {
    const withDeleted = [...objects, obj("gone.txt", { deleted_at: "2026-07-15T00:00:00Z" })];
    const { files } = childEntries(withDeleted, "");
    expect(files.map((f) => f.key)).not.toContain("gone.txt");
  });

  it("never yields empty-named folders for keys with '//' or a leading '/' (such objects become unreachable dead ends rather than blank clickable rows)", () => {
    const weird = [obj("weird//double.txt"), obj("/leading.txt")];

    // Root: "weird" is a real (non-empty) segment, so it becomes a folder.
    // "/leading.txt" has an empty first segment and is skipped outright —
    // it surfaces as neither a folder nor a file anywhere.
    const root = childEntries(weird, "");
    expect(root.folders.every((f) => f.name.length > 0)).toBe(true);
    expect(root.folders.map((f) => f.name)).toEqual(["weird"]);
    expect(root.files).toEqual([]);

    // Descending into "weird/": the remaining "/double.txt" also has an
    // empty first segment, so it's skipped too — the folder is a dead end
    // with no children, rather than showing a blank-named row.
    const inWeird = childEntries(weird, "weird/");
    expect(inWeird.folders).toEqual([]);
    expect(inWeird.files).toEqual([]);
  });
});

describe("buildTree", () => {
  it("builds a sorted recursive tree of folders only", () => {
    const tree = buildTree(objects);
    expect(tree.map((n) => n.name)).toEqual(["docs", "Docs-2", "photos"]);
    const photos = tree[2];
    expect(photos.prefix).toBe("photos/");
    expect(photos.children.map((n) => n.name)).toEqual(["2026"]);
    expect(photos.children[0].children.map((n) => n.name)).toEqual(["trip"]);
    expect(photos.children[0].children[0].children).toEqual([]);
  });
});

describe("breadcrumbSegments", () => {
  it("always starts at All files and walks the prefix", () => {
    expect(breadcrumbSegments("")).toEqual([{ label: "All files", prefix: "" }]);
    expect(breadcrumbSegments("photos/2026/")).toEqual([
      { label: "All files", prefix: "" },
      { label: "photos", prefix: "photos/" },
      { label: "2026", prefix: "photos/2026/" },
    ]);
  });
});

describe("formatSize", () => {
  it("formats binary sizes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(532)).toBe("532 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(4 * 1024 * 1024)).toBe("4 MB");
    expect(formatSize(4404019)).toBe("4.2 MB");
    expect(formatSize(8.2 * 1024 ** 3)).toBe("8.2 GB");
  });

  it("rolls over to the next unit at rounding boundaries", () => {
    expect(formatSize(1024 ** 2 - 1)).toBe("1 MB");
    expect(formatSize(1024 ** 3 - 1)).toBe("1 GB");
    expect(formatSize(1023)).toBe("1023 B");
  });
});

describe("formatModified", () => {
  const now = new Date("2026-07-15T12:00:00Z");
  it("uses relative ranges then absolute dates", () => {
    expect(formatModified("2026-07-15T11:59:30Z", now)).toBe("just now");
    expect(formatModified("2026-07-15T11:20:00Z", now)).toBe("40m ago");
    expect(formatModified("2026-07-15T03:00:00Z", now)).toBe("9h ago");
    expect(formatModified("2026-07-13T12:00:00Z", now)).toBe("2d ago");
    expect(formatModified("2026-01-05T00:00:00Z", now)).toBe("Jan 5, 2026");
  });
  it("tolerates unparseable timestamps", () => {
    expect(formatModified("not-a-date", now)).toBe("—");
  });
  it("is timezone-independent for absolute dates", () => {
    expect(formatModified("2026-01-05T00:00:00Z", now)).toBe("Jan 5, 2026");
    expect(formatModified("2026-01-05T23:59:00Z", now)).toBe("Jan 5, 2026");
  });
});

describe("totalSize", () => {
  it("sums live objects only", () => {
    const withDeleted = [...objects, obj("gone.txt", { size: 999999, deleted_at: "x" })];
    expect(totalSize(withDeleted)).toBe(objects.length * 100);
  });
});

describe("recentFiles", () => {
  it("sorts live files newest first with key tiebreak", () => {
    const list = [
      obj("b.txt", { last_modified: "2026-07-10T00:00:00Z" }),
      obj("a.txt", { last_modified: "2026-07-14T00:00:00Z" }),
      obj("tie-b.txt", { last_modified: "2026-07-12T00:00:00Z" }),
      obj("tie-a.txt", { last_modified: "2026-07-12T00:00:00Z" }),
      obj("dead.txt", { last_modified: "2026-07-15T00:00:00Z", deleted_at: "x" }),
    ];
    expect(recentFiles(list).map((f) => f.key)).toEqual([
      "a.txt",
      "tie-a.txt",
      "tie-b.txt",
      "b.txt",
    ]);
  });
});

describe("favoriteFiles", () => {
  it("returns only live favorites, name-sorted", () => {
    const list = [
      obj("z.txt", { favorite: true }),
      obj("a.txt", { favorite: true }),
      obj("m.txt"),
      obj("dead.txt", { favorite: true, deleted_at: "x" }),
    ];
    expect(favoriteFiles(list).map((f) => f.key)).toEqual(["a.txt", "z.txt"]);
  });
});

describe("searchFiles", () => {
  const list = [
    obj("photos/2026/trip/IMG_0142.jpg"),
    obj("docs/Itinerary.pdf"),
    obj("dead-img.txt", { deleted_at: "x" }),
  ];
  it("matches case-insensitively across the full key", () => {
    expect(searchFiles(list, "img").map((f) => f.key)).toEqual([
      "photos/2026/trip/IMG_0142.jpg",
    ]);
    expect(searchFiles(list, "ITINER").map((f) => f.key)).toEqual(["docs/Itinerary.pdf"]);
    expect(searchFiles(list, "2026/trip")).toHaveLength(1);
  });
  it("returns nothing for empty or whitespace queries", () => {
    expect(searchFiles(list, "")).toEqual([]);
    expect(searchFiles(list, "   ")).toEqual([]);
  });
});

describe("displayName", () => {
  it("splits name and parent", () => {
    expect(displayName("photos/2026/trip/IMG.jpg")).toEqual({
      name: "IMG.jpg",
      parent: "photos/2026/trip",
    });
    expect(displayName("readme.md")).toEqual({ name: "readme.md", parent: "" });
  });
});
