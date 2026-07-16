// "Generate missing thumbnails" runner (plan [B6]): `missingThumbCandidates`
// is a plain filter over manifest objects (directly tested); `start`'s
// sequential loop/cancel/skip-on-failure state machine is tested via the
// `generateMissingDeps` seam (mirrors `engineDeps`'s pattern) so no
// canvas/pdf.js/wasm client is needed — same reasoning as transfers.test.ts's
// mocked `engineDeps`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateMissing, generateMissingDeps, missingThumbCandidates } from "../src/lib/generateMissing.svelte";
import { session } from "../src/lib/session.svelte";
import type { Manifest, ManifestObject, PresignedRequest, WasmClient } from "../src/lib/core";

function obj(key: string, extra: Partial<ManifestObject> = {}): ManifestObject {
  return {
    key,
    size: 100,
    etag: '"e"',
    last_modified: "2026-07-14T18:22:00Z",
    content_type: "image/png",
    favorite: false,
    thumbnail_key: null,
    deleted_at: null,
    ...extra,
  };
}

describe("missingThumbCandidates", () => {
  it("includes a live, previewable row with no thumbnail_key", () => {
    const objects = [obj("a.png")];
    expect(missingThumbCandidates(objects, [])).toEqual(objects);
  });

  it("excludes a tombstoned row", () => {
    const objects = [obj("a.png", { deleted_at: "2026-07-01T00:00:00Z" })];
    expect(missingThumbCandidates(objects, [])).toEqual([]);
  });

  it("excludes a row that already has a thumbnail_key", () => {
    const objects = [obj("a.png", { thumbnail_key: "thumbs/a.png.webp" })];
    expect(missingThumbCandidates(objects, [])).toEqual([]);
  });

  it("excludes a row under the reserved prefix", () => {
    const objects = [obj(".bare-bucket/thumbs/a.png.webp")];
    expect(missingThumbCandidates(objects, [])).toEqual([]);
  });

  it("excludes a non-previewable row (e.g. a video)", () => {
    const objects = [obj("clip.mp4", { content_type: "video/mp4" })];
    expect(missingThumbCandidates(objects, [])).toEqual([]);
  });

  it("excludes a row with an in-flight transfer", () => {
    const objects = [obj("a.png"), obj("b.png")];
    expect(missingThumbCandidates(objects, ["a.png"])).toEqual([objects[1]]);
  });

  it("includes a pdf row", () => {
    const objects = [obj("doc.pdf", { content_type: "application/pdf" })];
    expect(missingThumbCandidates(objects, [])).toEqual(objects);
  });
});

function manifestOf(objects: ManifestObject[]): Manifest {
  return {
    schema_version: 1,
    last_full_rebuild_at: null,
    last_writer_device_id: "web-1",
    objects,
  };
}

function presignedGet(url: string): PresignedRequest {
  return { method: "GET", url, expires_secs: 3600 };
}

const realPresignGet = generateMissingDeps.presignGet;
const realGenerateThumb = generateMissingDeps.generateThumb;
const realUploadThumb = generateMissingDeps.uploadThumb;
const realApplyThumbnail = generateMissingDeps.applyThumbnail;

afterEach(() => {
  generateMissingDeps.presignGet = realPresignGet;
  generateMissingDeps.generateThumb = realGenerateThumb;
  generateMissingDeps.uploadThumb = realUploadThumb;
  generateMissingDeps.applyThumbnail = realApplyThumbnail;
  generateMissing.running = false;
  generateMissing.total = 0;
  generateMissing.done = 0;
  generateMissing.failed = 0;
  generateMissing.currentKey = null;
  generateMissing.cancelled = false;
  session.manifest = null;
  vi.restoreAllMocks();
});

