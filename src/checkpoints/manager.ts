import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface CheckpointMeta {
  id: string;
  round: number;
  timestamp: string;
  gitRef: string;
  description: string;
}

export interface CheckpointConfig {
  enabled: boolean;
  strategy: "git-commit" | "diff-snapshot";
  everyRound: boolean;
}

export class CheckpointManager {
  private config: CheckpointConfig;
  private artifactsDir: string;

  constructor(config: CheckpointConfig, artifactsDir: string) {
    this.config = config;
    this.artifactsDir = artifactsDir;
  }

  /** Create a checkpoint by committing current state */
  create(cwd: string, round: number, description: string): CheckpointMeta {
    if (!this.config.enabled) {
      throw new Error("Checkpoints are disabled");
    }

    // Stage all changes
    execSync("git add -A", { cwd, stdio: "pipe" });

    // Check if there are staged changes
    try {
      execSync("git diff --cached --quiet", { cwd, stdio: "pipe" });
      // No changes — still create metadata but skip commit
      const gitRef = execSync("git rev-parse HEAD", { cwd, stdio: "pipe" }).toString().trim();
      return this.saveMeta(round, gitRef, description);
    } catch {
      // There are staged changes — commit them
    }

    const message = `checkpoint: round ${round} — ${description}`;
    execSync("git commit -m " + JSON.stringify(message), { cwd, stdio: "pipe" });
    const gitRef = execSync("git rev-parse HEAD", { cwd, stdio: "pipe" }).toString().trim();

    return this.saveMeta(round, gitRef, description);
  }

  /** Restore to a specific checkpoint */
  restore(cwd: string, checkpointId: string): void {
    const meta = this.loadMeta(checkpointId);
    if (!meta) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }
    execSync(`git reset --hard ${meta.gitRef}`, { cwd, stdio: "pipe" });
  }

  /** Get the latest checkpoint */
  getLatest(): CheckpointMeta | undefined {
    const all = this.listAll();
    return all.length > 0 ? all[all.length - 1] : undefined;
  }

  /** List all checkpoints sorted by round */
  listAll(): CheckpointMeta[] {
    const dir = path.join(this.artifactsDir, "checkpoints");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as CheckpointMeta)
      .sort((a, b) => a.round - b.round);
  }

  private saveMeta(round: number, gitRef: string, description: string): CheckpointMeta {
    const meta: CheckpointMeta = {
      id: `checkpoint-round-${round}`,
      round,
      timestamp: new Date().toISOString(),
      gitRef,
      description,
    };
    const dir = path.join(this.artifactsDir, "checkpoints");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(dir, `round-${round}.json`),
      JSON.stringify(meta, null, 2),
      "utf-8"
    );
    return meta;
  }

  private loadMeta(checkpointId: string): CheckpointMeta | undefined {
    const all = this.listAll();
    return all.find(c => c.id === checkpointId);
  }
}
