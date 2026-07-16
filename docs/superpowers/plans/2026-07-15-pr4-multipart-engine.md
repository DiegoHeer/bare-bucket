# PR 4: Multipart Upload Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The upload engine in `bare-bucket-core`: upload planning (single-PUT vs multipart with part-size scaling), presigned data-plane descriptors the UI executes (bytes never enter WASM — spec §3.3/§5.1), and the multipart control-plane calls (create/complete/abort/list) including the 200-with-`<Error>` trap on Complete.

**Architecture:** New `core/src/s3/multipart.rs` child module (keeps access to the private `send()`), following `list.rs`'s pattern. Two kinds of API: **pure descriptor builders** (`plan_upload`, `presign_put`, `presign_upload_part` — return presigned URLs via `signer::presign_query`; the JS shell slices the `File` and fires the fetches, reporting progress itself) and **async control-plane ops** (`create_multipart_upload`, `complete_multipart_upload`, `abort_multipart_upload`, `list_multipart_uploads` — small XML bodies through `send()`). Presigned (query-auth) descriptors rather than header-auth: no Authorization header for the browser to carry, no clock-skew issues mid-upload, 1-hour default expiry.

**Tech Stack:** existing deps only (roxmltree for XML parsing; hand-built XML body for Complete with a small escape helper).

## Global Constraints

- Commits: Conventional Commits, atomic; trailer: blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work from `/home/diego/Projects/bare-bucket/.claude/worktrees/bare-bucket-design` (branch `worktree-bare-bucket-design`); `source "$HOME/.cargo/env"` in every shell.
- Before every commit: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings` clean.
- Do not push or open a PR.
- **Carried forward from PR 3's final review (binding):**
  - `multipart.rs` is a child module of `s3` (like `list.rs`) so `send()` stays private.
  - No second query encoder anywhere — `uploadId` (which can contain `/ = +`) flows only through `signer::canonical_query_string` / `presign_query`.
  - `CompleteMultipartUpload` can return **200 OK with an `<Error>` body** — parsing MUST detect this and return an error. `send()`'s is_success check does not defend against it.
  - Bulk part bytes NEVER go through `send()` — descriptors only.
- Spec anchors: threshold 64 MiB, part size 64 MiB scaling up under the 10,000-part cap (spec §5.1); dangling-upload cleanup listing is consumed by PR 6.
- YAGNI: no ListParts, no UploadPartCopy, no checksum algorithms (CRC32 etc.), no core-side progress events (progress is a JS/fetch concern per spec).

---

### Task 1: upload planning + presigned data-plane descriptors

**Files:**
- Create: `core/src/s3/multipart.rs` (planning + descriptors + their tests)
- Modify: `core/src/s3/mod.rs` (add `mod multipart;` + re-exports + the two presign methods on `S3Client`)

**Interfaces:**
- Consumes: `signer::{presign_query, SigningContext}`, `S3Client` internals (`config`, `scheme`, `authority`, `target()`, `now_timestamp()`).
- Produces (used by Task 2–3 and PR 10's upload flow):

```rust
pub const MULTIPART_THRESHOLD: u64 = 64 * 1024 * 1024;
pub const DEFAULT_PART_SIZE: u64 = 64 * 1024 * 1024;
pub const MAX_PARTS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadPlan {
    SinglePut,
    Multipart { part_size: u64, part_count: u32 },
}
pub fn plan_upload(size: u64) -> UploadPlan;

#[derive(Debug, Clone)]
pub struct PresignedRequest { pub method: String, pub url: String }

