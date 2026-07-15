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
    client
        .delete_object(MANIFEST_KEY)
        .await
        .expect("cleanup manifest");
}
