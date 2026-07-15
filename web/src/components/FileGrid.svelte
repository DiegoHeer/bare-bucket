<script lang="ts">
  import type { ManifestObject } from "../lib/core";
  import type { Listing } from "../lib/listing";
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";
  import GridThumb from "./GridThumb.svelte";

  let {
    listing,
    onOpen,
    onDownload,
    onDelete,
    deleteBlockedKeys,
  }: {
    listing: Listing;
    /** Opens the lightbox for this file [B8]. */
    onOpen: (file: ManifestObject) => void;
    onDownload: (file: ManifestObject) => void;
    onDelete: (file: ManifestObject) => void;
    /** Keys with an in-flight transfer (queued/uploading/paused/downloading)
     * [B7] — the tile's delete button is disabled for these. */
    deleteBlockedKeys: Set<string>;
  } = $props();

  function fileName(key: string): string {
    return key.slice(browse.prefix.length);
  }
</script>

<div class="grid">
  {#each listing.folders as folder (folder.prefix)}
    <button class="tile" onclick={() => browse.navigate(folder.prefix)}>
      <span class="thumb">📁</span>
      <span class="caption">{folder.name}</span>
    </button>
  {/each}
  {#each listing.files as file (file.key)}
    <div class="tile">
      <button
        class="download"
        aria-label={`Download ${fileName(file.key)}`}
        title="Download"
        onclick={(e) => {
          e.stopPropagation();
          onDownload(file);
        }}
      >⬇</button>
      <button
        class="star"
        class:starred={file.favorite}
        title={file.favorite ? "Unstar" : "Star"}
        aria-pressed={file.favorite}
        onclick={(e) => {
          e.stopPropagation();
          void session.toggleFavorite(file.key);
        }}
      >{file.favorite ? "★" : "☆"}</button>
      <button
        class="delete"
        aria-label={`Delete ${fileName(file.key)}`}
        title={deleteBlockedKeys.has(file.key) ? "Can't delete while a transfer is in progress" : "Delete"}
        disabled={deleteBlockedKeys.has(file.key)}
        onclick={(e) => {
          e.stopPropagation();
          onDelete(file);
        }}
      >🗑</button>
      <!-- A real button (not the whole `.tile`, which would nest it inside
           the action buttons above — invalid HTML) so Enter/Space opens the
           lightbox [B8]; the action buttons are absolutely-positioned
           siblings layered on top and keep working independently. -->
      <button class="open" onclick={() => onOpen(file)}>
        <GridThumb {file} />
        <span class="caption">{fileName(file.key)}</span>
      </button>
    </div>
  {/each}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
  }
  .tile {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px;
    display: grid;
    gap: 8px;
    text-align: center;
    color: inherit;
    font: inherit;
  }
  /* The file tile's `.tile` is a plain `<div>` whose only in-flow child is
     `.open` (the action buttons are position:absolute, out of flow) — the
     grid/gap/text-align above places that one child; `.open` needs its own
     copy of the same rules to lay out ITS OWN thumb+caption children. The
     folder tile (a bare `<button class="tile">`) has no `.open` at all and
     relies solely on the rules above for its thumb+caption. */
  .open {
    display: grid;
    gap: 8px;
    width: 100%;
    text-align: center;
    color: inherit;
    font: inherit;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .tile:has(.open:hover),
  .tile:has(.open:focus-visible) {
    border-color: var(--border-strong);
    background: var(--surface-raised);
  }
  .star,
  .download,
  .delete {
    position: absolute;
    top: 4px;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 2px;
    z-index: 1;
  }
  .star {
    right: 4px;
  }
  .download {
    right: 24px;
  }
  .delete {
    right: 44px;
  }
  .star.starred {
    color: var(--star);
  }
  .star:hover {
    color: var(--star);
  }
  .download:hover {
    color: var(--accent);
  }
  .delete:hover:not(:disabled) {
    color: var(--danger);
  }
  .delete:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  button.tile {
    cursor: pointer;
  }
  button.tile:hover {
    border-color: var(--border-strong);
    background: var(--surface-raised);
  }
  .thumb {
    font-size: 34px;
    line-height: 64px;
    height: 64px;
    background: var(--input-bg);
    border-radius: var(--radius-small);
  }
  .caption {
    font-size: 12px;
    color: var(--text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
