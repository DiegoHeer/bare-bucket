<script lang="ts">
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";
  import { buildTree, formatSize, totalSize } from "../lib/listing";
  import SidebarNode from "./SidebarNode.svelte";

  const objects = $derived(session.manifest?.objects ?? []);
  const tree = $derived(buildTree(objects));
</script>

<nav>
  <input
    class="search"
    type="search"
    placeholder="Search files…"
    value={browse.searchQuery}
    oninput={(e) => browse.setSearch(e.currentTarget.value)}
  />
  <ul class="views">
    <li>
      <button class:active={browse.section === "all"} onclick={() => browse.navigate("")}>
        📁 All files
      </button>
    </li>
    <li>
      <button
        class:active={browse.section === "recent"}
        onclick={() => browse.setSection("recent")}
      >
        🕓 Recent
      </button>
    </li>
    <li>
      <button
        class:active={browse.section === "favorites"}
        onclick={() => browse.setSection("favorites")}
      >
        ⭐ Favorites
      </button>
    </li>
  </ul>
  <div class="label">Folders</div>
  <ul class="tree">
    {#each tree as node (node.prefix)}
      <SidebarNode {node} />
    {/each}
  </ul>
  <div class="storage">◔ {formatSize(totalSize(objects))} used</div>
</nav>

<style>
  nav {
    width: 220px;
    flex-shrink: 0;
    background: var(--sidebar);
    border-right: 1px solid var(--border);
    padding: 12px 8px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .search {
    background: var(--input-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-small);
    color: var(--text-bright);
    padding: 6px 10px;
    font: inherit;
    width: 100%;
    box-sizing: border-box;
  }
  .search:focus {
    outline: 1px solid var(--accent);
  }
  .views button {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 6px 10px;
    border-radius: var(--radius-small);
  }
  .views button.active {
    background: var(--accent-soft);
    color: var(--accent-text);
    font-weight: 600;
  }
  .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-dim);
    padding: 0 10px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .tree {
    flex: 1;
  }
  .storage {
    font-size: 11px;
    color: var(--text-dim);
    border-top: 1px solid var(--border);
    padding: 10px 10px 0;
  }
</style>
