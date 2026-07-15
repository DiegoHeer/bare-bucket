# PR 6: Reconciliation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The reconciliation job (spec §6): a full-bucket LIST rebuild of the manifest that repairs drift caused by out-of-band tools, purges tombstones, deletes orphaned thumbnails, and aborts dangling multipart uploads — callable on demand (Refresh button), on app open, and as the first-connect bootstrap.

**Architecture:** New `core/src/reconcile.rs` plus thumbnail-key helpers in `manifest.rs` (shared with PR 14). Three layers: **pure planning** (`plan_rebuild` — diff the LIST truth against the current manifest, producing the new `objects` Vec and counters; heavily unit-testable), **cleanup actions** (orphan-thumb deletes, dangling-upload aborts with session-exclusion and age threshold), and the **orchestrator** `reconcile()` that runs LIST → plan → cleanups → manifest write via `update_with_retry` (rebuild timestamp computed *outside* the closure per the PR 5 contract), with corrupt-manifest recovery via the `Corrupt.etag` conditional replace.

**Tech Stack:** existing deps only. `time` parses `Initiated` timestamps (RFC3339) for the upload-age threshold.

## Global Constraints

- Commits: Conventional Commits, atomic; trailer: blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work from `/home/diego/Projects/bare-bucket/.claude/worktrees/bare-bucket-design` (branch `worktree-bare-bucket-design`); `source "$HOME/.cargo/env"` in every shell.
- Before every commit: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings` clean.
- Do not push or open a PR.
- **Carried forward from PR 4/5 reviews (binding):**
  - Rebuild constructs the `objects` Vec directly — NEVER `upsert` in a loop (O(n²) at 10k).
  - Tombstone purge via construction (vanished rows simply don't enter the new Vec).
  - `last_full_rebuild_at` timestamp computed ONCE, outside the `update_with_retry` closure; the closure only assigns captured values (pure + idempotent).
  - Corrupt manifest recovery: conditional replace using `ManifestError::Corrupt { etag }`; on 412 during recovery, retry the whole reconcile once, then give up with the error.
  - NEVER abort multipart uploads whose `upload_id` is in the caller's active set; additionally only abort uploads older than the age threshold (via `Initiated`); unparseable `Initiated` → skip (never abort what we can't age). `abort` hitting `NotFound` counts as success (already-gone race).
- Semantics: the LIST is truth. A tombstoned row whose object still exists resurrects (counts as updated); a row (tombstoned or live) whose object vanished is dropped (counts as removed). Drift repair preserves `favorite` and `content_type`; `thumbnail_key` is kept only if the thumb object actually exists.
- New objects discovered by LIST get a content type guessed from the file extension (LIST responses carry none); uploads through the app set the real type (PR 10).
- YAGNI: no incremental/partial reconcile, no progress events from core (the UI wraps the async call), no repair of `favorite` (nothing to repair it from).

---

### Task 1: thumbnail-key helpers + content-type guessing + pure rebuild planner

**Files:**
- Modify: `core/src/manifest.rs` (thumb helpers next to `RESERVED_PREFIX`)
- Create: `core/src/reconcile.rs` (planner + its tests)
- Modify: `core/src/lib.rs` (add `pub mod reconcile;`)

**Interfaces:**
- Consumes: `manifest::{Manifest, ManifestObject}`, `s3::ObjectInfo`.
- Produces (used by Task 2, PR 14):

```rust
// manifest.rs
pub const THUMBS_PREFIX: &str = ".bare-bucket/thumbs/";
pub fn thumbnail_key_for(key: &str) -> String;                    // ".bare-bucket/thumbs/<key>.webp"
pub fn original_key_for_thumbnail(thumb_key: &str) -> Option<String>;

// reconcile.rs
pub fn content_type_for_key(key: &str) -> &'static str;           // extension-based, fallback application/octet-stream
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RebuildCounters { pub added: u32, pub updated: u32, pub removed: u32 }
pub fn plan_rebuild(
    current: &Manifest,
    listed: &[ObjectInfo],               // caller pre-filters out RESERVED_PREFIX keys
    existing_thumb_keys: &std::collections::HashSet<String>,
) -> (Vec<ManifestObject>, RebuildCounters);
```

- [ ] **Step 1: Write the failing tests**

Append to `core/src/manifest.rs` tests module:

```rust
    #[test]
    fn thumbnail_key_mapping_roundtrips() {
        let key = "photos/2026/trip/IMG_0142.jpg";
        let thumb = thumbnail_key_for(key);
        assert_eq!(thumb, ".bare-bucket/thumbs/photos/2026/trip/IMG_0142.jpg.webp");
        assert_eq!(original_key_for_thumbnail(&thumb).as_deref(), Some(key));
        assert!(original_key_for_thumbnail("not-a-thumb-key").is_none());
        assert!(original_key_for_thumbnail(".bare-bucket/thumbs/no-suffix.png").is_none());
    }
