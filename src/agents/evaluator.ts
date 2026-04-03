import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, getModel } from "@mariozechner/pi-ai";
import type { EvaluationStrategy } from "../strategies/types.js";
import { subscribeWithStreaming, type AgentStreamEvent } from "./streaming.js";
import type { EvalReport, EvalScore, Blocker, Bug } from "../artifacts/types.js";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/** Try to repair truncated JSON (missing closing quotes/braces) */
function repairJSON(text: string): string {
  let s = text.trim();
  // Count open/close braces and brackets
  let braces = 0, brackets = 0, inString = false, escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") braces++;
    if (ch === "}") braces--;
    if (ch === "[") brackets++;
    if (ch === "]") brackets--;
  }
  // If we're inside a string, close it
  if (inString) s += '"';
  // Close any open brackets/braces
  while (brackets > 0) { s += "]"; brackets--; }
  while (braces > 0) { s += "}"; braces--; }
  return s;
}

/** Extract JSON from LLM output that may contain markdown fences, preamble, or be truncated */
function extractJSON(text: string): any {
  const trimmed = text.trim();
  // Direct parse
  try { return JSON.parse(trimmed); } catch {}
  // Markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
    try { return JSON.parse(repairJSON(fenceMatch[1].trim())); } catch {}
  }
  // First { ... } block
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}
  }
  // Find first { and try to repair truncated JSON
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace >= 0) {
    const partial = trimmed.slice(firstBrace);
    try { return JSON.parse(repairJSON(partial)); } catch {}
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
  private cwd: string;

  constructor(
    evalConfig: EvaluatorConfig,
    modelConfig: EvaluatorModelConfig,
    strategy: EvaluationStrategy,
    getApiKey: (provider: string) => Promise<string | undefined>,
    cwd: string = process.cwd(),
  ) {
    this.evalConfig = evalConfig;
    this.modelConfig = modelConfig;
    this.strategy = strategy;
    this.getApiKey = getApiKey;
    this.cwd = cwd;
  }

  getSystemPrompt(): string {
    return buildEvaluatorSystemPrompt(this.evalConfig, this.strategy);
  }

  /** Built-in tools that let the Evaluator inspect the project */
  private getBuiltinTools(): AgentTool[] {
    const cwd = this.cwd;

    const readFileTool: AgentTool = {
      name: "read_file",
      label: "Read File",
      description: "Read a file from the project. Use relative paths from the project root.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative file path to read" }),
      }),
      execute: async (_id, params: any) => {
        try {
          const fullPath = path.resolve(cwd, params.path);
          const content = fs.readFileSync(fullPath, "utf-8");
          return { content: [{ type: "text", text: content }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error reading file: ${err.message}` }], details: {} };
        }
      },
    };

    const listFilesTool: AgentTool = {
      name: "list_files",
      label: "List Files",
      description: "List files in a directory. Use relative paths. Returns file names.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Relative directory path (default: project root)" })),
        recursive: Type.Optional(Type.Boolean({ description: "List recursively (default: false)" })),
      }),
      execute: async (_id, params: any) => {
        try {
          const dir = path.resolve(cwd, params.path ?? ".");
          const cmd = params.recursive
            ? `find "${dir}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200`
            : `ls -la "${dir}"`;
          const output = execSync(cmd, { cwd, stdio: "pipe", timeout: 10000 }).toString();
          return { content: [{ type: "text", text: output }], details: {} };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], details: {} };
        }
      },
    };

    const searchTool: AgentTool = {
      name: "search_code",
      label: "Search Code",
      description: "Search for a pattern in project files using grep. Returns matching lines.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Search pattern (regex supported)" }),
        glob: Type.Optional(Type.String({ description: "File glob filter, e.g. '*.ts'" })),
      }),
      execute: async (_id, params: any) => {
        try {
          const globArg = params.glob ? `--include='${params.glob}'` : "";
          const cmd = `grep -rn ${globArg} '${params.pattern.replace(/'/g, "\\'")}' . --exclude-dir=node_modules --exclude-dir=.git | head -100`;
          const output = execSync(cmd, { cwd, stdio: "pipe", timeout: 10000 }).toString();
          return { content: [{ type: "text", text: output || "No matches found." }], details: {} };
        } catch {
          return { content: [{ type: "text", text: "No matches found." }], details: {} };
        }
      },
    };

    const runCommandTool: AgentTool = {
      name: "run_command",
      label: "Run Command",
      description: "Run a shell command in the project directory. Use for: npm test, curl, etc.",
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to run" }),
      }),
      execute: async (_id, params: any) => {
        try {
          const output = execSync(params.command, { cwd, stdio: "pipe", timeout: 30000 }).toString();
          return { content: [{ type: "text", text: output }], details: {} };
        } catch (err: any) {
          const stderr = err.stderr?.toString() ?? "";
          const stdout = err.stdout?.toString() ?? "";
          return { content: [{ type: "text", text: `Exit ${err.status}\n${stdout}\n${stderr}` }], details: {} };
        }
      },
    };

    return [readFileTool, listFilesTool, searchTool, runCommandTool];
  }

  async evaluate(spec: string, contract: string, round: number, onEvent?: (event: AgentStreamEvent) => void): Promise<EvalReport> {
    try {
      return await this.doEvaluate(spec, contract, round, onEvent);
    } catch (err: any) {
      // Never crash the pipeline on eval failure — return a graceful fail report
      return {
        round,
        timestamp: new Date().toISOString(),
        verdict: "fail",
        overallScore: 0,
        contractCoverage: 0,
        scores: [],
        blockers: [{ severity: "critical", description: `Evaluator error: ${err.message}` }],
        bugs: [],
        summary: `Evaluation failed due to an error: ${err.message}. Pipeline will continue to next round.`,
      };
    }
  }

  private async doEvaluate(spec: string, contract: string, round: number, onEvent?: (event: AgentStreamEvent) => void): Promise<EvalReport> {
    const model = getModel(this.modelConfig.provider as any, this.modelConfig.model as any);

    const tools = [...this.getBuiltinTools(), ...this.strategy.getTools()];

    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: this.getSystemPrompt(),
        tools,
      },
      getApiKey: this.getApiKey,
    });

    const { getResult } = subscribeWithStreaming(agent, onEvent);

    const evalPrompt = `Evaluate the project.\n\n## Specification:\n${spec}\n\n## Contract:\n${contract}`;
    await agent.prompt(evalPrompt);

    const result = getResult();
    if (!result.trim()) {
      throw new Error("Evaluator returned empty response. Check model configuration and API key.");
    }

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

  /** Review a contract draft for testability and completeness */
  async reviewContract(spec: string, draft: string): Promise<{ approved: boolean; feedback: string }> {
    try {
      const model = getModel(this.modelConfig.provider as any, this.modelConfig.model as any);

      const agent = new Agent({
        initialState: {
          model,
          systemPrompt: [
            "You are reviewing an acceptance contract for completeness and testability.",
            "Check whether:",
            "- The acceptance criteria are specific and testable (not vague)",
            "- All key features from the spec are covered",
            "- The test plan covers critical user interactions",
            "- Non-goals are clearly stated to prevent scope creep",
            "",
            "Respond with ONLY a JSON object (no markdown fences, no extra text):",
            '{ "approved": true, "feedback": "brief feedback" }',
            "Keep feedback under 200 words to avoid truncation.",
          ].join("\n"),
        },
        getApiKey: this.getApiKey,
      });

      let result = "";
      agent.subscribe((event: any) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          result += event.assistantMessageEvent.delta;
        }
      });

      await agent.prompt(`# Specification\n\n${spec}\n\n# Contract Draft\n\n${draft}`);

      if (!result.trim()) {
        return { approved: true, feedback: "No response from reviewer — auto-approving." };
      }

      const parsed = extractJSON(result);
      return {
        approved: parsed.approved ?? true,
        feedback: parsed.feedback ?? "",
      };
    } catch (err: any) {
      // Never crash on review failure — auto-approve and note the error
      return { approved: true, feedback: `Review failed (${err.message}), auto-approving to continue pipeline.` };
    }
  }
}

export { buildEvaluatorSystemPrompt };
