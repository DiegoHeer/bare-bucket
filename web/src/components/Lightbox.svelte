<script lang="ts">
  // Fullscreen preview overlay (spec §7.5, plan [B1][B3][B4][B5][B6][B7][B9])
  // on ModalBase's fullscreen variant: routes on `previewKind` to an <img>
  // (image), a ranged/capped <pre> (text, via textPreview.ts), a pdf.js
  // canvas (via pdfPreview.ts), or the metadata+download fallback for
  // anything else/unmatched. All overlay actions reuse BrowseScreen's
  // existing handlers/session methods verbatim [B4] — no parallel
  // download/favorite/delete flows here.
  import ModalBase from "./ModalBase.svelte";
  import { session } from "../lib/session.svelte";
  import { displayName, formatModified, formatSize } from "../lib/listing";
  import { previewKind } from "../lib/preview";
  import { fetchTextPreview } from "../lib/textPreview";
  import { clampPage, loadPdf, type PdfHandle } from "../lib/pdfPreview";
  import type { ManifestObject, PresignedRequest } from "../lib/core";

  interface Props {
    object: ManifestObject;
    canPrev: boolean;
    canNext: boolean;
    onPrev: () => void;
    onNext: () => void;
    onClose: () => void;
    onDownload: (object: ManifestObject) => void;
    /** Opens the (shared) DeleteConfirmModal via BrowseScreen's existing
     * requestDelete flow — same modal the FileList/FileGrid row action
     * uses, not a lightbox-local copy [B4]. */
    onDeleteRequest: (object: ManifestObject) => void;
    /** Mirrors FileList/FileGrid's own guard: disabled while this key has an
     * in-flight transfer. */
    deleteBlocked: boolean;
    /** True while the delete confirm modal is stacked on top of this
     * overlay — suppresses Escape/focus-trap/←/→ handling here so only the
     * topmost dialog reacts to keys [B3]. */
    nestedModalOpen: boolean;
  }

  let {
    object,
    canPrev,
    canNext,
    onPrev,
    onNext,
    onClose,
    onDownload,
    onDeleteRequest,
    deleteBlocked,
    nestedModalOpen,
  }: Props = $props();

  let closeButton: HTMLButtonElement | undefined = $state();

  const name = $derived(displayName(object.key).name);
  const kind = $derived(previewKind(object));

  // Local, mirrors BrowseScreen.svelte's/transfers.svelte.ts's own copies of
  // this constant (each site defines it independently — see their
  // comments); no shared export exists for it.
  const PRESIGN_EXPIRES_SECS = 3600;

  // Loading/error+Retry scaffolding [B9]. Error text is always a
  // status/provider message only, never the presigned URL [B1] — the catch
  // block below strips it out defensively even though today's failure modes
  // (fetch status text, pdf.js parse errors) shouldn't normally echo it.
  let previewLoading = $state(false);
  let previewError = $state<string | null>(null);

  // Per-kind preview state [B1]: held only in this component's local state
  // and cleared on navigate/unmount by `clearPreviewState` below — never
  // logged, never persisted.
  let imageUrl = $state<string | null>(null);
  let textContent = $state<string | null>(null);
  let textTruncated = $state(false);
  let pdfCanvas: HTMLCanvasElement | undefined = $state();
  let pdfPage = $state(1);
  let pdfPageCount = $state(0);
  // Not $state: never read directly by the template (only via pdfPageCount
  // and the render effect below), so it doesn't need to be reactive itself.
  let pdfHandle: PdfHandle | null = null;
  let textAbort: AbortController | null = null;

  // Bumped both by `loadPreview()` and by `clearPreviewState()` itself so a
  // slow in-flight load (e.g. a pdf.js doc still opening) that resolves
  // AFTER the user has already navigated to a different sibling — or after
  // the lightbox has been closed/unmounted entirely, where only the
  // `$effect` cleanup's bare `clearPreviewState()` call runs, with no
  // matching `loadPreview()` to bump the token itself — recognizes it's
  // stale and backs out instead of clobbering a destroyed/superseded
  // component's state (and leaking its own handle/fetch).
  let previewToken = 0;

  function clearPreviewState() {
    previewToken += 1;
    imageUrl = null;
    textContent = null;
    textTruncated = false;
    pdfPage = 1;
    pdfPageCount = 0;
    if (pdfHandle) {
      const handle = pdfHandle;
      pdfHandle = null;
      void handle.destroy();
    }
    if (textAbort) {
      textAbort.abort();
      textAbort = null;
    }
  }

  // Resolves with the probe Image itself (not just void) so a caller whose
  // token has gone stale by the time this resolves (superseded by a
  // sibling-nav/close before the decode finished) can clear `probe.src` —
  // polish item 6: abandoning the load rather than leaving a finished-but-
  // unused `<img>` holding onto its decoded bytes/presigned URL past the
  // point anything still needs them.
  function preloadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve(probe);
      probe.onerror = () => reject(new Error("Image failed to load"));
      probe.src = url;
    });
  }

  async function loadPreview() {
    // `clearPreviewState()` bumps `previewToken` itself now (see its
    // declaration above), so capturing `token` must happen AFTER calling it
    // — otherwise this load's own cleanup call would bump past the token it
    // just captured, self-invalidating before the first `await` ever runs.
    clearPreviewState();
    const token = ++previewToken;
    previewLoading = true;
    previewError = null;
    let presignedUrl: string | null = null;
    try {
      if (kind !== "none") {
        if (!session.client) throw new Error("not connected"); // matches transfers.svelte.ts's own presign-guard message
        // No attachment name: an inline preview must not force a
        // Content-Disposition: attachment response.
        const presigned = session.client.presign_get(object.key, PRESIGN_EXPIRES_SECS, null) as PresignedRequest;
        presignedUrl = presigned.url;

        if (kind === "image") {
          const probe = await preloadImage(presigned.url);
          if (token !== previewToken) {
            probe.src = ""; // stale: abandon the now-unused decoded image
            return;
          }
          imageUrl = presigned.url;
        } else if (kind === "text") {
          const controller = new AbortController();
          textAbort = controller;
          const result = await fetchTextPreview(presigned.url, object.size, controller.signal);
          if (token !== previewToken) return;
          textContent = result.text;
          textTruncated = result.truncated;
        } else if (kind === "pdf") {
          const handle = await loadPdf(presigned.url);
          if (token !== previewToken) {
            void handle.destroy(); // superseded by a newer load; don't leak it
            return;
          }
          pdfHandle = handle;
          pdfPageCount = handle.numPages;
          pdfPage = 1;
        }
      }
    } catch (e) {
      if (token !== previewToken) return; // stale error from a superseded load
      const raw = e instanceof Error ? e.message : String(e);
      previewError = presignedUrl ? raw.split(presignedUrl).join("[link removed]") : raw;
    } finally {
      if (token === previewToken) previewLoading = false;
    }
  }

  $effect(() => {
    void object.key; // re-run the load when siblings change
    void loadPreview();
    return () => clearPreviewState(); // covers close/unmount; loadPreview also self-clears for direct Retry calls
  });

  // Renders the current pdf page once both the doc is open and the canvas
  // element exists in the DOM (the canvas only mounts once previewLoading
  // goes false, i.e. after the doc has already opened — see loadPreview
  // above — so this effect's first run always has both ready) and again on
  // every page change.
  $effect(() => {
    const canvas = pdfCanvas;
    const page = pdfPage;
    const handle = pdfHandle;
    if (kind === "pdf" && handle && canvas) {
      // Polish item 7: a page-navigation render failure (not the initial
      // doc-open, which `loadPreview`'s own try/catch already covers) used
      // to reject silently — `void`-ed with nowhere for the rejection to go.
      // `token` pins this call to the load that was current when it started,
      // so a failure arriving after the user has already navigated/closed
      // (superseded by a newer `loadPreview` or unmount) doesn't clobber a
      // newer preview's state.
      const token = previewToken;
      handle.renderPage(page, canvas, window.devicePixelRatio || 1).catch((e) => {
        if (token !== previewToken) return;
        previewError = e instanceof Error ? e.message : String(e);
      });
    }
  });

  function pdfPrevPage() {
    pdfPage = clampPage(pdfPage - 1, pdfPageCount);
  }
  function pdfNextPage() {
    pdfPage = clampPage(pdfPage + 1, pdfPageCount);
  }

  function handleArrowKeys(e: KeyboardEvent) {
    if (nestedModalOpen) return;
    if (e.key === "ArrowLeft" && canPrev) {
      e.preventDefault();
      onPrev();
    } else if (e.key === "ArrowRight" && canNext) {
      e.preventDefault();
      onNext();
    }
  }