```

Create `core/src/reconcile.rs` with only the tests module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{thumbnail_key_for, Manifest, ManifestObject};
    use crate::s3::ObjectInfo;
    use std::collections::HashSet;

    fn listed(key: &str, size: u64, etag: &str) -> ObjectInfo {
        ObjectInfo {
            key: key.to_string(),
            size,
            etag: etag.to_string(),
            last_modified: "2026-07-15T09:00:00.000Z".to_string(),
        }
    }

    fn row(key: &str, size: u64, etag: &str) -> ManifestObject {
        ManifestObject {
            key: key.to_string(),
            size,
            etag: etag.to_string(),
            last_modified: "2026-07-14T00:00:00Z".to_string(),
            content_type: "image/jpeg".to_string(),
            favorite: false,
            thumbnail_key: None,
            deleted_at: None,
        }
    }

    #[test]
    fn guesses_content_types_from_extension() {
        assert_eq!(content_type_for_key("a/b/photo.JPG"), "image/jpeg");
        assert_eq!(content_type_for_key("doc.pdf"), "application/pdf");
        assert_eq!(content_type_for_key("notes.txt"), "text/plain");
        assert_eq!(content_type_for_key("clip.mp4"), "video/mp4");
        assert_eq!(content_type_for_key("archive.tar.gz"), "application/gzip");
        assert_eq!(content_type_for_key("unknown.zzz"), "application/octet-stream");
        assert_eq!(content_type_for_key("no-extension"), "application/octet-stream");
    }

    #[test]
    fn new_objects_are_added_with_guessed_type() {
        let current = Manifest::empty();
        let objects = [listed("new/photo.jpg", 10, "\"e1\"")];
        let (rows, counters) = plan_rebuild(&current, &objects, &HashSet::new());
        assert_eq!(counters, RebuildCounters { added: 1, updated: 0, removed: 0 });
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "new/photo.jpg");
        assert_eq!(rows[0].content_type, "image/jpeg");
        assert!(rows[0].deleted_at.is_none());
    }

    #[test]
    fn unchanged_objects_keep_metadata_and_count_nothing() {
        let mut current = Manifest::empty();
        let mut existing = row("a.jpg", 10, "\"e1\"");
        existing.favorite = true;
        existing.content_type = "image/custom".to_string();
        current.upsert(existing);
        let objects = [listed("a.jpg", 10, "\"e1\"")];
        let (rows, counters) = plan_rebuild(&current, &objects, &HashSet::new());
        assert_eq!(counters, RebuildCounters::default());
        assert!(rows[0].favorite, "favorite preserved");
        assert_eq!(rows[0].content_type, "image/custom");
        assert_eq!(rows[0].last_modified, "2026-07-14T00:00:00Z", "row untouched");
    }

    #[test]
    fn drifted_objects_are_updated_preserving_favorite() {
        let mut current = Manifest::empty();
        let mut existing = row("a.jpg", 10, "\"e1\"");
        existing.favorite = true;
        current.upsert(existing);
        let objects = [listed("a.jpg", 22, "\"e2\"")]; // rclone overwrote it
        let (rows, counters) = plan_rebuild(&current, &objects, &HashSet::new());
        assert_eq!(counters, RebuildCounters { added: 0, updated: 1, removed: 0 });
        assert_eq!(rows[0].size, 22);
        assert_eq!(rows[0].etag, "\"e2\"");
        assert_eq!(rows[0].last_modified, "2026-07-15T09:00:00.000Z");
        assert!(rows[0].favorite, "favorite survives drift repair");
        assert_eq!(rows[0].content_type, "image/jpeg", "known type preserved");
    }

    #[test]
    fn vanished_objects_and_tombstones_are_removed() {
        let mut current = Manifest::empty();
        current.upsert(row("gone.jpg", 10, "\"e1\""));
        current.upsert(row("tombstoned.jpg", 10, "\"e2\""));
        current.mark_deleted("tombstoned.jpg", "2026-07-15T00:00:00Z");
        let (rows, counters) = plan_rebuild(&current, &[], &HashSet::new());
        assert!(rows.is_empty());
        assert_eq!(counters, RebuildCounters { added: 0, updated: 0, removed: 2 });
    }

    #[test]
    fn tombstoned_but_present_object_resurrects_as_update() {
        let mut current = Manifest::empty();
        current.upsert(row("back.jpg", 10, "\"e1\""));
        current.mark_deleted("back.jpg", "2026-07-15T00:00:00Z");
        let objects = [listed("back.jpg", 10, "\"e1\"")];
        let (rows, counters) = plan_rebuild(&current, &objects, &HashSet::new());
        assert_eq!(counters, RebuildCounters { added: 0, updated: 1, removed: 0 });
        assert!(rows[0].deleted_at.is_none(), "LIST is truth: resurrected");
    }

    #[test]
    fn thumbnail_key_kept_only_when_thumb_exists() {
        let mut current = Manifest::empty();
        let mut with_thumb = row("a.jpg", 10, "\"e1\"");
        with_thumb.thumbnail_key = Some(thumbnail_key_for("a.jpg"));
        let mut lost_thumb = row("b.jpg", 10, "\"e1\"");
        lost_thumb.thumbnail_key = Some(thumbnail_key_for("b.jpg"));
        current.upsert(with_thumb);
        current.upsert(lost_thumb);

        let mut thumbs = HashSet::new();
        thumbs.insert(thumbnail_key_for("a.jpg"));

        let objects = [listed("a.jpg", 10, "\"e1\""), listed("b.jpg", 10, "\"e1\"")];
        let (rows, counters) = plan_rebuild(&current, &objects, &thumbs);
        let by_key = |k: &str| rows.iter().find(|r| r.key == k).unwrap();
        assert!(by_key("a.jpg").thumbnail_key.is_some());
        assert!(by_key("b.jpg").thumbnail_key.is_none(), "missing thumb cleared");
        // Clearing a dangling thumbnail ref is drift repair: counts as updated.
        assert_eq!(counters, RebuildCounters { added: 0, updated: 1, removed: 0 });
    }
}
```

