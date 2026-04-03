import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthProfileStore } from "../../../src/auth/profiles.js";

describe("AuthProfileStore", () => {
  let tmpDir: string;
  let storePath: string;
  let store: AuthProfileStore;
  const FIXTURE = path.resolve(import.meta.dirname, "../../fixtures/auth-profiles.json");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-auth-"));
    storePath = path.join(tmpDir, "auth-profiles.json");
    fs.copyFileSync(FIXTURE, storePath);
    store = new AuthProfileStore(storePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("loads profiles from disk", () => {
    const profile = store.getProfile("anthropic:main");
    expect(profile).toBeDefined();
    expect(profile!.type).toBe("api_key");
    expect(profile!.provider).toBe("anthropic");
  });

  it("returns undefined for unknown profile", () => {
    expect(store.getProfile("unknown:nope")).toBeUndefined();
  });

  it("lists profiles for a provider in order", () => {
    const ids = store.getProviderOrder("anthropic");
    expect(ids).toEqual(["anthropic:main", "anthropic:backup", "anthropic:sub"]);
  });

  it("returns empty array for provider with no profiles", () => {
    expect(store.getProviderOrder("google")).toEqual([]);
  });

  it("resolves API key from api_key profile", () => {
    const key = store.resolveKey("anthropic:main");
    expect(key).toBe("sk-ant-test-key-1");
  });

  it("resolves token from token profile", () => {
    const key = store.resolveKey("anthropic:sub");
    expect(key).toBe("tok-sub-test");
  });

  it("adds a new profile and persists", () => {
    store.addProfile("google:main", {
      type: "api_key",
      provider: "google",
      key: "AIza-test",
    });
    // Re-read from disk
    const fresh = new AuthProfileStore(storePath);
    expect(fresh.getProfile("google:main")).toBeDefined();
    expect(fresh.resolveKey("google:main")).toBe("AIza-test");
  });

  it("updates lastGood", () => {
    store.setLastGood("anthropic", "anthropic:backup");
    const fresh = new AuthProfileStore(storePath);
    expect(fresh.getLastGood("anthropic")).toBe("anthropic:backup");
  });

  it("creates new store file if none exists", () => {
    const newPath = path.join(tmpDir, "new-profiles.json");
    const newStore = new AuthProfileStore(newPath);
    newStore.addProfile("test:first", {
      type: "api_key",
      provider: "test",
      key: "test-key",
    });
    expect(fs.existsSync(newPath)).toBe(true);
  });
});