</script>

<svelte:window onkeydown={handleArrowKeys} />

<ModalBase
  labelledBy="lightbox-title"
  fullscreen
  {onClose}
  closeOnEscape={!nestedModalOpen}
  active={!nestedModalOpen}
  getInitialFocus={() => closeButton}
>
  <div class="header">
    <h2 id="lightbox-title">{name}</h2>
    <div class="actions">
      <button class="nav" aria-label="Previous file" title="Previous" disabled={!canPrev} onclick={onPrev}
        >‹</button
      >
      <button class="nav" aria-label="Next file" title="Next" disabled={!canNext} onclick={onNext}>›</button>
      <button aria-label={`Download ${name}`} title="Download" onclick={() => onDownload(object)}>⬇</button>
      <button
        class="star"
        class:starred={object.favorite}
        aria-pressed={object.favorite}
        title={object.favorite ? "Unstar" : "Star"}
        onclick={() => session.toggleFavorite(object.key)}
      >{object.favorite ? "★" : "☆"}</button>
      <button
        aria-label={`Delete ${name}`}
        title={deleteBlocked ? "Can't delete while a transfer is in progress" : "Delete"}
        disabled={deleteBlocked}
        onclick={() => onDeleteRequest(object)}
      >🗑</button>
      <button bind:this={closeButton} aria-label="Close" title="Close" onclick={onClose}>✕</button>
    </div>
  </div>
  <div class="content">
    {#if previewLoading}
      <p class="status">Loading…</p>
    {:else if previewError}
      <div class="status error" role="alert">
        <p>{previewError}</p>
        <button onclick={loadPreview}>Retry</button>
      </div>
    {:else if kind === "image" && imageUrl}
      <!-- [B1]/[B6]: presigned GET URL straight into <img> — SVGs render this
           way too (never inline-injected, so embedded scripts can't run). -->
      <img class="image-preview" src={imageUrl} alt={name} />
    {:else if kind === "pdf"}
      <div class="pdf-viewer">
        <canvas bind:this={pdfCanvas} aria-label={`${name}, page ${pdfPage} of ${pdfPageCount}`}></canvas>
        <div class="pdf-nav">
          <button disabled={pdfPage <= 1} aria-label="Previous page" onclick={pdfPrevPage}>‹</button>
          <span>{pdfPage} / {pdfPageCount}</span>
          <button disabled={pdfPage >= pdfPageCount} aria-label="Next page" onclick={pdfNextPage}>›</button>
        </div>
      </div>
    {:else if kind === "text" && textContent !== null}
      <div class="text-preview">
        <pre>{textContent}</pre>
        {#if textTruncated}
          <p class="truncated-notice">Preview truncated — download for the full file.</p>
        {/if}
      </div>
    {:else}
      {@render metadataFallback()}
    {/if}
  </div>
</ModalBase>

{#snippet metadataFallback()}
  <div class="metadata">
    <dl>
      <dt>Name</dt>
      <dd>{name}</dd>
      <dt>Size</dt>
      <dd>{formatSize(object.size)}</dd>
      <dt>Modified</dt>
      <dd>{formatModified(object.last_modified)}</dd>
      <dt>Type</dt>
      <dd>{object.content_type}</dd>
    </dl>
    <button class="primary" onclick={() => onDownload(object)}>Download</button>
  </div>
{/snippet}

<style>
  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--sidebar);
    border-bottom: 1px solid var(--border);
    color: var(--text-bright);
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .actions button {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 17px;
    line-height: 1;
    padding: 6px;
    border-radius: var(--radius-small);
  }
  .actions button:hover:not(:disabled) {
    color: var(--text-bright);
    background: var(--surface-raised);
  }
  .actions button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .star.starred {
    color: var(--star);
  }
  .nav {
    font-size: 20px;
    font-weight: 700;
  }
  .content {
    overflow: auto;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .status {
    color: var(--text-dim);
    display: grid;
    gap: 10px;
    justify-items: center;
    text-align: center;
  }
  .status.error p {
    color: var(--danger);
  }
  .status button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 7px 14px;
    font-weight: 700;
  }
  .metadata {
    display: grid;
    gap: 16px;
    justify-items: center;
    text-align: center;
    color: var(--text-bright);
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto auto;
    gap: 4px 14px;
    text-align: left;
  }
  dt {
    color: var(--text-dim);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .primary {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 8px 18px;
    font-weight: 700;
  }
  .image-preview {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .text-preview {
    width: 100%;
    height: 100%;
    align-self: stretch;
    justify-self: stretch;
    overflow: auto;
    display: grid;
    align-content: start;
    gap: 10px;
  }
  .text-preview pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    text-align: left;
    color: var(--text-bright);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
  }
  .truncated-notice {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
    text-align: center;
  }
  .pdf-viewer {
    display: grid;
    gap: 12px;
    justify-items: center;
    align-self: stretch;
    justify-self: stretch;
    overflow: auto;
  }
  .pdf-viewer canvas {
    max-width: 100%;
    box-shadow: 0 0 0 1px var(--border);
  }
  .pdf-nav {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-dim);
    font-size: 13px;
  }
  .pdf-nav button {
    background: var(--surface-raised);
    border: none;
    color: var(--text-bright);
    border-radius: var(--radius-small);
    padding: 4px 10px;
    font-size: 16px;
    font-weight: 700;
  }
  .pdf-nav button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
</style>
