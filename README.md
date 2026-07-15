# Bare Bucket

A serverless file-management client for S3-compatible object storage
(MinIO, Backblaze B2, Wasabi, Cloudflare R2, AWS S3, RustFS). No backend
service: all state lives in the bucket itself (objects, thumbnails, and an
in-bucket JSON manifest) or on-device (saved connection profiles); the
secret access key lives only in page memory for the session.

## Architecture

- **`core/`** — a Rust library implementing SigV4 request signing, the
  S3-compatible HTTP client, upload/multipart planning, and the manifest
  (the JSON index of the bucket's contents, stored as an object in the
  bucket itself, spec §4). Compiled to WebAssembly (`wasm-pack build core
  --target web`) and consumed directly by the web client — no server
  process runs this code.
- **`web/`** — a Svelte 5 SPA that renders the browse UI, drives uploads and
  downloads (the browser executes the presigned requests the core
  produces), generates thumbnails client-side (canvas for images, pdf.js
  for PDFs), and previews files inline.
- **No backend, ever.** The browser talks to your S3-compatible endpoint
  directly; the only "server" needed is a static file host for `web/dist/`.

Design spec: `docs/superpowers/specs/2026-07-15-bare-bucket-v1-design.md`
Self-hosting your own deployment: `docs/self-hosting.md`
Implementation history (PR by PR): `docs/superpowers/plans/`

## Repository layout

- `core/` — shared Rust core (compiled to WASM for the web client)
- `web/` — Svelte web client
- `scripts/seed-demo.sh` — seeds a local MinIO bucket with realistic
  fixtures (real JPEG/PNG images, a real PDF, real text) for demoing the
  browse UI, previews, and thumbnails
- `docker-compose.yml` — a local MinIO + bucket-bootstrap stack for
  development and the integration test suite

## Quickstart (local MinIO demo)

Spin up a local MinIO, seed it with realistic demo fixtures, and run the
app against it:

```sh
docker compose up -d --wait minio     # local MinIO
docker compose run --rm createbucket  # creates bare-bucket-it
./scripts/seed-demo.sh                # seeds real-format demo fixtures

wasm-pack build core --target web     # build the wasm package
cd web
npm ci
npm run build
npm run preview                       # serves web/dist/ — open the printed URL
```

In the app, add a profile: endpoint `http://127.0.0.1:9000`, region
`us-east-1`, bucket `bare-bucket-it`, access key `baretest`, secret
`baretest123`, path-style **on**. See `docs/self-hosting.md` for what each
field means and how to point this at your own bucket/provider instead.

## Development

Requires [rustup](https://rustup.rs) and
[wasm-pack](https://rustwasm.github.io/wasm-pack/); `rust-toolchain.toml`
provisions the toolchain and WASM target automatically.

```sh
cargo test                          # run core tests
cargo clippy --all-targets -- -D warnings  # lint (same flags as CI)
wasm-pack build core --target web  # build the WASM package (output: core/pkg/)
```

### Integration tests

Integration tests run against a local MinIO:

```sh
docker compose up -d --wait minio
docker compose run --rm createbucket
BARE_BUCKET_IT=1 BARE_BUCKET_IT_ENDPOINT=http://127.0.0.1:9000 \
  BARE_BUCKET_IT_REGION=us-east-1 BARE_BUCKET_IT_BUCKET=bare-bucket-it \
  BARE_BUCKET_IT_ACCESS_KEY=baretest BARE_BUCKET_IT_SECRET_KEY=baretest123 \
  cargo test -p bare-bucket-core --test s3_integration
```

Without `BARE_BUCKET_IT=1` these tests skip, so `cargo test` stays fast offline.

### Web client

```sh
wasm-pack build core --target web   # build the wasm package first
cd web
npm install
npm run dev                          # dev server
npm run check && npm test -- --run  # typecheck + unit tests
npm run build                        # production build (web/dist/)
npm run preview                      # serve the production build locally
```

> `npm run dev` currently 404s on the wasm asset in some setups (a Vite
> dev-server / local `file:` package interaction — known issue, not yet
> fixed). If you hit that, use `npm run build && npm run preview` instead;
> the production build path is unaffected. See `docs/self-hosting.md` for
> build/serve/CORS details when deploying somewhere other than your laptop.
