# Bare Bucket — Web Docker Image & Release Pipeline (PR 16)

Decided 2026-07-16 with Diego. Scope: packaging and releasing the **web client** only. Future native/desktop clients get their own packaging and attach their artifacts to the same GitHub Releases; this design must not preclude that.

## 1. Goals & non-goals

**Goals**
- The web app is deployable as a Docker image: `ghcr.io/diegoheer/bare-bucket-web`.
- CI builds and publishes the image with proper semantic versioning, driven by the repo's existing Conventional Commits discipline.
- A deployment can be identified: version visible (subtly) in the UI and stamped on the image.

**Non-goals**
- CI never touches Diego's infrastructure. Publish to GHCR only; the homelab (compose/doco-cd style) pulls on its own schedule.
- No packaging for future iOS/Android/desktop clients — different artifact types, same release stream, designed later.
- No per-component versioning yet. One repo-wide version; if native clients ever need independent versions, release-please manifest mode supports splitting then.

## 2. Versioning & release flow (release-please)

- Single repo-wide semver, **starting at 1.0.0** (v1 is shipped and validated).
- A `release-please` workflow runs on pushes to `main`. It maintains a running release PR ("chore(main): release X.Y.Z") that accumulates merged conventional commits: `feat:` → minor, `fix:` → patch, `BREAKING CHANGE`/`!` → major.
- The release PR maintains a root `CHANGELOG.md` and bumps the version in: the release-please version marker, `web/package.json`, and `core/Cargo.toml` (with lockfile). Exact updater mechanics (release type / extra-files) are an implementation detail for the plan.
- Merging the release PR creates tag `vX.Y.Z` and a GitHub Release. Cadence is fully in Diego's control — merge the bot PR when a release is wanted.
- **Accepted quirk:** PRs created with the default `GITHUB_TOKEN` do not trigger CI on themselves. The release PR only touches changelog/version files, and CI runs on `main` after the merge, so this is acceptable. Revisit with a PAT only if it ever bites.

## 3. The image

- **Self-contained multi-stage `Dockerfile` at repo root** — `docker build .` must work from a bare checkout (matches the self-hosting docs' spirit).
  - Stage 1 (pinned to `$BUILDPLATFORM`): rust + wasm-pack → `core/pkg`.
  - Stage 2 (pinned to `$BUILDPLATFORM`): node → `npm ci && npm run build` → `web/dist`.
  - Final stage (per `$TARGETPLATFORM`): `nginxinc/nginx-unprivileged:alpine` serving `web/dist`.
  - The wasm+JS output is architecture-independent, so **amd64 + arm64** images come from one asset build copied into per-arch nginx bases.
- **`nginx.conf`** (minimal): listen 8080 (unprivileged), gzip enabled including `application/wasm`, immutable cache headers for hashed assets, `no-cache` for `index.html`.
- **Plain HTTP by design.** TLS / secure-context concerns (File System Access downloads need https or localhost) belong to the operator's reverse proxy, exactly as `docs/self-hosting.md` documents.
- `.dockerignore` keeps the context lean (target/, node_modules/, dist/, pkg/, .git/ …).

## 4. Publish workflow

- New workflow triggered by the release tag (`v*`):
  1. buildx multi-platform build (linux/amd64, linux/arm64).
  2. **Smoke check before any push**: run the freshly built image, curl `index.html` and the wasm asset, non-200 fails the release.
  3. Push to GHCR with tags `X.Y.Z`, `X.Y`, and `latest`.
  4. OCI labels: `org.opencontainers.image.{version, revision, source, licenses}` (AGPL-3.0-only), etc.
- Workflow permissions: `contents: read`, `packages: write`.
- One-time manual step (documented, not automated): make the GHCR package public.
- The existing `ci.yml` PR gates stay untouched.

## 5. Version in the app

- Vite injects `__APP_VERSION__` from `web/package.json` at build time.
- The connect screen's card shows a subtle `vX.Y.Z` footer. No other UI changes.

## 6. Docs & verification

- `docs/self-hosting.md`: new "Run with Docker" section — image name, tags, a copy-paste `docker compose` snippet (port mapping, reverse-proxy note), and the make-package-public note.
- `README.md`: mention the image alongside the build-from-source quickstart.
- Verification for the implementation plan: `docker build` from a bare checkout succeeds; the running container serves the app and connects to the local MinIO stack end-to-end; the publish workflow's smoke check is exercised (e.g. via `workflow_dispatch` dry-run or an rc tag) before the first real release.

## 7. Deliverable shape

One PR (PR 16): `Dockerfile`, `nginx.conf`, `.dockerignore`, two workflows (`release-please.yml`, `publish.yml` — names indicative), release-please config, the `__APP_VERSION__` UI touch, and docs. Comfortably within the ~600-line source cap.
