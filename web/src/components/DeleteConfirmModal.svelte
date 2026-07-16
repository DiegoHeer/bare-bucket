<script lang="ts">
  // Permanent-delete confirm dialog (spec §7.6, PR 12 [B9]). Mirrors
  // ConflictModal's structure/level closely on purpose — PR 13 extracts a
  // shared modal base and wants the mechanical diff between the two to stay
  // small.
  //
  // Confirm is never reachable via a bare Enter: initial focus lands on
  // Cancel (like ConflictModal), and there is deliberately no keydown
  // handling that maps Enter to the destructive action — activating the
  // focused Cancel button with Enter is fine, since that's Cancel, not
  // Delete. The Delete button must be explicitly clicked/activated once
  // focus is moved to it.
  import { onMount } from "svelte";
  import { escapeShouldCancel, runConfirmDelete } from "../lib/deleteConfirm";

  interface Props {
    /** Display name only (not the full key) — matches ConflictModal's
     * `file.name` usage; BrowseScreen derives this once via `displayName`. */
    name: string;
    /** Awaited here, not by the caller — this component owns the in-modal
     * loading/error state around the call so a failure keeps the modal open
     * with the error visible [B10], and BrowseScreen only has to close the
     * modal on the success path. */
    onConfirm: () => Promise<void>;
    onCancel: () => void;
  }

  let { name, onConfirm, onCancel }: Props = $props();

  let cancelButton: HTMLButtonElement | undefined = $state();
  let deleting = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    cancelButton?.focus();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (escapeShouldCancel(e.key, deleting)) {
      e.preventDefault();
      onCancel();
    }
  }

  async function confirmDelete() {
    if (deleting) return;
    deleting = true;
    error = null;
    // Success: the caller is responsible for closing the modal (removing it
    // from the DOM) once ITS OWN await on `onConfirm()` resolves — this
    // component never unmounts itself, it just clears `deleting`/`error`.
    const result = await runConfirmDelete(onConfirm);
    error = result.error;
    deleting = false;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="backdrop">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title" tabindex="-1">
    <h2 id="delete-title">Delete file</h2>
    <p>“{name}” will be permanently deleted. This can't be undone.</p>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    <div class="actions">
      <button class="danger" onclick={confirmDelete} disabled={deleting}>
        {deleting ? "Deleting…" : "Delete"}
      </button>
      <button class="ghost" bind:this={cancelButton} onclick={onCancel} disabled={deleting}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: grid;
    place-items: center;
    z-index: 100;
  }
  .modal {
    width: min(380px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.4);
    padding: 20px;
    display: grid;
    gap: 10px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    color: var(--text-bright);
  }
  p {
    margin: 0;
    color: var(--text);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .error {
    color: var(--danger);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }
  .danger {
    background: var(--danger);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 7px 14px;
    font-weight: 700;
  }
  .danger:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .ghost {
    background: none;
    border: 1px solid var(--border-strong);
    color: var(--text-dim);
    border-radius: var(--radius-small);
    padding: 7px 14px;
  }
  .ghost:hover {
    color: var(--text-bright);
  }
  .ghost:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
