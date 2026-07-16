//! Integration tests against a real S3-compatible provider (MinIO via
//! `docker compose up -d`). Skipped unless BARE_BUCKET_IT=1.
//!
//! Run locally:
//!   docker compose up -d --wait minio && docker compose run --rm createbucket
//!   BARE_BUCKET_IT=1 BARE_BUCKET_IT_ENDPOINT=http://127.0.0.1:9000 \
//!     BARE_BUCKET_IT_REGION=us-east-1 BARE_BUCKET_IT_BUCKET=bare-bucket-it \
//!     BARE_BUCKET_IT_ACCESS_KEY=baretest BARE_BUCKET_IT_SECRET_KEY=baretest123 \
//!     cargo test --test s3_integration

use bare_bucket_core::s3::{S3Client, S3Config, S3Error};
use bare_bucket_core::signer::Credentials;

fn client() -> Option<S3Client> {
    if std::env::var("BARE_BUCKET_IT").as_deref() != Ok("1") {
        eprintln!("skipping: BARE_BUCKET_IT not set");
        return None;
    }
    let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set"));
    Some(
        S3Client::new(S3Config {
            endpoint: env("BARE_BUCKET_IT_ENDPOINT"),
            region: env("BARE_BUCKET_IT_REGION"),
            bucket: env("BARE_BUCKET_IT_BUCKET"),
            path_style: true,
            credentials: Credentials {
                access_key_id: env("BARE_BUCKET_IT_ACCESS_KEY"),
                secret_access_key: env("BARE_BUCKET_IT_SECRET_KEY"),
            },
        })
        .unwrap(),
    )
}

// The whole live suite runs serially: tests share one bucket and one
// manifest object, and reconcile() LISTs the entire bucket — concurrent
// tests' transient objects would corrupt its counters.
#[serial_test::serial]
#[tokio::test]
async fn full_object_lifecycle() {
    let Some(client) = client() else { return };

    client.head_bucket().await.expect("head_bucket");

    // Unique per-run prefix so local reruns never collide with leftovers
    // from a failed run.
    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // PUT (unconditional) — keys exercise encoding: space + unicode
    let key = format!("it/{run}/lifecycle/hello world ü.txt");
    let put = client
        .put_object(&key, b"integration", "text/plain", None)
        .await
        .expect("put");
    assert!(!put.etag.is_empty());

    // GET roundtrip
    let got = client.get_object(&key).await.expect("get");
    assert_eq!(got.bytes, b"integration");
    assert_eq!(got.etag, put.etag);

    // Conditional PUT with the correct ETag succeeds
    let put2 = client
        .put_object(&key, b"integration v2", "text/plain", Some(&put.etag))
        .await
        .expect("conditional put with matching etag");

    // Conditional PUT with a stale ETag must fail (MinIO supports If-Match)
    let err = client
        .put_object(&key, b"lost update", "text/plain", Some(&put.etag))
        .await
        .expect_err("conditional put with stale etag must fail");
    assert!(
        matches!(err, S3Error::PreconditionFailed),
        "expected PreconditionFailed, got: {err:?}"
    );

    // Content reflects the winning write
    let got2 = client.get_object(&key).await.expect("get v2");
    assert_eq!(got2.bytes, b"integration v2");
    assert_eq!(got2.etag, put2.etag);

    // DELETE, then GET maps to NotFound
    client.delete_object(&key).await.expect("delete");
    let err = client.get_object(&key).await.expect_err("get after delete");
    assert!(matches!(err, S3Error::NotFound { .. }));
}

#[serial_test::serial]
#[tokio::test]
async fn list_paginates_across_pages() {
    let Some(client) = client() else { return };

    // Unique per-run prefix so local reruns never collide with leftovers
    // from a failed run.
    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let prefix = format!("it/{run}/list/");
    let prefix = prefix.as_str();
    for i in 0..5 {
        client
            .put_object(&format!("{prefix}obj-{i}.txt"), b"x", "text/plain", None)
            .await
            .expect("seed put");
    }

    // Page size 2 forces 3 pages
    let mut token: Option<String> = None;
    let mut seen = Vec::new();
    loop {
        let page = client
            .list_page(Some(prefix), token.as_deref(), Some(2))
            .await
            .expect("list page");
        seen.extend(page.objects.into_iter().map(|o| o.key));
        if !page.is_truncated {
            break;
        }
        token = page.next_continuation_token;
        assert!(token.is_some(), "truncated page must carry a token");
    }
    assert_eq!(seen.len(), 5);
    assert!(seen.iter().all(|k| k.starts_with(prefix)));

    // list_all sees the same set
    let all = client.list_all(Some(prefix)).await.expect("list_all");
    assert_eq!(all.len(), 5);

    for key in &seen {
        client.delete_object(key).await.expect("cleanup");
    }
}

