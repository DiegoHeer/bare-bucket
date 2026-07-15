// Exercises the built WASM bindings end-to-end from Node against the local
// MinIO container: constructor, validate, reconcile, load_manifest.
// Usage: node scripts/wasm-smoke.mjs  (requires `docker compose up -d minio`
// + createbucket, and `wasm-pack build core --target web` beforehand)
import { readFile } from "node:fs/promises";
import init, { WasmClient } from "../core/pkg/bare_bucket_core.js";

const wasm = await readFile(new URL("../core/pkg/bare_bucket_core_bg.wasm", import.meta.url));
await init({ module_or_path: wasm });

console.log("core_version:", WasmClient.core_version());

const client = new WasmClient({
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: "bare-bucket-it",
  pathStyle: true,
  accessKeyId: "baretest",
  secretAccessKey: "baretest123",
  deviceId: "wasm-smoke",
});

await client.validate();
console.log("validate: ok");

const report = await client.reconcile([]);
console.log("reconcile:", JSON.stringify(report));

const manifest = await client.load_manifest();
if (manifest.schema_version !== 1) throw new Error("bad manifest shape");
console.log("load_manifest: ok,", manifest.objects.length, "objects");
console.log("SMOKE OK");
