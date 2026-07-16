# PR 8: Browse UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The main browse experience per the validated mockups (spec §7.1): Nextcloud-inspired dark layout — top bar (wordmark, connected-profile chip, Refresh, disconnect), sidebar (folder tree, All-files nav; search/Recent/Favorites arrive in PR 9), main pane (breadcrumbs, list/grid toggle, disabled Upload placeholder, file listing with icons/size/modified, footer count) — driven by pure, unit-tested listing derivation over the manifest.

**Architecture:** Pure derivation in `web/src/lib/listing.ts` (child entries at a prefix, folder-tree building, size/date formatting — all vitest-covered; the manifest never contains `.bare-bucket/` keys, reconciliation excludes them at the source). Browse state (current prefix, view mode) in `web/src/lib/browse.svelte.ts`; view mode persisted to localStorage. `BrowseScreen.svelte` becomes a real screen composed of `TopBar`, `Sidebar`, `Breadcrumbs`, `FileList`, `FileGrid` components. Refresh = `session.refresh()` → `client.reconcile([])` + `load_manifest()`, surfacing the report counts and the `conditional: false` degraded-write warning inline (PR 7 carry-forward). A `scripts/seed-demo.mjs` script populates MinIO with a realistic tree for live validation.

**Tech Stack:** existing only (Svelte 5 runes, Vitest).

## Global Constraints

- Commits: Conventional Commits, atomic; trailer: blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Work from `/home/diego/Projects/bare-bucket/.claude/worktrees/bare-bucket-design`; web commands from `web/`; `source "$HOME/.cargo/env"` for wasm-pack.
- Web gates before every commit: `npm run check && npm test -- --run && npm run build`.
- Do not push or open a PR.
- **Binding carry-forwards:** PR 8 makes NO manifest mutations (nothing to lock); Refresh reuses the existing `reconcile([])` + `load_manifest()` pattern and MUST surface `report.conditional === false` as a visible "conditional writes unavailable — concurrent changes can be lost" warning; Upload button renders disabled with title "Uploads arrive in a later phase".
- Mockup fidelity (spec §7.1): top bar `▙ bare|bucket` wordmark left, then `{profile} · {bucket} ▾` chip (click → disconnect to connect screen), spacer, `⟳ Refresh`, main pane header `＋ Upload` (disabled) + breadcrumbs + `☰ / ▦` toggle right; sidebar FOLDERS label + tree with expand/collapse; footer count `N folders, M files · X.Y GB`.
- Sorting: folders first (name, case-insensitive), then files (name, case-insensitive). Folder rows show `—` size, no modified. Deleted (tombstoned) objects never render — derive from `objects.filter(o => o.deleted_at === null)`.
- File-type icons by content_type prefix: `image/`→🖼, `video/`→🎬, `audio/`→🎵, `application/pdf`→📄, `text/`→📝, everything else →📦; folders 📁.
- YAGNI: no virtualization (10k rows renders fine), no drag-drop, no context menus, no selection checkboxes yet (PR 12 adds row actions), no thumbnails (PR 14 fills the grid tiles), no URL routing.

---

### Task 1: pure listing helpers (TDD)

**Files:**
- Create: `web/src/lib/listing.ts`
- Create: `web/tests/listing.test.ts`

