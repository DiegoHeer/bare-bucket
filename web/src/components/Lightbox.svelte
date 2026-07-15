<script lang="ts">
  // Fullscreen preview overlay (spec §7.5, plan [B3][B4][B5][B9]) on
  // ModalBase's fullscreen variant. Task 1 lands the shell + routing switch:
  // every kind renders the metadata+download fallback for now; Task 2 fills
  // in the image/pdf/text renderers behind the same `kind` branches. All
  // overlay actions reuse BrowseScreen's existing handlers/session methods
  // verbatim [B4] — no parallel download/favorite/delete flows here.
  import ModalBase from "./ModalBase.svelte";
  import { session } from "../lib/session.svelte";
  import { displayName, formatModified, formatSize } from "../lib/listing";
  import { previewKind } from "../lib/preview";
  import type { ManifestObject } from "../lib/core";

  interface Props {
    object: ManifestObject;
    canPrev: boolean;
    canNext: boolean;
    onPrev: () => void;
    onNext: () => void;
    onClose: () => void;
    onDownload: (object: ManifestObject) => void;
    /** Opens the (shared) DeleteConfirmModal via BrowseScreen's existing
     * requestDelete flow — same modal the FileList/FileGrid row action
     * uses, not a lightbox-local copy [B4]. */
    onDeleteRequest: (object: ManifestObject) => void;
    /** Mirrors FileList/FileGrid's own guard: disabled while this key has an
     * in-flight transfer. */
    deleteBlocked: boolean;
    /** True while the delete confirm modal is stacked on top of this
     * overlay — suppresses Escape/focus-trap/←/→ handling here so only the
     * topmost dialog reacts to keys [B3]. */
    nestedModalOpen: boolean;
  }

  let {
    object,
    canPrev,
    canNext,
    onPrev,
    onNext,
    onClose,
    onDownload,
    onDeleteRequest,
    deleteBlocked,
    nestedModalOpen,
  }: Props = $props();

  let closeButton: HTMLButtonElement | undefined = $state();

  const name = $derived(displayName(object.key).name);
  const kind = $derived(previewKind(object));

  // Loading/error+Retry scaffolding [B9] that Task 2's per-kind renderers
  // (image <img> load, ranged text fetch, pdf.js doc open) will drive by
  // replacing this function's body. The metadata-only fallback Task 1
  // renders needs no network call, so this resolves immediately — the
  // state and Retry button are wired up now so Task 2 only has to add the
  // fetch, not the scaffolding around it. Error text is a status/provider
  // message only, never a presigned URL [B1].
  let previewLoading = $state(false);
  let previewError = $state<string | null>(null);

  async function loadPreview() {
    previewLoading = true;
    previewError = null;
    try {
      // No-op for now: the metadata fallback needs no fetch. Task 2 branches
      // on `kind` here to actually fetch/open the real preview.
    } catch (e) {
      previewError = e instanceof Error ? e.message : String(e);
    } finally {
      previewLoading = false;
    }
  }

  $effect(() => {
    void object.key; // re-run the (currently trivial) load when siblings change
    void loadPreview();
  });

  function handleArrowKeys(e: KeyboardEvent) {
    if (nestedModalOpen) return;
    if (e.key === "ArrowLeft" && canPrev) {
      e.preventDefault();
      onPrev();
    } else if (e.key === "ArrowRight" && canNext) {
      e.preventDefault();
      onNext();
    }
  }
</script>

<svelte:window onkeydown={handleArrowKeys} />

<ModalBase
  labelledBy="lightbox-title"
  fullscreen
  {onClose}
  closeOnEscape={!nestedModalOpen}
  active={!nestedModalOpen}
  getInitialFocus={() => closeButton}
>
  <div class="header">
    <h2 id="lightbox-title">{name}</h2>
    <div class="actions">
      <button class="nav" aria-label="Previous file" title="Previous" disabled={!canPrev} onclick={onPrev}
        >‹</button
      >
      <button class="nav" aria-label="Next file" title="Next" disabled={!canNext} onclick={onNext}>›</button>
      <button aria-label={`Download ${name}`} title="Download" onclick={() => onDownload(object)}>⬇</button>
      <button
        class="star"
        class:starred={object.favorite}
        aria-pressed={object.favorite}
        title={object.favorite ? "Unstar" : "Star"}
        onclick={() => session.toggleFavorite(object.key)}
      >{object.favorite ? "★" : "☆"}</button>
      <button
        aria-label={`Delete ${name}`}
        title={deleteBlocked ? "Can't delete while a transfer is in progress" : "Delete"}
        disabled={deleteBlocked}
        onclick={() => onDeleteRequest(object)}
      >🗑</button>
      <button bind:this={closeButton} aria-label="Close" title="Close" onclick={onClose}>✕</button>
    </div>
  </div>
  <div class="content">
    {#if previewLoading}
      <p class="status">Loading…</p>
    {:else if previewError}
      <div class="status error" role="alert">
        <p>{previewError}</p>
        <button onclick={loadPreview}>Retry</button>
      </div>
    {:else if kind === "image"}
      <!-- Task 2: <img> renderer -->
      {@render metadataFallback()}
    {:else if kind === "pdf"}
      <!-- Task 2: pdf.js renderer -->
      {@render metadataFallback()}
    {:else if kind === "text"}
      <!-- Task 2: ranged, capped <pre> text renderer -->
      {@render metadataFallback()}
    {:else}
      {@render metadataFallback()}
    {/if}
  </div>
</ModalBase>

{#snippet metadataFallback()}
  <div class="metadata">
    <dl>
      <dt>Name</dt>
      <dd>{name}</dd>
      <dt>Size</dt>
      <dd>{formatSize(object.size)}</dd>
      <dt>Modified</dt>
      <dd>{formatModified(object.last_modified)}</dd>
      <dt>Type</dt>
      <dd>{object.content_type}</dd>
    </dl>
    <button class="primary" onclick={() => onDownload(object)}>Download</button>
  </div>
{/snippet}

<style>
  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--sidebar);
    border-bottom: 1px solid var(--border);
    color: var(--text-bright);
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .actions button {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 17px;
    line-height: 1;
    padding: 6px;
    border-radius: var(--radius-small);
  }
  .actions button:hover:not(:disabled) {
    color: var(--text-bright);
    background: var(--surface-raised);
  }
  .actions button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .star.starred {
    color: var(--star);
  }
  .nav {
    font-size: 20px;
    font-weight: 700;
  }
  .content {
    overflow: auto;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .status {
    color: var(--text-dim);
    display: grid;
    gap: 10px;
    justify-items: center;
    text-align: center;
  }
  .status.error p {
    color: var(--danger);
  }
  .status button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 7px 14px;
    font-weight: 700;
  }
  .metadata {
    display: grid;
    gap: 16px;
    justify-items: center;
    text-align: center;
    color: var(--text-bright);
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto auto;
    gap: 4px 14px;
    text-align: left;
  }
  dt {
    color: var(--text-dim);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .primary {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 8px 18px;
    font-weight: 700;
  }
</style>
