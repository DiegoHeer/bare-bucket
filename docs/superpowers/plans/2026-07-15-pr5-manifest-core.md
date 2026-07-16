# PR 5: Manifest Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The manifest layer in `bare-bucket-core`: the gzipped-JSON manifest document (spec §4), pure mutation semantics (upsert, tombstone, favorite), and a `ManifestStore` that loads/saves it through the S3 client with the conditional-PUT retry loop — including bootstrap-on-missing and the `Unsupported` (501) last-writer-wins fallback.

**Architecture:** New `core/src/manifest.rs` module. Two layers: a **pure data model** (`Manifest`, `ManifestObject` — serde JSON + gzip encode/decode, no I/O) and a **store** (`ManifestStore` owning an `S3Client` reference + device id) whose `update_with_retry` implements spec §4.2: read → apply mutator → gzip → conditional PUT (`If-Match`) → on 412 re-fetch and re-apply (bounded, 5 attempts). A provider that rejects `If-Match` with 501 (`S3Error::Unsupported`, added in PR 3) degrades to an unconditional PUT, and the outcome records that the write was unconditional.

**Tech Stack:** new deps `serde` (derive), `serde_json`, `flate2` (default rust backend — WASM-clean). Everything else existing.

## Global Constraints

- Commits: Conventional Commits, atomic; trailer: blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work from `/home/diego/Projects/bare-bucket/.claude/worktrees/bare-bucket-design` (branch `worktree-bare-bucket-design`); `source "$HOME/.cargo/env"` in every shell.
- Before every commit: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings` clean.
- Do not push or open a PR.
- Manifest key: `.bare-bucket/manifest.json.gz`; reserved prefix `.bare-bucket/` (spec §3.4) — expose both as consts; the UI later filters the prefix.
- JSON field names exactly as spec §4.1 (snake_case); unknown fields must not break parsing (forward compat) and `favorite`/`thumbnail_key`/`deleted_at` must parse when absent (`#[serde(default)]`).
- A manifest with `schema_version` greater than the current version must refuse to load (never clobber a newer client's data).
- Tombstones (spec §4.4): delete marks `deleted_at`, never removes the row here; purge is reconciliation's job (PR 6). Re-upserting a tombstoned key clears the tombstone.
- YAGNI: no If-None-Match bootstrap guard (single-device v1 — documented client-#2 prerequisite), no folder-tree derivation (UI concern, PR 8), no `.manifest.lock` fallback (spec §4.4 tier list).

---

### Task 1: manifest data model, gzip codec, mutations

**Files:**
- Modify: `core/Cargo.toml` (add serde, serde_json, flate2)
- Create: `core/src/manifest.rs`
- Modify: `core/src/lib.rs` (add `pub mod manifest;`)

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Task 2, PR 6, PR 8+):

```rust
pub const MANIFEST_KEY: &str = ".bare-bucket/manifest.json.gz";
pub const RESERVED_PREFIX: &str = ".bare-bucket/";
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestObject {
    pub key: String,
    pub size: u64,
    pub etag: String,
    pub last_modified: String,
    pub content_type: String,
    #[serde(default)] pub favorite: bool,
    #[serde(default)] pub thumbnail_key: Option<String>,
    #[serde(default)] pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub last_full_rebuild_at: Option<String>,
    pub last_writer_device_id: String,
    pub objects: Vec<ManifestObject>,
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("corrupt manifest: {0}")] Corrupt(String),
    #[error("manifest schema {found} is newer than supported {supported}")]
    FutureSchema { found: u32, supported: u32 },
    #[error(transparent)] S3(#[from] crate::s3::S3Error),
    #[error("conflict retries exhausted after {attempts} attempts")]
    RetriesExhausted { attempts: u32 },
}

impl Manifest {
    pub fn empty() -> Self;
    pub fn to_gzipped_json(&self) -> Vec<u8>;
    pub fn from_gzipped_json(bytes: &[u8]) -> Result<Self, ManifestError>;
    pub fn get(&self, key: &str) -> Option<&ManifestObject>;
    pub fn upsert(&mut self, object: ManifestObject);           // clears any tombstone
    pub fn mark_deleted(&mut self, key: &str, deleted_at: &str) -> bool;
    pub fn set_favorite(&mut self, key: &str, favorite: bool) -> bool;
    pub fn set_thumbnail(&mut self, key: &str, thumbnail_key: Option<String>) -> bool;
    pub fn live_objects(&self) -> impl Iterator<Item = &ManifestObject>; // excludes tombstones
}
pub fn now_iso8601() -> String; // "2026-07-15T10:00:00Z"
```

- [ ] **Step 1: Add dependencies**

In `core/Cargo.toml` `[dependencies]` (alphabetical):

```toml
flate2 = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/manifest.rs` with only the tests module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn object(key: &str) -> ManifestObject {
        ManifestObject {
            key: key.to_string(),
            size: 1024,
            etag: "\"abc\"".to_string(),
            last_modified: "2026-07-14T18:22:00Z".to_string(),
            content_type: "image/jpeg".to_string(),
            favorite: false,
            thumbnail_key: None,
            deleted_at: None,
        }
    }

    #[test]
    fn gzip_json_roundtrip_preserves_manifest() {
        let mut manifest = Manifest::empty();
        manifest.upsert(object("photos/a.jpg"));
        manifest.last_writer_device_id = "web-test".to_string();
        let bytes = manifest.to_gzipped_json();
        assert_eq!(&bytes[..2], &[0x1f, 0x8b], "gzip magic bytes");
        let restored = Manifest::from_gzipped_json(&bytes).unwrap();
        assert_eq!(restored.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(restored.last_writer_device_id, "web-test");
        assert_eq!(restored.objects, manifest.objects);
    }

    #[test]
    fn parses_spec_example_json_fields() {
        // Exact field names from design spec §4.1; favorite/thumbnail_key/
        // deleted_at/unknown fields exercise serde defaults + forward compat.
        let json = r#"{
          "schema_version": 1,
          "last_full_rebuild_at": "2026-07-15T10:00:00Z",
          "last_writer_device_id": "web-a1b2c3",
          "some_future_field": {"ignored": true},
          "objects": [
            {
              "key": "photos/2026/trip/IMG_0142.jpg",
              "size": 4194304,
              "etag": "\"9b2cf535f27731c974343645a3985328\"",
              "last_modified": "2026-07-14T18:22:00Z",
              "content_type": "image/jpeg"
            }
          ]
        }"#;
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, json.as_bytes()).unwrap();
        let gz = encoder.finish().unwrap();

        let manifest = Manifest::from_gzipped_json(&gz).unwrap();
        assert_eq!(manifest.objects.len(), 1);
        let obj = &manifest.objects[0];
        assert_eq!(obj.key, "photos/2026/trip/IMG_0142.jpg");
        assert_eq!(obj.size, 4194304);
        assert!(!obj.favorite);
        assert!(obj.thumbnail_key.is_none());
        assert!(obj.deleted_at.is_none());
    }

    #[test]
    fn future_schema_version_refuses_to_load() {
        let mut manifest = Manifest::empty();
        manifest.schema_version = CURRENT_SCHEMA_VERSION + 1;
        let bytes = manifest.to_gzipped_json();
        let err = Manifest::from_gzipped_json(&bytes).unwrap_err();
        assert!(matches!(
            err,
            ManifestError::FutureSchema { found, supported }
                if found == CURRENT_SCHEMA_VERSION + 1 && supported == CURRENT_SCHEMA_VERSION
        ));
    }

    #[test]
    fn corrupt_bytes_are_a_corrupt_error() {
        assert!(matches!(
            Manifest::from_gzipped_json(b"not gzip at all"),
            Err(ManifestError::Corrupt(_))
        ));
        // valid gzip, invalid JSON
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, b"{{{").unwrap();
        let gz = encoder.finish().unwrap();
        assert!(matches!(
            Manifest::from_gzipped_json(&gz),
            Err(ManifestError::Corrupt(_))
        ));
    }

    #[test]
    fn upsert_inserts_then_updates_by_key() {
        let mut manifest = Manifest::empty();
        manifest.upsert(object("a.txt"));
        assert_eq!(manifest.objects.len(), 1);
        let mut updated = object("a.txt");
        updated.size = 2048;
        manifest.upsert(updated);
        assert_eq!(manifest.objects.len(), 1);
        assert_eq!(manifest.get("a.txt").unwrap().size, 2048);
    }

    #[test]
    fn mark_deleted_sets_tombstone_and_keeps_row() {
        let mut manifest = Manifest::empty();
        manifest.upsert(object("a.txt"));
        assert!(manifest.mark_deleted("a.txt", "2026-07-15T12:00:00Z"));
        assert_eq!(manifest.objects.len(), 1, "tombstone keeps the row");
        assert_eq!(
            manifest.get("a.txt").unwrap().deleted_at.as_deref(),
            Some("2026-07-15T12:00:00Z")
        );
        assert_eq!(manifest.live_objects().count(), 0);
        assert!(!manifest.mark_deleted("missing.txt", "2026-07-15T12:00:00Z"));
    }

    #[test]
    fn upsert_over_tombstone_resurrects() {
        let mut manifest = Manifest::empty();
        manifest.upsert(object("a.txt"));
        manifest.mark_deleted("a.txt", "2026-07-15T12:00:00Z");
        manifest.upsert(object("a.txt"));
        assert!(manifest.get("a.txt").unwrap().deleted_at.is_none());
        assert_eq!(manifest.live_objects().count(), 1);
    }

    #[test]
    fn favorite_and_thumbnail_setters_return_hit() {
        let mut manifest = Manifest::empty();
        manifest.upsert(object("a.txt"));
        assert!(manifest.set_favorite("a.txt", true));
        assert!(manifest.get("a.txt").unwrap().favorite);
        assert!(manifest.set_thumbnail(
            "a.txt",
            Some(".bare-bucket/thumbs/a.txt.webp".to_string())
        ));
        assert_eq!(
            manifest.get("a.txt").unwrap().thumbnail_key.as_deref(),
            Some(".bare-bucket/thumbs/a.txt.webp")
        );
        assert!(!manifest.set_favorite("missing.txt", true));
    }

    #[test]
    fn now_iso8601_is_extended_utc() {
        let ts = now_iso8601();
        assert_eq!(ts.len(), 20, "YYYY-MM-DDTHH:MM:SSZ: {ts}");
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
        assert!(ts.ends_with('Z'));
    }
}
```

Add `pub mod manifest;` to `core/src/lib.rs` (below `pub mod s3;`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p bare-bucket-core manifest`
Expected: compile errors — `Manifest`, `ManifestObject` not found

