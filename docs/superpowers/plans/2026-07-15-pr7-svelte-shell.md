# PR 7: Svelte Shell + Profiles + Connect Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web client's foundation: the `wasm-api` boundary in the core (a `WasmClient` exposing validate/reconcile/load-manifest with the single-manifest-writer lock), a Svelte 5 + TypeScript + Vite app shell with the dark theme, connection profiles in `localStorage` (secrets session-only), and the connect screen validated in the design mockups (centered profile-picker card with add/edit/remove → secret entry → connect).

**Architecture:** Core side: `core/src/wasm_api.rs` — a `#[wasm_bindgen]` `WasmClient` wrapping `S3Client` + device id + an `async_lock::Mutex` that ALL manifest-mutating operations acquire (binding carry-forward from PR 6: reconcile's whole-Vec write erases concurrent manifest changes; every later mutation method takes this lock). Data crosses the boundary via `serde-wasm-bindgen`; manifest JSON keeps its spec §4.1 snake_case field names, config input is camelCase. Web side: `web/` Vite app consuming the wasm pkg as a `file:../core/pkg` dependency; no router (two app states: connect / browse-placeholder, switched by a Svelte 5 runes store); profiles module is pure TS (unit-testable with Vitest, no component tests in v1 per spec §10).

**Tech Stack:** Rust additions: `wasm-bindgen-futures`, `serde-wasm-bindgen`, `async-lock`. Web: Svelte 5, Vite 7, TypeScript, Vitest.

## Global Constraints

- Commits: Conventional Commits, atomic; trailer: blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work from `/home/diego/Projects/bare-bucket/.claude/worktrees/bare-bucket-design`; `source "$HOME/.cargo/env"` for cargo commands. Node v26 + npm are installed.
- Rust gates before commit: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace`. Web gates: `npm run check && npm test -- --run && npm run build` (from `web/`).
- Do not push or open a PR.
- **Binding carry-forwards (PR 6 final review):** the manifest-writer mutex in `WasmClient` (documented at the field, acquired by `reconcile` now and by every future mutation method); `reconcile` accepts `active_upload_ids` (empty array from the UI until PR 10 plumbs the upload manager).
- **Security model (spec §8):** profile config (incl. `access_key_id`) in `localStorage`; the secret access key is held in memory only (passed to `WasmClient` at connect, kept inside the wasm instance), never written to any persistent storage. Dropping the client forgets it.
- **UI design (spec §7.3, validated mockups):** dark theme; centered card with the bare|bucket wordmark; profile rows (badge, name, endpoint · bucket) with hover Edit/Remove; "＋ Add profile" opening the inline form (name, endpoint, bucket, region, access key id, path-style checkbox); selecting a profile reveals the secret field + Connect; errors render in the card, with a dedicated CORS hint ("your bucket needs CORS rules — see the setup docs") when the failure smells like CORS (network error from the browser).
- Reserved-prefix filtering (`.bare-bucket/`) is PR 8's concern; the placeholder browse screen shows only counts.
- YAGNI: no router, no i18n, no component-test infra, no state library (Svelte 5 runes), no dark/light toggle (dark only, spec mockups).

---

### Task 1: core `wasm-api` module (WasmClient + writer lock)

**Files:**
- Modify: `core/Cargo.toml` (add wasm-bindgen-futures, serde-wasm-bindgen, async-lock)
- Create: `core/src/wasm_api.rs`
- Modify: `core/src/lib.rs` (add `pub mod wasm_api;`, remove the old `version()` fn + its test — `WasmClient::core_version()` replaces it)
- Create: `scripts/wasm-smoke.mjs` (Node smoke test of the real bindings against MinIO)

**Interfaces:**
- Consumes: `s3::{S3Client, S3Config}`, `signer::Credentials`, `manifest::{ManifestStore, Manifest}`, `reconcile::{reconcile, ReconcileOptions}`.
- Produces (consumed by `web/src/lib/core.ts`):

```ts
// JS view of the wasm surface
new WasmClient({ endpoint, region, bucket, pathStyle, accessKeyId, secretAccessKey, deviceId }): WasmClient  // throws on bad config
WasmClient.core_version(): string
client.validate(): Promise<void>                       // head_bucket; throws on auth/network failure
client.reconcile(activeUploadIds: string[]): Promise<ReconcileReport>  // snake_case fields per core
client.load_manifest(): Promise<Manifest>              // spec §4.1 JSON shape (objects, schema_version, …)
```

- [ ] **Step 1: Add dependencies**

In `core/Cargo.toml` `[dependencies]` (keep alphabetical):

```toml
async-lock = "3"
serde-wasm-bindgen = "0.6"
wasm-bindgen-futures = "0.4"
```

- [ ] **Step 2: Write the implementation** (no meaningful pure-Rust unit tests exist for a bindings shim — verification is the compile gates + the Node smoke test in Step 4; this task is exempt from TDD's RED phase)

Create `core/src/wasm_api.rs`:

```rust
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
```

In `core/src/lib.rs`: add `pub mod wasm_api;`; DELETE the `version()` function, its `#[wasm_bindgen]` attribute, the now-unused `use wasm_bindgen::prelude::*;` line, and the `tests` module containing `version_matches_cargo_manifest` (superseded by `WasmClient::core_version`, which the smoke test exercises).

- [ ] **Step 3: Compile gates**

Run: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace && wasm-pack build core --target web`
Expected: clean. (Native clippy compiles wasm_api too — `wasm_bindgen` attrs are inert on native; if any item is genuinely wasm-only gate it with `#[cfg(target_arch = "wasm32")]` and note it in your report.)

- [ ] **Step 4: Node smoke test of the real bindings against MinIO**

Create `scripts/wasm-smoke.mjs`:

```js
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
```

Run:

```bash
docker compose up -d --wait minio && docker compose run --rm createbucket
node scripts/wasm-smoke.mjs
```

Expected: prints `core_version`, `validate: ok`, a reconcile report, `load_manifest: ok`, `SMOKE OK`. If Node lacks a browser API the wasm path needs (this validates reqwest-wasm under Node's fetch), report DONE_WITH_CONCERNS with the exact error — do not shim silently.

- [ ] **Step 5: Commit**

```bash
git add core/Cargo.toml core/src/lib.rs core/src/wasm_api.rs scripts/wasm-smoke.mjs Cargo.lock
git commit -m "feat: add wasm-api boundary with manifest-writer lock"
```

---

### Task 2: Svelte 5 + Vite scaffold with dark theme

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/svelte.config.js`, `web/tsconfig.json`, `web/index.html`
- Create: `web/src/main.ts`, `web/src/App.svelte`, `web/src/vite-env.d.ts`
- Create: `web/src/lib/core.ts` (wasm loader + typed surface)
- Create: `web/src/styles/theme.css`
- Create: `web/src/screens/BrowseScreen.svelte` (placeholder)
- Modify: `.gitignore` (add `web/node_modules/`, `web/dist/`)

**Interfaces:**
- Consumes: `core/pkg` (wasm-pack output, `file:` dependency).
- Produces: `initCore(): Promise<void>`, `createClient(config: ClientConfig): WasmClient`, types `ClientConfig`, `Manifest`, `ManifestObject`, `ReconcileReport`; app-state store contract consumed by Task 3 (`session.status` = `"connect" | "connected"`).

- [ ] **Step 1: Scaffold the files**

`web/package.json`:

```json
{
  "name": "bare-bucket-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest"
  },
  "dependencies": {
    "bare-bucket-core": "file:../core/pkg"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "svelte": "^5.0.0",
    "svelte-check": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0"
  }
}
```

(If npm reports unresolvable majors for vite/plugin combos, use the newest compatible pair and note it in the report — the pin is "current stable," not these exact numbers.)

`web/vite.config.ts`:

```ts
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  // The wasm pkg is a local file: dependency; keep it out of prebundling so
  // Vite serves its .wasm asset via import.meta.url resolution.
  optimizeDeps: { exclude: ["bare-bucket-core"] },
  build: { target: "esnext" },
});
```

`web/svelte.config.js`:

```js
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
export default { preprocess: vitePreprocess() };
```

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["svelte", "vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.svelte", "tests/**/*.ts"]
}
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bare Bucket</title>
    <link rel="stylesheet" href="/src/styles/theme.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`web/src/styles/theme.css` (dark theme tokens from the validated mockups):

```css
:root {
  --bg: #10141c;
  --bg-deep: #0a0e15;
  --surface: #161c29;
  --surface-raised: #1a2130;
  --sidebar: #131926;
  --border: #232a38;
  --border-strong: #2c3547;
  --input-bg: #0d1119;
  --text: #c8cdd6;
  --text-bright: #e6eaf2;
  --text-dim: #6c7789;
  --accent: #4f7cff;
  --accent-soft: #22407a;
  --accent-text: #cfe0ff;
  --selected: #14203a;
  --danger: #e5484d;
  --radius: 8px;
  --radius-small: 6px;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
}

