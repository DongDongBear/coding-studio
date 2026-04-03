import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeManager } from "../../../src/runtime/manager.js";
import type { RuntimeConfig } from "../../../src/runtime/manager.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({
    pid: 12345,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    killed: false,
    kill: vi.fn(),
  })),
}));

const testConfig: RuntimeConfig = {
  install: { command: "npm install" },
  build: { command: "npm run build" },
  start: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    readyPattern: "Local:",
    timeoutSec: 10,
  },
  healthcheck: { type: "http", target: "/" },
  captureLogs: true,
};

describe("RuntimeManager", () => {
  let manager: RuntimeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new RuntimeManager(testConfig);
  });

  it("initializes with stopped state", () => {
    const state = manager.getState();
    expect(state.status).toBe("stopped");
    expect(state.logs).toEqual([]);
  });

  it("prepare() runs install and build commands", async () => {
    const { execSync } = await import("node:child_process");
    manager.prepare("/test/cwd");
    expect(execSync).toHaveBeenCalledTimes(2);
    expect(execSync).toHaveBeenCalledWith("npm install", expect.objectContaining({ cwd: "/test/cwd" }));
    expect(execSync).toHaveBeenCalledWith("npm run build", expect.objectContaining({ cwd: "/test/cwd" }));
  });

  it("prepare() throws on install failure", async () => {
    const { execSync } = await import("node:child_process");
    (execSync as any).mockImplementationOnce(() => { throw new Error("install broke"); });
    expect(() => manager.prepare("/test")).toThrow("Install failed");
    expect(manager.getState().status).toBe("failed");
  });

  it("prepare() throws on build failure", async () => {
    const { execSync } = await import("node:child_process");
    (execSync as any).mockImplementationOnce(() => {}); // install ok
    (execSync as any).mockImplementationOnce(() => { throw new Error("build broke"); });
    expect(() => manager.prepare("/test")).toThrow("Build failed");
    expect(manager.getState().status).toBe("failed");
  });

  it("stop() sets status to stopped", () => {
    manager.stop();
    expect(manager.getState().status).toBe("stopped");
  });

  it("getRecentLogs() returns empty when no logs", () => {
    expect(manager.getRecentLogs()).toEqual([]);
  });
});
