# PR 9: Views & Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The remaining sidebar views per spec §7.2 — Recent (manifest sorted by last_modified), Favorites (star/unstar — the FIRST UI-driven manifest mutation, establishing the writer-lock pattern), the storage-used indicator, and client-side filename search — plus the small UX fold-ins inherited from PR 8's review (breadcrumb middle-collapse, stale-prefix fallback, inline refresh error).

**Architecture:** Core: one new `WasmClient::set_favorite(key, favorite)` method — acquires `manifest_write_lock`, runs `update_with_retry` with a pure idempotent mutator, returns nothing; the UI updates its local manifest optimistically and reverts on error. Web: `browse.section: "all" | "recent" | "favorites" | "search"` (the word "view" stays reserved for list/grid); pure helpers `recentFiles`/`favoriteFiles`/`searchFiles`/`displayName` in `listing.ts`; a files-only `FileRows` presentation used by the three non-"all" sections with path-qualified names; star toggles on list rows and grid tiles.

**Tech Stack:** existing only.

## Global Constraints

- Commits: Conventional Commits, atomic; trailer: blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work from `/home/diego/Projects/bare-bucket/.claude/worktrees/bare-bucket-design`; web commands from `web/`; `source "$HOME/.cargo/env"` for cargo/wasm-pack.
- Rust gates: fmt + clippy (native + wasm32) + `cargo test --workspace`. Web gates: `npm run check && npm test -- --run && npm run build`.
- Do not push or open a PR.
- **BINDING (writer-lock pattern-setter):** `set_favorite` MUST hold `manifest_write_lock` across the whole update; the mutator closure MUST be pure/idempotent (no timestamps needed here); boundary values MUST cross via `to_js` (the clippy `disallowed-methods` guard enforces the serializer).
- **BINDING (search semantics, spec §6 v1 scope):** search is client-side against the loaded manifest — case-insensitive substring over the full key; no network calls; `.bare-bucket/` keys never appear (excluded at reconcile).
- Recent = ALL live files sorted by `last_modified` desc (ties by key asc); no arbitrary cap. Favorites = live files with `favorite === true`, name-sorted. Search results name-sorted.
- Star toggle affordances: trailing ☆/★ button on list rows AND top-right of grid tiles for files (never folders). Optimistic update + revert-with-error on failure (`session.refreshError` reused for surfacing — it renders inline after this PR).
- Fold-ins from PR 8 review: (a) breadcrumbs collapse the MIDDLE when overflowing (first + last always visible); (b) after `session.manifest` replacement, if `browse.prefix` no longer exists in the tree, fall back to the nearest existing ancestor; (c) refresh errors render as an inline dismissible line under the toolbar, not tooltip-only.
- YAGNI: no fuzzy search, no search history, no per-column sorting, no favorites persistence outside the manifest, no keyboard shortcuts.

---

### Task 1: `set_favorite` across the wasm boundary + smoke coverage

**Files:**
- Modify: `core/src/wasm_api.rs`
- Modify: `scripts/wasm-smoke.mjs`

**Interfaces:**
- Produces: `client.set_favorite(key: string, favorite: boolean): Promise<void>` — throws if the key is unknown (`JsError` "unknown key: {key}").

- [ ] **Step 1: Implement the method** (TDD-exempt bindings shim; verification = compile gates + live smoke)

Add to `impl WasmClient` in `core/src/wasm_api.rs`:

```rust
    /// Star/unstar an object. Holds the manifest writer lock (see module
    /// docs) for the read→mutate→conditional-PUT cycle.
    pub async fn set_favorite(&self, key: String, favorite: bool) -> Result<(), JsError> {
        let _write = self.inner.manifest_write_lock.lock().await;
        let store = ManifestStore::new(&self.inner.client, &self.inner.device_id);
        // Pure, idempotent mutator (PR 5 contract); found-ness is checked
        // after the write from the closure's captured flag would be racy —
        // instead verify existence on the freshly loaded manifest each
        // attempt by keying the mutation itself.
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
```

Note: `found` is overwritten per attempt with the latest attempt's result, so it reflects the state of the manifest version that actually got written — correct under retries.

- [ ] **Step 2: Extend the smoke** — after the existing `option-null check`, add:

```js
// Favorite roundtrip (exercises the writer-lock mutation path end-to-end).
if (manifest.objects.length > 0) {
  const key = manifest.objects[0].key;
  await client.set_favorite(key, true);
  const after = await client.load_manifest();
  const starred = after.objects.find((o) => o.key === key);
  if (starred?.favorite !== true) throw new Error("favorite did not persist");
  await client.set_favorite(key, false);
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
}
```

- [ ] **Step 3: Gates + live smoke**

```bash
cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --workspace
wasm-pack build core --target web
node scripts/wasm-smoke.mjs   # bucket is seeded; expect "favorite roundtrip: ok"
```

- [ ] **Step 4: Commit**

```bash
git add core/src/wasm_api.rs scripts/wasm-smoke.mjs
git commit -m "feat: expose favorite toggling across the wasm boundary"
```