Add `pub mod reconcile;` to `core/src/lib.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bare-bucket-core reconcile && cargo test -p bare-bucket-core manifest::tests::thumbnail_key_mapping`
Expected: compile errors

- [ ] **Step 3: Write the implementation**

Append to `core/src/manifest.rs` (near the consts):

```rust
/// Prefix for cached thumbnail objects (spec §9).
pub const THUMBS_PREFIX: &str = ".bare-bucket/thumbs/";

/// Bucket key of the thumbnail for `key` — mirrors the object tree.
pub fn thumbnail_key_for(key: &str) -> String {
    format!("{THUMBS_PREFIX}{key}.webp")
}

/// Inverse of [`thumbnail_key_for`]; `None` for keys outside the thumbs tree.
pub fn original_key_for_thumbnail(thumb_key: &str) -> Option<String> {
    thumb_key
        .strip_prefix(THUMBS_PREFIX)?
        .strip_suffix(".webp")
        .map(str::to_string)
}
```

Prepend to `core/src/reconcile.rs`:

```rust
//! Bucket reconciliation (spec §6): rebuild the manifest from a full LIST,
//! repair out-of-band drift, purge tombstones, clean orphaned thumbnails
//! and dangling multipart uploads.

use crate::manifest::{Manifest, ManifestObject};
use crate::s3::ObjectInfo;
use std::collections::{HashMap, HashSet};

/// Extension-based content-type guess for objects created outside the app
/// (LIST responses carry no content type). Uploads through the app store
/// the browser-provided type instead.
pub fn content_type_for_key(key: &str) -> &'static str {
    let extension = key.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "csv" => "text/csv",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "7z" => "application/x-7z-compressed",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RebuildCounters {
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
}

/// Diff the bucket truth (`listed`, pre-filtered to exclude the reserved
/// prefix) against the current manifest. Returns the replacement `objects`
/// Vec (built directly — no per-row upsert) and change counters.
///
/// Rules (spec §6): LIST is truth. Rows for vanished objects (tombstoned or
/// not) are dropped. Present objects keep `favorite`/`content_type` from the
/// old row; `thumbnail_key` survives only if the thumb object exists. A row
/// is "updated" when drift was repaired (etag/size change, tombstone
/// resurrection, or a dangling thumbnail reference cleared).
pub fn plan_rebuild(
    current: &Manifest,
    listed: &[ObjectInfo],
    existing_thumb_keys: &HashSet<String>,
) -> (Vec<ManifestObject>, RebuildCounters) {
    let old_by_key: HashMap<&str, &ManifestObject> = current
        .objects
        .iter()
        .map(|o| (o.key.as_str(), o))
        .collect();
    let listed_keys: HashSet<&str> = listed.iter().map(|o| o.key.as_str()).collect();

    let mut counters = RebuildCounters::default();
    let mut rows = Vec::with_capacity(listed.len());

    for info in listed {
        match old_by_key.get(info.key.as_str()) {
            None => {
                counters.added += 1;
                rows.push(ManifestObject {
                    key: info.key.clone(),
                    size: info.size,
                    etag: info.etag.clone(),
                    last_modified: info.last_modified.clone(),
                    content_type: content_type_for_key(&info.key).to_string(),
                    favorite: false,
                    thumbnail_key: None,
                    deleted_at: None,
                });
            }
            Some(old) => {
                let thumbnail_key = old
                    .thumbnail_key
                    .clone()
                    .filter(|t| existing_thumb_keys.contains(t));
                let thumb_cleared = thumbnail_key.is_none() && old.thumbnail_key.is_some();
                let drifted = old.etag != info.etag
                    || old.size != info.size
                    || old.deleted_at.is_some();
                if drifted || thumb_cleared {
                    counters.updated += 1;
                    rows.push(ManifestObject {
                        key: info.key.clone(),
                        size: info.size,
                        etag: info.etag.clone(),
                        last_modified: if drifted {
                            info.last_modified.clone()
                        } else {
                            old.last_modified.clone()
                        },
                        content_type: old.content_type.clone(),
                        favorite: old.favorite,
                        thumbnail_key,
                        deleted_at: None,
                    });
                } else {
                    rows.push((*old).clone());
                }
            }
        }
    }

    counters.removed = current
        .objects
        .iter()
        .filter(|o| !listed_keys.contains(o.key.as_str()))
        .count() as u32;

    (rows, counters)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bare-bucket-core reconcile && cargo test -p bare-bucket-core thumbnail_key_mapping`
