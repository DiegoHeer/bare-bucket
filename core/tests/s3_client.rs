//! HTTP-level tests of the S3 client against a local wiremock server.
//! These validate wire behavior: signed headers, conditional requests,
//! error mapping, and retry.

use bare_bucket_core::s3::{S3Client, S3Config, S3Error};
use bare_bucket_core::signer::Credentials;
use wiremock::matchers::{body_bytes, header, header_exists, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

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

#[tokio::test]
async fn get_object_returns_bytes_and_etag() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test-bucket/hello.txt"))
        .and(header_exists("authorization"))
        .and(header_exists("x-amz-date"))
        .and(header_exists("x-amz-content-sha256"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(b"hello".to_vec())
                .insert_header("etag", "\"abc123\""),
        )
        .mount(&server)
        .await;

    let result = client_for(&server).get_object("hello.txt").await.unwrap();
    assert_eq!(result.bytes, b"hello");
    assert_eq!(result.etag, "\"abc123\"");
}

#[tokio::test]
async fn get_object_maps_404_to_not_found() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let err = client_for(&server)
        .get_object("missing.txt")
        .await
        .unwrap_err();
    assert!(matches!(err, S3Error::NotFound { key } if key == "missing.txt"));
}

#[tokio::test]
async fn put_object_sends_body_content_type_and_if_match() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path("/test-bucket/m.json"))
        .and(body_bytes(b"{}".to_vec()))
        .and(header("content-type", "application/json"))
        .and(header("if-match", "\"old\""))
        // payload hash must be the real sha256 of the body, not UNSIGNED-PAYLOAD
        .and(header(
            "x-amz-content-sha256",
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        ))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"new\""))
        .mount(&server)
        .await;

    let result = client_for(&server)
        .put_object("m.json", b"{}", "application/json", Some("\"old\""))
        .await
        .unwrap();
    assert_eq!(result.etag, "\"new\"");
}

#[tokio::test]
async fn put_object_maps_412_to_precondition_failed() {
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(412))
        .mount(&server)
        .await;

    let err = client_for(&server)
        .put_object("m.json", b"{}", "application/json", Some("\"old\""))
        .await
        .unwrap_err();
    assert!(matches!(err, S3Error::PreconditionFailed));
}

#[tokio::test]
async fn transient_500_is_retried_then_succeeds() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test-bucket/flaky.txt"))
        .respond_with(ResponseTemplate::new(500))
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/test-bucket/flaky.txt"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(b"ok".to_vec())
                .insert_header("etag", "\"e\""),
        )
        .mount(&server)
        .await;

    let result = client_for(&server).get_object("flaky.txt").await.unwrap();
    assert_eq!(result.bytes, b"ok");
}

#[tokio::test]
async fn non_retryable_400_fails_immediately() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(400).set_body_string("bad request"))
        .expect(1) // exactly one call: no retries
        .mount(&server)
        .await;

    let err = client_for(&server).get_object("x").await.unwrap_err();
    assert!(matches!(
        err,
        S3Error::Provider {
            status: 400,
            retryable: false,
            ..
        }
    ));
}

#[tokio::test]
async fn delete_object_accepts_204() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/test-bucket/gone.txt"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    client_for(&server).delete_object("gone.txt").await.unwrap();
}

