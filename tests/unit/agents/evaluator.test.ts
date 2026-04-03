import { describe, it, expect, vi } from "vitest";
import { Evaluator, evaluatePassFail, buildEvaluatorSystemPrompt } from "../../../src/agents/evaluator.js";
import { CodeReviewStrategy } from "../../../src/strategies/code-review.js";
import type { EvaluatorConfig } from "../../../src/agents/evaluator.js";
import type { EvalScore, Blocker } from "../../../src/artifacts/types.js";

// Mock pi deps
vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: vi.fn().mockImplementation(() => {
    let listener: Function;
    return {
      subscribe: vi.fn((fn: Function) => { listener = fn; }),
      prompt: vi.fn(async () => {
        listener({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: JSON.stringify({
              verdict: "fail",
              overallScore: 6.0,
              contractCoverage: 0.7,
              scores: [
                { name: "functionality", score: 5, weight: 1.0, feedback: "Core broken" },
                { name: "code_quality", score: 7, weight: 1.0, feedback: "OK" },
              ],
              blockers: [],
              bugs: [{ severity: "major", description: "button broken", location: "App.tsx:10" }],
              summary: "Needs work",
            }),
          },
        });
      }),
      state: {},
    };
  }),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "test-model", provider: "test" })),
}));

const testEvalConfig: EvaluatorConfig = {
  criteria: [
    { name: "functionality", weight: 1.0, description: "Works correctly" },
    { name: "code_quality", weight: 1.0, description: "Clean code" },
  ],
  passRules: {
    overallScore: 7.0,
    minCriterionScore: 6.0,
    blockersFail: true,
    requiredCriteria: ["functionality"],
  },
};

describe("evaluatePassFail", () => {
  const rules = testEvalConfig.passRules;

  it("passes when all gates met", () => {
    const scores: EvalScore[] = [
      { name: "functionality", score: 8, weight: 1, feedback: "" },
      { name: "code_quality", score: 7, weight: 1, feedback: "" },
    ];
    const result = evaluatePassFail(scores, [], rules);
    expect(result.verdict).toBe("pass");
    expect(result.overallScore).toBe(7.5);
  });

  it("fails on critical blocker", () => {
    const scores: EvalScore[] = [
      { name: "functionality", score: 9, weight: 1, feedback: "" },
    ];
    const blockers: Blocker[] = [{ severity: "critical", description: "crash" }];
    const result = evaluatePassFail(scores, blockers, rules);
    expect(result.verdict).toBe("fail");
  });

  it("fails when required criterion below threshold", () => {
    const scores: EvalScore[] = [
      { name: "functionality", score: 5, weight: 1, feedback: "" },
      { name: "code_quality", score: 9, weight: 1, feedback: "" },
    ];
    const result = evaluatePassFail(scores, [], rules);
    expect(result.verdict).toBe("fail");
  });

  it("fails when overall score below threshold", () => {
    const scores: EvalScore[] = [
      { name: "functionality", score: 6, weight: 1, feedback: "" },
      { name: "code_quality", score: 6, weight: 1, feedback: "" },
    ];
    const result = evaluatePassFail(scores, [], rules);
    expect(result.verdict).toBe("fail");
    expect(result.overallScore).toBe(6);
  });
});

describe("buildEvaluatorSystemPrompt", () => {
  it("includes strategy prompt fragment", () => {
    const prompt = buildEvaluatorSystemPrompt(testEvalConfig, new CodeReviewStrategy());
    expect(prompt).toContain("Code Review");
  });

  it("includes scoring criteria", () => {
    const prompt = buildEvaluatorSystemPrompt(testEvalConfig, new CodeReviewStrategy());
    expect(prompt).toContain("functionality");
    expect(prompt).toContain("code_quality");
  });

  it("includes pass rules", () => {
    const prompt = buildEvaluatorSystemPrompt(testEvalConfig, new CodeReviewStrategy());
    expect(prompt).toContain("7");
    expect(prompt).toContain("critical blocker");
  });
});

describe("Evaluator", () => {
  it("evaluate() returns structured EvalReport", async () => {
    const evaluator = new Evaluator(
      testEvalConfig,
      { provider: "test", model: "test-model" },
      new CodeReviewStrategy(),
      async () => "test-key",
    );
    const report = await evaluator.evaluate("spec text", "contract text", 1);
    expect(report.round).toBe(1);
    expect(report.verdict).toBe("fail"); // functionality=5 < minCriterionScore=6
    expect(report.scores).toHaveLength(2);
    expect(report.bugs).toHaveLength(1);
  });
});
