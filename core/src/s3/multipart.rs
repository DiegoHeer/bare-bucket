//! Upload planning and multipart descriptors.
//!
//! Data-plane bytes never enter the core (spec §3.3): the UI executes the
//! presigned requests built here, slicing the browser `File` per part. Only
//! the small control-plane XML calls go through the client itself.
//!
//! ## Bucket CORS requirements (spec §8.5)
//!
//! Both the presigned data-plane PUTs and the signed control-plane calls in
//! this module are executed directly by the browser, so the bucket's CORS
//! rule must cover both shapes or uploads fail with an opaque browser CORS
//! error instead of a usable S3 error body:
//!
//! - **Data-plane presigned PUTs** ([`S3Client::presign_put`],
//!   [`S3Client::presign_upload_part`]): `AllowedMethods` must include
//!   `PUT`, `AllowedHeaders` must cover `content-type`, and `ExposeHeaders`
//!   **must include `ETag`** — without it, JS cannot read a part's ETag
//!   from the response, and [`S3Client::complete_multipart_upload`] has
//!   nothing to assemble the parts from.
//! - **Control-plane signed calls** issued from the browser (initiate,
//!   complete, abort, list): `AllowedHeaders` must include `authorization`,
//!   `x-amz-date`, and `x-amz-content-sha256` — the SigV4 headers this
//!   client signs and sends on every request.

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
    // Closed form: part size stays DEFAULT_PART_SIZE unless that would need
    // more than MAX_PARTS parts, in which case it's the smallest MiB-aligned
    // size that brings the part count back to MAX_PARTS or fewer. Implicit
    // ceiling: S3's 5 GiB max part size times MAX_PARTS caps any uploadable
    // object at roughly 48.8 TiB, regardless of this function's math.
    let mut part_size = DEFAULT_PART_SIZE;
    if size.div_ceil(part_size) > MAX_PARTS {
        part_size = size.div_ceil(MAX_PARTS).div_ceil(MIB) * MIB;
    }
    let part_count =
        u32::try_from(size.div_ceil(part_size)).expect("part count bounded by MAX_PARTS");
    UploadPlan::Multipart {
        part_size,
        part_count,
    }
}