Expected: 7 reconcile + 1 manifest test passing

- [ ] **Step 5: fmt + clippy (both targets), full suite, commit**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace`
Expected: clean

```bash
git add core/src/manifest.rs core/src/reconcile.rs core/src/lib.rs
git commit -m "feat: add rebuild planner with drift repair and thumb mapping"
```

---

### Task 2: reconcile orchestrator (cleanups + manifest write + corrupt recovery)

**Files:**
- Modify: `core/src/reconcile.rs`
- Create: `core/tests/reconcile.rs` (wiremock)

**Interfaces:**
- Consumes: Task 1, `s3::{S3Client, S3Error, MultipartUploadInfo}`, `manifest::{ManifestStore, ManifestError, MANIFEST_KEY, RESERVED_PREFIX, THUMBS_PREFIX, now_iso8601}`.
- Produces (used by PR 7's wasm-api and the UI Refresh action):

```rust
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReconcileReport {
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub thumbnails_deleted: u32,
    pub uploads_aborted: u32,
    /// false when the manifest write degraded to last-writer-wins (501).
    pub conditional: bool,
}

pub struct ReconcileOptions<'a> {
    /// Upload IDs this session knows are in flight — never aborted.
    pub active_upload_ids: &'a [String],
    /// Only abort uploads whose Initiated timestamp is older than this.
    /// Unparseable timestamps are never aborted.
    pub min_upload_age_secs: u64,
}
impl Default for ReconcileOptions<'static> { /* &[], 3600 */ }

pub async fn reconcile(
    client: &S3Client,
    device_id: &str,
    options: &ReconcileOptions<'_>,
) -> Result<ReconcileReport, ManifestError>;
```

Orchestration order (each step's failures propagate; cleanups run before the manifest write so the written manifest reflects post-cleanup reality):
1. `list_all(None)` → partition into data objects (not under `RESERVED_PREFIX`), thumb keys (under `THUMBS_PREFIX`), and ignore the manifest object itself + anything else reserved.
2. Load the manifest via `ManifestStore::load()`. On `ManifestError::Corrupt { etag, .. }`: remember the etag, treat as empty manifest, and set a `corrupt_recovery` flag.
3. `plan_rebuild(...)`.
4. Orphaned thumbnails: thumb keys whose `original_key_for_thumbnail` is missing from the data-key set (or unparseable) → `delete_object` each; count. `NotFound` tolerated.
5. Dangling uploads: `list_multipart_uploads()` → skip entries whose `upload_id` ∈ `active_upload_ids`; skip entries younger than `min_upload_age_secs` (parse `Initiated` as RFC3339; unparseable → skip); also skip uploads for keys under `RESERVED_PREFIX`? No — reserved-prefix uploads are equally dangling; abort them too. `abort_multipart_upload` each; `NotFound` counts as aborted (already gone).
6. Manifest write:
   - Normal path: compute `rebuild_time = now_iso8601()` BEFORE the closure; `store.update_with_retry(|m| { m.objects = rows.clone(); m.last_full_rebuild_at = Some(rebuild_time.clone()); })`.
   - Corrupt-recovery path: construct a fresh `Manifest` with the rows + rebuild time and `store.save(&mut fresh, corrupt_etag.as_deref())`. On `PreconditionFailed`: retry the ENTIRE reconcile once (recursion depth 1 via an internal helper with a `retry_on_conflict: bool` parameter); if it conflicts again, propagate.
7. Report: counters + thumbnails_deleted + uploads_aborted + `conditional` from the save outcome.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/reconcile.rs`:

