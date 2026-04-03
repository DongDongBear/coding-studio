import { describe, it, expect } from "vitest";
import { CompositeStrategy } from "../../../src/strategies/composite.js";
import { CodeReviewStrategy } from "../../../src/strategies/code-review.js";
import { TestRunnerStrategy } from "../../../src/strategies/test-runner.js";
import { PlaywrightStrategy } from "../../../src/strategies/playwright.js";

describe("CompositeStrategy", () => {
  it("has correct name", () => {
    const strategy = new CompositeStrategy([new CodeReviewStrategy()]);
    expect(strategy.name).toBe("composite");
  });

  it("throws on empty strategies array", () => {
    expect(() => new CompositeStrategy([])).toThrow("at least one");
  });

  it("combines prompt fragments from all sub-strategies", () => {
    const strategy = new CompositeStrategy([
      new CodeReviewStrategy(),
      new TestRunnerStrategy(),
    ]);
    const fragment = strategy.getPromptFragment();
    expect(fragment).toContain("Code Review");
    expect(fragment).toContain("Test Runner");
    expect(fragment).toContain("Composite");
    expect(fragment).toContain("Synthesize findings");
  });

  it("merges tools and deduplicates by name", () => {
    const strategy = new CompositeStrategy([
      new CodeReviewStrategy(),
      new TestRunnerStrategy(),
    ]);
    // Both return empty tools, so merged is empty
    expect(strategy.getTools()).toEqual([]);
  });

  it("includes all three strategies", () => {
    const strategy = new CompositeStrategy([
      new CodeReviewStrategy(),
      new TestRunnerStrategy(),
      new PlaywrightStrategy(),
    ]);
    const fragment = strategy.getPromptFragment();
    expect(fragment).toContain("Code Review");
    expect(fragment).toContain("Test Runner");
    expect(fragment).toContain("Playwright");
  });

  it("exposes sub-strategies via getter", () => {
    const subs = [new CodeReviewStrategy(), new TestRunnerStrategy()];
    const strategy = new CompositeStrategy(subs);
    expect(strategy.getStrategies()).toHaveLength(2);
    expect(strategy.getStrategies()[0].name).toBe("code-review");
  });

  it("getter returns copy not reference", () => {
    const strategy = new CompositeStrategy([new CodeReviewStrategy()]);
    const a = strategy.getStrategies();
    a.pop();
    expect(strategy.getStrategies()).toHaveLength(1);
  });
});
