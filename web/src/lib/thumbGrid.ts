// FileGrid lazy-thumb decision logic (spec §9, plan [B7][B8]) pulled out as
// a pure helper — same reasoning as pdfPreview's `clampPage`/preview.ts's
// routing functions: this project has no DOM harness, so the
// IntersectionObserver plumbing itself (GridThumb.svelte) stays untested,
// but the actual gating decision it makes on every observer callback/state
// change is a plain function and IS unit-tested.
export type ThumbLoadState = "pending" | "loading" | "loaded" | "error";

/**
 * Decides whether a grid tile should (re-)fetch its presigned thumbnail URL
 * right now [B7]: only once — when the tile HAS a `thumbnail_key`, is
 * (near-)visible per the IntersectionObserver, and hasn't already started
 * (or finished, or failed) a fetch. `state` transitioning to anything other
 * than "pending" (set by the caller before actually fetching) is what makes
 * this idempotent across repeated intersection callbacks/effect re-runs.
 */
export function shouldFetchThumb(opts: {
  thumbnailKey: string | null;
  isIntersecting: boolean;
  state: ThumbLoadState;
}): boolean {
  return opts.thumbnailKey !== null && opts.isIntersecting && opts.state === "pending";
}
