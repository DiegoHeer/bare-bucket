// FileGrid's lazy-thumb gating decision [B7] — pure, so it's tested directly
// without needing a real IntersectionObserver/DOM harness (see GridThumb.svelte's
// own comment on why the component itself isn't unit-tested).
import { describe, expect, it } from "vitest";
import { shouldFetchThumb } from "../src/lib/thumbGrid";

describe("shouldFetchThumb", () => {
  it("fetches when there's a thumbnail_key, the tile is intersecting, and nothing has started yet", () => {
    expect(shouldFetchThumb({ thumbnailKey: "thumbs/a.webp", isIntersecting: true, state: "pending" })).toBe(
      true,
    );
  });

  it("does not fetch when there is no thumbnail_key", () => {
    expect(shouldFetchThumb({ thumbnailKey: null, isIntersecting: true, state: "pending" })).toBe(false);
  });

  it("does not fetch while the tile is off-screen", () => {
    expect(shouldFetchThumb({ thumbnailKey: "thumbs/a.webp", isIntersecting: false, state: "pending" })).toBe(
      false,
    );
  });

  it("does not re-fetch once loading has already started", () => {
    expect(shouldFetchThumb({ thumbnailKey: "thumbs/a.webp", isIntersecting: true, state: "loading" })).toBe(
      false,
    );
  });

  it("does not re-fetch a tile that already loaded", () => {
    expect(shouldFetchThumb({ thumbnailKey: "thumbs/a.webp", isIntersecting: true, state: "loaded" })).toBe(
      false,
    );
  });

  it("does not retry a tile whose fetch already failed", () => {
    expect(shouldFetchThumb({ thumbnailKey: "thumbs/a.webp", isIntersecting: true, state: "error" })).toBe(
      false,
    );
  });
});
