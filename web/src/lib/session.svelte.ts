// App-level session state (Svelte 5 runes). One connection at a time.
import {
  createClient,
  type Manifest,
  type ManifestObject,
  type ReconcileReport,
  type WasmClient,
} from "./core";
import type { Profile } from "./profiles";
import { transfers } from "./transfers.svelte";

interface Session {
  status: "connect" | "connected";
  connecting: boolean;
  error: string | null;
  profileName: string;
  client: WasmClient | null;
  manifest: Manifest | null;
  refreshing: boolean;
  lastReport: ReconcileReport | null;
  refreshError: string | null;
  connect(profile: Profile, secretAccessKey: string): Promise<void>;
  refresh(): Promise<void>;
  disconnect(): void;
  clearError(): void;
  toggleFavorite(key: string): Promise<void>;
  applyUpsert(object: ManifestObject): void;
}

const DEVICE_ID_KEY = "bare-bucket/device-id";

/** Keys with an in-flight `set_favorite` call — guards against a rapid
 * double-toggle producing order-dependent state on failure. */
const favoriteInflight = new Set<string>();

/** A stable per-browser device id (spec §4.1 last-writer tracking) —
 * generated once and cached in localStorage. Falls back to a fresh,
 * unpersisted id if localStorage is unavailable (private browsing, etc). */
function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const generated = `web-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    return `web-${crypto.randomUUID().slice(0, 8)}`;
  }
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
  refreshing: false,
  lastReport: null,
  refreshError: null,

  async connect(profile: Profile, secretAccessKey: string) {
    if (session.connecting) return;
    session.connecting = true;
    session.error = null;
    session.refreshError = null;
    let client: WasmClient | undefined;
    try {
      client = createClient({
        endpoint: profile.endpoint,
        region: profile.region,
        bucket: profile.bucket,
        pathStyle: profile.pathStyle,
        accessKeyId: profile.accessKeyId,
        secretAccessKey,
        deviceId: deviceId(),
      });
      await client.validate();
      // refresh-on-open + first-connect bootstrap (spec §6); capture the
      // report so a degraded-provider warning is visible immediately.
      // [B7] activeUploadIds() so a fresh connect never races an upload
      // that started before this session existed (there shouldn't be one,
      // but reconcile's contract takes the list regardless).
      session.lastReport = (await client.reconcile(transfers.activeUploadIds())) as ReconcileReport;
      session.manifest = (await client.load_manifest()) as Manifest;
      session.client = client;
      session.profileName = profile.name;
      session.status = "connected";
    } catch (e) {
      session.error = describeError(e);
      if (client) {
        try {
          client.free();
        } catch {
          /* mid-flight borrow; GC fallback */
        }
      }
    } finally {
      session.connecting = false;
    }
  },

  /** Manual refresh (spec §6): reconciles remote changes, then reloads the
   * manifest. Uses a dedicated `refreshError` (not `session.error`) so a
   * failed refresh doesn't bounce the connected UI back to the connect
   * screen's error handling. */
  async refresh() {
    if (!session.client || session.refreshing) return;
    session.refreshing = true;
    session.refreshError = null;
    try {
      // [B7] never abort an in-flight multipart upload out from under the
      // user just because they hit Refresh.
      session.lastReport = (await session.client.reconcile(
        transfers.activeUploadIds(),
      )) as ReconcileReport;
      session.manifest = (await session.client.load_manifest()) as Manifest;
    } catch (e) {
      session.refreshError = describeError(e);
    } finally {
      session.refreshing = false;
    }
  },

  disconnect() {
    try {
      session.client?.free();
    } catch {
      /* mid-flight borrow; GC fallback */
    }
    session.status = "connect";
    session.client = null; // drops the wasm instance and the secret with it
    session.manifest = null;
    session.profileName = "";
    session.error = null;
    session.lastReport = null;
    session.refreshError = null;
  },

  clearError() {
    session.error = null;
  },

  /** Optimistic favorite toggle (spec §... ) — flips the local flag
   * immediately for a snappy UI, then persists across the wasm boundary;
   * reverts and surfaces `refreshError` on failure. */
  async toggleFavorite(key: string) {
    if (!session.client || !session.manifest) return;
    if (favoriteInflight.has(key)) return;
    const object = session.manifest.objects.find((o) => o.key === key);
    if (!object) return;
    const next = !object.favorite;
    object.favorite = next; // optimistic
    favoriteInflight.add(key);
    try {
      await session.client.set_favorite(key, next);
      // Re-assert on the live instance — an overlapping refresh() may have
      // replaced `session.manifest` with pre-write data between the
      // optimistic flip and this write completing.
      const found = session.manifest?.objects.find((o) => o.key === key);
      if (found) found.favorite = next;
    } catch (e) {
      // Revert on the live instance — a concurrent refresh() may have
      // replaced `session.manifest.objects` with a new array, detaching
      // the captured `object` reference.
      const found = session.manifest?.objects.find((o) => o.key === key);
      if (found) found.favorite = !next;
      session.refreshError = describeError(e);
    } finally {
      favoriteInflight.delete(key);
    }
  },

  /** Local manifest upsert after a completed upload [B8][B10] — avoids a
   * full refresh() round-trip. `object`'s `favorite`/`thumbnail_key` are
   * ignored on input and recomputed here from any existing row, mirroring
   * `WasmClient::upsert_object`'s preservation rule (core/src/wasm_api.rs):
   * favorite always carries over; thumbnail_key carries over only when the
   * existing row's etag matches the new one, else it's cleared. A
   * tombstoned existing row (deleted_at !== null) is treated as absent —
   * re-uploading over a deleted key is a fresh object, not a restore, so it
   * must not inherit a stale favorite/thumbnail. Keep in sync with
   * core/src/wasm_api.rs's upsert_object. */
  applyUpsert(object: ManifestObject) {
    if (!session.manifest) return;
    const objects = session.manifest.objects;
    const found = objects.find((o) => o.key === object.key);
    const existing = found && found.deleted_at === null ? found : null;
    const merged: ManifestObject = {
      ...object,
      favorite: existing ? existing.favorite : false,
      thumbnail_key: existing && existing.etag === object.etag ? existing.thumbnail_key : null,
      deleted_at: null,
    };
    const index = objects.findIndex((o) => o.key === object.key);
    if (index >= 0) objects[index] = merged;
    else objects.push(merged);
  },
});
