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
