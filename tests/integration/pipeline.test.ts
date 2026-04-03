import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/loader.js";
import { ArtifactStore } from "../../src/artifacts/store.js";
import { ContractManager } from "../../src/contracts/manager.js";
import { CheckpointManager } from "../../src/checkpoints/manager.js";
import { RuntimeManager } from "../../src/runtime/manager.js";
import { Orchestrator, type OrchestratorDeps } from "../../src/orchestrator.js";
import { getStepsForMode } from "../../src/pipeline/modes.js";
import { evaluatePassFail } from "../../src/agents/evaluator.js";
import { CodeReviewStrategy } from "../../src/strategies/code-review.js";
import { CompositeStrategy } from "../../src/strategies/composite.js";
import { TestRunnerStrategy } from "../../src/strategies/test-runner.js";
import type { EvalReport, EvalScore } from "../../src/artifacts/types.js";

// Mock child_process for RuntimeManager and CheckpointManager
vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "git rev-parse HEAD") return Buffer.from("integration-test-sha\n");
    if (cmd === "git diff --cached --quiet") throw new Error("changes");
    return Buffer.from("");
  }),
  spawn: vi.fn(() => {
    // Capture data handlers so we can emit the ready pattern immediately
    const dataHandlers: Array<(chunk: Buffer) => void> = [];
    const mockProcess = {
      pid: 55555,
      stdout: {
        on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
          if (event === "data") {
            dataHandlers.push(handler);
            // Emit the ready pattern synchronously so RuntimeManager resolves instantly
            setImmediate(() => handler(Buffer.from("server ready\n")));
          }
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      killed: false,
      kill: vi.fn(),
    };
    return mockProcess;
  }),
}));