impl S3Client {
    pub fn presign_put(&self, key: &str, expires_secs: u64) -> PresignedRequest;
    pub fn presign_upload_part(&self, key: &str, upload_id: &str, part_number: u32, expires_secs: u64) -> PresignedRequest;
}
```

- [ ] **Step 1: Write the failing tests**

Create `core/src/s3/multipart.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::s3::{S3Client, S3Config};
    use crate::signer::Credentials;

    const MIB: u64 = 1024 * 1024;

    fn client() -> S3Client {
        S3Client::new(S3Config {
            endpoint: "https://s3.example.com:9000".to_string(),
            region: "us-east-1".to_string(),
            bucket: "photos".to_string(),
            path_style: true,
            credentials: Credentials {
                access_key_id: "AKID".to_string(),
                secret_access_key: "SECRET".to_string(),
            },
        })
        .unwrap()
    }

    #[test]
    fn small_files_use_single_put() {
        assert_eq!(plan_upload(0), UploadPlan::SinglePut);
        assert_eq!(plan_upload(64 * MIB), UploadPlan::SinglePut);
    }

    #[test]
    fn large_files_use_multipart_with_default_part_size() {
        let plan = plan_upload(64 * MIB + 1);
        assert_eq!(
            plan,
            UploadPlan::Multipart { part_size: 64 * MIB, part_count: 2 }
        );
        // 6 GiB video: 96 parts of 64 MiB
        let plan = plan_upload(6 * 1024 * MIB);
        assert_eq!(
            plan,
            UploadPlan::Multipart { part_size: 64 * MIB, part_count: 96 }
        );
    }

    #[test]
    fn part_size_scales_up_beyond_10k_parts() {
        // 1 TiB at 64 MiB/part would need 16384 parts → part size must grow.
        let size = 1024 * 1024 * MIB;
        let UploadPlan::Multipart { part_size, part_count } = plan_upload(size) else {
            panic!("expected multipart");
        };
        assert!(u64::from(part_count) <= MAX_PARTS);
        assert!(part_size > 64 * MIB);
        assert_eq!(part_size % MIB, 0, "part size stays MiB-aligned");
        assert!(u64::from(part_count) * part_size >= size, "parts must cover the file");
    }

    #[test]
    fn presign_put_produces_signed_put_url() {
        let req = client().presign_put("photos/2026/IMG 0001.jpg", 3600);
        assert_eq!(req.method, "PUT");
        assert!(req.url.starts_with(
            "https://s3.example.com:9000/photos/photos/2026/IMG%200001.jpg?"
        ));
        assert!(req.url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(req.url.contains("X-Amz-Expires=3600"));
        assert!(req.url.contains("&X-Amz-Signature="));
    }

    #[test]
    fn presign_upload_part_carries_part_number_and_upload_id() {
        let req = client().presign_upload_part(
            "big.bin",
            "abc/def+123=", // uploadId with characters needing encoding
            7,
            3600,
        );
        assert_eq!(req.method, "PUT");
        assert!(req.url.contains("partNumber=7"));
        assert!(req.url.contains("uploadId=abc%2Fdef%2B123%3D"));
        assert!(req.url.contains("&X-Amz-Signature="));
    }
}
```

In `core/src/s3/mod.rs`, next to `mod list;` add:

```rust
mod multipart;
```

and next to the existing `pub use list::...` add:

```rust
pub use multipart::{
    plan_upload, PresignedRequest, UploadPlan, DEFAULT_PART_SIZE, MAX_PARTS,
    MULTIPART_THRESHOLD,
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bare-bucket-core multipart`
Expected: compile errors — `plan_upload`, `presign_put` not found

- [ ] **Step 3: Write the implementation**

Prepend to `core/src/s3/multipart.rs` (above the tests):

```rust
//! Upload planning and multipart descriptors.
//!
//! Data-plane bytes never enter the core (spec §3.3): the UI executes the
//! presigned requests built here, slicing the browser `File` per part. Only
//! the small control-plane XML calls go through the client itself.

use super::{S3Client, S3Error};
use crate::signer::{presign_query, SigningContext};

/// Files at or below this size upload as one presigned PUT.
pub const MULTIPART_THRESHOLD: u64 = 64 * 1024 * 1024;
/// Base part size; grows for very large files to respect [`MAX_PARTS`].
pub const DEFAULT_PART_SIZE: u64 = 64 * 1024 * 1024;
/// S3 protocol cap on part count.
pub const MAX_PARTS: u64 = 10_000;

const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadPlan {
    SinglePut,
    Multipart { part_size: u64, part_count: u32 },
}

/// Decide the upload strategy for a file of `size` bytes (spec §5.1).
pub fn plan_upload(size: u64) -> UploadPlan {
    if size <= MULTIPART_THRESHOLD {
        return UploadPlan::SinglePut;
    }
    // Grow the part size in whole MiB until the file fits in MAX_PARTS.
    let mut part_size = DEFAULT_PART_SIZE;
    if size.div_ceil(part_size) > MAX_PARTS {
        part_size = size.div_ceil(MAX_PARTS).div_ceil(MIB) * MIB;
    }
    let part_count = u32::try_from(size.div_ceil(part_size))
        .expect("part count bounded by MAX_PARTS");
    UploadPlan::Multipart { part_size, part_count }
}

/// A signed request the UI executes with browser `fetch` — query-auth
/// (presigned), so no headers beyond the body are required.
#[derive(Debug, Clone)]
pub struct PresignedRequest {
    pub method: String,
    pub url: String,
}

impl S3Client {
    fn presign(
        &self,
        method: &str,
        key: &str,
        extra_query: &[(&str, &str)],
        expires_secs: u64,
    ) -> PresignedRequest {
        let target = self.target(Some(key), &[]);
        let timestamp = super::now_timestamp();
        let ctx = SigningContext {
            credentials: &self.config.credentials,
            region: &self.config.region,
            service: "s3",
            timestamp: &timestamp,
        };
        let query = presign_query(
            &ctx,
            method,
            &target.uri_path,
            &target.host,
            extra_query,
            expires_secs,
        );
        PresignedRequest {
            method: method.to_string(),
            url: format!(
                "{}://{}{}?{}",
                self.scheme, target.host, target.uri_path, query
            ),
        }
    }

    /// Presigned single PUT for files at or below [`MULTIPART_THRESHOLD`].
    pub fn presign_put(&self, key: &str, expires_secs: u64) -> PresignedRequest {
        self.presign("PUT", key, &[], expires_secs)
    }

    /// Presigned UploadPart PUT. `part_number` is 1-based.
    pub fn presign_upload_part(
        &self,
        key: &str,
        upload_id: &str,
        part_number: u32,
        expires_secs: u64,
    ) -> PresignedRequest {
        let part = part_number.to_string();
        self.presign(
            "PUT",
            key,
            &[("partNumber", &part), ("uploadId", upload_id)],
            expires_secs,
        )
    }
}
```

(Visibility note: `S3Client.scheme`/`.config` and `target()` are private to the `s3` module but `multipart.rs` is a child module (`super::`), so they are reachable; if the compiler disagrees on any field, prefer widening that one field to `pub(crate)` over restructuring.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bare-bucket-core multipart`
Expected: 5 passed, 0 failed

- [ ] **Step 5: fmt + clippy (both targets), full suite, commit**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace`
Expected: clean; 39 unit + 10 wiremock + 2 integration-skip

```bash
git add core/src/s3/multipart.rs core/src/s3/mod.rs
git commit -m "feat: add upload planning and presigned data-plane descriptors"
```

---

### Task 2: multipart control plane (create / complete / abort) with 200-Error trap

**Files:**
- Modify: `core/src/s3/multipart.rs`
- Modify: `core/tests/s3_client.rs` (wiremock tests)

**Interfaces:**
- Consumes: `send()` (private, same module tree), roxmltree.
- Produces (used by PR 10):

```rust
impl S3Client {
    pub async fn create_multipart_upload(&self, key: &str, content_type: &str) -> Result<String /* upload_id */, S3Error>;
    pub async fn complete_multipart_upload(&self, key: &str, upload_id: &str, parts: &[(u32, String)]) -> Result<String /* etag */, S3Error>;
    pub async fn abort_multipart_upload(&self, key: &str, upload_id: &str) -> Result<(), S3Error>;
}
```

- [ ] **Step 1: Write the failing tests**

Append to the tests module in `core/src/s3/multipart.rs` (pure parsing/building tests):

```rust
    #[test]
    fn parses_initiate_response() {
        let xml = r#"<?xml version="1.0"?>
<InitiateMultipartUploadResult>
  <Bucket>photos</Bucket><Key>big.bin</Key>
  <UploadId>VXBsb2FkIElE/with+chars=</UploadId>
</InitiateMultipartUploadResult>"#;
        assert_eq!(
            parse_initiate_response(xml.as_bytes()).unwrap(),
            "VXBsb2FkIElE/with+chars="
        );
    }

    #[test]
    fn initiate_without_upload_id_is_invalid() {
        let xml = b"<InitiateMultipartUploadResult></InitiateMultipartUploadResult>";
        assert!(parse_initiate_response(xml).is_err());
    }

    #[test]
    fn builds_complete_request_body() {
        let parts = vec![(1, "\"etag1\"".to_string()), (2, "\"etag2\"".to_string())];
        let body = build_complete_body(&parts);
        assert_eq!(
            body,
            "<CompleteMultipartUpload>\
             <Part><PartNumber>1</PartNumber><ETag>&quot;etag1&quot;</ETag></Part>\
             <Part><PartNumber>2</PartNumber><ETag>&quot;etag2&quot;</ETag></Part>\
             </CompleteMultipartUpload>"
        );
    }

    #[test]
    fn parses_complete_success_response() {
        let xml = r#"<?xml version="1.0"?>
<CompleteMultipartUploadResult>
  <Location>https://x/big.bin</Location><Bucket>photos</Bucket>
  <Key>big.bin</Key><ETag>"final-etag-123"</ETag>
</CompleteMultipartUploadResult>"#;
        assert_eq!(
            parse_complete_response(xml.as_bytes()).unwrap(),
            "\"final-etag-123\""
        );
    }

    #[test]
    fn complete_response_with_error_body_is_an_error() {
        // The classic trap: HTTP 200 whose body is an <Error> document.
        let xml = r#"<?xml version="1.0"?>
<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>"#;
        let err = parse_complete_response(xml.as_bytes()).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("InternalError"), "got: {text}");
    }

    #[test]
    fn complete_response_without_etag_is_invalid() {
        let xml = b"<CompleteMultipartUploadResult></CompleteMultipartUploadResult>";
        assert!(parse_complete_response(xml).is_err());
    }
