import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { CodingStudioConfigSchema } from "../../../src/config/schema.js";
import { defaultConfig } from "../../../src/config/defaults.js";

describe("CodingStudioConfigSchema", () => {
  it("validates the default config", () => {
    const result = Value.Check(CodingStudioConfigSchema, defaultConfig);
    expect(result).toBe(true);
  });

  it("rejects config with invalid pipeline mode", () => {
    const bad = { ...defaultConfig, pipeline: { ...defaultConfig.pipeline, mode: "invalid" } };
    const result = Value.Check(CodingStudioConfigSchema, bad);
    expect(result).toBe(false);
  });

  it("rejects config with missing models section", () => {
    const { models, ...rest } = defaultConfig;
    const result = Value.Check(CodingStudioConfigSchema, rest);
    expect(result).toBe(false);
  });

  it("accepts config with custom criteria weights", () => {
    const custom = structuredClone(defaultConfig);
    custom.evaluation.criteria[0].weight = 2.0;
    const result = Value.Check(CodingStudioConfigSchema, custom);
    expect(result).toBe(true);
  });
});
