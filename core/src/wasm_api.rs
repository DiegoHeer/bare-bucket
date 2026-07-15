//! The JS-facing boundary: everything the web shell calls crosses here.
//!
//! Concurrency contract (PR 6 carry-forward): `manifest_write_lock` MUST be
//! held for every manifest-mutating operation — reconcile now; upsert,
//! tombstone, favorite, and thumbnail-key methods as they land. Reconcile
//! replaces the whole `objects` Vec from a LIST snapshot, so a concurrent
//! unserialized mutation would be silently erased.

use std::rc::Rc;

use wasm_bindgen::prelude::*;

use crate::manifest::{now_iso8601, ManifestObject, ManifestStore};
use crate::reconcile::{reconcile, ReconcileOptions};
use crate::s3::{plan_upload, HeadResult, PresignedRequest, S3Client, S3Config, UploadPlan};
use crate::signer::Credentials;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsConfig {
    endpoint: String,
    region: String,
    bucket: String,
    path_style: bool,
    access_key_id: String,
    secret_access_key: String,
    device_id: String,
}

struct Inner {
    client: S3Client,
    device_id: String,
    /// Serializes ALL manifest writers (see module docs).
    manifest_write_lock: async_lock::Mutex<()>,
}

#[wasm_bindgen]
pub struct WasmClient {
    inner: Rc<Inner>,
}

fn js_error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// json_compatible: Option::None → null (not undefined), matching the
/// declared TS types and spec §4.1.
fn to_js<T: serde::Serialize>(value: &T) -> Result<JsValue, JsError> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(js_error)
}

/// JS numbers are IEEE-754 f64; file sizes cross the boundary as `number`
/// rather than `bigint` since even a multi-terabyte file stays well within
/// 2^53. Guard against NaN/negative/fractional input before the `as u64`
/// cast, which would otherwise silently truncate or saturate to 0.
fn size_from_js(size: f64) -> Result<u64, JsError> {
    if !size.is_finite() || size < 0.0 || size.fract() != 0.0 {
        return Err(JsError::new(&format!(
            "size must be a non-negative whole number, got {size}"
        )));
    }
    Ok(size as u64)
}

#[wasm_bindgen]
impl WasmClient {
    /// `config`: `{ endpoint, region, bucket, pathStyle, accessKeyId,
    /// secretAccessKey, deviceId }`. The secret lives only inside this
    /// instance's memory (spec §8.2).
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<WasmClient, JsError> {
        let js: JsConfig = serde_wasm_bindgen::from_value(config).map_err(js_error)?;
        let client = S3Client::new(S3Config {
            endpoint: js.endpoint,
            region: js.region,
            bucket: js.bucket,
            path_style: js.path_style,
            credentials: Credentials {
                access_key_id: js.access_key_id,
                secret_access_key: js.secret_access_key,
            },
        })
        .map_err(js_error)?;
        Ok(WasmClient {
            inner: Rc::new(Inner {
                client,
                device_id: js.device_id,
                manifest_write_lock: async_lock::Mutex::new(()),
            }),
        })
    }

    pub fn core_version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    /// Cheap connectivity + credential check (HEAD on the bucket).
    pub async fn validate(&self) -> Result<(), JsError> {
        self.inner.client.head_bucket().await.map_err(js_error)
    }

    /// Full-bucket reconciliation (Refresh / app-open / bootstrap).
    /// `active_upload_ids`: multipart uploads this session has in flight
    /// (empty until the upload manager exists — PR 10).
    pub async fn reconcile(&self, active_upload_ids: Vec<String>) -> Result<JsValue, JsError> {
        let _write = self.inner.manifest_write_lock.lock().await;
        let report = reconcile(
            &self.inner.client,
            &self.inner.device_id,
            &ReconcileOptions {
                active_upload_ids: &active_upload_ids,
                min_upload_age_secs: 3600,
            },
        )
        .await
        .map_err(js_error)?;
        to_js(&SerializableReport::from(&report))
    }

