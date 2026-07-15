//! Integration tests against a real S3-compatible provider (MinIO via
//! `docker compose up -d`). Skipped unless BARE_BUCKET_IT=1.
//!
//! Run locally:
//!   docker compose up -d --wait
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

    // PUT (unconditional) — keys exercise encoding: space + unicode
    let key = "it/lifecycle/hello world ü.txt";
    let put = client
        .put_object(key, b"integration", "text/plain", None)
        .await
        .expect("put");
    assert!(!put.etag.is_empty());

    // GET roundtrip
    let got = client.get_object(key).await.expect("get");
    assert_eq!(got.bytes, b"integration");
    assert_eq!(got.etag, put.etag);

    // Conditional PUT with the correct ETag succeeds
    let put2 = client
        .put_object(key, b"integration v2", "text/plain", Some(&put.etag))
        .await
        .expect("conditional put with matching etag");

    // Conditional PUT with a stale ETag must fail (MinIO supports If-Match)
    let err = client
        .put_object(key, b"lost update", "text/plain", Some(&put.etag))
        .await
        .expect_err("conditional put with stale etag must fail");
    assert!(
        matches!(err, S3Error::PreconditionFailed),
        "expected PreconditionFailed, got: {err:?}"
    );

    // Content reflects the winning write
    let got2 = client.get_object(key).await.expect("get v2");
    assert_eq!(got2.bytes, b"integration v2");
    assert_eq!(got2.etag, put2.etag);

    // DELETE, then GET maps to NotFound
    client.delete_object(key).await.expect("delete");
    let err = client.get_object(key).await.expect_err("get after delete");
    assert!(matches!(err, S3Error::NotFound { .. }));
}

#[tokio::test]
async fn list_paginates_across_pages() {
    let Some(client) = client() else { return };

    let prefix = "it/list/";
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
