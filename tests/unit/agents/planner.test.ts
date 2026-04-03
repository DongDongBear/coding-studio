import { describe, it, expect, vi } from "vitest";
import { Planner, buildPlannerSystemPrompt } from "../../../src/agents/planner.js";
import type { PlannerConfig, PlannerModelConfig } from "../../../src/agents/planner.js";

// Mock pi-agent-core and pi-ai
vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: vi.fn().mockImplementation(() => {
    let storedListener: Function | null = null;
    return {
      subscribe: vi.fn((listener: Function) => {
        storedListener = listener;
      }),
      prompt: vi.fn().mockImplementation(async () => {
        // Fire text delta event synchronously before resolving
        storedListener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "# Product Spec\n\nA great app." },
        });
      }),
      state: {},
    };
  }),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn(() => ({
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    api: "anthropic-messages",
  })),
}));

const testPlannerConfig: PlannerConfig = {
  ambitious: true,
  injectAIFeatures: true,
  techPreferences: {
    frontend: "React + Vite",
    backend: "FastAPI",
    database: "SQLite",
  },
};

const testModelConfig: PlannerModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
};

describe("buildPlannerSystemPrompt", () => {
  it("includes ambitious instruction when enabled", () => {
    const prompt = buildPlannerSystemPrompt(testPlannerConfig);
    expect(prompt).toContain("ambitious");
    expect(prompt).toContain("truly impressive");
  });

  it("includes AI features instruction when enabled", () => {
    const prompt = buildPlannerSystemPrompt(testPlannerConfig);
    expect(prompt).toContain("AI-powered features");
  });

  it("omits ambitious when disabled", () => {
    const prompt = buildPlannerSystemPrompt({ ...testPlannerConfig, ambitious: false });
    expect(prompt).not.toContain("truly impressive");
  });

  it("omits AI features when disabled", () => {
    const prompt = buildPlannerSystemPrompt({ ...testPlannerConfig, injectAIFeatures: false });
    expect(prompt).not.toContain("AI-powered features");
  });

  it("includes tech preferences", () => {
    const prompt = buildPlannerSystemPrompt(testPlannerConfig);
    expect(prompt).toContain("React + Vite");
    expect(prompt).toContain("FastAPI");
    expect(prompt).toContain("SQLite");
  });

  it("includes output format instructions", () => {
    const prompt = buildPlannerSystemPrompt(testPlannerConfig);
    expect(prompt).toContain("Project Overview");
    expect(prompt).toContain("Feature List");
    expect(prompt).toContain("Visual Design Language");
    expect(prompt).toContain("Technical Architecture");
  });
});

describe("Planner", () => {
  it("constructs with config", () => {
    const planner = new Planner(testPlannerConfig, testModelConfig, async () => "key");
    expect(planner.getSystemPrompt()).toContain("product planning specialist");
  });

  it("plan() creates Agent and returns accumulated text", async () => {
    const planner = new Planner(testPlannerConfig, testModelConfig, async () => "test-key");
    const spec = await planner.plan("Build a todo app");
    expect(spec).toContain("Product Spec");
  });
});