describe("Integration: Full Pipeline", () => {
  let tmpDir: string;
  let artifactsDir: string;
  let configPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-integration-"));
    artifactsDir = path.join(tmpDir, ".coding-studio");

    // Write a minimal valid config
    configPath = path.join(tmpDir, ".coding-studio.yml");
    fs.writeFileSync(configPath, `
models:
  planner:
    provider: anthropic
    model: claude-sonnet-4-20250514
  evaluator:
    provider: openai
    model: gpt-5.4
generator:
  cliCommand: claude
  allowedTools: [Edit, Write, Bash, Read, Glob, Grep]
  mcpServers: []
  maxTurns: 50
  selfReview: true
  checkpoint:
    enabled: true
    strategy: git-commit
    everyRound: true
runtime:
  install:
    command: "echo install"
  build:
    command: "echo build"
  start:
    command: "echo server"
    url: "http://127.0.0.1:5173"
    readyPattern: "server"
    timeoutSec: 5
  healthcheck:
    type: http
    target: /
  captureLogs: true
evaluation:
  mode: final-pass
  strategy: composite
  maxRounds: 2
  criteriaProfile: app-default
  criteria:
    - name: functionality
      weight: 1.0
      description: "Works correctly"
    - name: code_quality
      weight: 1.0
      description: "Clean code"
  passRules:
    overallScore: 7.0
    minCriterionScore: 5.0
    blockersFail: true
    requiredCriteria: [functionality]
planner:
  ambitious: true
  injectAIFeatures: false
  techPreferences:
    frontend: "React + Vite"
    backend: "Express"
    database: "SQLite"
pipeline:
  mode: final-qa
  interactive: false
  artifactsDir: .coding-studio/
  resume: true
  stopOnBlocker: true
  contract:
    enabled: false
    maxRevisions: 0
`);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("loads config, creates deps, runs final-qa pipeline end-to-end", async () => {
    const config = loadConfig(configPath);

    // Verify config loaded correctly
    expect(config.pipeline.mode).toBe("final-qa");
    expect(config.models.planner.provider).toBe("anthropic");
    expect(config.evaluation.criteria).toHaveLength(2);

    // Create real infrastructure (with mocked child_process)
    const store = new ArtifactStore(artifactsDir);
    const contractMgr = new ContractManager(config.pipeline.contract, artifactsDir);
    const checkpointMgr = new CheckpointManager(config.generator.checkpoint, artifactsDir);

    // Mock planner and evaluator (they'd call real LLMs)
    const mockPlanner = {
      plan: vi.fn().mockResolvedValue("# Todo App Spec\n\n- Add todos\n- Complete todos\n- Delete todos"),
    };

    const passingReport: EvalReport = {
      round: 1,
      timestamp: new Date().toISOString(),
      verdict: "pass",
      overallScore: 8.5,
      contractCoverage: 1.0,
      scores: [
        { name: "functionality", score: 8, weight: 1, feedback: "Core CRUD works" },
        { name: "code_quality", score: 9, weight: 1, feedback: "Clean structure" },
      ],
      blockers: [],
      bugs: [{ severity: "minor", description: "No loading spinner", location: "App.tsx:45" }],
      summary: "Solid implementation with minor polish needed.",
    };

    const mockEvaluator = {
      evaluate: vi.fn().mockResolvedValue(passingReport),
    };

    const mockGenerator = {
      run: vi.fn().mockResolvedValue({ exitCode: 0, output: "Build complete", duration: 5000 }),
    };

    // Use real RuntimeManager but it won't actually start anything (child_process mocked)
    const runtimeMgr = new RuntimeManager(config.runtime);

    const deps: OrchestratorDeps = {
      planner: mockPlanner,
      generator: mockGenerator,
      evaluator: mockEvaluator,
      contractManager: contractMgr,
      runtimeManager: runtimeMgr,
      checkpointManager: checkpointMgr,
      artifactStore: store,
    };

    const orch = new Orchestrator(deps, {
      mode: config.pipeline.mode,
      maxRounds: config.evaluation.maxRounds,
      interactive: false,
      cwd: tmpDir,
    });

    const events: string[] = [];
    orch.onEvent((e) => events.push(e.type));

    const status = await orch.run("Build a todo app");

    // Verify pipeline ran correctly
    expect(mockPlanner.plan).toHaveBeenCalledWith("Build a todo app", expect.any(Function));
    expect(mockGenerator.run).toHaveBeenCalledOnce();
    expect(mockEvaluator.evaluate).toHaveBeenCalledOnce();
    expect(status.phase).toBe("completed");
    expect(status.history).toHaveLength(1);
    expect(status.history[0].verdict).toBe("pass");

    // Verify artifacts were written
    expect(store.readSpec()).toContain("Todo App Spec");
    expect(store.readEvalReport(1)).toBeDefined();
    expect(store.readEvalReport(1)?.verdict).toBe("pass");
    expect(store.readStatus()?.phase).toBe("completed");

    // Verify checkpoint was created
    const checkpoints = checkpointMgr.listAll();
    expect(checkpoints).toHaveLength(1);

    // Verify event sequence
    expect(events).toContain("phase");
    expect(events).toContain("round");
    expect(events).toContain("eval");
    expect(events).toContain("complete");
  });

  it("evaluatePassFail integrates with real criteria from config", () => {
    const config = loadConfig(configPath);
    const scores: EvalScore[] = [
      { name: "functionality", score: 8, weight: 1, feedback: "Good" },
      { name: "code_quality", score: 7, weight: 1, feedback: "Clean" },
    ];
    const result = evaluatePassFail(scores, [], config.evaluation.passRules);
    expect(result.verdict).toBe("pass");
    expect(result.overallScore).toBe(7.5);
  });

  it("CompositeStrategy combines all sub-strategies", () => {
    const composite = new CompositeStrategy([
      new CodeReviewStrategy(),
      new TestRunnerStrategy(),
    ]);
    const fragment = composite.getPromptFragment();
    expect(fragment).toContain("Code Review");
    expect(fragment).toContain("Test Runner");
    expect(fragment).toContain("Composite");
  });

  it("pipeline modes define correct step combinations", () => {
    const solo = getStepsForMode("solo");
    expect(solo.plan).toBe(false);
    expect(solo.eval).toBe(false);

    const iterative = getStepsForMode("iterative-qa");
    expect(iterative.plan).toBe(true);
    expect(iterative.contract).toBe(true);
    expect(iterative.iterateOnFail).toBe(true);
  });
});
