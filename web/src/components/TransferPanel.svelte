<script lang="ts">
  // Corner transfer panel (spec §7.4): floating bottom-right, aggregate
  // header collapsible to a pill, per-row progress/pause/cancel. Disappears
  // entirely once `transfers.clearFinished()` empties the list.
  import { transfers, type Transfer } from "../lib/transfers.svelte";

  let collapsed = $state(false);

  const aggregatePercent = $derived.by(() => {
    const totalSize = transfers.items.reduce((sum, t) => sum + t.size, 0);
    if (totalSize === 0) return 100;
    const totalUploaded = transfers.items.reduce((sum, t) => sum + t.uploaded, 0);
    return Math.min(100, Math.round((totalUploaded / totalSize) * 100));
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
    return Math.min(100, Math.round((t.uploaded / t.size) * 100));
  }

  // Pause/resume only ever applies to a multipart transfer still short of
  // 100% — once the part loop finishes and Complete starts, the engine's
  // `internal.completing` flag makes pause() a no-op, so hide the control
  // once progress reaches full (mirrors that phase without exposing
  // internal engine state to the UI).
  function showPauseResume(t: Transfer): boolean {
    return t.kind === "multipart" && (t.status === "uploading" || t.status === "paused") && percent(t) < 100;
  }

  function showCancel(t: Transfer): boolean {
    return t.status === "queued" || t.status === "uploading" || t.status === "paused";
  }
</script>

{#if transfers.items.length > 0}
  <div class="panel" class:collapsed>
    <div class="header">
      <span class="title">
        Uploading {transfers.items.length} item{transfers.items.length === 1 ? "" : "s"} · {aggregatePercent}%
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
            <span class="icon">{iconFor(t.name)}</span>
            <span class="name" title={t.name}>{t.name}</span>
            <span class="status">
              {#if t.status === "queued"}
                <span class="label">Queued</span>
              {:else if t.status === "uploading" || t.status === "paused"}
                <span class="bar"><span class="fill" style="width: {percent(t)}%"></span></span>
                <span class="pct">{percent(t)}%{t.status === "paused" ? " · Paused" : ""}</span>
              {:else if t.status === "done"}
                <span class="label done">✓</span>
              {:else if t.status === "error"}
                <span class="label error" title={t.error ?? ""}>{t.error ?? "Upload failed"}</span>
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
