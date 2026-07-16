<script lang="ts">
  // Corner transfer panel (spec §7.4): floating bottom-right, aggregate
  // header collapsible to a pill, per-row progress/pause/cancel. Disappears
  // entirely once `transfers.clearFinished()` empties the list.
  import { transfers, type Transfer } from "../lib/transfers.svelte";

  let collapsed = $state(false);

  // Rows still meaningfully "in progress" — used both to decide whether the
  // header shows an aggregate or falls back to a plain "Transfers" label.
  const activeItems = $derived(
    transfers.items.filter(
      (t) =>
        t.status === "queued" ||
        t.status === "uploading" ||
        t.status === "downloading" ||
        t.status === "paused",
    ),
  );

  // The header's verb: "Uploading"/"Downloading" when every active row
  // shares one direction, "Transferring" once both are mixed in — so the
  // aggregate (which already counts/sums both directions) never mislabels a
  // download-only or mixed batch as an upload.
  const activeVerb = $derived.by(() => {
    const hasUpload = activeItems.some((t) => t.direction === "upload");
    const hasDownload = activeItems.some((t) => t.direction === "download");
    if (hasUpload && hasDownload) return "Transferring";
    return hasDownload ? "Downloading" : "Uploading";
  });

  // Cancelled/error rows never finish, so counting their size/transferred
  // bytes would permanently drag the aggregate below 100% even once every
  // other row is done.
  const aggregatePercent = $derived.by(() => {
    const counted = transfers.items.filter((t) => t.status !== "cancelled" && t.status !== "error");
    const totalSize = counted.reduce((sum, t) => sum + t.size, 0);
    if (totalSize === 0) return 100;
    const totalTransferred = counted.reduce((sum, t) => sum + t.transferred, 0);
    return Math.min(100, Math.round((totalTransferred / totalSize) * 100));
  });

  // Small extension-based icon (Transfer rows don't carry a content-type —
  // only the underlying File does, which isn't part of the reactive row).
  function iconFor(name: string): string {
    const dot = name.lastIndexOf(".");
    const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "🖼";
    if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "🎬";
    if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) return "🎵";
    if (ext === "pdf") return "📄";
    if (["txt", "md", "json", "csv", "log"].includes(ext)) return "📝";
    return "📦";
  }

  function percent(t: Transfer): number {
    if (t.size === 0) return 100;
    return Math.min(100, Math.round((t.transferred / t.size) * 100));
  }

  // Pause/resume only ever applies to a multipart upload still short of its
  // full byte count — once the part loop finishes and Complete starts, the
  // engine's `internal.completing` flag makes pause() a no-op, so hide the
  // control once every byte is uploaded (mirrors that phase without
  // exposing internal engine state to the UI). Gated on raw bytes rather
  // than the rounded display percent so a 99.6%-rounds-to-100% row doesn't
  // hide pause a beat before the part loop is actually done. Downloads never
  // show pause/resume [B5].
  function showPauseResume(t: Transfer): boolean {
    return (
      t.direction === "upload" &&
      t.kind === "multipart" &&
      (t.status === "uploading" || t.status === "paused") &&
      t.transferred < t.size
    );
  }

  // True during the Complete phase: every byte is uploaded but the row
  // hasn't settled to "done" yet (Complete's retry/backoff can take a few
  // seconds). Renders a "Finishing…" label instead of a progress bar —
  // there's no more per-byte progress to show, and pause is a no-op here.
  // Download rows never "complete" this way — a download's "done" follows
  // straight from its last chunk, so this only ever applies to uploads.
  function isCompleting(t: Transfer): boolean {
    return t.direction === "upload" && t.status === "uploading" && t.transferred >= t.size;
  }

  function showCancel(t: Transfer): boolean {
    return (
      t.status === "queued" ||
      t.status === "uploading" ||
      t.status === "downloading" ||
      t.status === "paused"
    );
  }
</script>

{#if transfers.items.length > 0}
  <div class="panel" class:collapsed>
    <div class="header">
      <span class="title">
        {#if activeItems.length === 0}
          Transfers
        {:else}
          {activeVerb} {transfers.items.length} item{transfers.items.length === 1 ? "" : "s"} · {aggregatePercent}%
        {/if}
      </span>
      <button
        class="icon-btn"
        onclick={() => (collapsed = !collapsed)}
        title={collapsed ? "Expand" : "Collapse"}
      >{collapsed ? "▴" : "▾"}</button>
      <button
        class="icon-btn"
        onclick={() => transfers.clearFinished()}
        disabled={transfers.active}
        title="Clear finished"
        aria-label="Clear finished"
      >✕</button>
    </div>
    {#if !collapsed}
      <ul class="rows">
        {#each transfers.items as t (t.id)}
          <li>
            <span
              class="dir"
              aria-hidden="true"
              title={t.direction === "upload" ? "Upload" : "Download"}
            >{t.direction === "upload" ? "↑" : "↓"}</span>
            <span class="icon">{iconFor(t.name)}</span>
            <span class="name" title={t.name}>{t.name}</span>
            <span class="status">
              {#if t.status === "queued"}
                <span class="label">Queued</span>
              {:else if isCompleting(t)}
                <span class="label">Finishing…</span>
              {:else if t.status === "uploading" || t.status === "downloading" || t.status === "paused"}
                <span class="bar"><span class="fill" style="width: {percent(t)}%"></span></span>
                <span class="pct"
                  >{percent(t)}%{t.status === "paused"
                    ? " · Paused"
                    : t.status === "downloading"
                      ? " · Downloading"
                      : ""}</span
                >
              {:else if t.status === "done"}
                <span class="label done">✓</span>
              {:else if t.status === "error"}
                <span class="label error" title={t.error ?? ""}
                  >{t.error ?? (t.direction === "download" ? "Download failed" : "Upload failed")}</span
                >
              {:else if t.status === "cancelled"}
                <span class="label">Cancelled</span>
              {/if}
            </span>
            <span class="row-actions">
              {#if showPauseResume(t)}
                <button
                  class="icon-btn"
                  onclick={() => (t.status === "paused" ? transfers.resume(t.id) : transfers.pause(t.id))}
                  title={t.status === "paused" ? "Resume" : "Pause"}
                >{t.status === "paused" ? "▶" : "⏸"}</button>
              {/if}
              {#if showCancel(t)}
                <button class="icon-btn" onclick={() => void transfers.cancel(t.id)} title="Cancel">✕</button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .panel {
    position: fixed;
    right: 16px;
    bottom: 16px;
    width: 320px;
    max-width: calc(100vw - 32px);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
    z-index: 50;
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    background: var(--surface-raised);
  }
  .title {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .icon-btn {
    background: none;
    border: none;
    color: var(--text-dim);
    padding: 3px 6px;
    border-radius: var(--radius-small);
    line-height: 1;
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--text-bright);
    background: var(--surface);
  }
  .icon-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    max-height: 260px;
    overflow-y: auto;
  }
  .rows li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
  }
  .dir {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-dim);
  }
  .icon {
    flex-shrink: 0;
  }
  .name {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-bright);
    font-size: 12px;
  }
  .status {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .bar {
    flex: 1;
    height: 5px;
    border-radius: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .pct {
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .label {
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label.done {
    color: var(--accent);
    font-weight: 700;
  }
  .label.error {
    color: var(--danger);
  }
  .row-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }
</style>
