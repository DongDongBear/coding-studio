import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { EvaluationStrategy } from "./types.js";

export interface PlaywrightConfig {
  baseUrl: string;
  viewport: { width: number; height: number };
}

export class PlaywrightStrategy implements EvaluationStrategy {
  name = "playwright";
  private config: PlaywrightConfig;

  constructor(config: PlaywrightConfig = { baseUrl: "http://127.0.0.1:5173", viewport: { width: 1280, height: 720 } }) {
    this.config = config;
  }

  getTools(): AgentTool[] {
    // Playwright MCP tools will be injected by the orchestrator when available.
    // The strategy declares intent; actual tool provision depends on MCP server availability.
    return [];
  }

  getPromptFragment(): string {
    return [
      "## Evaluation Mode: Playwright End-to-End Testing",
      "",
      `The application is running at ${this.config.baseUrl}`,
      `Viewport: ${this.config.viewport.width}x${this.config.viewport.height}`,
      "",
      "You are evaluating by actually navigating and interacting with the running application.",
      "Use Playwright MCP tools to:",
      "1. Navigate to the application URL",
      "2. Take screenshots of key pages",
      "3. Click buttons, fill forms, test interactions",
      "4. Verify that UI elements respond correctly",
      "5. Check responsive behavior and visual consistency",
      "",
      "Focus on:",
      "- Does the UI match the design language specified in the contract?",
      "- Are all interactive elements functional (not just visual)?",
      "- Are there layout issues, broken elements, or unresponsive controls?",
      "- Does the application handle error states gracefully?",
      "",
      "Take screenshots as evidence for your scoring. Reference specific visual issues.",
      "Distinguish between 'looks good in screenshot' and 'actually works when interacted with'.",
    ].join("\n");
  }
}
