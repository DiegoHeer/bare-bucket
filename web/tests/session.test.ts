// PR 12: applyTombstone (live re-find discipline + found-flag no-op shape,
// mirroring core's `Manifest::mark_deleted` [B2][B4][B6]) and deleteObject
// (gates success on the wasm promise resolving, not on the report's
// `deleted` field; propagates rejections untouched for the confirm modal
// [B10]; a `thumbnail_deleted: false` leftover is a non-blocking
// console.warn, never thrown).
import { afterEach, describe, expect, it, vi } from "vitest";
import { session } from "../src/lib/session.svelte";
import { generateMissing } from "../src/lib/generateMissing.svelte";
import { childEntries, favoriteFiles } from "../src/lib/listing";
import type { ManifestObject, WasmClient } from "../src/lib/core";

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

function fakeClient(deleteObject: (key: string) => Promise<unknown>): Pick<WasmClient, "delete_object"> {
  return { delete_object: vi.fn(deleteObject) as unknown as WasmClient["delete_object"] };
}

afterEach(() => {
  session.manifest = null;
  session.client = null;
  generateMissing.running = false;
  generateMissing.total = 0;
  generateMissing.done = 0;
  generateMissing.failed = 0;
  generateMissing.currentKey = null;
  generateMissing.cancelled = false;
  vi.restoreAllMocks();
});

describe("disconnect", () => {
  it("cancels and resets an active generate-missing run (polish item 10)", () => {
    session.client = { free: vi.fn() } as unknown as WasmClient;
    session.status = "connected";
    generateMissing.running = true;
    generateMissing.total = 5;
    generateMissing.done = 2;
    generateMissing.currentKey = "a.png";

    session.disconnect();

    expect(generateMissing.running).toBe(false);
    expect(generateMissing.total).toBe(0);
    expect(generateMissing.done).toBe(0);
    expect(generateMissing.currentKey).toBeNull();
    expect(generateMissing.cancelled).toBe(true);
    expect(session.status).toBe("connect");
  });

  it("is a no-op on generate-missing state when no run was active", () => {
    session.client = null;
    session.status = "connected";

    expect(() => session.disconnect()).not.toThrow();
    expect(generateMissing.total).toBe(0);
  });
});

describe("applyTombstone", () => {
  it("sets deleted_at and clears thumbnail_key on the live row, leaving other fields (favorite) alone", () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg", { favorite: true, thumbnail_key: "thumbs/photo.jpg" })],
    };

    session.applyTombstone("photo.jpg");

    const row = session.manifest.objects[0];
    expect(row.deleted_at).not.toBeNull();
    expect(Number.isNaN(Date.parse(row.deleted_at as string))).toBe(false);
    expect(row.thumbnail_key).toBeNull();
    expect(row.favorite).toBe(true); // preserved — only deleted_at/thumbnail_key are the Rust mutator's job
  });

  it("re-finds the row off the CURRENT session.manifest.objects (live-instance discipline)", () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg")],
    };
    // Simulate an overlapping refresh() replacing the objects array with a
    // fresh (but equivalent) one right before the tombstone lands.
    const replaced = [obj("photo.jpg")];
    session.manifest.objects = replaced;

    session.applyTombstone("photo.jpg");

    expect(replaced[0].deleted_at).not.toBeNull();
  });

  it("no-ops when the key is absent", () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("other.jpg")],
    };

    session.applyTombstone("missing.jpg");

    expect(session.manifest.objects).toHaveLength(1);
    expect(session.manifest.objects[0].deleted_at).toBeNull();
  });

  it("no-ops (found-flag shape) when the row is already tombstoned — does not overwrite deleted_at", () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg", { deleted_at: "2026-07-01T00:00:00Z", thumbnail_key: null })],
    };

    session.applyTombstone("photo.jpg");

    expect(session.manifest.objects[0].deleted_at).toBe("2026-07-01T00:00:00Z");
  });

  it("no-ops when there is no manifest at all", () => {
    session.manifest = null;
    expect(() => session.applyTombstone("photo.jpg")).not.toThrow();
  });

  it("interplay with listing helpers: a tombstoned row disappears from childEntries and favoriteFiles", () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("docs/photo.jpg", { favorite: true })],
    };

    session.applyTombstone("docs/photo.jpg");

    expect(childEntries(session.manifest.objects, "docs/").files).toEqual([]);
    expect(favoriteFiles(session.manifest.objects)).toEqual([]);
  });
});