```

Append to `core/tests/s3_client.rs`:

```rust
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
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"<Error><Code>InternalError</Code><Message>boom</Message></Error>"#,
        ))
        .mount(&server)
        .await;

    let err = client_for(&server)
        .complete_multipart_upload("big.bin", "uid-1", &[(1, "\"e1\"".to_string())])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("InternalError"));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bare-bucket-core multipart`
Expected: compile errors — `parse_initiate_response`, `build_complete_body`, `parse_complete_response` not found

- [ ] **Step 3: Write the implementation**

Add to `core/src/s3/multipart.rs` (module scope, above the tests):

```rust
fn xml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Body for CompleteMultipartUpload. `parts` are (1-based part number, ETag).
fn build_complete_body(parts: &[(u32, String)]) -> String {
    let mut body = String::from("<CompleteMultipartUpload>");
    for (number, etag) in parts {
        body.push_str(&format!(
            "<Part><PartNumber>{number}</PartNumber><ETag>{}</ETag></Part>",
            xml_escape(etag)
        ));
    }
    body.push_str("</CompleteMultipartUpload>");
    body
}

fn parse_xml(xml: &[u8]) -> Result<roxmltree::Document<'_>, S3Error> {
    let text = std::str::from_utf8(xml)
        .map_err(|e| S3Error::InvalidResponse(format!("non-UTF8 XML: {e}")))?;
    // roxmltree needs the document to live as long as the return value, so
    // callers pass the raw bytes and we parse in one expression per use.
    roxmltree::Document::parse(text)
        .map_err(|e| S3Error::InvalidResponse(format!("XML parse error: {e}")))
}

