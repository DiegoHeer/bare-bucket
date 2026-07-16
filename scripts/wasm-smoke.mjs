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

// Favorite roundtrip (exercises the writer-lock mutation path end-to-end).
const key = manifest.objects[0].key;
await client.set_favorite(key, true);
try {
  const after = await client.load_manifest();
  const starred = after.objects.find((o) => o.key === key);
  if (starred?.favorite !== true) throw new Error("favorite did not persist");
} finally {
  await client.set_favorite(key, false);
}
const reverted = await client.load_manifest();
if (reverted.objects.find((o) => o.key === key)?.favorite !== false) {
  throw new Error("unfavorite did not persist");
}
let threw = false;
try {
  await client.set_favorite("definitely/not/a/key.bin", true);
} catch {
  threw = true;
}
if (!threw) throw new Error("unknown key must throw");
console.log("favorite roundtrip: ok");

// Upload planning: single-PUT vs multipart math.
const singlePlan = client.upload_plan(1000);
if (singlePlan.kind !== "single") throw new Error(`expected single plan, got ${JSON.stringify(singlePlan)}`);
const multipartPlan = client.upload_plan(200 * 1024 * 1024);
if (multipartPlan.kind !== "multipart" || multipartPlan.part_size !== 64 * 1024 * 1024 || multipartPlan.part_count !== 4) {
  throw new Error(`unexpected multipart plan: ${JSON.stringify(multipartPlan)}`);
}
console.log("upload_plan: ok");

// Presigned GET: fetch the seeded object directly, byte-compare against the
// ci-seed content; with an attachment name, the response must carry a
// sanitized Content-Disposition header (spec §5.2 universal download
// fallback).
const seedKey = "ci-seed/seed.txt";
const presignedGet = client.presign_get(seedKey, 60, null);
if (presignedGet.method !== "GET" || !presignedGet.url.startsWith("http")) {
  throw new Error(`bad presigned GET request: ${JSON.stringify(presignedGet)}`);
}
const getResponse = await fetch(presignedGet.url);
if (!getResponse.ok) throw new Error(`presigned GET failed: ${getResponse.status}`);
if (getResponse.headers.get("content-disposition")) {
  throw new Error("no disposition requested, none should be echoed back");
}
const expectedBytes = new TextEncoder().encode("ci-seed");
const gotBytes = new Uint8Array(await getResponse.arrayBuffer());
if (Buffer.compare(Buffer.from(gotBytes), Buffer.from(expectedBytes)) !== 0) {
  throw new Error(`presigned GET body mismatch: got ${gotBytes.length} bytes`);
}
console.log("presign_get + fetch GET: ok");

const evilName = 'weird "name"\\with\\backslash.txt';
const presignedGetWithName = client.presign_get(seedKey, 60, evilName);
const getWithNameResponse = await fetch(presignedGetWithName.url);
if (!getWithNameResponse.ok) throw new Error(`presigned GET (disposition) failed: ${getWithNameResponse.status}`);
const disposition = getWithNameResponse.headers.get("content-disposition");
if (disposition !== 'attachment; filename="weird namewithbackslash.txt"') {
  throw new Error(`unexpected content-disposition: ${disposition}`);
}
console.log("presign_get attachment_name sanitization: ok");

// Single-PUT upload roundtrip: presign, PUT via Node fetch, HEAD, then
// record it in the manifest. Overwrites the same key each run rather than
// cleaning up afterward — there is no wasm delete method yet, and this is
// the seeded local/CI bucket, so a stray row is acceptable.
const uploadKey = "smoke/upload-roundtrip.txt";
const uploadBody = `hello from wasm smoke @ ${Date.now()}`;
const presigned = client.presign_put(uploadKey, 60);
if (presigned.method !== "PUT" || !presigned.url.startsWith("http")) {
  throw new Error(`bad presigned request: ${JSON.stringify(presigned)}`);
}
const putResponse = await fetch(presigned.url, {
  method: "PUT",
  body: uploadBody,
  headers: { "content-type": "text/plain" },
});
if (!putResponse.ok) throw new Error(`presigned PUT failed: ${putResponse.status}`);
const putEtag = putResponse.headers.get("etag");
if (!putEtag) throw new Error("presigned PUT response missing ETag header");
console.log("presign_put + fetch PUT: ok");

const headed = await client.head_object(uploadKey);
if (headed === null) throw new Error("head_object returned null for an object that was just uploaded");
if (headed.etag !== putEtag) throw new Error(`head_object etag ${headed.etag} !== PUT etag ${putEtag}`);
if (headed.size !== uploadBody.length) throw new Error(`head_object size ${headed.size} !== ${uploadBody.length}`);
console.log("head_object roundtrip: ok");

