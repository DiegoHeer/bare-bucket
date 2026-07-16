<script lang="ts">
  // Lazy grid thumbnail (spec §9, plan [B7][B8]): renders the file-type icon
  // until the tile is (near-)visible, then presigns a GET for its
  // `thumbnail_key` and swaps in an `<img>` once it loads — on any failure
  // (or when there's no `thumbnail_key` at all) the icon fallback just stays
  // put, silently [B8]. The gating decision (`shouldFetchThumb`) is a pure,
  // separately-tested helper (thumbGrid.ts); this component is pure DOM
  // glue around it (IntersectionObserver + presign), which this project's
  // no-DOM-harness test setup can't exercise directly.
  import { session } from "../lib/session.svelte";
  import { iconFor } from "../lib/icons";
  import { shouldFetchThumb, type ThumbLoadState } from "../lib/thumbGrid";
  import type { ManifestObject, PresignedRequest } from "../lib/core";

  let { file }: { file: ManifestObject } = $props();

  // Mirrors the other local copies of this constant across the app (see
  // BrowseScreen.svelte/Lightbox.svelte/transfers.svelte.ts's own comments);
  // no shared export exists for it.
  const PRESIGN_EXPIRES_SECS = 3600;

  let root: HTMLElement | undefined = $state();
  let isIntersecting = $state(false);
  let thumbState = $state<ThumbLoadState>("pending");
  // [B8] Per-tile, component-local only — never logged, never persisted;
  // a bearer token that lives exactly as long as this tile's <img>.
  let url = $state<string | null>(null);

  $effect(() => {
    const el = root;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) isIntersecting = entry.isIntersecting;
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  });

  // Re-evaluates on every isIntersecting/thumbnail_key/thumbState change (not
  // just on the observer's own callback) so a tile that's already on screen
  // when its thumbnail_key first appears (e.g. "Generate missing" just
  // populated it) picks it up without needing a scroll event.
  $effect(() => {
    if (file.thumbnail_key === null) {
      // Row lost its thumbnail (re-uploaded with different content, etc.) —
      // drop whatever we had and allow a fresh fetch if one reappears.
      thumbState = "pending";
      url = null;
      return;
    }
    if (!shouldFetchThumb({ thumbnailKey: file.thumbnail_key, isIntersecting, state: thumbState })) return;
    thumbState = "loading";
    if (!session.client) {
      thumbState = "error";
      return;
    }
    try {
      const presigned = session.client.presign_get(
        file.thumbnail_key,
        PRESIGN_EXPIRES_SECS,
        null,
      ) as PresignedRequest;
      url = presigned.url;
    } catch {
      thumbState = "error";
    }
  });
</script>

<span class="thumb" bind:this={root}>
  {#if url}
    <img
      class="thumb-img"
      src={url}
      alt=""
      loading="lazy"
      onload={() => (thumbState = "loaded")}
      onerror={() => {
        thumbState = "error";
        url = null;
      }}
    />
  {:else}
    {iconFor(file.content_type)}
  {/if}
</span>

<style>
  /* Duplicated from FileGrid.svelte's own `.thumb` rule (Svelte scopes each
     component's CSS separately) — kept in sync by hand; FileGrid still owns
     the same rule for its icon-only folder tiles. */
  .thumb {
    display: block;
    font-size: 34px;
    line-height: 64px;
    height: 64px;
    background: var(--input-bg);
    border-radius: var(--radius-small);
    overflow: hidden;
  }
  .thumb-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
