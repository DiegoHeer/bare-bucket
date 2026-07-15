<script lang="ts">
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";
  import { buildTree } from "../lib/listing";
  import SidebarNode from "./SidebarNode.svelte";

  const tree = $derived(buildTree(session.manifest?.objects ?? []));
</script>

<nav>
  <ul class="views">
    <li>
      <button class:active={browse.prefix === ""} onclick={() => browse.navigate("")}>
        📁 All files
      </button>
    </li>
  </ul>
  <div class="label">Folders</div>
  <ul class="tree">
    {#each tree as node (node.prefix)}
      <SidebarNode {node} />
    {/each}
  </ul>
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
</style>
