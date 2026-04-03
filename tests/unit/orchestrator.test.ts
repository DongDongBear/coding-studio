import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator, type OrchestratorDeps, type OrchestratorConfig, type OrchestratorEvent } from "../../src/orchestrator.js";
import { ArtifactStore } from "../../src/artifacts/store.js";
import type { EvalReport } from "../../src/artifacts/types.js";

function createMockDeps(artifactStore: ArtifactStore): OrchestratorDeps {
  return {
    planner: { plan: vi.fn().mockResolvedValue("# Generated Spec\n\n- Feature A\n- Feature B") },
    generator: {
      run: vi.fn().mockResolvedValue({ exitCode: 0, output: "built", duration: 1000 }),
    },
    evaluator: {
      evaluate: vi.fn().mockResolvedValue({
        round: 1, timestamp: "", verdict: "pass", overallScore: 8.0,
        contractCoverage: 1, scores: [], blockers: [], bugs: [], summary: "Good.",
      } satisfies EvalReport),
    },
    contractManager: {
      isEnabled: vi.fn().mockReturnValue(true),
      saveDraft: vi.fn(),
      saveReview: vi.fn(),
      finalize: vi.fn(),
      readContract: vi.fn().mockReturnValue("# Contract"),
      canRevise: vi.fn().mockReturnValue(true),
      recordRevision: vi.fn(),
      reset: vi.fn(),
    },
    runtimeManager: {
      prepare: vi.fn(),
      start: vi.fn().mockResolvedValue({ status: "ready" }),
      stop: vi.fn(),
      healthcheck: vi.fn().mockResolvedValue({ ok: true }),
    },
    checkpointManager: {
      create: vi.fn().mockReturnValue({ id: "cp-1", round: 1 }),
      getLatest: vi.fn(),
      restore: vi.fn(),
    },
    artifactStore,
  };
}