```rust
//! Wiremock tests of the reconcile orchestrator: partitioning, cleanups,
//! manifest write, and corrupt-manifest recovery.

use bare_bucket_core::manifest::{thumbnail_key_for, Manifest, ManifestObject, MANIFEST_KEY};
use bare_bucket_core::reconcile::{reconcile, ReconcileOptions, ReconcileReport};
use bare_bucket_core::s3::{S3Client, S3Config};
use bare_bucket_core::signer::Credentials;
use wiremock::matchers::{method, path, query_param};
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

fn list_xml(entries: &[(&str, u64, &str)]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>"#,
    );
    for (key, size, etag) in entries {
        xml.push_str(&format!(
            "<Contents><Key>{key}</Key><Size>{size}</Size><ETag>{etag}</ETag>\
             <LastModified>2026-07-15T09:00:00.000Z</LastModified></Contents>"
        ));
    }
    xml.push_str("</ListBucketResult>");
    xml
}

fn empty_uploads_xml() -> &'static str {
    r#"<?xml version="1.0"?><ListMultipartUploadsResult></ListMultipartUploadsResult>"#
}

/// Standard mocks: LIST (objects), uploads listing, manifest GET(404)/PUT.
async fn mount_defaults(server: &MockServer, objects_xml: String, uploads_xml: String) {
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("list-type", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_string(objects_xml))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("uploads", ""))
        .respond_with(ResponseTemplate::new(200).set_body_string(uploads_xml))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(ResponseTemplate::new(404))
        .mount(server)
        .await;
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"m1\""))
        .mount(server)
        .await;
}

#[tokio::test]
async fn bootstrap_reconcile_builds_manifest_from_list() {
    let server = MockServer::start().await;
    mount_defaults(
        &server,
        list_xml(&[
            ("photos/a.jpg", 10, "\"e1\""),
            (".bare-bucket/manifest.json.gz", 999, "\"self\""), // must be ignored
        ]),
        empty_uploads_xml().to_string(),
    )
    .await;

    let client = client_for(&server);
    let report = reconcile(&client, "web-test", &ReconcileOptions::default())
        .await
        .unwrap();
    assert_eq!(
        report,
        ReconcileReport {
            added: 1,
            updated: 0,
            removed: 0,
            thumbnails_deleted: 0,
            uploads_aborted: 0,
            conditional: false, // bootstrap: no prior etag
        }
    );

    // Decode the PUT body: exactly one object, correct content type,
    // last_full_rebuild_at stamped.
    let requests = server.received_requests().await.unwrap();
    let put = requests.iter().rfind(|r| r.method.as_str() == "PUT").unwrap();
    let saved = Manifest::from_gzipped_json(&put.body).unwrap();
    assert_eq!(saved.objects.len(), 1);
    assert_eq!(saved.objects[0].key, "photos/a.jpg");
    assert_eq!(saved.objects[0].content_type, "image/jpeg");
    assert!(saved.last_full_rebuild_at.is_some());
    assert_eq!(saved.last_writer_device_id, "web-test");
}

#[tokio::test]
async fn orphaned_thumbnails_are_deleted() {
    let server = MockServer::start().await;
    let orphan_thumb = thumbnail_key_for("gone.jpg");
    let live_thumb = thumbnail_key_for("photos/a.jpg");
    mount_defaults(
        &server,
        list_xml(&[
            ("photos/a.jpg", 10, "\"e1\""),
            (&live_thumb, 1, "\"t1\""),
            (&orphan_thumb, 1, "\"t2\""),
        ]),
        empty_uploads_xml().to_string(),
    )
    .await;
    let delete_path = format!("/test-bucket/{}", orphan_thumb.replace(' ', "%20"));
    Mock::given(method("DELETE"))
        .and(path(delete_path.as_str()))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&server);
    let report = reconcile(&client, "web-test", &ReconcileOptions::default())
        .await
        .unwrap();
    assert_eq!(report.thumbnails_deleted, 1);
    assert_eq!(report.added, 1, "thumb objects are not manifest rows");
}

#[tokio::test]
async fn dangling_uploads_aborted_with_exclusions() {
    let server = MockServer::start().await;
    let uploads = r#"<?xml version="1.0"?><ListMultipartUploadsResult>
      <Upload><Key>old.bin</Key><UploadId>old-1</UploadId><Initiated>2020-01-01T00:00:00.000Z</Initiated></Upload>
      <Upload><Key>mine.bin</Key><UploadId>active-1</UploadId><Initiated>2020-01-01T00:00:00.000Z</Initiated></Upload>
      <Upload><Key>fresh.bin</Key><UploadId>fresh-1</UploadId><Initiated>2999-01-01T00:00:00.000Z</Initiated></Upload>
      <Upload><Key>weird.bin</Key><UploadId>weird-1</UploadId><Initiated>not-a-date</Initiated></Upload>
    </ListMultipartUploadsResult>"#;
    mount_defaults(&server, list_xml(&[]), uploads.to_string()).await;
    Mock::given(method("DELETE"))
        .and(path("/test-bucket/old.bin"))
        .and(query_param("uploadId", "old-1"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&server);
    let active = vec!["active-1".to_string()];
    let report = reconcile(
        &client,
        "web-test",
        &ReconcileOptions { active_upload_ids: &active, min_upload_age_secs: 3600 },
    )
    .await
    .unwrap();
    assert_eq!(report.uploads_aborted, 1, "only the old, inactive, parseable one");
}

#[tokio::test]
async fn corrupt_manifest_recovers_with_conditional_replace() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("list-type", "2"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(list_xml(&[("photos/a.jpg", 10, "\"e1\"")])),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("uploads", ""))
        .respond_with(ResponseTemplate::new(200).set_body_string(empty_uploads_xml()))
        .mount(&server)
        .await;
    // Manifest GET returns garbage with an etag.
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(b"garbage".to_vec())
                .insert_header("etag", "\"corrupt-etag\""),
        )
        .mount(&server)
        .await;
    // Recovery PUT must be conditional on the corrupt object's etag.
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .and(wiremock::matchers::header("if-match", "\"corrupt-etag\""))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"m2\""))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&server);
    let report = reconcile(&client, "web-test", &ReconcileOptions::default())
        .await
        .unwrap();
    assert_eq!(report.added, 1);
    assert!(report.conditional, "recovery replaced exactly the observed bytes");
}

#[tokio::test]
async fn existing_manifest_write_is_conditional() {
    let server = MockServer::start().await;
    let mut existing = Manifest::empty();
    existing.upsert(ManifestObject {
        key: "photos/a.jpg".to_string(),
        size: 10,
        etag: "\"e1\"".to_string(),
        last_modified: "2026-07-15T09:00:00.000Z".to_string(),
        content_type: "image/jpeg".to_string(),
        favorite: false,
        thumbnail_key: None,
        deleted_at: None,
    });
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("list-type", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_string(list_xml(&[
            ("photos/a.jpg", 10, "\"e1\""),
            ("photos/new.png", 5, "\"e9\""),
        ])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("uploads", ""))
        .respond_with(ResponseTemplate::new(200).set_body_string(empty_uploads_xml()))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(existing.to_gzipped_json())
                .insert_header("etag", "\"m1\""),
        )
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .and(wiremock::matchers::header("if-match", "\"m1\""))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"m2\""))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&server);
    let report = reconcile(&client, "web-test", &ReconcileOptions::default())
        .await
        .unwrap();
    assert_eq!(report.added, 1);
    assert!(report.conditional);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bare-bucket-core --test reconcile`
