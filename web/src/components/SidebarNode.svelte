<script lang="ts">
  import type { TreeNode } from "../lib/listing";
  import { browse } from "../lib/browse.svelte";
  import SidebarNode from "./SidebarNode.svelte";

  let { node, depth = 0 }: { node: TreeNode; depth?: number } = $props();
  let expanded = $state(false);

  const active = $derived(browse.prefix === node.prefix);
  // Auto-expand ancestors of the current prefix
  $effect(() => {
    if (browse.prefix.startsWith(node.prefix) && browse.prefix !== node.prefix) {
      expanded = true;
    }
  });
</script>

<li>
  <div class="row" class:active style={`padding-left: ${8 + depth * 12}px`}>
    {#if node.children.length > 0}
      <button class="twist" onclick={() => (expanded = !expanded)}>
        {expanded ? "▾" : "▸"}
      </button>
    {:else}
      <span class="twist-placeholder"></span>
    {/if}
    <button class="name" onclick={() => browse.navigate(node.prefix)}>{node.name}</button>
  </div>
  {#if expanded}
    <ul>
      {#each node.children as child (child.prefix)}
        <SidebarNode node={child} depth={depth + 1} />
      {/each}
    </ul>
  {/if}
</li>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: var(--radius-small);
  }
  .row.active {
    background: var(--accent-soft);
  }
  .row.active .name {
    color: var(--accent-text);
    font-weight: 600;
  }
  .twist,
  .twist-placeholder {
    width: 18px;
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--text-dim);
    padding: 0;
    display: inline-block;
  }
  .name {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 4px 6px 4px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