describe("Orchestrator", () => {
  let tmpDir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-orch-"));
    store = new ArtifactStore(path.join(tmpDir, ".coding-studio"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("solo mode: build only, no plan/eval", async () => {
    const deps = createMockDeps(store);
    const orch = new Orchestrator(deps, { mode: "solo", maxRounds: 1, interactive: false, cwd: tmpDir });
    const status = await orch.run("build something");
    expect(deps.planner.plan).not.toHaveBeenCalled();
    expect(deps.generator.run).toHaveBeenCalledOnce();
    expect(deps.evaluator.evaluate).not.toHaveBeenCalled();
    expect(status.phase).toBe("completed");
  });

  it("plan-build mode: plan + build, no eval", async () => {
    const deps = createMockDeps(store);
    const orch = new Orchestrator(deps, { mode: "plan-build", maxRounds: 1, interactive: false, cwd: tmpDir });
    const status = await orch.run("build an app");
    expect(deps.planner.plan).toHaveBeenCalledWith("build an app");
    expect(deps.generator.run).toHaveBeenCalledOnce();
    expect(deps.evaluator.evaluate).not.toHaveBeenCalled();
    expect(status.phase).toBe("completed");
  });

  it("final-qa mode: plan + build + one eval", async () => {
    const deps = createMockDeps(store);
    const orch = new Orchestrator(deps, { mode: "final-qa", maxRounds: 3, interactive: false, cwd: tmpDir });
    const status = await orch.run("build an app");
    expect(deps.planner.plan).toHaveBeenCalled();
    expect(deps.generator.run).toHaveBeenCalledOnce();
    expect(deps.evaluator.evaluate).toHaveBeenCalledOnce();
    expect(deps.runtimeManager.start).toHaveBeenCalled();
    expect(deps.runtimeManager.stop).toHaveBeenCalled();
    expect(status.phase).toBe("completed");
    expect(status.history).toHaveLength(1);
    expect(status.history[0].verdict).toBe("pass");
  });

  it("iterative-qa mode: loops on fail, stops on pass", async () => {
    const deps = createMockDeps(store);
    // First eval fails, second passes
    (deps.evaluator.evaluate as any)
      .mockResolvedValueOnce({
        round: 1, timestamp: "", verdict: "fail", overallScore: 5.0,
        contractCoverage: 0.5, scores: [], blockers: [], bugs: [{ severity: "major", description: "broken" }], summary: "Fix it.",
      })
      .mockResolvedValueOnce({
        round: 2, timestamp: "", verdict: "pass", overallScore: 8.5,
        contractCoverage: 1, scores: [], blockers: [], bugs: [], summary: "Good.",
      });

    const orch = new Orchestrator(deps, { mode: "iterative-qa", maxRounds: 3, interactive: false, cwd: tmpDir });
    const status = await orch.run("build an app");
    expect(deps.generator.run).toHaveBeenCalledTimes(2);
    expect(deps.evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(status.history).toHaveLength(2);
    expect(status.history[0].verdict).toBe("fail");
    expect(status.history[1].verdict).toBe("pass");
  });

  it("emits events during execution", async () => {
    const deps = createMockDeps(store);
    const orch = new Orchestrator(deps, { mode: "final-qa", maxRounds: 1, interactive: false, cwd: tmpDir });
    const events: OrchestratorEvent[] = [];
    orch.onEvent(e => events.push(e));
    await orch.run("test");
    const phases = events.filter(e => e.type === "phase").map(e => (e as any).phase);
    expect(phases).toContain("planning");
    expect(phases).toContain("building");
    expect(phases).toContain("evaluating");
    expect(events.some(e => e.type === "complete")).toBe(true);
  });

  it("writes artifacts: spec, eval report, status", async () => {
    const deps = createMockDeps(store);
    const orch = new Orchestrator(deps, { mode: "final-qa", maxRounds: 1, interactive: false, cwd: tmpDir });
    await orch.run("test");
    expect(store.readSpec()).toContain("Generated Spec");
    expect(store.readEvalReport(1)).toBeDefined();
    expect(store.readStatus()?.phase).toBe("completed");
  });

  it("stops at maxRounds in iterative-qa", async () => {
    const deps = createMockDeps(store);
    (deps.evaluator.evaluate as any).mockResolvedValue({
      round: 1, timestamp: "", verdict: "fail", overallScore: 4.0,
      contractCoverage: 0.3, scores: [], blockers: [], bugs: [], summary: "Still bad.",
    });
    const orch = new Orchestrator(deps, { mode: "iterative-qa", maxRounds: 2, interactive: false, cwd: tmpDir });
    const status = await orch.run("test");
    expect(deps.generator.run).toHaveBeenCalledTimes(2);
    expect(status.history).toHaveLength(2);
    expect(status.phase).toBe("completed");
  });

  it("iterative-qa: runs full contract handshake when agents support it", async () => {
    const deps = createMockDeps(store);
    // Add contract drafting/reviewing capabilities
    (deps.generator as any).draftContract = vi.fn().mockResolvedValue("# Draft Contract\n- AC1: Login works");
    (deps.generator as any).reviseContract = vi.fn().mockResolvedValue("# Revised Contract\n- AC1: Login works\n- AC2: Logout works");
    (deps.evaluator as any).reviewContract = vi.fn()
      .mockResolvedValueOnce({ approved: false, feedback: "Missing logout test" })
      .mockResolvedValueOnce({ approved: true, feedback: "Looks good now" });

    const orch = new Orchestrator(deps, { mode: "iterative-qa", maxRounds: 1, interactive: false, cwd: tmpDir });
    await orch.run("build auth system");

    expect((deps.generator as any).draftContract).toHaveBeenCalledOnce();
    expect((deps.evaluator as any).reviewContract).toHaveBeenCalledTimes(2);
    expect((deps.generator as any).reviseContract).toHaveBeenCalledOnce();
    expect(deps.contractManager.saveDraft).toHaveBeenCalledTimes(2); // draft + revision
    expect(deps.contractManager.saveReview).toHaveBeenCalledTimes(2);
    expect(deps.contractManager.recordRevision).toHaveBeenCalledOnce();
    expect(deps.contractManager.finalize).toHaveBeenCalledOnce();
  });

  it("iterative-qa: falls back to spec-based contract when agents lack methods", async () => {
    const deps = createMockDeps(store);
    // No draftContract/reviewContract on agents
    const orch = new Orchestrator(deps, { mode: "iterative-qa", maxRounds: 1, interactive: false, cwd: tmpDir });
    const events: OrchestratorEvent[] = [];
    orch.onEvent(e => events.push(e));
    await orch.run("build something");

    const logs = events.filter(e => e.type === "log").map(e => (e as any).message);
    expect(logs.some((m: string) => m.includes("spec as contract"))).toBe(true);
    expect(deps.contractManager.finalize).toHaveBeenCalledOnce();
  });
});
