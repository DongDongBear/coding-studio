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
