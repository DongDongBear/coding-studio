import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import type { EvaluationStrategy } from "../strategies/types.js";
import type { EvalReport, EvalScore, Blocker, Bug } from "../artifacts/types.js";

/** Extract JSON from LLM output that may contain markdown fences or preamble */
function extractJSON(text: string): any {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}
  }
  throw new Error(`Failed to parse evaluator response as JSON: ${trimmed.slice(0, 200)}`);
}

export interface EvaluatorModelConfig {
  provider: string;
  model: string;
}

export interface EvaluationCriterion {
  name: string;
  weight: number;
  description: string;
}

export interface PassRules {
  overallScore: number;
  minCriterionScore: number;
  blockersFail: boolean;
  requiredCriteria: string[];
}

export interface EvaluatorConfig {
  criteria: EvaluationCriterion[];
  passRules: PassRules;
}

function buildEvaluatorSystemPrompt(config: EvaluatorConfig, strategy: EvaluationStrategy): string {
  const parts: string[] = [];

  parts.push("You are a strict QA engineer performing an independent evaluation of code output.");
  parts.push("Do NOT be lenient toward LLM-generated content. Evaluate as if reviewing a human developer's work.");
  parts.push("");

  parts.push(strategy.getPromptFragment());
  parts.push("");

  parts.push("## Scoring Criteria");
  parts.push("Score each dimension 0-10:");
  for (const c of config.criteria) {
    parts.push(`- **${c.name}** (weight ${c.weight}): ${c.description}`);
  }

  parts.push("");
  parts.push("## Pass Rules");
  parts.push(`- Overall weighted score must be >= ${config.passRules.overallScore}`);
  parts.push(`- Required criteria (${config.passRules.requiredCriteria.join(", ")}): each must score >= ${config.passRules.minCriterionScore}`);
  if (config.passRules.blockersFail) {
    parts.push("- Any critical blocker = automatic FAIL");
  }

  parts.push("");
  parts.push("## Output Format");
  parts.push("Respond with a JSON object matching this schema (and NOTHING else — no markdown fences, no explanation):");
  parts.push(JSON.stringify({
    verdict: "pass | fail",
    overallScore: 0,
    contractCoverage: 0,
    scores: [{ name: "criterion_name", score: 0, weight: 0, feedback: "explanation" }],
    blockers: [{ severity: "critical | major", description: "what is broken", evidence: "how you found it" }],
    bugs: [{ severity: "critical | major | minor", description: "bug description", location: "file:line", suggestedFix: "how to fix" }],
    summary: "Overall assessment for the Generator",
  }, null, 2));

  return parts.join("\n");
}

/** Calculate weighted score and apply pass rules */
export function evaluatePassFail(scores: EvalScore[], blockers: Blocker[], passRules: PassRules): { verdict: "pass" | "fail"; overallScore: number } {
  // Blocker gate
  if (passRules.blockersFail && blockers.some(b => b.severity === "critical")) {
    const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
    const weightedSum = scores.reduce((sum, s) => sum + s.score * s.weight, 0);
    return { verdict: "fail", overallScore: totalWeight > 0 ? weightedSum / totalWeight : 0 };
  }

  // Criterion gate
  for (const req of passRules.requiredCriteria) {
    const score = scores.find(s => s.name === req);
    if (score && score.score < passRules.minCriterionScore) {
      const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
      const weightedSum = scores.reduce((sum, s) => sum + s.score * s.weight, 0);
      return { verdict: "fail", overallScore: totalWeight > 0 ? weightedSum / totalWeight : 0 };
    }
  }

  // Aggregate gate
  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  const weightedSum = scores.reduce((sum, s) => sum + s.score * s.weight, 0);
  const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const verdict = overallScore >= passRules.overallScore ? "pass" : "fail";
  return { verdict, overallScore };
}

export class Evaluator {
  private evalConfig: EvaluatorConfig;
  private modelConfig: EvaluatorModelConfig;
  private strategy: EvaluationStrategy;
  private getApiKey: (provider: string) => Promise<string | undefined>;

  constructor(
    evalConfig: EvaluatorConfig,
    modelConfig: EvaluatorModelConfig,
    strategy: EvaluationStrategy,
    getApiKey: (provider: string) => Promise<string | undefined>,
  ) {
    this.evalConfig = evalConfig;
    this.modelConfig = modelConfig;
    this.strategy = strategy;
    this.getApiKey = getApiKey;
  }

  getSystemPrompt(): string {
    return buildEvaluatorSystemPrompt(this.evalConfig, this.strategy);
  }

  async evaluate(spec: string, contract: string, round: number): Promise<EvalReport> {
    const model = getModel(this.modelConfig.provider as any, this.modelConfig.model as any);

    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: this.getSystemPrompt(),
        tools: this.strategy.getTools(),
      },
      getApiKey: this.getApiKey,
    });

    let result = "";
    agent.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        result += event.assistantMessageEvent.delta;
      }
    });

    const evalPrompt = `Evaluate the project.\n\n## Specification:\n${spec}\n\n## Contract:\n${contract}`;
    await agent.prompt(evalPrompt);

    // Parse the LLM's JSON response with fallback extraction
    const parsed = extractJSON(result);

    // Apply our own pass/fail logic (don't trust the LLM's verdict blindly)
    const { verdict, overallScore } = evaluatePassFail(
      parsed.scores ?? [],
      parsed.blockers ?? [],
      this.evalConfig.passRules,
    );

    return {
      round,
      timestamp: new Date().toISOString(),
      verdict,
      overallScore,
      contractCoverage: parsed.contractCoverage ?? 0,
      scores: parsed.scores ?? [],
      blockers: parsed.blockers ?? [],
      bugs: parsed.bugs ?? [],
      summary: parsed.summary ?? "",
    };
  }
}

export { buildEvaluatorSystemPrompt };
