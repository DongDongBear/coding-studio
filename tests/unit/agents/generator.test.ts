import { describe, it, expect, vi, beforeEach } from "vitest";
import { Generator } from "../../../src/agents/generator.js";
import type { GeneratorConfig } from "../../../src/agents/generator.js";
import type { EvalReport } from "../../../src/artifacts/types.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    pid: 99999,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: Function) => {
      if (event === "exit") {
        // Simulate immediate exit with code 0
        setTimeout(() => cb(0), 10);
      }
    }),
    killed: false,
    kill: vi.fn(),
  })),
}));

const testConfig: GeneratorConfig = {
  cliCommand: "claude",
  allowedTools: ["Edit", "Write", "Bash", "Read"],
  mcpServers: [],
  maxTurns: 100,
  selfReview: true,
};

describe("Generator", () => {
  let gen: Generator;

  beforeEach(() => {
    vi.clearAllMocks();
    gen = new Generator(testConfig);
  });

  it("builds prompt with spec only", () => {
    const prompt = gen.buildPrompt("# My App\n\nBuild a todo app");
    expect(prompt).toContain("# Product Specification");
    expect(prompt).toContain("Build a todo app");
    expect(prompt).not.toContain("Evaluator Feedback");
    expect(prompt).toContain("Self-Review Requirement");
  });

  it("builds prompt with spec and contract", () => {
    const prompt = gen.buildPrompt("spec text", "# Contract\n- AC1");
    expect(prompt).toContain("# Acceptance Contract");
    expect(prompt).toContain("AC1");
  });

  it("builds prompt with eval feedback", () => {
    const feedback: EvalReport = {
      round: 1,
      timestamp: "",
      verdict: "fail",
      overallScore: 5.5,
      contractCoverage: 0.6,
      scores: [{ name: "functionality", score: 4, weight: 1, feedback: "Broken drag-drop" }],
      blockers: [{ severity: "critical", description: "Entity wiring broken" }],
      bugs: [{ severity: "major", description: "Fill tool broken", location: "Editor.tsx:100", suggestedFix: "Fix mouseUp handler" }],
      summary: "Core interactions broken.",
    };
    const prompt = gen.buildPrompt("spec", undefined, feedback);
    expect(prompt).toContain("Verdict: fail");
    expect(prompt).toContain("Entity wiring broken");
    expect(prompt).toContain("Fill tool broken");
    expect(prompt).toContain("Editor.tsx:100");
    expect(prompt).toContain("Fix mouseUp handler");
    expect(prompt).toContain("functionality: 4/10");
    expect(prompt).toContain("address ALL the feedback");
  });

  it("builds correct CLI args", () => {
    const args = gen.buildArgs("test prompt");
    expect(args).toContain("-p");
    expect(args).toContain("test prompt");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--max-turns");
    expect(args).toContain("100");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Edit,Write,Bash,Read");
  });

  it("includes MCP servers in args", () => {
    const gen2 = new Generator({ ...testConfig, mcpServers: ["playwright", "custom-mcp"] });
    const args = gen2.buildArgs("prompt");
    const mcpIndices = args.reduce<number[]>((acc, a, i) => (a === "--mcp" ? [...acc, i] : acc), []);
    expect(mcpIndices).toHaveLength(2);
    expect(args[mcpIndices[0] + 1]).toBe("playwright");
    expect(args[mcpIndices[1] + 1]).toBe("custom-mcp");
  });

  it("run() spawns claude subprocess", async () => {
    const { spawn } = await import("node:child_process");
    const result = await gen.run("/project", "build stuff");
    expect(spawn).toHaveBeenCalledWith("claude", expect.any(Array), expect.objectContaining({ cwd: "/project" }));
    expect(result.exitCode).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("omits selfReview section when disabled", () => {
    const gen2 = new Generator({ ...testConfig, selfReview: false });
    const prompt = gen2.buildPrompt("spec");
    expect(prompt).not.toContain("Self-Review");
  });
});
