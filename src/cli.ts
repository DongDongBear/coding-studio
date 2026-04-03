#!/usr/bin/env node

import { Command } from "commander";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { ProviderRegistry } from "./providers/registry.js";
import { runSetup } from "./auth/setup.js";
import path from "node:path";
import os from "node:os";

const AUTH_PATH = path.join(os.homedir(), ".coding-studio", "auth.json");

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
  .action(async () => {
    const authStorage = AuthStorage.create(AUTH_PATH);
    const all = authStorage.getAll();
    const providers = Object.keys(all);

    if (providers.length === 0) {
      console.log("No credentials configured. Run `coding-studio setup` to get started.");
      return;
    }

    console.log(
      "Provider".padEnd(14) +
        "Type".padEnd(12) +
        "Status",
    );
    console.log("-".repeat(40));

    for (const provider of providers) {
      const cred = all[provider];
      const key = await authStorage.getApiKey(provider);
      const status = key ? "OK" : "FAILED";
      const mark = key ? "\u2713" : "\u2717";
      console.log(
        `${provider.padEnd(14)}${cred.type.padEnd(12)}${mark} ${status}`,
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

// --- run (stub for Phase 4) ---
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

// --- resume (stub for Phase 4) ---
program
  .command("resume")
  .description("Resume from the last checkpoint")
  .action(() => {
    console.log("[Not yet implemented — see Phase 4]");
  });

// --- setup ---
program
  .command("setup")
  .description("Interactive credential setup")
  .action(async () => {
    const authStorage = AuthStorage.create(AUTH_PATH);
    await runSetup(authStorage);
  });

program.parse();
