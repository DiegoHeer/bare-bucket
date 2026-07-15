<script lang="ts">
  import type { ManifestObject } from "../lib/core";
  import type { Listing } from "../lib/listing";
  import { displayName, formatModified, formatSize } from "../lib/listing";
  import { iconFor } from "../lib/icons";
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";

  // Two shapes: the default folder+file listing scoped to `browse.prefix`,
  // or a flat files-only mode (Recent/Favorites/Search) that shows each
  // file's parent path instead of relying on the current prefix.
  type Props = { listing: Listing; showPath?: false } | { files: ManifestObject[]; showPath: true };

  let props: Props = $props();

  const folders = $derived("listing" in props ? props.listing.folders : []);
  const files = $derived("listing" in props ? props.listing.files : props.files);
  const showPath = $derived("showPath" in props && props.showPath === true);

  function fileName(key: string): string {
    return showPath ? displayName(key).name : key.slice(browse.prefix.length);
  }
</script>

<table>
  <thead>
    <tr><th class="name">Name</th><th class="num">Size</th><th class="num">Modified</th><th class="star-col"></th></tr>
  </thead>
  <tbody>
    {#each folders as folder (folder.prefix)}
      <tr class="clickable" onclick={() => browse.navigate(folder.prefix)}>
        <td class="name">📁 {folder.name}</td>
        <td class="num">—</td>
        <td class="num"></td>
        <td class="star-col"></td>
      </tr>
    {/each}
    {#each files as file (file.key)}
      <tr>
        <td class="name">
          {iconFor(file.content_type)} {fileName(file.key)}
          {#if showPath && displayName(file.key).parent}
            <span class="path">{displayName(file.key).parent}</span>
          {/if}
        </td>
        <td class="num">{formatSize(file.size)}</td>
        <td class="num">{formatModified(file.last_modified)}</td>
        <td class="star-col">
          <button
            class="star"
            class:starred={file.favorite}
            title={file.favorite ? "Unstar" : "Star"}
            onclick={(e) => {
              e.stopPropagation();
              void session.toggleFavorite(file.key);
            }}
          >{file.favorite ? "★" : "☆"}</button>
        </td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-dim);
    font-weight: 600;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-bright);
  }
  th.num,
  td.num {
    text-align: right;
    color: var(--text-dim);
    width: 110px;
    white-space: nowrap;
  }
  td.name {
    overflow-wrap: anywhere;
  }
  .path {
    display: block;
    font-size: 11px;
    color: var(--text-dim);
  }
  th.star-col,
  td.star-col {
    width: 30px;
    padding: 8px 6px;
  }
  .star {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 2px;
  }
  .star.starred {
    color: #f5c518;
  }
  .star:hover {
    color: #f5c518;
  }
  tr.clickable {
    cursor: pointer;
  }
  tr.clickable:hover td {
    background: var(--surface);
  }
</style>
