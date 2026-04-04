import { getStepsForMode, type PipelineMode } from "./pipeline/modes.js";
import type { ArtifactStore } from "./artifacts/store.js";
import type { EvalReport, PipelineStatus } from "./artifacts/types.js";
import type { AgentStreamEvent } from "./agents/streaming.js";

export interface ContractReviewer {
  reviewContract(spec: string, draft: string): Promise<{ approved: boolean; feedback: string }>;
}

export interface OrchestratorDeps {
  planner: { plan(prompt: string, onEvent?: (e: AgentStreamEvent) => void): Promise<string> };
  generator: { run(cwd: string, spec: string, contract?: string, evalFeedback?: EvalReport, onOutput?: (chunk: string) => void): Promise<{ exitCode: number | null; output: string; duration: number }> };
  evaluator: { evaluate(spec: string, contract: string, round: number, onEvent?: (e: AgentStreamEvent) => void): Promise<EvalReport> } & Partial<ContractReviewer>;
  contractDrafter?: { draftContract(spec: string, onEvent?: (e: AgentStreamEvent) => void): Promise<string>; reviseContract(draft: string, feedback: string, onEvent?: (e: AgentStreamEvent) => void): Promise<string> };
  contractManager: {
    isEnabled(): boolean;
    saveDraft(content: string): void;
    saveReview(review: { approved: boolean; feedback: string }): void;
    finalize(): void;
    readContract(): string | undefined;
    canRevise(): boolean;
    recordRevision(): void;
    reset(): void;
  };
  runtimeManager: {
    prepare(cwd: string): void;
    start(cwd: string): Promise<any>;
    stop(): void;
    healthcheck(): Promise<{ ok: boolean; detail?: string }>;
  };
  checkpointManager: {
    create(cwd: string, round: number, description: string): any;
    getLatest(): any | undefined;
    restore(cwd: string, checkpointId: string): void;
  };
  artifactStore: ArtifactStore;
}

export interface OrchestratorConfig {
  mode: PipelineMode;
  maxRounds: number;
  interactive: boolean;
  cwd: string;
  /** Called when pipeline wants to pause for user review. Return false to abort. */
  onPause?: (reason: string) => Promise<boolean>;
}

export type OrchestratorEvent =
  | { type: "phase"; phase: PipelineStatus["phase"] }
  | { type: "round"; round: number }
  | { type: "log"; message: string }
  | { type: "agent_text"; agent: "planner" | "generator" | "evaluator"; delta: string }
  | { type: "tool_use"; agent: "planner" | "generator" | "evaluator"; tool: string; status: "start" | "end"; args?: string; result?: string }
  | { type: "eval"; report: EvalReport }
  | { type: "pause"; reason: string }
  | { type: "complete"; status: PipelineStatus };

export class Orchestrator {
  private deps: OrchestratorDeps;
  private config: OrchestratorConfig;
  private listeners: Array<(event: OrchestratorEvent) => void> = [];
  private ccLineBuf = "";

  constructor(deps: OrchestratorDeps, config: OrchestratorConfig) {
    this.deps = deps;
    this.config = config;
  }

