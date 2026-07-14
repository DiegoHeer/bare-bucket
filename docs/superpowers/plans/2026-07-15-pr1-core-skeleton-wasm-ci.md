# PR 1: Rust Core Skeleton + WASM Build Pipeline + CI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cargo workspace containing the `bare-bucket-core` crate that compiles natively (with a passing test) and to WASM via `wasm-pack`, with a GitHub Actions CI pipeline enforcing fmt/clippy/test/WASM-build.

**Architecture:** Root Cargo workspace with a single `core/` crate (`cdylib + rlib`). The crate exposes one `#[wasm_bindgen]` function, `version()`, proving the native-test and WASM-bindings paths both work end to end. CI runs two jobs: native checks and a `wasm-pack` build. This is PR 1 of 15 from the design spec (`docs/superpowers/specs/2026-07-15-bare-bucket-v1-design.md` §11); later PRs add the `signer`, `s3`, `manifest`, and `reconcile` modules.

**Tech Stack:** Rust (stable, edition 2021), `wasm-bindgen` 0.2, `wasm-pack`, GitHub Actions.

## Global Constraints

- Commits follow Conventional Commits; each commit is atomic (one logical change, working state after each).
- PR soft cap: ~600 lines of source (tests counted separately; generated files excluded).
- Keep the core intentionally small — do NOT scaffold empty `signer`/`s3`/`manifest`/`reconcile` modules; they arrive with their own PRs.
- **Do not push or open a PR at the end** — Diego reviews the completed work in the worktree first (global workflow rule). After sign-off: push branch, open PR, monitor CI.
- Working directory: the `bare-bucket-design` worktree (branch `worktree-bare-bucket-design`).

---

### Task 1: Toolchain bootstrap (rustup + wasm32 target + wasm-pack)

**Files:** none (machine setup only — nothing to commit).

**Interfaces:**
- Consumes: nothing.
- Produces: working `cargo`, `rustup` with `wasm32-unknown-unknown` target, and `wasm-pack` on PATH for all later tasks.

- [ ] **Step 1: Install rustup (stable toolchain)**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
source "$HOME/.cargo/env"
```

Note: `source "$HOME/.cargo/env"` is needed once per shell; subsequent shells pick it up from the profile that rustup edits. If a task's `cargo` invocation fails with "command not found", re-run the `source` line.

- [ ] **Step 2: Verify the toolchain**

Run: `cargo --version && rustc --version`
Expected: both print versions (Rust stable, e.g. `rustc 1.8x.x`)

- [ ] **Step 3: Add the WASM target**

```bash
rustup target add wasm32-unknown-unknown
```

Run: `rustup target list --installed | grep wasm32`
Expected: `wasm32-unknown-unknown`

- [ ] **Step 4: Install wasm-pack**

```bash
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

Run: `wasm-pack --version`
Expected: `wasm-pack 0.13.x` (or newer)

---

### Task 2: Cargo workspace + core crate with `version()` (TDD)

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `rust-toolchain.toml`
- Create: `core/Cargo.toml`
- Create: `core/src/lib.rs` (implementation + unit test in the same file)
- Modify: `.gitignore`
- Create: `README.md`

**Interfaces:**
- Consumes: toolchain from Task 1.
- Produces: `bare_bucket_core::version() -> String` (returns the crate version from `CARGO_PKG_VERSION`); workspace layout `core/` that Task 3 adds WASM bindings to.

- [ ] **Step 1: Create the workspace and crate manifests**

`Cargo.toml` (repo root):

```toml
[workspace]
resolver = "2"
members = ["core"]
```

`rust-toolchain.toml` (repo root — makes rustup auto-provision the right toolchain/target for anyone cloning):

```toml
[toolchain]
channel = "stable"
targets = ["wasm32-unknown-unknown"]
```

`core/Cargo.toml`:

```toml
[package]
name = "bare-bucket-core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
```

(No dependencies yet — `wasm-bindgen` arrives in Task 3.)

- [ ] **Step 2: Write the failing test**

`core/src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn version_matches_cargo_manifest() {
        assert_eq!(crate::version(), env!("CARGO_PKG_VERSION"));
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test`
Expected: compile error — `cannot find function `version` in the crate root`

- [ ] **Step 4: Write the minimal implementation**

Prepend to `core/src/lib.rs` (above the `tests` module):

