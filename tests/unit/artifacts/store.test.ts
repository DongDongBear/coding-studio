import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../../src/artifacts/store.js";
import type { EvalReport, PipelineStatus } from "../../../src/artifacts/types.js";

describe("ArtifactStore", () => {
  let tmpDir: string;
  let artifactsDir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-art-"));
    artifactsDir = path.join(tmpDir, ".coding-studio");
    store = new ArtifactStore(artifactsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("creates artifacts directory on first write", () => {
    expect(fs.existsSync(artifactsDir)).toBe(false);
    store.writeSpec("# Test Spec\n\nSome content");
    expect(fs.existsSync(artifactsDir)).toBe(true);
  });

  it("writes and reads spec", () => {
    const spec = "# Product Spec\n\n- Feature 1\n- Feature 2";
    store.writeSpec(spec);
    expect(store.readSpec()).toBe(spec);
  });

  it("writes and reads contract", () => {
    const contract = "# Contract\n\n## Acceptance Criteria\n- AC1";
    store.writeContract(contract);
    expect(store.readContract()).toBe(contract);
  });

  it("writes and reads eval report", () => {
    const report: EvalReport = {
      round: 1,
      timestamp: "2026-04-03T12:00:00Z",
      verdict: "fail",
      overallScore: 6.2,
      contractCoverage: 0.7,
      scores: [{ name: "functionality", score: 5.0, weight: 1.0, feedback: "Broken" }],
      blockers: [],
      bugs: [],
      summary: "Needs work.",
    };
    store.writeEvalReport(report);
    const loaded = store.readEvalReport(1);
    expect(loaded).toEqual(report);
  });

  it("returns undefined for missing eval report", () => {
    expect(store.readEvalReport(99)).toBeUndefined();
  });

  it("writes and reads pipeline status", () => {
    const status: PipelineStatus = {
      phase: "building",
      mode: "final-qa",
      currentRound: 1,
      maxRounds: 3,
      history: [],
    };
    store.writeStatus(status);
    expect(store.readStatus()).toEqual(status);
  });

  it("returns undefined for missing spec", () => {
    expect(store.readSpec()).toBeUndefined();
  });

  it("lists all eval reports in order", () => {
    store.writeEvalReport({ round: 2, timestamp: "", verdict: "pass", overallScore: 8, contractCoverage: 1, scores: [], blockers: [], bugs: [], summary: "" });
    store.writeEvalReport({ round: 1, timestamp: "", verdict: "fail", overallScore: 5, contractCoverage: 0.5, scores: [], blockers: [], bugs: [], summary: "" });
    const reports = store.listEvalReports();
    expect(reports).toHaveLength(2);
    expect(reports[0].round).toBe(1);
    expect(reports[1].round).toBe(2);
  });
});
