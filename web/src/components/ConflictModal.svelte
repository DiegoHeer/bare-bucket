<script lang="ts">
  // Object-level conflict modal (spec §8.3): shown when the target key of an
  // upload already names a live manifest object. One instance is rendered
  // per queued conflict — BrowseScreen keys the block by the conflict's id
  // so a fresh instance mounts per conflict, which both re-runs the
  // head_object check below and re-focuses the Cancel button for each new
  // conflict in the queue.
  import { onMount } from "svelte";
  import { session } from "../lib/session.svelte";
  import type { HeadResult } from "../lib/core";
  import { nextFreeName } from "../lib/upload";

  interface Props {
    file: File;
    targetKey: string;
    takenNames: Set<string>;
    onOverwrite: () => void;
    onSaveAsCopy: (newName: string) => void;
    onCancel: () => void;
  }

  let { file, targetKey, takenNames, onOverwrite, onSaveAsCopy, onCancel }: Props = $props();

  let cancelButton: HTMLButtonElement | undefined = $state();

  // Out-of-band warning: the manifest's ETag for this key vs. what's
  // actually on the provider right now (some other tool may have written
  // over it since the last reconcile). Best-effort — a failed head_object
  // (e.g. transient network blip) just skips the extra warning rather than
  // blocking the modal's choices.
  let outOfBand = $state(false);

  // BrowseScreen mounts one ConflictModal instance per queued conflict
  // (keyed by the conflict's id), so `onMount` runs exactly once per
  // conflict shown — no need to react to prop changes within an instance.
  onMount(() => {
    cancelButton?.focus();
    const client = session.client;
    const manifestEtag = session.manifest?.objects.find((o) => o.key === targetKey)?.etag ?? null;
    if (!client) return;
    void client
      .head_object(targetKey)
      .then((result) => {
        const head = result as HeadResult | null;
        if (head && manifestEtag && head.etag !== manifestEtag) outOfBand = true;
      })
      .catch(() => {
        /* best-effort check; no extra warning if it fails */
      });
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  function saveAsCopy() {
    onSaveAsCopy(nextFreeName(file.name, takenNames));
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="backdrop">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title" tabindex="-1">
    <h2 id="conflict-title">File already exists</h2>
    <p>“{file.name}” already exists in this folder.</p>
    {#if outOfBand}
      <p class="warning">This file changed outside the app since the last sync.</p>
    {/if}
    <div class="actions">
      <button class="primary" onclick={onOverwrite}>Overwrite</button>
      <button class="ghost" onclick={saveAsCopy}>Save as a copy</button>
      <button class="ghost" bind:this={cancelButton} onclick={onCancel}>Cancel</button>
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
  .warning {
    color: #eab308;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }
  .primary {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 7px 14px;
    font-weight: 700;
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
</style>
