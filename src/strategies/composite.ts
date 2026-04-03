import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { EvaluationStrategy } from "./types.js";

export class CompositeStrategy implements EvaluationStrategy {
  name = "composite";
  private strategies: EvaluationStrategy[];

  constructor(strategies: EvaluationStrategy[]) {
    if (strategies.length === 0) {
      throw new Error("CompositeStrategy requires at least one sub-strategy");
    }
    this.strategies = strategies;
  }

  getTools(): AgentTool[] {
    const toolMap = new Map<string, AgentTool>();
    for (const strategy of this.strategies) {
      for (const tool of strategy.getTools()) {
        toolMap.set(tool.name, tool); // deduplicate by name
      }
    }
    return [...toolMap.values()];
  }

  getPromptFragment(): string {
    const parts = [
      "## Evaluation Mode: Composite (Multi-Strategy)",
      "",
      "You are performing a comprehensive evaluation using multiple strategies.",
      "Apply ALL of the following evaluation approaches:",
      "",
    ];

    for (const strategy of this.strategies) {
      parts.push(strategy.getPromptFragment());
      parts.push(""); // separator
    }

    parts.push("Synthesize findings from all approaches into a single coherent assessment.");
    parts.push("Prioritize findings by severity — a critical bug from any approach is a blocker.");

    return parts.join("\n");
  }

  getStrategies(): EvaluationStrategy[] {
    return [...this.strategies];
  }
}
