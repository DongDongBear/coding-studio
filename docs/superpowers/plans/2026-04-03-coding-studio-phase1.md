# Coding Studio Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the project scaffold, config system, auth/provider layer, and artifact store — enough to run `coding-studio models list` and `coding-studio models status`.

**Architecture:** TypeScript ESM CLI using commander. Config loaded from `.coding-studio.yml` with TypeBox schema validation. Auth via openclaw-style `auth-profiles.json` with multi-key rotation. Provider discovery via `@mariozechner/pi-ai`. Artifact store as a thin file-system wrapper over `.coding-studio/`.

**Tech Stack:** TypeScript 5.8+, Node 20+, Vitest, commander, yaml, @sinclair/typebox, @mariozechner/pi-ai, @inquirer/prompts

**Spec:** `docs/superpowers/specs/2026-04-03-coding-studio-design.md`

---

## File Structure

```
coding-studio/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── src/
│   ├── cli.ts                      ← CLI entry point
│   ├── config/
│   │   ├── schema.ts               ← TypeBox schema for .coding-studio.yml
│   │   ├── defaults.ts             ← Default config values
│   │   └── loader.ts               ← Load + validate + env interpolation
│   ├── auth/
│   │   ├── types.ts                ← AuthProfile, AuthProfileStore types
│   │   ├── profiles.ts             ← Read/write auth-profiles.json
│   │   ├── rotation.ts             ← Multi-key rotation logic
│   │   └── setup.ts                ← Interactive onboarding wizard
│   ├── providers/
│   │   └── registry.ts             ← pi-ai model discovery + auth integration
│   └── artifacts/
│       ├── types.ts                ← EvalReport, PipelineStatus, etc.
│       └── store.ts                ← Read/write artifact files
└── tests/
    ├── unit/
    │   ├── config/
    │   │   ├── schema.test.ts
    │   │   └── loader.test.ts
    │   ├── auth/
    │   │   ├── profiles.test.ts
    │   │   └── rotation.test.ts
    │   ├── providers/
    │   │   └── registry.test.ts
    │   └── artifacts/
    │       └── store.test.ts
    └── fixtures/
        ├── valid-config.yml
        ├── invalid-config.yml
        ├── auth-profiles.json
        └── sample-eval-report.json
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "coding-studio",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "coding-studio": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "@mariozechner/pi-ai": "latest",
    "commander": "^13.0.0",
    "yaml": "^2.7.0",
    "@sinclair/typebox": "^0.34.0",
    "@inquirer/prompts": "^7.0.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.coding-studio/
*.tsbuildinfo
.env
```

- [ ] **Step 5: Install dependencies and verify**

Run: `npm install`
Expected: `node_modules/` created, no errors.

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold project with TS, Vitest, commander, pi-ai"
```

---

### Task 2: Config Schema + Defaults

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/defaults.ts`
- Test: `tests/unit/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config/schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { CodingStudioConfigSchema } from "../../src/config/schema.js";
import { defaultConfig } from "../../src/config/defaults.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config/schema.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write config schema**

Create `src/config/schema.ts`:

```typescript
import { Type, type Static } from "@sinclair/typebox";

const ModelRefSchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
});

const CriterionSchema = Type.Object({
  name: Type.String(),
  weight: Type.Number({ minimum: 0 }),
  description: Type.String(),
});

const PassRulesSchema = Type.Object({
  overallScore: Type.Number({ minimum: 0, maximum: 10 }),
  minCriterionScore: Type.Number({ minimum: 0, maximum: 10 }),
  blockersFail: Type.Boolean(),
  requiredCriteria: Type.Array(Type.String()),
});

const PlaywrightConfigSchema = Type.Object({
  baseUrl: Type.String(),
  viewport: Type.Object({
    width: Type.Number(),
    height: Type.Number(),
  }),
});

const EvaluationSchema = Type.Object({
  mode: Type.Union([Type.Literal("final-pass"), Type.Literal("iterative")]),
  strategy: Type.Union([
    Type.Literal("code-review"),
    Type.Literal("playwright"),
    Type.Literal("test-runner"),
    Type.Literal("composite"),
  ]),
  maxRounds: Type.Number({ minimum: 1, maximum: 10 }),
  criteriaProfile: Type.String(),
  criteria: Type.Array(CriterionSchema),
  passRules: PassRulesSchema,
  playwright: Type.Optional(PlaywrightConfigSchema),
});

const GeneratorSchema = Type.Object({
  cliCommand: Type.String(),
  authProfile: Type.Optional(Type.String()),
  allowedTools: Type.Array(Type.String()),
  mcpServers: Type.Array(Type.String()),
  maxTurns: Type.Number({ minimum: 1 }),
  selfReview: Type.Boolean(),
  checkpoint: Type.Object({
    enabled: Type.Boolean(),
    strategy: Type.Union([Type.Literal("git-commit"), Type.Literal("diff-snapshot")]),
    everyRound: Type.Boolean(),
  }),
});

const RuntimeSchema = Type.Object({
  install: Type.Object({ command: Type.String() }),
  build: Type.Object({ command: Type.String() }),
  start: Type.Object({
    command: Type.String(),
    url: Type.String(),
    readyPattern: Type.String(),
    timeoutSec: Type.Number({ minimum: 1 }),
  }),
  healthcheck: Type.Object({
    type: Type.Union([Type.Literal("http"), Type.Literal("tcp"), Type.Literal("command")]),
    target: Type.String(),
  }),
  captureLogs: Type.Boolean(),
});

