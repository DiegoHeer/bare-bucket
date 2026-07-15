// Exercises the built WASM bindings end-to-end from Node against the local
// MinIO container: constructor, validate, reconcile, load_manifest.
// Usage: node scripts/wasm-smoke.mjs  (requires `docker compose up -d minio`
// + createbucket, and `wasm-pack build core --target web` beforehand)
//
// The bucket must contain at least one object so the smoke can exercise the
// per-object Option->null boundary check. CI seeds one automatically; for a
// local run, seed it yourself first:
//   printf 'ci-seed' > /tmp/seed.txt
//   docker compose run --rm -v /tmp/seed.txt:/seed.txt:z --entrypoint sh createbucket \
//     -c "mc alias set local http://minio:9000 baretest baretest123 && mc cp /seed.txt local/bare-bucket-it/ci-seed/seed.txt"
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

if (manifest.objects.length > 0) {
  const first = manifest.objects[0];
  if (first.deleted_at !== null || first.thumbnail_key !== null) {
    throw new Error(`Option fields must cross as null, got deleted_at=${String(first.deleted_at)} thumbnail_key=${String(first.thumbnail_key)}`);
  }
  console.log("option-null check: ok");
} else {
  throw new Error(
    "smoke expects at least one object so the Option→null branch is exercised — seed the bucket first",
  );
}

console.log("SMOKE OK");
