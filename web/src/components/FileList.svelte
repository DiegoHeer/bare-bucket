<script lang="ts">
  import type { Listing } from "../lib/listing";
  import { formatModified, formatSize } from "../lib/listing";
  import { iconFor } from "../lib/icons";
  import { browse } from "../lib/browse.svelte";

  let { listing }: { listing: Listing } = $props();

  function fileName(key: string): string {
    return key.slice(browse.prefix.length);
  }
</script>

<table>
  <thead>
    <tr><th class="name">Name</th><th class="num">Size</th><th class="num">Modified</th></tr>
  </thead>
  <tbody>
    {#each listing.folders as folder (folder.prefix)}
      <tr class="clickable" onclick={() => browse.navigate(folder.prefix)}>
        <td class="name">📁 {folder.name}</td>
        <td class="num">—</td>
        <td class="num"></td>
      </tr>
    {/each}
    {#each listing.files as file (file.key)}
      <tr>
        <td class="name">{iconFor(file.content_type)} {fileName(file.key)}</td>
        <td class="num">{formatSize(file.size)}</td>
        <td class="num">{formatModified(file.last_modified)}</td>
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
  tr.clickable {
    cursor: pointer;
  }
  tr.clickable:hover td {
    background: var(--surface);
  }
</style>
