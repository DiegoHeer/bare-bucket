# PR 14 — Thumbnails: generate on upload, "generate missing", lazy grid

Spec: `docs/superpowers/specs/2026-07-15-bare-bucket-v1-design.md` §9 (client-side generation in the UI layer — canvas downscale for images, pdf.js page-1 for PDFs; WebP ~256px long edge, quality ~0.75; stored `.bare-bucket/thumbs/<original-key>.webp`; on-upload non-fatal + "Generate missing thumbnails" action with progress+cancel; grid lazy-loads visible tiles, icon fallback), §4.1 (`thumbnail_key`), §7.6/PR 12 (delete cleans thumbs), PR 6 (reconcile sweeps orphans).

## Global constraints (binding)

- [B1] Thumbnails are generated client-side in web/ (canvas/createImageBitmap; pdf.js page-1 via the existing lazy `pdfPreview` seam). The core only gains a `set_thumbnail` manifest mutation — no image code in Rust.
- [B2] Manifest writes serialize under `manifest_write_lock`; `set_thumbnail(key, thumbnail_key)` uses the found-flag mutator via `update_with_retry_if_changed` (PR 12 pattern): row absent or tombstoned → no write, report false; setting an identical value → no write. Tombstoned rows are treated as absent (PR 10 rule).
- [B3] Thumb objects PUT via the existing presigned single-PUT path (`presign_put` + XHR/fetch), Content-Type `image/webp`, key from the SAME `thumbnail_key_for` shape as core (`.bare-bucket/thumbs/<original-key>.webp`) — web must not invent its own key layout: derive it via a tiny exported helper mirrored from core with a cross-reference comment, or (preferred, no drift possible) add wasm getter `thumbnail_key_for(key)` — a pure function re-export, allowed despite [B1] since it's key math, not image code.
- [B4] Generation parameters: 256 px long edge (never upscale), WebP quality 0.75, `canvas.toBlob("image/webp", 0.75)`. SVG rasterizes via `<img>` decode (same no-inline-injection rule as previews).
- [B5] On-upload generation is NON-FATAL and non-blocking for the upload result: the transfer completes/upserts exactly as today; thumb generation runs after upsert success, failures are console-warn only, row keeps `thumbnail_key: null`.
- [B6] "Generate missing thumbnails" action (toolbar/sidebar): scans live manifest for `previewKind ∈ {image, pdf}` rows with `thumbnail_key === null`, processes SEQUENTIALLY (one at a time — don't saturate the main thread), with visible progress (n / N) and a Cancel that stops between items. Per-item failures skip and continue; summary at the end (generated X, failed Y).
- [B7] Grid lazy loading: FileGrid tiles with `thumbnail_key` set load the thumb via presigned GET ONLY when the tile is (near-)visible — IntersectionObserver with a sensible rootMargin; no thumbnail or load failure → existing file-type icon. List view stays icon-only (spec: grid).
- [B8] Presigned thumb URLs are bearer tokens: per-tile component state, never logged; failed loads fall back to icon silently.
- [B9] Delete flow already clears thumbs (PR 12) — do not duplicate; verify interplay only. Reconcile orphan sweep untouched.
- [B10] The generate-missing scan and on-upload generation must skip keys under `.bare-bucket/` and respect in-flight transfers (don't thumb a key that's mid-upload).
- [B11] All new wasm surface uses `to_js`; no new deps (pdf.js + canvas already available).

## Task 1 — Core/wasm: `set_thumbnail` + key getter

- `core/src/wasm_api.rs`: `pub async fn set_thumbnail(&self, key: String, thumbnail_key: Option<String>) -> Result<JsValue, JsError>` — lock, found-flag mutator (set/clear `thumbnail_key`; absent/tombstoned/identical → no write) [B2], report `{updated: bool}`; reject reserved-prefix `key`. Plus sync getter `thumbnail_key_for(key) -> String` re-exporting the core helper [B3].
- Unit tests (mutator shapes: set, clear, identical no-op, absent, tombstoned) + integration test (seed → set_thumbnail → manifest reflects; second identical call → no PUT via wiremock or attempts check) + smoke additions (set/get roundtrip incl. no-op).

## Task 2 — Web: generation pipeline + on-upload + generate-missing + lazy grid

- `web/src/lib/thumbs.ts`: `generateThumbnail(blobOrUrl, kind): Promise<Blob>` (canvas downscale [B4]; pdf page-1 via pdfPreview seam at thumb scale); `thumbTargetSize` math as pure tested helpers (long-edge 256, no upscale).
- Upload integration: after a transfer's upsert succeeds and kind is image/pdf, generate from the local `File` (no re-download!), presign_put the thumb key, PUT, then `set_thumbnail` [B3][B5]. Wire inside the transfers store completion path behind a seam (`engineDeps.generateThumb`?) so engine tests stay deterministic (mock it; assert non-fatal on rejection).
- `web/src/lib/generateMissing.svelte.ts` (or similar): sequential runner state (running, current, done/failed counts, cancel flag) [B6]; items fetch the ORIGINAL via presigned GET (these are out-of-band files — no local File), generate, PUT, set_thumbnail.
- UI: "Generate missing thumbnails" action (sidebar under the storage footer or TopBar overflow — match existing style), progress line + Cancel [B6]; FileGrid lazy thumbs [B7] with IntersectionObserver (extract observer-decision logic to a pure helper for tests where possible) + icon fallback [B8].
- Tests: thumb size math, runner state machine (progress/cancel/skip-on-failure), engine thumb hook non-fatal, grid decision helpers. Existing 140 green.

## Task 3 — Live validation (controller-owned)

Upload a real PNG → thumb appears in `.bare-bucket/thumbs/` (mc verify, webp, small), manifest row updated, grid tile shows the image (screenshot); out-of-band seed several images + a PDF → "Generate missing" → progress advances, thumbs created, grid updates; cancel mid-run stops it; delete a thumbed file → object + thumb + tombstone all verified gone (PR 12 interplay [B9]); lazy loading: tiles outside viewport don't fetch until scrolled (performance entries); failure tolerance: a corrupt/random-byte "image" (existing seed garbage) fails generation but the run continues and summarizes.

## Carry-forwards to respect
- PR 15: seed-demo real-format fixtures; per-provider CORS docs; polish list.
