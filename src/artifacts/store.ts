import fs from "node:fs";
import path from "node:path";
import type { EvalReport, PipelineStatus, RuntimeState } from "./types.js";

export class ArtifactStore {
  private dir: string;

  constructor(artifactsDir: string) {
    this.dir = artifactsDir;
    this.ensureGitignore();
  }

  /** Ensure .coding-studio/ is in .gitignore */
  private ensureGitignore(): void {
    const projectRoot = path.dirname(this.dir);
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const entry = path.basename(this.dir) + "/";
    try {
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, "utf-8");
        if (!content.includes(entry)) {
          fs.appendFileSync(gitignorePath, `\n${entry}\n`);
        }
      } else {
        fs.writeFileSync(gitignorePath, `${entry}\n`);
      }
    } catch {
      // Non-critical — skip silently
    }
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
    const parentDir = path.dirname(relativePath);
    this.ensureDir(parentDir === "." ? undefined : parentDir);
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

  writeRuntimeState(state: RuntimeState): void {
    this.writeTo("runtime.json", JSON.stringify(state, null, 2));
  }

  readRuntimeState(): RuntimeState | undefined {
    const raw = this.readFrom("runtime.json");
    return raw ? (JSON.parse(raw) as RuntimeState) : undefined;
  }

  writeStatus(status: PipelineStatus): void {
    this.writeTo("status.json", JSON.stringify(status, null, 2));
  }

  readStatus(): PipelineStatus | undefined {
    const raw = this.readFrom("status.json");
    return raw ? (JSON.parse(raw) as PipelineStatus) : undefined;
  }

  // ── Session index (for resume selection) ──

  saveSession(prompt: string, status: PipelineStatus): void {
    const sessions = this.listSessions();
    const existing = sessions.findIndex((s) => s.id === status.mode + "-" + sessions.length);
    const entry = {
      id: `session-${Date.now()}`,
      prompt: prompt.slice(0, 100),
      startedAt: new Date().toISOString(),
      phase: status.phase,
      rounds: status.history.length,
      lastScore: status.history.length > 0
        ? status.history[status.history.length - 1].score ?? null
        : null,
      mode: status.mode,
    };

    // Update existing or add new
    const idx = sessions.findIndex((s) => s.prompt === entry.prompt && s.phase !== "completed" && s.phase !== "failed");
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx], ...entry, id: sessions[idx].id };
    } else {
      sessions.unshift(entry);
    }

    this.writeTo("sessions.json", JSON.stringify(sessions.slice(0, 20), null, 2));
  }

  listSessions(): Array<{
    id: string;
    prompt: string;
    startedAt: string;
    phase: string;
    rounds: number;
    lastScore: number | null;
    mode: string;
  }> {
    const raw = this.readFrom("sessions.json");
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }
}
