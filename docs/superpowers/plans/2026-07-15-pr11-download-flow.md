# PR 11 — Download flow (streaming to disk + universal fallback)

Spec: `docs/superpowers/specs/2026-07-15-bare-bucket-v1-design.md` §5.2, §7, §8. Depends on PR 8 (browse UI) and PR 10 (transfer store/panel).

## Spec deviation (documented, needs Diego's sign-off at review)

Spec §5.2 names a StreamSaver-style **service-worker fallback** for non-Chromium browsers. Both service workers and `showSaveFilePicker` require a **secure context** — and v1's primary deployment is LAN/VPN over plain `http://<private-ip>`, where neither exists. An in-repo SW clone would therefore fail exactly where the primary path also fails, while adding sw-lifetime/keepalive complexity.

**Decision:** two tiers instead.
1. **File System Access API** (`showSaveFilePicker` → `WritableStream`) where available: streamed fetch with a live progress row in the transfer panel, cancellable.
2. **Universal fallback** (Firefox/Safari, any `http://` LAN origin): navigate a temporary `<a href download>` at a presigned GET URL carrying `response-content-disposition=attachment; filename="…"`. The browser's own download manager streams it natively — no CORS needed (navigation, not fetch), no memory buffering, works everywhere. No panel row; the browser shows its own progress.

Amend spec §5.2 with this rationale in this PR (small doc edit). The final report to Diego must call this out.

## Global constraints (binding)

