import { describe, it, expect } from "vitest";
import { getStepsForMode, isValidMode, getAllModes } from "../../../src/pipeline/modes.js";

describe("Pipeline Modes", () => {
  it("solo mode: only build", () => {
    const steps = getStepsForMode("solo");
    expect(steps.plan).toBe(false);
    expect(steps.build).toBe(true);
    expect(steps.eval).toBe(false);
    expect(steps.contract).toBe(false);
    expect(steps.iterateOnFail).toBe(false);
  });

  it("plan-build mode: plan + build, no eval", () => {
    const steps = getStepsForMode("plan-build");
    expect(steps.plan).toBe(true);
    expect(steps.build).toBe(true);
    expect(steps.eval).toBe(false);
    expect(steps.selfReview).toBe(true);
  });

  it("final-qa mode: plan + build + single eval", () => {
    const steps = getStepsForMode("final-qa");
    expect(steps.plan).toBe(true);
    expect(steps.build).toBe(true);
    expect(steps.eval).toBe(true);
    expect(steps.runtime).toBe(true);
    expect(steps.iterateOnFail).toBe(false);
  });

  it("iterative-qa mode: full pipeline with iteration", () => {
    const steps = getStepsForMode("iterative-qa");
    expect(steps.plan).toBe(true);
    expect(steps.contract).toBe(true);
    expect(steps.build).toBe(true);
    expect(steps.eval).toBe(true);
    expect(steps.iterateOnFail).toBe(true);
  });

  it("isValidMode accepts known modes", () => {
    expect(isValidMode("solo")).toBe(true);
    expect(isValidMode("final-qa")).toBe(true);
  });

  it("isValidMode rejects unknown modes", () => {
    expect(isValidMode("turbo")).toBe(false);
    expect(isValidMode("")).toBe(false);
  });

  it("getAllModes returns all 4 modes", () => {
    const modes = getAllModes();
    expect(modes).toHaveLength(4);
    expect(modes).toContain("solo");
    expect(modes).toContain("iterative-qa");
  });

  it("getStepsForMode returns a copy (not reference)", () => {
    const a = getStepsForMode("solo");
    const b = getStepsForMode("solo");
    a.build = false;
    expect(b.build).toBe(true);
  });
});