fn text_of<'a>(doc: &'a roxmltree::Document, tag: &str) -> Option<&'a str> {
    doc.descendants()
        .find(|n| n.has_tag_name(tag))
        .and_then(|n| n.text())
        .map(str::trim)
        .filter(|t| !t.is_empty())
}

/// If the document is an S3 `<Error>` body, surface it as a Provider error.
fn check_error_body(doc: &roxmltree::Document) -> Result<(), S3Error> {
    if doc.root_element().has_tag_name("Error") {
        let code = text_of(doc, "Code").unwrap_or("UnknownError");
        let message = text_of(doc, "Message").unwrap_or("");
        return Err(S3Error::Provider {
            status: 200,
            message: format!("{code}: {message}"),
            retryable: true, // Complete-time InternalError is retryable per AWS guidance
        });
    }
    Ok(())
}

fn parse_initiate_response(xml: &[u8]) -> Result<String, S3Error> {
    let doc = parse_xml(xml)?;
    check_error_body(&doc)?;
    text_of(&doc, "UploadId")
        .map(str::to_string)
        .ok_or_else(|| S3Error::InvalidResponse("initiate response missing UploadId".into()))
}

fn parse_complete_response(xml: &[u8]) -> Result<String, S3Error> {
    let doc = parse_xml(xml)?;
    check_error_body(&doc)?;
    text_of(&doc, "ETag")
        .map(str::to_string)
        .ok_or_else(|| S3Error::InvalidResponse("complete response missing ETag".into()))
}
```

And extend `impl S3Client` in the same file:

```rust
    /// Start a multipart upload; returns the provider's upload ID.
    pub async fn create_multipart_upload(
        &self,
        key: &str,
        content_type: &str,
    ) -> Result<String, S3Error> {
        let response = self
            .send(
                reqwest::Method::POST,
                Some(key),
                &[("uploads", "")],
                &[("content-type", content_type)],
                None,
            )
            .await?;
        let body = response
            .bytes()
            .await
            .map_err(|e| S3Error::Network(e.to_string()))?;
        parse_initiate_response(&body)
    }

    /// Finish a multipart upload. `parts` are (1-based part number, ETag)
    /// in ascending part order. Detects the 200-with-`<Error>`-body trap.
    pub async fn complete_multipart_upload(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[(u32, String)],
    ) -> Result<String, S3Error> {
        let body = build_complete_body(parts);
        let response = self
            .send(
                reqwest::Method::POST,
                Some(key),
                &[("uploadId", upload_id)],
                &[("content-type", "application/xml")],
                Some(body.as_bytes()),
            )
            .await?;
        let bytes = response
            .bytes()
            .await
            .map_err(|e| S3Error::Network(e.to_string()))?;
        parse_complete_response(&bytes)
    }

    /// Abort a multipart upload so half-uploaded parts stop accruing storage.
    pub async fn abort_multipart_upload(
        &self,
        key: &str,
        upload_id: &str,
    ) -> Result<(), S3Error> {
        self.send(
            reqwest::Method::DELETE,
            Some(key),
            &[("uploadId", upload_id)],
            &[],
            None,
        )
        .await
        .map(|_| ())
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bare-bucket-core multipart && cargo test -p bare-bucket-core --test s3_client`
Expected: 11 multipart unit tests + 14 wiremock tests, all passing

- [ ] **Step 5: fmt + clippy (both targets), full suite, commit**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace`
Expected: clean

```bash
git add core/src/s3/multipart.rs core/tests/s3_client.rs
git commit -m "feat: add multipart create/complete/abort with 200-error trap"
```

---

### Task 3: dangling-upload listing + real multipart integration test

**Files:**
- Modify: `core/src/s3/multipart.rs` (`list_multipart_uploads` + parse + tests)
- Modify: `core/src/s3/mod.rs` (re-export `MultipartUploadInfo`)
- Modify: `core/tests/s3_integration.rs` (full multipart roundtrip)

**Interfaces:**
- Consumes: everything above.
- Produces (used by PR 6 reconciliation cleanup):

```rust
#[derive(Debug, Clone)]
pub struct MultipartUploadInfo { pub key: String, pub upload_id: String, pub initiated: String }
impl S3Client {
    pub async fn list_multipart_uploads(&self) -> Result<Vec<MultipartUploadInfo>, S3Error>;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `core/src/s3/multipart.rs` tests:

```rust
    #[test]
    fn parses_list_multipart_uploads() {
        let xml = r#"<?xml version="1.0"?>
<ListMultipartUploadsResult>
  <Bucket>photos</Bucket>
  <Upload>
    <Key>big.bin</Key><UploadId>uid-1</UploadId>
    <Initiated>2026-07-15T10:00:00.000Z</Initiated>
  </Upload>
  <Upload>
    <Key>other.mp4</Key><UploadId>uid-2</UploadId>
    <Initiated>2026-07-15T11:00:00.000Z</Initiated>
  </Upload>
</ListMultipartUploadsResult>"#;
        let uploads = parse_list_uploads_response(xml.as_bytes()).unwrap();
        assert_eq!(uploads.len(), 2);
        assert_eq!(uploads[0].key, "big.bin");
        assert_eq!(uploads[0].upload_id, "uid-1");
        assert_eq!(uploads[0].initiated, "2026-07-15T10:00:00.000Z");
        assert_eq!(uploads[1].upload_id, "uid-2");
    }

    #[test]
    fn parses_empty_upload_list() {
        let xml = b"<ListMultipartUploadsResult></ListMultipartUploadsResult>";
        assert!(parse_list_uploads_response(xml).unwrap().is_empty());
    }
```

Append to `core/tests/s3_integration.rs`:

```rust
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
        dangling.iter().any(|u| u.key == key && u.upload_id == upload_id),
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
    let after = client.list_multipart_uploads().await.expect("list after abort");
    assert!(
        !after.iter().any(|u| u.upload_id == abort_id),
        "aborted upload must not be listed"
    );

    client.delete_object(&key).await.expect("cleanup");
}
```

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `cargo test -p bare-bucket-core multipart`
Expected: compile errors — `parse_list_uploads_response`, `MultipartUploadInfo` not found

- [ ] **Step 3: Write the implementation**

Add to `core/src/s3/multipart.rs`:

```rust
/// An in-progress (possibly dangling) multipart upload, for reconciliation
/// cleanup (spec §6).
#[derive(Debug, Clone)]
pub struct MultipartUploadInfo {
    pub key: String,
    pub upload_id: String,
    pub initiated: String,
}

