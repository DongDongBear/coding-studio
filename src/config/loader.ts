import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { Value } from "@sinclair/typebox/value";
import { CodingStudioConfigSchema, type CodingStudioConfig } from "./schema.js";
import { defaultConfig } from "./defaults.js";

export function interpolateEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (match, varName) => {
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(`Environment variable ${varName} is not set (referenced as \${${varName}})`);
    }
    return value;
  });
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig(configPath: string): CodingStudioConfig {
  if (!fs.existsSync(configPath)) {
    return structuredClone(defaultConfig);
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const interpolated = interpolateEnvVars(raw);
  const parsed = parseYaml(interpolated);

  const merged = deepMerge(structuredClone(defaultConfig) as unknown as Record<string, any>, parsed);

  if (!Value.Check(CodingStudioConfigSchema, merged)) {
    const errors = [...Value.Errors(CodingStudioConfigSchema, merged)];
    const messages = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid config at ${configPath}:\n${messages}`);
  }

  return merged as CodingStudioConfig;
}
