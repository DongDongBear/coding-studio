import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointManager } from "../../../src/checkpoints/manager.js";
import type { CheckpointConfig } from "../../../src/checkpoints/manager.js";

// Mock child_process to avoid real git operations
vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === "git rev-parse HEAD") return Buffer.from("abc123def\n");
    if (cmd === "git diff --cached --quiet") throw new Error("changes exist");
    return Buffer.from("");
  }),
}));

const enabledConfig: CheckpointConfig = {
  enabled: true,
  strategy: "git-commit",
  everyRound: true,
};

const disabledConfig: CheckpointConfig = {
  enabled: false,
  strategy: "git-commit",
  everyRound: false,
};

describe("CheckpointManager", () => {
  let tmpDir: string;
  let artifactsDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-chk-"));
    artifactsDir = path.join(tmpDir, ".coding-studio");
  });

  it("creates checkpoint with metadata", () => {
    const mgr = new CheckpointManager(enabledConfig, artifactsDir);
    const meta = mgr.create("/project", 1, "After initial build");
    expect(meta.id).toBe("checkpoint-round-1");
    expect(meta.round).toBe(1);
    expect(meta.gitRef).toBe("abc123def");
    expect(meta.description).toBe("After initial build");
  });

  it("persists checkpoint to disk", () => {
    const mgr = new CheckpointManager(enabledConfig, artifactsDir);
    mgr.create("/project", 1, "test");
    const file = path.join(artifactsDir, "checkpoints", "round-1.json");
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(data.gitRef).toBe("abc123def");
  });

  it("throws when checkpoints disabled", () => {
    const mgr = new CheckpointManager(disabledConfig, artifactsDir);
    expect(() => mgr.create("/project", 1, "test")).toThrow("disabled");
  });

  it("lists checkpoints sorted by round", () => {
    const mgr = new CheckpointManager(enabledConfig, artifactsDir);
    mgr.create("/project", 3, "round 3");
    mgr.create("/project", 1, "round 1");
    const all = mgr.listAll();
    expect(all).toHaveLength(2);
    expect(all[0].round).toBe(1);
    expect(all[1].round).toBe(3);
  });

  it("returns latest checkpoint", () => {
    const mgr = new CheckpointManager(enabledConfig, artifactsDir);
    mgr.create("/project", 1, "first");
    mgr.create("/project", 2, "second");
    const latest = mgr.getLatest();
    expect(latest?.round).toBe(2);
  });

  it("returns undefined when no checkpoints", () => {
    const mgr = new CheckpointManager(enabledConfig, artifactsDir);
    expect(mgr.getLatest()).toBeUndefined();
    expect(mgr.listAll()).toEqual([]);
  });

  it("restore calls git reset to checkpoint ref", async () => {
    const { execSync } = await import("node:child_process");
    const mgr = new CheckpointManager(enabledConfig, artifactsDir);
    mgr.create("/project", 1, "target");
    mgr.restore("/project", "checkpoint-round-1");
    expect(execSync).toHaveBeenCalledWith(
      "git reset --hard abc123def",
      expect.objectContaining({ cwd: "/project" })
    );
  });

  it("restore throws for unknown checkpoint", () => {
    const mgr = new CheckpointManager(enabledConfig, artifactsDir);
    expect(() => mgr.restore("/project", "nonexistent")).toThrow("not found");
  });
});
