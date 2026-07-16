// Client-side thumbnail generation + upload (spec §9, plan [B1][B3][B4]):
// canvas/createImageBitmap downscale for images, pdf.js page-1 (via the
// existing lazy `pdfPreview` seam) for PDFs. Deliberately no image code
// crosses into Rust — the core only gains a `set_thumbnail` manifest
// mutation ([B1]); everything here is browser-side.
import { loadPdf } from "./pdfPreview";
import type { PresignedRequest, SetThumbnailReport, WasmClient } from "./core";

/** [B4]: thumbnails are capped to this long-edge size, never upscaled. */
export const THUMB_LONG_EDGE = 256;

/** [B4]: `canvas.toBlob("image/webp", THUMB_QUALITY)`. */
export const THUMB_QUALITY = 0.75;

export const THUMB_CONTENT_TYPE = "image/webp";

// Local copy of the transfer engine's presign expiry — mirrors
// transfers.svelte.ts's/BrowseScreen.svelte's/Lightbox.svelte's own copies of
// this constant (each site defines it independently; no shared export
// exists for it, same convention as those call sites' own comments).
const PRESIGN_EXPIRES_SECS = 3600;

/**
 * Pure long-edge scaling math [B4]: scales `(width, height)` down so its
 * longer edge is at most `THUMB_LONG_EDGE`, preserving aspect ratio, and
 * NEVER upscales — an image already smaller than the target is returned
 * unchanged. Rounds to whole pixels (minimum 1px) since canvas dimensions
 * must be integers.
 */
export function thumbDimensions(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const longEdge = Math.max(width, height);
  if (longEdge <= THUMB_LONG_EDGE) return { width, height };
  const scale = THUMB_LONG_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"))),
      THUMB_CONTENT_TYPE,
      THUMB_QUALITY,
    );
  });
}

/**
 * Rasterizes `blob` via a plain `<img>` + `decode()` (same no-inline-
 * injection rule as previews — the bytes are handed to the browser's own
 * image decoder via an object URL, never parsed/executed as markup) and
 * hands the decoded image to `createImageBitmap`. This is the fallback path
 * for sources `createImageBitmap` can't decode directly — SVG being the
 * common case, since not every browser's `createImageBitmap` supports it.
 */
async function bitmapViaImgElement(blob: Blob): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Generates a WebP thumbnail from an image `blob` [B4]: `createImageBitmap`
 * decode → canvas downscale (`thumbDimensions`) → `toBlob`. Falls back to
 * the `<img>` decode path (`bitmapViaImgElement`) when `createImageBitmap`
 * rejects the blob directly (e.g. SVG in browsers whose `createImageBitmap`
 * doesn't accept it).
 */
export async function generateImageThumb(blob: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    // `imageOrientation: "from-image"` — createImageBitmap's own default is
    // "none" (ignore EXIF), which would thumb EXIF-rotated photos sideways;
    // `<img>` decoding (the fallback below) already auto-applies EXIF per the
    // HTML spec, so this option only matters on this direct-from-Blob path.
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    bitmap = await bitmapViaImgElement(blob);
  }
  try {
    const { width, height } = thumbDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await canvasToBlob(canvas);
  } finally {
    bitmap.close();
  }
}

/**
 * Generates a WebP thumbnail of PAGE 1 of the PDF at `url` (a presigned GET,
 * per the same contract as `pdfPreview.loadPdf`) [B1]. Reuses the existing
 * lazy pdf.js seam rather than duplicating any of its loading/render/destroy
 * plumbing: renders page 1 at its NATIVE resolution (scale 1) into a
 * throwaway canvas — `PdfHandle.renderPage` bundles `getViewport` and
 * `page.render` together with no separate "measure only" step, so there's no
 * cheaper way to learn the page's unscaled dimensions through this seam —
 * then downscales that into the final thumb canvas via `drawImage`
 * (`thumbDimensions`), so pdf.js only ever renders the page once.
 */