button {
  font: inherit;
  cursor: pointer;
}

input,
select {
  font: inherit;
}
```

`web/src/lib/core.ts`:

```ts
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
```

`web/src/main.ts`:

```ts
import { mount } from "svelte";
import App from "./App.svelte";

const app = mount(App, { target: document.getElementById("app")! });

export default app;
```

`web/src/App.svelte`:

```svelte
<script lang="ts">
  import { initCore } from "./lib/core";
  import { session } from "./lib/session.svelte";
  import ConnectScreen from "./screens/ConnectScreen.svelte";
  import BrowseScreen from "./screens/BrowseScreen.svelte";

  const ready = initCore();
</script>

{#await ready}
  <main class="boot">Loading core…</main>
{:then}
  {#if session.status === "connected"}
    <BrowseScreen />
  {:else}
    <ConnectScreen />
  {/if}
{:catch error}
  <main class="boot error">Failed to load the core module: {error}</main>
{/await}

<style>
  .boot {
    display: grid;
    place-items: center;
    min-height: 100vh;
    color: var(--text-dim);
  }
  .error {
    color: var(--danger);
  }
</style>
```

`web/src/screens/BrowseScreen.svelte` (placeholder proving the wasm roundtrip; PR 8 replaces it):

```svelte
<script lang="ts">
  import { session } from "../lib/session.svelte";

  const objectCount = $derived(
    session.manifest?.objects.filter((o) => o.deleted_at === null).length ?? 0
  );
</script>

<main>
  <h1>Connected to {session.profileName}</h1>
  <p>{objectCount} objects in the manifest.</p>
  <p class="dim">Browse UI arrives in the next phase.</p>
  <button onclick={() => session.disconnect()}>Disconnect</button>
</main>

<style>
  main {
    display: grid;
    place-content: center;
    gap: 8px;
    min-height: 100vh;
    text-align: center;
  }
  h1 {
    color: var(--text-bright);
    font-size: 20px;
  }
  .dim {
    color: var(--text-dim);
  }
  button {
    justify-self: center;
    background: var(--accent-soft);
    color: var(--accent-text);
    border: none;
    border-radius: var(--radius-small);
    padding: 8px 16px;
  }
</style>
```

`web/src/vite-env.d.ts`:

```ts
/// <reference types="svelte" />
/// <reference types="vite/client" />
```

Append to `.gitignore`:

```gitignore
web/node_modules/
web/dist/
```

NOTE: `App.svelte` and `BrowseScreen.svelte` import `./lib/session.svelte` which Task 3 creates. To keep Task 2 independently green, create a MINIMAL `web/src/lib/session.svelte.ts` now (Task 3 replaces it):

```ts
// Minimal session state — expanded by the connect flow.
import type { Manifest, WasmClient } from "./core";

interface Session {
  status: "connect" | "connected";
  profileName: string;
  client: WasmClient | null;
  manifest: Manifest | null;
  disconnect(): void;
}

export const session: Session = $state({
  status: "connect",
  profileName: "",
  client: null,
  manifest: null,
  disconnect() {
    session.status = "connect";
    session.client = null;
    session.manifest = null;
    session.profileName = "";
  },
});
```

And a MINIMAL `web/src/screens/ConnectScreen.svelte` placeholder (Task 3 replaces it):

```svelte
<main>Connect screen arrives with the next task.</main>
```

- [ ] **Step 2: Install and verify**

```bash
source "$HOME/.cargo/env" && wasm-pack build core --target web   # ensure pkg exists/fresh
cd web && npm install && npm run check && npm run build
```

Expected: install resolves, `svelte-check` reports 0 errors, `vite build` emits `dist/` including the wasm asset. If `svelte-check` flags the `$state` rune in a `.svelte.ts` file, confirm the file is named `session.svelte.ts` (runes only work in `.svelte`/`.svelte.js/ts` modules).

- [ ] **Step 3: Commit**

```bash
git add .gitignore web/
git commit -m "feat: scaffold Svelte web shell with wasm integration"
```

(`web/package-lock.json` is included — it is the web build's lockfile.)

---

### Task 3: profiles module + connect flow + session state

**Files:**
- Create: `web/src/lib/profiles.ts`
- Replace: `web/src/lib/session.svelte.ts`
- Replace: `web/src/screens/ConnectScreen.svelte`
- Create: `web/tests/profiles.test.ts`

**Interfaces:**
- Consumes: Task 2's `core.ts` surface.
- Produces:

```ts
// profiles.ts — pure localStorage CRUD, injectable storage for tests
export interface Profile {
  id: string;            // crypto.randomUUID()
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  pathStyle: boolean;
}
export function listProfiles(storage?: Storage): Profile[];
export function saveProfile(profile: Profile, storage?: Storage): void;   // insert or replace by id
export function deleteProfile(id: string, storage?: Storage): void;
export function createProfile(fields: Omit<Profile, "id">): Profile;

// session.svelte.ts
session.status: "connect" | "connected"
session.connect(profile: Profile, secretAccessKey: string): Promise<void> // validate → reconcile([]) → load_manifest → connected
session.connecting: boolean
session.error: string | null       // human-readable; CORS hint appended when applicable
session.disconnect(): void
session.manifest / session.client / session.profileName
```

- [ ] **Step 1: Write the failing tests**

`web/tests/profiles.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  createProfile,
  deleteProfile,
  listProfiles,
  saveProfile,
  type Profile,
} from "../src/lib/profiles";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("profiles", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memoryStorage();
  });

  const fields = {
    name: "R2 photos",
    endpoint: "https://acc.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "photos",
    accessKeyId: "AKID",
    pathStyle: false,
  };

  it("starts empty and round-trips a saved profile", () => {
    expect(listProfiles(storage)).toEqual([]);
    const profile = createProfile(fields);
    expect(profile.id).toMatch(/[0-9a-f-]{36}/);
    saveProfile(profile, storage);
    expect(listProfiles(storage)).toEqual([profile]);
  });

  it("replaces by id on save (edit flow)", () => {
    const profile = createProfile(fields);
    saveProfile(profile, storage);
    saveProfile({ ...profile, name: "Renamed" }, storage);
    const all = listProfiles(storage);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Renamed");
  });

  it("deletes by id", () => {
    const a = createProfile(fields);
    const b = createProfile({ ...fields, name: "Other" });
    saveProfile(a, storage);
    saveProfile(b, storage);
    deleteProfile(a.id, storage);
    expect(listProfiles(storage).map((p) => p.name)).toEqual(["Other"]);
  });

  it("never stores anything that looks like a secret", () => {
    const profile = createProfile(fields);
    saveProfile(profile, storage);
    const raw = storage.getItem("bare-bucket/profiles")!;
    expect(raw).not.toMatch(/secret/i);
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed[0]).sort()).toEqual(
      ["accessKeyId", "bucket", "endpoint", "id", "name", "pathStyle", "region"]
    );
  });

  it("tolerates corrupt storage by starting fresh", () => {
    storage.setItem("bare-bucket/profiles", "{not json");
    expect(listProfiles(storage)).toEqual([]);
  });
});
```

Run: `cd web && npm test -- --run` → FAIL (module not found).

- [ ] **Step 2: Implement `profiles.ts`**

```ts
// Connection profiles: non-secret config only (spec §8.1). The secret
// access key NEVER touches persistent storage — it lives in the WasmClient
// instance for the session.
export interface Profile {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  pathStyle: boolean;
}