#[serial_test::serial]
#[tokio::test]
async fn multipart_roundtrip_via_presigned_descriptors() {
    let Some(client) = client() else { return };
    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let key = format!("it/{run}/multipart/big.bin");

    // Two 5 MiB parts (provider minimum for non-final parts) + verify the
    // presigned descriptors work end-to-end the way the browser will use them.
    let part_size = 5 * 1024 * 1024;
    let part1 = vec![0xAAu8; part_size];
    let part2 = vec![0xBBu8; part_size / 2]; // final part may be smaller

    let upload_id = client
        .create_multipart_upload(&key, "application/octet-stream")
        .await
        .expect("create");

    // A dangling upload must be visible to the cleanup listing.
    let dangling = client.list_multipart_uploads().await.expect("list uploads");
    assert!(
        dangling
            .iter()
            .any(|u| u.key == key && u.upload_id == upload_id),
        "in-progress upload should be listed"
    );

    let http = reqwest::Client::new();
    let mut parts: Vec<(u32, String)> = Vec::new();
    for (number, bytes) in [(1u32, &part1), (2u32, &part2)] {
        let descriptor = client.presign_upload_part(&key, &upload_id, number, 3600);
        assert_eq!(descriptor.method, "PUT");
        let response = http
            .put(&descriptor.url)
            .body(bytes.clone())
            .send()
            .await
            .expect("part upload");
        assert!(
            response.status().is_success(),
            "part {number} failed: {} {:?}",
            response.status(),
            response.text().await
        );
        let etag = response
            .headers()
            .get("etag")
            .expect("part etag")
            .to_str()
            .unwrap()
            .to_string();
        parts.push((number, etag));
    }

    let final_etag = client
        .complete_multipart_upload(&key, &upload_id, &parts)
        .await
        .expect("complete");
    assert!(!final_etag.is_empty());

    // Full object roundtrip
    let got = client.get_object(&key).await.expect("get");
    assert_eq!(got.bytes.len(), part_size + part_size / 2);
    assert_eq!(&got.bytes[..part_size], &part1[..]);
    assert_eq!(&got.bytes[part_size..], &part2[..]);

    // Cleanup + abort path: start another upload and abort it
    let abort_id = client
        .create_multipart_upload(&key, "application/octet-stream")
        .await
        .expect("create for abort");
    client
        .abort_multipart_upload(&key, &abort_id)
        .await
        .expect("abort");
    let after = client
        .list_multipart_uploads()
        .await
        .expect("list after abort");
    assert!(
        !after.iter().any(|u| u.upload_id == abort_id),
        "aborted upload must not be listed"
    );

    client.delete_object(&key).await.expect("cleanup");
}

#[serial_test::serial]
#[tokio::test]
async fn presigned_get_returns_object_bytes_and_disposition() {
    let Some(client) = client() else { return };
    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let key = format!("it/{run}/presign-get/hello world ü.txt");
    let body = b"presigned get roundtrip";
    client
        .put_object(&key, body, "text/plain", None)
        .await
        .expect("seed put");

    let http = reqwest::Client::new();

    // Plain presigned GET (no disposition) — a browser `fetch`/anchor
    // navigation would hit this exact URL and get the object body back.
    let plain = client.presign_get(&key, 3600, None);
    assert_eq!(plain.method, "GET");
    let response = http.get(&plain.url).send().await.expect("plain get");
    assert!(
        response.status().is_success(),
        "status {}",
        response.status()
    );
    assert!(
        response.headers().get("content-disposition").is_none(),
        "no disposition requested, none should be echoed back"
    );
    let bytes = response.bytes().await.expect("plain get body");
    assert_eq!(&bytes[..], &body[..]);

    // With a disposition, the provider echoes it back as a response header —
    // this is exactly what the universal download fallback (spec §5.2
    // amendment) relies on to name the saved file.
    let disposition = r#"attachment; filename="hello world.txt""#;
    let with_disposition = client.presign_get(&key, 3600, Some(disposition));
    let response = http
        .get(&with_disposition.url)
        .send()
        .await
        .expect("disposition get");
    assert!(
        response.status().is_success(),
        "status {}",
        response.status()
    );
    let got_disposition = response
        .headers()
        .get("content-disposition")
        .expect("content-disposition header")
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(got_disposition, disposition);
    let bytes = response.bytes().await.expect("disposition get body");
    assert_eq!(&bytes[..], &body[..]);

    client.delete_object(&key).await.expect("cleanup");
}

