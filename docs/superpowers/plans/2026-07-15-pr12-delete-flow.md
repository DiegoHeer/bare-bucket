# PR 12 — Delete flow (confirm dialog, tombstone, thumbnail cleanup)

Spec: `docs/superpowers/specs/2026-07-15-bare-bucket-v1-design.md` §7.6 ("Permanent (no trash). Confirm dialog → object `DELETE` + thumbnail `DELETE` + manifest tombstone write."), §4 (tombstones), §8 (errors). Depends on PR 8/10/11 UI surfaces.

## Global constraints (binding)

- [B1] All manifest writers serialize under `manifest_write_lock`; mutators passed to `update_with_retry` are pure and idempotent (may run multiple times on conflict retry); timestamps computed OUTSIDE the closure.
- [B2] Tombstone mutator uses the **found-flag pattern** — do NOT copy `set_favorite`'s write-on-miss shape (PR 9 carry). If the key is absent or already tombstoned, the mutator makes no change and the wasm method reports it (no pointless manifest PUT: skip the write when nothing changed).
- [B3] Order of operations (spec §7.6): object DELETE → thumbnail DELETE (if the manifest row has a `thumbnail_key`) → manifest tombstone write. S3 DELETE on a missing key returns 204/NoSuchKey — treat NotFound as success (idempotent delete, matches abort-NotFound=success precedent). A thumbnail DELETE failure must NOT abort the flow: still tombstone, report the leftover (reconcile's orphan-thumb sweep will heal it).
- [B4] Tombstone semantics per spec §4: set `deleted_at` (ISO-8601, computed outside closure), clear `thumbnail_key`; row is retained as a tombstone, not removed. All readers already treat `deleted_at != null` as absent (PR 10 fix).
- [B5] New wasm method uses `to_js` (clippy guard) and returns a serializable report `{ deleted: bool, thumbnail_deleted: bool | null, already_absent: bool }` (camelCase on the JS side via serde rename like existing reports — CHECK existing report structs and match their convention exactly).
- [B6] Web mirror: `session.applyTombstone(key)` mirrors the Rust rule on the live manifest (set deleted_at on the local row) so the UI updates without a full refresh; same live-instance re-find discipline as `applyUpsert` (PR 10).
- [B7] Delete is blocked for keys with an in-flight transfer (queued/uploading/paused/downloading) — reuse the same in-flight key set the conflict pipeline consults; the row's delete button is disabled with a title explaining why.
- [B8] Keyboard accessibility (PR 8 BINDING carry): with this row-actions rework, FileList rows become keyboard-reachable — folder-row navigation triggerable via Enter/Space on a real focusable element (real `<button>` or `role="button"` + `tabindex="0"` + key handler; prefer a real button element wrapping the name cell). Row action buttons (download/star/delete) are already `<button>`s — they must remain reachable in tab order after the rework. FileGrid tiles get the same treatment (real button or tabindex + key handler) if they aren't already.
- [B9] Confirm dialog: modal in the ConflictModal style (backdrop, Escape cancels, Enter does NOT auto-confirm destructive action — the confirm button must be explicitly activated; initial focus lands on the Cancel button). Text names the file and says the delete is permanent. Full focus-trap extraction stays deferred to PR 13's shared modal base — match ConflictModal's current level, no worse.
- [B10] Errors: object-DELETE failure → in-modal (or inline) error, manifest untouched, no optimistic removal. Only after the wasm method reports success does the UI apply the tombstone locally.
- [B11] Presigned-URL/secret hygiene unchanged: nothing new is logged or persisted.

## Task 1 — Core/wasm: `delete_object` composite

`core/src/wasm_api.rs` (+ any core helper that fits naturally in manifest.rs):
- `pub async fn delete_object(&self, key: String) -> Result<JsValue, JsError>`, under `manifest_write_lock` for the FULL sequence [B1][B3]:
  1. Load current manifest state (within `update_with_retry`'s loop is fine for the tombstone, but the thumbnail key must be read before deleting: read the row's `thumbnail_key` via a manifest load before the S3 deletes).
  2. S3 `DELETE` object (NotFound = success).
  3. If the row had a `thumbnail_key`: S3 `DELETE` thumbnail; failure → remember `thumbnail_deleted: false`, continue [B3].
  4. `update_with_retry` with a pure found-flag tombstone mutator [B2][B4]; skip the PUT when the mutator reports no change.
- Reject deleting keys under `.bare-bucket/` (reserved prefix) with a clear error.
- Unit tests for the mutator shape (found / absent / already-tombstoned / clears thumbnail_key). Integration test (`s3_integration.rs`): seed object (+ fake thumb under `.bare-bucket/thumbs/`), delete via `S3Client` primitives mirroring the composite's logic OR expose a core-level helper and test that; assert object gone, thumb gone, manifest row tombstoned with `deleted_at` set. Smoke (`scripts/wasm-smoke.mjs`): upload → delete_object → load_manifest shows tombstone → reconcile keeps it consistent.

## Task 2 — Web: confirm modal, row actions, keyboard accessibility

- `web/src/components/DeleteConfirmModal.svelte` [B9].
- `web/src/lib/session.svelte.ts`: `deleteObject(key)` — calls wasm `delete_object`, then `applyTombstone(key)` [B6][B10]; surface `thumbnail_deleted === false` as a non-blocking console-level note (reconcile heals).
- FileList + FileGrid: delete button (🗑-style icon consistent with icons.ts, `aria-label="Delete <name>"`), disabled while the key is in-flight [B7]; keyboard accessibility rework [B8].
- BrowseScreen wiring: delete button → modal → on confirm await `session.deleteObject` → close; error path per [B10]. Deleting the last file of a folder: existing stale-prefix ancestor fallback (PR 9) must kick in — verify, don't reimplement.
- Vitest: modal behavior (Escape cancels, confirm fires callback, initial focus), applyTombstone (row gets deleted_at; listing helpers then hide it; favorite/tombstone interplay), in-flight disable logic. Keyboard: unit-test the key handler logic where feasible.

## Task 3 — Live validation (controller-owned)

Delete small file (confirm modal → row disappears, footer count drops, MinIO object gone via mc, manifest tombstone present via wasm smoke or mc cat | gunzip), delete file with favorite set (tombstone clears it per preservation rule), cancel path (Escape + Cancel button leave everything intact), delete-while-uploading blocked (disabled button), keyboard walk (Tab to folder row → Enter navigates; Tab to delete → Enter opens modal → Escape), reserved-prefix rejection (via console/wasm call), empty-folder ancestor fallback after deleting last file.

## Carry-forwards to respect
- PR 13: shared modal base extraction (this PR adds the 3rd modal-ish surface — keep DeleteConfirmModal's structure close to ConflictModal so extraction is mechanical).
- PR 15: any new polish items discovered here go on the list, not in this PR.
