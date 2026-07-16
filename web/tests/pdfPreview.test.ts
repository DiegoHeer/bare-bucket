// [B7]: `clampPage` is a pure page-bounds helper, tested directly. `loadPdf`
// wraps two dynamic imports (`pdfjs-dist` and its worker `?url` asset) —
// that's the seam this test mocks with `vi.doMock` instead of loading the
// real pdf.js/worker bundle (this project has no DOM/canvas harness to
// render into anyway), so only the orchestration around the mocked API
// (doc-open -> numPages, page render plumbing, destroy) is verified here.
import { describe, expect, it, vi } from "vitest";
import { clampedPdfRenderScale, clampPage, MAX_PDF_CANVAS_DIMENSION } from "../src/lib/pdfPreview";

describe("clampPage", () => {
  it("clamps below 1 up to 1", () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(-3, 5)).toBe(1);
  });

  it("clamps above numPages down to numPages", () => {
    expect(clampPage(9, 5)).toBe(5);
  });

  it("passes values already in range through unchanged", () => {
    expect(clampPage(3, 5)).toBe(3);
  });

  it("returns 1 when there are no pages to clamp into", () => {
    expect(clampPage(3, 0)).toBe(1);
    expect(clampPage(1, -1)).toBe(1);
  });
});

describe("clampedPdfRenderScale", () => {
  it("returns the requested scale unchanged when the result fits under the cap", () => {
    expect(clampedPdfRenderScale(612, 792, 2)).toBe(2); // a normal US-letter page at 2x DPR
  });

  it("scales down a pathologically large page so its long edge lands exactly on the cap", () => {
    const scale = clampedPdfRenderScale(20000, 10000, 1);
    expect(20000 * scale).toBeCloseTo(MAX_PDF_CANVAS_DIMENSION);
    expect(10000 * scale).toBeLessThan(MAX_PDF_CANVAS_DIMENSION);
  });

  it("scales down for an inflated devicePixelRatio on an otherwise-normal page", () => {
    const scale = clampedPdfRenderScale(612, 792, 10); // absurd DPR
    expect(792 * scale).toBeCloseTo(MAX_PDF_CANVAS_DIMENSION);
  });

  it("clamps against a portrait page's long edge (height), not just width", () => {
    const scale = clampedPdfRenderScale(1000, 20000, 1);
    expect(20000 * scale).toBeCloseTo(MAX_PDF_CANVAS_DIMENSION);
  });

  it("honors a custom maxDimension override", () => {
    expect(clampedPdfRenderScale(1000, 1000, 1, 500)).toBeCloseTo(0.5);
  });
});

describe("loadPdf (pdf.js mocked at the dynamic-import seam)", () => {
  it("opens the doc, exposes numPages, renders a page, and tears down via loadingTask.destroy()", async () => {
    class RenderingCancelledException extends Error {}

    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const getPage = vi.fn(async (pageNumber: number) => ({
      pageNumber,
      getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
      render,
    }));
    const doc = { numPages: 3, getPage };
    const loadingTaskDestroy = vi.fn(async () => {});
    const loadingTask = { promise: Promise.resolve(doc), destroy: loadingTaskDestroy };
    const getDocument = vi.fn(() => loadingTask);
    const globalWorkerOptions: { workerSrc?: string } = {};

    vi.doMock("pdfjs-dist", () => ({
      getDocument,
      GlobalWorkerOptions: globalWorkerOptions,
      RenderingCancelledException,
    }));
    vi.doMock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "mock-worker-url" }));

    const { loadPdf } = await import("../src/lib/pdfPreview");
    const handle = await loadPdf("https://example.test/presigned-url");

    expect(globalWorkerOptions.workerSrc).toBe("mock-worker-url");
    expect(getDocument).toHaveBeenCalledWith({ url: "https://example.test/presigned-url" });
    expect(handle.numPages).toBe(3);

    const canvas = { width: 0, height: 0, style: {} as CSSStyleDeclaration } as unknown as HTMLCanvasElement;
    await handle.renderPage(2, canvas, 2);
    expect(getPage).toHaveBeenCalledWith(2);
    expect(canvas.width).toBe(200); // 100 * devicePixelRatio(2)
    expect(canvas.height).toBe(400); // 200 * devicePixelRatio(2)
    expect(render).toHaveBeenCalledTimes(1);

    await handle.destroy();
    expect(loadingTaskDestroy).toHaveBeenCalledTimes(1);

    vi.doUnmock("pdfjs-dist");
    vi.doUnmock("pdfjs-dist/build/pdf.worker.min.mjs?url");
  });

  it("cancels an in-flight render before starting the next one", async () => {
    class RenderingCancelledException extends Error {}

    const cancel1 = vi.fn();
    const cancel2 = vi.fn();
    let call = 0;
    const render = vi.fn(() => {
      call += 1;
      return call === 1 ? { promise: new Promise(() => {}), cancel: cancel1 } : { promise: Promise.resolve(), cancel: cancel2 };
    });
    const getPage = vi.fn(async (pageNumber: number) => ({
      pageNumber,
      getViewport: ({ scale }: { scale: number }) => ({ width: 10 * scale, height: 10 * scale }),
      render,
    }));
    const doc = { numPages: 2, getPage };
    const loadingTask = { promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) };

    vi.doMock("pdfjs-dist", () => ({
      getDocument: () => loadingTask,
      GlobalWorkerOptions: {},
      RenderingCancelledException,
    }));
    vi.doMock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "mock-worker-url" }));

    const { loadPdf } = await import("../src/lib/pdfPreview");
    const handle = await loadPdf("https://example.test/presigned-url");
    const canvas = { width: 0, height: 0, style: {} as CSSStyleDeclaration } as unknown as HTMLCanvasElement;

    // Fire page 1's render but don't await it (its promise never resolves),
    // then immediately request page 2 — this must cancel page 1's task.
    void handle.renderPage(1, canvas, 1);
    await handle.renderPage(2, canvas, 1);

    expect(cancel1).toHaveBeenCalledTimes(1);

    vi.doUnmock("pdfjs-dist");
    vi.doUnmock("pdfjs-dist/build/pdf.worker.min.mjs?url");
  });
});
