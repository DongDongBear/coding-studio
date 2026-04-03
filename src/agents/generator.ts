import { spawn, type ChildProcess } from "node:child_process";
import type { EvalReport } from "../artifacts/types.js";

export interface GeneratorConfig {
  cliCommand: string;
  allowedTools: string[];
  mcpServers: string[];
  maxTurns: number;
  selfReview: boolean;
}

export interface GeneratorResult {
  exitCode: number | null;
  output: string;
  duration: number; // ms
}

export class Generator {
  private config: GeneratorConfig;

  constructor(config: GeneratorConfig) {
    this.config = config;
  }

  /** Build the prompt that gets passed to claude -p */
  buildPrompt(
    spec: string,
    contract?: string,
    evalFeedback?: EvalReport,
  ): string {
    const parts: string[] = [];

    parts.push("# Product Specification\n\n" + spec);

    if (contract) {
      parts.push("\n\n# Acceptance Contract\n\n" + contract);
    }

    if (evalFeedback) {
      parts.push("\n\n# Evaluator Feedback (Previous Round)\n");
      parts.push(`Round: ${evalFeedback.round}`);
      parts.push(`Verdict: ${evalFeedback.verdict}`);
      parts.push(`Score: ${evalFeedback.overallScore}/10`);

      if (evalFeedback.blockers.length > 0) {
        parts.push("\n## Critical Blockers:");
        for (const b of evalFeedback.blockers) {
          parts.push(`- [${b.severity}] ${b.description}`);
        }
      }

      if (evalFeedback.bugs.length > 0) {
        parts.push("\n## Bugs to Fix:");
        for (const bug of evalFeedback.bugs) {
          const loc = bug.location ? ` (${bug.location})` : "";
          parts.push(`- [${bug.severity}]${loc} ${bug.description}`);
          if (bug.suggestedFix) {
            parts.push(`  Suggested fix: ${bug.suggestedFix}`);
          }
        }
      }

      parts.push("\n## Score Breakdown:");
      for (const s of evalFeedback.scores) {
        parts.push(`- ${s.name}: ${s.score}/10 (weight ${s.weight}) — ${s.feedback}`);
      }

      parts.push("\n" + evalFeedback.summary);
      parts.push("\nPlease address ALL the feedback above. Fix blockers and bugs first, then improve scores.");
    }

    if (this.config.selfReview) {
      parts.push("\n\n# Self-Review Requirement\n\nBefore finishing, review your own work. Check that all acceptance criteria are met, test core functionality, and verify there are no obvious bugs.");
    }

    return parts.join("\n");
  }

  /** Build the CLI args array for claude */
  buildArgs(prompt: string): string[] {
    const args: string[] = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--max-turns", String(this.config.maxTurns),
    ];

    if (this.config.allowedTools.length > 0) {
      args.push("--allowedTools", this.config.allowedTools.join(","));
    }

    for (const mcp of this.config.mcpServers) {
      args.push("--mcp", mcp);
    }

    return args;
  }

  /** Run Claude Code as a subprocess (stream-json output for coding tasks) */
  async run(
    cwd: string,
    spec: string,
    contract?: string,
    evalFeedback?: EvalReport,
    onOutput?: (chunk: string) => void,
  ): Promise<GeneratorResult> {
    const prompt = this.buildPrompt(spec, contract, evalFeedback);
    const args = this.buildArgs(prompt);
    return this.spawn(cwd, args, onOutput);
  }

  /** Run CC with plain text output (for non-coding tasks like contract drafting) */
  async runText(cwd: string, prompt: string): Promise<GeneratorResult> {
    const args = [
      "-p", prompt,
      "--output-format", "text",
      "--max-turns", String(this.config.maxTurns),
    ];
    // Contract drafting needs CC to read the codebase
    if (this.config.allowedTools.length > 0) {
      args.push("--allowedTools", this.config.allowedTools.join(","));
    }
    return this.spawn(cwd, args);
  }

  /** Draft a contract — CC reads the repo state and proposes what it can deliver */
  async draftContract(cwd: string, spec: string): Promise<string> {
    const prompt = [
      "You are about to build a project. Based on the specification below and the current state of the repository,",
      "draft an acceptance contract that describes what you will deliver.",
      "",
      "The contract should contain:",
      "- **Scope**: what this build delivers",
      "- **Non-goals**: what is explicitly out of scope for this round",
      "- **Acceptance Criteria**: specific, testable conditions (each verifiable by interaction or inspection)",
      "- **Test Plan**: key user interactions, API calls, and states the evaluator must check",
      "",
      "Be realistic about what you can build. Each acceptance criterion should describe observable behavior.",
      "Output ONLY the contract in markdown.",
      "",
      "# Specification",
      "",
      spec,
    ].join("\n");

    const result = await this.runText(cwd, prompt);
    return result.output;
  }

  /** Revise a contract based on evaluator feedback */
  async reviseContract(cwd: string, draft: string, feedback: string): Promise<string> {
    const prompt = [
      "Revise the following acceptance contract based on the reviewer's feedback.",
      "You may read the repository to check what's feasible.",
      "Output ONLY the revised contract in markdown.",
      "",
      "# Current Contract",
      "",
      draft,
      "",
      "# Reviewer Feedback",
      "",
      feedback,
    ].join("\n");

    const result = await this.runText(cwd, prompt);
    return result.output;
  }

  private spawn(cwd: string, args: string[], onOutput?: (chunk: string) => void): Promise<GeneratorResult> {
    const startTime = Date.now();
    let output = "";

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.cliCommand, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        onOutput?.(text);
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        onOutput?.(text);
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn ${this.config.cliCommand}: ${err.message}`));
      });

      proc.on("exit", (code) => {
        resolve({
          exitCode: code,
          output,
          duration: Date.now() - startTime,
        });
      });
    });
  }
}