const STORAGE_KEY = "bare-bucket/profiles";

function defaultStorage(): Storage {
  return globalThis.localStorage;
}

export function listProfiles(storage: Storage = defaultStorage()): Profile[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Profile[]) : [];
  } catch {
    return [];
  }
}

export function saveProfile(profile: Profile, storage: Storage = defaultStorage()): void {
  const all = listProfiles(storage);
  const index = all.findIndex((p) => p.id === profile.id);
  if (index >= 0) all[index] = profile;
  else all.push(profile);
  storage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function deleteProfile(id: string, storage: Storage = defaultStorage()): void {
  const all = listProfiles(storage).filter((p) => p.id !== id);
  storage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function createProfile(fields: Omit<Profile, "id">): Profile {
  return { id: crypto.randomUUID(), ...fields };
}
```

Run: `npm test -- --run` → 5 passed.

- [ ] **Step 3: Implement `session.svelte.ts` (replace the placeholder)**

```ts
// App-level session state (Svelte 5 runes). One connection at a time.
import { createClient, type Manifest, type WasmClient } from "./core";
import type { Profile } from "./profiles";

interface Session {
  status: "connect" | "connected";
  connecting: boolean;
  error: string | null;
  profileName: string;
  client: WasmClient | null;
  manifest: Manifest | null;
  connect(profile: Profile, secretAccessKey: string): Promise<void>;
  refreshManifest(): Promise<void>;
  disconnect(): void;
}

function deviceId(): string {
  return `web-${crypto.randomUUID().slice(0, 8)}`;
}

/** Network-shaped failures from the browser usually mean missing bucket
 * CORS rules — the #1 setup failure (spec §8.4). */
function describeError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/network error|failed to fetch|networkerror/i.test(message)) {
    return `${message} — if the endpoint is reachable, your bucket is likely missing CORS rules; see the setup docs.`;
  }
  return message;
}

