import { describe, expect, it } from "vitest";
import { nextFreeName, partRanges } from "../src/lib/upload";

describe("nextFreeName", () => {
  it("appends (1) when the base name is taken", () => {
    expect(nextFreeName("photo.jpg", new Set(["photo.jpg"]))).toBe("photo (1).jpg");
  });

  it("returns the name unchanged when it isn't taken", () => {
    expect(nextFreeName("photo.jpg", new Set())).toBe("photo.jpg");
  });

  it("chains to the next free suffix when earlier suffixes are also taken", () => {
    const taken = new Set(["photo.jpg", "photo (1).jpg"]);
    expect(nextFreeName("photo.jpg", taken)).toBe("photo (2).jpg");
  });

  it("handles extensionless names", () => {
    expect(nextFreeName("README", new Set(["README"]))).toBe("README (1)");
  });

  it("handles dotfiles (no extension split on the leading dot)", () => {
    expect(nextFreeName(".env", new Set([".env"]))).toBe(".env (1)");
  });

  it("keeps a multi-dot extension intact, splitting at the first dot", () => {
    expect(nextFreeName("a.tar.gz", new Set(["a.tar.gz"]))).toBe("a (1).tar.gz");
  });
});

describe("partRanges", () => {
  it("splits an exact multiple into equal parts", () => {
    expect(partRanges(200, 100)).toEqual([
      { partNumber: 1, start: 0, end: 100 },
      { partNumber: 2, start: 100, end: 200 },
    ]);
  });

  it("gives the remainder to the last part", () => {
    expect(partRanges(250, 100)).toEqual([
      { partNumber: 1, start: 0, end: 100 },
      { partNumber: 2, start: 100, end: 200 },
      { partNumber: 3, start: 200, end: 250 },
    ]);
  });

  it("returns a single part when size is below part size", () => {
    expect(partRanges(50, 100)).toEqual([{ partNumber: 1, start: 0, end: 50 }]);
  });

  it("returns no parts for a zero-byte file", () => {
    expect(partRanges(0, 5)).toEqual([]);
  });

  it("covers the size exactly with contiguous 1-based parts", () => {
    const size = 64 * 1024 * 1024 * 3 + 12345;
    const partSize = 64 * 1024 * 1024;
    const ranges = partRanges(size, partSize);
    let expectedStart = 0;
    ranges.forEach((r, i) => {
      expect(r.partNumber).toBe(i + 1);
      expect(r.start).toBe(expectedStart);
      expect(r.end).toBeGreaterThan(r.start);
      expectedStart = r.end;
    });
    expect(expectedStart).toBe(size);
  });
});
