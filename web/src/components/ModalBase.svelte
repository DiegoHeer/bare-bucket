<script lang="ts">
  // Shared modal/overlay base (PR 10/12/13 carry, plan [B2]): dimmed
  // backdrop, Escape-to-close, `role="dialog" aria-modal`, an initial-focus
  // hook, and a Tab/Shift+Tab focus trap. ConflictModal + DeleteConfirmModal
  // refit onto this with zero behavior change; Lightbox uses the `fullscreen`
  // variant.
  //
  // Two host-visible knobs beyond the obvious open/close:
  //  - `closeOnEscape` lets the host suppress Escape entirely (e.g.
  //    DeleteConfirmModal while a delete is in flight — see
  //    lib/deleteConfirm.ts's `escapeShouldCancel`).
  //  - `active` lets the host make this ENTIRE instance inert (no Escape, no
  //    focus trap) without unmounting it — needed when a nested modal (the
  //    delete confirm) is stacked on top of the lightbox [B3]: only the
  //    topmost dialog's keydown handling should run.
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";
  import { FOCUSABLE_SELECTOR, nextFocusIndex } from "../lib/modalFocus";

  interface Props {
    /** id of the element (usually an <h2>) that names this dialog. */
    labelledBy: string;
    onClose: () => void;
    closeOnEscape?: boolean;
    /** When false, this instance's keydown handling (Escape + focus trap) is
     * entirely suppressed — for a backgrounded dialog under a nested modal. */
    active?: boolean;
    fullscreen?: boolean;
    /** Called once on mount to obtain the element to focus initially; falls
     * back to the dialog container itself if omitted or it returns nothing
     * focusable. */
    getInitialFocus?: () => HTMLElement | null | undefined;
    children: Snippet;
  }

  let {
    labelledBy,
    onClose,
    closeOnEscape = true,
    active = true,
    fullscreen = false,
    getInitialFocus,
    children,
  }: Props = $props();

  let dialogEl: HTMLDivElement | undefined = $state();

  onMount(() => {
    const target = getInitialFocus?.() ?? dialogEl;
    target?.focus();
  });

  function focusableElements(): HTMLElement[] {
    if (!dialogEl) return [];
    return Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!active) return;

    if (e.key === "Escape") {
      if (!closeOnEscape) return;
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key !== "Tab") return;
    const focusable = focusableElements();
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const next = nextFocusIndex(currentIndex, focusable.length, e.shiftKey);
    if (next === -1) return;
    e.preventDefault();
    focusable[next]?.focus();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="backdrop" class:fullscreen>
  <div
    class="modal"
    class:fullscreen
    role="dialog"
    aria-modal="true"
    aria-labelledby={labelledBy}
    tabindex="-1"
    bind:this={dialogEl}
  >
    {@render children()}
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
  .modal:focus {
    outline: none;
  }
  .backdrop.fullscreen {
    background: rgba(0, 0, 0, 0.85);
    padding: 0;
  }
  .modal.fullscreen {
    width: 100vw;
    height: 100vh;
    max-width: none;
    border: none;
    border-radius: 0;
    box-shadow: none;
    padding: 0;
    grid-template-rows: auto 1fr;
  }
</style>
