//! S3-compatible HTTP client: signed control-plane operations
//! (HEAD/GET/PUT/DELETE/LIST) against any SigV4 provider.
//!
//! Bodies here are in-memory byte slices — this client carries the manifest,
//! thumbnails, and API XML only. Bulk file transfer stays outside the core
//! (spec §3.3); PR 4 adds multipart *descriptors* for the UI to execute.

pub mod error;
mod list;

pub use error::S3Error;
pub use list::{ListPage, ObjectInfo};

use crate::signer::{
    authorization_header, canonical_query_string, sha256_hex, sign, uri_encode, CanonicalRequest,
    Credentials, SigningContext, EMPTY_PAYLOAD_SHA256,
};

pub struct S3Config {
    /// Scheme + authority, e.g. `https://s3.example.com:9000` — no trailing slash.
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    /// `true` for MinIO/RustFS-style path addressing (`host/bucket/key`);
    /// `false` for virtual-hosted (`bucket.host/key`, R2/AWS).
    pub path_style: bool,
    pub credentials: Credentials,
}

#[derive(Debug)]
pub struct GetResult {
    pub bytes: Vec<u8>,
    pub etag: String,
}

#[derive(Debug)]
pub struct PutResult {
    pub etag: String,
}

pub struct S3Client {
    config: S3Config,
    scheme: String,
    authority: String,
    http: reqwest::Client,
    max_retries: u32,
}

pub(crate) struct Target {
    pub url: String,
    pub host: String,
    pub uri_path: String,
}

impl S3Client {
    pub fn new(config: S3Config) -> Result<Self, S3Error> {
        let (scheme, authority) = config.endpoint.split_once("://").ok_or_else(|| {
            S3Error::Config(format!("endpoint must include scheme: {}", config.endpoint))
        })?;
        if authority.is_empty() || authority.contains('/') {
            return Err(S3Error::Config(format!(
                "endpoint must be scheme://host[:port] with no path: {}",
                config.endpoint
            )));
        }
        Ok(S3Client {
            scheme: scheme.to_string(),
            authority: authority.to_string(),
            http: reqwest::Client::new(),
            max_retries: 3,
            config,
        })
    }

    /// URL, host header value, and signable URI path for an object key (or
    /// the bucket root when `key` is `None`). The query string is built with
    /// the signer's own encoder so signed bytes always equal wire bytes.
    pub(crate) fn target(&self, key: Option<&str>, query: &[(&str, &str)]) -> Target {
        let encoded_key = key.map(|k| uri_encode(k, false)).unwrap_or_default();
        let (host, uri_path) = if self.config.path_style {
            let path = if encoded_key.is_empty() {
                format!("/{}", self.config.bucket)
            } else {
                format!("/{}/{}", self.config.bucket, encoded_key)
            };
            (self.authority.clone(), path)
        } else {
            (
                format!("{}.{}", self.config.bucket, self.authority),
                format!("/{encoded_key}"),
            )
        };
        let query_string = canonical_query_string(query);
        let url = if query_string.is_empty() {
            format!("{}://{}{}", self.scheme, host, uri_path)
        } else {
            format!("{}://{}{}?{}", self.scheme, host, uri_path, query_string)
        };
        Target {
            url,
            host,
            uri_path,
        }
    }

    /// Sign and send one request, retrying retryable failures with backoff.
    /// The single place where the payload hash is computed and where the
    /// signing timestamp is read — headers and signature cannot drift.
    async fn send(
        &self,
        method: reqwest::Method,
        key: Option<&str>,
        query: &[(&str, &str)],
        extra_headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<reqwest::Response, S3Error> {
        let payload_hash = match body {
            Some(bytes) => sha256_hex(bytes),
            None => EMPTY_PAYLOAD_SHA256.to_string(),
        };
        let target = self.target(key, query);
        let mut attempt: u32 = 0;
        loop {
            let timestamp = now_timestamp();
            let mut headers: Vec<(&str, &str)> = vec![
                ("host", &target.host),
                ("x-amz-content-sha256", &payload_hash),
                ("x-amz-date", &timestamp),
            ];
            headers.extend_from_slice(extra_headers);
            let ctx = SigningContext {
                credentials: &self.config.credentials,
                region: &self.config.region,
                service: "s3",
                timestamp: &timestamp,
            };
            let canonical = CanonicalRequest {
                method: method.as_str(),
                uri_path: &target.uri_path,
                query,
                headers: &headers,
                payload_hash: &payload_hash,
            };
            let auth = authorization_header(&ctx, &sign(&ctx, &canonical));

            let mut request = self
                .http
                .request(method.clone(), &target.url)
                .header("authorization", auth)
                .header("x-amz-content-sha256", &payload_hash)
                .header("x-amz-date", &timestamp);
            for (name, value) in extra_headers {
                request = request.header(*name, *value);
            }
            if let Some(bytes) = body {
                request = request.body(bytes.to_vec());
            }

            let error = match request.send().await {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status().as_u16();
                    let text = response.text().await.unwrap_or_default();
                    classify(status, key, text)
                }
                Err(e) => S3Error::Network(e.to_string()),
            };
            attempt += 1;
            if !error.is_retryable() || attempt > self.max_retries {
                return Err(error);
            }
            sleep_ms(backoff_ms(attempt)).await;
        }
    }