Expected: compile errors — `reconcile`, `ReconcileOptions` not found

- [ ] **Step 3: Write the implementation**

Add to `core/src/reconcile.rs` (above the tests module):

```rust
use crate::manifest::{
    now_iso8601, original_key_for_thumbnail, ManifestError, ManifestStore, MANIFEST_KEY,
    RESERVED_PREFIX, THUMBS_PREFIX,
};
use crate::s3::{S3Client, S3Error};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReconcileReport {
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub thumbnails_deleted: u32,
    pub uploads_aborted: u32,
    /// `false` when the manifest write was unconditional (bootstrap or 501
    /// last-writer-wins degradation).
    pub conditional: bool,
}

pub struct ReconcileOptions<'a> {
    /// Upload IDs this session knows are in flight — never aborted.
    pub active_upload_ids: &'a [String],
    /// Only abort uploads whose `Initiated` timestamp is at least this old.
    /// Unparseable timestamps are never aborted.
    pub min_upload_age_secs: u64,
}

impl Default for ReconcileOptions<'static> {
    fn default() -> Self {
        ReconcileOptions {
            active_upload_ids: &[],
            min_upload_age_secs: 3600,
        }
    }
}

/// Full-bucket reconciliation (spec §6). Self-heals drift caused by tools
/// that bypass the app (rclone, provider consoles), purges tombstones,
/// removes orphaned thumbnails, and aborts dangling multipart uploads.
pub async fn reconcile(
    client: &S3Client,
    device_id: &str,
    options: &ReconcileOptions<'_>,
) -> Result<ReconcileReport, ManifestError> {
    reconcile_inner(client, device_id, options, true).await
}

async fn reconcile_inner(
    client: &S3Client,
    device_id: &str,
    options: &ReconcileOptions<'_>,
    retry_on_recovery_conflict: bool,
) -> Result<ReconcileReport, ManifestError> {
    // 1. The bucket truth.
    let all = client.list_all(None).await.map_err(ManifestError::from)?;
    let mut data_objects = Vec::new();
    let mut thumb_keys = std::collections::HashSet::new();
    for info in all {
        if info.key.starts_with(THUMBS_PREFIX) {
            thumb_keys.insert(info.key.clone());
        } else if info.key.starts_with(RESERVED_PREFIX) {
            // manifest + other app-internal objects: never manifest rows
        } else {
            data_objects.push(info);
        }
    }

    // 2. Current manifest (corrupt → rebuild from scratch, remember etag).
    let store = ManifestStore::new(client, device_id);
    let mut corrupt_etag: Option<String> = None;
    let (current, current_etag) = match store.load().await {
        Ok(loaded) => (loaded.manifest, loaded.etag),
        Err(ManifestError::Corrupt { etag, .. }) => {
            corrupt_etag = etag.clone();
            (Manifest::empty(), etag)
        }
        Err(e) => return Err(e),
    };

    // 3. Plan the rebuild.
    let (rows, counters) = plan_rebuild(&current, &data_objects, &thumb_keys);

    // 4. Orphaned thumbnails.
    let data_keys: std::collections::HashSet<&str> =
        data_objects.iter().map(|o| o.key.as_str()).collect();
    let mut thumbnails_deleted = 0u32;
    for thumb in &thumb_keys {
        let orphaned = match original_key_for_thumbnail(thumb) {
            Some(original) => !data_keys.contains(original.as_str()),
            None => true, // unparseable name inside the thumbs tree
        };
        if orphaned {
            match client.delete_object(thumb).await {
                Ok(()) | Err(S3Error::NotFound { .. }) => thumbnails_deleted += 1,
                Err(e) => return Err(e.into()),
            }
        }
    }

    // 5. Dangling multipart uploads.
    let mut uploads_aborted = 0u32;
    let now = time::OffsetDateTime::now_utc();
    for upload in client.list_multipart_uploads().await.map_err(ManifestError::from)? {
        if options.active_upload_ids.contains(&upload.upload_id) {
            continue;
        }
        let old_enough = time::OffsetDateTime::parse(
            &upload.initiated,
            &time::format_description::well_known::Rfc3339,
        )
        .map(|initiated| (now - initiated).whole_seconds() >= options.min_upload_age_secs as i64)
        .unwrap_or(false); // never abort what we cannot age
        if !old_enough {
            continue;
        }
        match client.abort_multipart_upload(&upload.key, &upload.upload_id).await {
            Ok(()) | Err(S3Error::NotFound { .. }) => uploads_aborted += 1,
            Err(e) => return Err(e.into()),
        }
    }

    // 6. Write the manifest. Timestamp computed OUTSIDE the mutator closure
    // (update_with_retry may run it multiple times).
    let rebuild_time = now_iso8601();
    let outcome = if corrupt_etag.is_some() {
        // Recovery: replace exactly the corrupt bytes we observed.
        let mut fresh = Manifest::empty();
        fresh.objects = rows.clone();
        fresh.last_full_rebuild_at = Some(rebuild_time.clone());
        match store.save(&mut fresh, current_etag.as_deref()).await {
            Ok(outcome) => outcome,
            Err(ManifestError::S3(S3Error::PreconditionFailed)) if retry_on_recovery_conflict => {
                // Someone rewrote the manifest mid-recovery; it is probably
                // valid now — rerun the whole reconcile once.
                return Box::pin(reconcile_inner(client, device_id, options, false)).await;
            }
            Err(e) => return Err(e),
        }
    } else {
        store
            .update_with_retry(|m| {
                m.objects = rows.clone();
                m.last_full_rebuild_at = Some(rebuild_time.clone());
            })
            .await?
    };

    Ok(ReconcileReport {
        added: counters.added,
        updated: counters.updated,
        removed: counters.removed,
        thumbnails_deleted,
        uploads_aborted,
        conditional: outcome.conditional,
    })
}
```

