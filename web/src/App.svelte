<script lang="ts">
  import { initCore } from "./lib/core";
  import { session } from "./lib/session.svelte";
  import ConnectScreen from "./screens/ConnectScreen.svelte";
  import BrowseScreen from "./screens/BrowseScreen.svelte";

  const ready = initCore();
</script>

{#await ready}
  <main class="boot">Loading core…</main>
{:then}
  {#if session.status === "connected"}
    <BrowseScreen />
  {:else}
    <ConnectScreen />
  {/if}
{:catch error}
  <main class="boot error">Failed to load the core module: {error}</main>
{/await}

<style>
  .boot {
    display: grid;
    place-items: center;
    min-height: 100vh;
    color: var(--text-dim);
  }
  .error {
    color: var(--danger);
  }
</style>
