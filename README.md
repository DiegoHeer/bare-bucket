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
cargo clippy --all-targets         # lint
wasm-pack build core --target web  # build the WASM package (output: core/pkg/)
```
