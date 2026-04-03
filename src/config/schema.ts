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