  onEvent(listener: (event: OrchestratorEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: OrchestratorEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async run(userPrompt: string): Promise<PipelineStatus> {
    const steps = getStepsForMode(this.config.mode);

    // --- Resume detection ---
    const savedStatus = this.deps.artifactStore.readStatus();
    const savedSpec = this.deps.artifactStore.readSpec();
    const savedContract = this.deps.artifactStore.readContract();
    const completedRounds = this.deps.artifactStore.listEvalReports().length;

    const canResume = savedSpec && savedStatus && savedStatus.phase !== "completed"
      && savedStatus.phase !== "failed" && completedRounds > 0;

    let spec = "";
    let contract = "";
    let startRound = 1;

    if (canResume) {
      spec = savedSpec;
      contract = savedContract ?? "";
      startRound = completedRounds + 1;
      this.emit({ type: "log", message: `Resuming from round ${startRound} (${completedRounds} completed rounds found)` });
    }

    const status: PipelineStatus = {
      phase: "planning",
      mode: this.config.mode,
      currentRound: canResume ? completedRounds : 0,
      maxRounds: this.config.maxRounds,
      history: canResume && savedStatus ? savedStatus.history : [],
    };

    // --- Plan (skip if resuming) ---
    if (steps.plan && !canResume) {
      this.emit({ type: "phase", phase: "planning" });
      this.emit({ type: "log", message: "Running Planner..." });
      spec = await this.deps.planner.plan(userPrompt, (e) => {
        if (e.type === "text_delta") this.emit({ type: "agent_text", agent: "planner", delta: e.delta });
        if (e.type === "tool_start") this.emit({ type: "tool_use", agent: "planner", tool: e.tool, status: "start", args: e.args });
        if (e.type === "tool_end") this.emit({ type: "tool_use", agent: "planner", tool: e.tool, status: "end", result: e.result });
      });
      this.deps.artifactStore.writeSpec(spec);
      this.emit({ type: "log", message: "Spec generated." });

      if (this.config.interactive) {
        const reason = "Review the generated spec before continuing.";
        this.emit({ type: "pause", reason });
        if (this.config.onPause) {
          const shouldContinue = await this.config.onPause(reason);
          if (!shouldContinue) {
            status.phase = "failed";
            this.deps.artifactStore.writeStatus(status);
            this.emit({ type: "complete", status });
            return status;
          }
        }
      }
    } else {
      // Solo mode: use prompt as spec directly
      spec = userPrompt;
    }

    // --- Contract (skip if resuming) ---
    if (steps.contract && this.deps.contractManager.isEnabled() && !canResume) {
      this.emit({ type: "phase", phase: "contracting" });

      if (this.deps.contractDrafter && this.deps.evaluator.reviewContract) {
        // Contract drafter reads codebase and proposes, Evaluator reviews testability
        const streamContract = (e: AgentStreamEvent) => {
          if (e.type === "text_delta") this.emit({ type: "agent_text", agent: "planner", delta: e.delta });
          if (e.type === "tool_start") this.emit({ type: "tool_use", agent: "planner", tool: e.tool, status: "start", args: e.args });
          if (e.type === "tool_end") this.emit({ type: "tool_use", agent: "planner", tool: e.tool, status: "end", result: e.result });
        };

        this.emit({ type: "log", message: "Drafting contract..." });
        let draft = await this.deps.contractDrafter.draftContract(spec, streamContract);
        this.deps.contractManager.saveDraft(draft);

        // Review/revise loop
        while (true) {
          this.emit({ type: "log", message: "Evaluator reviewing contract..." });
          const review = await this.deps.evaluator.reviewContract(spec, draft);
          this.deps.contractManager.saveReview(review);

          if (review.approved) {
            this.emit({ type: "log", message: "Contract approved by Evaluator." });
            break;
          }

          if (!this.deps.contractManager.canRevise()) {
            this.emit({ type: "log", message: "Max contract revisions reached. Using current draft." });
            break;
          }

          this.emit({ type: "log", message: `Contract revision needed: ${review.feedback.slice(0, 100)}...` });
          this.deps.contractManager.recordRevision();
          draft = await this.deps.contractDrafter.reviseContract(draft, review.feedback, streamContract);
          this.deps.contractManager.saveDraft(draft);
        }
      } else {
        // Fallback: use spec as basic contract
        this.emit({ type: "log", message: "Agent-driven contract not available. Using spec as contract." });
        this.deps.contractManager.saveDraft(`# Acceptance Contract\n\nBased on spec:\n${spec}`);
      }

      this.deps.contractManager.finalize();
      contract = this.deps.contractManager.readContract() ?? "";
      this.deps.artifactStore.writeContract(contract);
      this.emit({ type: "log", message: "Contract finalized." });

      if (this.config.interactive) {
        const reason = "Review the contract before building.";
        this.emit({ type: "pause", reason });
        if (this.config.onPause) {
          const shouldContinue = await this.config.onPause(reason);
          if (!shouldContinue) {
            status.phase = "failed";
            this.deps.artifactStore.writeStatus(status);
            this.emit({ type: "complete", status });
            return status;
          }
        }
      }
    }

    // --- Build/Eval Loop ---
    let lastReport: EvalReport | undefined;

    for (let round = startRound; round <= this.config.maxRounds; round++) {
      status.currentRound = round;
      status.phase = "building";
      this.deps.artifactStore.writeStatus(status);
      this.deps.artifactStore.saveSession(userPrompt, status);

      // Build
      this.emit({ type: "phase", phase: "building" });
      this.emit({ type: "round", round });
      this.emit({ type: "log", message: `Build round ${round}...` });

      const buildStart = Date.now();
      const buildResult = await this.deps.generator.run(
        this.config.cwd,
        spec,
        contract || undefined,
        lastReport,
        (chunk) => this.parseGeneratorStream(chunk),
      );
      const buildDuration = (Date.now() - buildStart) / 1000;

      this.emit({ type: "log", message: `Build round ${round} done (exit ${buildResult.exitCode}, ${buildDuration.toFixed(0)}s).` });

      // Checkpoint after build
      this.deps.checkpointManager.create(this.config.cwd, round, `After build round ${round}`);

      // Runtime (if needed for eval)
      if (steps.runtime && steps.eval) {
        this.emit({ type: "phase", phase: "running" });
        try {
          this.deps.runtimeManager.prepare(this.config.cwd);
          await this.deps.runtimeManager.start(this.config.cwd);
        } catch (err: any) {
          this.emit({ type: "log", message: `Runtime failed: ${err.message}` });
          // Continue to eval anyway — eval can still do code review
        }
      }

      // Eval
      if (steps.eval) {
        this.emit({ type: "phase", phase: "evaluating" });
        this.emit({ type: "log", message: `Evaluating round ${round}...` });

        const evalStart = Date.now();
        const report = await this.deps.evaluator.evaluate(spec, contract || spec, round, (e) => {
          if (e.type === "text_delta") this.emit({ type: "agent_text", agent: "evaluator", delta: e.delta });
          if (e.type === "tool_start") this.emit({ type: "tool_use", agent: "evaluator", tool: e.tool, status: "start", args: e.args });
          if (e.type === "tool_end") this.emit({ type: "tool_use", agent: "evaluator", tool: e.tool, status: "end", result: e.result });
        });
        const evalDuration = (Date.now() - evalStart) / 1000;

        this.deps.artifactStore.writeEvalReport(report);
        this.emit({ type: "eval", report });
        this.emit({ type: "log", message: `Round ${round}: ${report.verdict} (score ${report.overallScore.toFixed(1)})` });

        // Stop runtime after eval
        if (steps.runtime) {
          this.deps.runtimeManager.stop();
        }

        status.history.push({
          round,
          buildDuration,
          evalDuration,
          score: report.overallScore,
          verdict: report.verdict,
        });

        if (report.verdict === "pass") {
          status.phase = "completed";
          this.deps.artifactStore.writeStatus(status);
          this.emit({ type: "complete", status });
          return status;
        }

        lastReport = report;

        // No pause between rounds — just log and continue
        this.emit({ type: "log", message: `Round ${round} failed (${report.overallScore.toFixed(1)}/10). Continuing to next round...` });

        if (!steps.iterateOnFail) {
          // final-qa: only one eval pass, don't loop
          break;
        }
      } else {
        // No eval (solo, plan-build)
        status.history.push({ round, buildDuration });
        break;
      }
    }

    // Reached max rounds or no-eval mode
    status.phase = "completed";
    this.deps.artifactStore.writeStatus(status);
    this.deps.artifactStore.saveSession(userPrompt, status);
    this.emit({ type: "complete", status });
    return status;
  }

  /**
   * Parse CC's stream-json NDJSON output and emit structured events.
   * CC outputs one JSON object per line with types like:
   *   - assistant (content: text/thinking/tool_use)
   *   - user (tool_result)
   *   - result (final summary)
   *   - system (hooks, init)
   */
  private parseGeneratorStream(chunk: string): void {
    this.ccLineBuf += chunk;
    const lines = this.ccLineBuf.split("\n");
    this.ccLineBuf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const content = event.message?.content;

        if (event.type === "assistant" && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              this.emit({ type: "agent_text", agent: "generator", delta: block.text + "\n" });
            } else if (block.type === "tool_use") {
              const name = block.name ?? "tool";
              const inputPreview = block.input
                ? Object.entries(block.input)
                    .filter(([k]) => ["command", "file_path", "path", "pattern", "content"].includes(k))
                    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
                    .join(", ")
                : "";
              this.emit({ type: "tool_use", agent: "generator", tool: name, status: "start", args: inputPreview });
            }
          }
        } else if (event.type === "result") {
          if (event.subtype === "success" && event.result) {
            this.emit({ type: "agent_text", agent: "generator", delta: "\n" + event.result + "\n" });
          }
        }
        // Ignore system, user (tool_result) events — they're noise
      } catch {
        // Not JSON — ignore
      }
    }
  }
}
