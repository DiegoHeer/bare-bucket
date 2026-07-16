# Bare Bucket — v1 (Web) Design

**Date:** 2026-07-15
**Status:** Approved for planning
**Supersedes:** the initial "Serverless S3-Compatible Client — Architecture & Spec" draft (incorporates it; deltas are marked).

## 1. Vision

A file-management client for S3-compatible object storage (MinIO, Backblaze B2, Wasabi, Cloudflare R2, AWS S3, RustFS) with **no backend service of any kind**. All state lives either in the bucket itself or on-device. Every client — web now; Windows, iOS, Android later — is a dedicated app UI (browse, preview, upload/download), not a mounted drive. v1 is a self-hosted, LAN/VPN-only web client.

**Confirmed scale target:** personal use, up to ~10,000 objects per bucket, single active device at a time. These two assumptions shape the manifest format and the conflict-handling tier below; both are revisited when a second client is built.

## 2. Non-goals (v1)

- Multi-user collaboration / shared buckets between different people
- File versioning / version history
- Restorable trash — **deletes are permanent**, behind a confirm dialog (decided during design; tombstone *metadata* still exists, see §4)
- Mandatory encryption (future optional per-bucket toggle)
- Revocable sharing links
- Public internet-facing deployment (LAN/VPN only)
- Content/full-text search (filename/metadata search only)
- Native OS filesystem mounts on any platform
- Video thumbnails (v2; images + PDFs only in v1)
- Background auto-refresh polling (manual refresh + refresh-on-open only)

## 3. Architecture

### 3.1 Shared Rust core, thin UI shells

- **Web (v1):** Rust → WASM via `wasm-bindgen`, called from a thin Svelte UI.
- **Windows / iOS / Android (later):** same core as a native library via FFI.

Rust chosen for performance on this I/O- and parsing-heavy workload and for the mature `wasm-bindgen` path. The core stays intentionally small and boring for v1 — only what the web client needs.

### 3.2 Core modules (each independently testable)

| Module | Responsibility |
|---|---|
| `signer` | SigV4 request signing + presigned URL generation (custom, not the AWS SDK — must behave identically across providers) |
| `s3` | LIST/GET/PUT/DELETE + multipart upload engine; provider quirks (path-style vs virtual-hosted, conditional-write support) |
| `manifest` | read/parse/mutate/conditional-write of the manifest document |
| `reconcile` | full-LIST rebuild, drift repair, orphan/dangling-upload cleanup |
| `wasm-api` | thin `wasm-bindgen` boundary exposing the above to JS |

### 3.3 Streaming invariant

**The core never buffers file bodies.** File sizes are unbounded (>4 GB must work), so the core signs requests and orchestrates multipart chunking while bytes flow through browser-native streams (`Blob.slice` for uploads, `ReadableStream`/File System Access API for downloads). Core memory stays flat regardless of file size.

### 3.4 Reserved prefix

All app-internal objects live under `.bare-bucket/` in the bucket:

- `.bare-bucket/manifest.json.gz` — the manifest
- `.bare-bucket/thumbs/<original-key>.webp` — thumbnails

The browse UI hides the entire `.bare-bucket/` prefix.

## 4. Manifest

### 4.1 Format (delta from the original spec: SQLite dropped)

A gzipped JSON document, not SQLite. Rationale: at ≤10k objects the whole manifest is ~2 MB raw / ~300 KB gzipped and is loaded fully into memory anyway; SQLite-in-WASM adds ~1 MB of binary and the most fragile toolchain step for zero used capability. Plain `serde` + gzip is trivial, and the document is inspectable with `curl | gunzip | jq`. `schema_version` covers a future format migration if a later client needs partial reads at much larger scale.

```jsonc
{
  "schema_version": 1,
  "last_full_rebuild_at": "2026-07-15T10:00:00Z",
  "last_writer_device_id": "web-a1b2c3",
  "objects": [
    {
      "key": "photos/2026/trip/IMG_0142.jpg",
      "size": 4194304,
      "etag": "\"9b2cf535f27731c974343645a3985328\"",
      "last_modified": "2026-07-14T18:22:00Z",
      "content_type": "image/jpeg",
      "favorite": false,
      "thumbnail_key": ".bare-bucket/thumbs/photos/2026/trip/IMG_0142.jpg.webp", // null if none
      "deleted_at": null // tombstone timestamp (see 4.4)
    }
  ]
}
```

