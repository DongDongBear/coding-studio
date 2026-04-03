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

// --- setup (stub for Task 9) ---
program
  .command("setup")
  .description("Interactive credential setup")
  .action(() => {
    console.log("[Not yet implemented — see Task 9]");
  });

program.parse();
