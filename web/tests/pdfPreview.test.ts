// [B7]: `clampPage` is a pure page-bounds helper, tested directly. `loadPdf`
// wraps two dynamic imports (`pdfjs-dist` and its worker `?url` asset) —
// that's the seam this test mocks with `vi.doMock` instead of loading the
// real pdf.js/worker bundle (this project has no DOM/canvas harness to
// render into anyway), so only the orchestration around the mocked API
// (doc-open -> numPages, page render plumbing, destroy) is verified here.
import { describe, expect, it, vi } from "vitest";
import { clampPage } from "../src/lib/pdfPreview";

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