export const session: Session = $state({
  status: "connect",
  connecting: false,
  error: null,
  profileName: "",
  client: null,
  manifest: null,

  async connect(profile: Profile, secretAccessKey: string) {
    session.connecting = true;
    session.error = null;
    try {
      const client = createClient({
        endpoint: profile.endpoint,
        region: profile.region,
        bucket: profile.bucket,
        pathStyle: profile.pathStyle,
        accessKeyId: profile.accessKeyId,
        secretAccessKey,
        deviceId: deviceId(),
      });
      await client.validate();
      await client.reconcile([]); // refresh-on-open + first-connect bootstrap (spec §6)
      session.manifest = (await client.load_manifest()) as Manifest;
      session.client = client;
      session.profileName = profile.name;
      session.status = "connected";
    } catch (e) {
      session.error = describeError(e);
    } finally {
      session.connecting = false;
    }
  },

  async refreshManifest() {
    if (!session.client) return;
    session.manifest = (await session.client.load_manifest()) as Manifest;
  },

  disconnect() {
    session.status = "connect";
    session.client = null; // drops the wasm instance and the secret with it
    session.manifest = null;
    session.profileName = "";
    session.error = null;
  },
});
```

- [ ] **Step 4: Implement `ConnectScreen.svelte` (replace the placeholder)**

Design per the validated mockup (§7.3): centered card, wordmark, profile rows with hover edit/remove, add/edit inline form, secret reveal on selection, connect button, in-card errors.

```svelte
<script lang="ts">
  import {
    createProfile,
    deleteProfile,
    listProfiles,
    saveProfile,
    type Profile,
  } from "../lib/profiles";
  import { session } from "../lib/session.svelte";

  let profiles = $state(listProfiles());
  let selectedId = $state<string | null>(null);
  let editing = $state<Profile | null>(null); // null = list mode
  let isNew = $state(false);
  let secret = $state("");

  const selected = $derived(profiles.find((p) => p.id === selectedId) ?? null);

  const emptyFields = {
    name: "",
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKeyId: "",
    pathStyle: false,
  };

  function startAdd() {
    editing = { id: "", ...emptyFields };
    isNew = true;
  }

  function startEdit(profile: Profile) {
    editing = { ...profile };
    isNew = false;
  }

  function submitForm(event: SubmitEvent) {
    event.preventDefault();
    if (!editing) return;
    const { id, ...fields } = editing;
    const saved = isNew ? createProfile(fields) : editing;
    saveProfile(saved);
    profiles = listProfiles();
    selectedId = saved.id;
    editing = null;
  }

  function remove(profile: Profile) {
    deleteProfile(profile.id);
    profiles = listProfiles();
    if (selectedId === profile.id) selectedId = null;
  }

  function select(profile: Profile) {
    selectedId = selectedId === profile.id ? null : profile.id;
    secret = "";
  }

  function connect(event: SubmitEvent) {
    event.preventDefault();
    if (selected && secret) void session.connect(selected, secret);
  }

  function endpointHost(profile: Profile): string {
    return profile.endpoint.replace(/^https?:\/\//, "");
  }
</script>

<main>
  <div class="card">
    <h1 class="wordmark">▙ bare<span>bucket</span></h1>

    {#if editing}
      <form class="profile-form" onsubmit={submitForm}>
        <label>Name <input bind:value={editing.name} required placeholder="R2 photos" /></label>
        <label>Endpoint <input bind:value={editing.endpoint} required placeholder="https://…" /></label>
        <div class="row">
          <label>Bucket <input bind:value={editing.bucket} required /></label>
          <label>Region <input bind:value={editing.region} required /></label>
        </div>
        <label>Access key ID <input bind:value={editing.accessKeyId} required /></label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={editing.pathStyle} />
          Path-style addressing (MinIO / RustFS)
        </label>
        <div class="actions">
          <button type="submit" class="primary">{isNew ? "Add profile" : "Save changes"}</button>
          <button type="button" class="ghost" onclick={() => (editing = null)}>Cancel</button>
        </div>
      </form>
    {:else}
      <ul class="profiles">
        {#each profiles as profile (profile.id)}
          <li class:selected={profile.id === selectedId}>
            <button class="profile" onclick={() => select(profile)}>
              <span class="badge">{profile.name.slice(0, 2).toUpperCase()}</span>
              <span class="meta">
                <span class="name">{profile.name}</span>
                <span class="detail">{endpointHost(profile)} · {profile.bucket}</span>
              </span>
            </button>
            <span class="row-actions">
              <button class="icon" title="Edit" onclick={() => startEdit(profile)}>✎</button>
              <button class="icon" title="Remove" onclick={() => remove(profile)}>✕</button>
            </span>
          </li>
        {:else}
          <li class="empty">No profiles yet — add one to get started.</li>
        {/each}
      </ul>

      <button class="add" onclick={startAdd}>＋ Add profile</button>

      {#if selected}
        <form class="secret" onsubmit={connect}>
          <hr />
          <label>
            Secret access key for “{selected.name}”
            <input
              type="password"
              bind:value={secret}
              required
              autocomplete="off"
              placeholder="Session only — never stored"
            />
          </label>
          <button type="submit" class="primary" disabled={session.connecting || !secret}>
            {session.connecting ? "Connecting…" : "Connect"}
          </button>
        </form>
      {/if}

      {#if session.error}
        <p class="error">{session.error}</p>
      {/if}
    {/if}
  </div>
</main>

<style>
  main {
    display: grid;
    place-items: center;
    min-height: 100vh;
  }
  .card {
    width: min(420px, 92vw);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    padding: 24px;
    display: grid;
    gap: 12px;
  }
  .wordmark {
    text-align: center;
    color: var(--text-bright);
    font-size: 18px;
    margin: 0 0 4px;
  }
  .wordmark span {
    color: var(--accent);
  }
  .profiles {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .profiles li {
    display: flex;
    align-items: center;
    background: var(--input-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
  }
  .profiles li.selected {
    border-color: var(--accent);
    background: var(--selected);
  }
  .profiles li.empty {
    justify-content: center;
    color: var(--text-dim);
    padding: 12px;
    border-style: dashed;
  }
  .profile {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    color: inherit;
    padding: 9px 10px;
    text-align: left;
  }
  .badge {
    width: 30px;
    height: 30px;
    border-radius: var(--radius-small);
    background: var(--accent-soft);
    color: var(--accent-text);
    display: grid;
    place-items: center;
    font-weight: 700;
    flex-shrink: 0;
  }
  .meta {
    display: grid;
  }
  .name {
    color: var(--text-bright);
    font-weight: 600;
  }
  .detail {
    color: var(--text-dim);
    font-size: 12px;
  }
  .row-actions {
    display: flex;
    gap: 2px;
    padding-right: 6px;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .profiles li:hover .row-actions,
  .profiles li.selected .row-actions {
    opacity: 1;
  }
  .icon {
    background: none;
    border: none;
    color: var(--text-dim);
    padding: 4px 6px;
    border-radius: 4px;
  }
  .icon:hover {
    color: var(--text-bright);
    background: var(--surface-raised);
  }
  .add {
    background: none;
    border: none;
    color: var(--accent);
    font-weight: 600;
    padding: 6px;
  }
  .profile-form,
  .secret {
    display: grid;
    gap: 10px;
  }
  label {
    display: grid;
    gap: 4px;
    color: var(--text-dim);
    font-size: 12px;
  }
  label.checkbox {
    grid-auto-flow: column;
    justify-content: start;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  input:not([type="checkbox"]) {
    background: var(--input-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-small);
    color: var(--text-bright);
    padding: 8px 10px;
  }
  input:focus-visible {
    outline: 1px solid var(--accent);
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .primary {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 9px 14px;
    font-weight: 700;
  }
  .primary:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .ghost {
    background: none;
    border: 1px solid var(--border-strong);
    color: var(--text-dim);
    border-radius: var(--radius-small);
    padding: 9px 14px;
  }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 2px 0;
  }
  .error {
    color: var(--danger);
    font-size: 13px;
    margin: 0;
  }
</style>
```

(Note: `const { id, ...fields } = editing` intentionally discards the empty `id` for the isNew path; if `noUnusedLocals` flags `id`, rename the binding to `_id` or use `void id;` — report which.)

- [ ] **Step 5: Full verification**

```bash
cd web && npm run check && npm test -- --run && npm run build
```

Expected: 0 check errors, 5 tests passed, build green.

Then a REAL browser-shaped smoke: `npm run build && npm run preview -- --port 4173 &`, then `curl -s http://localhost:4173 | grep -q bare-bucket && echo PREVIEW OK` (verifies the built bundle serves; interactive validation happens in the final Playwright phase). Kill the preview server afterward.

- [ ] **Step 6: Commit**

```bash
git add web/
git commit -m "feat: add connection profiles and connect screen"
```

---

### Task 4: CI web job + README

**Files:**
- Modify: `.github/workflows/ci.yml` (add `web` job)
- Modify: `README.md` (web dev instructions, repository layout update)

- [ ] **Step 1: Add the CI job**

Append under `jobs:`:

```yaml
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
      - uses: Swatinem/rust-cache@v2
      - uses: taiki-e/install-action@v2
        with:
          tool: wasm-pack
      - run: wasm-pack build core --target web
      - uses: actions/setup-node@v4
        with:
          node-version: 26
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
        working-directory: web
      - run: npm run check
        working-directory: web
      - run: npm test -- --run
        working-directory: web
      - run: npm run build
        working-directory: web
```

Sanity-check: `node -e "const s=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!s.includes('web:')) throw 1; console.log('smoke OK')"`

- [ ] **Step 2: Update README**

Repository layout gains `- \`web/\` — Svelte web client`. Development section gains:

```markdown
### Web client

```sh
wasm-pack build core --target web   # build the wasm package first
cd web
npm install
npm run dev                          # dev server
npm run check && npm test -- --run  # typecheck + unit tests
npm run build                        # production build (web/dist/)
```
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: add web typecheck, test, and build job"
```