const PlannerSchema = Type.Object({
  ambitious: Type.Boolean(),
  injectAIFeatures: Type.Boolean(),
  techPreferences: Type.Object({
    frontend: Type.String(),
    backend: Type.String(),
    database: Type.String(),
  }),
});

const ContractSchema = Type.Object({
  enabled: Type.Boolean(),
  maxRevisions: Type.Number({ minimum: 0 }),
});

const PipelineSchema = Type.Object({
  mode: Type.Union([
    Type.Literal("solo"),
    Type.Literal("plan-build"),
    Type.Literal("final-qa"),
    Type.Literal("iterative-qa"),
  ]),
  interactive: Type.Boolean(),
  artifactsDir: Type.String(),
  resume: Type.Boolean(),
  stopOnBlocker: Type.Boolean(),
  contract: ContractSchema,
});

export const CodingStudioConfigSchema = Type.Object({
  models: Type.Object({
    planner: ModelRefSchema,
    generator: Type.Optional(
      Type.Object({
        provider: Type.String(),
        model: Type.String(),
        authProfile: Type.Optional(Type.String()),
      }),
    ),
    evaluator: ModelRefSchema,
  }),
  generator: GeneratorSchema,
  runtime: RuntimeSchema,
  evaluation: EvaluationSchema,
  planner: PlannerSchema,
  pipeline: PipelineSchema,
});

export type CodingStudioConfig = Static<typeof CodingStudioConfigSchema>;
```

- [ ] **Step 4: Write defaults**

Create `src/config/defaults.ts`:

```typescript
import type { CodingStudioConfig } from "./schema.js";

export const defaultConfig: CodingStudioConfig = {
  models: {
    planner: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
    evaluator: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  },
  generator: {
    cliCommand: "claude",
    allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
    mcpServers: [],
    maxTurns: 200,
    selfReview: true,
    checkpoint: {
      enabled: true,
      strategy: "git-commit",
      everyRound: true,
    },
  },
  runtime: {
    install: { command: "npm install" },
    build: { command: "npm run build" },
    start: {
      command: "npm run dev -- --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      readyPattern: "Local:",
      timeoutSec: 90,
    },
    healthcheck: { type: "http", target: "/" },
    captureLogs: true,
  },
  evaluation: {
    mode: "final-pass",
    strategy: "composite",
    maxRounds: 3,
    criteriaProfile: "app-default",
    criteria: [
      { name: "functionality", weight: 1.0, description: "Core features work correctly" },
      { name: "product_depth", weight: 1.0, description: "Real depth, not demo/stub" },
      { name: "code_quality", weight: 1.0, description: "Clean, maintainable, no integration risks" },
      { name: "design_quality", weight: 1.25, description: "Visual coherence and quality" },
      { name: "craft", weight: 1.0, description: "Typography, spacing, color execution" },
      { name: "originality", weight: 1.25, description: "Intentional design choices, no AI slop" },
    ],
    passRules: {
      overallScore: 7.5,
      minCriterionScore: 6.0,
      blockersFail: true,
      requiredCriteria: ["functionality", "product_depth", "code_quality"],
    },
  },
  planner: {
    ambitious: true,
    injectAIFeatures: true,
    techPreferences: {
      frontend: "React + Vite + TailwindCSS",
      backend: "FastAPI",
      database: "SQLite",
    },
  },
  pipeline: {
    mode: "final-qa",
    interactive: false,
    artifactsDir: ".coding-studio/",
    resume: true,
    stopOnBlocker: true,
    contract: {
      enabled: true,
      maxRevisions: 2,
    },
  },
};
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/config/schema.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/config/defaults.ts tests/unit/config/schema.test.ts
git commit -m "feat: add config schema and defaults with TypeBox validation"
```

---

### Task 3: Config Loader

**Files:**
- Create: `src/config/loader.ts`
- Create: `tests/fixtures/valid-config.yml`
- Create: `tests/fixtures/invalid-config.yml`
- Test: `tests/unit/config/loader.test.ts`

- [ ] **Step 1: Create test fixtures**

Create `tests/fixtures/valid-config.yml`:

```yaml
models:
  planner:
    provider: anthropic
    model: claude-sonnet-4-20250514
  evaluator:
    provider: openai
    model: gpt-5.4

generator:
  cliCommand: claude
  allowedTools: [Edit, Write, Bash, Read]
  mcpServers: []
  maxTurns: 100
  selfReview: true
  checkpoint:
    enabled: true
    strategy: git-commit
    everyRound: true

runtime:
  install:
    command: npm install
  build:
    command: npm run build
  start:
    command: npm run dev -- --host 127.0.0.1 --port 5173
    url: "http://127.0.0.1:5173"
    readyPattern: "Local:"
    timeoutSec: 90
  healthcheck:
    type: http
    target: /
  captureLogs: true

