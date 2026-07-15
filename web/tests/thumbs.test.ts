// thumbDimensions' pure long-edge scaling math [B4], plus uploadThumb's
// presign->PUT->set_thumbnail composition [B3] (fully fakeable without any
// DOM/canvas/pdf.js — see thumbs.ts's own comments on why the rest of the
// generation pipeline isn't unit-tested directly, matching pdfPreview.ts's
// precedent).
import { afterEach, describe, expect, it, vi } from "vitest";
import { THUMB_LONG_EDGE, thumbDimensions, uploadThumb } from "../src/lib/thumbs";
import type { PresignedRequest, SetThumbnailReport, WasmClient } from "../src/lib/core";

describe("thumbDimensions", () => {
  it("never upscales an image already at or below the long-edge cap", () => {
    expect(thumbDimensions(100, 50)).toEqual({ width: 100, height: 50 });
    expect(thumbDimensions(THUMB_LONG_EDGE, THUMB_LONG_EDGE)).toEqual({
      width: THUMB_LONG_EDGE,
      height: THUMB_LONG_EDGE,
    });
  });

  it("scales a landscape image down so its long edge (width) hits the cap", () => {
    expect(thumbDimensions(1024, 512)).toEqual({ width: 256, height: 128 });
  });

  it("scales a portrait image down so its long edge (height) hits the cap", () => {
    expect(thumbDimensions(512, 1024)).toEqual({ width: 128, height: 256 });
  });

  it("scales a square image down to exactly the cap on both edges", () => {
    expect(thumbDimensions(1000, 1000)).toEqual({ width: 256, height: 256 });
  });

  it("rounds to whole pixels and never rounds down to 0", () => {
    const { width, height } = thumbDimensions(10000, 1);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
    expect(height).toBeGreaterThanOrEqual(1);
  });

  it("returns zero dimensions for degenerate (zero/negative) input", () => {
    expect(thumbDimensions(0, 100)).toEqual({ width: 0, height: 0 });
    expect(thumbDimensions(100, 0)).toEqual({ width: 0, height: 0 });
    expect(thumbDimensions(-5, 100)).toEqual({ width: 0, height: 0 });
  });
});

function presigned(url: string): PresignedRequest {
  return { method: "PUT", url, expires_secs: 3600 };
}

function fakeClient(overrides: {
  thumbnailKeyFor?: (key: string) => string;
  setThumbnailReport?: SetThumbnailReport;
}): Pick<WasmClient, "thumbnail_key_for" | "presign_put" | "set_thumbnail"> {
  return {
    thumbnail_key_for: vi.fn(
      overrides.thumbnailKeyFor ?? ((key: string) => `.bare-bucket/thumbs/${key}.webp`),
    ) as unknown as WasmClient["thumbnail_key_for"],
    presign_put: vi.fn(() => presigned("https://example.test/thumb-put")) as unknown as WasmClient["presign_put"],
    set_thumbnail: vi.fn(
      async () => (overrides.setThumbnailReport ?? { updated: true }) as SetThumbnailReport,
    ) as unknown as WasmClient["set_thumbnail"],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("uploadThumb", () => {
  it("derives the thumb key via thumbnail_key_for, PUTs with the webp content-type, then calls set_thumbnail", async () => {
    const client = fakeClient({});
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["fake-webp-bytes"], { type: "image/webp" });

    const result = await uploadThumb(client as unknown as WasmClient, "photos/cat.png", blob);

    expect(client.thumbnail_key_for).toHaveBeenCalledWith("photos/cat.png");
    expect(client.presign_put).toHaveBeenCalledWith(".bare-bucket/thumbs/photos/cat.png.webp", expect.any(Number));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/thumb-put",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "image/webp" },
        body: blob,
      }),
    );
    expect(client.set_thumbnail).toHaveBeenCalledWith(
      "photos/cat.png",
      ".bare-bucket/thumbs/photos/cat.png.webp",
    );
    expect(result).toEqual({ thumbnailKey: ".bare-bucket/thumbs/photos/cat.png.webp", updated: true });
  });

  it("surfaces updated: false from set_thumbnail's found-flag no-op cases without throwing", async () => {
    const client = fakeClient({ setThumbnailReport: { updated: false } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const blob = new Blob(["x"]);

    const result = await uploadThumb(client as unknown as WasmClient, "gone.png", blob);

    expect(result.updated).toBe(false);
  });

  it("rejects when the PUT responds non-2xx, without ever calling set_thumbnail", async () => {
    const client = fakeClient({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    const blob = new Blob(["x"]);

    await expect(uploadThumb(client as unknown as WasmClient, "photo.png", blob)).rejects.toThrow("403");
    expect(client.set_thumbnail).not.toHaveBeenCalled();
  });
});