describe("generateMissing.start", () => {
  it("processes candidates sequentially, updating done/total as it goes, and applies the thumbnail locally", async () => {
    const objects = [obj("a.png"), obj("b.png")];
    generateMissingDeps.presignGet = vi.fn((_client, key) => presignedGet(`https://example.test/${key}`));
    generateMissingDeps.generateThumb = vi.fn(async () => new Blob(["x"]));
    generateMissingDeps.uploadThumb = vi.fn(async (_client, key) => ({
      thumbnailKey: `thumbs/${key}.webp`,
      updated: true,
    }));
    const applyMock = vi.fn();
    generateMissingDeps.applyThumbnail = applyMock;

    const fakeClient = {} as unknown as WasmClient;
    await generateMissing.start(fakeClient, manifestOf(objects));

    expect(generateMissing.running).toBe(false); // settled by the time start() resolves
    expect(generateMissing.total).toBe(2);
    expect(generateMissing.done).toBe(2);
    expect(generateMissing.failed).toBe(0);
    expect(generateMissing.currentKey).toBeNull();
    expect(applyMock).toHaveBeenCalledWith("a.png", "thumbs/a.png.webp");
    expect(applyMock).toHaveBeenCalledWith("b.png", "thumbs/b.png.webp");
    expect(generateMissingDeps.uploadThumb).toHaveBeenCalledTimes(2);
  });

  it("counts a per-item failure and continues to the next candidate instead of aborting the run", async () => {
    const objects = [obj("a.png"), obj("b.png")];
    generateMissingDeps.presignGet = vi.fn((_client, key) => presignedGet(`https://example.test/${key}`));
    generateMissingDeps.generateThumb = vi.fn(async (_kind, source) => {
      if (typeof source === "string" && source.includes("a.png")) throw new Error("corrupt image");
      return new Blob(["x"]);
    });
    generateMissingDeps.uploadThumb = vi.fn(async (_client, key) => ({
      thumbnailKey: `thumbs/${key}.webp`,
      updated: true,
    }));
    const applyMock = vi.fn();
    generateMissingDeps.applyThumbnail = applyMock;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await generateMissing.start({} as unknown as WasmClient, manifestOf(objects));

    expect(generateMissing.total).toBe(2);
    expect(generateMissing.done).toBe(1);
    expect(generateMissing.failed).toBe(1);
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith("b.png", "thumbs/b.png.webp");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("skips the local applyThumbnail mirror when set_thumbnail reports updated: false", async () => {
    const objects = [obj("a.png")];
    generateMissingDeps.presignGet = vi.fn((_client, key) => presignedGet(`https://example.test/${key}`));
    generateMissingDeps.generateThumb = vi.fn(async () => new Blob(["x"]));
    generateMissingDeps.uploadThumb = vi.fn(async () => ({ thumbnailKey: "thumbs/a.png.webp", updated: false }));
    const applyMock = vi.fn();
    generateMissingDeps.applyThumbnail = applyMock;

    await generateMissing.start({} as unknown as WasmClient, manifestOf(objects));

    expect(generateMissing.done).toBe(1); // still counted as a success — the PUT itself didn't fail
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("cancel() stops the loop before the next item, leaving already-processed counts intact", async () => {
    const objects = [obj("a.png"), obj("b.png"), obj("c.png")];
    generateMissingDeps.presignGet = vi.fn((_client, key) => presignedGet(`https://example.test/${key}`));
    generateMissingDeps.uploadThumb = vi.fn(async (_client, key) => ({
      thumbnailKey: `thumbs/${key}.webp`,
      updated: true,
    }));
    generateMissingDeps.applyThumbnail = vi.fn();
    // Cancel as soon as the first item's generation is asked for — the loop
    // must still finish that first item (never abort mid-item) but must not
    // start the second.
    generateMissingDeps.generateThumb = vi.fn(async () => {
      generateMissing.cancel();
      return new Blob(["x"]);
    });

    await generateMissing.start({} as unknown as WasmClient, manifestOf(objects));

    expect(generateMissing.total).toBe(3);
    expect(generateMissing.done).toBe(1);
    expect(generateMissing.failed).toBe(0);
    expect(generateMissingDeps.generateThumb).toHaveBeenCalledTimes(1);
    expect(generateMissing.running).toBe(false);
  });

  it("does nothing (and never flips running) when there are no candidates", async () => {
    const fetchSpy = vi.fn();
    generateMissingDeps.presignGet = fetchSpy as unknown as typeof generateMissingDeps.presignGet;

    await generateMissing.start({} as unknown as WasmClient, manifestOf([]));

    expect(generateMissing.running).toBe(false);
    expect(generateMissing.total).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a no-op re-entrantly while a run is already active", async () => {
    let releaseFirst!: () => void;
    const firstItemGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    generateMissingDeps.presignGet = vi.fn((_client, key) => presignedGet(`https://example.test/${key}`));
    generateMissingDeps.uploadThumb = vi.fn(async (_client, key) => ({
      thumbnailKey: `thumbs/${key}.webp`,
      updated: true,
    }));
    generateMissingDeps.applyThumbnail = vi.fn();
    generateMissingDeps.generateThumb = vi.fn(async () => {
      await firstItemGate;
      return new Blob(["x"]);
    });

    const objects = [obj("a.png")];
    const firstRun = generateMissing.start({} as unknown as WasmClient, manifestOf(objects));
    expect(generateMissing.running).toBe(true);

    // A second call while the first is still in flight must no-op rather
    // than starting a concurrent scan/loop.
    await generateMissing.start({} as unknown as WasmClient, manifestOf(objects));
    expect(generateMissingDeps.generateThumb).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstRun;
    expect(generateMissing.running).toBe(false);
  });
});
