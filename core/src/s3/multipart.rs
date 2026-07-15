//! Upload planning and multipart descriptors.
//!
//! Data-plane bytes never enter the core (spec §3.3): the UI executes the
//! presigned requests built here, slicing the browser `File` per part. Only
//! the small control-plane XML calls go through the client itself.

use super::S3Client;
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

#[cfg(test)]
mod tests {
    use super::{plan_upload, UploadPlan, MAX_PARTS};
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
}