---

### Task 2: listing helpers for the new sections (TDD)

**Files:**
- Modify: `web/src/lib/listing.ts`
- Modify: `web/tests/listing.test.ts`

**Interfaces:**

```ts
export function recentFiles(objects: ManifestObject[]): ManifestObject[];   // live files, last_modified desc, ties key asc
export function favoriteFiles(objects: ManifestObject[]): ManifestObject[]; // live favorites, name asc (case-insensitive by key)
export function searchFiles(objects: ManifestObject[], query: string): ManifestObject[]; // live, case-insensitive substring on key; empty/whitespace query → []
export function displayName(key: string): { name: string; parent: string }; // "photos/2026/trip/IMG.jpg" → {name:"IMG.jpg", parent:"photos/2026/trip"}; root file → parent ""
```

- [ ] **Step 1: Write the failing tests** (append to `listing.test.ts`):

```ts
describe("recentFiles", () => {
  it("sorts live files newest first with key tiebreak", () => {
    const list = [
      obj("b.txt", { last_modified: "2026-07-10T00:00:00Z" }),
      obj("a.txt", { last_modified: "2026-07-14T00:00:00Z" }),
      obj("tie-b.txt", { last_modified: "2026-07-12T00:00:00Z" }),
      obj("tie-a.txt", { last_modified: "2026-07-12T00:00:00Z" }),
      obj("dead.txt", { last_modified: "2026-07-15T00:00:00Z", deleted_at: "x" }),
    ];
    expect(recentFiles(list).map((f) => f.key)).toEqual([
      "a.txt",
      "tie-a.txt",
      "tie-b.txt",
      "b.txt",
    ]);
  });
});

describe("favoriteFiles", () => {
  it("returns only live favorites, name-sorted", () => {
    const list = [
      obj("z.txt", { favorite: true }),
      obj("a.txt", { favorite: true }),
      obj("m.txt"),
      obj("dead.txt", { favorite: true, deleted_at: "x" }),
    ];
    expect(favoriteFiles(list).map((f) => f.key)).toEqual(["a.txt", "z.txt"]);
  });
});

describe("searchFiles", () => {
  const list = [
    obj("photos/2026/trip/IMG_0142.jpg"),
    obj("docs/Itinerary.pdf"),
    obj("dead-img.txt", { deleted_at: "x" }),
  ];
  it("matches case-insensitively across the full key", () => {
    expect(searchFiles(list, "img").map((f) => f.key)).toEqual([
      "photos/2026/trip/IMG_0142.jpg",
    ]);
    expect(searchFiles(list, "ITINER").map((f) => f.key)).toEqual(["docs/Itinerary.pdf"]);
    expect(searchFiles(list, "2026/trip")).toHaveLength(1);
  });
  it("returns nothing for empty or whitespace queries", () => {
    expect(searchFiles(list, "")).toEqual([]);
    expect(searchFiles(list, "   ")).toEqual([]);
  });
});

describe("displayName", () => {
  it("splits name and parent", () => {
    expect(displayName("photos/2026/trip/IMG.jpg")).toEqual({
      name: "IMG.jpg",
      parent: "photos/2026/trip",
    });
    expect(displayName("readme.md")).toEqual({ name: "readme.md", parent: "" });
  });
});
```

- [ ] **Step 2: RED**, then implement:

```ts
export function recentFiles(objects: ManifestObject[]): ManifestObject[] {
  return live(objects)
    .slice()
    .sort(
      (a, b) =>
        b.last_modified.localeCompare(a.last_modified) || a.key.localeCompare(b.key),
    );
}

export function favoriteFiles(objects: ManifestObject[]): ManifestObject[] {
  return live(objects)
    .filter((o) => o.favorite)
    .sort((a, b) => byName.compare(a.key, b.key));
}

export function searchFiles(objects: ManifestObject[], query: string): ManifestObject[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return live(objects)
    .filter((o) => o.key.toLowerCase().includes(needle))
    .sort((a, b) => byName.compare(a.key, b.key));
}

export function displayName(key: string): { name: string; parent: string } {
  const slash = key.lastIndexOf("/");
  return slash === -1
    ? { name: key, parent: "" }
    : { name: key.slice(slash + 1), parent: key.slice(0, slash) };
}
```

(ISO8601 timestamps sort correctly as strings only when formats match; providers may return varied precision — if that bothers you, compare `Date.parse` values with the string as tiebreak. Prefer `Date.parse` comparison for robustness: `(Date.parse(b.last_modified) || 0) - (Date.parse(a.last_modified) || 0) || a.key.localeCompare(b.key)`. Use the Date.parse form and keep the tests green.)

- [ ] **Step 3: GREEN + gates + commit**

```bash
npm run check && npm test -- --run && npm run build
git add web/src/lib/listing.ts web/tests/listing.test.ts
git commit -m "feat: add recent, favorites, and search listing helpers"
```

---

