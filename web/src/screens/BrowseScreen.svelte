<script lang="ts">
  import TopBar from "../components/TopBar.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import Breadcrumbs from "../components/Breadcrumbs.svelte";
  import FileList from "../components/FileList.svelte";
  import FileGrid from "../components/FileGrid.svelte";
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";
  import {
    childEntries,
    favoriteFiles,
    formatSize,
    recentFiles,
    searchFiles,
    totalSize,
  } from "../lib/listing";

  const listing = $derived(childEntries(session.manifest?.objects ?? [], browse.prefix));
  const footer = $derived.by(() => {
    const bytes = totalSize(
      (session.manifest?.objects ?? []).filter((o) => o.key.startsWith(browse.prefix)),
    );
    const folders = listing.folders.length;
    const files = listing.files.length;
    return `${folders} folder${folders === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} · ${formatSize(bytes)} total`;
  });

  const sectionFiles = $derived.by(() => {
    const objects = session.manifest?.objects ?? [];
    switch (browse.section) {
      case "recent":
        return recentFiles(objects);
      case "favorites":
        return favoriteFiles(objects);
      case "search":
        return searchFiles(objects, browse.searchQuery);
      default:
        return [];
    }
  });

  const sectionTitle = $derived.by(() => {
    switch (browse.section) {
      case "recent":
        return "Recent";
      case "favorites":
        return "Favorites";
      case "search":
        return `Search results for "${browse.searchQuery}"`;
      default:
        return "";
    }
  });

  const sectionEmptyMessage = $derived.by(() => {
    switch (browse.section) {
      case "recent":
        return "Nothing here yet.";
      case "favorites":
        return "Star files to pin them here.";
      case "search":
        return "No matches.";
      default:
        return "";
    }
  });

  // A section switch or a stale (e.g. just-deleted) prefix can leave
  // `browse.prefix` pointing at a folder with no children; walk up to the
  // nearest ancestor that still exists so the "all" view never renders on a
  // dead prefix.
  $effect(() => {
    if (browse.section !== "all") return;
    const objects = session.manifest?.objects ?? [];
    let prefix = browse.prefix;
    while (prefix !== "") {
      const { folders, files } = childEntries(objects, prefix);
      if (folders.length > 0 || files.length > 0) break;
      const next = prefix.replace(/[^/]+\/$/, "");
      if (next === prefix) break;
      prefix = next;
    }
    if (prefix !== browse.prefix) browse.prefix = prefix;
  });
</script>

<div class="screen">
  <TopBar />
  <div class="body">
    <Sidebar />
    <main>
      <div class="toolbar">
        <button class="upload" disabled title="Uploads arrive in a later phase">＋ Upload</button>
        {#if browse.section === "all"}
          <Breadcrumbs />
        {:else}
          <span class="section-title">{sectionTitle}</span>
        {/if}
        <span class="spacer"></span>
        {#if browse.section === "all"}
          <button class="ghost" onclick={() => browse.toggleView()} title="Toggle view">
            {browse.view === "list" ? "▦" : "☰"}
          </button>
        {/if}
      </div>
      {#if session.refreshError}
        <div class="refresh-error" role="alert">
          {session.refreshError}
          <button aria-label="Dismiss" onclick={() => (session.refreshError = null)}>✕</button>
        </div>
      {/if}
      <div class="content">
        {#if browse.section === "all"}
          {#if browse.view === "list"}
            <FileList {listing} />
          {:else}
            <FileGrid {listing} />
          {/if}
          {#if listing.folders.length === 0 && listing.files.length === 0}
            <p class="empty">This folder is empty.</p>
          {/if}
        {:else}
          <p class="section-count">{sectionFiles.length} result{sectionFiles.length === 1 ? "" : "s"}</p>
          <FileList files={sectionFiles} showPath />
          {#if sectionFiles.length === 0}
            <p class="empty">{sectionEmptyMessage}</p>
          {/if}
        {/if}
      </div>
      {#if browse.section === "all"}
        <div class="footer">{footer}</div>
      {/if}
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
  .section-title {
    font-weight: 600;
    color: var(--text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .section-count {
    margin: 0;
    font-size: 12px;
    color: var(--text-dim);
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
  .refresh-error {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--accent-soft);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-small);
    color: var(--accent-text);
    font-size: 12px;
    padding: 6px 10px;
  }
  .refresh-error button {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
  }
</style>