/// A signed request the UI executes with browser `fetch` — query-auth
/// (presigned), so no headers beyond the body are required.
#[derive(Debug, Clone)]
pub struct PresignedRequest {
    pub method: String,
    pub url: String,
    /// The `expires_secs` this request was signed with, so callers (PR 10)
    /// can track when a descriptor goes stale.
    pub expires_secs: u64,
}

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
///
/// Convention: callers should pass parts already in ascending part-number
/// order, but this function sorts a local copy before emitting regardless —
/// S3 rejects out-of-order parts with `InvalidPartOrder`, and parts routinely
/// arrive out of order when multiple parts upload concurrently.
fn build_complete_body(parts: &[(u32, String)]) -> String {
    let mut sorted = parts.to_vec();
    sorted.sort_by_key(|(number, _)| *number);
    let mut body = String::from("<CompleteMultipartUpload>");
    for (number, etag) in &sorted {
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
        .find(|n| n.tag_name().name() == tag)
        .and_then(|n| n.text())
        .map(str::trim)
        .filter(|t| !t.is_empty())
}

/// If the document is an S3 `<Error>` body, surface it as a Provider error.
fn check_error_body(doc: &roxmltree::Document) -> Result<(), S3Error> {
    if doc.root_element().tag_name().name() == "Error" {
        let code = text_of(doc, "Code").unwrap_or("UnknownError");
        let message = match text_of(doc, "Message") {
            Some(m) => format!("{code}: {m}"),
            None => code.to_string(),
        };
        let retryable = matches!(
            code,
            "InternalError" | "SlowDown" | "RequestTimeout" | "ServiceUnavailable"
        );
        return Err(S3Error::Provider {
            status: 200,
            message,
            retryable, // Only transient errors are retryable per AWS guidance
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

/// Parse the CompleteMultipartUpload response. Unlike `parse_initiate_response`,
/// an XML parse failure here is mapped to a *retryable* `Provider` error, not
/// `InvalidResponse`: AWS documents that Complete can stream whitespace and
/// then die mid-response, and retrying Complete with the same parts is the
/// documented remedy. A response that parses fine but lacks an ETag is a
/// different failure (a genuinely malformed success body) and stays
/// `InvalidResponse`.
fn parse_complete_response(xml: &[u8]) -> Result<String, S3Error> {
    let doc = parse_xml(xml).map_err(|e| S3Error::Provider {
        status: 200,
        message: format!("unparseable complete response: {e}"),
        retryable: true,
    })?;
    check_error_body(&doc)?;
    text_of(&doc, "ETag")
        .map(str::to_string)
        .ok_or_else(|| S3Error::InvalidResponse("complete response missing ETag".into()))
}

/// An in-progress (possibly dangling) multipart upload, for reconciliation
/// cleanup (spec §6).
#[derive(Debug, Clone)]
pub struct MultipartUploadInfo {
    pub key: String,
    pub upload_id: String,
    pub initiated: String,
}

/// Parses one page of `ListMultipartUploadsResult`. Returns
/// `(uploads, is_truncated, next_key_marker, next_upload_id_marker)` so
/// [`S3Client::list_multipart_uploads`] can loop `key-marker` /
/// `upload-id-marker` until the provider stops truncating.
#[allow(clippy::type_complexity)]
fn parse_list_uploads_page(
    xml: &[u8],
) -> Result<
    (
        Vec<MultipartUploadInfo>,
        bool,
        Option<String>,
        Option<String>,
    ),
    S3Error,
> {
    let doc = parse_xml(xml)?;
    check_error_body(&doc)?;
    let mut uploads = Vec::new();
    for upload in doc
        .descendants()
        .filter(|n| n.tag_name().name() == "Upload")
    {
        let child_text = |tag: &str| {
            upload
                .children()
                .find(|n| n.tag_name().name() == tag)
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
    let is_truncated = text_of(&doc, "IsTruncated") == Some("true");
    let next_key_marker = text_of(&doc, "NextKeyMarker").map(str::to_string);
    let next_upload_id_marker = text_of(&doc, "NextUploadIdMarker").map(str::to_string);
    Ok((
        uploads,
        is_truncated,
        next_key_marker,
        next_upload_id_marker,
    ))
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
            expires_secs,
        }
    }

    /// Presigned single PUT for files at or below [`MULTIPART_THRESHOLD`].
    ///
    /// The stored Content-Type comes from the browser `Blob` at PUT time —
    /// this presigned URL doesn't pin it, so it travels unsigned but is
    /// still accepted by the provider.
    pub fn presign_put(&self, key: &str, expires_secs: u64) -> PresignedRequest {
        debug_assert!(expires_secs <= 604_800, "SigV4 caps expiry at 7 days");
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
        debug_assert!(
            (1..=10_000).contains(&part_number),
            "part_number must be within S3's 1..=10_000 range"
        );
        debug_assert!(expires_secs <= 604_800, "SigV4 caps expiry at 7 days");
        let part = part_number.to_string();
        self.presign(
            "PUT",
            key,
            &[("partNumber", &part), ("uploadId", upload_id)],
            expires_secs,
        )
    }

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

    /// Finish a multipart upload. `parts` are (1-based part number, ETag);
    /// order doesn't matter, [`build_complete_body`] sorts them. Detects the
    /// 200-with-`<Error>`-body trap.
    pub async fn complete_multipart_upload(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[(u32, String)],
    ) -> Result<String, S3Error> {
        if parts.is_empty() {
            return Err(S3Error::InvalidResponse(
                "complete called with no parts".into(),
            ));
        }
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
    pub async fn abort_multipart_upload(&self, key: &str, upload_id: &str) -> Result<(), S3Error> {
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

    /// List in-progress multipart uploads (reconciliation cleanup, spec §6).
    /// Follows `key-marker`/`upload-id-marker` pagination until the provider
    /// stops truncating the result.
    pub async fn list_multipart_uploads(&self) -> Result<Vec<MultipartUploadInfo>, S3Error> {
        let mut all = Vec::new();
        let mut key_marker: Option<String> = None;
        let mut upload_id_marker: Option<String> = None;
        loop {
            let mut query: Vec<(&str, &str)> = vec![("uploads", "")];
            if let Some(km) = key_marker.as_deref() {
                query.push(("key-marker", km));
            }
            if let Some(uim) = upload_id_marker.as_deref() {
                query.push(("upload-id-marker", uim));
            }
            let response = self
                .send(reqwest::Method::GET, None, &query, &[], None)
                .await?;
            let body = response
                .bytes()
                .await
                .map_err(|e| S3Error::Network(e.to_string()))?;
            let (uploads, is_truncated, next_key_marker, next_upload_id_marker) =
                parse_list_uploads_page(&body)?;
            all.extend(uploads);
            if !is_truncated {
                return Ok(all);
            }
            key_marker = Some(next_key_marker.ok_or_else(|| {
                S3Error::InvalidResponse(
                    "truncated multipart upload list without a key marker".into(),
                )
            })?);
            upload_id_marker = next_upload_id_marker;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_complete_body, parse_complete_response, parse_initiate_response,
        parse_list_uploads_page, plan_upload, UploadPlan, MAX_PARTS,
    };
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
            UploadPlan::Multipart {
                part_size: 64 * MIB,
                part_count: 2
            }
        );
        // 6 GiB video: 96 parts of 64 MiB
        let plan = plan_upload(6 * 1024 * MIB);
        assert_eq!(
            plan,
            UploadPlan::Multipart {
                part_size: 64 * MIB,
                part_count: 96
            }
        );
    }

    #[test]
    fn part_size_scales_up_beyond_10k_parts() {
        // 1 TiB at 64 MiB/part would need 16384 parts → part size must grow.
        let size = 1024 * 1024 * MIB;
        let UploadPlan::Multipart {
            part_size,
            part_count,
        } = plan_upload(size)
        else {
            panic!("expected multipart");
        };
        assert!(u64::from(part_count) <= MAX_PARTS);
        assert!(part_size > 64 * MIB);
        assert_eq!(part_size % MIB, 0, "part size stays MiB-aligned");
        assert!(
            u64::from(part_count) * part_size >= size,
            "parts must cover the file"
        );
    }

    #[test]
    fn presign_put_produces_signed_put_url() {
        let req = client().presign_put("photos/2026/IMG 0001.jpg", 3600);
        assert_eq!(req.method, "PUT");
        assert!(req
            .url
            .starts_with("https://s3.example.com:9000/photos/photos/2026/IMG%200001.jpg?"));
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
    fn builds_complete_request_body_sorts_out_of_order_parts() {
        // PR 10 uploads several parts concurrently, so completion order is
        // not upload order — S3 rejects out-of-order parts outright.
        let parts = vec![(2, "b".to_string()), (1, "a".to_string())];
        let body = build_complete_body(&parts);
        assert_eq!(
            body,
            "<CompleteMultipartUpload>\
             <Part><PartNumber>1</PartNumber><ETag>a</ETag></Part>\
             <Part><PartNumber>2</PartNumber><ETag>b</ETag></Part>\
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

    #[test]
    fn truncated_complete_response_is_retryable() {
        // AWS documents Complete streaming whitespace and then possibly
        // dying mid-response; retrying with the same parts is the
        // documented remedy, so this must be retryable, not InvalidResponse.
        let err = parse_complete_response(b"<truncated").unwrap_err();
        assert!(err.is_retryable(), "got: {err}");
    }

    #[test]
    fn parses_namespaced_initiate_response() {
        let xml = r#"<?xml version="1.0"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <UploadId>ns-uid</UploadId>
</InitiateMultipartUploadResult>"#;
        assert_eq!(parse_initiate_response(xml.as_bytes()).unwrap(), "ns-uid");
    }

    #[test]
    fn parses_namespaced_complete_response() {
        let xml = r#"<?xml version="1.0"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <ETag>"ns-etag"</ETag>
</CompleteMultipartUploadResult>"#;
        assert_eq!(
            parse_complete_response(xml.as_bytes()).unwrap(),
            "\"ns-etag\""
        );
    }

    #[test]
    fn complete_error_body_retryability_depends_on_code() {
        let transient = br#"<Error><Code>InternalError</Code><Message>x</Message></Error>"#;
        assert!(parse_complete_response(transient)
            .unwrap_err()
            .is_retryable());
        let permanent = br#"<Error><Code>InvalidPart</Code><Message>x</Message></Error>"#;
        assert!(!parse_complete_response(permanent)
            .unwrap_err()
            .is_retryable());
    }

    #[test]
    fn parses_list_multipart_uploads() {
        let xml = r#"<?xml version="1.0"?>
<ListMultipartUploadsResult>
  <Bucket>photos</Bucket>
  <IsTruncated>false</IsTruncated>
  <Upload>
    <Key>big.bin</Key><UploadId>uid-1</UploadId>
    <Initiated>2026-07-15T10:00:00.000Z</Initiated>
  </Upload>
  <Upload>
    <Key>other.mp4</Key><UploadId>uid-2</UploadId>
    <Initiated>2026-07-15T11:00:00.000Z</Initiated>
  </Upload>
</ListMultipartUploadsResult>"#;
        let (uploads, is_truncated, next_key_marker, next_upload_id_marker) =
            parse_list_uploads_page(xml.as_bytes()).unwrap();
        assert_eq!(uploads.len(), 2);
        assert_eq!(uploads[0].key, "big.bin");
        assert_eq!(uploads[0].upload_id, "uid-1");
        assert_eq!(uploads[0].initiated, "2026-07-15T10:00:00.000Z");
        assert_eq!(uploads[1].upload_id, "uid-2");
        assert!(!is_truncated);
        assert!(next_key_marker.is_none());
        assert!(next_upload_id_marker.is_none());
    }

    #[test]
    fn parses_empty_upload_list() {
        let xml = b"<ListMultipartUploadsResult></ListMultipartUploadsResult>";
        let (uploads, is_truncated, ..) = parse_list_uploads_page(xml).unwrap();
        assert!(uploads.is_empty());
        assert!(!is_truncated);
    }

    #[test]
    fn parses_truncated_list_with_markers() {
        let xml = r#"<?xml version="1.0"?>
<ListMultipartUploadsResult>
  <IsTruncated>true</IsTruncated>
  <NextKeyMarker>big.bin</NextKeyMarker>
  <NextUploadIdMarker>uid-1</NextUploadIdMarker>
  <Upload>
    <Key>big.bin</Key><UploadId>uid-1</UploadId>
    <Initiated>2026-07-15T10:00:00.000Z</Initiated>
  </Upload>
</ListMultipartUploadsResult>"#;
        let (uploads, is_truncated, next_key_marker, next_upload_id_marker) =
            parse_list_uploads_page(xml.as_bytes()).unwrap();
        assert_eq!(uploads.len(), 1);
        assert!(is_truncated);
        assert_eq!(next_key_marker.as_deref(), Some("big.bin"));
        assert_eq!(next_upload_id_marker.as_deref(), Some("uid-1"));
    }
}
