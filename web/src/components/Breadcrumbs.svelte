<script lang="ts">
  import { breadcrumbSegments } from "../lib/listing";
  import { browse } from "../lib/browse.svelte";

  const segments = $derived(breadcrumbSegments(browse.prefix));
  // Collapse long paths to first ▸ … ▸ last two, so deep prefixes don't
  // push the toolbar's other controls off-screen.
  const visible = $derived.by(() => {
    if (segments.length <= 4) return segments;
    return [segments[0], null, ...segments.slice(-2)];
  });
</script>

<span class="crumbs">
  {#each visible as segment, i (segment ? segment.prefix : "…")}
    {#if i > 0}<span class="sep">▸</span>{/if}
    {#if segment === null}
      <span class="ellipsis">…</span>
    {:else}
      <button
        class:current={segment.prefix === segments[segments.length - 1].prefix}
        onclick={() => browse.navigate(segment.prefix)}>{segment.label}</button>
    {/if}
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
  .ellipsis {
    color: var(--text-dim);
    padding: 2px 4px;
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
