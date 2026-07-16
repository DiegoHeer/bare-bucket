<script lang="ts">
  import { onMount } from "svelte";
  import { initCore } from "./lib/core";
  import { session } from "./lib/session.svelte";
  import ConnectScreen from "./screens/ConnectScreen.svelte";
  import BrowseScreen from "./screens/BrowseScreen.svelte";

  const ready = initCore();

  // App-wide safety net (spec §8.3): BrowseScreen's own dragenter/dragover/
  // drop handlers preventDefault() within the content zone, but a drop
  // anywhere else in the window (the sidebar, the top bar, ConnectScreen
  // before a session even exists) would otherwise fall through to the
  // browser's default behavior — navigating the whole SPA away to render the
  // dropped file. Registered once for the app's lifetime; only intercepts
  // drags that actually carry files, so ordinary text/link drag-drop (if any
  // UI ever does that) is untouched.
  onMount(() => {
    function guardFileDrag(e: DragEvent): void {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    }
    window.addEventListener("dragover", guardFileDrag);
    window.addEventListener("drop", guardFileDrag);
    return () => {
      window.removeEventListener("dragover", guardFileDrag);
      window.removeEventListener("drop", guardFileDrag);
    };
  });
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
