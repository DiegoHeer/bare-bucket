<script lang="ts">
  import TopBar from "../components/TopBar.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import Breadcrumbs from "../components/Breadcrumbs.svelte";
  import FileList from "../components/FileList.svelte";
  import FileGrid from "../components/FileGrid.svelte";
  import TransferPanel from "../components/TransferPanel.svelte";
  import ConflictModal from "../components/ConflictModal.svelte";
  import DeleteConfirmModal from "../components/DeleteConfirmModal.svelte";
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";
  import { transfers, keysInStatus } from "../lib/transfers.svelte";
  import { anchorDownload, pickSaveTarget, supportsFsa } from "../lib/download";
  import { folderLabel, hasConflict, takenNamesInPrefix } from "../lib/conflicts";
  import {
    childEntries,
    displayName,
    favoriteFiles,
    formatSize,
    recentFiles,
    searchFiles,
    totalSize,
  } from "../lib/listing";
  import type { ManifestObject, PresignedRequest } from "../lib/core";

  // Mirrors transfers.svelte.ts's own `PRESIGN_EXPIRES_SECS` engine constant
  // (used for the FSA path's own lazy presign, inside `enqueueDownload`) —
  // kept as a separate constant here rather than importing it, so this task
  // doesn't have to touch the transfer engine module.
  const PRESIGN_EXPIRES_SECS = 3600;

  interface QueuedConflict {
    id: string;
    file: File;
    key: string;
    prefix: string;
  }

  interface PendingDelete {
    key: string;
    name: string;
  }

  let fileInput: HTMLInputElement | undefined = $state();
  let contentEl: HTMLDivElement | undefined = $state();
  let isDragging = $state(false);
  let conflictQueue = $state<QueuedConflict[]>([]);
  const currentConflict = $derived(conflictQueue[0] ?? null);
  let pendingDelete = $state<PendingDelete | null>(null);

  // Transfer keys still actually "in flight" — a cancelled or errored-out
  // transfer never lands, so its key doesn't occupy anything. Shared by
  // both the conflict check below and the taken-names set handed to the
  // modal (same set, same reasoning).
  const inFlightKeys = $derived(keysInStatus(transfers.items, ["queued", "uploading", "paused"]));

  // [B7] Delete's in-flight guard is a superset of the conflict pipeline's
  // set above (also blocks a key that's mid-download) — same underlying
  // helper, just a wider status list, so the two can't define "in flight"
  // differently by accident.
  const deleteBlockedKeys = $derived(
    new Set(keysInStatus(transfers.items, ["queued", "uploading", "paused", "downloading"])),
  );

  /** Routes a batch of dropped/picked files through the conflict pipeline
   * (spec §8.3): files whose target key already names a live manifest
   * object, or an in-flight transfer's target, are queued for the modal
   * (one at a time); everything else enqueues immediately. The target key
   * snapshots `browse.prefix` now — later navigation never retargets an
   * in-flight upload. */
  function handleFiles(files: globalThis.FileList | File[]) {
    const prefix = browse.prefix;
    const objects = session.manifest?.objects ?? [];
    for (const file of Array.from(files)) {
      const key = prefix + file.name;
      if (hasConflict(objects, key, inFlightKeys)) {
        conflictQueue.push({ id: crypto.randomUUID(), file, key, prefix });
      } else {
        transfers.enqueue(file, key);
      }
    }
  }

  /** Per-file download handler (spec §5.2's two-tier approach) wired to the
   * FileList/FileGrid row actions. On FSA-capable, secure-context browsers,
   * `pickSaveTarget` is called FIRST — before any `await` on presign/fetch —
   * so `showSaveFilePicker` still runs under the click's user activation
   * [B7]; a user cancel (`null`) is a silent no-op. Once a target is picked,
   * the actual streaming (including its own lazy presign) is the transfer
   * engine's job via `enqueueDownload`. Elsewhere (Firefox/Safari, or any
   * plain `http://` origin — the FSA/secure-context prerequisite fails
   * there), fall back to navigating a presigned, `attachment`-dispositioned
   * URL: the browser's own download manager takes it from there, so there's
   * no transfer row for this path. */
  async function downloadFile(object: ManifestObject) {
    const name = displayName(object.key).name;
    if (supportsFsa()) {
      const writable = await pickSaveTarget(name);
      if (!writable) return; // user cancelled the picker — not an error
      transfers.enqueueDownload(object.key, name, object.size, writable);
      return;
    }
    if (!session.client) return;
    const presigned = session.client.presign_get(
      object.key,
      PRESIGN_EXPIRES_SECS,
      name,
    ) as PresignedRequest;
    anchorDownload(presigned.url);
  }

  function onFileInputChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) handleFiles(input.files);
    input.value = ""; // allow re-picking the same file(s)
  }

  function onDragEnter(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    isDragging = true;
  }
  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
  }
  // Rather than a simple enter/leave counter (which can get stuck "open" if
  // the drag exits the browser window entirely and no matching dragleave
  // fires for every nested dragenter), check whether the pointer actually
  // left `contentEl`'s subtree — `relatedTarget` is null when leaving the
  // window, and unrelated otherwise, so both cases correctly clear the flag.
  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    if (contentEl && e.relatedTarget instanceof Node && contentEl.contains(e.relatedTarget)) return;
    isDragging = false;
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
  }

  function resolveOverwrite() {
    const conflict = conflictQueue[0];
    if (!conflict) return;
    transfers.enqueue(conflict.file, conflict.key);
    conflictQueue = conflictQueue.slice(1);
  }
  function resolveSaveAsCopy(newName: string) {
    const conflict = conflictQueue[0];
    if (!conflict) return;
    transfers.enqueue(conflict.file, conflict.prefix + newName);
    conflictQueue = conflictQueue.slice(1);
  }
  function resolveCancel() {
    conflictQueue = conflictQueue.slice(1);
  }

  /** Opens the delete confirm modal for `file` (spec §7.6, [B9]) — wired to
   * the FileList/FileGrid row action. */
  function requestDelete(file: ManifestObject) {
    pendingDelete = { key: file.key, name: displayName(file.key).name };
  }
  function cancelDelete() {
    pendingDelete = null;
  }
  /** Awaited BY the modal, not here: a rejection (object-delete failure,
   * reserved prefix, manifest-conflict exhaustion) propagates back through
   * this same promise, so the modal's own try/catch shows the error and
   * keeps itself open [B10] — `pendingDelete` is only cleared below, on the
   * success path, which is what actually closes the modal. Deleting the
   * last file in a folder relies on the existing stale-prefix ancestor
   * fallback effect further down (PR 9) once the manifest reflects the
   * tombstone. */
  async function confirmDelete() {
    if (!pendingDelete) return;
    await session.deleteObject(pendingDelete.key);
    pendingDelete = null;
  }

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
        <input
          type="file"
          multiple
          class="sr-only"
          bind:this={fileInput}
          onchange={onFileInputChange}
        />
        <button class="upload" onclick={() => fileInput?.click()}>＋ Upload</button>
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
      <!-- svelte-ignore a11y_no_static_element_interactions -- drag-drop is a
           mouse-only convenience layered over the same conflict pipeline as
           the Upload button, which remains the fully keyboard/AT-accessible
           path -->
      <div
        class="content"
        bind:this={contentEl}
        ondragenter={onDragEnter}
        ondragover={onDragOver}
        ondragleave={onDragLeave}
        ondrop={onDrop}
      >
        {#if browse.section === "all"}
          {#if browse.view === "list"}
            <FileList {listing} onDownload={downloadFile} onDelete={requestDelete} {deleteBlockedKeys} />
          {:else}
            <FileGrid {listing} onDownload={downloadFile} onDelete={requestDelete} {deleteBlockedKeys} />
          {/if}
          {#if listing.folders.length === 0 && listing.files.length === 0}
            <p class="empty">This folder is empty.</p>
          {/if}
        {:else}
          <p class="section-count">{sectionFiles.length} result{sectionFiles.length === 1 ? "" : "s"}</p>
          <FileList
            files={sectionFiles}
            showPath
            onDownload={downloadFile}
            onDelete={requestDelete}
            {deleteBlockedKeys}
          />
          {#if sectionFiles.length === 0}
            <p class="empty">{sectionEmptyMessage}</p>
          {/if}
        {/if}
        {#if isDragging}
          <div class="drop-overlay">Drop to upload to {folderLabel(browse.prefix)}</div>
        {/if}
      </div>
      {#if browse.section === "all"}
        <div class="footer">{footer}</div>
      {/if}
    </main>
  </div>
</div>

<TransferPanel />

{#if currentConflict}
  {#key currentConflict.id}
    <ConflictModal
      file={currentConflict.file}
      targetKey={currentConflict.key}
      takenNames={takenNamesInPrefix(
        session.manifest?.objects ?? [],
        inFlightKeys,
        currentConflict.prefix,
      )}
      onOverwrite={resolveOverwrite}
      onSaveAsCopy={resolveSaveAsCopy}
      onCancel={resolveCancel}
    />
  {/key}
{/if}

{#if pendingDelete}
  {#key pendingDelete.key}
    <DeleteConfirmModal name={pendingDelete.name} onConfirm={confirmDelete} onCancel={cancelDelete} />
  {/key}
{/if}

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
    position: relative;
    flex: 1;
    overflow-y: auto;
  }
  .drop-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--accent-soft);
    border: 2px dashed var(--accent);
    border-radius: var(--radius);
    color: var(--accent-text);
    font-weight: 600;
    pointer-events: none;
    z-index: 10;
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