**Interfaces:**
- Consumes: `ManifestObject` type from `core.ts`.
- Produces (used by Task 2 and PR 9's views):

```ts
export interface FolderEntry { name: string; prefix: string }          // prefix ends with "/"
export interface Listing { folders: FolderEntry[]; files: ManifestObject[] }
export function childEntries(objects: ManifestObject[], prefix: string): Listing;
export interface TreeNode { name: string; prefix: string; children: TreeNode[] }
export function buildTree(objects: ManifestObject[]): TreeNode[];      // top-level nodes, recursive, sorted
export function breadcrumbSegments(prefix: string): { label: string; prefix: string }[]; // root first: [{label:"All files",prefix:""}...]
export function formatSize(bytes: number): string;                     // "0 B","532 B","1.2 KB","4.2 MB","8.2 GB" (1024-based, 1 decimal ≥KB, trailing .0 stripped)
export function formatModified(iso: string, now?: Date): string;       // <60s "just now"; <1h "Nm ago"; <24h "Nh ago"; <7d "Nd ago"; else "Jan 5, 2026"
export function totalSize(objects: ManifestObject[]): number;
```

- [ ] **Step 1: Write the failing tests**

`web/tests/listing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../src/lib/core";
import {
  breadcrumbSegments,
  buildTree,
  childEntries,
  formatModified,
  formatSize,
  totalSize,
} from "../src/lib/listing";

function obj(key: string, extra: Partial<ManifestObject> = {}): ManifestObject {
  return {
    key,
    size: 100,
    etag: '"e"',
    last_modified: "2026-07-14T18:22:00Z",
    content_type: "application/octet-stream",
    favorite: false,
    thumbnail_key: null,
    deleted_at: null,
    ...extra,
  };
}

const objects = [
  obj("readme.txt"),
  obj("photos/2026/trip/IMG_0142.jpg"),
  obj("photos/2026/trip/IMG_0143.jpg"),
  obj("photos/2026/other.png"),
  obj("docs/plan.pdf"),
  obj("Docs-2/z.txt"), // exercises case-insensitive sort
];

describe("childEntries", () => {
  it("lists root folders and files, folders first, case-insensitive sort", () => {
    const { folders, files } = childEntries(objects, "");
    expect(folders.map((f) => f.name)).toEqual(["docs", "Docs-2", "photos"]);
    expect(folders.map((f) => f.prefix)).toEqual(["docs/", "Docs-2/", "photos/"]);
    expect(files.map((f) => f.key)).toEqual(["readme.txt"]);
  });

  it("lists a nested prefix without duplicating deeper folders", () => {
    const { folders, files } = childEntries(objects, "photos/");
    expect(folders.map((f) => f.name)).toEqual(["2026"]);
    expect(files).toEqual([]);
    const deeper = childEntries(objects, "photos/2026/");
    expect(deeper.folders.map((f) => f.name)).toEqual(["trip"]);
    expect(deeper.files.map((f) => f.key)).toEqual(["photos/2026/other.png"]);
  });

  it("excludes tombstoned objects entirely", () => {
    const withDeleted = [...objects, obj("gone.txt", { deleted_at: "2026-07-15T00:00:00Z" })];
    const { files } = childEntries(withDeleted, "");
    expect(files.map((f) => f.key)).not.toContain("gone.txt");
  });
});

describe("buildTree", () => {
  it("builds a sorted recursive tree of folders only", () => {
    const tree = buildTree(objects);
    expect(tree.map((n) => n.name)).toEqual(["docs", "Docs-2", "photos"]);
    const photos = tree[2];
    expect(photos.prefix).toBe("photos/");
    expect(photos.children.map((n) => n.name)).toEqual(["2026"]);
    expect(photos.children[0].children.map((n) => n.name)).toEqual(["trip"]);
    expect(photos.children[0].children[0].children).toEqual([]);
  });
});

describe("breadcrumbSegments", () => {
  it("always starts at All files and walks the prefix", () => {
    expect(breadcrumbSegments("")).toEqual([{ label: "All files", prefix: "" }]);
    expect(breadcrumbSegments("photos/2026/")).toEqual([
      { label: "All files", prefix: "" },
      { label: "photos", prefix: "photos/" },
      { label: "2026", prefix: "photos/2026/" },
    ]);
  });
});

describe("formatSize", () => {
  it("formats binary sizes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(532)).toBe("532 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(4 * 1024 * 1024)).toBe("4 MB");
    expect(formatSize(4404019)).toBe("4.2 MB");
    expect(formatSize(8.2 * 1024 ** 3)).toBe("8.2 GB");
  });
});

describe("formatModified", () => {
  const now = new Date("2026-07-15T12:00:00Z");
  it("uses relative ranges then absolute dates", () => {
    expect(formatModified("2026-07-15T11:59:30Z", now)).toBe("just now");
    expect(formatModified("2026-07-15T11:20:00Z", now)).toBe("40m ago");
    expect(formatModified("2026-07-15T03:00:00Z", now)).toBe("9h ago");
    expect(formatModified("2026-07-13T12:00:00Z", now)).toBe("2d ago");
    expect(formatModified("2026-01-05T00:00:00Z", now)).toBe("Jan 5, 2026");
  });
  it("tolerates unparseable timestamps", () => {
    expect(formatModified("not-a-date", now)).toBe("—");
  });
});

describe("totalSize", () => {
  it("sums live objects only", () => {
    const withDeleted = [...objects, obj("gone.txt", { size: 999999, deleted_at: "x" })];
    expect(totalSize(withDeleted)).toBe(objects.length * 100);
  });
});
```

- [ ] **Step 2: RED** — `cd web && npm test -- --run` → module not found.

- [ ] **Step 3: Implement `web/src/lib/listing.ts`**

```ts
// Pure derivation over the manifest: folder structure is computed from key
// prefixes at render time (design spec §4.1 — no stored folder rows).
import type { ManifestObject } from "./core";

export interface FolderEntry {
  name: string;
  prefix: string;
}

export interface Listing {
  folders: FolderEntry[];
  files: ManifestObject[];
}

const byName = new Intl.Collator(undefined, { sensitivity: "base" });

function live(objects: ManifestObject[]): ManifestObject[] {
  return objects.filter((o) => o.deleted_at === null);
}

/** Direct children of `prefix` ("" = root): sub-folders and files. */
export function childEntries(objects: ManifestObject[], prefix: string): Listing {
  const folders = new Map<string, FolderEntry>();
  const files: ManifestObject[] = [];
  for (const object of live(objects)) {
    if (!object.key.startsWith(prefix)) continue;
    const rest = object.key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push(object);
    } else {
      const name = rest.slice(0, slash);
      if (!folders.has(name)) {
        folders.set(name, { name, prefix: `${prefix}${name}/` });
      }
    }
  }
  return {
    folders: [...folders.values()].sort((a, b) => byName.compare(a.name, b.name)),
    files: files.sort((a, b) => byName.compare(a.key, b.key)),
  };
}

export interface TreeNode {
  name: string;
  prefix: string;
  children: TreeNode[];
}

/** Full folder tree (folders only), recursively sorted. */
export function buildTree(objects: ManifestObject[]): TreeNode[] {
  const build = (prefix: string): TreeNode[] =>
    childEntries(objects, prefix).folders.map((folder) => ({
      name: folder.name,
      prefix: folder.prefix,
      children: build(folder.prefix),
    }));
  return build("");
}

export function breadcrumbSegments(
  prefix: string,
): { label: string; prefix: string }[] {
  const segments = [{ label: "All files", prefix: "" }];
  let acc = "";
  for (const part of prefix.split("/").filter(Boolean)) {
    acc += `${part}/`;
    segments.push({ label: part, prefix: acc });
  }
  return segments;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  const rounded = value >= 100 ? Math.round(value).toString() : (Math.round(value * 10) / 10).toString();
  return `${rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded} ${unit}`;
}

export function formatModified(iso: string, now: Date = new Date()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const seconds = Math.max(0, (now.getTime() - time) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(time).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function totalSize(objects: ManifestObject[]): number {
  return live(objects).reduce((sum, o) => sum + o.size, 0);
}
```

(If `formatSize(4 * 1024 * 1024)` produces `"4 MB"` vs `"4.0 MB"` mismatches, the trailing-`.0`-strip handles it; adjust only the test-vs-impl mismatch minimally and note it.)

- [ ] **Step 4: GREEN** — `npm test -- --run` → all listing tests pass (plus existing 6 profile tests).

- [ ] **Step 5: Gates + commit**

```bash
npm run check && npm test -- --run && npm run build
git add web/src/lib/listing.ts web/tests/listing.test.ts
git commit -m "feat: add manifest listing derivation helpers"
```

---

### Task 2: browse state + layout components

**Files:**
- Create: `web/src/lib/browse.svelte.ts`
- Modify: `web/src/lib/session.svelte.ts` (add `refresh()` + `lastReport`)
- Create: `web/src/components/TopBar.svelte`, `web/src/components/Sidebar.svelte`, `web/src/components/Breadcrumbs.svelte`, `web/src/components/FileList.svelte`, `web/src/components/FileGrid.svelte`
- Create: `web/src/lib/icons.ts`
- Replace: `web/src/screens/BrowseScreen.svelte`

**Interfaces:**

```ts
// browse.svelte.ts
browse.prefix: string                    // current folder ("" = root)
browse.view: "list" | "grid"            // persisted to localStorage "bare-bucket/view"
browse.navigate(prefix: string): void
browse.toggleView(): void
browse.reset(): void                    // called on disconnect

// session additions
session.refresh(): Promise<void>        // reconcile([]) + load_manifest; sets lastReport; errors to session.error? NO — separate refreshError to avoid connect-screen coupling; sets refreshing flag
session.refreshing: boolean
session.lastReport: ReconcileReport | null
session.refreshError: string | null

// icons.ts
export function iconFor(contentType: string): string  // per the Global Constraints table
```

- [ ] **Step 1: Implement `web/src/lib/icons.ts`** (with a small vitest in `web/tests/icons.test.ts`: image/jpeg→🖼, video/mp4→🎬, audio/mpeg→🎵, application/pdf→📄, text/plain→📝, application/zip→📦)

```ts
export function iconFor(contentType: string): string {
  if (contentType.startsWith("image/")) return "🖼";
  if (contentType.startsWith("video/")) return "🎬";
  if (contentType.startsWith("audio/")) return "🎵";
  if (contentType === "application/pdf") return "📄";
  if (contentType.startsWith("text/")) return "📝";
  return "📦";
}
```

- [ ] **Step 2: Implement `browse.svelte.ts`**

```ts
import { session } from "./session.svelte";

type View = "list" | "grid";
const VIEW_KEY = "bare-bucket/view";

function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export const browse = $state({
  prefix: "",
  view: storedView() as View,

  navigate(prefix: string) {
    browse.prefix = prefix;
  },
  toggleView() {
    browse.view = browse.view === "list" ? "grid" : "list";
    try {
      localStorage.setItem(VIEW_KEY, browse.view);
    } catch {
      /* view preference is best-effort */
    }
  },
  reset() {
    browse.prefix = "";
  },
});

// keep session import used (disconnect hook wiring happens in TopBar)
void session;
```

(If the trailing `void session;` is unnecessary because session isn't imported, drop the import entirely — decide while implementing; keep the file free of dead imports.)

- [ ] **Step 3: Extend `session.svelte.ts`**

Add to the Session interface + object:

```ts
  refreshing: false as boolean,
  lastReport: null as ReconcileReport | null,
  refreshError: null as string | null,

  async refresh() {
    if (!session.client || session.refreshing) return;
    session.refreshing = true;
    session.refreshError = null;
    try {
      session.lastReport = (await session.client.reconcile([])) as ReconcileReport;
      session.manifest = (await session.client.load_manifest()) as Manifest;
    } catch (e) {
      session.refreshError = describeError(e);
    } finally {
      session.refreshing = false;
    }
  },
```

(Import `ReconcileReport` type; `disconnect()` additionally clears `lastReport`/`refreshError` and calls nothing else new.)

- [ ] **Step 4: Components** — follow the mockup structurally; shared tokens from theme.css. Complete code:

`web/src/components/TopBar.svelte`:

```svelte
<script lang="ts">
  import { session } from "../lib/session.svelte";
  import { browse } from "../lib/browse.svelte";

  function switchProfile() {
    browse.reset();
    session.disconnect();
  }
</script>

<header>
  <span class="wordmark">▙ bare<span class="accent">bucket</span></span>
  <button class="chip" title="Switch profile" onclick={switchProfile}>
    {session.profileName} ▾
  </button>
  <span class="spacer"></span>
  {#if session.lastReport && session.lastReport.conditional === false}
    <span class="warn" title="This provider rejected conditional writes; concurrent changes can be lost.">⚠ unconditional writes</span>
  {/if}
  {#if session.refreshError}
    <span class="warn" title={session.refreshError}>⚠ refresh failed</span>
  {/if}
  <button class="ghost" onclick={() => session.refresh()} disabled={session.refreshing}>
    {session.refreshing ? "⟳ Refreshing…" : "⟳ Refresh"}
  </button>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    background: var(--bg-deep);
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
  }
  .wordmark {
    font-weight: 700;
    color: var(--text-bright);
  }
  .accent {
    color: var(--accent);
  }
  .chip {
    background: var(--surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    padding: 3px 12px;
    color: var(--accent-text);
  }
  .spacer {
    flex: 1;
  }
  .warn {
    color: #eab308;
    font-size: 12px;
  }
  .ghost {
    background: none;
    border: none;
    color: var(--text-dim);
    padding: 4px 8px;
    border-radius: var(--radius-small);
  }
  .ghost:hover {
    color: var(--text-bright);
    background: var(--surface-raised);
  }
  .ghost:disabled {
    opacity: 0.6;
  }
</style>
```

`web/src/components/Sidebar.svelte`:

```svelte
<script lang="ts">
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";
  import { buildTree, type TreeNode } from "../lib/listing";
  import SidebarNode from "./SidebarNode.svelte";

  const tree = $derived(buildTree(session.manifest?.objects ?? []));
</script>

<nav>
  <ul class="views">
    <li>
      <button class:active={browse.prefix === ""} onclick={() => browse.navigate("")}>
        📁 All files
      </button>
    </li>
  </ul>
  <div class="label">Folders</div>
  <ul class="tree">
    {#each tree as node (node.prefix)}
      <SidebarNode {node} />
    {/each}
  </ul>
</nav>

<style>
  nav {
    width: 220px;
    flex-shrink: 0;
    background: var(--sidebar);
    border-right: 1px solid var(--border);
    padding: 12px 8px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .views button {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 6px 10px;
    border-radius: var(--radius-small);
  }
  .views button.active {
    background: var(--accent-soft);
    color: var(--accent-text);
    font-weight: 600;
  }
  .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-dim);
    padding: 0 10px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .tree {
    flex: 1;
  }
</style>
```

`web/src/components/SidebarNode.svelte` (recursive; add to the Files list in this task):

```svelte
<script lang="ts">
  import type { TreeNode } from "../lib/listing";
  import { browse } from "../lib/browse.svelte";
  import SidebarNode from "./SidebarNode.svelte";

  let { node, depth = 0 }: { node: TreeNode; depth?: number } = $props();
  let expanded = $state(false);

  const active = $derived(browse.prefix === node.prefix);
  // Auto-expand ancestors of the current prefix
  $effect(() => {
    if (browse.prefix.startsWith(node.prefix) && browse.prefix !== node.prefix) {
      expanded = true;
    }
  });
</script>

<li>
  <div class="row" class:active style={`padding-left: ${8 + depth * 12}px`}>
    {#if node.children.length > 0}
      <button class="twist" onclick={() => (expanded = !expanded)}>
        {expanded ? "▾" : "▸"}
      </button>
    {:else}
      <span class="twist-placeholder"></span>
    {/if}
    <button class="name" onclick={() => browse.navigate(node.prefix)}>{node.name}</button>
  </div>
  {#if expanded}
    <ul>
      {#each node.children as child (child.prefix)}
        <SidebarNode node={child} depth={depth + 1} />
      {/each}
    </ul>
  {/if}
</li>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: var(--radius-small);
  }
  .row.active {
    background: var(--accent-soft);
  }
  .row.active .name {
    color: var(--accent-text);
    font-weight: 600;
  }
  .twist,
  .twist-placeholder {
    width: 18px;
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--text-dim);
    padding: 0;
    display: inline-block;
  }
  .name {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    padding: 4px 6px 4px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
```

`web/src/components/Breadcrumbs.svelte`:

```svelte
<script lang="ts">
  import { breadcrumbSegments } from "../lib/listing";
  import { browse } from "../lib/browse.svelte";

  const segments = $derived(breadcrumbSegments(browse.prefix));
</script>

<span class="crumbs">
  {#each segments as segment, i (segment.prefix)}
    {#if i > 0}<span class="sep">▸</span>{/if}
    <button
      class:current={i === segments.length - 1}
      onclick={() => browse.navigate(segment.prefix)}>{segment.label}</button>
  {/each}
</span>

<style>
  .crumbs {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
  }
  .sep {
    color: var(--text-dim);
  }
  button {
    background: none;
    border: none;
    color: var(--accent-text);
    padding: 2px 4px;
    border-radius: 4px;
    white-space: nowrap;
  }
  button.current {
    color: var(--text-bright);
    font-weight: 600;
  }
  button:hover {
    background: var(--surface-raised);
  }
</style>
```

`web/src/components/FileList.svelte`:

```svelte
<script lang="ts">
  import type { Listing } from "../lib/listing";
  import { formatModified, formatSize } from "../lib/listing";
  import { iconFor } from "../lib/icons";
  import { browse } from "../lib/browse.svelte";

  let { listing }: { listing: Listing } = $props();

  function fileName(key: string): string {
    return key.slice(browse.prefix.length);
  }
</script>

<table>
  <thead>
    <tr><th class="name">Name</th><th class="num">Size</th><th class="num">Modified</th></tr>
  </thead>
  <tbody>
    {#each listing.folders as folder (folder.prefix)}
      <tr class="clickable" onclick={() => browse.navigate(folder.prefix)}>
        <td class="name">📁 {folder.name}</td>
        <td class="num">—</td>
        <td class="num"></td>
      </tr>
    {/each}
    {#each listing.files as file (file.key)}
      <tr>
        <td class="name">{iconFor(file.content_type)} {fileName(file.key)}</td>
        <td class="num">{formatSize(file.size)}</td>
        <td class="num">{formatModified(file.last_modified)}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-dim);
    font-weight: 600;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-bright);
  }
  th.num,
  td.num {
    text-align: right;
    color: var(--text-dim);
    width: 110px;
    white-space: nowrap;
  }
  td.name {
    overflow-wrap: anywhere;
  }
  tr.clickable {
    cursor: pointer;
  }
  tr.clickable:hover td {
    background: var(--surface);
  }
</style>
```

`web/src/components/FileGrid.svelte`:

```svelte
<script lang="ts">
  import type { Listing } from "../lib/listing";
  import { iconFor } from "../lib/icons";
  import { browse } from "../lib/browse.svelte";

  let { listing }: { listing: Listing } = $props();

  function fileName(key: string): string {
    return key.slice(browse.prefix.length);
  }
</script>

<div class="grid">
  {#each listing.folders as folder (folder.prefix)}
    <button class="tile" onclick={() => browse.navigate(folder.prefix)}>
      <span class="thumb">📁</span>
      <span class="caption">{folder.name}</span>
    </button>
  {/each}
  {#each listing.files as file (file.key)}
    <div class="tile">
      <span class="thumb">{iconFor(file.content_type)}</span>
      <span class="caption">{fileName(file.key)}</span>
    </div>
  {/each}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
  }
  .tile {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px;
    display: grid;
    gap: 8px;
    text-align: center;
    color: inherit;
    font: inherit;
  }
  button.tile {
    cursor: pointer;
  }
  button.tile:hover {
    border-color: var(--border-strong);
    background: var(--surface-raised);
  }
  .thumb {
    font-size: 34px;
    line-height: 64px;
    height: 64px;
    background: var(--input-bg);
    border-radius: var(--radius-small);
  }
  .caption {
    font-size: 12px;
    color: var(--text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
```

`web/src/screens/BrowseScreen.svelte` (replace):

```svelte
<script lang="ts">
  import TopBar from "../components/TopBar.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import Breadcrumbs from "../components/Breadcrumbs.svelte";
  import FileList from "../components/FileList.svelte";
  import FileGrid from "../components/FileGrid.svelte";
  import { browse } from "../lib/browse.svelte";
  import { session } from "../lib/session.svelte";
  import { childEntries, formatSize, totalSize } from "../lib/listing";

  const listing = $derived(childEntries(session.manifest?.objects ?? [], browse.prefix));
  const footer = $derived.by(() => {
    const bytes = totalSize(
      (session.manifest?.objects ?? []).filter((o) => o.key.startsWith(browse.prefix)),
    );
    const folders = listing.folders.length;
    const files = listing.files.length;
    return `${folders} folder${folders === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} · ${formatSize(bytes)}`;
  });
</script>

<div class="screen">
  <TopBar />
  <div class="body">
    <Sidebar />
    <main>
      <div class="toolbar">
        <button class="upload" disabled title="Uploads arrive in a later phase">＋ Upload</button>
        <Breadcrumbs />
        <span class="spacer"></span>
        <button class="ghost" onclick={() => browse.toggleView()} title="Toggle view">
          {browse.view === "list" ? "▦" : "☰"}
        </button>
      </div>
      <div class="content">
        {#if browse.view === "list"}
          <FileList {listing} />
        {:else}
          <FileGrid {listing} />
        {/if}
        {#if listing.folders.length === 0 && listing.files.length === 0}
          <p class="empty">This folder is empty.</p>
        {/if}
      </div>
      <div class="footer">{footer}</div>
    </main>
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 12px 16px;
    gap: 10px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .upload {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius-small);
    padding: 7px 14px;
    font-weight: 700;
  }
  .upload:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .spacer {
    flex: 1;
  }
  .ghost {
    background: none;
    border: 1px solid var(--border-strong);
    color: var(--text-dim);
    border-radius: var(--radius-small);
    padding: 5px 10px;
  }
  .content {
    flex: 1;
    overflow-y: auto;
  }
  .empty {
    color: var(--text-dim);
    text-align: center;
    padding: 40px 0;
  }
  .footer {
    color: var(--text-dim);
    font-size: 12px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
</style>
```

Also: in `session.disconnect()`, call `browse.reset()`? NO — circular import risk; TopBar's `switchProfile` already resets browse before disconnecting. Note this in the code where relevant.

- [ ] **Step 5: Gates + commit**

```bash
cd web && npm run check && npm test -- --run && npm run build
git add web/src
git commit -m "feat: add browse UI with folder navigation and list/grid views"
```

(Two commits total for this task are fine if you prefer icons+state separate from components — keep each atomic.)

---

### Task 3: demo seed script + preview

**Files:**
- Create: `scripts/seed-demo.sh`

- [ ] **Step 1: Create the seed script** — the wasm surface has no PUT yet (uploads are PR 10), so seeding goes through the `mc` container. Create `scripts/seed-demo.sh`:

```bash
#!/usr/bin/env bash
# Seeds the local MinIO bucket with a realistic tree for browse-UI testing.
# Usage: scripts/seed-demo.sh   (MinIO + createbucket must have run)
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

make_file() { # path bytes
  mkdir -p "$tmp/$(dirname "$1")"
  head -c "$2" /dev/urandom > "$tmp/$1"
}

make_file "photos/2026/trip/IMG_0142.jpg" 180000
make_file "photos/2026/trip/IMG_0143.jpg" 210000
make_file "photos/2026/other.png"          90000
make_file "photos/2025/archive.jpg"       120000
make_file "docs/itinerary.pdf"             48000
make_file "docs/notes.txt"                  2000
make_file "videos/clip.mp4"               900000
make_file "readme.md"                       1200

docker run --rm --network host -v "$tmp":/seed:z --entrypoint sh minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727 -c '
  mc alias set local http://127.0.0.1:9000 baretest baretest123 &&
  mc cp --recursive /seed/ local/bare-bucket-it/
'
echo "Seeded. Open the app and hit Refresh (or reconnect) to rebuild the manifest."
```

Make it executable (`chmod +x scripts/seed-demo.sh`).

- [ ] **Step 2: Run it + verify via the app's own core**

```bash
docker compose up -d --wait minio && docker compose run --rm createbucket
scripts/seed-demo.sh
node scripts/wasm-smoke.mjs   # reconcile discovers the seeded tree; expect objects >= 8 in load_manifest output
```

Expected: smoke prints `load_manifest: ok, 8 objects` (or more).

- [ ] **Step 3: Build + preview for the controller's live validation**

```bash
source "$HOME/.cargo/env" && wasm-pack build core --target web
cd web && npm run build
```

(Leave the preview to the controller — do not start long-running servers from this task.)

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-demo.sh
git commit -m "chore: add demo seed script for browse testing"
```
