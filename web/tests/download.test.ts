// Unit-tests the parts of download.ts that don't need a real browser. Neither
// jsdom nor happy-dom is an installed dependency here (both are only
// *optional* peers of vitest — see package-lock.json — and adding either
// would violate this PR's "no new deps" constraint), so `window`/`document`
// are stubbed by hand via `globalThis` instead of switching the test
// environment. That's enough for these functions: `supportsFsa`/
// `pickSaveTarget` only ever touch a couple of `window` properties, and
// `anchorDownload` only touches `document.createElement`/`body.appendChild`/
// `body.removeChild`/`anchor.click`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorDownload, pickSaveTarget, supportsFsa } from "../src/lib/download";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

describe("supportsFsa", () => {
  it("is false when window doesn't exist", () => {
    expect(supportsFsa()).toBe(false);
  });

  it("is false when showSaveFilePicker is missing, even in a secure context", () => {
    (globalThis as { window?: unknown }).window = { isSecureContext: true };
    expect(supportsFsa()).toBe(false);
  });

  it("is false when showSaveFilePicker exists but the context isn't secure", () => {
    (globalThis as { window?: unknown }).window = {
      showSaveFilePicker: () => Promise.resolve(),
      isSecureContext: false,
    };
    expect(supportsFsa()).toBe(false);
  });

  it("is true when showSaveFilePicker exists and the context is secure", () => {
    (globalThis as { window?: unknown }).window = {
      showSaveFilePicker: () => Promise.resolve(),
      isSecureContext: true,
    };
    expect(supportsFsa()).toBe(true);
  });
});

describe("pickSaveTarget", () => {
  it("passes suggestedName through and returns the writable from a successful pick", async () => {
    const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    const createWritable = vi.fn(async () => writable);
    const showSaveFilePicker = vi.fn(async (opts?: { suggestedName?: string }) => {
      expect(opts).toEqual({ suggestedName: "photo.png" });
      return { createWritable };
    });
    (globalThis as { window?: unknown }).window = { showSaveFilePicker };

    const result = await pickSaveTarget("photo.png");

    expect(result).toBe(writable);
    expect(createWritable).toHaveBeenCalledTimes(1);
  });

  it("returns null on user cancel (AbortError) rather than throwing", async () => {
    (globalThis as { window?: unknown }).window = {
      showSaveFilePicker: vi.fn(async () => {
        throw new DOMException("cancelled", "AbortError");
      }),
    };

    await expect(pickSaveTarget("photo.png")).resolves.toBeNull();
  });

  it("rethrows any other failure", async () => {
    (globalThis as { window?: unknown }).window = {
      showSaveFilePicker: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    };

    await expect(pickSaveTarget("photo.png")).rejects.toThrow("permission denied");
  });
});

describe("anchorDownload", () => {
  it("creates an <a>, sets href and a download hint, clicks it, and removes it synchronously", () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    const order: string[] = [];
    const createElement = vi.fn((tag: string) => {
      expect(tag).toBe("a");
      return anchor;
    });
    const appendChild = vi.fn(() => order.push("append"));
    const removeChild = vi.fn(() => order.push("remove"));
    anchor.click.mockImplementation(() => order.push("click"));
    (globalThis as { document?: unknown }).document = {
      createElement,
      body: { appendChild, removeChild },
    };

    anchorDownload("https://example.test/get?sig=abc123");

    expect(anchor.href).toBe("https://example.test/get?sig=abc123");
    expect(anchor.download).toBe("");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(removeChild).toHaveBeenCalledWith(anchor);
    // Synchronous: appended, clicked, then removed — all within this one
    // call, never left dangling in the DOM.
    expect(order).toEqual(["append", "click", "remove"]);
  });
});