const missingHead = await client.head_object("smoke/definitely-does-not-exist.txt");
if (missingHead !== null) throw new Error("head_object on a missing key must return null");
console.log("head_object missing: ok");

await client.upsert_object(uploadKey, headed.size, headed.etag, "text/plain");
const afterUpsert = await client.load_manifest();
const upsertedRow = afterUpsert.objects.find((o) => o.key === uploadKey);
if (!upsertedRow) throw new Error("upsert_object did not add a manifest row");
if (upsertedRow.content_type !== "text/plain") throw new Error(`unexpected content_type: ${upsertedRow.content_type}`);
if (upsertedRow.favorite !== false) throw new Error("favorite should default to false for a new row");
if (upsertedRow.thumbnail_key !== null) throw new Error("thumbnail_key should be null for a new row");
console.log("upsert_object: ok");

// Re-upsert with a DIFFERENT etag simulates a content change: thumbnail_key
// must be cleared (it was already null here, but this exercises the branch
// deliberately rather than by accident).
await client.upsert_object(uploadKey, headed.size, `${headed.etag}-different`, "text/plain");
const afterReupsert = await client.load_manifest();
const reupsertedRow = afterReupsert.objects.find((o) => o.key === uploadKey);
if (reupsertedRow.thumbnail_key !== null) throw new Error("thumbnail_key must be cleared when etag changes");
console.log("upsert_object etag-change clears thumbnail_key: ok");

// delete_object: upload -> delete -> tombstone visible in load_manifest ->
// reconcile keeps it consistent (delete already ran the tombstone write, so
// reconcile should see no further changes to this row).
const deleteKey = `smoke/delete-roundtrip-${Date.now()}.txt`;
const presignedForDelete = client.presign_put(deleteKey, 60);
const putForDeleteResponse = await fetch(presignedForDelete.url, {
  method: "PUT",
  body: "to be deleted",
  headers: { "content-type": "text/plain" },
});
if (!putForDeleteResponse.ok) throw new Error(`presigned PUT (for delete) failed: ${putForDeleteResponse.status}`);
const headedForDelete = await client.head_object(deleteKey);
await client.upsert_object(deleteKey, headedForDelete.size, headedForDelete.etag, "text/plain");

const deleteReport = await client.delete_object(deleteKey);
if (deleteReport.deleted !== true) throw new Error(`delete_object did not report deleted: ${JSON.stringify(deleteReport)}`);
if (deleteReport.thumbnail_deleted !== null) {
  // No thumbnail was ever attached to this row, so the report must carry null.
  throw new Error(`expected null thumbnail_deleted, got: ${JSON.stringify(deleteReport)}`);
}
if (deleteReport.already_absent !== false) {
  throw new Error(`row was live before delete, already_absent must be false: ${JSON.stringify(deleteReport)}`);
}
console.log("delete_object: ok,", JSON.stringify(deleteReport));

const afterDelete = await client.load_manifest();
const tombstoned = afterDelete.objects.find((o) => o.key === deleteKey);
if (!tombstoned) throw new Error("delete_object did not leave a manifest row (tombstones must be retained)");
if (tombstoned.deleted_at === null) throw new Error("tombstoned row must have deleted_at set");
console.log("delete_object tombstone visible in load_manifest: ok");

// A second delete_object call on the same (already-tombstoned) key must be a
// no-op manifest write, reported via already_absent.
const secondDeleteReport = await client.delete_object(deleteKey);
if (secondDeleteReport.already_absent !== true) {
  throw new Error(`re-deleting an already-tombstoned key must report already_absent: ${JSON.stringify(secondDeleteReport)}`);
}
console.log("delete_object already-tombstoned short-circuit: ok");

// reconcile keeps the tombstone consistent: rerunning it must not resurrect
// or otherwise disturb the deleted row (it is gone from the bucket LIST, so
// reconcile drops it from the manifest entirely — never surfaced as live).
await client.reconcile([]);
const afterReconcile = await client.load_manifest();
if (afterReconcile.objects.some((o) => o.key === deleteKey)) {
  throw new Error("reconcile must not resurrect a deleted object");
}
console.log("reconcile after delete_object: ok");

// Reserved-prefix rejection: must throw before any network call.
let reservedThrew = false;
try {
  await client.delete_object(".bare-bucket/manifest.json.gz");
} catch {
  reservedThrew = true;
}
if (!reservedThrew) throw new Error("delete_object on a reserved-prefix key must throw");
console.log("delete_object reserved-prefix rejection: ok");

console.log("SMOKE OK");