- No `folder` field — the folder tree is derived from key prefixes at load time (milliseconds at this scale; stored derived data only risks drift).
- `favorite` supports the Favorites view (§7).

### 4.2 Writes

Read manifest → apply change → gzip → `PUT` with `If-Match: <etag>`. On `412 Precondition Failed`: re-fetch, re-apply, retry (bounded, 5 attempts, then surface an error). If the provider ignores `If-Match` on PUT, v1 logs a console warning and proceeds last-writer-wins.

### 4.3 Bootstrap

First connect to a bucket with no manifest runs reconciliation (§6) to build one. Same code path as manual refresh; no special case.

### 4.4 Conflict-handling tiers — v1 vs. client #2 prerequisites

v1 assumes a single active device. It ships only:

- ETag conditional-PUT on manifest writes (cheap insurance against accidental overlap)
- Object-level ETag comparison before upload-over-existing (§8.3)
- Tombstone *fields*: deleting writes `deleted_at` instead of removing the row (rows purged on next reconciliation)

**Prerequisites for building any second client (documented here deliberately — these are not optional polish):**

- `.manifest.lock` advisory-lock fallback for providers without conditional-write support (device ID + timestamp + short TTL)
- Tombstone grace window: purge only after a defined window, so a stale device cannot resurrect deleted files
- Re-evaluation of last-writer-wins on non-conditional providers

## 5. Transfers

### 5.1 Upload

- **≤ 64 MB:** single signed `PUT` (one request; atomic; cheap on per-request-billed providers — this matters because thumbnails are themselves small uploaded objects).
- **> 64 MB:** S3 multipart — `CreateMultipartUpload` → parallel `UploadPart` (64 MB parts, 3–4 in flight) → `CompleteMultipartUpload`. Part size scales up as needed under the 10,000-part cap, so file size is effectively unlimited.
- One `upload()` entry point picks the strategy; the threshold is a tunable constant.
- Core emits signed request descriptors per part; JS slices the `File` (`Blob.slice`, zero-copy) and performs the fetches.
- Per-part retry with backoff. On abort or final failure, `AbortMultipartUpload` is sent so half-uploads don't accrue storage. Reconciliation also lists dangling multipart uploads and cleans them up.
- Per-part progress events feed the transfer panel (§7.4). Closing the tab mid-upload triggers a `beforeunload` warning; uploads do not survive the tab in v1.
- After object upload: manifest row upserted → thumbnail generated and uploaded (images/PDFs) → manifest updated with `thumbnail_key`. Thumbnail failure is non-fatal and never blocks the upload.

### 5.2 Download

- Signed `GET`, streamed to disk via the File System Access API (`showSaveFilePicker` → `WritableStream`) on Chromium.
- Fallback (Firefox/Safari): a small service worker converts the fetch into a browser-native download (StreamSaver-style pattern, implemented in-repo, no dependency).
- Previews use ranged `GET`s (§7.5).