```rust
/// Returns the core crate version.
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test`
Expected: `test tests::version_matches_cargo_manifest ... ok` — 1 passed, 0 failed

- [ ] **Step 6: Extend `.gitignore`**

Append to the existing `.gitignore` (which currently contains `.superpowers/`):

```gitignore
/target
core/pkg/
```

- [ ] **Step 7: Create `README.md`**

```markdown
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
```

- [ ] **Step 8: Run fmt and clippy before committing**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings`
Expected: no output / no warnings

- [ ] **Step 9: Commit**

```bash
git add Cargo.toml Cargo.lock rust-toolchain.toml core/ .gitignore README.md
git commit -m "feat: scaffold Cargo workspace with bare-bucket-core crate"
```

---

### Task 3: wasm-bindgen export + WASM build

**Files:**
- Modify: `core/Cargo.toml` (add dependency)
- Modify: `core/src/lib.rs` (add binding attribute)

**Interfaces:**
- Consumes: `version()` and the workspace from Task 2.
- Produces: `core/pkg/` wasm-pack output whose JS module exports `version(): string` — this is the exact artifact the Svelte shell (PR 7) imports.

- [ ] **Step 1: Add the wasm-bindgen dependency**

In `core/Cargo.toml`, replace the empty `[dependencies]` section with:

```toml
[dependencies]
wasm-bindgen = "0.2"
```

- [ ] **Step 2: Export `version()` through wasm-bindgen**

In `core/src/lib.rs`, add the import at the top of the file and the attribute on the function:

```rust
use wasm_bindgen::prelude::*;

/// Returns the core crate version.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
```

(`#[wasm_bindgen]` is a no-op wrapper on native targets, so the Task 2 unit test keeps working unchanged.)

- [ ] **Step 3: Verify native tests still pass**

Run: `cargo test`
Expected: `test tests::version_matches_cargo_manifest ... ok`

- [ ] **Step 4: Build the WASM package**

Run: `wasm-pack build core --target web`
Expected: `[INFO]: :-) Your wasm pkg is ready to publish at .../core/pkg.`

- [ ] **Step 5: Verify the JS binding actually works**

Run:

```bash
node --input-type=module -e "
import init, { version } from './core/pkg/bare_bucket_core.js';
const wasm = await import('node:fs/promises').then(fs => fs.readFile('./core/pkg/bare_bucket_core_bg.wasm'));
await init({ module_or_path: wasm });
console.log('wasm version():', version());
"
```

Expected: `wasm version(): 0.1.0`

- [ ] **Step 6: Run fmt and clippy**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings`
Expected: no warnings

- [ ] **Step 7: Commit**

```bash
git add core/Cargo.toml core/src/lib.rs Cargo.lock
git commit -m "feat: compile core to WASM with wasm-bindgen"
```

---

### Task 4: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the workspace, tests, and WASM build from Tasks 2–3.
- Produces: a `CI` workflow with jobs `rust` (fmt, clippy, test) and `wasm` (wasm-pack build) that every later PR runs against.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test --workspace

  wasm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
      - uses: Swatinem/rust-cache@v2
      - uses: taiki-e/install-action@v2
        with:
          tool: wasm-pack
      - run: wasm-pack build core --target web
```

- [ ] **Step 2: Sanity-check the YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"`
Expected: `YAML OK` (if PyYAML is missing, `node -e "const s=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!s.includes('wasm-pack build')) throw 1; console.log('smoke OK')"` is an acceptable smoke check — real validation happens when CI runs on the PR)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add fmt, clippy, test, and WASM build checks"
```

---

### Task 5: Verify the full pipeline end to end

**Files:** none.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified, review-ready branch.

- [ ] **Step 1: Clean-slate verification run**

```bash
cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --workspace && wasm-pack build core --target web
```

Expected: all four succeed; final line `[INFO]: :-) Your wasm pkg is ready to publish`.

- [ ] **Step 2: Confirm the tree is clean and commits are atomic**

Run: `git status --short && git log --oneline main..HEAD`
Expected: no uncommitted changes (besides `core/pkg/` being ignored); commit list shows the scaffold, wasm, and ci commits (plus the earlier design-doc commits on this branch).

- [ ] **Step 3: STOP — request Diego's review**

Per the global workflow: pause here, present the diff summary, and wait for sign-off before pushing the branch and opening the PR. After sign-off: push, `gh pr create` (merge-commit strategy on merge), monitor CI.