fn parse_list_uploads_response(xml: &[u8]) -> Result<Vec<MultipartUploadInfo>, S3Error> {
    let doc = parse_xml(xml)?;
    check_error_body(&doc)?;
    let mut uploads = Vec::new();
    for upload in doc.descendants().filter(|n| n.has_tag_name("Upload")) {
        let child_text = |tag: &str| {
            upload
                .children()
                .find(|n| n.has_tag_name(tag))
                .and_then(|n| n.text())
                .map(str::trim)
                .unwrap_or_default()
                .to_string()
        };
        let info = MultipartUploadInfo {
            key: child_text("Key"),
            upload_id: child_text("UploadId"),
            initiated: child_text("Initiated"),
        };
        if !info.key.is_empty() && !info.upload_id.is_empty() {
            uploads.push(info);
        }
    }
    Ok(uploads)
}
```

Extend `impl S3Client`:

```rust
    /// List in-progress multipart uploads (reconciliation cleanup, spec §6).
    pub async fn list_multipart_uploads(&self) -> Result<Vec<MultipartUploadInfo>, S3Error> {
        let response = self
            .send(reqwest::Method::GET, None, &[("uploads", "")], &[], None)
            .await?;
        let body = response
            .bytes()
            .await
            .map_err(|e| S3Error::Network(e.to_string()))?;
        parse_list_uploads_response(&body)
    }
