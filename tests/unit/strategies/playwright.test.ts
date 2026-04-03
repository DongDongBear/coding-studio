import { describe, it, expect } from "vitest";
import { PlaywrightStrategy } from "../../../src/strategies/playwright.js";

describe("PlaywrightStrategy", () => {
  it("has correct name", () => {
    expect(new PlaywrightStrategy().name).toBe("playwright");
  });

  it("returns empty tools array (MCP tools injected externally)", () => {
    expect(new PlaywrightStrategy().getTools()).toEqual([]);
  });

  it("includes default base URL in prompt", () => {
    const fragment = new PlaywrightStrategy().getPromptFragment();
    expect(fragment).toContain("http://127.0.0.1:5173");
    expect(fragment).toContain("1280x720");
  });

  it("uses custom config in prompt", () => {
    const strategy = new PlaywrightStrategy({
      baseUrl: "http://localhost:3000",
      viewport: { width: 1920, height: 1080 },
    });
    const fragment = strategy.getPromptFragment();
    expect(fragment).toContain("http://localhost:3000");
    expect(fragment).toContain("1920x1080");
  });

  it("includes interaction guidance", () => {
    const fragment = new PlaywrightStrategy().getPromptFragment();
    expect(fragment).toContain("Playwright");
    expect(fragment).toContain("screenshots");
    expect(fragment).toContain("interactive elements");
  });
});