(`MANIFEST_KEY` is not needed by this partition — drop it from reconcile.rs's imports if unused.)

Note on `update_with_retry` bootstrap: when there is no manifest object (`load()` → etag None), `update_with_retry` saves unconditionally, so `conditional` is `false` for bootstrap — the first test asserts exactly that.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bare-bucket-core --test reconcile && cargo test --workspace`
Expected: 5 reconcile wiremock tests + full suite green

- [ ] **Step 5: fmt + clippy (both targets), commit**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings`
Expected: clean

```bash
git add core/src/reconcile.rs core/tests/reconcile.rs
git commit -m "feat: add reconcile orchestrator with cleanup and recovery"
```

---

### Task 3: live reconciliation integration test

**Files:**
- Modify: `core/tests/s3_integration.rs`

- [ ] **Step 1: Append the integration test**

```rust
#[tokio::test]
async fn reconcile_heals_out_of_band_changes() {
    use bare_bucket_core::manifest::{thumbnail_key_for, ManifestStore, MANIFEST_KEY};
    use bare_bucket_core::reconcile::{reconcile, ReconcileOptions};

    let Some(client) = client() else { return };
    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let prefix = format!("it/{run}/reconcile/");
    let _ = client.delete_object(MANIFEST_KEY).await;

    // Out-of-band state: two data objects, one live thumb, one orphan thumb,
    // one dangling multipart upload (old enough via min_upload_age_secs: 0).
    let key_a = format!("{prefix}a.txt");
    let key_b = format!("{prefix}b.jpg");
    client.put_object(&key_a, b"aaa", "text/plain", None).await.expect("seed a");
    client.put_object(&key_b, b"bbb", "image/jpeg", None).await.expect("seed b");
    let live_thumb = thumbnail_key_for(&key_b);
    let orphan_thumb = thumbnail_key_for(&format!("{prefix}vanished.jpg"));
    client.put_object(&live_thumb, b"t", "image/webp", None).await.expect("live thumb");
    client.put_object(&orphan_thumb, b"t", "image/webp", None).await.expect("orphan thumb");
    let dangling = client
        .create_multipart_upload(&format!("{prefix}dangling.bin"), "application/octet-stream")
        .await
        .expect("dangling upload");

    let report = reconcile(
        &client,
        "device-it",
        &ReconcileOptions { active_upload_ids: &[], min_upload_age_secs: 0 },
    )
    .await
    .expect("reconcile");

    assert_eq!(report.added, 2, "both data objects discovered");
    assert_eq!(report.thumbnails_deleted, 1, "orphan thumb removed");
    assert!(report.uploads_aborted >= 1, "dangling upload aborted");

    // Manifest reflects the bucket; live thumb key was NOT attached (no row
    // had it) but the thumb object survives for PR 14 to pick up.
    let store = ManifestStore::new(&client, "device-it");
    let loaded = store.load().await.expect("load");
    assert_eq!(loaded.manifest.live_objects().count(), 2);
    assert!(loaded.manifest.get(&key_a).is_some());
    assert!(loaded.manifest.last_full_rebuild_at.is_some());

    // The dangling upload is really gone.
    let uploads = client.list_multipart_uploads().await.expect("uploads");
    assert!(!uploads.iter().any(|u| u.upload_id == dangling));

    // Cleanup.
    for key in [key_a.as_str(), key_b.as_str(), live_thumb.as_str()] {
        client.delete_object(key).await.expect("cleanup");
    }
    client.delete_object(MANIFEST_KEY).await.expect("cleanup manifest");
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

Expected: 5 passed. Note: this test may collide with leftover objects from other tests' runs under different `it/{run}` prefixes — the manifest counts only what exists; if `added` exceeds 2 because of leftovers, investigate rather than loosening the assertion (prior tests clean up after themselves).

- [ ] **Step 3: fmt + clippy (both targets), full suite, commit**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace`
Expected: clean

```bash
git add core/tests/s3_integration.rs
git commit -m "test: add live reconciliation integration test"
```