    /// Load and decode the manifest (read-only — no lock needed).
    pub async fn load_manifest(&self) -> Result<JsValue, JsError> {
        let store = ManifestStore::new(&self.inner.client, &self.inner.device_id);
        let loaded = store.load().await.map_err(js_error)?;
        to_js(&loaded.manifest)
    }

    /// Star/unstar an object. Holds the manifest writer lock (see module
    /// docs) for the read→mutate→conditional-PUT cycle.
    pub async fn set_favorite(&self, key: String, favorite: bool) -> Result<(), JsError> {
        let _write = self.inner.manifest_write_lock.lock().await;
        let store = ManifestStore::new(&self.inner.client, &self.inner.device_id);
        // The lock serializes all writers, so the mutator's LAST run is the one
        // whose result got written; checking the captured flag after
        // update_with_retry therefore reflects the persisted manifest version.
        let mut found = false;
        store
            .update_with_retry(|m| {
                found = m.set_favorite(&key, favorite);
            })
            .await
            .map_err(js_error)?;
        if !found {
            return Err(JsError::new(&format!("unknown key: {key}")));
        }
        Ok(())
    }

    /// Decide the upload strategy for a file of `size` bytes (spec §5.1).
    pub fn upload_plan(&self, size: f64) -> Result<JsValue, JsError> {
        let size = size_from_js(size)?;
        to_js(&SerializableUploadPlan::from(&plan_upload(size)))
    }

    /// Presigned single PUT for files at or below the multipart threshold.
    /// `expires_secs` is `u32` (not the core client's `u64`) purely so it
    /// crosses the wasm boundary as a plain JS `number` rather than a
    /// `BigInt` — SigV4 expiry is capped at 7 days (604_800s) regardless.
    pub fn presign_put(&self, key: String, expires_secs: u32) -> Result<JsValue, JsError> {
        to_js(&SerializablePresignedRequest::from(
            &self.inner.client.presign_put(&key, expires_secs.into()),
        ))
    }

    /// Start a multipart upload; returns the provider's upload ID.
    pub async fn create_multipart_upload(
        &self,
        key: String,
        content_type: String,
    ) -> Result<String, JsError> {
        self.inner
            .client
            .create_multipart_upload(&key, &content_type)
            .await
            .map_err(js_error)
    }

    /// Presigned UploadPart PUT. `part_number` is 1-based. `expires_secs` is
    /// `u32` for the same reason as [`Self::presign_put`].
    pub fn presign_upload_part(
        &self,
        key: String,
        upload_id: String,
        part_number: u32,
        expires_secs: u32,
    ) -> Result<JsValue, JsError> {
        to_js(&SerializablePresignedRequest::from(
            &self.inner.client.presign_upload_part(
                &key,
                &upload_id,
                part_number,
                expires_secs.into(),
            ),
        ))
    }

    /// Finish a multipart upload. `parts` crosses as
    /// `[{ part_number, etag }]` (JS array of plain objects).
    pub async fn complete_multipart_upload(
        &self,
        key: String,
        upload_id: String,
        parts: JsValue,
    ) -> Result<String, JsError> {
        let parts: Vec<JsPart> = serde_wasm_bindgen::from_value(parts).map_err(js_error)?;
        let parts: Vec<(u32, String)> =
            parts.into_iter().map(|p| (p.part_number, p.etag)).collect();
        self.inner
            .client
            .complete_multipart_upload(&key, &upload_id, &parts)
            .await
            .map_err(js_error)
    }

    /// Abort a multipart upload so half-uploaded parts stop accruing storage.
    pub async fn abort_multipart_upload(
        &self,
        key: String,
        upload_id: String,
    ) -> Result<(), JsError> {
        self.inner
            .client
            .abort_multipart_upload(&key, &upload_id)
            .await
            .map_err(js_error)
    }

    /// HEAD an object; `null` when it does not exist.
    pub async fn head_object(&self, key: String) -> Result<JsValue, JsError> {
        let result = self
            .inner
            .client
            .head_object(&key)
            .await
            .map_err(js_error)?;
        to_js(&result.as_ref().map(SerializableHeadResult::from))
    }

