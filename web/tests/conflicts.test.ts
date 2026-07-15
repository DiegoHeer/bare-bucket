import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../src/lib/core";
import { folderLabel, hasConflict, takenNamesInPrefix } from "../src/lib/conflicts";

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

describe("hasConflict", () => {
  it("is true for a live key already in the manifest", () => {
    expect(hasConflict([obj("photo.jpg")], "photo.jpg")).toBe(true);
  });

  it("is false for a key not present", () => {
    expect(hasConflict([obj("photo.jpg")], "other.jpg")).toBe(false);
  });

  it("ignores tombstoned rows (deleted_at set)", () => {
    expect(hasConflict([obj("photo.jpg", { deleted_at: "2026-07-14T00:00:00Z" })], "photo.jpg")).toBe(
      false,
    );
  });
});

describe("takenNamesInPrefix", () => {
  const objects = [obj("docs/a.txt"), obj("docs/b.txt"), obj("other/c.txt")];

  it("collects names directly under the prefix from the manifest", () => {
    expect(takenNamesInPrefix(objects, [], "docs/")).toEqual(new Set(["a.txt", "b.txt"]));
  });

  it("does not descend into nested folders", () => {
    expect(takenNamesInPrefix([obj("docs/nested/d.txt")], [], "docs/")).toEqual(new Set());
  });

  it("merges in-flight transfer keys targeting the same prefix", () => {
    expect(takenNamesInPrefix(objects, ["docs/a (1).txt"], "docs/")).toEqual(
      new Set(["a.txt", "b.txt", "a (1).txt"]),
    );
  });

  it("ignores transfer keys outside the prefix", () => {
    expect(takenNamesInPrefix(objects, ["other/z.txt"], "docs/")).toEqual(
      new Set(["a.txt", "b.txt"]),
    );
  });
});

describe("folderLabel", () => {
  it("is 'All files' at the root", () => {
    expect(folderLabel("")).toBe("All files");
  });

  it("is the last path segment for a nested prefix", () => {
    expect(folderLabel("photos/2026/trip/")).toBe("trip");
  });

  it("works for a single top-level folder", () => {
    expect(folderLabel("docs/")).toBe("docs");
  });
});
