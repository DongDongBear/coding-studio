import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContractManager } from "../../../src/contracts/manager.js";

describe("ContractManager", () => {
  let tmpDir: string;
  let artifactsDir: string;
  let manager: ContractManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-contract-"));
    artifactsDir = path.join(tmpDir, ".coding-studio");
    manager = new ContractManager({ enabled: true, maxRevisions: 2 }, artifactsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("saves and reads a draft", () => {
    manager.saveDraft("# Contract\n- AC1: Login works");
    expect(manager.readDraft()).toBe("# Contract\n- AC1: Login works");
  });

  it("returns undefined for missing draft", () => {
    expect(manager.readDraft()).toBeUndefined();
  });

  it("saves and reads a review", () => {
    manager.saveReview({ approved: false, feedback: "Missing error handling tests" });
    const review = manager.readReview();
    expect(review?.approved).toBe(false);
    expect(review?.feedback).toContain("error handling");
  });

  it("finalizes draft to contract.md", () => {
    manager.saveDraft("# Final Contract\n- All criteria");
    manager.finalize();
    expect(manager.readContract()).toBe("# Final Contract\n- All criteria");
  });

  it("throws when finalizing without a draft", () => {
    expect(() => manager.finalize()).toThrow("No contract draft");
  });

  it("tracks revision count", () => {
    expect(manager.getRevisionCount()).toBe(0);
    expect(manager.canRevise()).toBe(true);
    manager.recordRevision();
    expect(manager.getRevisionCount()).toBe(1);
    expect(manager.canRevise()).toBe(true);
    manager.recordRevision();
    expect(manager.getRevisionCount()).toBe(2);
    expect(manager.canRevise()).toBe(false);
  });

  it("reset clears revision count", () => {
    manager.recordRevision();
    manager.recordRevision();
    manager.reset();
    expect(manager.getRevisionCount()).toBe(0);
    expect(manager.canRevise()).toBe(true);
  });

  it("reports disabled state", () => {
    const disabled = new ContractManager({ enabled: false, maxRevisions: 0 }, artifactsDir);
    expect(disabled.isEnabled()).toBe(false);
  });

  it("creates artifacts directory on first write", () => {
    expect(fs.existsSync(artifactsDir)).toBe(false);
    manager.saveDraft("test");
    expect(fs.existsSync(artifactsDir)).toBe(true);
  });
});
