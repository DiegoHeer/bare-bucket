// Preview routing table [B5] + sibling stepping/advance-or-close decisions
// [B3][B4] — pure logic, unit-tested without a DOM harness (this project has
// none). Component wiring (Lightbox.svelte actually fetching/rendering per
// kind) arrives in Task 2; here we only verify the routing switch and the
// navigation math Task 1 is responsible for.
import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../src/lib/core";
import { advanceOrClose, nextSiblingKey, previewKind, siblingKeys } from "../src/lib/preview";

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

describe("previewKind", () => {
  it.each([
    ["image/png", "photo.png", "image"],
    ["image/jpeg", "photo.jpeg", "image"],
    ["image/svg+xml", "icon.svg", "image"],
    ["application/pdf", "doc.pdf", "pdf"],
    ["text/plain", "notes.txt", "text"],
    ["application/json", "data.bin", "text"],
    ["text/csv", "sheet.bin", "text"],
    ["application/octet-stream", "archive.zip", "none"],
    ["application/octet-stream", "video.mp4", "none"],
  ] as const)("content_type=%s key=%s -> %s", (content_type, key, expected) => {
    expect(previewKind(obj(key, { content_type }))).toBe(expected);
  });

  it("routes off the extension when content_type is a generic octet-stream", () => {
    expect(previewKind(obj("photo.png", { content_type: "application/octet-stream" }))).toBe("image");
    expect(previewKind(obj("itinerary.pdf", { content_type: "application/octet-stream" }))).toBe("pdf");
    expect(previewKind(obj("readme.md", { content_type: "application/octet-stream" }))).toBe("text");
  });

  it("routes off content_type even when the extension is missing or unrecognized", () => {
    expect(previewKind(obj("noext", { content_type: "image/png" }))).toBe("image");
    expect(previewKind(obj("weird.xyz", { content_type: "text/plain" }))).toBe("text");
  });

  it("is case-insensitive on both content_type and extension", () => {
    expect(previewKind(obj("PHOTO.PNG", { content_type: "application/octet-stream" }))).toBe("image");
    expect(previewKind(obj("doc.pdf", { content_type: "APPLICATION/PDF" }))).toBe("pdf");
  });

  it("falls back to none for anything unmatched (metadata+download fallback)", () => {
    expect(previewKind(obj("archive.tar.gz", { content_type: "application/gzip" }))).toBe("none");
  });
});

describe("siblingKeys", () => {
  it("preserves listing order and excludes tombstoned rows", () => {
    const files = [obj("a.txt"), obj("b.txt", { deleted_at: "2026-07-15T00:00:00Z" }), obj("c.txt")];
    expect(siblingKeys(files)).toEqual(["a.txt", "c.txt"]);
  });

  it("returns an empty list for an empty or fully-tombstoned input", () => {
    expect(siblingKeys([])).toEqual([]);
    expect(siblingKeys([obj("a.txt", { deleted_at: "2026-07-15T00:00:00Z" })])).toEqual([]);
  });
});

describe("nextSiblingKey", () => {
  const keys = ["a.txt", "b.txt", "c.txt"];

  it("steps to the next sibling", () => {
    expect(nextSiblingKey(keys, "a.txt", 1)).toBe("b.txt");
    expect(nextSiblingKey(keys, "b.txt", 1)).toBe("c.txt");
  });

  it("steps to the previous sibling", () => {
    expect(nextSiblingKey(keys, "c.txt", -1)).toBe("b.txt");
    expect(nextSiblingKey(keys, "b.txt", -1)).toBe("a.txt");
  });

  it("stops at the end instead of wrapping", () => {
    expect(nextSiblingKey(keys, "c.txt", 1)).toBeNull();
    expect(nextSiblingKey(keys, "a.txt", -1)).toBeNull();
  });

  it("returns null for a key that's no longer in the list (deleted out from under the lightbox)", () => {
    expect(nextSiblingKey(keys, "deleted.txt", 1)).toBeNull();
  });

  it("returns null for a single-item list in either direction", () => {
    expect(nextSiblingKey(["only.txt"], "only.txt", 1)).toBeNull();
    expect(nextSiblingKey(["only.txt"], "only.txt", -1)).toBeNull();
  });
});

describe("advanceOrClose", () => {
  it("leaves the lightbox alone when the deleted file wasn't the one open", () => {
    expect(advanceOrClose("other.txt", "open.txt", "next.txt")).toBe("open.txt");
  });

  it("advances to the captured next sibling when the open file was deleted", () => {
    expect(advanceOrClose("open.txt", "open.txt", "next.txt")).toBe("next.txt");
  });

  it("closes the lightbox when the open (and deleted) file had no next sibling", () => {
    expect(advanceOrClose("open.txt", "open.txt", null)).toBeNull();
  });

  it("is a no-op when the lightbox is already closed", () => {
    expect(advanceOrClose("open.txt", null, "next.txt")).toBeNull();
  });
});