    /// One page of ListObjectsV2 results.
    pub async fn list_page(
        &self,
        prefix: Option<&str>,
        continuation_token: Option<&str>,
        max_keys: Option<u32>,
    ) -> Result<ListPage, S3Error> {
        let max_keys_value;
        let mut query: Vec<(&str, &str)> = vec![("list-type", "2")];
        if let Some(p) = prefix {
            query.push(("prefix", p));
        }
        if let Some(t) = continuation_token {
            query.push(("continuation-token", t));
        }
        if let Some(m) = max_keys {
            max_keys_value = m.to_string();
            query.push(("max-keys", &max_keys_value));
        }
        let response = self
            .send(reqwest::Method::GET, None, &query, &[], None)
            .await?;
        let body = response
            .bytes()
            .await
            .map_err(|e| S3Error::Network(e.to_string()))?;
        list::parse_list_response(&body)
    }

    /// Every object under `prefix`, following continuation tokens.
    pub async fn list_all(&self, prefix: Option<&str>) -> Result<Vec<ObjectInfo>, S3Error> {
        let mut all = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let page = self.list_page(prefix, token.as_deref(), None).await?;
            all.extend(page.objects);
            if !page.is_truncated {
                return Ok(all);
            }
            token = Some(page.next_continuation_token.ok_or_else(|| {
                S3Error::InvalidResponse("truncated list without continuation token".into())
            })?);
        }
    }

    /// Cheap connectivity/credential check: HEAD on the bucket root.
    pub async fn head_bucket(&self) -> Result<(), S3Error> {
        self.send(reqwest::Method::HEAD, None, &[], &[], None)
            .await
            .map(|_| ())
    }

    pub async fn get_object(&self, key: &str) -> Result<GetResult, S3Error> {
        let response = self
            .send(reqwest::Method::GET, Some(key), &[], &[], None)
            .await?;
        let etag = required_header(&response, "etag")?;
        let bytes = response
            .bytes()
            .await
            .map_err(|e| S3Error::Network(e.to_string()))?
            .to_vec();
        Ok(GetResult { bytes, etag })
    }

    /// PUT an object. `if_match` adds a conditional write on the current
    /// ETag (manifest conflict handling, spec §4.2); providers that ignore
    /// it degrade to last-writer-wins.
    pub async fn put_object(
        &self,
        key: &str,
        body: &[u8],
        content_type: &str,
        if_match: Option<&str>,
    ) -> Result<PutResult, S3Error> {
        let mut extra: Vec<(&str, &str)> = vec![("content-type", content_type)];
        if let Some(etag) = if_match {
            extra.push(("if-match", etag));
        }
        let response = self
            .send(reqwest::Method::PUT, Some(key), &[], &extra, Some(body))
            .await?;
        Ok(PutResult {
            etag: required_header(&response, "etag")?,
        })
    }

    pub async fn delete_object(&self, key: &str) -> Result<(), S3Error> {
        self.send(reqwest::Method::DELETE, Some(key), &[], &[], None)
            .await
            .map(|_| ())
    }
}

