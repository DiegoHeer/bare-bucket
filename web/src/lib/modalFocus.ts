// ModalBase.svelte's focus-trap index math [B2], extracted to a pure module
// so it's unit-testable without a DOM (this project has no jsdom/
// testing-library harness — see tests/modalFocus.test.ts). Everything DOM-y
// (querying the focusable elements, actually calling .focus()) stays in the
// component; this is only the "given where focus is now, where should Tab /
// Shift+Tab send it" decision.

/** CSS selector for elements ModalBase's focus trap cycles between. Kept
 * narrow to the handful of interactive element types this app's modals
 * actually use (buttons, plus a general fallback for anything with an
 * explicit non-negative tabindex) rather than a fully general a11y query. */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Given the index of the currently focused element among `count` focusable
 * elements inside a trapped dialog (`-1` if focus is currently outside that
 * list — e.g. the dialog container itself, or nothing focusable exists),
 * computes which index Tab (`shiftKey` false) or Shift+Tab (`shiftKey` true)
 * should move focus to next, cycling within `[0, count)`.
 *
 * Returns `-1` when there is nothing focusable to move to (`count <= 0`) —
 * the caller should leave the key's default behavior alone in that case.
 */
export function nextFocusIndex(currentIndex: number, count: number, shiftKey: boolean): number {
  if (count <= 0) return -1;
  if (currentIndex === -1) return shiftKey ? count - 1 : 0;
  const direction = shiftKey ? -1 : 1;
  return (currentIndex + direction + count) % count;
}
