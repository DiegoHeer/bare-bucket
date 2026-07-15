# Bare Bucket

A serverless file-management client for S3-compatible object storage
(MinIO, Backblaze B2, Wasabi, Cloudflare R2, AWS S3, RustFS). No backend
service: all state lives in the bucket itself or on-device.

Design spec: `docs/superpowers/specs/2026-07-15-bare-bucket-v1-design.md`

## Repository layout

- `core/` — shared Rust core (compiled to WASM for the web client)

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
docker compose up -d --wait
BARE_BUCKET_IT=1 BARE_BUCKET_IT_ENDPOINT=http://127.0.0.1:9000 \
  BARE_BUCKET_IT_REGION=us-east-1 BARE_BUCKET_IT_BUCKET=bare-bucket-it \
  BARE_BUCKET_IT_ACCESS_KEY=baretest BARE_BUCKET_IT_SECRET_KEY=baretest123 \
  cargo test -p bare-bucket-core --test s3_integration
```

Without `BARE_BUCKET_IT=1` these tests skip, so `cargo test` stays fast offline.
