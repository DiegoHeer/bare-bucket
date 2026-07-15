// ModalBase.svelte's focus-trap index math [B2] — component-only concerns
// (querying focusable elements, calling .focus()) are covered by code
// review + Task 3's live keyboard walk, not here (no DOM harness).
import { describe, expect, it } from "vitest";
import { nextFocusIndex } from "../src/lib/modalFocus";

describe("nextFocusIndex", () => {
  it("returns -1 when there's nothing focusable", () => {
    expect(nextFocusIndex(-1, 0, false)).toBe(-1);
    expect(nextFocusIndex(0, 0, true)).toBe(-1);
  });

  it("enters at the first element on Tab when nothing is currently focused", () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
  });

  it("enters at the last element on Shift+Tab when nothing is currently focused", () => {
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
  });

  it("steps forward through the middle of the list", () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1);
    expect(nextFocusIndex(1, 3, false)).toBe(2);
  });

  it("steps backward through the middle of the list", () => {
    expect(nextFocusIndex(2, 3, true)).toBe(1);
    expect(nextFocusIndex(1, 3, true)).toBe(0);
  });

  it("wraps forward from the last element back to the first", () => {
    expect(nextFocusIndex(2, 3, false)).toBe(0);
  });

  it("wraps backward from the first element back to the last", () => {
    expect(nextFocusIndex(0, 3, true)).toBe(2);
  });

  it("cycles trivially within a single-element list", () => {
    expect(nextFocusIndex(0, 1, false)).toBe(0);
    expect(nextFocusIndex(0, 1, true)).toBe(0);
  });
});
