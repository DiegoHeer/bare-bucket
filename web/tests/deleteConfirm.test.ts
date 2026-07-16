// PR 12: DeleteConfirmModal.svelte's keyboard/submit gating logic [B9][B10],
// extracted to a pure module so it's unit-testable without a DOM (this
// project has no jsdom/testing-library harness). Component-only concerns
// (initial focus landing on Cancel, backdrop markup, actual DOM keydown
// wiring) are covered by code review + Task 3's live keyboard walk, not
// here.
import { describe, expect, it } from "vitest";
import { escapeShouldCancel, runConfirmDelete } from "../src/lib/deleteConfirm";

describe("escapeShouldCancel", () => {
  it("cancels on Escape when no delete is in flight", () => {
    expect(escapeShouldCancel("Escape", false)).toBe(true);
  });

  it("does not cancel on Escape while a delete is in flight", () => {
    expect(escapeShouldCancel("Escape", true)).toBe(false);
  });

  it("ignores every other key, including Enter — nothing here ever maps Enter to confirm", () => {
    expect(escapeShouldCancel("Enter", false)).toBe(false);
    expect(escapeShouldCancel("Enter", true)).toBe(false);
    expect(escapeShouldCancel(" ", false)).toBe(false);
  });
});

describe("runConfirmDelete", () => {
  it("calls the confirm callback and reports no error on success", async () => {
    let called = false;
    const result = await runConfirmDelete(async () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(result.error).toBeNull();
  });

  it("converts a rejection into a display-ready error message instead of throwing", async () => {
    const result = await runConfirmDelete(async () => {
      throw new Error("object delete failed");
    });
    expect(result.error).toBe("object delete failed");
  });

  it("stringifies a non-Error rejection", async () => {
    const result = await runConfirmDelete(async () => {
      throw "plain string failure";
    });
    expect(result.error).toBe("plain string failure");
  });
});
