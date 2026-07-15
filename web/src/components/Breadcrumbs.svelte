<script lang="ts">
  import { breadcrumbSegments } from "../lib/listing";
  import { browse } from "../lib/browse.svelte";

  const segments = $derived(breadcrumbSegments(browse.prefix));
</script>

<span class="crumbs">
  {#each segments as segment, i (segment.prefix)}
    {#if i > 0}<span class="sep">▸</span>{/if}
    <button
      class:current={i === segments.length - 1}
      onclick={() => browse.navigate(segment.prefix)}>{segment.label}</button>
  {/each}
</span>

<style>
  .crumbs {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
  }
  .sep {
    color: var(--text-dim);
  }
  button {
    background: none;
    border: none;
    color: var(--accent-text);
    padding: 2px 4px;
    border-radius: 4px;
    white-space: nowrap;
  }
  button.current {
    color: var(--text-bright);
    font-weight: 600;
  }
  button:hover {
    background: var(--surface-raised);
  }
</style>