evaluation:
  mode: final-pass
  strategy: composite
  maxRounds: 3
  criteriaProfile: app-default
  criteria:
    - name: functionality
      weight: 1.0
      description: "Core features work"
    - name: product_depth
      weight: 1.0
      description: "Real depth"
    - name: code_quality
      weight: 1.0
      description: "Clean code"
    - name: design_quality
      weight: 1.25
      description: "Visual coherence"
    - name: craft
      weight: 1.0
      description: "Technical execution"
    - name: originality
      weight: 1.25
      description: "No AI slop"
  passRules:
    overallScore: 7.5
    minCriterionScore: 6.0
    blockersFail: true
    requiredCriteria: [functionality, product_depth, code_quality]

planner:
  ambitious: true
  injectAIFeatures: true
  techPreferences:
    frontend: "React + Vite + TailwindCSS"
    backend: "FastAPI"
    database: "SQLite"

pipeline:
  mode: final-qa
  interactive: false
  artifactsDir: .coding-studio/
  resume: true
  stopOnBlocker: true
  contract:
    enabled: true
    maxRevisions: 2
```

Create `tests/fixtures/invalid-config.yml`:

```yaml
models:
  planner:
    provider: anthropic
pipeline:
  mode: not-a-real-mode
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/config/loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, interpolateEnvVars } from "../../src/config/loader.js";
import { defaultConfig } from "../../src/config/defaults.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");

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
    fs.writeFileSync(tmpFile, "pipeline:\n  mode: solo\n  interactive: true\n  artifactsDir: .coding-studio/\n  resume: true\n  stopOnBlocker: true\n  contract:\n    enabled: false\n    maxRevisions: 0\n");
    const config = loadConfig(tmpFile);
    expect(config.pipeline.mode).toBe("solo");
    expect(config.pipeline.interactive).toBe(true);
    // Other sections fall back to defaults
    expect(config.models).toEqual(defaultConfig.models);
    fs.rmSync(tmpDir, { recursive: true });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/config/loader.test.ts`
Expected: FAIL — module `../../src/config/loader.js` not found.

- [ ] **Step 4: Implement config loader**

Create `src/config/loader.ts`:

```typescript
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

  const merged = deepMerge(defaultConfig, parsed);

  if (!Value.Check(CodingStudioConfigSchema, merged)) {
    const errors = [...Value.Errors(CodingStudioConfigSchema, merged)];
    const messages = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid config at ${configPath}:\n${messages}`);
  }

  return merged as CodingStudioConfig;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/config/loader.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/loader.ts tests/unit/config/loader.test.ts tests/fixtures/valid-config.yml tests/fixtures/invalid-config.yml
git commit -m "feat: config loader with YAML parsing, env var interpolation, deep merge"
```

---

### Task 4: Auth Types + Profiles Store

**Files:**
- Create: `src/auth/types.ts`
- Create: `src/auth/profiles.ts`
- Create: `tests/fixtures/auth-profiles.json`
- Test: `tests/unit/auth/profiles.test.ts`

- [ ] **Step 1: Create test fixture**

Create `tests/fixtures/auth-profiles.json`:

```json
{
  "version": 2,
  "profiles": {
    "anthropic:main": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-test-key-1"
    },
    "anthropic:backup": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-test-key-2"
    },
    "openai:main": {
      "type": "api_key",
      "provider": "openai",
      "key": "sk-openai-test-key"
    },
    "anthropic:sub": {
      "type": "token",
      "provider": "anthropic",
      "token": "tok-sub-test",
      "expires": "2027-01-01T00:00:00Z"
    }
  },
  "order": {
    "anthropic": ["anthropic:main", "anthropic:backup", "anthropic:sub"],
    "openai": ["openai:main"]
  },
  "lastGood": {
    "anthropic": "anthropic:main"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/auth/profiles.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthProfileStore } from "../../src/auth/profiles.js";

describe("AuthProfileStore", () => {
  let tmpDir: string;
  let storePath: string;
  let store: AuthProfileStore;
  const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/auth-profiles.json");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-auth-"));
    storePath = path.join(tmpDir, "auth-profiles.json");
    fs.copyFileSync(FIXTURE, storePath);
    store = new AuthProfileStore(storePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("loads profiles from disk", () => {
    const profile = store.getProfile("anthropic:main");
    expect(profile).toBeDefined();
    expect(profile!.type).toBe("api_key");
    expect(profile!.provider).toBe("anthropic");
  });

  it("returns undefined for unknown profile", () => {
    expect(store.getProfile("unknown:nope")).toBeUndefined();
  });

  it("lists profiles for a provider in order", () => {
    const ids = store.getProviderOrder("anthropic");
    expect(ids).toEqual(["anthropic:main", "anthropic:backup", "anthropic:sub"]);
  });

  it("returns empty array for provider with no profiles", () => {
    expect(store.getProviderOrder("google")).toEqual([]);
  });

  it("resolves API key from api_key profile", () => {
    const key = store.resolveKey("anthropic:main");
    expect(key).toBe("sk-ant-test-key-1");
  });

  it("resolves token from token profile", () => {
    const key = store.resolveKey("anthropic:sub");
    expect(key).toBe("tok-sub-test");
  });

  it("adds a new profile and persists", () => {
    store.addProfile("google:main", {
      type: "api_key",
      provider: "google",
      key: "AIza-test",
    });
    // Re-read from disk
    const fresh = new AuthProfileStore(storePath);
    expect(fresh.getProfile("google:main")).toBeDefined();
    expect(fresh.resolveKey("google:main")).toBe("AIza-test");
  });

  it("updates lastGood", () => {
    store.setLastGood("anthropic", "anthropic:backup");
    const fresh = new AuthProfileStore(storePath);
    expect(fresh.getLastGood("anthropic")).toBe("anthropic:backup");
  });

  it("creates new store file if none exists", () => {
    const newPath = path.join(tmpDir, "new-profiles.json");
    const newStore = new AuthProfileStore(newPath);
    newStore.addProfile("test:first", {
      type: "api_key",
      provider: "test",
      key: "test-key",
    });
    expect(fs.existsSync(newPath)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/auth/profiles.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement auth types**

Create `src/auth/types.ts`:

```typescript
export interface ApiKeyProfile {
  type: "api_key";
  provider: string;
  key: string;
}

export interface TokenProfile {
  type: "token";
  provider: string;
  token: string;
  expires?: string;
}

export interface OAuthProfile {
  type: "oauth";
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expires?: string;
}

export type AuthProfile = ApiKeyProfile | TokenProfile | OAuthProfile;

export interface AuthProfilesData {
  version: number;
  profiles: Record<string, AuthProfile>;
  order: Record<string, string[]>;
  lastGood: Record<string, string>;
}

export interface RateLimitInfo {
  profileId: string;
  cooldownUntil: number; // epoch ms
}
```

- [ ] **Step 5: Implement profiles store**

Create `src/auth/profiles.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { AuthProfile, AuthProfilesData } from "./types.js";

export class AuthProfileStore {
  private data: AuthProfilesData;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): AuthProfilesData {
    if (!fs.existsSync(this.filePath)) {
      return { version: 2, profiles: {}, order: {}, lastGood: {} };
    }
    const raw = fs.readFileSync(this.filePath, "utf-8");
    return JSON.parse(raw) as AuthProfilesData;
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  getProfile(id: string): AuthProfile | undefined {
    return this.data.profiles[id];
  }

  getProviderOrder(provider: string): string[] {
    return this.data.order[provider] ?? [];
  }

  getLastGood(provider: string): string | undefined {
    return this.data.lastGood[provider];
  }

  resolveKey(profileId: string): string | undefined {
    const profile = this.data.profiles[profileId];
    if (!profile) return undefined;
    if (profile.type === "api_key") return profile.key;
    if (profile.type === "token") return profile.token;
    if (profile.type === "oauth") return profile.accessToken;
    return undefined;
  }

  addProfile(id: string, profile: AuthProfile): void {
    this.data.profiles[id] = profile;
    const provider = profile.provider;
    if (!this.data.order[provider]) {
      this.data.order[provider] = [];
    }
    if (!this.data.order[provider].includes(id)) {
      this.data.order[provider].push(id);
    }
    this.save();
  }

  removeProfile(id: string): void {
    const profile = this.data.profiles[id];
    if (!profile) return;
    delete this.data.profiles[id];
    const provider = profile.provider;
    if (this.data.order[provider]) {
      this.data.order[provider] = this.data.order[provider].filter((p) => p !== id);
    }
    if (this.data.lastGood[provider] === id) {
      delete this.data.lastGood[provider];
    }
    this.save();
  }

  setLastGood(provider: string, profileId: string): void {
    this.data.lastGood[provider] = profileId;
    this.save();
  }

  listProviders(): string[] {
    return [...new Set(Object.values(this.data.profiles).map((p) => p.provider))];
  }

  listProfiles(): Array<{ id: string; profile: AuthProfile }> {
    return Object.entries(this.data.profiles).map(([id, profile]) => ({ id, profile }));
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/unit/auth/profiles.test.ts`
Expected: All 9 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/auth/types.ts src/auth/profiles.ts tests/unit/auth/profiles.test.ts tests/fixtures/auth-profiles.json
git commit -m "feat: auth profile store with CRUD, key resolution, and persistence"
```

---

### Task 5: Auth Key Rotation

**Files:**
- Create: `src/auth/rotation.ts`
- Test: `tests/unit/auth/rotation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/auth/rotation.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyRotator } from "../../src/auth/rotation.js";
import { AuthProfileStore } from "../../src/auth/profiles.js";

describe("KeyRotator", () => {
  let tmpDir: string;
  let store: AuthProfileStore;
  let rotator: KeyRotator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rot-"));
    const storePath = path.join(tmpDir, "auth-profiles.json");
    store = new AuthProfileStore(storePath);
    store.addProfile("anthropic:a", { type: "api_key", provider: "anthropic", key: "key-a" });
    store.addProfile("anthropic:b", { type: "api_key", provider: "anthropic", key: "key-b" });
    store.addProfile("anthropic:c", { type: "api_key", provider: "anthropic", key: "key-c" });
    rotator = new KeyRotator(store);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("resolves key from first profile in order", () => {
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-a");
  });

  it("resolves from env override first", () => {
    process.env.CODING_STUDIO_LIVE_ANTHROPIC_KEY = "env-override";
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("env-override");
    delete process.env.CODING_STUDIO_LIVE_ANTHROPIC_KEY;
  });

  it("falls back to generic env var", () => {
    // Empty store for a provider
    const key = rotator.resolveKeyForProvider("google");
    expect(key).toBeUndefined();

    process.env.GOOGLE_API_KEY = "generic-google-key";
    const key2 = rotator.resolveKeyForProvider("google");
    expect(key2).toBe("generic-google-key");
    delete process.env.GOOGLE_API_KEY;
  });

  it("skips rate-limited keys", () => {
    rotator.markRateLimited("anthropic:a", 60_000);
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-b");
  });

  it("returns to rate-limited key after cooldown expires", () => {
    rotator.markRateLimited("anthropic:a", -1); // negative = already expired
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-a");
  });

  it("returns undefined when all keys are rate-limited", () => {
    rotator.markRateLimited("anthropic:a", 60_000);
    rotator.markRateLimited("anthropic:b", 60_000);
    rotator.markRateLimited("anthropic:c", 60_000);
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBeUndefined();
  });

  it("prefers lastGood profile", () => {
    store.setLastGood("anthropic", "anthropic:b");
    rotator = new KeyRotator(store); // re-create to pick up lastGood
    const key = rotator.resolveKeyForProvider("anthropic");
    expect(key).toBe("key-b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/auth/rotation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement key rotation**

Create `src/auth/rotation.ts`:

```typescript
import type { RateLimitInfo } from "./types.js";
import type { AuthProfileStore } from "./profiles.js";

export class KeyRotator {
  private store: AuthProfileStore;
  private rateLimits: Map<string, RateLimitInfo> = new Map();

  constructor(store: AuthProfileStore) {
    this.store = store;
  }

  resolveKeyForProvider(provider: string): string | undefined {
    // Priority 1: Live env override
    const liveEnvKey = `CODING_STUDIO_LIVE_${provider.toUpperCase()}_KEY`;
    if (process.env[liveEnvKey]) {
      return process.env[liveEnvKey];
    }

    // Priority 2: Profile store (lastGood first, then order)
    const order = this.store.getProviderOrder(provider);
    const lastGood = this.store.getLastGood(provider);

    const sortedOrder = lastGood && order.includes(lastGood)
      ? [lastGood, ...order.filter((id) => id !== lastGood)]
      : order;

    const now = Date.now();
    for (const profileId of sortedOrder) {
      const limit = this.rateLimits.get(profileId);
      if (limit && limit.cooldownUntil > now) {
        continue;
      }
      // Cooldown expired — remove stale entry
      if (limit) {
        this.rateLimits.delete(profileId);
      }
      const key = this.store.resolveKey(profileId);
      if (key) {
        this.store.setLastGood(provider, profileId);
        return key;
      }
    }

    // Priority 3: Generic env var fallback
    const genericEnvKey = `${provider.toUpperCase()}_API_KEY`;
    if (process.env[genericEnvKey]) {
      return process.env[genericEnvKey];
    }

    return undefined;
  }

  markRateLimited(profileId: string, cooldownMs: number): void {
    this.rateLimits.set(profileId, {
      profileId,
      cooldownUntil: Date.now() + cooldownMs,
    });
  }

  clearRateLimits(): void {
    this.rateLimits.clear();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/auth/rotation.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/rotation.ts tests/unit/auth/rotation.test.ts
git commit -m "feat: key rotation with rate-limit tracking, env override, lastGood preference"
```

---

### Task 6: Provider Registry

**Files:**
- Create: `src/providers/registry.ts`
- Test: `tests/unit/providers/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/providers/registry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProviderRegistry } from "../../src/providers/registry.js";

// Mock pi-ai — getModel and getModels may not be available without API keys at test time
vi.mock("@mariozechner/pi-ai", () => ({
  getProviders: () => ["anthropic", "openai", "google"],
  getModels: (provider?: string) => {
    const all = [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200000, maxTokens: 16384 },
      { id: "gpt-5.4", name: "GPT-5.4", provider: "openai", cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 10 }, contextWindow: 256000, maxTokens: 32768 },
    ];
    return provider ? all.filter((m) => m.provider === provider) : all;
  },
  getModel: (provider: string, id: string) => {
    const models = [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200000, maxTokens: 16384 },
    ];
    return models.find((m) => m.provider === provider && m.id === id);
  },
}));

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("lists available providers", () => {
    const providers = registry.listProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
  });

  it("lists models for a provider", () => {
    const models = registry.listModels("anthropic");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].provider).toBe("anthropic");
  });

  it("resolves a model by provider + id", () => {
    const model = registry.resolveModel("anthropic", "claude-sonnet-4-20250514");
    expect(model).toBeDefined();
    expect(model!.id).toBe("claude-sonnet-4-20250514");
  });

  it("returns undefined for unknown model", () => {
    const model = registry.resolveModel("anthropic", "nonexistent");
    expect(model).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/providers/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement provider registry**

Create `src/providers/registry.ts`:

```typescript
import { getProviders, getModels, getModel } from "@mariozechner/pi-ai";

export class ProviderRegistry {
  listProviders(): string[] {
    return getProviders();
  }

  listModels(provider?: string): Array<{
    id: string;
    name: string;
    provider: string;
    cost: { input: number; output: number };
    contextWindow: number;
  }> {
    const models = getModels(provider);
    return models.map((m: any) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      cost: { input: m.cost.input, output: m.cost.output },
      contextWindow: m.contextWindow,
    }));
  }

  resolveModel(provider: string, modelId: string) {
    try {
      return getModel(provider, modelId);
    } catch {
      return undefined;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/providers/registry.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/registry.ts tests/unit/providers/registry.test.ts
git commit -m "feat: provider registry wrapping pi-ai model discovery"
```

---

### Task 7: Artifact Types + Store

**Files:**
- Create: `src/artifacts/types.ts`
- Create: `src/artifacts/store.ts`
- Create: `tests/fixtures/sample-eval-report.json`
- Test: `tests/unit/artifacts/store.test.ts`

- [ ] **Step 1: Create test fixture**

Create `tests/fixtures/sample-eval-report.json`:

```json
{
  "round": 1,
  "timestamp": "2026-04-03T12:00:00Z",
  "verdict": "fail",
  "overallScore": 6.2,
  "contractCoverage": 0.7,
  "scores": [
    { "name": "functionality", "score": 5.0, "weight": 1.0, "feedback": "Core drag-drop broken" },
    { "name": "design_quality", "score": 8.0, "weight": 1.25, "feedback": "Cohesive dark theme" }
  ],
  "blockers": [
    { "severity": "critical", "description": "Entity wiring broken", "evidence": "Click entity → no response" }
  ],
  "bugs": [
    { "severity": "major", "description": "Fill tool only fills endpoints", "location": "LevelEditor.tsx:892", "suggestedFix": "Call fillRectangle on mouseUp" }
  ],
  "summary": "Visual quality good but core interaction broken."
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/artifacts/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../src/artifacts/store.js";
import type { EvalReport, PipelineStatus } from "../../src/artifacts/types.js";

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/artifacts/store.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement artifact types**

Create `src/artifacts/types.ts`:

```typescript
export interface EvalScore {
  name: string;
  score: number;
  weight: number;
  feedback: string;
}

export interface Blocker {
  severity: "critical" | "major";
  description: string;
  evidence?: string;
}

export interface Bug {
  severity: "critical" | "major" | "minor";
  description: string;
  location?: string;
  suggestedFix?: string;
}

export interface EvalReport {
  round: number;
  timestamp: string;
  verdict: "pass" | "fail";
  overallScore: number;
  contractCoverage: number;
  scores: EvalScore[];
  blockers: Blocker[];
  bugs: Bug[];
  summary: string;
}

export interface RuntimeState {
  status: "starting" | "ready" | "failed" | "stopped";
  url?: string;
  pid?: number;
  startedAt?: string;
  healthcheck?: { ok: boolean; detail?: string };
  logFiles: string[];
}

export interface PipelineStatus {
  phase: "planning" | "contracting" | "building" | "running" | "evaluating" | "completed" | "failed";
  mode: "solo" | "plan-build" | "final-qa" | "iterative-qa";
  currentRound: number;
  maxRounds: number;
  activeCheckpoint?: string;
  generatorProfile?: string;
  history: Array<{
    round: number;
    buildDuration: number;
    runtimeDuration?: number;
    evalDuration?: number;
    score?: number;
    verdict?: "pass" | "fail";
  }>;
}

export interface CheckpointMeta {
  id: string;
  round: number;
  timestamp: string;
  gitRef?: string;
  description: string;
}
```

- [ ] **Step 5: Implement artifact store**

Create `src/artifacts/store.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { EvalReport, PipelineStatus } from "./types.js";

export class ArtifactStore {
  private dir: string;

  constructor(artifactsDir: string) {
    this.dir = artifactsDir;
  }

  private ensureDir(subdir?: string): string {
    const target = subdir ? path.join(this.dir, subdir) : this.dir;
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    return target;
  }

  private writeTo(relativePath: string, content: string): void {
    const fullPath = path.join(this.dir, relativePath);
    this.ensureDir(path.dirname(relativePath) === "." ? undefined : path.dirname(relativePath));
    fs.writeFileSync(fullPath, content, "utf-8");
  }

  private readFrom(relativePath: string): string | undefined {
    const fullPath = path.join(this.dir, relativePath);
    if (!fs.existsSync(fullPath)) return undefined;
    return fs.readFileSync(fullPath, "utf-8");
  }

  writeSpec(content: string): void {
    this.writeTo("spec.md", content);
  }

  readSpec(): string | undefined {
    return this.readFrom("spec.md");
  }

  writeContract(content: string): void {
    this.writeTo("contract.md", content);
  }

  readContract(): string | undefined {
    return this.readFrom("contract.md");
  }

  writeSelfReview(content: string): void {
    this.writeTo("self-review.md", content);
  }

  readSelfReview(): string | undefined {
    return this.readFrom("self-review.md");
  }

  writeBuildLog(content: string): void {
    this.writeTo("build-log.md", content);
  }

  readBuildLog(): string | undefined {
    return this.readFrom("build-log.md");
  }

  writeEvalReport(report: EvalReport): void {
    this.writeTo(`eval-reports/round-${report.round}.json`, JSON.stringify(report, null, 2));
  }

  readEvalReport(round: number): EvalReport | undefined {
    const raw = this.readFrom(`eval-reports/round-${round}.json`);
    return raw ? (JSON.parse(raw) as EvalReport) : undefined;
  }

  listEvalReports(): EvalReport[] {
    const dir = path.join(this.dir, "eval-reports");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("round-") && f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as EvalReport);
  }

  writeStatus(status: PipelineStatus): void {
    this.writeTo("status.json", JSON.stringify(status, null, 2));
  }

  readStatus(): PipelineStatus | undefined {
    const raw = this.readFrom("status.json");
    return raw ? (JSON.parse(raw) as PipelineStatus) : undefined;
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/unit/artifacts/store.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/artifacts/types.ts src/artifacts/store.ts tests/unit/artifacts/store.test.ts tests/fixtures/sample-eval-report.json
git commit -m "feat: artifact store for spec, contract, eval reports, pipeline status"
```

---

### Task 8: CLI Scaffolding + Models Commands

**Files:**
- Create: `src/cli.ts`
- Test: manual verification (CLI integration)

- [ ] **Step 1: Implement CLI entry point**

Create `src/cli.ts`:

```typescript
#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config/loader.js";
import { AuthProfileStore } from "./auth/profiles.js";
import { KeyRotator } from "./auth/rotation.js";
import { ProviderRegistry } from "./providers/registry.js";
import path from "node:path";
import os from "node:os";

const AUTH_PROFILES_PATH = path.join(os.homedir(), ".coding-studio", "auth-profiles.json");
const CONFIG_PATH = path.join(process.cwd(), ".coding-studio.yml");

const program = new Command();

program
  .name("coding-studio")
  .description("Harness-driven coding pipeline: Planner + Generator (Claude Code) + Evaluator")
  .version("0.1.0");

// --- models status ---
const modelsCmd = program.command("models").description("Manage model providers and credentials");

modelsCmd
  .command("status")
  .description("Check credential status for all configured providers")
  .action(() => {
    const store = new AuthProfileStore(AUTH_PROFILES_PATH);
    const profiles = store.listProfiles();

    if (profiles.length === 0) {
      console.log("No credentials configured. Run `coding-studio setup` to get started.");
      return;
    }

    console.log(
      "Provider".padEnd(14) +
        "Profile".padEnd(24) +
        "Type".padEnd(10) +
        "Status",
    );
    console.log("-".repeat(58));

    for (const { id, profile } of profiles) {
      let status = "OK";
      if (profile.type === "token" && profile.expires) {
        const expires = new Date(profile.expires);
        if (expires < new Date()) {
          status = "EXPIRED";
        } else {
          const daysLeft = Math.ceil((expires.getTime() - Date.now()) / 86_400_000);
          status = daysLeft <= 7 ? `Expires in ${daysLeft}d` : "OK";
        }
      }
      const mark = status === "OK" || status.startsWith("Expires") ? "\u2713" : "\u2717";
      console.log(
        `${profile.provider.padEnd(14)}${id.padEnd(24)}${profile.type.padEnd(10)}${mark} ${status}`,
      );
    }
  });

// --- models list ---
modelsCmd
  .command("list")
  .description("List available models from all providers")
  .option("-p, --provider <provider>", "Filter by provider")
  .action((opts) => {
    const registry = new ProviderRegistry();
    const models = registry.listModels(opts.provider);

    console.log(
      "Provider".padEnd(14) +
        "Model".padEnd(38) +
        "Context".padEnd(10) +
        "Cost (in/out $/M)",
    );
    console.log("-".repeat(80));

    for (const m of models) {
      console.log(
        `${m.provider.padEnd(14)}${m.id.padEnd(38)}${String(m.contextWindow).padEnd(10)}$${m.cost.input}/$${m.cost.output}`,
      );
    }
  });

// --- run (placeholder for Phase 4) ---
program
  .command("run <prompt>")
  .description("Run the coding pipeline")
  .option("-m, --mode <mode>", "Pipeline mode: solo | plan-build | final-qa | iterative-qa")
  .option("-i, --interactive", "Pause at key checkpoints for confirmation")
  .action((prompt, opts) => {
    console.log(`Pipeline mode: ${opts.mode ?? "from config"}`);
    console.log(`Interactive: ${opts.interactive ?? false}`);
    console.log(`Prompt: ${prompt}`);
    console.log("\n[Not yet implemented — see Phase 4]");
  });

// --- resume (placeholder for Phase 4) ---
program
  .command("resume")
  .description("Resume from the last checkpoint")
  .action(() => {
    console.log("[Not yet implemented — see Phase 4]");
  });

// --- setup (placeholder for Phase 1 Task 9) ---
program
  .command("setup")
  .description("Interactive credential setup")
  .action(() => {
    console.log("[Not yet implemented — see Task 9]");
  });

program.parse();
```

- [ ] **Step 2: Build and verify**

Run: `npx tsc`
Expected: No errors, `dist/cli.js` created.

Run: `node dist/cli.js --help`
Expected: Shows help with `run`, `resume`, `setup`, `models` commands.

Run: `node dist/cli.js models list --provider anthropic 2>/dev/null || echo "pi-ai may need API keys for full listing"`
Expected: Either lists models or shows empty (depends on pi-ai runtime behavior without keys).

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: CLI scaffolding with models status/list commands"
```

---

### Task 9: Auth Setup Interactive

**Files:**
- Create: `src/auth/setup.ts`
- Modify: `src/cli.ts` (wire up setup command)

- [ ] **Step 1: Implement setup wizard**

Create `src/auth/setup.ts`:

```typescript
import { select, input, password, confirm } from "@inquirer/prompts";
import { AuthProfileStore } from "./profiles.js";
import { ProviderRegistry } from "../providers/registry.js";

const KNOWN_PROVIDERS = [
  { name: "Anthropic", value: "anthropic" },
  { name: "OpenAI", value: "openai" },
  { name: "Google (Gemini)", value: "google" },
  { name: "xAI (Grok)", value: "xai" },
  { name: "Custom (OpenAI-compatible)", value: "custom" },
];

const AUTH_METHODS = [
  { name: "API Key (paste your key)", value: "api_key" },
  { name: "Setup Token (from claude setup-token)", value: "token" },
  { name: "Environment Variable (reference)", value: "env_ref" },
];

export async function runSetup(profilesPath: string): Promise<void> {
  console.log("\nWelcome to Coding Studio!\n");

  const store = new AuthProfileStore(profilesPath);
  let addMore = true;

  while (addMore) {
    const provider = await select({
      message: "Select a provider to configure:",
      choices: KNOWN_PROVIDERS,
    });

    const method = await select({
      message: `Auth method for ${provider}:`,
      choices: AUTH_METHODS,
    });

    const profileName = await input({
      message: "Profile name (e.g. main, backup):",
      default: "main",
    });

    const profileId = `${provider}:${profileName}`;

    if (method === "api_key") {
      const key = await password({
        message: `Paste your ${provider} API key:`,
      });
      store.addProfile(profileId, { type: "api_key", provider, key });
      console.log(`\u2713 Saved ${profileId} to auth-profiles.json`);
    } else if (method === "token") {
      const token = await password({
        message: `Paste your ${provider} setup token:`,
      });
      const expiresIn = await input({
        message: "Token expires (ISO date, or leave blank for no expiry):",
        default: "",
      });
      store.addProfile(profileId, {
        type: "token",
        provider,
        token,
        ...(expiresIn ? { expires: expiresIn } : {}),
      });
      console.log(`\u2713 Saved ${profileId} to auth-profiles.json`);
    } else if (method === "env_ref") {
      const envVar = await input({
        message: "Environment variable name:",
        default: `${provider.toUpperCase()}_API_KEY`,
      });
      const currentValue = process.env[envVar];
      if (currentValue) {
        store.addProfile(profileId, { type: "api_key", provider, key: currentValue });
        console.log(`\u2713 Resolved $${envVar} and saved ${profileId}`);
      } else {
        console.log(`\u2717 $${envVar} is not set. Skipping.`);
      }
    }

    addMore = await confirm({ message: "Add another provider?", default: false });
  }

  // Summary
  console.log("\nConfigured profiles:");
  const profiles = store.listProfiles();
  for (const { id, profile } of profiles) {
    const keyPreview = store.resolveKey(id);
    const masked = keyPreview ? keyPreview.slice(0, 8) + "..." : "N/A";
    console.log(`  ${profile.provider.padEnd(14)} ${id.padEnd(24)} ${profile.type.padEnd(10)} ${masked}`);
  }

  console.log("\nSetup complete! Run `coding-studio run \"your prompt\"` to start.\n");
}
```

- [ ] **Step 2: Wire setup command into CLI**

In `src/cli.ts`, replace the setup placeholder:

```typescript
// Replace the existing setup command block with:
import { runSetup } from "./auth/setup.js";

// ... (keep existing code, just change the setup .action):
program
  .command("setup")
  .description("Interactive credential setup")
  .action(async () => {
    await runSetup(AUTH_PROFILES_PATH);
  });
```

- [ ] **Step 3: Build and verify**

Run: `npx tsc`
Expected: No errors.

Run: `node dist/cli.js setup --help`
Expected: Shows "Interactive credential setup".

- [ ] **Step 4: Commit**

```bash
git add src/auth/setup.ts src/cli.ts
git commit -m "feat: interactive auth setup wizard with multi-provider support"
```

---

### Task 10: Run All Tests + Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (schema: 4, loader: 6, profiles: 9, rotation: 7, registry: 4, store: 8 = **38 tests**).

- [ ] **Step 2: Build check**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Manual smoke test**

Run: `node dist/cli.js --version`
Expected: `0.1.0`

Run: `node dist/cli.js models status`
Expected: "No credentials configured..." or table output.

- [ ] **Step 4: Commit all remaining changes**

```bash
git add -A
git commit -m "chore: Phase 1 complete — config, auth, providers, artifacts, CLI scaffold"
```

---

## Phase 2 Preview: Infrastructure

> Covered in a follow-up plan after Phase 1 is verified.

| Task | Module | Key Deliverable |
|------|--------|----------------|
| 11 | Runtime Manager | install/build/start/stop/healthcheck |
| 12 | Checkpoint Manager | git snapshot/restore, checkpoint metadata |
| 13 | Contract Manager | draft/review/revise cycle, contract schema |

## Phase 3 Preview: Agents

| Task | Module | Key Deliverable |
|------|--------|----------------|
| 14 | Generator | CC subprocess wrapper with auth injection |
| 15 | Planner | pi-agent-core Agent with spec generation |
| 16 | Evaluator | pi-agent-core Agent with pluggable strategies |

## Phase 4 Preview: Orchestration & CLI

| Task | Module | Key Deliverable |
|------|--------|----------------|
| 17 | Pipeline Modes | solo/plan-build/final-qa/iterative-qa definitions |
| 18 | Orchestrator | plan→contract→build→runtime→eval→loop |
| 19 | CLI Run + Resume | Full `run` and `resume` commands |
