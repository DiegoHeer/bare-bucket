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
    let format =
        time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]Z");
    time::OffsetDateTime::now_utc()
        .format(&format)
        .expect("static format cannot fail")
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
            Err(ManifestError::Corrupt(_))
        ));
        // valid gzip, invalid JSON
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
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
}
