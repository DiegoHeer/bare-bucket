import { beforeEach, describe, expect, it } from "vitest";
import {
  createProfile,
  deleteProfile,
  listProfiles,
  saveProfile,
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
