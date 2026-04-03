import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

export interface PlannerConfig {
  ambitious: boolean;
  injectAIFeatures: boolean;
  techPreferences: {
    frontend: string;
    backend: string;
    database: string;
  };
}

export interface PlannerModelConfig {
  provider: string;
  model: string;
}

export function buildPlannerSystemPrompt(config: PlannerConfig): string {
  const parts: string[] = [];

  parts.push("You are a product planning specialist. Your job is to take a brief user prompt and expand it into a comprehensive product specification.");

  if (config.ambitious) {
    parts.push("\nBe ambitious. Don't just implement the minimum — think about what would make this product truly impressive. Add features that complement the core request.");
  }

  if (config.injectAIFeatures) {
    parts.push("\nActively look for opportunities to weave in AI-powered features. For each major feature area, consider: could an AI assistant, generator, or intelligent automation make this better?");
  }

  parts.push("\n## Tech Preferences (treat as defaults, not constraints):");
  parts.push(`- Frontend: ${config.techPreferences.frontend}`);
  parts.push(`- Backend: ${config.techPreferences.backend}`);
  parts.push(`- Database: ${config.techPreferences.database}`);

  parts.push("\n## Output Format");
  parts.push("Produce a markdown document with:");
  parts.push("1. **Project Overview** — what are we building and for whom");
  parts.push("2. **Feature List** — prioritized, with user stories or feature slices");
  parts.push("3. **Visual Design Language** — colors, typography, layout principles, mood");
  parts.push("4. **Technical Architecture** — high-level only (frameworks, data flow). Do NOT specify implementation details.");
  parts.push("5. **AI Features** — if enabled, list AI-powered enhancements");
  parts.push("\nFocus on WHAT to build, not HOW to implement it. The Generator will handle implementation details.");

  return parts.join("\n");
}

export class Planner {
  private config: PlannerConfig;
  private modelConfig: PlannerModelConfig;
  private getApiKey: (provider: string) => Promise<string | undefined>;

  constructor(
    config: PlannerConfig,
    modelConfig: PlannerModelConfig,
    getApiKey: (provider: string) => Promise<string | undefined>,
  ) {
    this.config = config;
    this.modelConfig = modelConfig;
    this.getApiKey = getApiKey;
  }

  /** Get the system prompt (exposed for testing/debugging) */
  getSystemPrompt(): string {
    return buildPlannerSystemPrompt(this.config);
  }

  /** Run the planner to generate a spec from a user prompt */
  async plan(userPrompt: string): Promise<string> {
    const model = getModel(this.modelConfig.provider as any, this.modelConfig.model as any);

    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: this.getSystemPrompt(),
      },
      getApiKey: this.getApiKey,
    });

    let result = "";
    agent.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        result += event.assistantMessageEvent.delta;
      }
    });

    await agent.prompt(userPrompt);

    return result;
  }
}
