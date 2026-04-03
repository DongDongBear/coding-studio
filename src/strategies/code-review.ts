import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { EvaluationStrategy } from "./types.js";

export class CodeReviewStrategy implements EvaluationStrategy {
  name = "code-review";

  getTools(): AgentTool[] {
    // Code review uses file reading tools — in real usage these come from the agent's tool registry.
    // We return empty here; the Evaluator will always have readFile/glob/grep.
    return [];
  }

  getPromptFragment(): string {
    return [
      "## Evaluation Mode: Code Review",
      "",
      "You are evaluating by reading and analyzing the code directly.",
      "Focus on:",
      "- Does the code implement what the contract specifies?",
      "- Are there integration bugs (functions that exist but aren't wired correctly)?",
      "- Is the code structure clean and maintainable?",
      "- Are there obvious performance issues or security concerns?",
      "",
      "Read the key source files, trace the data flow, and verify the implementation matches the contract.",
    ].join("\n");
  }
}
