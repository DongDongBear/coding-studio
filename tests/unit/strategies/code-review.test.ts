import { describe, it, expect } from "vitest";
import { CodeReviewStrategy } from "../../../src/strategies/code-review.js";

describe("CodeReviewStrategy", () => {
  it("has correct name", () => {
    expect(new CodeReviewStrategy().name).toBe("code-review");
  });

  it("returns empty tools array", () => {
    expect(new CodeReviewStrategy().getTools()).toEqual([]);
  });

  it("returns prompt fragment about code review", () => {
    const fragment = new CodeReviewStrategy().getPromptFragment();
    expect(fragment).toContain("Code Review");
    expect(fragment).toContain("integration bugs");
  });
});
