// PDF rendering [B7]: `pdfjs-dist` is lazy-loaded via a dynamic `import()` so
// its ~1MB+ weight only lands in the browser once a user actually opens a
// PDF, never in the main bundle. Its worker is wired the Vite way (a `?url`
// asset import of the shipped worker file) rather than pdf.js's default
// same-origin-script/CDN worker resolution, which wouldn't survive this
// app's bundling.
//
// `loadPdf` is the one seam between this app and pdf.js: it's a plain
// function (not inlined in Lightbox.svelte) specifically so tests can
// `vi.mock` the two dynamic imports inside it and exercise the surrounding
// page-navigation/destroy plumbing without ever loading the real pdf.js
// worker — this project has no DOM harness to render into a real <canvas>
// anyway, so pdf.js's own rendering is out of scope for unit tests (see
// tests/pdfPreview.test.ts, which covers `clampPage` plus a mocked-loader
// smoke test of the handle's shape/destroy behavior).
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

/** Polish item 8: neither edge of a rendered PDF canvas is allowed to exceed
 * this many device pixels — a guard against a pathological page's own MediaBox
 * (e.g. a giant poster-size PDF) or an inflated `devicePixelRatio` producing a
 * canvas the browser can't allocate (canvas dimension limits are commonly
 * ~16-32k px, but the real-world failure mode is exhausting memory well
 * before that). 4096 comfortably covers any realistic display/DPR combo. */
export const MAX_PDF_CANVAS_DIMENSION = 4096;

/**
 * Scale to actually render at, given the page's UNSCALED (`scale: 1`)
 * viewport dimensions and the caller's requested `devicePixelRatio`: the
 * requested scale, unless it would put either edge over
 * `maxDimension`, in which case it's scaled down (preserving aspect ratio)
 * so the longer edge lands exactly on the cap. Pure so this is unit-testable
 * without pdf.js/canvas.
 */
export function clampedPdfRenderScale(
  unscaledWidth: number,
  unscaledHeight: number,
  devicePixelRatio: number,
  maxDimension: number = MAX_PDF_CANVAS_DIMENSION,
): number {
  const longEdge = Math.max(unscaledWidth, unscaledHeight) * devicePixelRatio;
  if (longEdge <= maxDimension) return devicePixelRatio;
  return devicePixelRatio * (maxDimension / longEdge);
}

export interface PdfHandle {
  numPages: number;
  /** Renders `pageNumber` (1-based) into `canvas` at a devicePixelRatio-aware
   * scale. Cancels any still-in-flight render on this handle first, so rapid
   * prev/next clicks don't hit pdf.js's "render already in progress" error. */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, devicePixelRatio: number): Promise<void>;
  /** [B1]/[B7]: destroys the loading task (which tears down its whole
   * document/worker transport) on close/navigate so no decoded page data or
   * the presigned URL pdf.js was given lingers past the preview's lifetime. */
  destroy(): Promise<void>;
}

/**
 * Opens `url` (a presigned GET [B1]) with pdf.js: it range-requests the PDF
 * when the provider/CORS allows `Range` and falls back to a full fetch on
 * its own otherwise [B10] — both acceptable per plan [B7].
 */
export async function loadPdf(url: string): Promise<PdfHandle> {
  const [pdfjs, workerUrlModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = (workerUrlModule as { default: string }).default;

  const loadingTask = pdfjs.getDocument({ url });
  const doc: PDFDocumentProxy = await loadingTask.promise;

  let renderTask: RenderTask | null = null;
  let destroyed = false;

  return {
    numPages: doc.numPages,

    async renderPage(pageNumber, canvas, devicePixelRatio) {
      if (destroyed) return;
      const page: PDFPageProxy = await doc.getPage(pageNumber);
      if (destroyed) return;
      // Cancel whatever's currently rendering AFTER the (async) page fetch
      // above resolves, not before: two overlapping `renderPage` calls (fast
      // prev/next clicks) each start their own `getPage` await, and doing
      // the cancel-check before that point would race — whichever call's
      // `getPage` happens to resolve second wouldn't see the first call's
      // renderTask yet. Checking here, right before superseding it, means
      // whichever call reaches this point second always cancels whatever
      // the other one already started.
      if (renderTask) {
        renderTask.cancel();
        renderTask = null;
      }
      // [Polish item 8] Clamp the actual render scale against the page's
      // own unscaled size so a pathological page/DPR combo can't allocate an
      // oversized canvas — shared by both this lightbox preview (a real
      // `devicePixelRatio`) and thumbs.ts's page-1 full-res render
      // (`devicePixelRatio: 1`), since both route through this one method.
      // CSS display size is pinned to the page's own unscaled dimensions
      // regardless of any clamping, so the on-screen size never changes —
      // only the backing canvas resolution does, in the rare pathological
      // case.
      const unscaled = page.getViewport({ scale: 1 });
      const scale = clampedPdfRenderScale(unscaled.width, unscaled.height, devicePixelRatio);
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${unscaled.width}px`;
      canvas.style.height = `${unscaled.height}px`;

      const task = page.render({ canvas, viewport });
      renderTask = task;
      try {
        await task.promise;
      } catch (e) {
        if (e instanceof pdfjs.RenderingCancelledException) return;
        throw e;
      } finally {
        if (renderTask === task) renderTask = null;
      }
    },

    async destroy() {
      destroyed = true;
      if (renderTask) {
        renderTask.cancel();
        renderTask = null;
      }
      // `loadingTask.destroy()` tears down the whole document/worker
      // transport; `PDFDocumentProxy` in this pdf.js version has no
      // separate `destroy()` of its own to also call.
      await loadingTask.destroy();
    },
  };
}

/** Clamps a requested page number into `[1, numPages]` — pulled out as a
 * pure function (rather than inlined at the prev/next click handlers) so
 * page-navigation bounds are unit-testable. */
export function clampPage(page: number, numPages: number): number {
  if (numPages <= 0) return 1;
  return Math.min(Math.max(page, 1), numPages);
}
