import type { AgentTool } from "@mariozechner/pi-agent-core";

export interface EvaluationStrategy {
  name: string;
  /** Returns tools this strategy needs injected into the Evaluator agent */
  getTools(): AgentTool[];
  /** Returns additional system prompt fragment for the Evaluator */
  getPromptFragment(): string;
}
