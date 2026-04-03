import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { RateLimitInfo } from "./types.js";

/**
 * Wraps pi's AuthStorage with rate-limit tracking.
 * AuthStorage already handles: stored keys > OAuth token refresh > env vars.
 * KeyRotator adds: live env override + rate-limit cooldown per provider.
 */
export class KeyRotator {
  private authStorage: AuthStorage;
  private rateLimits: Map<string, RateLimitInfo> = new Map();

  constructor(authStorage: AuthStorage) {
    this.authStorage = authStorage;
  }

  async resolveKeyForProvider(provider: string): Promise<string | undefined> {
    // Priority 1: Live env override (coding-studio specific)
    const liveEnvKey = `CODING_STUDIO_LIVE_${provider.toUpperCase()}_KEY`;
    if (process.env[liveEnvKey]) {
      return process.env[liveEnvKey];
    }

    // Priority 2: Check rate-limit cooldown
    const limit = this.rateLimits.get(provider);
    const now = Date.now();
    if (limit && limit.cooldownUntil > now) {
      return undefined;
    }
    if (limit) {
      this.rateLimits.delete(provider);
    }

    // Priority 3: pi AuthStorage (handles stored keys, OAuth refresh, env fallback)
    return this.authStorage.getApiKey(provider);
  }

  markRateLimited(provider: string, cooldownMs: number): void {
    this.rateLimits.set(provider, {
      provider,
      cooldownUntil: Date.now() + cooldownMs,
    });
  }

  clearRateLimits(): void {
    this.rateLimits.clear();
  }
}
