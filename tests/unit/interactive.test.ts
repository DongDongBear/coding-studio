import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator, type OrchestratorDeps } from "../../src/orchestrator.js";
import { ArtifactStore } from "../../src/artifacts/store.js";
import type { EvalReport } from "../../src/artifacts/types.js";

function createMockDeps(artifactStore: ArtifactStore): OrchestratorDeps {
  return {
    planner: { plan: vi.fn().mockResolvedValue("# Spec") },
    generator: { run: vi.fn().mockResolvedValue({ exitCode: 0, output: "", duration: 100 }) },
    evaluator: { evaluate: vi.fn().mockResolvedValue({
      round: 1, timestamp: "", verdict: "pass", overallScore: 8,
      contractCoverage: 1, scores: [], blockers: [], bugs: [], summary: "OK",
    } satisfies EvalReport) },
    contractManager: {
      isEnabled: vi.fn().mockReturnValue(false),
      saveDraft: vi.fn(), saveReview: vi.fn(), finalize: vi.fn(),
      readContract: vi.fn().mockReturnValue(""), canRevise: vi.fn().mockReturnValue(false),
      recordRevision: vi.fn(), reset: vi.fn(),
    },
    runtimeManager: {
      prepare: vi.fn(), start: vi.fn().mockResolvedValue({}), stop: vi.fn(),
      healthcheck: vi.fn().mockResolvedValue({ ok: true }),
    },
    checkpointManager: {
      create: vi.fn(), getLatest: vi.fn(), restore: vi.fn(),
    },
    artifactStore,
  };
}

describe("Interactive Mode", () => {
  let tmpDir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-int-"));
    store = new ArtifactStore(path.join(tmpDir, ".coding-studio"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("calls onPause and continues when it returns true", async () => {
    const onPause = vi.fn().mockResolvedValue(true);
    const deps = createMockDeps(store);
    const orch = new Orchestrator(deps, {
      mode: "final-qa", maxRounds: 1, interactive: true, cwd: tmpDir, onPause,
    });
    const status = await orch.run("test");
    expect(onPause).toHaveBeenCalled();
    expect(status.phase).toBe("completed");
  });

  it("aborts pipeline when onPause returns false", async () => {
    const onPause = vi.fn().mockResolvedValue(false);
    const deps = createMockDeps(store);
    const orch = new Orchestrator(deps, {
      mode: "final-qa", maxRounds: 1, interactive: true, cwd: tmpDir, onPause,
    });
    const status = await orch.run("test");
    expect(onPause).toHaveBeenCalled();
    expect(status.phase).toBe("failed");
    // Generator should NOT have been called since we abort after plan
    expect(deps.generator.run).not.toHaveBeenCalled();
  });

  it("does not call onPause when interactive is false", async () => {
    const onPause = vi.fn().mockResolvedValue(true);
    const deps = createMockDeps(store);
    const orch = new Orchestrator(deps, {
      mode: "final-qa", maxRounds: 1, interactive: false, cwd: tmpDir, onPause,
    });
    await orch.run("test");
    expect(onPause).not.toHaveBeenCalled();
  });
});
