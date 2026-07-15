# PR 10: Upload Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Working uploads per spec §5.1/§7.4: drag-drop + Upload button, single presigned PUT ≤64 MiB / multipart beyond (3 parts in flight, lazy per-part presigning), the corner transfer panel (per-file progress, pause for multipart, cancel with abort), the conflict modal (Overwrite / Save as a copy / Cancel — spec §8.3), manifest upsert after completion, and `active_upload_ids` threaded into every reconcile call.

**Architecture:** Core: `s3::head_object` (conflict detection reads the CURRENT object ETag) + the wasm upload surface (`upload_plan`, `presign_put`, `create/complete/abort_multipart_upload`, `presign_upload_part`, `upsert_object`, `head_object`). Web: a `transfers.svelte.ts` store owning the queue, per-item state, progress, and active upload IDs; an upload engine module (`upload.ts`) with pure, tested helpers (collision rename, part math) and the per-file driver (XHR for upload progress; fetch lacks it); `TransferPanel` + `ConflictModal` components; drag-drop + picker wiring in BrowseScreen.

**Tech Stack:** existing only. XMLHttpRequest for upload progress events.

## Global Constraints

- Commits: Conventional Commits, atomic; trailer: blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work from `/home/diego/Projects/bare-bucket/.claude/worktrees/bare-bucket-design`; web from `web/`; `source "$HOME/.cargo/env"` for cargo/wasm-pack.
- Rust gates: fmt + both clippys + `cargo test --workspace`. Web gates: `npm run check && npm test -- --run && npm run build`.
- Do not push or open a PR.
- **BINDING carry-forwards (accumulated from PR 4/6/7/9 reviews):**
  1. Presign each part LAZILY immediately before its PUT dispatch; on retry, re-presign. Never presign a batch upfront. Presigned URLs are bearer tokens — never `console.log` them, never store them beyond the in-flight request.
  2. The UI owns the Complete retry loop: on a retryable error from `complete_multipart_upload` (including the truncated-200 case the core marks retryable), retry Complete with the SAME parts up to 3 times with backoff; only then fail the transfer (leaving abort to the user's cancel or reconcile's cleanup).
  3. `abort_multipart_upload` errors: NotFound counts as success (already handled in core; don't double-report in UI).
  4. Single-PUT and part PUTs set `Content-Type` explicitly from the browser `File.type` (fallback `application/octet-stream`) via the XHR request header — presigns don't sign it, providers store it.
  5. `upsert_object`'s wasm method: writer lock held; `last_modified` timestamp computed OUTSIDE the mutator closure (compute `now_iso8601()` once in Rust before `update_with_retry`); values captured.
  6. All new wasm returns cross via `to_js` (clippy guard enforces).
  7. `session.connect()` and `session.refresh()` pass `transfers.activeUploadIds()` instead of `[]`.
  8. After a completed upload: update `session.manifest` locally (upsert the row in place) — no full refresh; the transfer panel row flips to done.
  9. `beforeunload` warns while any transfer is active (spec §5.1).
  10. Optimistic/local manifest updates re-find rows by key on the live manifest instance.
- **Conflict UX (spec §8.3 + design decision):** ANY name collision with an existing manifest key prompts the modal before upload starts. The modal message gains a warning line ("This file changed outside the app") when `head_object`'s current ETag ≠ the manifest row's ETag. Choices: **Overwrite** (proceed with same key), **Save as a copy** (auto-renamed `name (1).ext`, first free suffix), **Cancel**. Never silent data loss.
- Concurrency: max 3 files uploading at once (rest queued); within a multipart file, max 3 parts in flight.
- Pause: multipart only (stop dispatching new parts; in-flight parts finish; Resume continues). Single-PUT shows cancel only.
- Cancel: single-PUT → `xhr.abort()`; multipart → stop dispatch, abort in-flight XHRs, then `abort_multipart_upload` (fire-and-forget with error logged to the transfer row).
- YAGNI: no resumability across page reloads, no upload retry UI (per-part network retry: 2 attempts then transfer fails), no folder uploads, no drag-drop folder traversal, no speed/ETA display.

---

### Task 1: core upload surface (`head_object` + wasm methods)

**Files:**
- Modify: `core/src/s3/mod.rs` (add `head_object`)
- Modify: `core/tests/s3_client.rs` (wiremock: head_object etag + 404→None path)
- Modify: `core/src/wasm_api.rs` (upload surface)
- Modify: `scripts/wasm-smoke.mjs` (single-PUT upload roundtrip incl. conflict fields)

**Interfaces:**

```rust
// s3/mod.rs
pub struct HeadResult { pub etag: String, pub size: u64 }
impl S3Client {
    /// HEAD an object; Ok(None) when it does not exist.
    pub async fn head_object(&self, key: &str) -> Result<Option<HeadResult>, S3Error>;
}
```

```ts
// wasm surface (all camelCase in, snake_case/simple out via to_js)
client.upload_plan(size: bigint | number): { kind: "single" } | { kind: "multipart"; part_size: number; part_count: number }
client.presign_put(key: string, expiresSecs: number): { method: string; url: string; expires_secs: number }
client.create_multipart_upload(key: string, contentType: string): Promise<string>
client.presign_upload_part(key: string, uploadId: string, partNumber: number, expiresSecs: number): { method; url; expires_secs }
client.complete_multipart_upload(key: string, uploadId: string, parts: { part_number: number; etag: string }[]): Promise<string>
client.abort_multipart_upload(key: string, uploadId: string): Promise<void>
client.upsert_object(key: string, size: number, etag: string, contentType: string): Promise<void>  // stamps last_modified internally (outside closure)
client.head_object(key: string): Promise<{ etag: string; size: number } | null>
```

Implementation notes (binding):
- `head_object` in s3: `send(HEAD, Some(key), ...)` — on `S3Error::NotFound` return `Ok(None)`; NOTE `head_bucket`'s 404 remap doesn't apply here (different method: key is Some; classify's 404 arm yields NotFound{key} — map that). HEAD responses have no body; etag from headers; size from `content-length` header (`required_header` for etag; content-length parse with InvalidResponse on absence/garbage).
- wasm `upload_plan`: expose `multipart::plan_upload`; sizes as `f64`-safe numbers via `u64` from JS `number` (accept `f64` and cast: JS can't exceed 2^53 for realistic sizes; take `size: f64`, guard negative/NaN → JsError).
- wasm errors: message strings as today (typed codes deferred per PR 9 decision).
- `upsert_object`: lock → `let last_modified = now_iso8601();` OUTSIDE closure → `update_with_retry(|m| m.upsert(ManifestObject { key, size, etag, last_modified: last_modified.clone(), content_type, favorite: preserve existing? — upsert REPLACES the row; preserve `favorite` and `thumbnail_key` from any existing row (read them inside the closure from the fresh manifest before upserting; pure w.r.t. the manifest state) })`. Spec: re-upload over a favorite keeps the star; thumbnail_key becomes stale on content change — CLEAR thumbnail_key on upsert when the etag changed (old thumb shows old content); keep when same etag.
- Smoke additions (after favorite roundtrip): `upload_plan(1000)` kind single + `upload_plan(200*1024*1024)` multipart math; presign_put + Node fetch PUT a small body + `head_object` roundtrip (etag matches PUT response... PUT via presigned URL returns ETag header — compare) + `upsert_object` + `load_manifest` shows the row with correct content_type + favorite preserved false + re-upsert with DIFFERENT etag clears thumbnail... (thumbnail null anyway; assert field null) + `head_object("missing") === null`. Clean up the uploaded key at the end (delete via... no wasm delete yet — leave the object; use key `smoke/upload-roundtrip.txt` overwritten each run; the manifest row stays — acceptable, seeded bucket).

TDD: wiremock tests for head_object first (RED/GREEN); wasm surface is bindings (gates + smoke).

Commit: `feat: add core upload surface across the wasm boundary`

---

### Task 2: transfers store + upload engine (TDD for pure parts)

**Files:**
- Create: `web/src/lib/upload.ts` (pure helpers + the XHR driver)
- Create: `web/src/lib/transfers.svelte.ts` (reactive store + queue orchestration)
- Create: `web/tests/upload.test.ts`
- Modify: `web/src/lib/session.svelte.ts` (reconcile calls take `transfers.activeUploadIds()`; add `applyUpsert(object)` local-manifest helper)

**Interfaces:**

```ts
// upload.ts — pure, tested
export function nextFreeName(name: string, taken: Set<string>): string;
// "photo.jpg" taken → "photo (1).jpg"; "photo (1).jpg" taken → "photo (2).jpg"; extensionless + dotfiles handled (".env" → ".env (1)")
export function partRanges(size: number, partSize: number): { partNumber: number; start: number; end: number }[]; // 1-based, end exclusive, covers size exactly

// upload.ts — driver (not unit-tested; exercised live)
export interface PutProgress { (loadedBytes: number): void }
export function putWithProgress(url: string, body: Blob, contentType: string, onProgress: PutProgress, signal: AbortSignal): Promise<string /* etag header */>;
// XHR PUT; rejects on non-2xx (message includes status), abort (DOMException AbortError), network error, or missing ETag header

// transfers.svelte.ts
export interface Transfer {
  id: string; key: string; name: string; size: number;
  kind: "single" | "multipart";
  status: "queued" | "uploading" | "paused" | "done" | "error" | "cancelled";
  uploaded: number;             // bytes, reactive
  error: string | null;
  uploadId: string | null;      // multipart only
}
export const transfers: {
  items: Transfer[];
  active: boolean;                       // any queued/uploading/paused
  activeUploadIds(): string[];           // multipart uploadIds not yet completed/aborted
  enqueue(file: File, key: string): void;
  pause(id: string): void;               // multipart only
  resume(id: string): void;
  cancel(id: string): Promise<void>;
  clearFinished(): void;
};
```

Engine algorithm (in transfers.svelte.ts; binding points marked):
1. `enqueue` pushes a Transfer and pokes the scheduler; scheduler keeps ≤3 transfers in "uploading".
2. Per file: `plan = client.upload_plan(file.size)`.
   - single: `presign_put(key, 3600)` immediately before `putWithProgress` [B1]; etag from response; content-type from `file.type || "application/octet-stream"` [B4].
   - multipart: `create_multipart_upload(key, contentType)` → store uploadId (activeUploadIds now includes it) → part loop over `partRanges(size, plan.part_size)` with a window of 3 [B-concurrency]: for each part, presign LAZILY right before dispatch [B1], `putWithProgress(url, file.slice(start, end), contentType, ...)`; per-part retry: on failure re-presign + retry ONCE more, then fail the transfer; per-part progress accumulates into `uploaded` (track per-part loaded to avoid double-count on retry: uploaded = completedBytes + sum(inFlightLoaded)).
   - pause: stop dispatching new parts (in-flight finish and count); resume re-enters the loop.
   - cancel: abort in-flight XHRs via AbortController(s); multipart → `abort_multipart_upload` (catch → row error note, status stays cancelled).
   - complete: `complete_multipart_upload(key, uploadId, parts)` with retry ×3/backoff on ANY rejection whose message doesn't clearly indicate a permanent condition — simplest faithful rule per the carry-forward: retry up to 3 times unconditionally with 1s/2s backoff [B2], then status error.
3. On success: `upsert_object(key, size, etag, contentType)` → `session.applyUpsert({...row})` locally [B8] → status done.
4. `window.addEventListener("beforeunload", ...)` registered once in the store module: `if (transfers.active) { e.preventDefault(); }` [B9].

`session.applyUpsert(object: ManifestObject)`: find by key on the live manifest; replace or push [B10]. (Favorite/thumbnail preservation happens in core; applyUpsert mirrors: when replacing keep existing favorite, and thumbnail_key = same-etag ? existing : null — mirror core's rule; simplest: applyUpsert takes the fields and applies the same preservation logic; add a tiny comment pointing at wasm_api's rule.)

Tests (vitest, TDD): `nextFreeName` (base, chained, extensionless, dotfile, multi-dot "a.tar.gz" → "a (1).tar.gz"), `partRanges` (exact multiple, remainder last part, single part, coverage property: concatenated ranges == size, 1-based contiguous).

Commit(s): `feat: add transfer store and upload engine` (split pure helpers/tests from store if cleaner).

---

### Task 3: UI — TransferPanel, ConflictModal, drag-drop + picker

**Files:**
- Create: `web/src/components/TransferPanel.svelte`
- Create: `web/src/components/ConflictModal.svelte`
- Modify: `web/src/screens/BrowseScreen.svelte` (enable Upload button → hidden `<input type="file" multiple>`; drag-drop overlay on the content area; conflict-check pipeline; mount TransferPanel + ConflictModal)
- Modify: `web/src/lib/browse.svelte.ts` if needed (nothing expected)

**Behavior (binding):**
- Upload button (now enabled, primary style) opens the picker; drag-over shows an overlay ("Drop to upload to {current folder}"); drop/pick → for each file: target key = `browse.prefix + file.name`.
- Conflict pipeline per file: if key exists among live manifest objects → open ConflictModal (queue further conflicts; one modal at a time). Modal fetches `head_object(key)` while opening; if current etag ≠ manifest etag, show the out-of-band warning line. Choices per Global Constraints; "Save as a copy" computes `nextFreeName(file.name, takenNamesInPrefix)`.
- Non-conflicting files enqueue immediately (don't wait for the modal queue).
- TransferPanel (mockup §7.4): fixed bottom-right; header "Uploading N items · M%" (aggregate bytes) with collapse-to-pill (▾/▴) and ✕ (hidden entirely when no items; ✕ clears finished, disabled while active); per-row: icon, name, progress bar (or status label), per-row buttons: ⏸/▶ (multipart uploading/paused), ✕ cancel (while active). Done rows show ✓, error rows show the message (truncated, title=full).
- Uploads target the CURRENT prefix at enqueue time (key snapshot — later navigation doesn't retarget).
- After each upsert the row appears in the listing immediately (applyUpsert). No navigation side effects [carry-forward: nothing navigates automatically].

Styling: theme tokens throughout; panel `box-shadow`, `--surface` background, progress bar `--accent` on `--border` track.

Gates + commit: `feat: add upload UI with transfer panel and conflict modal`

Final step: `wasm-pack build core --target web && cd web && npm run build` (controller live-validates; no servers).
