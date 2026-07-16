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

function isProfile(value: unknown): value is Profile {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.endpoint === "string" &&
    typeof p.region === "string" &&
    typeof p.bucket === "string" &&
    typeof p.accessKeyId === "string" &&
    typeof p.pathStyle === "boolean"
  );
}

export function listProfiles(storage: Storage = defaultStorage()): Profile[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isProfile) : [];
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
