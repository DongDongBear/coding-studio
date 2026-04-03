import { getStepsForMode, type PipelineMode } from "./pipeline/modes.js";
import type { ArtifactStore } from "./artifacts/store.js";
import type { EvalReport, PipelineStatus } from "./artifacts/types.js";

export interface OrchestratorDeps {
  planner: { plan(prompt: string): Promise<string> };
  generator: { run(cwd: string, spec: string, contract?: string, evalFeedback?: EvalReport, onOutput?: (chunk: string) => void): Promise<{ exitCode: number | null; output: string; duration: number }> };
  evaluator: { evaluate(spec: string, contract: string, round: number): Promise<EvalReport> };
  contractManager: {
    isEnabled(): boolean;
    saveDraft(content: string): void;
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
}

export type OrchestratorEvent =
  | { type: "phase"; phase: PipelineStatus["phase"] }
  | { type: "round"; round: number }
  | { type: "log"; message: string }
  | { type: "eval"; report: EvalReport }
  | { type: "pause"; reason: string }
  | { type: "complete"; status: PipelineStatus };

export class Orchestrator {
  private deps: OrchestratorDeps;
  private config: OrchestratorConfig;
  private listeners: Array<(event: OrchestratorEvent) => void> = [];

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
    const status: PipelineStatus = {
      phase: "planning",
      mode: this.config.mode,
      currentRound: 0,
      maxRounds: this.config.maxRounds,
      history: [],
    };

    let spec = "";
    let contract = "";

    // --- Plan ---
    if (steps.plan) {
      this.emit({ type: "phase", phase: "planning" });
      this.emit({ type: "log", message: "Running Planner..." });
      spec = await this.deps.planner.plan(userPrompt);
      this.deps.artifactStore.writeSpec(spec);
      this.emit({ type: "log", message: "Spec generated." });

      if (this.config.interactive) {
        this.emit({ type: "pause", reason: "Review the generated spec before continuing." });
      }
    } else {
      // Solo mode: use prompt as spec directly
      spec = userPrompt;
    }

    // --- Contract ---
    if (steps.contract && this.deps.contractManager.isEnabled()) {
      this.emit({ type: "phase", phase: "contracting" });
      // In a real implementation, Generator drafts the contract and Evaluator reviews it.
      // For now, we use the spec as a basic contract.
      this.deps.contractManager.saveDraft(`# Acceptance Contract\n\nBased on spec:\n${spec}`);
      this.deps.contractManager.finalize();
      contract = this.deps.contractManager.readContract() ?? "";
      this.deps.artifactStore.writeContract(contract);
      this.emit({ type: "log", message: "Contract finalized." });

      if (this.config.interactive) {
        this.emit({ type: "pause", reason: "Review the contract before building." });
      }
    }

    // --- Build/Eval Loop ---
    let lastReport: EvalReport | undefined;

    for (let round = 1; round <= this.config.maxRounds; round++) {
      status.currentRound = round;

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
        (chunk) => this.emit({ type: "log", message: chunk }),
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
        const report = await this.deps.evaluator.evaluate(spec, contract || spec, round);
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

        if (this.config.interactive) {
          this.emit({ type: "pause", reason: `Round ${round} failed. Review eval report before continuing.` });
        }

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
    this.emit({ type: "complete", status });
    return status;
  }
}
