<script lang="ts">
  import { session } from "../lib/session.svelte";
  import { browse } from "../lib/browse.svelte";
  import { transfers } from "../lib/transfers.svelte";

  // browse.reset() must happen before disconnect() clears the profile name —
  // session.disconnect() doesn't touch browse state itself to avoid a
  // circular import between session.svelte.ts and browse.svelte.ts.
  //
  // If any upload is still queued/uploading/paused, confirm first — the
  // about-to-be-torn-down client is what those transfers are presigning
  // and completing against, so switching out from under them would just
  // strand them. On confirmation, cancel them all before tearing down.
  async function switchProfile() {
    if (transfers.active) {
      const proceed = confirm(
        "Transfers are in progress — switching profiles cancels them. Continue?",
      );
      if (!proceed) return;
      await transfers.cancelAll();
    }
    browse.reset();
    session.disconnect();
  }
</script>

<header>
  <span class="wordmark">▙ bare<span class="accent">bucket</span></span>
  <button class="chip" title="Switch profile" onclick={() => void switchProfile()}>
    {session.profileName} ▾
  </button>
  <span class="spacer"></span>
  {#if session.lastReport && session.lastReport.conditional === false}
    <span class="warn" title="This provider rejected conditional writes; concurrent changes can be lost.">⚠ unconditional writes</span>
  {/if}
  {#if session.refreshError}
    <span class="warn" title={session.refreshError}>⚠ refresh failed</span>
  {/if}
  <button class="ghost" onclick={() => session.refresh()} disabled={session.refreshing}>
    {session.refreshing ? "⟳ Refreshing…" : "⟳ Refresh"}
  </button>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    background: var(--bg-deep);
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
  }
  .wordmark {
    font-weight: 700;
    color: var(--text-bright);
  }
  .accent {
    color: var(--accent);
  }
  .chip {
    background: var(--surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    padding: 3px 12px;
    color: var(--accent-text);
  }
  .spacer {
    flex: 1;
  }
  .warn {
    color: #eab308;
    font-size: 12px;
  }
  .ghost {
    background: none;
    border: none;
    color: var(--text-dim);
    padding: 4px 8px;
    border-radius: var(--radius-small);
  }
  .ghost:hover {
    color: var(--text-bright);
    background: var(--surface-raised);
  }
  .ghost:disabled {
    opacity: 0.6;
  }
</style>
