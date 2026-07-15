//! The bucket manifest (design spec §4): a gzipped JSON document at
//! [`MANIFEST_KEY`] that is the source of truth for listings and change
//! detection. Pure data model first; [`ManifestStore`] below owns the
//! load/save and conflict-retry machinery.

use crate::s3::{S3Client, S3Error};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const MANIFEST_KEY: &str = ".bare-bucket/manifest.json.gz";
/// Everything under this prefix is app-internal (manifest, thumbnails) and
/// hidden from the browse UI (spec §3.4).
pub const RESERVED_PREFIX: &str = ".bare-bucket/";
pub const CURRENT_SCHEMA_VERSION: u32 = 1;
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
    #[error("corrupt manifest: {detail}")]
    Corrupt {
        detail: String,
        /// ETag of the corrupt object when known — lets reconciliation
        /// conditionally replace exactly the bytes it observed.
        etag: Option<String>,
    },
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
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
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
            .map_err(|e| ManifestError::Corrupt {
                detail: format!("gzip: {e}"),
                etag: None,
            })?;
        let manifest: Manifest =
            serde_json::from_slice(&json).map_err(|e| ManifestError::Corrupt {
                detail: format!("json: {e}"),
                etag: None,
            })?;
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

    /// Tombstone a live key (spec §4.4): sets `deleted_at` and clears
    /// `thumbnail_key`, preserving the rest of the row [B4, PR 12].
    ///
    /// Found-flag pattern (PR 12 [B2] — deliberately NOT `set_favorite`'s
    /// write-on-miss shape): an absent key or a row that is already
    /// tombstoned is left untouched and this returns `false`, so a caller
    /// driving [`ManifestStore::update_with_retry_if_changed`] can skip a
    /// pointless PUT.
    pub fn mark_deleted(&mut self, key: &str, deleted_at: &str) -> bool {
        match self.get_mut(key) {
            Some(object) if object.deleted_at.is_none() => {
                object.deleted_at = Some(deleted_at.to_string());
                object.thumbnail_key = None;
                true
            }
            _ => false,
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
    let format =
        time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]Z");
    time::OffsetDateTime::now_utc()
        .format(&format)
        .expect("static format cannot fail")
}

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
            Ok(result) => {
                let manifest = Manifest::from_gzipped_json(&result.bytes).map_err(|e| match e {
                    ManifestError::Corrupt { detail, etag: None } => ManifestError::Corrupt {
                        detail,
                        etag: Some(result.etag.clone()),
                    },
                    other => other,
                })?;
                Ok(LoadedManifest {
                    manifest,
                    etag: Some(result.etag),
                })
            }
            Err(S3Error::NotFound { .. }) => Ok(LoadedManifest {
                manifest: Manifest::empty(),
                etag: None,
            }),
            Err(e) => Err(e.into()),
        }
    }

    /// Serialize and PUT the manifest, stamping this device as the writer.
    ///
    /// Note: stamps `last_writer_device_id` on the passed manifest before the
    /// PUT — the in-memory manifest is mutated even if the PUT then fails.
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
    ///
    /// The mutator may run MULTIPLE times (once per attempt, and again after
    /// an ambiguous network failure whose write actually landed). It must be
    /// a pure, idempotent function of the manifest: no external side
    /// effects, and values that vary per call (timestamps via
    /// [`now_iso8601`], generated keys) must be computed ONCE, outside the
    /// closure, and captured.
    pub async fn update_with_retry(
        &self,
        mut mutate: impl FnMut(&mut Manifest),
    ) -> Result<SaveOutcome, ManifestError> {
        let outcome = self
            .update_with_retry_if_changed(|m| {
                mutate(m);
                true
            })
            .await?;
        Ok(outcome.expect("mutator above always reports a change"))
    }

    /// Like [`Self::update_with_retry`], but `mutate` reports whether it
    /// actually changed the manifest (PR 12 [B2] no-change short-circuit).
    /// When the FIRST application finds nothing to change, no PUT happens at
    /// all and this returns `Ok(None)`. On a conflict retry, `mutate` is
    /// re-applied to the freshly loaded manifest as usual; if THAT
    /// application also reports no change (e.g. someone else already made
    /// the same edit), the loop stops there and returns `Ok(None)` rather
    /// than writing a no-op PUT.
    ///
    /// Same purity/idempotency contract as `update_with_retry`: `mutate` may
    /// run multiple times and must be a pure function of the loaded
    /// manifest plus values captured before the call (timestamps, generated
    /// keys) — never computed inside the closure.
    pub async fn update_with_retry_if_changed(
        &self,
        mut mutate: impl FnMut(&mut Manifest) -> bool,
    ) -> Result<Option<SaveOutcome>, ManifestError> {
        let mut attempts: u32 = 0;
        loop {
            let mut loaded = self.load().await?;
            if !mutate(&mut loaded.manifest) {
                return Ok(None);
            }
            attempts += 1;
            match self
                .save(&mut loaded.manifest, loaded.etag.as_deref())
                .await
            {
                Ok(mut outcome) => {
                    outcome.attempts = attempts;
                    return Ok(Some(outcome));
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
                    return Ok(Some(outcome));
                }
                Err(e) => return Err(e),
            }
        }
    }
}

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
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
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
            Err(ManifestError::Corrupt { .. })
        ));
        // valid gzip, invalid JSON
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, b"{{{").unwrap();
        let gz = encoder.finish().unwrap();
        assert!(matches!(
            Manifest::from_gzipped_json(&gz),
            Err(ManifestError::Corrupt { .. })
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
    }

    #[test]
    fn mark_deleted_on_absent_key_reports_no_change() {
        let mut manifest = Manifest::empty();
        manifest.upsert(object("a.txt"));
        assert!(!manifest.mark_deleted("missing.txt", "2026-07-15T12:00:00Z"));
        assert!(manifest.get("missing.txt").is_none());
    }

    #[test]
    fn mark_deleted_on_already_tombstoned_row_reports_no_change() {
        let mut manifest = Manifest::empty();
        manifest.upsert(object("a.txt"));
        assert!(manifest.mark_deleted("a.txt", "2026-07-15T12:00:00Z"));
        // Found-flag pattern [B2]: re-tombstoning an already-deleted row is a
        // no-op that reports false, and must not stomp the original timestamp.
        assert!(!manifest.mark_deleted("a.txt", "2026-07-15T13:00:00Z"));
        assert_eq!(
            manifest.get("a.txt").unwrap().deleted_at.as_deref(),
            Some("2026-07-15T12:00:00Z"),
            "original tombstone timestamp is preserved"
        );
    }

    #[test]
    fn mark_deleted_clears_thumbnail_key_and_preserves_the_rest_of_the_row() {
        let mut manifest = Manifest::empty();
        let mut with_thumb = object("a.txt");
        with_thumb.favorite = true;
        with_thumb.thumbnail_key = Some(".bare-bucket/thumbs/a.txt.webp".to_string());
        manifest.upsert(with_thumb);

        assert!(manifest.mark_deleted("a.txt", "2026-07-15T12:00:00Z"));
        let row = manifest.get("a.txt").unwrap();
        assert!(row.thumbnail_key.is_none(), "thumbnail_key cleared [B4]");
        assert!(row.favorite, "favorite preserved [B4]");
        assert_eq!(row.size, 1024, "unrelated fields preserved [B4]");
        assert_eq!(row.deleted_at.as_deref(), Some("2026-07-15T12:00:00Z"));
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
        assert!(manifest.set_thumbnail("a.txt", Some(".bare-bucket/thumbs/a.txt.webp".to_string())));
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

    #[test]
    fn thumbnail_key_mapping_roundtrips() {
        let key = "photos/2026/trip/IMG_0142.jpg";
        let thumb = thumbnail_key_for(key);
        assert_eq!(
            thumb,
            ".bare-bucket/thumbs/photos/2026/trip/IMG_0142.jpg.webp"
        );
        assert_eq!(original_key_for_thumbnail(&thumb).as_deref(), Some(key));
        assert!(original_key_for_thumbnail("not-a-thumb-key").is_none());
        assert!(original_key_for_thumbnail(".bare-bucket/thumbs/no-suffix.png").is_none());
    }
}
