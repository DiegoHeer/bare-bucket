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
  type Props = ({ listing: Listing; showPath?: false } | { files: ManifestObject[]; showPath: true }) & {
    onDownload: (file: ManifestObject) => void;
    onDelete: (file: ManifestObject) => void;
    /** Keys with an in-flight transfer (queued/uploading/paused/downloading)
     * [B7] — the row's delete button is disabled for these. */
    deleteBlockedKeys: Set<string>;
  };

  let props: Props = $props();

  const folders = $derived("listing" in props ? props.listing.folders : []);
  const files = $derived("listing" in props ? props.listing.files : props.files);
  const showPath = $derived("showPath" in props && props.showPath === true);

  function fileName(key: string): string {
    return showPath ? displayName(key).name : key.slice(browse.prefix.length);
  }

  function parentPath(key: string): string {
    return displayName(key).parent;
  }
</script>

<table>
  <thead>
    <tr><th class="name">Name</th><th class="num">Size</th><th class="num">Modified</th><th class="actions-col"><span class="sr-only">Actions</span></th></tr>
  </thead>
  <tbody>
    {#each folders as folder (folder.prefix)}
      <tr class="folder-row">
        <td class="name">
          <button class="row-button" onclick={() => browse.navigate(folder.prefix)}>📁 {folder.name}</button>
        </td>
        <td class="num">—</td>
        <td class="num"></td>
        <td class="actions-col"></td>
      </tr>
    {/each}
    {#each files as file (file.key)}
      <tr>
        <td class="name">
          {iconFor(file.content_type)} {fileName(file.key)}
          {#if showPath && parentPath(file.key)}
            <button
              class="path"
              onclick={(e) => {
                e.stopPropagation();
                browse.navigate(parentPath(file.key) + "/");
              }}
            >{parentPath(file.key)}</button>
          {/if}
        </td>
        <td class="num">{formatSize(file.size)}</td>
        <td class="num">{formatModified(file.last_modified)}</td>
        <td class="actions-col">
          <button
            class="download"
            aria-label={`Download ${fileName(file.key)}`}
            title="Download"
            onclick={(e) => {
              e.stopPropagation();
              props.onDownload(file);
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
            title={props.deleteBlockedKeys.has(file.key) ? "Can't delete while a transfer is in progress" : "Delete"}
            disabled={props.deleteBlockedKeys.has(file.key)}
            onclick={(e) => {
              e.stopPropagation();
              props.onDelete(file);
            }}
          >🗑</button>
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
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .path:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  th.actions-col,
  td.actions-col {
    width: 78px;
    padding: 8px 6px;
    white-space: nowrap;
  }
  .row-button {
    display: block;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .star,
  .download,
  .delete {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 2px;
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
  tr.folder-row:hover td {
    background: var(--surface);
  }
</style>
