import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { EvaluationStrategy } from "./types.js";

export class TestRunnerStrategy implements EvaluationStrategy {
  name = "test-runner";

  getTools(): AgentTool[] {
    return [];
  }

  getPromptFragment(): string {
    return [
      "## Evaluation Mode: Test Runner",
      "",
      "You are evaluating by running the project's test suite.",
      "Steps:",
      "1. Run `npm test` or the project's configured test command",
      "2. Analyze test results — which tests pass, which fail",
      "3. For failing tests, read the test code and implementation to understand the root cause",
      "4. Check test coverage — are critical paths tested?",
      "",
      "A passing test suite with good coverage is a strong positive signal.",
      "Failing tests on core functionality are blockers.",
    ].join("\n");
  }
}