- [ ] **Step 4: Write the implementation**

Prepend to `core/src/manifest.rs`:

```rust
//! The bucket manifest (design spec §4): a gzipped JSON document at
//! [`MANIFEST_KEY`] that is the source of truth for listings and change
//! detection. Pure data model here; [`ManifestStore`] (below, Task 2) owns
//! the load/save + conflict-retry machinery.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const MANIFEST_KEY: &str = ".bare-bucket/manifest.json.gz";
/// Everything under this prefix is app-internal (manifest, thumbnails) and
/// hidden from the browse UI (spec §3.4).
pub const RESERVED_PREFIX: &str = ".bare-bucket/";
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestObject {
    pub key: String,
    pub size: u64,
    pub etag: String,
    /// ISO8601, stored verbatim from the provider.
    pub last_modified: String,
    pub content_type: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub thumbnail_key: Option<String>,
    /// Tombstone timestamp (spec §4.4). Rows are purged by reconciliation,
    /// never by ordinary deletes.
    #[serde(default)]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub last_full_rebuild_at: Option<String>,
    pub last_writer_device_id: String,
    pub objects: Vec<ManifestObject>,
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("corrupt manifest: {0}")]
    Corrupt(String),
    #[error("manifest schema {found} is newer than supported {supported}")]
    FutureSchema { found: u32, supported: u32 },
    #[error(transparent)]
    S3(#[from] crate::s3::S3Error),
    #[error("conflict retries exhausted after {attempts} attempts")]
    RetriesExhausted { attempts: u32 },
}

impl Manifest {
    pub fn empty() -> Self {
        Manifest {
            schema_version: CURRENT_SCHEMA_VERSION,
            last_full_rebuild_at: None,
            last_writer_device_id: String::new(),
            objects: Vec::new(),
        }
    }

    pub fn to_gzipped_json(&self) -> Vec<u8> {
        let json = serde_json::to_vec(self).expect("manifest serialization cannot fail");
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(&json)
            .and_then(|_| encoder.finish())
            .expect("in-memory gzip cannot fail")
    }

    pub fn from_gzipped_json(bytes: &[u8]) -> Result<Self, ManifestError> {
        let mut decoder = flate2::read::GzDecoder::new(bytes);
        let mut json = Vec::new();
        decoder
            .read_to_end(&mut json)
            .map_err(|e| ManifestError::Corrupt(format!("gzip: {e}")))?;
        let manifest: Manifest = serde_json::from_slice(&json)
            .map_err(|e| ManifestError::Corrupt(format!("json: {e}")))?;
        if manifest.schema_version > CURRENT_SCHEMA_VERSION {
            return Err(ManifestError::FutureSchema {
                found: manifest.schema_version,
                supported: CURRENT_SCHEMA_VERSION,
            });
        }
        Ok(manifest)
    }

    pub fn get(&self, key: &str) -> Option<&ManifestObject> {
        self.objects.iter().find(|o| o.key == key)
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut ManifestObject> {
        self.objects.iter_mut().find(|o| o.key == key)
    }

    /// Insert or replace by key. Replacing clears any tombstone (a re-upload
    /// after delete resurrects the row with fresh metadata).
    pub fn upsert(&mut self, object: ManifestObject) {
        match self.get_mut(&object.key) {
            Some(existing) => *existing = object,
            None => self.objects.push(object),
        }
    }

    /// Tombstone a key (spec §4.4). Returns false if the key is unknown.
    pub fn mark_deleted(&mut self, key: &str, deleted_at: &str) -> bool {
        match self.get_mut(key) {
            Some(object) => {
                object.deleted_at = Some(deleted_at.to_string());
                true
            }
            None => false,
        }
    }

    pub fn set_favorite(&mut self, key: &str, favorite: bool) -> bool {
        match self.get_mut(key) {
            Some(object) => {
                object.favorite = favorite;
                true
            }
            None => false,
        }
    }

    pub fn set_thumbnail(&mut self, key: &str, thumbnail_key: Option<String>) -> bool {
        match self.get_mut(key) {
            Some(object) => {
                object.thumbnail_key = thumbnail_key;
                true
            }
            None => false,
        }
    }

    /// Objects that are not tombstoned — what the UI shows.
    pub fn live_objects(&self) -> impl Iterator<Item = &ManifestObject> {
        self.objects.iter().filter(|o| o.deleted_at.is_none())
    }
}

/// Current UTC time in extended ISO8601 (`2026-07-15T10:00:00Z`) — the format
/// used inside the manifest document.
pub fn now_iso8601() -> String {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
    );
    time::OffsetDateTime::now_utc()
        .format(&format)
        .expect("static format cannot fail")
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p bare-bucket-core manifest`
Expected: 9 passed, 0 failed

