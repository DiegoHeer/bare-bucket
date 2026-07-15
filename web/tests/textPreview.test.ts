// Pure-helper tests for the ranged/capped text preview [B5][B6] — the
// range-header builder and the 206-vs-200 truncation decision. This project
// has no DOM harness (see download.test.ts's comment), so `readCapped` is
// exercised against a hand-rolled fake `ReadableStream` reader (same
// stubbing style as download.test.ts) rather than a real stream; the actual
// `fetch()`-calling `fetchTextPreview` is intentionally left untested here —
// it's a thin composition of these pieces.
import { describe, expect, it, vi } from "vitest";
import {
  isTruncated,
  parseContentRangeTotal,
  rangeHeaderValue,
  readCapped,
  resolveTotalSize,
} from "../src/lib/textPreview";

describe("rangeHeaderValue", () => {
  it("defaults to the 256 KiB preview cap", () => {
    expect(rangeHeaderValue()).toBe("bytes=0-262143");
  });

  it("honors a custom cap", () => {
    expect(rangeHeaderValue(1024)).toBe("bytes=0-1023");
  });
});

describe("parseContentRangeTotal", () => {
  it("extracts the total from a well-formed header", () => {
    expect(parseContentRangeTotal("bytes 0-262143/500000")).toBe(500000);
  });

  it("returns null when the header is absent", () => {
    expect(parseContentRangeTotal(null)).toBeNull();
  });

  it("returns null for a malformed header", () => {
    expect(parseContentRangeTotal("bytes 0-262143")).toBeNull();
    expect(parseContentRangeTotal("nonsense")).toBeNull();
  });

  it("returns null for a non-numeric total", () => {
    expect(parseContentRangeTotal("bytes 0-262143/*")).toBeNull();
  });
});

describe("resolveTotalSize", () => {
  it("prefers the Content-Range total when present", () => {
    expect(resolveTotalSize({ contentRangeTotal: 500000, contentLength: 1000, manifestSize: 999 })).toBe(500000);
  });

  it("falls back to Content-Length when Content-Range is absent", () => {
    expect(resolveTotalSize({ contentRangeTotal: null, contentLength: 1000, manifestSize: 999 })).toBe(1000);
  });

  it("falls back to the manifest size when both headers are absent", () => {
    expect(resolveTotalSize({ contentRangeTotal: null, contentLength: null, manifestSize: 999 })).toBe(999);
  });
});

describe("isTruncated", () => {
  it("is false when the object fits within the cap", () => {
    expect(isTruncated(1000, 262144)).toBe(false);
    expect(isTruncated(262144, 262144)).toBe(false); // exactly the cap: not truncated
  });

  it("is true when the object exceeds the cap", () => {
    expect(isTruncated(262145, 262144)).toBe(true);
  });
});

/** Builds a stand-in for a fetch `Response.body` that hands out `chunks` one
 * `read()` call at a time, and records whether/how many times `cancel()` was
 * called — enough surface for `readCapped` without needing a spec-accurate
 * native ReadableStream. */
function fakeBody(chunks: Uint8Array[]) {
  let i = 0;
  const read = vi.fn(async () => {
    if (i >= chunks.length) return { done: true, value: undefined };
    return { done: false, value: chunks[i++] };
  });
  const cancel = vi.fn(async () => {});
  const body = { getReader: () => ({ read, cancel }) } as unknown as ReadableStream<Uint8Array>;
  return { body, read, cancel };
}

describe("readCapped", () => {
  it("returns an empty buffer for a null body", async () => {
    const result = await readCapped(null, 10);
    expect(result).toEqual(new Uint8Array(0));
  });

  it("reads the whole stream when it's under the cap", async () => {
    const { body, cancel } = fakeBody([new Uint8Array([1, 2, 3])]);
    const result = await readCapped(body, 10);
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("caps mid-chunk and cancels the reader instead of reading further chunks", async () => {
    const { body, read, cancel } = fakeBody([
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array([6, 7, 8, 9, 10]), // would exceed the cap
      new Uint8Array([11]), // must never be reached
    ]);
    const result = await readCapped(body, 8);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2); // never asked for the 3rd chunk
  });

  it("stops exactly at a chunk boundary without over-reading", async () => {
    const { body, read } = fakeBody([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8]), new Uint8Array([9])]);
    const result = await readCapped(body, 8);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
