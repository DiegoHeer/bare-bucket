//! S3-compatible HTTP client: signed control-plane operations
//! (HEAD/GET/PUT/DELETE/LIST) against any SigV4 provider.
//!
//! Bodies here are in-memory byte slices — this client carries the manifest,
//! thumbnails, and API XML only. Bulk file transfer stays outside the core
//! (spec §3.3); PR 4 adds multipart *descriptors* for the UI to execute.

pub mod error;

pub use error::S3Error;

use crate::signer::{canonical_query_string, uri_encode, Credentials};

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

#[allow(dead_code)]
pub struct S3Client {
    config: S3Config,
    scheme: String,
    authority: String,
    http: reqwest::Client,
    max_retries: u32,
}

#[allow(dead_code)]
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
    #[allow(dead_code)]
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
}

/// Current UTC time in ISO8601 basic format (`YYYYMMDDTHHMMSSZ`) — the single
/// time source for both the signing context and the `x-amz-date` header.
#[allow(dead_code)]
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
