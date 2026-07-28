# PR 16 — Web Docker Image & Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the web client as `ghcr.io/diegoheer/bare-bucket-web` (multi-arch, unprivileged nginx) with release-please-driven semantic versioning and a tag-triggered publish workflow.

**Architecture:** A self-contained multi-stage Dockerfile builds wasm+web on `$BUILDPLATFORM` and copies the arch-independent `web/dist` into per-arch `nginx-unprivileged` bases. release-please (running on pushes to main) maintains a release PR bumping one repo-wide version; merging it tags `vX.Y.Z`, which triggers a publish workflow: smoke-check the image, then buildx-push amd64+arm64 to GHCR.

**Tech Stack:** Docker/BuildKit, nginxinc/nginx-unprivileged:alpine, googleapis/release-please-action@v4, docker/{metadata,login,build-push,setup-qemu,setup-buildx} actions, Vite `define`.

**Spec:** `docs/superpowers/specs/2026-07-16-docker-release-design.md` — binding.

## Global Constraints

- [B1] Image name exactly `ghcr.io/diegoheer/bare-bucket-web`; tags `X.Y.Z`, `X.Y`, `latest`; OCI labels incl. `org.opencontainers.image.licenses=AGPL-3.0-only`.
- [B2] `docker build .` MUST succeed from a bare checkout (no host toolchain). Final stage runs unprivileged, listens on 8080, plain HTTP (TLS is the operator's proxy problem — spec §3).
- [B3] Single repo-wide version starting at **1.0.0**; bumped in `version.txt` (marker), `web/package.json`, `core/Cargo.toml`; root `CHANGELOG.md`. Cargo.lock staleness after a bump is accepted (cargo reconciles on next build; note it in the release-please config comment/docs).
- [B4] CI never touches infrastructure: publish workflow pushes to GHCR only, `permissions: contents: read, packages: write`.
- [B5] The publish workflow smoke-checks the freshly built image (index.html AND the wasm asset return 200) BEFORE any push.
- [B6] UI shows the version subtly on the connect screen only; injected at build time as `__APP_VERSION__` from `web/package.json`.
- [B7] Existing `ci.yml` stays untouched.
- [B8] Pin action versions (@vN) and base images by major/named tag (digest-pinning optional, follow docker-compose.yml precedent if trivial).
- All gates for any task touching web/: `cd web && npm run check && npm test -- --run && npm run build`. Rust untouched except the Cargo.toml version line (+ annotation comment): run `cargo fmt --all --check && cargo test --workspace` once in Task 2.

---

### Task 1: Dockerfile + nginx.conf + .dockerignore

**Files:**
- Create: `Dockerfile`
- Create: `nginx.conf`
- Create: `.dockerignore`

**Interfaces:**
- Produces: image serving the SPA on :8080; `web/dist` layout (hashed assets under `/assets/`, wasm among them) — Task 3's smoke check depends on this.

- [ ] **Step 1: Write `.dockerignore`**

```
.git
.github
.claude
.superpowers
docs
scripts
target
core/pkg
core/pkg-node
web/node_modules
web/dist
**/*.md
```

- [ ] **Step 2: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

# ---- Stage 1: wasm (runs on the build host's native arch; output is
# architecture-independent) ----
FROM --platform=$BUILDPLATFORM rust:1-slim AS wasm
ARG WASM_PACK_VERSION=0.13.1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown \
    && curl -fsSL "https://github.com/drager/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
       | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/wasm-pack'
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY core ./core
RUN wasm-pack build core --target web

# ---- Stage 2: web build (native arch; output is architecture-independent) ----
FROM --platform=$BUILDPLATFORM node:22-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
COPY --from=wasm /src/core/pkg /src/core/pkg
RUN npm ci
COPY web ./
RUN npm run build

# ---- Final stage: static serving, per target arch, unprivileged ----
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web /src/web/dist /usr/share/nginx/html
EXPOSE 8080
```

Note for the implementer: the wasm-pack release asset arch in the URL is the
BUILD host's — on GitHub's amd64 runners `x86_64-unknown-linux-musl` is
correct. If you want local arm64 `docker build` to work too, derive it:
replace the hardcoded triple with a `case "$(uname -m)"` mapping
(`x86_64`→`x86_64-unknown-linux-musl`, `aarch64`→`aarch64-unknown-linux-musl`)
inside the RUN. Do this — it is two lines and keeps [B2] true on ARM hosts.

Second note: `COPY web ./` lands on top of the existing `node_modules`
(COPY merges, does not replace) and `.dockerignore` already excludes
`web/node_modules` and `web/dist` from the context, so the host's copies
can't leak in. The `file:../core/pkg` dependency resolves because Stage 2
copied the pkg to the same relative location before `npm ci`.

- [ ] **Step 3: Write `nginx.conf`**

```nginx
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types application/wasm application/javascript text/css application/json image/svg+xml;

    # Hashed build artifacts: safe to cache forever.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # The entry document must always revalidate so deploys take effect.
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

- [ ] **Step 4: Build the image from a bare-checkout context**

Run (from the worktree root): `docker build -t bare-bucket-web:dev .`
Expected: succeeds end-to-end (rust stage compiles the workspace, wasm-pack emits `core/pkg`, vite build emits `dist`, final image assembles). First build takes several minutes.

- [ ] **Step 5: Run and smoke the container**

```bash
docker run -d --rm --name bbweb -p 8080:8080 bare-bucket-web:dev
sleep 1
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/            # expect 200
WASM=$(docker exec bbweb sh -c 'ls /usr/share/nginx/html/assets | grep "\.wasm$"' | head -1)
curl -fsS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8080/assets/$WASM"  # expect 200
curl -fsSI "http://127.0.0.1:8080/assets/$WASM" | grep -i cache-control        # expect immutable
docker exec bbweb id -u                                                        # expect non-0 (unprivileged)
docker stop bbweb
```

- [ ] **Step 6: Commit**

```bash
git add Dockerfile nginx.conf .dockerignore
git commit -m "feat: add self-contained multi-stage Dockerfile for the web client"
```
(Trailer per repo convention: blank line + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` — applies to every commit in this plan.)

---

### Task 2: release-please config + workflow + version in the UI

**Files:**
- Create: `release-please-config.json`, `.release-please-manifest.json`, `version.txt`, `.github/workflows/release-please.yml`
- Modify: `core/Cargo.toml:3` (annotation), `web/vite.config.ts` (define), `web/src/vite-env.d.ts` (declaration), `web/src/screens/ConnectScreen.svelte` (footer)
- Test: `web/tests/` — only if a pure helper emerges; the version footer itself is markup (no DOM harness in this repo — verified live in Task 4).

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: tag format `vX.Y.Z` (no component prefix) — Task 3's publish trigger depends on it; `__APP_VERSION__: string` global.

- [ ] **Step 1: Write `release-please-config.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "release-type": "simple",
      "changelog-path": "CHANGELOG.md",
      "include-component-in-tag": false,
      "release-as": "1.0.0",
      "extra-files": [
        { "type": "json", "path": "web/package.json", "jsonpath": "$.version" },
        { "type": "generic", "path": "core/Cargo.toml" }
      ]
    }
  }
}
```

`"release-as": "1.0.0"` forces the FIRST release to 1.0.0 per spec §2; removing it afterwards is a documented one-line chore (Step 6 adds it to the docs). The `simple` release type maintains `version.txt` + `CHANGELOG.md` at the root. Cargo.lock is deliberately NOT managed (spec-accepted staleness; cargo reconciles on the next build).

- [ ] **Step 2: Write `.release-please-manifest.json` and `version.txt`**

`.release-please-manifest.json`:
```json
{ ".": "0.1.0" }
```
`version.txt`:
```
0.1.0
```
(0.1.0 mirrors the current `web/package.json`/`core/Cargo.toml` version; `release-as` overrides the computed next version for the first release.)

- [ ] **Step 3: Annotate `core/Cargo.toml` for the generic updater**

Change line 3 from `version = "0.1.0"` to:
```toml
version = "0.1.0" # x-release-please-version
```
Run: `source "$HOME/.cargo/env" && cargo fmt --all --check && cargo test --workspace` — expected: all green (comment-only change).

- [ ] **Step 4: Write `.github/workflows/release-please.yml`**

```yaml
name: release-please

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

