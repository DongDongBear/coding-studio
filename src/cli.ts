#!/usr/bin/env node

import { Command } from "commander";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { ProviderRegistry } from "./providers/registry.js";
import { runSetup } from "./auth/setup.js";
import { loadConfig } from "./config/loader.js";
import { KeyRotator } from "./auth/rotation.js";
import { ArtifactStore } from "./artifacts/store.js";
import { Orchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { Planner } from "./agents/planner.js";
import { Generator } from "./agents/generator.js";
import { Evaluator } from "./agents/evaluator.js";
import { ContractManager } from "./contracts/manager.js";
import { RuntimeManager } from "./runtime/manager.js";
import { CheckpointManager } from "./checkpoints/manager.js";
import { CodeReviewStrategy } from "./strategies/code-review.js";
import { TestRunnerStrategy } from "./strategies/test-runner.js";
import { isValidMode, type PipelineMode } from "./pipeline/modes.js";
import type { EvaluationStrategy } from "./strategies/types.js";
import path from "node:path";
import os from "node:os";

const AUTH_PATH = path.join(os.homedir(), ".coding-studio", "auth.json");
const CONFIG_PATH = path.join(process.cwd(), ".coding-studio.yml");

function getStrategy(name: string): EvaluationStrategy {
  switch (name) {
    case "code-review": return new CodeReviewStrategy();
    case "test-runner": return new TestRunnerStrategy();
    case "composite": return new CodeReviewStrategy(); // TODO: implement CompositeStrategy
    case "playwright": return new CodeReviewStrategy(); // TODO: implement PlaywrightStrategy
    default: return new CodeReviewStrategy();
  }
}

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

// --- run ---
program
  .command("run <prompt>")
  .description("Run the coding pipeline")
  .option("-m, --mode <mode>", "Pipeline mode: solo | plan-build | final-qa | iterative-qa")
  .option("-i, --interactive", "Pause at key checkpoints for confirmation")
  .action(async (prompt, opts) => {
    const config = loadConfig(CONFIG_PATH);
    const authStorage = AuthStorage.create(AUTH_PATH);
    const rotator = new KeyRotator(authStorage);
    const getApiKey = (provider: string) => rotator.resolveKeyForProvider(provider);

    const mode: PipelineMode = opts.mode && isValidMode(opts.mode)
      ? opts.mode
      : config.pipeline.mode;

    const artifactsDir = path.resolve(process.cwd(), config.pipeline.artifactsDir);
    const artifactStore = new ArtifactStore(artifactsDir);

    const deps: OrchestratorDeps = {
      planner: new Planner(config.planner, config.models.planner, getApiKey),
      generator: new Generator(config.generator),
      evaluator: new Evaluator(
        { criteria: config.evaluation.criteria, passRules: config.evaluation.passRules },
        config.models.evaluator,
        getStrategy(config.evaluation.strategy),
        getApiKey,
      ),
      contractManager: new ContractManager(config.pipeline.contract, artifactsDir),
      runtimeManager: new RuntimeManager(config.runtime),
      checkpointManager: new CheckpointManager(config.generator.checkpoint, artifactsDir),
      artifactStore,
    };

    const orchestrator = new Orchestrator(deps, {
      mode,
      maxRounds: config.evaluation.maxRounds,
      interactive: opts.interactive ?? config.pipeline.interactive,
      cwd: process.cwd(),
    });

    orchestrator.onEvent((event) => {
      switch (event.type) {
        case "phase":
          console.log(`\n--- Phase: ${event.phase} ---`);
          break;
        case "round":
          console.log(`\n=== Round ${event.round} ===`);
          break;
        case "log":
          console.log(event.message);
          break;
        case "eval":
          console.log(`\nEval: ${event.report.verdict} (${event.report.overallScore.toFixed(1)}/10)`);
          if (event.report.blockers.length > 0) {
            console.log("Blockers:");
            for (const b of event.report.blockers) {
              console.log(`  [${b.severity}] ${b.description}`);
            }
          }
          break;
        case "pause":
          console.log(`\n[PAUSE] ${event.reason}`);
          // TODO: in interactive mode, wait for user input
          break;
        case "complete":
          console.log(`\n✓ Pipeline complete (${event.status.mode}, ${event.status.history.length} rounds)`);
          break;
      }
    });

    try {
      await orchestrator.run(prompt);
    } catch (err: any) {
      console.error(`\n✗ Pipeline failed: ${err.message}`);
      process.exit(1);
    }
  });

// --- resume ---
program
  .command("resume")
  .description("Resume from the last checkpoint")
  .action(() => {
    const config = loadConfig(CONFIG_PATH);
    const artifactsDir = path.resolve(process.cwd(), config.pipeline.artifactsDir);
    const checkpointMgr = new CheckpointManager(config.generator.checkpoint, artifactsDir);
    const latest = checkpointMgr.getLatest();

    if (!latest) {
      console.log("No checkpoints found. Nothing to resume.");
      return;
    }

    console.log(`Latest checkpoint: round ${latest.round} (${latest.timestamp})`);
    console.log(`Git ref: ${latest.gitRef}`);
    console.log(`Description: ${latest.description}`);
    console.log("\nTo restore, run: git reset --hard " + latest.gitRef);
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
