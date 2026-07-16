// Pure decision helpers backing DeleteConfirmModal.svelte's keyboard/submit
// gating (PR 12 [B9][B10]) — kept here, not inline in the component, so
// they're unit-testable without a DOM (this project has no jsdom/
// testing-library harness yet; see tests/deleteConfirm.test.ts).

/** Escape cancels the modal, but only while no delete is in flight — once
 * `confirmDelete()` has started, a stray Escape shouldn't abandon an
 * already-dispatched request. Note this only decides what a "Escape" key
 * does; Enter is never wired to anything here at all — the modal relies on
 * initial focus landing on the Cancel button (see onMount in the
 * component) so a bare Enter activates Cancel, never the destructive
 * confirm action [B9]. */
export function escapeShouldCancel(key: string, deleting: boolean): boolean {
  return key === "Escape" && !deleting;
}

export interface ConfirmResult {
  /** `null` on success; the formatted message on a rejection. */
  error: string | null;
}

/** Runs `onConfirm()` and converts a rejection into a display-ready error
 * message instead of letting it throw — the same catch/format
 * DeleteConfirmModal.svelte's own confirm handler applies. On success there
 * is nothing further to do here: closing the modal is the caller's
 * (BrowseScreen's) responsibility once ITS OWN await on the same promise
 * chain resolves. On failure, the manifest is untouched (session.deleteObject
 * never applied the tombstone) and the returned error is meant to be shown
 * in-modal while the modal stays open [B10]. */
export async function runConfirmDelete(onConfirm: () => Promise<void>): Promise<ConfirmResult> {
  try {
    await onConfirm();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