- [B1] Presigned URLs are bearer tokens: never logged, never persisted, never put in reactive `$state` beyond the moment of use. The fallback anchor's `href` is set, clicked, and the element removed synchronously.
- [B2] Core never buffers file bodies (§3.4): the FSA path pipes `Response.body` reader chunks straight to the `FileSystemWritableFileStream`; no accumulation.
- [B3] All new wasm methods use the `to_js` helper (clippy disallowed-methods enforces); `expires_secs` crosses as `u32` (u64 becomes BigInt).
- [B4] `Transfer` gains `direction: "upload" | "download"` (PR 10 final-review carry). Rename `uploaded` → `transferred` (bytes moved either direction); update panel + all tests mechanically.
- [B5] Downloads support **cancel only** — no pause/resume in v1 (would need Range bookkeeping; note in spec §5.2 amendment). Panel pause/resume buttons render only for `direction === "upload"`.
- [B6] Shared scheduler: downloads occupy the same ≤3-concurrent-transfer pump slots as uploads; the per-part ≤3 loop stays upload-only.
- [B7] `showSaveFilePicker` must be called **first** in the click handler (user activation), with `suggestedName` = display name — before any `await` on presign/fetch. Picker cancel (AbortError) is a silent no-op, not an error row.
- [B8] Cancel/error on the FSA path aborts the fetch (AbortController) **and** `writable.abort()`s so no partial file survives. `transfers.cancelAll()` (and thus the disconnect guard) covers download rows.
- [B9] `activeUploadIds()` is unaffected by downloads (no uploadId). Engine internals for downloads are freed on terminal states like uploads (PR 10 pattern).
- [B10] Engine test seam (`engineDeps`) gains the download dependencies (presign + fetch); new races pinned in `web/tests/transfers.test.ts` — never against live network.
- [B11] `response-content-disposition` filename sanitization: strip `"` and `\` and CR/LF from the display name before embedding in `attachment; filename="…"`; the pair goes through the canonical-query encoder like any other param.

## Task 1 — Core: presigned GET with optional response-content-disposition

`core/src/s3/multipart.rs` (or a better-fitting home next to `presign_put`):
- `pub fn presign_get(&self, key: &str, expires_secs: u64, content_disposition: Option<&str>) -> PresignedRequest` — reuses the private `presign` helper; when `content_disposition` is `Some`, add query pair `("response-content-disposition", value)`. Same `debug_assert!` 7-day cap.

`core/src/wasm_api.rs`:
- `pub fn presign_get(&self, key: String, expires_secs: u32, attachment_name: Option<String>) -> Result<JsValue, JsError>` — when `attachment_name` is `Some`, build `attachment; filename="<sanitized>"` per [B11]; return `SerializablePresignedRequest` via `to_js`.

Tests:
- Unit: URL contains encoded `response-content-disposition`; no pair when `None`; sanitization strips quotes/backslash/CRLF.
- `tests/s3_integration.rs`: presign GET for a seeded object → plain `reqwest` fetch of the URL returns the exact bytes; with disposition set, response carries the `Content-Disposition` header.
- `scripts/wasm-smoke.mjs`: presign_get a seeded key, `fetch` it in Node, byte-compare.

## Task 2 — Web: download engine inside the transfer store

`web/src/lib/transfers.svelte.ts`:
- [B4] `direction` field + `transferred` rename. Upload construction sets `direction: "upload"`.
- Download statuses reuse the union; active state is `"downloading"` (added to the union; panel maps it to a label). No `"paused"` for downloads [B5].
- `engineDeps` gains: `presignGet: (key, expires, name) => Promise<PresignedRequest>` (wraps client call) and `fetchStream: (url: string, signal: AbortSignal) => Promise<Response>` (wraps `fetch`) [B10].
- `enqueueDownload(key: string, name: string, size: number, writable: FileSystemWritableFileStream)`: creates the row (`status: "queued"`), stores `writable` in internals, pump dispatches into `runDownload` under the shared slots [B6].
- `runDownload`: presign (lazy, at dispatch) → `fetchStream` → non-OK response = error row → reader loop: `transfer.transferred += chunk.byteLength`, `await writable.write(chunk)` → `writable.close()` → `status: "done"`. Unwind gate mirrors uploads: on cancel, abort controller + `writable.abort()` [B8]; free internals on terminal [B9].
- `cancelAll` covers downloads.

`web/tests/transfers.test.ts` additions (mock Response with a controllable `ReadableStream`, mock writable capturing write/close/abort):
- progress accumulates per chunk; done closes writable exactly once.
- cancel mid-stream → fetch aborted, `writable.abort()` called, `close()` never called, status `"cancelled"`.
- non-OK response → error row, writable aborted.
- slot sharing: 3 active uploads queue a download until a slot frees.

## Task 3 — UI wiring + fallback + docs

- `web/src/lib/download.ts`: `supportsFsa()` (`"showSaveFilePicker" in window && window.isSecureContext`), `pickSaveTarget(suggestedName)` (returns writable or `null` on user cancel), `anchorDownload(url)` (create `<a>`, `href`, `download`, click, remove — synchronous [B1]).
- `FileList.svelte` + `FileGrid.svelte`: per-file download action (icon button beside the star; `aria-label="Download <name>"`). Folder rows get none.
- `BrowseScreen.svelte` handler: FSA support → picker-first flow [B7] then `transfers.enqueueDownload`; otherwise presign with `attachment_name` and `anchorDownload` (no row).
- `TransferPanel.svelte`: direction icon (↑/↓) per row; labels "Downloading"/"Finishing…"; pause/resume hidden for downloads [B5]; header aggregates both directions.
- Spec §5.2 amendment (deviation rationale above + cancel-only note).
- Gates: full rust + web suites, wasm-pack rebuild, `npm run build`.

Live validation (controller, CDP): headless Chrome is a secure-context question — validate FSA path if available, else validate fallback; verify byte-identical download of a seeded file (small + the 150MiB multipart object), cancel mid-download leaves no partial file, panel row behavior, disconnect guard covers an active download.

## Carry-forwards to respect
- PR 12 (BINDING): tombstone-aware preservation landed; FileList row keyboard accessibility due with row-actions rework — this PR adds a row action button; make it a real `<button>` (keyboardable) so PR 12's work builds on it.
- PR 13: Range + Accept-Ranges CORS documentation (previews) — note in spec amendment that ranged GETs come with PR 13.
