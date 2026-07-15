// Pure threshold logic for the transfer engine's progress-write throttle
// (plan item 13 [B2]) — see progressThrottle.ts's own module doc for the
// rules being tested here.
import { describe, expect, it } from "vitest";
import { shouldWriteProgress } from "../src/lib/progressThrottle";

describe("shouldWriteProgress", () => {
  it("always writes the terminal value, even if it lands inside both throttle windows", () => {
    const lastWrite = { bytes: 999_990, at: 1000 };
    const next = { bytes: 1_000_000, at: 1000 }; // 0 elapsed, tiny delta, but this IS the total
    expect(shouldWriteProgress(lastWrite, next, 1_000_000)).toBe(true);
  });

  it("writes past-total readings too (a final chunk landing over the declared size)", () => {
    const lastWrite = { bytes: 0, at: 0 };
    const next = { bytes: 1_000_001, at: 0 };
    expect(shouldWriteProgress(lastWrite, next, 1_000_000)).toBe(true);
  });

  it("writes when the byte delta alone crosses 0.5% of total, even with zero elapsed time", () => {
    const lastWrite = { bytes: 0, at: 1000 };
    const next = { bytes: 5001, at: 1000 }; // 0.5001% of 1,000,000
    expect(shouldWriteProgress(lastWrite, next, 1_000_000)).toBe(true);
  });

  it("suppresses a write when neither the byte delta nor the time delta clears its threshold", () => {
    const lastWrite = { bytes: 100_000, at: 1000 };
    const next = { bytes: 100_100, at: 1050 }; // 0.01% of total, 50ms elapsed
    expect(shouldWriteProgress(lastWrite, next, 1_000_000)).toBe(false);
  });

  it("writes when the time delta alone crosses 150ms, even with a negligible byte delta", () => {
    const lastWrite = { bytes: 100_000, at: 1000 };
    const next = { bytes: 100_001, at: 1151 };
    expect(shouldWriteProgress(lastWrite, next, 1_000_000)).toBe(true);
  });

  it("suppresses a write at exactly 149ms with a negligible byte delta", () => {
    const lastWrite = { bytes: 100_000, at: 1000 };
    const next = { bytes: 100_001, at: 1149 };
    expect(shouldWriteProgress(lastWrite, next, 1_000_000)).toBe(false);
  });

  it("always writes when total is zero or negative (nothing to compute a percentage against)", () => {
    expect(shouldWriteProgress({ bytes: 0, at: 0 }, { bytes: 1, at: 0 }, 0)).toBe(true);
    expect(shouldWriteProgress({ bytes: 0, at: 0 }, { bytes: 1, at: 0 }, -5)).toBe(true);
  });

  it("writes the very first progress event for a small transfer where any delta clears 0.5%", () => {
    // Mirrors the tiny synthetic sizes the transfer-engine race tests use
    // (e.g. a 10-byte part) — any nonzero delta is already >= 0.5% of 10.
    expect(shouldWriteProgress({ bytes: 0, at: 0 }, { bytes: 1, at: 0 }, 10)).toBe(true);
  });
});
