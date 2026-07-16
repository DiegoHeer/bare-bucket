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
  clearError(): void;
}

const DEVICE_ID_KEY = "bare-bucket/device-id";

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

  async connect(profile: Profile, secretAccessKey: string) {
    if (session.connecting) return;
    session.connecting = true;
    session.error = null;
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
      await client.reconcile([]); // refresh-on-open + first-connect bootstrap (spec §6)
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

  async refreshManifest() {
    if (!session.client) return;
    session.manifest = (await session.client.load_manifest()) as Manifest;
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
  },

  clearError() {
    session.error = null;
  },
});
