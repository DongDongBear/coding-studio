import { describe, it, expect } from "vitest";
import { TestRunnerStrategy } from "../../../src/strategies/test-runner.js";

describe("TestRunnerStrategy", () => {
  it("has correct name", () => {
    expect(new TestRunnerStrategy().name).toBe("test-runner");
  });

  it("returns empty tools array", () => {
    expect(new TestRunnerStrategy().getTools()).toEqual([]);
  });

  it("returns prompt fragment about test running", () => {
    const fragment = new TestRunnerStrategy().getPromptFragment();
    expect(fragment).toContain("Test Runner");
    expect(fragment).toContain("npm test");
    expect(fragment).toContain("test coverage");
  });
});
