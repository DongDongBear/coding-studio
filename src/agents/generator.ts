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
    const args = this.buildArgs(prompt);
    return this.spawn(cwd, args, onOutput);
  }

  /**
   * Run CC with stream-json and parse events to extract assistant text.
   * Used for non-coding tasks (contract drafting) where we want streaming
   * progress AND the final text output.
   */
  async runStreaming(cwd: string, prompt: string, onOutput?: (chunk: string) => void): Promise<GeneratorResult> {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", String(this.config.maxTurns),
    ];
    if (this.config.allowedTools.length > 0) {
      args.push("--allowedTools", this.config.allowedTools.join(","));
    }

    let assistantText = "";
    let lineBuf = "";

    const result = await this.spawn(cwd, args, (raw) => {
      // Parse NDJSON stream: each line is a JSON event
      lineBuf += raw;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? ""; // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === "assistant" && event.subtype === "text") {
            // Streaming text delta from assistant
            assistantText += event.text ?? "";
            onOutput?.(event.text ?? "");
          } else if (event.type === "tool_use") {
            // Tool call started
            onOutput?.(`\n> ${event.tool ?? "tool"}: ${JSON.stringify(event.input ?? {}).slice(0, 100)}\n`);
          } else if (event.type === "result") {
            // Final result — use this as the complete text
            if (event.result) assistantText = event.result;
          }
        } catch {
          // Not valid JSON — pass raw line as output for visibility
          onOutput?.(line);
        }
      }
    });

    // Override output with parsed assistant text
    return {
      ...result,
      output: assistantText || result.output,
    };
  }

  /** Draft a contract — CC reads the repo state and proposes what it can deliver */
  async draftContract(cwd: string, spec: string, onOutput?: (chunk: string) => void): Promise<string> {
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

    const result = await this.runStreaming(cwd, prompt, onOutput);
    return result.output;
  }

  /** Revise a contract based on evaluator feedback */
  async reviseContract(cwd: string, draft: string, feedback: string, onOutput?: (chunk: string) => void): Promise<string> {
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

    const result = await this.runStreaming(cwd, prompt, onOutput);
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
