import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyRotator } from "../../../src/auth/rotation.js";
import { AuthProfileStore } from "../../../src/auth/profiles.js";

describe("KeyRotator", () => {
  let tmpDir: string;
  let store: AuthProfileStore;
  let rotator: KeyRotator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rot-"));
    const storePath = path.join(tmpDir, "auth-profiles.json");
    store = new AuthProfileStore(storePath);
    store.addProfile("anthropic:a", { type: "api_key", provider: "anthropic", key: "key-a" });
    store.addProfile("anthropic:b", { type: "api_key", provider: "anthropic", key: "key-b" });
    store.addProfile("anthropic:c", { type: "api_key", provider: "anthropic", key: "key-c" });
    rotator = new KeyRotator(store);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("resolves key from first profile in order", () => {
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-a");
  });

  it("resolves from env override first", () => {
    process.env.CODING_STUDIO_LIVE_ANTHROPIC_KEY = "env-override";
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("env-override");
    delete process.env.CODING_STUDIO_LIVE_ANTHROPIC_KEY;
  });

  it("falls back to generic env var", () => {
    const key = rotator.resolveKeyForProvider("google");
    expect(key).toBeUndefined();

    process.env.GOOGLE_API_KEY = "generic-google-key";
    const key2 = rotator.resolveKeyForProvider("google");
    expect(key2).toBe("generic-google-key");
    delete process.env.GOOGLE_API_KEY;
  });

  it("skips rate-limited keys", () => {
    rotator.markRateLimited("anthropic:a", 60_000);
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-b");
  });

  it("returns to rate-limited key after cooldown expires", () => {
    rotator.markRateLimited("anthropic:a", -1); // negative = already expired
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-a");
  });

  it("returns undefined when all keys are rate-limited", () => {
    rotator.markRateLimited("anthropic:a", 60_000);
    rotator.markRateLimited("anthropic:b", 60_000);
    rotator.markRateLimited("anthropic:c", 60_000);
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBeUndefined();
  });

  it("prefers lastGood profile", () => {
    store.setLastGood("anthropic", "anthropic:b");
    rotator = new KeyRotator(store);
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-b");
  });
});