    /// Record a completed upload in the manifest. Holds the manifest writer
    /// lock (see module docs) for the read→mutate→conditional-PUT cycle.
    ///
    /// `favorite` is preserved from any existing row (re-uploading over a
    /// favorite keeps the star). `thumbnail_key` is preserved only when the
    /// existing row's etag matches the new one (content unchanged); it is
    /// cleared when the etag differs, since a stale thumbnail would show the
    /// old content.
    pub async fn upsert_object(
        &self,
        key: String,
        size: f64,
        etag: String,
        content_type: String,
    ) -> Result<(), JsError> {
        let size = size_from_js(size)?;
        let _write = self.inner.manifest_write_lock.lock().await;
        let store = ManifestStore::new(&self.inner.client, &self.inner.device_id);
        // Computed once, outside the closure: the mutator may run multiple
        // times across retries and must be a pure function of the loaded
        // manifest plus these captured values (see update_with_retry docs).
        let last_modified = now_iso8601();
        store
            .update_with_retry(|m| {
                let (favorite, thumbnail_key) = match m.get(&key) {
                    Some(existing) => (
                        existing.favorite,
                        if existing.etag == etag {
                            existing.thumbnail_key.clone()
                        } else {
                            None
                        },
                    ),
                    None => (false, None),
                };
                m.upsert(ManifestObject {
                    key: key.clone(),
                    size,
                    etag: etag.clone(),
                    last_modified: last_modified.clone(),
                    content_type: content_type.clone(),
                    favorite,
                    thumbnail_key,
                    deleted_at: None,
                });
            })
            .await
            .map_err(js_error)?;
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct JsPart {
    part_number: u32,
    etag: String,
}

/// Mirrors [`UploadPlan`] as a tagged union (`{ kind: "single" }` or
/// `{ kind: "multipart", part_size, part_count }`) for the JS boundary.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum SerializableUploadPlan {
    Single,
    Multipart { part_size: u64, part_count: u32 },
}

impl From<&UploadPlan> for SerializableUploadPlan {
    fn from(plan: &UploadPlan) -> Self {
        match plan {
            UploadPlan::SinglePut => SerializableUploadPlan::Single,
            UploadPlan::Multipart {
                part_size,
                part_count,
            } => SerializableUploadPlan::Multipart {
                part_size: *part_size,
                part_count: *part_count,
            },
        }
    }
}

#[derive(serde::Serialize)]
struct SerializablePresignedRequest {
    method: String,
    url: String,
    expires_secs: u64,
}

impl From<&PresignedRequest> for SerializablePresignedRequest {
    fn from(req: &PresignedRequest) -> Self {
        SerializablePresignedRequest {
            method: req.method.clone(),
            url: req.url.clone(),
            expires_secs: req.expires_secs,
        }
    }
}

#[derive(serde::Serialize)]
struct SerializableHeadResult {
    etag: String,
    size: u64,
}

impl From<&HeadResult> for SerializableHeadResult {
    fn from(result: &HeadResult) -> Self {
        SerializableHeadResult {
            etag: result.etag.clone(),
            size: result.size,
        }
    }
}

/// ReconcileReport mirror with serde derive (the core struct deliberately
/// carries no serde impls; this keeps the boundary shape explicit).
#[derive(serde::Serialize)]
struct SerializableReport {
    added: u32,
    updated: u32,
    removed: u32,
    thumbnails_deleted: u32,
    uploads_aborted: u32,
    conditional: bool,
}

impl From<&crate::reconcile::ReconcileReport> for SerializableReport {
    fn from(r: &crate::reconcile::ReconcileReport) -> Self {
        SerializableReport {
            added: r.added,
            updated: r.updated,
            removed: r.removed,
            thumbnails_deleted: r.thumbnails_deleted,
            uploads_aborted: r.uploads_aborted,
            conditional: r.conditional,
        }
    }
}
