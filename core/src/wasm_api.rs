//! The JS-facing boundary: everything the web shell calls crosses here.
//!
//! Concurrency contract (PR 6 carry-forward): `manifest_write_lock` MUST be
//! held for every manifest-mutating operation — reconcile now; upsert,
//! tombstone, favorite, and thumbnail-key methods as they land. Reconcile
//! replaces the whole `objects` Vec from a LIST snapshot, so a concurrent
//! unserialized mutation would be silently erased.

use std::rc::Rc;

use wasm_bindgen::prelude::*;

use crate::manifest::ManifestStore;
use crate::reconcile::{reconcile, ReconcileOptions};
use crate::s3::{S3Client, S3Config};
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
        serde_wasm_bindgen::to_value(&SerializableReport::from(&report)).map_err(js_error)
    }

    /// Load and decode the manifest (read-only — no lock needed).
    pub async fn load_manifest(&self) -> Result<JsValue, JsError> {
        let store = ManifestStore::new(&self.inner.client, &self.inner.device_id);
        let loaded = store.load().await.map_err(js_error)?;
        serde_wasm_bindgen::to_value(&loaded.manifest).map_err(js_error)
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