#[tokio::test]
async fn head_bucket_hits_bucket_root() {
    let server = MockServer::start().await;
    Mock::given(method("HEAD"))
        .and(path("/test-bucket"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    client_for(&server).head_bucket().await.unwrap();
}

#[tokio::test]
async fn authorization_header_has_sigv4_shape() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header_exists("authorization"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(Vec::new())
                .insert_header("etag", "\"e\""),
        )
        .mount(&server)
        .await;

    client_for(&server).get_object("k").await.unwrap();
    let requests = server.received_requests().await.unwrap();
    let auth = requests[0]
        .headers
        .get("authorization")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKID/"));
    assert!(auth.contains("/us-east-1/s3/aws4_request"));
    assert!(auth.contains("SignedHeaders="));
    assert!(auth.contains("host"));
    assert!(auth.contains("x-amz-content-sha256"));
    assert!(auth.contains("x-amz-date"));
    assert!(auth.contains("Signature="));
}

#[tokio::test]
async fn list_all_follows_continuation_tokens() {
    let server = MockServer::start().await;
    let page1 = r#"<?xml version="1.0"?><ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>tok2</NextContinuationToken>
      <Contents><Key>a.txt</Key><LastModified>2026-01-01T00:00:00Z</LastModified><ETag>"e1"</ETag><Size>1</Size></Contents>
    </ListBucketResult>"#;
    let page2 = r#"<?xml version="1.0"?><ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <Contents><Key>b.txt</Key><LastModified>2026-01-02T00:00:00Z</LastModified><ETag>"e2"</ETag><Size>2</Size></Contents>
    </ListBucketResult>"#;

    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("list-type", "2"))
        .and(query_param("continuation-token", "tok2"))
        .respond_with(ResponseTemplate::new(200).set_body_string(page2))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("list-type", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_string(page1))
        .mount(&server)
        .await;

    let objects = client_for(&server).list_all(None).await.unwrap();
    assert_eq!(objects.len(), 2);
    assert_eq!(objects[0].key, "a.txt");
    assert_eq!(objects[1].key, "b.txt");
}

#[tokio::test]
async fn create_multipart_upload_posts_and_parses_upload_id() {
    use wiremock::matchers::query_param;

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/test-bucket/big.bin"))
        .and(query_param("uploads", ""))
        .and(header("content-type", "video/mp4"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"<InitiateMultipartUploadResult><UploadId>uid-1</UploadId></InitiateMultipartUploadResult>"#,
        ))
        .mount(&server)
        .await;

    let upload_id = client_for(&server)
        .create_multipart_upload("big.bin", "video/mp4")
        .await
        .unwrap();
    assert_eq!(upload_id, "uid-1");
}

#[tokio::test]
async fn complete_multipart_upload_sends_xml_and_parses_etag() {
    use wiremock::matchers::query_param;

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/test-bucket/big.bin"))
        .and(query_param("uploadId", "uid-1"))
        .and(body_bytes(
            b"<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part></CompleteMultipartUpload>".to_vec(),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"<CompleteMultipartUploadResult><ETag>"combined"</ETag></CompleteMultipartUploadResult>"#,
        ))
        .mount(&server)
        .await;

    let etag = client_for(&server)
        .complete_multipart_upload("big.bin", "uid-1", &[(1, "\"e1\"".to_string())])
        .await
        .unwrap();
    assert_eq!(etag, "\"combined\"");
}

#[tokio::test]
async fn complete_multipart_upload_detects_200_error_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(
                r#"<Error><Code>InternalError</Code><Message>boom</Message></Error>"#,
            ),
        )
        .mount(&server)
        .await;

    let err = client_for(&server)
        .complete_multipart_upload("big.bin", "uid-1", &[(1, "\"e1\"".to_string())])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("InternalError"));
}

#[tokio::test]
async fn complete_multipart_upload_rejects_empty_parts_without_a_network_call() {
    let server = MockServer::start().await;
    // Deliberately no Mock mounted: if the guard didn't fire before the
    // network call, wiremock would fail with "no matching mock found".
    let err = client_for(&server)
        .complete_multipart_upload("big.bin", "uid-1", &[])
        .await
        .unwrap_err();
    assert!(matches!(err, S3Error::InvalidResponse(_)));
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn abort_multipart_upload_deletes_with_upload_id() {
    use wiremock::matchers::query_param;

    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/test-bucket/big.bin"))
        .and(query_param("uploadId", "uid-1"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    client_for(&server)
        .abort_multipart_upload("big.bin", "uid-1")
        .await
        .unwrap();
}

#[tokio::test]
async fn list_multipart_uploads_hits_bucket_root_with_uploads_query() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test-bucket"))
        .and(query_param("uploads", ""))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"<ListMultipartUploadsResult>
  <IsTruncated>false</IsTruncated>
  <Upload>
    <Key>big.bin</Key><UploadId>uid-1</UploadId>
    <Initiated>2026-07-15T10:00:00.000Z</Initiated>
  </Upload>
</ListMultipartUploadsResult>"#,
        ))
        .mount(&server)
        .await;

    let uploads = client_for(&server).list_multipart_uploads().await.unwrap();
    assert_eq!(uploads.len(), 1);
    assert_eq!(uploads[0].key, "big.bin");
    assert_eq!(uploads[0].upload_id, "uid-1");
}