async fn sleep_ms(ms: u64) {
    #[cfg(target_arch = "wasm32")]
    gloo_timers::future::TimeoutFuture::new(ms as u32).await;
    #[cfg(not(target_arch = "wasm32"))]
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

fn backoff_ms(attempt: u32) -> u64 {
    // 200ms, 800ms, 3200ms
    200 * 4u64.pow(attempt - 1)
}

fn classify(status: u16, key: Option<&str>, body: String) -> S3Error {
    let message: String = body.chars().take(500).collect();
    match status {
        404 => S3Error::NotFound {
            key: key.unwrap_or_default().to_string(),
        },
        412 => S3Error::PreconditionFailed,
        403 => S3Error::AccessDenied { message },
        429 | 500..=599 => S3Error::Provider {
            status,
            message,
            retryable: true,
        },
        _ => S3Error::Provider {
            status,
            message,
            retryable: false,
        },
    }
}

fn required_header(response: &reqwest::Response, name: &str) -> Result<String, S3Error> {
    response
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| S3Error::InvalidResponse(format!("missing {name} header")))
}

/// Current UTC time in ISO8601 basic format (`YYYYMMDDTHHMMSSZ`) — the single
/// time source for both the signing context and the `x-amz-date` header.
pub(crate) fn now_timestamp() -> String {
    let format = time::macros::format_description!("[year][month][day]T[hour][minute][second]Z");
    time::OffsetDateTime::now_utc()
        .format(&format)
        .expect("static format cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signer::Credentials;

    fn config(path_style: bool) -> S3Config {
        S3Config {
            endpoint: "https://s3.example.com:9000".to_string(),
            region: "us-east-1".to_string(),
            bucket: "photos".to_string(),
            path_style,
            credentials: Credentials {
                access_key_id: "AKID".to_string(),
                secret_access_key: "SECRET".to_string(),
            },
        }
    }

    #[test]
    fn client_rejects_endpoint_without_scheme() {
        let mut cfg = config(true);
        cfg.endpoint = "s3.example.com".to_string();
        assert!(matches!(S3Client::new(cfg), Err(S3Error::Config(_))));
    }

    #[test]
    fn path_style_target_puts_bucket_in_path() {
        let client = S3Client::new(config(true)).unwrap();
        let t = client.target(Some("photos/2026/IMG 0001.jpg"), &[]);
        assert_eq!(t.host, "s3.example.com:9000");
        assert_eq!(t.uri_path, "/photos/photos/2026/IMG%200001.jpg");
        assert_eq!(
            t.url,
            "https://s3.example.com:9000/photos/photos/2026/IMG%200001.jpg"
        );
    }

    #[test]
    fn virtual_hosted_target_puts_bucket_in_host() {
        let client = S3Client::new(config(false)).unwrap();
        let t = client.target(Some("a.txt"), &[]);
        assert_eq!(t.host, "photos.s3.example.com:9000");
        assert_eq!(t.uri_path, "/a.txt");
        assert_eq!(t.url, "https://photos.s3.example.com:9000/a.txt");
    }

    #[test]
    fn bucket_root_targets() {
        let path = S3Client::new(config(true)).unwrap().target(None, &[]);
        assert_eq!(path.uri_path, "/photos");
        let virt = S3Client::new(config(false)).unwrap().target(None, &[]);
        assert_eq!(virt.uri_path, "/");
    }

    #[test]
    fn target_query_string_is_canonical() {
        let client = S3Client::new(config(true)).unwrap();
        let t = client.target(None, &[("prefix", "J"), ("list-type", "2")]);
        assert!(t.url.ends_with("/photos?list-type=2&prefix=J"));
    }

    #[test]
    fn target_url_survives_url_parsing_unchanged() {
        // reqwest parses the URL string; if the url crate normalized our
        // percent-encoding the wire path would diverge from the signed path.
        let client = S3Client::new(config(true)).unwrap();
        let t = client.target(Some("photos/2026/IMG 0001.jpg"), &[]);
        let parsed = reqwest::Url::parse(&t.url).unwrap();
        assert_eq!(parsed.path(), t.uri_path);
    }

    #[test]
    fn now_timestamp_is_iso8601_basic() {
        let ts = now_timestamp();
        assert_eq!(ts.len(), 16);
        assert_eq!(&ts[8..9], "T");
        assert!(ts.ends_with('Z'));
        assert!(ts[..8].chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn retryable_classification() {
        assert!(S3Error::Network("timeout".into()).is_retryable());
        assert!(S3Error::Provider {
            status: 503,
            message: String::new(),
            retryable: true
        }
        .is_retryable());
        assert!(!S3Error::NotFound { key: "k".into() }.is_retryable());
        assert!(!S3Error::PreconditionFailed.is_retryable());
    }
}