> **v1 note (revised during implementation):** the service-worker fallback described above was replaced with a universal `<a download>` fallback before it was built (PR 11). Both a service worker and `showSaveFilePicker` require a **secure context** (HTTPS or `localhost`), and v1's primary deployment is LAN/VPN access over plain `http://<private-ip>` — an origin with neither. A StreamSaver-style service worker would therefore fail on exactly the origins that also lack `showSaveFilePicker`, while adding real service-worker lifetime/keepalive complexity for no coverage gain. The two tiers actually shipped:
> 1. **File System Access API** (`showSaveFilePicker` → `WritableStream`) where available: a streamed fetch with a live, cancellable progress row in the transfer panel.
> 2. **Universal fallback** (Firefox/Safari, or any plain-`http://` LAN origin): navigate a temporary `<a href download>` at a presigned `GET` URL carrying `response-content-disposition=attachment; filename="…"`. The browser's own download manager streams it natively — no CORS needed (it's a navigation, not a `fetch`), no in-page buffering, and it works on every origin. There's no panel row for this path; the browser shows its own download progress instead.
>
> Downloads are **cancel-only** in v1 — no pause/resume (that would need Range-based resume bookkeeping the engine doesn't have yet). Ranged `GET`s and the `Accept-Ranges`/`Range` CORS exposure they need (previews, §7.5) land with PR 13; full-object `GET`s are all either path uses until then.

## 6. Reconciliation

Full-bucket LIST rebuild of the manifest — triggered manually (Refresh button), on app open, and on first-connect bootstrap. No background polling in v1.

Reconciliation also:
- updates rows whose ETag/size drifted (out-of-band tools: rclone, AWS CLI, provider consoles)
- removes rows for vanished objects and purges tombstoned rows
- flags orphaned thumbnails (thumb exists, original doesn't) and deletes them
- lists dangling multipart uploads and aborts them

## 7. Web UI

Nextcloud-inspired dark theme; validated via mockups during design.

### 7.1 Layout

- **Top bar:** logo · **profile switcher** ("R2 · photos ▾") · Refresh (reconcile) · settings
- **Left sidebar:** filename search · views (All files / Recent / Favorites) · folder tree · footer (storage-used indicator, settings)
- **Main pane:** Upload button · breadcrumbs · list/grid view toggle · recent-files strip (thumbnail cards) · file list with checkboxes, per-row inline actions (`···`), Size and Modified columns · footer count ("1 folder, 4 files · 8.2 GB")

Explicitly dropped from the Nextcloud pattern: Shares, People, Tags, app switcher, notifications, trash.

### 7.2 Views

- **All files:** folder navigation (derived tree), list + thumbnail-grid toggle
- **Recent:** manifest sorted by `last_modified`
- **Favorites:** rows with `favorite: true`; star/unstar from row actions and lightbox
- **Search:** client-side filename/metadata filter against the loaded manifest; no network calls
- **Storage indicator:** sum of manifest sizes

### 7.3 Connect screen

Centered profile-picker card (account-picker style):
- Lists saved profiles (name, endpoint, bucket); selecting one reveals the secret-key field and Connect button
- "＋ Add profile" opens the profile form in the same card
- Each profile row has an edit affordance (pencil/`···` on hover) → **Edit / Remove**; Edit reuses the add form, prefilled
- Connect validates credentials with a cheap request before entering the app

### 7.4 Transfers

Corner transfer panel (Drive-style): floating bottom-right, per-file progress bars, pause/cancel per item, aggregate header, collapsible to a pill, disappears when done.

### 7.5 Previews

Fullscreen lightbox: dimmed overlay, ←/→ steps through siblings in the current folder, Esc closes; actions in the overlay (download, favorite, delete). Content types: images (direct stream), PDF (pdf.js, range-requested), text (range-requested, capped preview size). Everything else: metadata + download button.

### 7.6 Delete

Permanent (no trash). Confirm dialog → object `DELETE` + thumbnail `DELETE` + manifest tombstone write.

## 8. Credentials, security, errors

### 8.1 Profiles

`localStorage`: `{ id, name, endpoint, region, bucket, accessKeyId, pathStyle }` (camelCase — aligned during implementation to match the web client's TypeScript convention; `web/src/lib/profiles.ts` is the source of truth). The access key ID is treated as non-secret (it is an identifier). `pathStyle` toggles path-style vs virtual-hosted addressing (RustFS/MinIO vs R2/AWS).

### 8.2 Secret key

Session-only: prompted per profile per session, held in WASM memory (at most `sessionStorage`), never persisted.

### 8.3 Object-level conflicts

Before uploading over an existing key, compare the object's current ETag with the manifest's. Mismatch → modal: **Overwrite / Save as a copy / Cancel**. Never silent data loss.

### 8.4 Error tiers

1. **Retryable** (network blips, 5xx, throttling): automatic backoff retries inside the core; invisible unless exhausted.
2. **Conflict:** manifest `412` retries silently (§4.2); object conflicts raise the modal (§8.3).
3. **Fatal** (bad credentials, missing CORS, bucket gone): human-readable message with a hint. CORS gets a dedicated "your bucket needs CORS rules → docs link" message — it is the most common setup failure for browser S3 clients.

### 8.5 CORS (docs requirement)

Browser-direct S3 requires bucket CORS rules allowing the app origin and exposing `ETag`. The self-hosting docs must include copy-paste CORS configurations for R2, RustFS/MinIO, and generic S3.

## 9. Thumbnails

- Generated **client-side in the UI layer** (browser APIs own this): images via canvas downscale, PDFs via pdf.js page-1 render. The core only uploads results and tracks `thumbnail_key`.
- WebP, ~256 px long edge, quality ~0.75 (typically 5–15 KB).
- Stored at `.bare-bucket/thumbs/<original-key>.webp` (mirrors the object tree; orphans are derivable).
- Generated on upload (non-fatal on failure) and via a **"Generate missing thumbnails"** action that scans the manifest for image/PDF rows with `thumbnail_key: null`, with progress + cancel — covers out-of-band uploads and pre-existing buckets.
- Delete removes the thumbnail with the object; reconciliation sweeps orphans.
- Browse grid lazy-loads thumbnails for visible tiles only; no thumbnail → file-type icon.

## 10. Testing

- **Core unit tests:** signer against AWS SigV4 test vectors; manifest mutations; conflict retry logic. `cargo test`, no network.
- **Integration:** `s3` module against a containerized RustFS or MinIO in CI (docker-compose). R2 exercised manually pre-release (no CI tier).
- **UI:** Vitest for profile logic and conflict-modal state. No e2e suite in v1.
- **CI:** `cargo test` + `cargo clippy` + WASM build check + UI build.

RustFS is in beta — treat as a moving target; re-check its compatibility matrix if conditional-write behavior seems inconsistent.

## 11. PR breakdown (v1)

Soft cap ~600 lines per PR (source and tests counted separately; generated files excluded).

| # | PR | Depends on |
|---|---|---|
| 1 | Core skeleton + WASM build pipeline + CI | — |
| 2 | SigV4 signer + presigned URLs (AWS test vectors) | 1 |
| 3 | S3 client: LIST/GET/PUT/DELETE, addressing styles, provider quirks; integration tests vs containerized RustFS/MinIO | 2 |
| 4 | Multipart upload engine: create/part/complete/abort, retry, progress events | 3 |
| 5 | Manifest core: JSON schema, gzip, conditional-PUT retry loop | 3 |
| 6 | Reconciliation: full-LIST rebuild, drift repair, orphaned-thumbnail + dangling-multipart cleanup | 5 |
| 7 | Svelte shell: scaffolding, profiles (localStorage), connect screen, secret handling | 1 |
| 8 | Browse UI: layout (sidebar/topbar/breadcrumbs), folder navigation, list + grid views | 5, 7 |
| 9 | Views & search: Recent, Favorites, storage indicator, filename search | 8 |
| 10 | Upload flow: drag-drop, corner transfer panel, conflict modal | 4, 8 |
| 11 | Download flow: streaming to disk + service-worker fallback | 8 |
| 12 | Delete flow: confirm dialog, tombstone write, thumbnail cleanup | 8 |
| 13 | Previews: lightbox (image / pdf.js / range-capped text), arrow navigation | 8 |
| 14 | Thumbnails: generate on upload, "generate missing" action, lazy grid loading | 6, 10 |
| 15 | Self-hosting docs (incl. per-provider CORS configs) + error-message polish | all |

PRs 1–6 are the core and block the rest; 9–14 can land in any order once 8 exists.

## 12. Deferred (later phases)

| Feature | Target | Notes |
|---|---|---|
| Content/full-text search | v2 (Web) | separate FTS index object in the bucket, same conflict mechanics as the manifest |
| Sharing links | v2 (Web) | presigned URLs, 1-hour default expiry, not revocable |
| Optional per-bucket encryption | v2 (Web) | client-side encrypt-before-upload; known tradeoffs (no key recovery, previews need decrypt, out-of-band key exchange) |
| Video thumbnails | v2 (Web) | frame extraction via `<video>` + canvas; no schema change needed |
| Configurable auto-refresh interval | v2 (Web) | v1 is manual + on-open only |
| Restorable trash | reconsider with client #2 | delete = move to `.bare-bucket/trash/`; explicitly rejected for v1 |
| Windows app | Phase 2 | Rust core via FFI; shell TBD (e.g. Tauri). **Blocked on §4.4 prerequisites.** |
| iOS app | Phase 3 | shell TBD (e.g. React Native). Same §4.4 blocker. |
| Android app | Phase 4 | shell TBD. Same §4.4 blocker. |
