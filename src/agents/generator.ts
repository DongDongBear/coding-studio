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

    parts.push("\n\n# Test Output Rules");
    parts.push("- All test result files (screenshots, reports, logs) MUST go into `.coding-studio/test-results/` directory.");
    parts.push("- Do NOT create `test-results/` or `test-result/` in the project root.");
    parts.push("- After tests pass, clean up any temporary test artifacts (screenshots, trace files) from `.coding-studio/test-results/`.");
    parts.push("- Test source code (test/*.test.js etc.) stays in the project, but test OUTPUT goes in .coding-studio/.");

    return parts.join("\n");
  }

  /** Build the CLI args array for claude (prompt passed via stdin, not -p) */
  buildArgs(): string[] {
    const args: string[] = [
      "-p", "-",  // read prompt from stdin
      "--output-format", "stream-json",
      "--verbose",
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
    const args = this.buildArgs();
    return this.spawn(cwd, args, onOutput, prompt);
  }

  // Contract drafting removed from Generator — now handled by ContractDrafterAgent (pi-agent-core)

  private spawn(cwd: string, args: string[], onOutput?: (chunk: string) => void, stdinData?: string): Promise<GeneratorResult> {
    const startTime = Date.now();
    let output = "";

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.cliCommand, args, {
        cwd,
        stdio: [stdinData ? "pipe" : "ignore", "pipe", "pipe"],
      });

      // Pipe prompt via stdin to avoid OS arg length limits
      if (stdinData && proc.stdin) {
        proc.stdin.write(stdinData);
        proc.stdin.end();
      }

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
