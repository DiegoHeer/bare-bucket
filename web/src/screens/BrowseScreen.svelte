<script lang="ts">
  import { session } from "../lib/session.svelte";

  const objectCount = $derived(
    session.manifest?.objects.filter((o) => o.deleted_at === null).length ?? 0
  );
</script>

<main>
  <h1>Connected to {session.profileName}</h1>
  <p>{objectCount} objects in the manifest.</p>
  <p class="dim">Browse UI arrives in the next phase.</p>
  <button onclick={() => session.disconnect()}>Disconnect</button>
</main>

<style>
  main {
    display: grid;
    place-content: center;
    gap: 8px;
    min-height: 100vh;
    text-align: center;
  }
  h1 {
    color: var(--text-bright);
    font-size: 20px;
  }
  .dim {
    color: var(--text-dim);
  }
  button {
    justify-self: center;
    background: var(--accent-soft);
    color: var(--accent-text);
    border: none;
    border-radius: var(--radius-small);
    padding: 8px 16px;
  }
</style>
