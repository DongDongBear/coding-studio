import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProviderRegistry } from "../../../src/providers/registry.js";

// Mock pi-ai — we cannot depend on real API keys or network in unit tests
vi.mock("@mariozechner/pi-ai", () => ({
  getProviders: () => ["anthropic", "openai", "google"],
  getModels: (provider?: string) => {
    const all = [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200000, maxTokens: 16384 },
      { id: "gpt-5.4", name: "GPT-5.4", provider: "openai", cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 10 }, contextWindow: 256000, maxTokens: 32768 },
    ];
    return provider ? all.filter((m) => m.provider === provider) : all;
  },
  getModel: (provider: string, id: string) => {
    const models = [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200000, maxTokens: 16384 },
    ];
    const found = models.find((m) => m.provider === provider && m.id === id);
    if (!found) throw new Error(`Model not found: ${provider}/${id}`);
    return found;
  },
}));

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("lists available providers", () => {
    const providers = registry.listProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
  });

  it("lists models for a provider", () => {
    const models = registry.listModels("anthropic");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].provider).toBe("anthropic");
  });

  it("lists all models when no provider specified", () => {
    const models = registry.listModels();
    expect(models.length).toBe(2);
  });

  it("resolves a model by provider + id", () => {
    const model = registry.resolveModel("anthropic", "claude-sonnet-4-20250514");
    expect(model).toBeDefined();
    expect(model!.id).toBe("claude-sonnet-4-20250514");
  });

  it("returns undefined for unknown model", () => {
    const model = registry.resolveModel("anthropic", "nonexistent");
    expect(model).toBeUndefined();
  });
});
