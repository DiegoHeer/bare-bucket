# PR 15 — Self-hosting docs + polish

Spec: `docs/superpowers/specs/2026-07-15-bare-bucket-v1-design.md` §8 (CORS: "self-hosting docs must include copy-paste CORS configurations for R2, RustFS/MinIO, and generic S3"), §11 row 15. Plus the accumulated polish ledger from PRs 7–14.

## Global constraints (binding)

- [B1] Docs are copy-paste ACCURATE: every CORS config must list exactly the headers the app actually sends/reads — AllowedHeaders: `authorization`, `x-amz-date`, `x-amz-content-sha256`, `if-match`, `content-type`, `range`; ExposeHeaders: `ETag`, `Content-Range`, `Accept-Ranges`; methods GET/PUT/POST/DELETE/HEAD. Derive from the code (signer/client/multipart docs), not from memory.
- [B2] No behavior regressions: every polish fix keeps the full gate suite green (Rust fmt/clippy native+wasm/test; web check/test/build; smoke). Engine-adjacent changes (progress throttling) get their own commit + tests and must keep all existing race tests untouched and green.
- [B3] Secret/URL hygiene rules restated in the docs (secret in memory only; presigned URLs are bearer tokens; http-LAN implications: FSA/SW unavailable → anchor fallback, documented in §5.2 already — link it).
- [B4] PR-size discipline: docs don't count; polish source stays small per item. Anything that balloons gets dropped back onto a "future" list rather than forced in.

## Task 1 — Self-hosting docs

- `docs/self-hosting.md`: prerequisites; build (`wasm-pack build core --target web` + `npm ci && npm run build`); serve `web/dist` statically (any static server; SPA — no server routes); connect-screen profile fields explained; **CORS section** [B1] with copy-paste configs: MinIO (`mc admin` / env var or `mc cors set` JSON), RustFS (same S3 JSON), Cloudflare R2 (dashboard JSON), generic S3 (`s3api put-bucket-cors` JSON); http-vs-https deployment notes (secure-context: FSA download path + future SW need https or localhost; everything else works on plain http LAN) [B3]; troubleshooting (CORS preflight failures, If-Match unsupported → last-writer-wins warning chip, clock skew 403).
- `README.md` (root): project one-paragraph, architecture sketch (core wasm / web), quickstart (docker compose up minio → seed → build → preview), link to self-hosting.md + spec.
- Spec §8.1 alignment (old carry-forward): fix the profile-fields casing doc mismatch (verify against profiles.ts and correct the spec table).
- `scripts/seed-demo.sh`: generate REAL-format fixtures (embed a small base64 PNG, a minimal valid PDF, real text) so previews/thumbnails demo correctly (PR 13 carry).

## Task 2 — Polish fixes (curated ledger; one commit per coherent group)

Web:
1. Save-as-copy: transfer panel row shows the renamed key's display name (PR 10 cosmetic).
2. `PRESIGN_EXPIRES_SECS`: export once from transfers store (or a constants module), import in BrowseScreen (PR 11).
3. `downloadFile` fire-and-forget: surface non-AbortError picker/presign failures via the session-level error affordance used elsewhere (match existing pattern; no new UI surface) (PR 11).
4. `DeleteReport.deleted` → derive `!already_absent` in Rust; web type stays (PR 12). already_absent may stay unused in web.
5. previewKind: parameter-tolerant content-type match (`application/json; charset=utf-8`) (PR 13 L2).
6. Stale image probe: clear `probe.src` when a stale token is detected (PR 13 L3).
7. pdf renderPage failures post-open surface the in-overlay error state instead of silent rejection (PR 13 L4).
8. pdf thumb/preview canvas: clamp max canvas dimension (e.g. 4096) against pathological pages/DPR (PR 13).
9. GridThumb `alt` — decorative is intentional: keep `alt=""` but add `aria-hidden`/comment, or use the filename — pick one, justify (PR 14).
10. `session.disconnect()` cancels + resets an active generate-missing run (PR 14 Low).
11. Generate-missing summary distinguishes cancelled runs; summary clears on next connect (PR 14 Info).
12. Empty-provider-message error strings: drop trailing colon (PR 7 cosmetic).
13. Progress-update throttling [B2 — own commit]: cap reactive `transferred` writes (e.g. only when Δ≥0.5% or ≥150ms since last write, always write the final value); keep engine race tests green; add a unit test for the throttle helper.
14. Trailing "· X total" footer wording (PR 8 note): verify current copy is fine; change only if trivially better.

Rust:
15. `reconcile_heals_out_of_band_changes` env flake: isolate the test under a unique run prefix (or make counts tolerant) so a polluted shared bucket can't fail it (PR 12).

Investigate-and-fix-if-cheap (else document in README "Known issues"):
16. `npm run dev` 404s the wasm asset (build+preview works) — likely vite dev + `file:` wasm pkg serving; try `optimizeDeps.exclude`/`server.fs.allow`; timebox it.

## Task 3 — Live validation + full-gate sweep (controller-owned)

Fresh full build; docs sanity (follow self-hosting.md steps mentally against the running stack); re-seed with the new real-format fixtures and confirm previews/thumbs demo correctly; spot-check polish items live (save-as-copy panel name, disconnect-during-generate-missing, generate-missing cancelled summary, download error surfacing); full gates: cargo fmt/clippy(native+wasm)/test, live integration suite (flake now isolated → should be fully green), wasm-pack, smoke, web check/test/build. This PR closes the 15-PR plan — after it, the final whole-project e2e validation pass (task #20) runs before anything is presented for review.
