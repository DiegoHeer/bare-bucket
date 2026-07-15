//! Bucket reconciliation (spec §6): rebuild the manifest from a full LIST,
//! repair out-of-band drift, purge tombstones, clean orphaned thumbnails
//! and dangling multipart uploads.

use crate::manifest::{
    now_iso8601, original_key_for_thumbnail, Manifest, ManifestError, ManifestObject,
    ManifestStore, RESERVED_PREFIX, THUMBS_PREFIX,
};
use crate::s3::{ObjectInfo, S3Client, S3Error};
use std::collections::{HashMap, HashSet};

/// Extension-based content-type guess for objects created outside the app
/// (LIST responses carry no content type). Uploads through the app store
/// the browser-provided type instead.
pub fn content_type_for_key(key: &str) -> &'static str {
    let extension = key
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
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
                let drifted =
                    old.etag != info.etag || old.size != info.size || old.deleted_at.is_some();
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
    for upload in client
        .list_multipart_uploads()
        .await
        .map_err(ManifestError::from)?
    {
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
        match client
            .abort_multipart_upload(&upload.key, &upload.upload_id)
            .await
        {
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
        assert_eq!(
            content_type_for_key("unknown.zzz"),
            "application/octet-stream"
        );
        assert_eq!(
            content_type_for_key("no-extension"),
            "application/octet-stream"
        );
    }

    #[test]
    fn new_objects_are_added_with_guessed_type() {
        let current = Manifest::empty();
        let objects = [listed("new/photo.jpg", 10, "\"e1\"")];
        let (rows, counters) = plan_rebuild(&current, &objects, &HashSet::new());
        assert_eq!(
            counters,
            RebuildCounters {
                added: 1,
                updated: 0,
                removed: 0
            }
        );
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
        assert_eq!(
            rows[0].last_modified, "2026-07-14T00:00:00Z",
            "row untouched"
        );
    }

    #[test]
    fn drifted_objects_are_updated_preserving_favorite() {
        let mut current = Manifest::empty();
        let mut existing = row("a.jpg", 10, "\"e1\"");
        existing.favorite = true;
        current.upsert(existing);
        let objects = [listed("a.jpg", 22, "\"e2\"")]; // rclone overwrote it
        let (rows, counters) = plan_rebuild(&current, &objects, &HashSet::new());
        assert_eq!(
            counters,
            RebuildCounters {
                added: 0,
                updated: 1,
                removed: 0
            }
        );
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
        assert_eq!(
            counters,
            RebuildCounters {
                added: 0,
                updated: 0,
                removed: 2
            }
        );
    }

    #[test]
    fn tombstoned_but_present_object_resurrects_as_update() {
        let mut current = Manifest::empty();
        current.upsert(row("back.jpg", 10, "\"e1\""));
        current.mark_deleted("back.jpg", "2026-07-15T00:00:00Z");
        let objects = [listed("back.jpg", 10, "\"e1\"")];
        let (rows, counters) = plan_rebuild(&current, &objects, &HashSet::new());
        assert_eq!(
            counters,
            RebuildCounters {
                added: 0,
                updated: 1,
                removed: 0
            }
        );
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
        assert!(
            by_key("b.jpg").thumbnail_key.is_none(),
            "missing thumb cleared"
        );
        // Clearing a dangling thumbnail ref is drift repair: counts as updated.
        assert_eq!(
            counters,
            RebuildCounters {
                added: 0,
                updated: 1,
                removed: 0
            }
        );
    }
}
