import type { RateLimitInfo } from "./types.js";
import type { AuthProfileStore } from "./profiles.js";

export class KeyRotator {
  private store: AuthProfileStore;
  private rateLimits: Map<string, RateLimitInfo> = new Map();

  constructor(store: AuthProfileStore) {
    this.store = store;
  }

  resolveKeyForProvider(provider: string): string | undefined {
    // Priority 1: Live env override
    const liveEnvKey = `CODING_STUDIO_LIVE_${provider.toUpperCase()}_KEY`;
    if (process.env[liveEnvKey]) {
      return process.env[liveEnvKey];
    }

    // Priority 2: Profile store (lastGood first, then order)
    const order = this.store.getProviderOrder(provider);
    const lastGood = this.store.getLastGood(provider);

    const sortedOrder = lastGood && order.includes(lastGood)
      ? [lastGood, ...order.filter((id) => id !== lastGood)]
      : order;

    const now = Date.now();
    for (const profileId of sortedOrder) {
      const limit = this.rateLimits.get(profileId);
      if (limit && limit.cooldownUntil > now) {
        continue;
      }
      if (limit) {
        this.rateLimits.delete(profileId);
      }
      const key = this.store.resolveKey(profileId);
      if (key) {
        this.store.setLastGood(provider, profileId);
        return key;
      }
    }

    // Priority 3: Generic env var fallback
    const genericEnvKey = `${provider.toUpperCase()}_API_KEY`;
    if (process.env[genericEnvKey]) {
      return process.env[genericEnvKey];
    }

    return undefined;
  }

  markRateLimited(profileId: string, cooldownMs: number): void {
    this.rateLimits.set(profileId, {
      profileId,
      cooldownUntil: Date.now() + cooldownMs,
    });
  }

  clearRateLimits(): void {
    this.rateLimits.clear();
  }
}