(Known, spec-accepted quirk: the release PR is created with `GITHUB_TOKEN`, so `ci.yml` does not run on it; its changes are mechanical and main CI runs post-merge.)

- [ ] **Step 5: Inject `__APP_VERSION__` and render the footer**

`web/vite.config.ts` — add at the top:
```ts
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
```
and inside `defineConfig({ ... })`:
```ts
define: { __APP_VERSION__: JSON.stringify(pkg.version) },
```

`web/src/vite-env.d.ts` — append:
```ts
declare const __APP_VERSION__: string;
```

`web/src/screens/ConnectScreen.svelte` — inside the card, after the existing content (match the card's class conventions; style: small, muted — reuse an existing muted color var if one exists in the file/styles):
```svelte
<p class="app-version">v{__APP_VERSION__}</p>
```
```css
.app-version {
  margin: 16px 0 0;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted, #6b7280);
}
```
Read the component first and follow its exact spacing/var conventions — the snippet above is the shape, the file's own idiom wins on class naming and color variables.

- [ ] **Step 6: Gates + commit**

Run: `cd web && npm run check && npm test -- --run && npm run build` — all green; confirm `grep -o 'v0\.1\.0' dist/assets/*.js | head -1` finds the injected version.
```bash
git add release-please-config.json .release-please-manifest.json version.txt .github/workflows/release-please.yml core/Cargo.toml web/vite.config.ts web/src/vite-env.d.ts web/src/screens/ConnectScreen.svelte
git commit -m "feat: add release-please versioning and surface the app version"
```

---

### Task 3: publish workflow + docs

**Files:**
- Create: `.github/workflows/publish.yml`
- Modify: `docs/self-hosting.md` (new "Run with Docker" section), `README.md` (image mention)

**Interfaces:**
- Consumes: tag `vX.Y.Z` from Task 2's flow; image/asset layout from Task 1.

- [ ] **Step 1: Write `.github/workflows/publish.yml`**

```yaml
name: publish

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  packages: write

jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3

      # Build a single-arch copy locally and smoke it BEFORE any push.
      - name: Build for smoke test
        uses: docker/build-push-action@v6
        with:
          context: .
          load: true
          tags: smoke:local
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Smoke test
        run: |
          docker run -d --rm --name smoke -p 8080:8080 smoke:local
          sleep 2
          curl -fsS -o /dev/null http://127.0.0.1:8080/
          WASM=$(docker exec smoke sh -c 'ls /usr/share/nginx/html/assets | grep "\.wasm$"' | head -1)
          test -n "$WASM"
          curl -fsS -o /dev/null "http://127.0.0.1:8080/assets/$WASM"
          docker stop smoke

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/diegoheer/bare-bucket-web
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=latest
          labels: |
            org.opencontainers.image.title=Bare Bucket (web)
            org.opencontainers.image.description=Serverless S3-compatible file manager — web client
            org.opencontainers.image.licenses=AGPL-3.0-only

      - name: Build and push (multi-arch)
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

(`metadata-action` derives `version`/`revision`/`source`/`created` labels automatically from the tag + repo; the explicit labels add title/description/license per [B1].)

- [ ] **Step 2: Validate workflow syntax**

Run: `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest .github/workflows/publish.yml .github/workflows/release-please.yml 2>&1 || npx --yes yaml-lint .github/workflows/*.yml`
Expected: no errors (if actionlint's image can't be pulled, fall back to careful YAML parse via `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish.yml'))"` — for each file).

- [ ] **Step 3: Docs — `docs/self-hosting.md` "Run with Docker" section**

Insert after the "Serving" section, matching the doc's voice:

````markdown
## Run with Docker

Each release publishes a multi-arch image (amd64/arm64):

```
ghcr.io/diegoheer/bare-bucket-web:latest     # newest release
ghcr.io/diegoheer/bare-bucket-web:1.0.0      # exact version (recommended)
ghcr.io/diegoheer/bare-bucket-web:1.0        # newest patch of a minor
```

It serves the static app over plain HTTP on port 8080 as a non-root user —
put your reverse proxy in front for TLS (see the http-vs-https notes above).

```yaml
services:
  bare-bucket:
    image: ghcr.io/diegoheer/bare-bucket-web:1.0.0
    ports:
      - "8080:8080"
    restart: unless-stopped
```

The image contains no credentials and needs no configuration — connection
profiles live in your browser. Building locally instead: `docker build .`
works from a bare checkout.
````

Also append to Troubleshooting (or the release notes area, wherever fits the doc's structure): after the first `v1.0.0` release, remove the `"release-as": "1.0.0"` line from `release-please-config.json` so subsequent versions are computed from commits. Put this note in the README's release section instead if self-hosting.md has no natural home for maintainer notes — implementer's judgment, but it must be written down somewhere discoverable.

- [ ] **Step 4: `README.md`** — in the quickstart area, add one short paragraph: run the released image via `docker run -p 8080:8080 ghcr.io/diegoheer/bare-bucket-web:latest` as the no-toolchain alternative, linking to the self-hosting doc's Docker section. Mention releases are cut via release-please (conventional commits → CHANGELOG).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish.yml docs/self-hosting.md README.md
git commit -m "feat: publish versioned multi-arch web image to GHCR on release"
```

---

### Task 4: Live validation (controller-owned — not delegated)

- [ ] Full `docker build` from the worktree; run the container; drive a real browser at `http://127.0.0.1:8080` — connect to the local MinIO stack THROUGH the containerized app; verify browse works and the connect screen shows `v0.1.0`.
- [ ] Confirm image runs as non-root; cache headers on assets; gzip on the wasm asset (`curl -H 'Accept-Encoding: gzip' -sI`).
- [ ] Post-merge (after this PR lands): merge the release-please PR when it appears → tag `v1.0.0` → watch `publish.yml` run: smoke passes, image lands on GHCR with `1.0.0`/`1.0`/`latest`; then the one-time step: make the GHCR package public (Settings → Packages, or `gh api`) and pull-test anonymously. Then remove `release-as` (per the docs note) in a trivial follow-up commit/PR.

---

## Self-review notes

- Spec coverage: §2 → Task 2; §3 → Task 1; §4 → Task 3 Step 1; §5 → Task 2 Step 5; §6 → Task 3 Steps 3–4 + Task 4; §7 → single PR, all tasks. No gaps.
- Type consistency: `__APP_VERSION__` declared (vite-env.d.ts) before use; tag pattern `v*` matches `include-component-in-tag: false`.
- The `generic` updater requires the `# x-release-please-version` annotation — added in Task 2 Step 3; the `json` updater needs none.
