<script lang="ts">
  import TopBar from "../components/TopBar.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import Breadcrumbs from "../components/Breadcrumbs.svelte";
  import FileList from "../components/FileList.svelte";
  import FileGrid from "../components/FileGrid.svelte";
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";
  import { childEntries, formatSize, totalSize } from "../lib/listing";

  const listing = $derived(childEntries(session.manifest?.objects ?? [], browse.prefix));
  const footer = $derived.by(() => {
    const bytes = totalSize(
      (session.manifest?.objects ?? []).filter((o) => o.key.startsWith(browse.prefix)),
    );
    const folders = listing.folders.length;
    const files = listing.files.length;
    return `${folders} folder${folders === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} · ${formatSize(bytes)}`;
  });
</script>

<div class="screen">
  <TopBar />
  <div class="body">
    <Sidebar />
    <main>
      <div class="toolbar">
        <button class="upload" disabled title="Uploads arrive in a later phase">＋ Upload</button>
        <Breadcrumbs />
        <span class="spacer"></span>
        <button class="ghost" onclick={() => browse.toggleView()} title="Toggle view">
          {browse.view === "list" ? "▦" : "☰"}
        </button>
      </div>
      <div class="content">
        {#if browse.view === "list"}
          <FileList {listing} />
        {:else}
          <FileGrid {listing} />
        {/if}
        {#if listing.folders.length === 0 && listing.files.length === 0}
          <p class="empty">This folder is empty.</p>
        {/if}
      </div>
      <div class="footer">{footer}</div>
    </main>
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 12px 16px;
    gap: 10px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .upload {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 7px 14px;
    font-weight: 700;
  }
  .upload:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .spacer {
    flex: 1;
  }
  .ghost {
    background: none;
    border: 1px solid var(--border-strong);
    color: var(--text-dim);
    border-radius: var(--radius-small);
    padding: 5px 10px;
  }
  .content {
    flex: 1;
    overflow-y: auto;
  }
  .empty {
    color: var(--text-dim);
    text-align: center;
    padding: 40px 0;
  }
  .footer {
    color: var(--text-dim);
    font-size: 12px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
</style>
