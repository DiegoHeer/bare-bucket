<script lang="ts">
  import type { Listing } from "../lib/listing";
  import { iconFor } from "../lib/icons";
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";

  let { listing }: { listing: Listing } = $props();

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
        class="star"
        class:starred={file.favorite}
        title={file.favorite ? "Unstar" : "Star"}
        onclick={(e) => {
          e.stopPropagation();
          void session.toggleFavorite(file.key);
        }}
      >{file.favorite ? "★" : "☆"}</button>
      <span class="thumb">{iconFor(file.content_type)}</span>
      <span class="caption">{fileName(file.key)}</span>
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
  .star {
    position: absolute;
    top: 4px;
    right: 4px;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 2px;
    z-index: 1;
  }
  .star.starred {
    color: #f5c518;
  }
  .star:hover {
    color: #f5c518;
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
