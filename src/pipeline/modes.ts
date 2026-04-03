export type PipelineMode = "solo" | "plan-build" | "final-qa" | "iterative-qa";

export interface PipelineSteps {
  plan: boolean;
  contract: boolean;
  build: boolean;
  selfReview: boolean;
  runtime: boolean;
  eval: boolean;
  iterateOnFail: boolean;
}

const MODE_DEFINITIONS: Record<PipelineMode, PipelineSteps> = {
  solo: {
    plan: false,
    contract: false,
    build: true,
    selfReview: false,
    runtime: false,
    eval: false,
    iterateOnFail: false,
  },
  "plan-build": {
    plan: true,
    contract: false,
    build: true,
    selfReview: true,
    runtime: false,
    eval: false,
    iterateOnFail: false,
  },
  "final-qa": {
    plan: true,
    contract: false,
    build: true,
    selfReview: true,
    runtime: true,
    eval: true,
    iterateOnFail: false,
  },
  "iterative-qa": {
    plan: true,
    contract: true,
    build: true,
    selfReview: true,
    runtime: true,
    eval: true,
    iterateOnFail: true,
  },
};

export function getStepsForMode(mode: PipelineMode): PipelineSteps {
  return { ...MODE_DEFINITIONS[mode] };
}

export function isValidMode(mode: string): mode is PipelineMode {
  return mode in MODE_DEFINITIONS;
}

export function getAllModes(): PipelineMode[] {
  return Object.keys(MODE_DEFINITIONS) as PipelineMode[];
}
