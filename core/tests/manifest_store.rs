//! HTTP-level tests of ManifestStore against wiremock: bootstrap, conditional
//! save, the 412 retry loop, and the 501 last-writer-wins fallback.

use bare_bucket_core::manifest::{Manifest, ManifestError, ManifestObject, ManifestStore};
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
async fn load_reports_etag_on_corrupt_manifest() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(b"not gzip at all".to_vec())
                .insert_header("etag", "\"c1\""),
        )
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    let err = match store.load().await {
        Err(e) => e,
        Ok(_) => panic!("expected load() to fail on corrupt bytes"),
    };
    assert!(matches!(
        err,
        ManifestError::Corrupt { etag: Some(ref e), .. } if e == "\"c1\""
    ));
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
        .rfind(|r| r.method.as_str() == "PUT")
        .unwrap();
    let saved = Manifest::from_gzipped_json(&final_put.body).unwrap();
    assert!(
        saved.get("other.txt").is_some(),
        "concurrent change preserved"
    );
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
    assert!(matches!(
        err,
        ManifestError::RetriesExhausted { attempts: 5 }
    ));
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
    assert_eq!(outcome.attempts, 2);
    assert!(!outcome.conditional, "degraded to last-writer-wins");

    // The final (unconditional) PUT must still carry our change.
    let requests = server.received_requests().await.unwrap();
    let final_put = requests
        .iter()
        .rfind(|r| r.method.as_str() == "PUT")
        .unwrap();
    let saved = Manifest::from_gzipped_json(&final_put.body).unwrap();
    assert!(saved.get("mine.txt").is_some(), "our change applied");
}

#[tokio::test]
async fn update_with_retry_if_changed_skips_put_when_mutator_reports_no_change() {
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

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    // Tombstoning an absent key is a no-op per the found-flag pattern [B2]:
    // update_with_retry_if_changed must not issue a PUT at all.
    let outcome = store
        .update_with_retry_if_changed(|m| m.mark_deleted("missing.txt", "2026-07-15T12:00:00Z"))
        .await
        .unwrap();
    assert!(outcome.is_none());

    let requests = server.received_requests().await.unwrap();
    assert!(
        requests.iter().all(|r| r.method.as_str() != "PUT"),
        "no PUT should be issued when nothing changed"
    );
}

#[tokio::test]
async fn update_with_retry_if_changed_skips_put_when_thumbnail_value_is_identical() {
    let server = MockServer::start().await;
    let mut base = Manifest::empty();
    let mut with_thumb = object("a.txt", 5);
    with_thumb.thumbnail_key = Some(".bare-bucket/thumbs/a.txt.webp".to_string());
    base.upsert(with_thumb);
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(gz(&base))
                .insert_header("etag", "\"v1\""),
        )
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    // Setting the SAME thumbnail_key that's already stored is a no-op per
    // the found-flag pattern [B2]: no PUT should be issued.
    let outcome = store
        .update_with_retry_if_changed(|m| {
            m.set_thumbnail("a.txt", Some(".bare-bucket/thumbs/a.txt.webp".to_string()))
        })
        .await
        .unwrap();
    assert!(outcome.is_none());

    let requests = server.received_requests().await.unwrap();
    assert!(
        requests.iter().all(|r| r.method.as_str() != "PUT"),
        "no PUT should be issued when the thumbnail value is unchanged"
    );
}

#[tokio::test]
async fn update_with_retry_if_changed_writes_when_mutator_reports_a_change() {
    let server = MockServer::start().await;
    let mut base = Manifest::empty();
    base.upsert(object("a.txt", 5));
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(gz(&base))
                .insert_header("etag", "\"v1\""),
        )
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .and(header("if-match", "\"v1\""))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"v2\""))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&server);
    let store = ManifestStore::new(&client, "web-test");
    let outcome = store
        .update_with_retry_if_changed(|m| m.mark_deleted("a.txt", "2026-07-15T12:00:00Z"))
        .await
        .unwrap()
        .expect("a live row was tombstoned: a change happened");
    assert_eq!(outcome.etag, "\"v2\"");
    assert_eq!(outcome.attempts, 1);
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
