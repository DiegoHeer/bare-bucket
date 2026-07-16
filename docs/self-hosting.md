# Self-hosting Bare Bucket

Bare Bucket is a static single-page app: a Rust core compiled to WebAssembly,
wrapped by a Svelte UI. There is no backend service and no server-side
session — everything the app needs (the manifest, thumbnails, the objects
themselves) lives in your S3-compatible bucket, and the only "state" outside
the bucket is the profile list in the browser's `localStorage` and the
secret access key held in page memory for the session. Self-hosting means:
build the static site, serve the files, and configure CORS on the bucket you
point it at.

## Prerequisites

- [rustup](https://rustup.rs) (the target's `rust-toolchain.toml` provisions
  the right toolchain and the `wasm32-unknown-unknown` target automatically)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- Node.js 26+ and npm
- An S3-compatible bucket: MinIO, RustFS, Cloudflare R2, AWS S3, Backblaze
  B2, Wasabi, etc.

## Build

These are the exact commands CI runs (`.github/workflows/ci.yml`, `web` job):

```sh
wasm-pack build core --target web   # compiles core/ to core/pkg/ (wasm + JS glue)
cd web
npm ci
npm run build                        # production build -> web/dist/
```

`web/dist/` is the entire deployable artifact: static HTML/CSS/JS plus the
wasm binary. There's nothing else to build or deploy.

> If you're iterating locally rather than deploying, `npm run dev` runs a
> Vite dev server. For a check that exercises the real build output, use
> `npm run build && npm run preview` instead.

## Serving

`web/dist/` is a plain static SPA — there are no server-side routes, no
API endpoints, and no server-rendered pages. Any static file server works:
nginx, Caddy, a CDN, `python -m http.server`, `npx serve`, S3-as-a-website,
GitHub Pages, etc. The one requirement: serve `index.html` for unknown paths
if your host doesn't already do path-based SPA fallback (Bare Bucket doesn't
use client-side routing for deep links today, so in practice this only
matters for the root path — there's nothing to configure for a plain
static host serving `index.html` at `/`).

There is no environment-specific build: the same `web/dist/` works against
any S3-compatible provider, because the endpoint, region, bucket, and
credentials are all supplied at runtime through the connect screen (§8.1),
not baked in at build time.

## Connecting: profile fields

The connect screen (spec §7, §8.1) collects, per saved profile:

| Field | Meaning |
|---|---|
| Name | A label for the profile list — purely cosmetic. |
| Endpoint | `scheme://host[:port]` of the S3-compatible API, e.g. `https://s3.example.com:9000`. No path, no trailing slash. |
| Bucket | The bucket name. |
| Region | The SigV4 signing region. MinIO/RustFS accept `us-east-1` (or any consistent value); R2 uses `auto`. |
| Access key ID | Non-secret identifier for the credential; saved alongside the profile. |
| Path-style addressing | Checkbox. On for MinIO/RustFS (`https://host/bucket/key`); off for R2/AWS-style virtual-hosted addressing (`https://bucket.host/key`). |

Everything above is saved to `localStorage` (key `bare-bucket/profiles`) so
it's there next time you open the app. The **secret access key** is
deliberately not part of the saved profile: it's prompted every time you
connect and lives only in the WASM client instance for that session — never
written to `localStorage`, `sessionStorage`, or anywhere else on disk. Closing
the tab forgets it.

## CORS

Because Bare Bucket has no backend, the browser talks to your bucket
directly — uploads, downloads, listing, and the manifest read/write all go
straight from the page to the S3 endpoint. That means the bucket's CORS
configuration must allow the app's origin, or every request fails a
preflight before it ever reaches your provider. This is, in practice, the
most common first-run failure — see Troubleshooting below.

The exact headers below are derived from what the client actually sends and
reads (`core/src/signer.rs`, `core/src/s3/mod.rs`, `core/src/s3/multipart.rs`,
`web/src/lib/textPreview.ts`, `web/src/lib/upload.ts`), not a generic
S3-CORS template:

- **`AllowedHeaders`**: `authorization`, `x-amz-date`, `x-amz-content-sha256`
  (the three SigV4 headers signed on every control-plane request — list,
  get/put/delete/head object, multipart init/complete/abort/list),
  `if-match` (conditional manifest writes, spec §4.2), `content-type` (every
  PUT/POST body, including presigned upload PUTs), `range` (the ranged `GET`
  the text-preview lightbox issues against a presigned URL, spec §7.5).
- **`ExposeHeaders`**: `ETag` (read back after every PUT/GET/HEAD — required
  for multipart part assembly and object-conflict comparison), `Content-Range`
  (read back from the ranged preview `GET` to determine the object's real
  size vs. a stale manifest value), and `Accept-Ranges` (consumed by pdf.js's
  range-probing when streaming PDF previews).
- **`AllowedMethods`**: `GET`, `PUT`, `POST`, `DELETE`, `HEAD`.
- **`AllowedOrigins`**: the origin(s) you serve `web/dist/` from, e.g.
  `https://bucket.example.com` or `http://192.168.1.50:8080` for a plain LAN
  deployment. Replace `https://your-app-origin.example` below with yours.

### MinIO

Via `mc` (works identically against RustFS, which speaks the same admin API):

```sh
cat > cors.json <<'EOF'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://your-app-origin.example"],
      "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
      "AllowedHeaders": ["authorization", "x-amz-date", "x-amz-content-sha256", "if-match", "content-type", "range"],
      "ExposeHeaders": ["ETag", "Content-Range", "Accept-Ranges"],
      "MaxAgeSeconds": 3600
    }
  ]
}
EOF

mc alias set local https://your-minio-endpoint ACCESS_KEY SECRET_KEY
mc cors set local/your-bucket cors.json
```