```

In `core/src/s3/mod.rs`, extend the multipart re-export with `MultipartUploadInfo`.

- [ ] **Step 4: Run all tests**

Run: `cargo test --workspace` then the live integration run:

```bash
docker compose up -d --wait minio && docker compose run --rm createbucket
BARE_BUCKET_IT=1 BARE_BUCKET_IT_ENDPOINT=http://127.0.0.1:9000 \
  BARE_BUCKET_IT_REGION=us-east-1 BARE_BUCKET_IT_BUCKET=bare-bucket-it \
  BARE_BUCKET_IT_ACCESS_KEY=baretest BARE_BUCKET_IT_SECRET_KEY=baretest123 \
  cargo test -p bare-bucket-core --test s3_integration -- --nocapture
```

Expected: workspace suite green; integration 3 passed (lifecycle, list-pagination, multipart roundtrip). If the presigned part upload fails against MinIO (e.g. signature rejection on the `?uploads=` empty-value form or the presigned query shape), STOP and report DONE_WITH_CONCERNS with the exact provider error — that is a provider-quirk finding the controller must see.

- [ ] **Step 5: fmt + clippy (both targets), WASM build, commit**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && wasm-pack build core --target web`
Expected: clean

```bash
git add core/src/s3/multipart.rs core/src/s3/mod.rs core/tests/s3_integration.rs
git commit -m "feat: add multipart upload listing and live roundtrip test"
```
