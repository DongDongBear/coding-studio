import { describe, it, expect, beforeEach } from "vitest";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { KeyRotator } from "../../../src/auth/rotation.js";

describe("KeyRotator", () => {
  let authStorage: AuthStorage;
  let rotator: KeyRotator;

  beforeEach(() => {
    authStorage = AuthStorage.inMemory();
    authStorage.set("anthropic", { type: "api_key", key: "key-anthropic" });
    authStorage.set("openai", { type: "api_key", key: "key-openai" });
    rotator = new KeyRotator(authStorage);
  });

  it("resolves key from AuthStorage", async () => {
    const key = await rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-anthropic");
  });

  it("resolves from env override first", async () => {
    process.env.CODING_STUDIO_LIVE_ANTHROPIC_KEY = "env-override";
    const key = await rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("env-override");
    delete process.env.CODING_STUDIO_LIVE_ANTHROPIC_KEY;
  });

  it("returns undefined for unknown provider", async () => {
    const key = await rotator.resolveKeyForProvider("unknown-provider");
    expect(key).toBeUndefined();
  });

  it("returns undefined when provider is rate-limited", async () => {
    rotator.markRateLimited("anthropic", 60_000);
    const key = await rotator.resolveKeyForProvider("anthropic");
    expect(key).toBeUndefined();
  });

  it("returns key after rate-limit cooldown expires", async () => {
    rotator.markRateLimited("anthropic", -1); // already expired
    const key = await rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-anthropic");
  });

  it("does not affect other providers when one is rate-limited", async () => {
    rotator.markRateLimited("anthropic", 60_000);
    const key = await rotator.resolveKeyForProvider("openai");
    expect(key).toBe("key-openai");
  });

  it("clears all rate limits", async () => {
    rotator.markRateLimited("anthropic", 60_000);
    rotator.clearRateLimits();
    const key = await rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-anthropic");
  });
});