(Older MinIO releases without `mc cors set` used a bucket-level
`MINIO_API_CORS_ALLOW_ORIGIN` env var restricted to origins only, with no
per-header control — upgrade if you're on one of those; the header-level
rules above need the newer `mc cors set` support.)

### RustFS

RustFS speaks the same S3 CORS API as MinIO/AWS, so either the `mc cors set`
form above (if you manage it via `mc`) or the generic S3 JSON form below (if
you manage it via the S3 API directly) applies unchanged.

### Cloudflare R2

R2's dashboard (Bucket → Settings → CORS Policy) takes the same shape as the
S3 `CORSRules` JSON — paste this in directly:

```json
[
  {
    "AllowedOrigins": ["https://your-app-origin.example"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedHeaders": ["authorization", "x-amz-date", "x-amz-content-sha256", "if-match", "content-type", "range"],
    "ExposeHeaders": ["ETag", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

R2 uses virtual-hosted-style addressing, so leave "Path-style addressing"
**off** in the profile, and set Region to `auto`.

### Generic S3 (AWS S3, Backblaze B2, Wasabi, ...)

```sh
cat > cors.json <<'EOF'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://your-app-origin.example"],
      "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
      "AllowedHeaders": ["authorization", "x-amz-date", "x-amz-content-sha256", "if-match", "content-type", "range"],
      "ExposeHeaders": ["ETag", "Content-Range", "Accept-Ranges"],
      "MaxAgeSeconds": 3600
    }
  ]
}
EOF

aws s3api put-bucket-cors --bucket your-bucket --cors-configuration file://cors.json --endpoint-url https://your-endpoint
```

Drop `--endpoint-url` for real AWS S3.

## HTTP vs. HTTPS

Bare Bucket's core signing/list/upload/download path works over plain
`http://` — this is intentional, since a common deployment is a LAN or VPN
appliance reachable only as `http://192.168.x.x` with no TLS terminator in
front of it. Two features specifically need a **secure context** (HTTPS, or
`http://localhost`), and degrade gracefully without one (spec §5.2):

- The **File System Access API** (`showSaveFilePicker`) download path, used
  when available for a streamed, cancellable, progress-tracked download.
- A page origin's ability to register a Service Worker (not currently used
  in v1 — the planned SW-based download fallback was replaced with the
  universal `<a download>` fallback below before it shipped, specifically
  *because* it would have failed on exactly the http-LAN origins this app
  targets).

On any origin lacking a secure context — plain `http://<lan-ip>`, or a
browser without FSA support (Firefox, Safari) — downloads fall back to
navigating a temporary `<a href download>` at a presigned URL. The browser's
own download manager handles it; there's no CORS requirement for this path
(it's a navigation, not a `fetch`) and no in-page progress row, just the
browser's native download UI. Uploads, browsing, thumbnails, and previews are
unaffected either way — only the *download* mechanism changes.

## Security notes

- The secret access key is **never persisted**. It's prompted per profile
  per session and held only in the in-page WASM client instance; it does not
  touch `localStorage`, `sessionStorage`, cookies, or any file. Closing the
  tab (or reconnecting) requires re-entering it.
- Presigned URLs (used for uploads, downloads, and multipart parts) are
  **bearer tokens**: anyone who obtains one can use it for whatever it
  authorizes (a GET, a PUT to a specific key) until it expires, with no
  further authentication check. Don't log them, don't put them in
  screenshots you share, and treat a leaked presigned URL as a leaked
  credential for that one operation.
- The access key ID is treated as non-secret (spec §8.1) — it's an
  identifier, not a credential — and is the only credential material saved
  to `localStorage`.

## Troubleshooting

**CORS preflight failures** (browser console shows a blocked
`OPTIONS`/preflight, or a "no 'Access-Control-Allow-Origin' header" error,
and the app surfaces a "your bucket needs CORS rules" message): check that
your bucket's CORS rule's `AllowedOrigins` exactly matches the origin
`web/dist/` is served from (scheme + host + port — `http://localhost:5173`
and `http://localhost:8080` are different origins), and that `AllowedHeaders`
and `ExposeHeaders` match the lists above exactly. A rule that's missing just
`content-type` or `if-match` will pass simple GETs and fail on the first
upload or manifest write, which can look like a different bug at first.

**"If-Match unsupported" / an "⚠ unconditional writes" chip appears** in the
top bar: your provider doesn't support conditional PUT (`If-Match`) on this
endpoint. The app detects this (a `501 Not Implemented` from the provider)
and falls back to last-writer-wins for manifest saves — concurrent edits from
two clients can silently overwrite each other instead of retrying. This is a
provider limitation, not an app bug; it's rare among modern S3-compatible
providers but worth knowing about if you see the chip.

**403 errors that look like bad credentials but aren't**: SigV4 signatures
are time-scoped, so a client clock more than a few minutes off from the
provider's clock produces `SignatureDoesNotMatch`/403 even with correct
keys. Check the browsing device's clock (NTP sync) if you're otherwise
confident the access key/secret/endpoint/region are right.

**`npm run dev` 404s on the wasm asset**: fixed via `server.fs.allow` in
`web/vite.config.ts` (Vite's file-serving allow-list stopped at
`web/`, blocking the local `file:` wasm package in `core/pkg`). If you see
this on an older checkout, update; the production build path was never
affected.

## See also

- [`README.md`](../README.md) — quickstart against the bundled MinIO dev stack.
- [Design spec](superpowers/specs/2026-07-15-bare-bucket-v1-design.md) — §5.2
  (download paths), §8 (credentials/security/CORS), §7.5 (previews).
- [Plans directory](superpowers/plans/) — implementation history, PR by PR.