- [ ] **Step 6: fmt + clippy (both targets), full suite, WASM build, commit**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace && wasm-pack build core --target web`
Expected: clean (validates serde/flate2 on wasm32)

```bash
git add core/Cargo.toml core/src/lib.rs core/src/manifest.rs Cargo.lock
git commit -m "feat: add manifest data model with gzip codec and tombstones"
```

---

### Task 2: ManifestStore — load/save/bootstrap + conditional-write retry loop

**Files:**
- Modify: `core/src/manifest.rs`
- Create: `core/tests/manifest_store.rs` (wiremock tests)

**Interfaces:**
- Consumes: `s3::{S3Client, S3Error, GetResult}`, Task 1 model.
- Produces (used by PR 6 reconciliation, PR 10+ UI flows):

```rust
pub struct LoadedManifest { pub manifest: Manifest, pub etag: Option<String> } // etag None = no manifest object yet
pub struct SaveOutcome { pub etag: String, pub attempts: u32, pub conditional: bool }

pub struct ManifestStore<'a> { /* client: &'a S3Client, device_id: String */ }
impl<'a> ManifestStore<'a> {
    pub fn new(client: &'a S3Client, device_id: impl Into<String>) -> Self;
    pub async fn load(&self) -> Result<LoadedManifest, ManifestError>; // NotFound → empty manifest, etag None
    pub async fn save(&self, manifest: &mut Manifest, if_match: Option<&str>) -> Result<SaveOutcome, ManifestError>; // stamps last_writer_device_id
    pub async fn update_with_retry(&self, mutate: impl FnMut(&mut Manifest)) -> Result<SaveOutcome, ManifestError>;
}
pub const MANIFEST_CONTENT_TYPE: &str = "application/gzip";
const MAX_CONFLICT_RETRIES: u32 = 5;
```

`update_with_retry` semantics (spec §4.2):
1. `load()` → apply `mutate` → `save(..., if_match = loaded etag)`; a fresh (etag-None) manifest saves unconditionally.
2. On `S3Error::PreconditionFailed`: re-`load()`, re-apply `mutate`, retry — up to `MAX_CONFLICT_RETRIES` total save attempts, then `ManifestError::RetriesExhausted`.
3. On `S3Error::Unsupported` (provider rejects If-Match with 501): retry the same save once WITHOUT `if_match`; the returned `SaveOutcome.conditional` is `false` so callers can surface the degraded guarantee.
4. Any other `S3Error` propagates immediately.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/manifest_store.rs`:

```rust
//! HTTP-level tests of ManifestStore against wiremock: bootstrap, conditional
//! save, the 412 retry loop, and the 501 last-writer-wins fallback.

use bare_bucket_core::manifest::{
    Manifest, ManifestError, ManifestObject, ManifestStore, MANIFEST_KEY,
};
use bare_bucket_core::s3::{S3Client, S3Config};
use bare_bucket_core::signer::Credentials;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const MANIFEST_PATH: &str = "/test-bucket/.bare-bucket/manifest.json.gz";

fn client_for(server: &MockServer) -> S3Client {
    S3Client::new(S3Config {
        endpoint: server.uri(),
        region: "us-east-1".to_string(),
        bucket: "test-bucket".to_string(),
        path_style: true,
        credentials: Credentials {
            access_key_id: "AKID".to_string(),
            secret_access_key: "SECRET".to_string(),
        },
    })
    .unwrap()
}

fn object(key: &str, size: u64) -> ManifestObject {
    ManifestObject {
        key: key.to_string(),
        size,
        etag: "\"e\"".to_string(),
        last_modified: "2026-07-15T00:00:00Z".to_string(),
        content_type: "text/plain".to_string(),
        favorite: false,
        thumbnail_key: None,
        deleted_at: None,
    }
}

fn gz(manifest: &Manifest) -> Vec<u8> {
    manifest.to_gzipped_json()
}

#[tokio::test]
async fn load_bootstraps_empty_manifest_on_404() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    let loaded = store.load().await.unwrap();
    assert!(loaded.etag.is_none());
    assert!(loaded.manifest.objects.is_empty());
    assert_eq!(
        loaded.manifest.schema_version,
        bare_bucket_core::manifest::CURRENT_SCHEMA_VERSION
    );
}

#[tokio::test]
async fn load_parses_existing_manifest_and_keeps_etag() {
    let server = MockServer::start().await;
    let mut manifest = Manifest::empty();
    manifest.upsert(object("a.txt", 5));
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(gz(&manifest))
                .insert_header("etag", "\"m1\""),
        )
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    let loaded = store.load().await.unwrap();
    assert_eq!(loaded.etag.as_deref(), Some("\"m1\""));
    assert_eq!(loaded.manifest.objects.len(), 1);
}

#[tokio::test]
async fn save_stamps_device_id_and_uses_if_match() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .and(header("if-match", "\"m1\""))
        .and(header("content-type", "application/gzip"))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"m2\""))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    let mut manifest = Manifest::empty();
    let outcome = store.save(&mut manifest, Some("\"m1\"")).await.unwrap();
    assert_eq!(outcome.etag, "\"m2\"");
    assert!(outcome.conditional);
    assert_eq!(manifest.last_writer_device_id, "web-test");
}

#[tokio::test]
async fn update_with_retry_reapplies_mutation_after_412() {
    let server = MockServer::start().await;

    // First load: empty-ish manifest at etag v1.
    let base = Manifest::empty();
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(gz(&base))
                .insert_header("etag", "\"v1\""),
        )
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;

    // First save against v1: conflict.
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .and(header("if-match", "\"v1\""))
        .respond_with(ResponseTemplate::new(412))
        .expect(1)
        .mount(&server)
        .await;

    // Re-fetch: someone else added other.txt; etag now v2.
    let mut concurrent = Manifest::empty();
    concurrent.upsert(object("other.txt", 7));
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(gz(&concurrent))
                .insert_header("etag", "\"v2\""),
        )
        .mount(&server)
        .await;

    // Save against v2 succeeds.
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .and(header("if-match", "\"v2\""))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"v3\""))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    let outcome = store
        .update_with_retry(|m| m.upsert(object("mine.txt", 9)))
        .await
        .unwrap();
    assert_eq!(outcome.etag, "\"v3\"");
    assert_eq!(outcome.attempts, 2);
    assert!(outcome.conditional);

    // The saved body must contain BOTH the concurrent object and ours:
    // verify by decoding what the mock received on the final PUT.
    let requests = server.received_requests().await.unwrap();
    let final_put = requests
        .iter()
        .filter(|r| r.method.as_str() == "PUT")
        .last()
        .unwrap();
    let saved = Manifest::from_gzipped_json(&final_put.body).unwrap();
    assert!(saved.get("other.txt").is_some(), "concurrent change preserved");
    assert!(saved.get("mine.txt").is_some(), "our change applied");
}

#[tokio::test]
async fn update_with_retry_exhausts_after_max_attempts() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(gz(&Manifest::empty()))
                .insert_header("etag", "\"v1\""),
        )
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .respond_with(ResponseTemplate::new(412))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    let err = store
        .update_with_retry(|m| m.upsert(object("mine.txt", 9)))
        .await
        .unwrap_err();
    assert!(matches!(err, ManifestError::RetriesExhausted { attempts: 5 }));
}

#[tokio::test]
async fn update_with_retry_falls_back_on_unsupported_if_match() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(gz(&Manifest::empty()))
                .insert_header("etag", "\"v1\""),
        )
        .mount(&server)
        .await;
    // Conditional PUT rejected as unsupported…
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .and(header("if-match", "\"v1\""))
        .respond_with(ResponseTemplate::new(501))
        .expect(1)
        .mount(&server)
        .await;
    // …unconditional PUT succeeds (no if-match header → separate mock).
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"v2\""))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    let outcome = store
        .update_with_retry(|m| m.upsert(object("mine.txt", 9)))
        .await
        .unwrap();
    assert_eq!(outcome.etag, "\"v2\"");
    assert!(!outcome.conditional, "degraded to last-writer-wins");
}

#[tokio::test]
async fn bootstrap_save_is_unconditional() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"v1\""))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    let outcome = store
        .update_with_retry(|m| m.upsert(object("first.txt", 1)))
        .await
        .unwrap();
    assert_eq!(outcome.etag, "\"v1\"");
    assert_eq!(outcome.attempts, 1);
    // No PUT carried an if-match header.
    let requests = server.received_requests().await.unwrap();
    assert!(requests
        .iter()
        .filter(|r| r.method.as_str() == "PUT")
        .all(|r| !r.headers.contains_key("if-match")));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bare-bucket-core --test manifest_store`
Expected: compile errors — `ManifestStore` not found

- [ ] **Step 3: Write the implementation**

Append to `core/src/manifest.rs` (above the tests module):

```rust
use crate::s3::{S3Client, S3Error};

pub const MANIFEST_CONTENT_TYPE: &str = "application/gzip";
const MAX_CONFLICT_RETRIES: u32 = 5;

pub struct LoadedManifest {
    pub manifest: Manifest,
    /// `None` when the bucket has no manifest object yet (bootstrap).
    pub etag: Option<String>,
}

#[derive(Debug)]
pub struct SaveOutcome {
    pub etag: String,
    pub attempts: u32,
    /// `false` when the provider rejected `If-Match` (501) and the write
    /// degraded to last-writer-wins — callers may surface a warning.
    pub conditional: bool,
}

/// Loads and saves the manifest through the S3 client, implementing the
/// conditional-write conflict loop of spec §4.2.
pub struct ManifestStore<'a> {
    client: &'a S3Client,
    device_id: String,
}

impl<'a> ManifestStore<'a> {
    pub fn new(client: &'a S3Client, device_id: impl Into<String>) -> Self {
        ManifestStore {
            client,
            device_id: device_id.into(),
        }
    }

    /// Fetch and decode the manifest. A missing manifest object is not an
    /// error: it bootstraps as an empty manifest with no ETag (spec §4.3).
    pub async fn load(&self) -> Result<LoadedManifest, ManifestError> {
        match self.client.get_object(MANIFEST_KEY).await {
            Ok(result) => Ok(LoadedManifest {
                manifest: Manifest::from_gzipped_json(&result.bytes)?,
                etag: Some(result.etag),
            }),
            Err(S3Error::NotFound { .. }) => Ok(LoadedManifest {
                manifest: Manifest::empty(),
                etag: None,
            }),
            Err(e) => Err(e.into()),
        }
    }

    /// Serialize and PUT the manifest, stamping this device as the writer.
    pub async fn save(
        &self,
        manifest: &mut Manifest,
        if_match: Option<&str>,
    ) -> Result<SaveOutcome, ManifestError> {
        manifest.last_writer_device_id = self.device_id.clone();
        let body = manifest.to_gzipped_json();
        let result = self
            .client
            .put_object(MANIFEST_KEY, &body, MANIFEST_CONTENT_TYPE, if_match)
            .await?;
        Ok(SaveOutcome {
            etag: result.etag,
            attempts: 1,
            conditional: if_match.is_some(),
        })
    }

    /// Read → mutate → conditional PUT, retrying on conflict (spec §4.2).
    /// The mutator is re-applied to a freshly loaded manifest on every
    /// attempt, so concurrent changes are preserved.
    pub async fn update_with_retry(
        &self,
        mut mutate: impl FnMut(&mut Manifest),
    ) -> Result<SaveOutcome, ManifestError> {
        let mut attempts: u32 = 0;
        loop {
            let mut loaded = self.load().await?;
            mutate(&mut loaded.manifest);
            attempts += 1;
            match self.save(&mut loaded.manifest, loaded.etag.as_deref()).await {
                Ok(mut outcome) => {
                    outcome.attempts = attempts;
                    return Ok(outcome);
                }
                Err(ManifestError::S3(S3Error::PreconditionFailed)) => {
                    if attempts >= MAX_CONFLICT_RETRIES {
                        return Err(ManifestError::RetriesExhausted { attempts });
                    }
                    // loop: re-load, re-apply
                }
                Err(ManifestError::S3(S3Error::Unsupported { .. })) => {
                    // Provider rejects If-Match: degrade to last-writer-wins
                    // (documented limitation, spec §4.2).
                    let mut outcome = self.save(&mut loaded.manifest, None).await?;
                    outcome.attempts = attempts + 1;
                    outcome.conditional = false;
                    return Ok(outcome);
                }
                Err(e) => return Err(e),
            }
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bare-bucket-core --test manifest_store`
Expected: 7 passed, 0 failed

- [ ] **Step 5: fmt + clippy (both targets), full suite, commit**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace`
Expected: clean

```bash
git add core/src/manifest.rs core/tests/manifest_store.rs
git commit -m "feat: add manifest store with conditional-write retry loop"
```

---

### Task 3: live manifest conflict test against MinIO

**Files:**
- Modify: `core/tests/s3_integration.rs`

**Interfaces:** consumes everything above; produces integration confidence that the conflict loop works against a real conditional-write provider.

- [ ] **Step 1: Append the integration test**

Append to `core/tests/s3_integration.rs`:

```rust
#[tokio::test]
async fn manifest_conflict_loop_preserves_concurrent_changes() {
    use bare_bucket_core::manifest::{
        Manifest, ManifestObject, ManifestStore, MANIFEST_KEY,
    };

    let Some(client) = client() else { return };
    // Isolate: remove any manifest left by a previous run.
    let _ = client.delete_object(MANIFEST_KEY).await;

    let object = |key: &str| ManifestObject {
        key: key.to_string(),
        size: 1,
        etag: "\"e\"".to_string(),
        last_modified: "2026-07-15T00:00:00Z".to_string(),
        content_type: "text/plain".to_string(),
        favorite: false,
        thumbnail_key: None,
        deleted_at: None,
    };

    let store_a = ManifestStore::new(&client, "device-a");
    let store_b = ManifestStore::new(&client, "device-b");

    // Bootstrap via A.
    let first = store_a
        .update_with_retry(|m| m.upsert(object("from-a-1.txt")))
        .await
        .expect("bootstrap write");
    assert!(first.attempts >= 1);

    // Simulate a stale writer: B loads now…
    let stale = store_b.load().await.expect("stale load");
    let stale_etag = stale.etag.clone().expect("etag after bootstrap");

    // …A writes again (bumping the ETag)…
    store_a
        .update_with_retry(|m| m.upsert(object("from-a-2.txt")))
        .await
        .expect("second write");

    // …then B's direct conditional save against the stale ETag must 412.
    let mut stale_manifest = stale.manifest;
    stale_manifest.upsert(object("from-b.txt"));
    let err = store_b
        .save(&mut stale_manifest, Some(&stale_etag))
        .await
        .expect_err("stale conditional save must fail");
    assert!(matches!(
        err,
        bare_bucket_core::manifest::ManifestError::S3(
            bare_bucket_core::s3::S3Error::PreconditionFailed
        )
    ));

    // But B's update_with_retry resolves the conflict and preserves A's data.
    let outcome = store_b
        .update_with_retry(|m| m.upsert(object("from-b.txt")))
        .await
        .expect("retry loop");
    assert!(outcome.conditional, "MinIO supports conditional writes");

    let merged = store_b.load().await.expect("final load");
    for key in ["from-a-1.txt", "from-a-2.txt", "from-b.txt"] {
        assert!(merged.manifest.get(key).is_some(), "missing {key}");
    }
    assert_eq!(merged.manifest.last_writer_device_id, "device-b");

    client.delete_object(MANIFEST_KEY).await.expect("cleanup");
}
```

- [ ] **Step 2: Run the live suite**

```bash
docker compose up -d --wait minio && docker compose run --rm createbucket
BARE_BUCKET_IT=1 BARE_BUCKET_IT_ENDPOINT=http://127.0.0.1:9000 \
  BARE_BUCKET_IT_REGION=us-east-1 BARE_BUCKET_IT_BUCKET=bare-bucket-it \
  BARE_BUCKET_IT_ACCESS_KEY=baretest BARE_BUCKET_IT_SECRET_KEY=baretest123 \
  cargo test -p bare-bucket-core --test s3_integration -- --nocapture
```

Expected: 4 passed. If MinIO's 412 does not surface (conditional writes regress), STOP and report DONE_WITH_CONCERNS with the actual output.

- [ ] **Step 3: fmt + clippy (both targets), full suite, commit**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace`
Expected: clean

```bash
git add core/tests/s3_integration.rs
git commit -m "test: add live manifest conflict-loop integration test"
```
