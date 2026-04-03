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

  writeStatus(status: PipelineStatus): void {
    this.writeTo("status.json", JSON.stringify(status, null, 2));
  }

  readStatus(): PipelineStatus | undefined {
    const raw = this.readFrom("status.json");
    return raw ? (JSON.parse(raw) as PipelineStatus) : undefined;
  }
}
