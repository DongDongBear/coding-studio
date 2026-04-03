import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, interpolateEnvVars } from "../../../src/config/loader.js";
import { defaultConfig } from "../../../src/config/defaults.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const FIXTURES = path.resolve(import.meta.dirname, "../../fixtures");

describe("interpolateEnvVars", () => {
  it("replaces ${VAR} with environment value", () => {
    process.env.TEST_KEY = "secret123";
    expect(interpolateEnvVars("key: ${TEST_KEY}")).toBe("key: secret123");
    delete process.env.TEST_KEY;
  });

  it("leaves string unchanged when no env vars", () => {
    expect(interpolateEnvVars("no vars here")).toBe("no vars here");
  });

  it("throws on undefined env var", () => {
    delete process.env.MISSING_VAR;
    expect(() => interpolateEnvVars("${MISSING_VAR}")).toThrow("MISSING_VAR");
  });
});

describe("loadConfig", () => {
  it("loads and validates a valid config file", () => {
    const config = loadConfig(path.join(FIXTURES, "valid-config.yml"));
    expect(config.models.planner.provider).toBe("anthropic");
    expect(config.pipeline.mode).toBe("final-qa");
    expect(config.evaluation.criteria).toHaveLength(6);
  });

  it("throws on invalid config", () => {
    expect(() => loadConfig(path.join(FIXTURES, "invalid-config.yml"))).toThrow();
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/path/.coding-studio.yml");
    expect(config).toEqual(defaultConfig);
  });

  it("deep merges partial config with defaults", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-test-"));
    const tmpFile = path.join(tmpDir, ".coding-studio.yml");
    fs.writeFileSync(
      tmpFile,
      `pipeline:
  mode: solo
  interactive: true
  artifactsDir: .coding-studio/
  resume: true
  stopOnBlocker: true
  contract:
    enabled: false
    maxRevisions: 0
`,
    );
    const config = loadConfig(tmpFile);
    expect(config.pipeline.mode).toBe("solo");
    expect(config.pipeline.interactive).toBe(true);
    // Other sections fall back to defaults
    expect(config.models).toEqual(defaultConfig.models);
    fs.rmSync(tmpDir, { recursive: true });
  });
});