export async function generatePdfThumb(url: string): Promise<Blob> {
  const handle = await loadPdf(url);
  try {
    const fullCanvas = document.createElement("canvas");
    await handle.renderPage(1, fullCanvas, 1);
    const { width, height } = thumbDimensions(fullCanvas.width, fullCanvas.height);
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = width;
    thumbCanvas.height = height;
    const ctx = thumbCanvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    ctx.drawImage(fullCanvas, 0, 0, width, height);
    return await canvasToBlob(thumbCanvas);
  } finally {
    await handle.destroy();
  }
}

/** What `generateThumbFor` can generate a thumbnail from — the on-upload
 * hook has the local `File` in hand (no re-download, per plan); the
 * generate-missing runner only has a presigned GET URL for the out-of-band
 * original. */
export type ThumbSource = Blob | string;

/**
 * Dispatches thumbnail generation by `previewKind` ("image" | "pdf" only —
 * callers gate on this before calling in). `source` is either a local
 * `Blob`/`File` or a presigned GET URL string:
 *  - image: a URL source is fetched into a `Blob` first (`createImageBitmap`
 *    needs image data, not a URL); a `Blob` source is used as-is.
 *  - pdf: pdf.js wants a URL — a `Blob` source is turned into a temporary
 *    object URL for the duration of the render, then revoked.
 */
export async function generateThumbFor(kind: "image" | "pdf", source: ThumbSource): Promise<Blob> {
  if (kind === "image") {
    const blob = typeof source === "string" ? await (await fetch(source)).blob() : source;
    return generateImageThumb(blob);
  }
  // kind === "pdf"
  if (typeof source === "string") return generatePdfThumb(source);
  const objectUrl = URL.createObjectURL(source);
  try {
    return await generatePdfThumb(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function putThumbBlob(url: string, blob: Blob, contentType: string): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!response.ok) {
    throw new Error(`thumbnail upload failed with status ${response.status}`);
  }
}

export interface UploadThumbResult {
  thumbnailKey: string;
  /** Mirrors `SetThumbnailReport.updated` — `false` means `set_thumbnail`
   * no-opped (absent key, tombstoned row, identical value); the caller
   * should skip any local-manifest mirroring in that case. */
  updated: boolean;
}

/**
 * Uploads `blob` as `key`'s thumbnail [B3]: derives the thumb key via the
 * SAME `thumbnail_key_for` shape core uses (no separately-invented key
 * layout), presigns a PUT for it, PUTs with `blob`'s OWN `type` as the
 * `Content-Type` (see below), then calls `set_thumbnail` to record it in the
 * manifest.
 *
 * `canvas.toBlob("image/webp", …)` silently falls back to PNG bytes on
 * engines lacking a WebP encoder — it never rejects. Trusting the requested
 * `THUMB_CONTENT_TYPE` in that case would PUT PNG bytes under a `.webp`-
 * suffixed key with an `image/webp` header, which is wrong even though it
 * happens to render (browsers byte-sniff `<img>` content over trusting the
 * extension/header). So the PUT's `Content-Type` is threaded from the blob's
 * ACTUAL `type` rather than hardcoded; the `.webp` key suffix stays as-is
 * per the manifest's key-layout contract regardless of the real encoding.
 */
export async function uploadThumb(client: WasmClient, key: string, blob: Blob): Promise<UploadThumbResult> {
  const thumbnailKey = client.thumbnail_key_for(key);
  const presigned = client.presign_put(thumbnailKey, PRESIGN_EXPIRES_SECS) as PresignedRequest;
  const contentType = blob.type || THUMB_CONTENT_TYPE;
  if (contentType !== THUMB_CONTENT_TYPE) {
    console.warn(
      `thumbnail for "${key}" was encoded as "${contentType}", not ${THUMB_CONTENT_TYPE} ` +
        `(engine likely lacks a WebP encoder) — uploading the actual bytes/type under the ` +
        `.webp-suffixed key anyway; browsers byte-sniff image content so it still renders.`,
    );
  }
  await putThumbBlob(presigned.url, blob, contentType);
  const report = (await client.set_thumbnail(key, thumbnailKey)) as SetThumbnailReport;
  return { thumbnailKey, updated: report.updated };
}
