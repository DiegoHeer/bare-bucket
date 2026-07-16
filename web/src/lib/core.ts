// Wasm bootstrap + the typed surface of the core bindings.
import init, { WasmClient } from "bare-bucket-core";

export interface ClientConfig {
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  deviceId: string;
}

// Manifest shapes cross the boundary with the core's snake_case field names
// (design spec §4.1) — deliberately not renamed.
export interface ManifestObject {
  key: string;
  size: number;
  etag: string;
  last_modified: string;
  content_type: string;
  favorite: boolean;
  thumbnail_key: string | null;
  deleted_at: string | null;
}

export interface Manifest {
  schema_version: number;
  last_full_rebuild_at: string | null;
  last_writer_device_id: string;
  objects: ManifestObject[];
}

export interface ReconcileReport {
  added: number;
  updated: number;
  removed: number;
  thumbnails_deleted: number;
  uploads_aborted: number;
  conditional: boolean;
}

// Upload surface (PR 10). `WasmClient`'s upload_plan/presign_put/
// presign_upload_part return `any` from the generated .d.ts (serde-erased
// at the wasm boundary) — these mirror wasm_api.rs's Serializable* shapes
// so call sites can cast instead of re-declaring the shape ad hoc.
export type UploadPlan =
  | { kind: "single" }
  | { kind: "multipart"; part_size: number; part_count: number };

export interface PresignedRequest {
  method: string;
  url: string;
  expires_secs: number;
}

export interface HeadResult {
  etag: string;
  size: number;
}

// `WasmClient::delete_object`'s report (PR 12, core/src/wasm_api.rs's
// `DeleteReport`) — snake_case, no serde rename on this struct. `deleted` is
// `!already_absent` (polish item 4): callers must still gate success on the
// returned promise RESOLVING, not on this field — `deleted: false` on an
// already-tombstoned key is a successful no-op, not a failure.
export interface DeleteReport {
  deleted: boolean;
  thumbnail_deleted: boolean | null;
  already_absent: boolean;
}

// `WasmClient::set_thumbnail`'s report (PR 14 [B2], core/src/wasm_api.rs's
// `SetThumbnailReport`): `updated` is `false` for the found-flag mutator's
// no-op cases (absent key, tombstoned row, identical value) — no PUT was
// issued and the caller must not assume the manifest changed.
export interface SetThumbnailReport {
  updated: boolean;
}

let initialized: Promise<void> | null = null;

/** Idempotent wasm module initialization. */
export function initCore(): Promise<void> {
  initialized ??= init().then(() => undefined);
  return initialized;
}

export function coreVersion(): string {
  return WasmClient.core_version();
}

export function createClient(config: ClientConfig): WasmClient {
  return new WasmClient(config);
}

export type { WasmClient };