describe("applyThumbnail", () => {
  it("sets thumbnail_key on the live row", () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg")],
    };

    session.applyThumbnail("photo.jpg", ".bare-bucket/thumbs/photo.jpg.webp");

    expect(session.manifest.objects[0].thumbnail_key).toBe(".bare-bucket/thumbs/photo.jpg.webp");
  });

  it("re-finds the row off the CURRENT session.manifest.objects (live-instance discipline)", () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg")],
    };
    const replaced = [obj("photo.jpg")];
    session.manifest.objects = replaced;

    session.applyThumbnail("photo.jpg", "thumbs/photo.jpg.webp");

    expect(replaced[0].thumbnail_key).toBe("thumbs/photo.jpg.webp");
  });

  it("no-ops when the key is absent", () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("other.jpg")],
    };

    session.applyThumbnail("missing.jpg", "thumbs/missing.jpg.webp");

    expect(session.manifest.objects[0].thumbnail_key).toBeNull();
  });

  it("no-ops on a tombstoned row rather than resurrecting it with a thumbnail_key", () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg", { deleted_at: "2026-07-01T00:00:00Z" })],
    };

    session.applyThumbnail("photo.jpg", "thumbs/photo.jpg.webp");

    expect(session.manifest.objects[0].thumbnail_key).toBeNull();
  });

  it("no-ops when there is no manifest at all", () => {
    session.manifest = null;
    expect(() => session.applyThumbnail("photo.jpg", "thumbs/photo.jpg.webp")).not.toThrow();
  });
});

describe("deleteObject", () => {
  it("rejects without calling the client when there is no connection", async () => {
    session.client = null;
    await expect(session.deleteObject("photo.jpg")).rejects.toThrow("not connected");
  });

  it("calls the wasm client then applies the tombstone locally on success", async () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg")],
    };
    const client = fakeClient(async () => ({ deleted: true, thumbnail_deleted: null, already_absent: false }));
    session.client = client as unknown as WasmClient;

    await session.deleteObject("photo.jpg");

    expect(client.delete_object).toHaveBeenCalledWith("photo.jpg");
    expect(session.manifest.objects[0].deleted_at).not.toBeNull();
  });

  it("gates success on the promise resolving, not on the report's `deleted` field", async () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg")],
    };
    // Per Task 1's interface note, `deleted` is always true today, but the
    // contract is: resolving == success, regardless of this field's value.
    const client = fakeClient(async () => ({ deleted: false, thumbnail_deleted: null, already_absent: false }));
    session.client = client as unknown as WasmClient;

    await session.deleteObject("photo.jpg");

    expect(session.manifest.objects[0].deleted_at).not.toBeNull();
  });

  it("propagates a rejection and leaves the manifest untouched (no optimistic removal) [B10]", async () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg")],
    };
    const client = fakeClient(async () => {
      throw new Error("object delete failed");
    });
    session.client = client as unknown as WasmClient;

    await expect(session.deleteObject("photo.jpg")).rejects.toThrow("object delete failed");
    expect(session.manifest.objects[0].deleted_at).toBeNull();
  });

  it("still tombstones and only warns (never throws) on thumbnail_deleted === false", async () => {
    session.manifest = {
      schema_version: 1,
      last_full_rebuild_at: null,
      last_writer_device_id: "web-1",
      objects: [obj("photo.jpg", { thumbnail_key: "thumbs/photo.jpg" })],
    };
    const client = fakeClient(async () => ({ deleted: true, thumbnail_deleted: false, already_absent: false }));
    session.client = client as unknown as WasmClient;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(session.deleteObject("photo.jpg")).resolves.toBeUndefined();

    expect(session.manifest.objects[0].deleted_at).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
