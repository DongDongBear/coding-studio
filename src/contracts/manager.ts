import fs from "node:fs";
import path from "node:path";

export interface ContractConfig {
  enabled: boolean;
  maxRevisions: number;
}

export interface ContractReview {
  approved: boolean;
  feedback: string;
}

/**
 * ContractManager coordinates the contract handshake between Generator and Evaluator.
 * It doesn't call LLMs directly — it manages the file-based protocol.
 * The Orchestrator will pass in the actual drafted/reviewed content from the agents.
 */
export class ContractManager {
  private config: ContractConfig;
  private artifactsDir: string;
  private revisionCount: number = 0;

  constructor(config: ContractConfig, artifactsDir: string) {
    this.config = config;
    this.artifactsDir = artifactsDir;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Save a contract draft from the Generator */
  saveDraft(content: string): void {
    this.writeFile("contract-draft.md", content);
  }

  /** Read the current draft */
  readDraft(): string | undefined {
    return this.readFile("contract-draft.md");
  }

  /** Save review feedback from the Evaluator */
  saveReview(review: ContractReview): void {
    this.writeFile("contract-review.json", JSON.stringify(review, null, 2));
  }

  /** Read the latest review */
  readReview(): ContractReview | undefined {
    const raw = this.readFile("contract-review.json");
    return raw ? (JSON.parse(raw) as ContractReview) : undefined;
  }

  /** Finalize the contract (copy draft to contract.md) */
  finalize(): void {
    const draft = this.readDraft();
    if (!draft) {
      throw new Error("No contract draft to finalize");
    }
    this.writeFile("contract.md", draft);
  }

  /** Read the finalized contract */
  readContract(): string | undefined {
    return this.readFile("contract.md");
  }

  /** Check if more revisions are allowed */
  canRevise(): boolean {
    return this.revisionCount < this.config.maxRevisions;
  }

  /** Record a revision attempt */
  recordRevision(): void {
    this.revisionCount++;
  }

  /** Get current revision count */
  getRevisionCount(): number {
    return this.revisionCount;
  }

  /** Reset for a new round (in iterative-qa mode) */
  reset(): void {
    this.revisionCount = 0;
  }

  private writeFile(name: string, content: string): void {
    const dir = this.artifactsDir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dir, name), content, "utf-8");
  }

  private readFile(name: string): string | undefined {
    const fullPath = path.join(this.artifactsDir, name);
    if (!fs.existsSync(fullPath)) return undefined;
    return fs.readFileSync(fullPath, "utf-8");
  }
}
