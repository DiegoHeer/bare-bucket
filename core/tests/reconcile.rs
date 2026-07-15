//! Wiremock tests of the reconcile orchestrator: partitioning, cleanups,
//! manifest write, and corrupt-manifest recovery.

use bare_bucket_core::manifest::{thumbnail_key_for, Manifest, ManifestError, ManifestObject};
use bare_bucket_core::reconcile::{reconcile, ReconcileOptions, ReconcileReport};
use bare_bucket_core::s3::{S3Client, S3Config, S3Error};
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
    let mut xml =
        String::from(r#"<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>"#);
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
    let put = requests
        .iter()
        .rfind(|r| r.method.as_str() == "PUT")
        .unwrap();
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
        &ReconcileOptions {
            active_upload_ids: &active,
            min_upload_age_secs: 3600,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        report.uploads_aborted, 1,
        "only the old, inactive, parseable one"
    );
}

#[tokio::test]
async fn corrupt_manifest_recovers_with_conditional_replace() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("list-type", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_string(list_xml(&[(
            "photos/a.jpg",
            10,
            "\"e1\"",
        )])))
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
    assert!(
        report.conditional,
        "recovery replaced exactly the observed bytes"
    );
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

#[tokio::test]
async fn corrupt_recovery_conflict_retries_whole_reconcile_once() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("list-type", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_string(list_xml(&[(
            "photos/a.jpg",
            10,
            "\"e1\"",
        )])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("uploads", ""))
        .respond_with(ResponseTemplate::new(200).set_body_string(empty_uploads_xml()))
        .mount(&server)
        .await;

    // First pass: manifest GET returns garbage at etag "c1" — but only once.
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(b"garbage".to_vec())
                .insert_header("etag", "\"c1\""),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;
    // First recovery PUT (conditional on "c1") conflicts.
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .and(wiremock::matchers::header("if-match", "\"c1\""))
        .respond_with(ResponseTemplate::new(412))
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;

    // Retry pass: manifest is now valid at etag "v2".
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(Manifest::empty().to_gzipped_json())
                .insert_header("etag", "\"v2\""),
        )
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .and(wiremock::matchers::header("if-match", "\"v2\""))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"m9\""))
        .expect(1)
        .mount(&server)
        .await;

    let client = client_for(&server);
    let report = reconcile(&client, "web-test", &ReconcileOptions::default())
        .await
        .unwrap();
    assert_eq!(report.added, 1, "retry pass rebuilds from the same LIST");
    assert!(
        report.conditional,
        "retry pass still writes conditionally against the valid etag"
    );
}

#[tokio::test]
async fn corrupt_recovery_conflict_twice_propagates() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("list-type", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_string(list_xml(&[(
            "photos/a.jpg",
            10,
            "\"e1\"",
        )])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("uploads", ""))
        .respond_with(ResponseTemplate::new(200).set_body_string(empty_uploads_xml()))
        .mount(&server)
        .await;
    // Manifest is always corrupt, always at etag "c1".
    Mock::given(method("GET"))
        .and(path(MANIFEST_PATH))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(b"garbage".to_vec())
                .insert_header("etag", "\"c1\""),
        )
        .mount(&server)
        .await;
    // Every recovery PUT conflicts, both on the first pass and the retry.
    Mock::given(method("PUT"))
        .and(path(MANIFEST_PATH))
        .respond_with(ResponseTemplate::new(412))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let err = reconcile(&client, "web-test", &ReconcileOptions::default())
        .await
        .unwrap_err();
    assert!(
        matches!(err, ManifestError::S3(S3Error::PreconditionFailed)),
        "one retry is allowed; a second conflict propagates"
    );
}

#[tokio::test]
async fn unparseable_thumb_names_are_orphaned() {
    let server = MockServer::start().await;
    let odd_thumb = ".bare-bucket/thumbs/noext.png"; // no .webp suffix
    mount_defaults(
        &server,
        list_xml(&[("photos/a.jpg", 10, "\"e1\""), (odd_thumb, 1, "\"t1\"")]),
        empty_uploads_xml().to_string(),
    )
    .await;
    let delete_path = format!("/test-bucket/{odd_thumb}");
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
    assert_eq!(
        report.thumbnails_deleted, 1,
        "unparseable thumb name is treated as orphaned"
    );
}
