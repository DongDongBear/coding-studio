import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, getModel } from "@mariozechner/pi-ai";
import { subscribeWithStreaming, type AgentStreamEvent } from "./streaming.js";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface ContractDrafterConfig {
  provider: string;
  model: string;
}

/** Lightweight agent for contract drafting/revision using pi-agent-core with file tools */
export class ContractDrafterAgent {
  private config: ContractDrafterConfig;
  private getApiKey: (provider: string) => Promise<string | undefined>;
  private cwd: string;

  constructor(config: ContractDrafterConfig, getApiKey: (provider: string) => Promise<string | undefined>, cwd: string) {
    this.config = config;
    this.getApiKey = getApiKey;
    this.cwd = cwd;
  }

  private getTools(): AgentTool[] {
    const cwd = this.cwd;

    return [
      {
        name: "read_file",
        label: "Read File",
        description: "Read a file from the project.",
        parameters: Type.Object({
          path: Type.String({ description: "Relative file path" }),
        }),
        execute: async (_id: string, params: any) => {
          try {
            const content = fs.readFileSync(path.resolve(cwd, params.path), "utf-8");
            return { content: [{ type: "text" as const, text: content.slice(0, 8000) }], details: {} };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], details: {} };
          }
        },
      },
      {
        name: "list_files",
        label: "List Files",
        description: "List files in the project.",
        parameters: Type.Object({
          path: Type.Optional(Type.String({ description: "Relative directory (default: root)" })),
          recursive: Type.Optional(Type.Boolean({ description: "Recursive listing" })),
        }),
        execute: async (_id: string, params: any) => {
          try {
            const dir = path.resolve(cwd, params.path ?? ".");
            const cmd = params.recursive
              ? `find "${dir}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | head -100`
              : `ls -la "${dir}"`;
            const output = execSync(cmd, { cwd, stdio: "pipe", timeout: 10000 }).toString();
            return { content: [{ type: "text" as const, text: output }], details: {} };
          } catch (err: any) {
            return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], details: {} };
          }
        },
      },
    ];
  }

  private async runAgent(systemPrompt: string, userPrompt: string, onEvent?: (e: AgentStreamEvent) => void): Promise<string> {
    const model = getModel(this.config.provider as any, this.config.model as any);

    const agent = new Agent({
      initialState: {
        model,
        systemPrompt,
        tools: this.getTools(),
      },
      getApiKey: this.getApiKey,
    });

    const { getResult } = subscribeWithStreaming(agent, onEvent);
    await agent.prompt(userPrompt);

    const result = getResult();
    if (!result.trim()) {
      throw new Error("Contract agent returned empty response.");
    }
    return result;
  }

  async draftContract(spec: string, onEvent?: (e: AgentStreamEvent) => void): Promise<string> {
    return this.runAgent(
      [
        "You are drafting an acceptance contract for a software project.",
        "You have access to the project's file system to understand its current state.",
        "First read the project structure and key files, then draft a contract containing:",
        "- **Scope**: what this build delivers",
        "- **Non-goals**: what is out of scope",
        "- **Acceptance Criteria**: specific, testable conditions",
        "- **Test Plan**: key interactions and states to verify",
        "",
        "Be specific. Each criterion should describe observable behavior.",
        "Output the contract in markdown after reviewing the codebase.",
      ].join("\n"),
      `Draft an acceptance contract for this specification:\n\n${spec}`,
      onEvent,
    );
  }

  async reviseContract(draft: string, feedback: string, onEvent?: (e: AgentStreamEvent) => void): Promise<string> {
    return this.runAgent(
      [
        "You are revising an acceptance contract based on reviewer feedback.",
        "You can read project files to verify feasibility.",
        "Output ONLY the revised contract in markdown.",
      ].join("\n"),
      `# Current Contract\n\n${draft}\n\n# Reviewer Feedback\n\n${feedback}`,
      onEvent,
    );
  }
}