### Task 3: sections UI, search, storage indicator, star toggles, fold-ins

**Files:**
- Modify: `web/src/lib/browse.svelte.ts` (add `section`, `searchQuery`; `navigate()` resets section to "all")
- Modify: `web/src/lib/session.svelte.ts` (add `toggleFavorite(key)` with optimistic update + revert)
- Modify: `web/src/components/Sidebar.svelte` (search input at top; Recent + Favorites nav items with section-aware active states; storage footer)
- Modify: `web/src/components/FileList.svelte` (star button column for files; optional `showPath` mode rendering `displayName().parent` under the name)
- Modify: `web/src/components/FileGrid.svelte` (star button on tiles)
- Modify: `web/src/components/Breadcrumbs.svelte` (middle-collapse when > 4 segments: first ▸ … ▸ last two)
- Modify: `web/src/screens/BrowseScreen.svelte` (section switch: all → folder listing; recent/favorites/search → files-only listing with paths; inline refresh-error line; stale-prefix ancestor fallback `$effect`)

Key implementation notes (complete where non-obvious):

`browse.svelte.ts` additions:

```ts
  section: "all" as "all" | "recent" | "favorites" | "search",
  searchQuery: "",

  navigate(prefix: string) {
    browse.prefix = prefix;
    browse.section = "all";
  },
  setSection(section: "all" | "recent" | "favorites") {
    browse.section = section;
    if (section !== "all") browse.searchQuery = "";
  },
  setSearch(query: string) {
    browse.searchQuery = query;
    browse.section = query.trim() ? "search" : "all";
  },
```

`session.svelte.ts` — optimistic favorite toggle:

```ts
  async toggleFavorite(key: string) {
    if (!session.client || !session.manifest) return;
    const object = session.manifest.objects.find((o) => o.key === key);
    if (!object) return;
    const next = !object.favorite;
    object.favorite = next; // optimistic
    try {
      await session.client.set_favorite(key, next);
    } catch (e) {
      object.favorite = !next; // revert
      session.refreshError = describeError(e);
    }
  },
```

Stale-prefix fallback in `BrowseScreen.svelte` (uses `childEntries` existence semantics — a prefix "exists" if it has any children):

```ts
  $effect(() => {
    const objects = session.manifest?.objects ?? [];
    let prefix = browse.prefix;
    while (prefix !== "") {
      const { folders, files } = childEntries(objects, prefix);
      if (folders.length > 0 || files.length > 0) break;
      prefix = prefix.replace(/[^/]+\/$/, "");
    }
    if (prefix !== browse.prefix) browse.prefix = prefix;
  });
```

Breadcrumbs middle-collapse: when `segments.length > 4` render `[first, "…", ...last two]` where the ellipsis is a non-clickable span.

Sections in `BrowseScreen.svelte`:

```ts
  const sectionFiles = $derived.by(() => {
    const objects = session.manifest?.objects ?? [];
    switch (browse.section) {
      case "recent": return recentFiles(objects);
      case "favorites": return favoriteFiles(objects);
      case "search": return searchFiles(objects, browse.searchQuery);
      default: return [];
    }
  });
```

Render: `browse.section === "all"` → existing folder listing (list or grid); otherwise `FileList` with `files={sectionFiles} showPath` (grid not needed for sections; the list/grid toggle hides outside "all"). Section headers: "Recent", "Favorites", `Search results for "{query}"` with result count. Empty states: "Nothing here yet." / favorites hint "Star files to pin them here." / "No matches."

Sidebar: search `<input>` at top bound to `browse.searchQuery` via `oninput={(e) => browse.setSearch(e.currentTarget.value)}`; nav items Recent (🕓) and Favorites (⭐) via `setSection`; active classes: All files active when `section === "all"`, others when section matches. Storage footer at the bottom: `◔ {formatSize(totalSize(objects))} used`.

Star button markup (FileList file rows, trailing cell; FileGrid tile corner):

```svelte
<button
  class="star"
  class:starred={file.favorite}
  title={file.favorite ? "Unstar" : "Star"}
  onclick={(e) => { e.stopPropagation(); void session.toggleFavorite(file.key); }}
>{file.favorite ? "★" : "☆"}</button>
```

Inline refresh error (BrowseScreen, under the toolbar):

```svelte
{#if session.refreshError}
  <div class="refresh-error" role="alert">
    {session.refreshError}
    <button onclick={() => (session.refreshError = null)}>✕</button>
  </div>
{/if}
```

(TopBar keeps its compact chip; the inline line is the accessible surface.)

- [ ] **Steps: implement → gates → commit**

```bash
cd web && npm run check && npm test -- --run && npm run build
git add web/src
git commit -m "feat: add recent, favorites, search, and storage indicator"
```

(Split into two commits if you prefer state+session separate from components; keep each atomic.)

- [ ] **Final: rebuild for live validation**

```bash
source "$HOME/.cargo/env" && wasm-pack build core --target web && cd web && npm run build
```
(Controller validates live; do not start servers.)