#[serial_test::serial]
#[tokio::test]
async fn manifest_conflict_loop_preserves_concurrent_changes() {
    use bare_bucket_core::manifest::{ManifestObject, ManifestStore, MANIFEST_KEY};

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
    assert_eq!(first.attempts, 1);

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

/// Mirrors the wasm `delete_object` composite's logic ([B1]-[B4] of the PR 12
/// plan) using core primitives directly, since this test crate has no wasm
/// boundary: read thumbnail_key from the manifest, S3 DELETE object
/// (NotFound = success), S3 DELETE thumbnail (best-effort), tombstone via
/// `update_with_retry_if_changed` + `Manifest::mark_deleted`.
#[serial_test::serial]
#[tokio::test]
async fn delete_object_composite_removes_object_thumb_and_tombstones_row() {
    use bare_bucket_core::manifest::{
        now_iso8601, thumbnail_key_for, ManifestObject, ManifestStore, MANIFEST_KEY,
    };

    let Some(client) = client() else { return };
    let _ = client.delete_object(MANIFEST_KEY).await;

    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let key = format!("it/{run}/delete/photo.jpg");
    let thumb_key = thumbnail_key_for(&key);

    // Seed the object, a fake thumbnail under the reserved thumbs prefix,
    // and a manifest row pointing at both.
    client
        .put_object(&key, b"photo bytes", "image/jpeg", None)
        .await
        .expect("seed object");
    client
        .put_object(&thumb_key, b"thumb bytes", "image/webp", None)
        .await
        .expect("seed thumbnail");

    let store = ManifestStore::new(&client, "device-it");
    store
        .update_with_retry(|m| {
            m.upsert(ManifestObject {
                key: key.clone(),
                size: 11,
                etag: "\"e\"".to_string(),
                last_modified: "2026-07-15T00:00:00Z".to_string(),
                content_type: "image/jpeg".to_string(),
                favorite: true,
                thumbnail_key: Some(thumb_key.clone()),
                deleted_at: None,
            });
        })
        .await
        .expect("seed manifest row");

    // --- The composite, mirrored step by step ---
    let loaded = store.load().await.expect("load before delete");
    let read_thumbnail_key = loaded
        .manifest
        .get(&key)
        .and_then(|o| o.thumbnail_key.clone());
    assert_eq!(read_thumbnail_key.as_deref(), Some(thumb_key.as_str()));

    match client.delete_object(&key).await {
        Ok(()) | Err(S3Error::NotFound { .. }) => {}
        Err(e) => panic!("object delete failed: {e}"),
    }
    let thumbnail_deleted = match &read_thumbnail_key {
        Some(t) => Some(matches!(
            client.delete_object(t).await,
            Ok(()) | Err(S3Error::NotFound { .. })
        )),
        None => None,
    };
    assert_eq!(thumbnail_deleted, Some(true));

    let deleted_at = now_iso8601();
    let outcome = store
        .update_with_retry_if_changed(|m| m.mark_deleted(&key, &deleted_at))
        .await
        .expect("tombstone write");
    assert!(
        outcome.is_some(),
        "a live row was tombstoned: a change happened"
    );

    // --- Assertions ---
    let object_err = client.get_object(&key).await.expect_err("object gone");
    assert!(matches!(object_err, S3Error::NotFound { .. }));
    let thumb_err = client.get_object(&thumb_key).await.expect_err("thumb gone");
    assert!(matches!(thumb_err, S3Error::NotFound { .. }));

    let after = store.load().await.expect("load after delete");
    let row = after.manifest.get(&key).expect("tombstone row retained");
    assert_eq!(row.deleted_at.as_deref(), Some(deleted_at.as_str()));
    assert!(row.thumbnail_key.is_none(), "thumbnail_key cleared [B4]");
    assert!(row.favorite, "unrelated fields preserved [B4]");
    assert_eq!(after.manifest.live_objects().count(), 0);

    // A second delete of the same (already-tombstoned) key must be a no-op
    // manifest write: nothing left to change.
    let deleted_at_2 = now_iso8601();
    let outcome2 = store
        .update_with_retry_if_changed(|m| m.mark_deleted(&key, &deleted_at_2))
        .await
        .expect("second tombstone attempt");
    assert!(outcome2.is_none(), "already-tombstoned row: no change");

    client
        .delete_object(MANIFEST_KEY)
        .await
        .expect("cleanup manifest");
}

/// Mirrors the wasm `set_thumbnail` mutator (PR 14 [B2][B3]) using core
/// primitives directly, since this test crate has no wasm boundary: seed an
/// object + manifest row, set the thumbnail via
/// `ManifestStore::update_with_retry_if_changed` + `Manifest::set_thumbnail`,
/// reload and confirm the row reflects it, then confirm a second identical
/// call is a no-op (`updated: false` shape — no attempt/PUT happens).
#[serial_test::serial]
#[tokio::test]
async fn set_thumbnail_updates_manifest_and_is_idempotent_on_repeat() {
    use bare_bucket_core::manifest::{
        thumbnail_key_for, ManifestObject, ManifestStore, MANIFEST_KEY,
    };

    let Some(client) = client() else { return };
    let _ = client.delete_object(MANIFEST_KEY).await;

    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let key = format!("it/{run}/thumbnail/photo.jpg");
    let thumb_key = thumbnail_key_for(&key);

    client
        .put_object(&key, b"photo bytes", "image/jpeg", None)
        .await
        .expect("seed object");

    let store = ManifestStore::new(&client, "device-it");
    store
        .update_with_retry(|m| {
            m.upsert(ManifestObject {
                key: key.clone(),
                size: 11,
                etag: "\"e\"".to_string(),
                last_modified: "2026-07-15T00:00:00Z".to_string(),
                content_type: "image/jpeg".to_string(),
                favorite: false,
                thumbnail_key: None,
                deleted_at: None,
            });
        })
        .await
        .expect("seed manifest row");

    // First call: absent -> Some, a real change.
    let outcome = store
        .update_with_retry_if_changed(|m| m.set_thumbnail(&key, Some(thumb_key.clone())))
        .await
        .expect("set_thumbnail write");
    assert!(outcome.is_some(), "row had no thumbnail: a change happened");

    let after = store.load().await.expect("load after set_thumbnail");
    assert_eq!(
        after
            .manifest
            .get(&key)
            .and_then(|o| o.thumbnail_key.clone()),
        Some(thumb_key.clone()),
        "manifest reflects the new thumbnail_key"
    );

    // Second, identical call: no-op per the found-flag pattern [B2].
    let outcome2 = store
        .update_with_retry_if_changed(|m| m.set_thumbnail(&key, Some(thumb_key.clone())))
        .await
        .expect("second set_thumbnail attempt");
    assert!(
        outcome2.is_none(),
        "identical thumbnail_key: no change, no PUT"
    );

    client.delete_object(&key).await.expect("cleanup object");
    client
        .delete_object(MANIFEST_KEY)
        .await
        .expect("cleanup manifest");
}

#[serial_test::serial]
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
    client
        .put_object(&key_a, b"aaa", "text/plain", None)
        .await
        .expect("seed a");
    client
        .put_object(&key_b, b"bbb", "image/jpeg", None)
        .await
        .expect("seed b");
    let live_thumb = thumbnail_key_for(&key_b);
    let orphan_thumb = thumbnail_key_for(&format!("{prefix}vanished.jpg"));
    client
        .put_object(&live_thumb, b"t", "image/webp", None)
        .await
        .expect("live thumb");
    client
        .put_object(&orphan_thumb, b"t", "image/webp", None)
        .await
        .expect("orphan thumb");
    let dangling = client
        .create_multipart_upload(&format!("{prefix}dangling.bin"), "application/octet-stream")
        .await
        .expect("dangling upload");

    let report = reconcile(
        &client,
        "device-it",
        &ReconcileOptions {
            active_upload_ids: &[],
            min_upload_age_secs: 0,
        },
    )
    .await
    .expect("reconcile");

    // Polish item 15: `reconcile()` LISTs the WHOLE bucket, not just this
    // test's own `prefix` — a shared bucket left with debris from an earlier
    // interrupted run (this test or another) contributes extra objects/
    // thumbs that a strict `==` here would wrongly fail on. Tolerant `>=`
    // checks confirm THIS run's own additions were seen without asserting
    // anything about a bucket this test doesn't fully control the contents
    // of; `uploads_aborted` already used `>=` for the same reason.
    assert!(report.added >= 2, "both data objects discovered");
    assert!(report.thumbnails_deleted >= 1, "orphan thumb removed");
    assert!(report.uploads_aborted >= 1, "dangling upload aborted");

    // Manifest reflects the bucket; live thumb key was NOT attached (no row
    // had it) but the thumb object survives for PR 14 to pick up. Scoped to
    // this run's own `prefix` (same pollution reasoning as above) rather than
    // asserting an exact whole-bucket count.
    let store = ManifestStore::new(&client, "device-it");
    let loaded = store.load().await.expect("load");
    assert_eq!(
        loaded
            .manifest
            .live_objects()
            .filter(|o| o.key.starts_with(&prefix))
            .count(),
        2
    );
    assert!(loaded.manifest.get(&key_a).is_some());
    assert!(loaded.manifest.last_full_rebuild_at.is_some());

    // The dangling upload is really gone.
    let uploads = client.list_multipart_uploads().await.expect("uploads");
    assert!(!uploads.iter().any(|u| u.upload_id == dangling));

    // Cleanup.
    for key in [key_a.as_str(), key_b.as_str(), live_thumb.as_str()] {
        client.delete_object(key).await.expect("cleanup");
    }
    client
        .delete_object(MANIFEST_KEY)
        .await
        .expect("cleanup manifest");
}
