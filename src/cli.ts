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
import { PlaywrightStrategy } from "./strategies/playwright.js";
import { CompositeStrategy } from "./strategies/composite.js";
import { isValidMode, type PipelineMode } from "./pipeline/modes.js";
import type { EvaluationStrategy } from "./strategies/types.js";
import { waitForConfirmation } from "./interactive.js";
import { CodingStudioTUI } from "./tui.js";
import fs from "node:fs";
import { ContractDrafterAgent } from "./agents/contract-drafter.js";
import path from "node:path";
import os from "node:os";

const AUTH_PATH = path.join(os.homedir(), ".coding-studio", "auth.json");
/** Always compute config path at call time — process.cwd() changes */
function getConfigPath(): string {
  return path.join(process.cwd(), ".coding-studio.yml");
}

function getStrategy(name: string, config: any): EvaluationStrategy {
  switch (name) {
    case "code-review": return new CodeReviewStrategy();
    case "test-runner": return new TestRunnerStrategy();
    case "playwright": return new PlaywrightStrategy(config?.playwright);
    case "composite": return new CompositeStrategy([
      new CodeReviewStrategy(),
      new TestRunnerStrategy(),
      new PlaywrightStrategy(config?.playwright),
    ]);
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
  .option("-f, --full-auto", "Run fully autonomously — model decides everything, no pauses")
  .option("--no-tui", "Disable TUI even when stdout is a TTY (plain output)")
  .action(async (prompt, opts) => {
    const config = loadConfig(getConfigPath());
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
        getStrategy(config.evaluation.strategy, config.evaluation),
        getApiKey,
        process.cwd(),
      ),
      contractDrafter: new ContractDrafterAgent(
        config.models.evaluator, // uses evaluator's model (GPT-5.4) for contract work
        getApiKey,
        process.cwd(),
      ),
      contractManager: new ContractManager(config.pipeline.contract, artifactsDir),
      runtimeManager: new RuntimeManager(config.runtime),
      checkpointManager: new CheckpointManager(config.generator.checkpoint, artifactsDir),
      artifactStore,
    };

    // -f (full-auto) overrides everything: no pauses, model decides all
    // -i (interactive) pauses at checkpoints
    // default: from config
    const isFullAuto = opts.fullAuto ?? false;
    const isInteractive = isFullAuto ? false : (opts.interactive ?? config.pipeline.interactive);

    // Use TUI when stdout is a TTY (and --no-tui not specified)
    const useTui = opts.tui !== false && process.stdout.isTTY;

    if (useTui) {
      // TUI mode: rich blessed terminal UI
      const tui = new CodingStudioTUI();
      tui.setRunning(true);
      tui.agentLog("system", `Starting pipeline: ${prompt}`);

      tui.setCommandHandler((cmd, _args) => {
        if (cmd === "abort" || cmd === "quit" || cmd === "exit") {
          tui.agentLog("system", "Aborting...");
          tui.destroy();
          process.exit(0);
        } else {
          tui.agentLog("system", `Command /${cmd} not available during run. Use /abort to stop.`);
        }
      });

      const orchestrator = new Orchestrator(deps, {
        mode,
        maxRounds: config.evaluation.maxRounds,
        interactive: isInteractive,
        cwd: process.cwd(),
        onPause: isInteractive
          ? async (reason) => {
              tui.agentLog("system", `Paused: ${reason}. Press Enter to continue or type abort.`);
              const response = await tui.waitForInput();
              return response.toLowerCase() !== "abort";
            }
          : undefined,
      });

      orchestrator.onEvent((event) => tui.handleOrchestratorEvent(event));

      try {
        await orchestrator.run(prompt);
      } catch (err: any) {
        tui.agentLog("system", `Pipeline failed: ${err.message}`);
        tui.agentLog("system", "Pipeline stopped.");
      } finally {
        tui.setRunning(false);
        // Keep TUI alive so user can read results; Ctrl+C to exit
        tui.agentLog("system", "Done. Press Ctrl+C to exit.");
      }
      return;
    }

    // Plain output mode (piped / --no-tui)
    if (isFullAuto) {
      console.log("[Full-Auto Mode] Pipeline will run autonomously. Model decides everything.\n");
    }

    const orchestrator = new Orchestrator(deps, {
      mode,
      maxRounds: config.evaluation.maxRounds,
      interactive: isInteractive,
      cwd: process.cwd(),
      onPause: isInteractive ? waitForConfirmation : undefined,
    });

    // ANSI colors
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
    const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
    const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
    const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
    const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
    const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
    const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

    let currentAgent = "";

    orchestrator.onEvent((event) => {
      switch (event.type) {
        case "phase":
          process.stdout.write(`\n${bold(`--- ${event.phase.toUpperCase()} ---`)}\n`);
          currentAgent = "";
          break;

        case "round":
          process.stdout.write(`\n${bold(yellow(`=== Round ${event.round} ===`))}\n`);
          break;

        case "log":
          process.stdout.write(`${dim(event.message)}\n`);
          break;

        case "agent_text": {
          // Show agent label on first output
          if (currentAgent !== event.agent) {
            currentAgent = event.agent;
            const label = event.agent === "planner" ? cyan("Planner")
              : event.agent === "generator" ? yellow("Generator (CC)")
              : magenta("Evaluator");
            process.stdout.write(`\n${bold(label)}:\n`);
          }
          process.stdout.write(event.delta);
          break;
        }

        case "tool_use": {
          if (event.status === "start") {
            const argsPreview = event.args ? dim(` ${event.args.slice(0, 80)}`) : "";
            process.stdout.write(`\n  ${cyan(">")} ${bold(event.tool)}${argsPreview}\n`);
          } else {
            const resultPreview = event.result ? dim(`  ${event.result.slice(0, 120)}`) : "";
            if (resultPreview) process.stdout.write(`${resultPreview}\n`);
          }
          break;
        }

        case "eval": {
          const v = event.report.verdict === "pass" ? green("PASS") : red("FAIL");
          process.stdout.write(`\n${bold("Eval Result")}: ${v} (${event.report.overallScore.toFixed(1)}/10)\n`);
          for (const s of event.report.scores) {
            const bar = s.score >= 7 ? green(`${s.score}`) : s.score >= 5 ? yellow(`${s.score}`) : red(`${s.score}`);
            process.stdout.write(`  ${s.name.padEnd(18)} ${bar}/10  ${dim(s.feedback.slice(0, 60))}\n`);
          }
          if (event.report.blockers.length > 0) {
            process.stdout.write(`${red("Blockers:")}\n`);
            for (const b of event.report.blockers) {
              process.stdout.write(`  ${red(`[${b.severity}]`)} ${b.description}\n`);
            }
          }
          if (event.report.bugs.length > 0) {
            process.stdout.write(`${yellow("Bugs:")}\n`);
            for (const bug of event.report.bugs.slice(0, 5)) {
              const loc = bug.location ? dim(` (${bug.location})`) : "";
              process.stdout.write(`  ${yellow(`[${bug.severity}]`)}${loc} ${bug.description}\n`);
            }
          }
          break;
        }

        case "pause":
          process.stdout.write(`\n${yellow("[PAUSE]")} ${event.reason}\n`);
          break;

        case "complete": {
          const h = event.status.history;
          const lastScore = h.length > 0 ? h[h.length - 1].score?.toFixed(1) ?? "N/A" : "N/A";
          const totalTime = h.reduce((s, r) => s + r.buildDuration + (r.evalDuration ?? 0), 0);
          process.stdout.write(`\n${green("✓")} ${bold("Pipeline complete")} (${event.status.mode}, ${h.length} rounds, ${totalTime.toFixed(0)}s, score: ${lastScore})\n`);
          break;
        }
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
  .description("Show resume info: pipeline status, last eval, and restore instructions")
  .action(() => {
    const config = loadConfig(getConfigPath());
    const artifactsDir = path.resolve(process.cwd(), config.pipeline.artifactsDir);
    const artifactStore = new ArtifactStore(artifactsDir);
    const checkpointMgr = new CheckpointManager(config.generator.checkpoint, artifactsDir);

    // Pipeline status
    const pipelineStatus = artifactStore.readStatus();
    if (pipelineStatus) {
      console.log("\n--- Pipeline Status ---");
      console.log(`Phase:   ${pipelineStatus.phase}`);
      console.log(`Mode:    ${pipelineStatus.mode}`);
      console.log(`Rounds:  ${pipelineStatus.currentRound} / ${pipelineStatus.maxRounds}`);
      if (pipelineStatus.history.length > 0) {
        console.log("History:");
        for (const h of pipelineStatus.history) {
          const verdict = h.verdict ? ` [${h.verdict}]` : "";
          const score = h.score !== undefined ? ` score=${h.score.toFixed(1)}` : "";
          console.log(`  Round ${h.round}:${verdict}${score} build=${h.buildDuration.toFixed(0)}s`);
        }
      }
    } else {
      console.log("No pipeline status found.");
    }

    // Last eval report summary
    const evalReports = artifactStore.listEvalReports();
    if (evalReports.length > 0) {
      const last = evalReports[evalReports.length - 1];
      console.log("\n--- Last Eval Report (round " + last.round + ") ---");
      console.log(`Verdict: ${last.verdict}  Score: ${last.overallScore.toFixed(1)}/10`);
      console.log(`Summary: ${last.summary}`);
      if (last.blockers.length > 0) {
        console.log("Blockers:");
        for (const b of last.blockers) {
          console.log(`  [${b.severity}] ${b.description}`);
        }
      }
    }

    // Checkpoint / restore info
    const latest = checkpointMgr.getLatest();
    if (!latest) {
      console.log("\nNo checkpoints found.");
      return;
    }

    console.log("\n--- Latest Checkpoint ---");
    console.log(`Round:       ${latest.round}`);
    console.log(`Timestamp:   ${latest.timestamp}`);
    console.log(`Description: ${latest.description}`);
    if (latest.gitRef) {
      console.log(`Git ref:     ${latest.gitRef}`);
      console.log("\nTo restore to this checkpoint, run:");
      console.log("  git reset --hard " + latest.gitRef);
    }
  });

// --- setup ---
program
  .command("setup")
  .description("Interactive credential setup")
  .action(async () => {
    const authStorage = AuthStorage.create(AUTH_PATH);
    await runSetup(authStorage);
  });

// --- tui (default interactive mode) ---
program
  .command("tui", { isDefault: true })
  .description("Interactive terminal UI (default when no subcommand given)")
  .action(async () => {
    const tui = new CodingStudioTUI();

    tui.agentLog("system", "Welcome to Coding Studio!");
    tui.agentLog(
      "system",
      "Commands: /run <prompt>  /agent  /status  /abort  /quit",
    );
    tui.agentLog("system", "Plain text is queued as steering for the pipeline.");

    let currentOrchestrator: Orchestrator | null = null;

    tui.setCommandHandler(async (cmd, args) => {
      switch (cmd) {
        case "run": {
          if (!args.trim()) {
            tui.agentLog("system", "Usage: /run <prompt>");
            return;
          }
          if (tui.isRunning()) {
            tui.agentLog("system", "Pipeline already running. Use /abort first.");
            return;
          }

          tui.setRunning(true);
          tui.agentLog("system", "Starting pipeline...");

          // Must compute config path at runtime (not module load time)
          // because cwd matters and getConfigPath() is stale
          const config = loadConfig(getConfigPath());
          tui.agentLog("system", `${config.models.planner.provider}/${config.models.planner.model} | cwd: ${process.cwd()}`);
          const authStorage = AuthStorage.create(AUTH_PATH);
          const rotator = new KeyRotator(authStorage);
          const getApiKey = (provider: string) =>
            rotator.resolveKeyForProvider(provider);

          const mode: PipelineMode =
            config.pipeline.mode && isValidMode(config.pipeline.mode)
              ? config.pipeline.mode
              : "iterative-qa";

          const artifactsDir = path.resolve(
            process.cwd(),
            config.pipeline.artifactsDir,
          );
          const artifactStore = new ArtifactStore(artifactsDir);

          const deps: OrchestratorDeps = {
            planner: new Planner(
              config.planner,
              config.models.planner,
              getApiKey,
            ),
            generator: new Generator(config.generator),
            evaluator: new Evaluator(
              {
                criteria: config.evaluation.criteria,
                passRules: config.evaluation.passRules,
              },
              config.models.evaluator,
              getStrategy(config.evaluation.strategy, config.evaluation),
              getApiKey,
              process.cwd(),
            ),
            contractDrafter: new ContractDrafterAgent(
              config.models.evaluator,
              getApiKey,
              process.cwd(),
            ),
            contractManager: new ContractManager(
              config.pipeline.contract,
              artifactsDir,
            ),
            runtimeManager: new RuntimeManager(config.runtime),
            checkpointManager: new CheckpointManager(
              config.generator.checkpoint,
              artifactsDir,
            ),
            artifactStore,
          };

          // TUI default: full-auto (no pauses). User can type feedback anytime.
          const orch = new Orchestrator(deps, {
            mode,
            maxRounds: config.evaluation.maxRounds,
            interactive: false,
            cwd: process.cwd(),
          });

          currentOrchestrator = orch;
          orch.onEvent((event) => tui.handleOrchestratorEvent(event));

          orch
            .run(args.trim())
            .catch((err: Error) => {
              tui.agentLog("system", `Pipeline error: ${err.message}`);
              tui.agentLog("system", "Pipeline stopped.");
            })
            .finally(() => {
              tui.setRunning(false);
              currentOrchestrator = null;
            });
          break;
        }

        case "agent": {
          // Spawn interactive claude CLI — destroys TUI, exits after claude returns
          await tui.spawnAgent();
          process.exit(0);
        }

        case "status": {
          const config = loadConfig(getConfigPath());
          const artifactsDir = path.resolve(
            process.cwd(),
            config.pipeline.artifactsDir,
          );
          const artifactStore = new ArtifactStore(artifactsDir);
          const pipelineStatus = artifactStore.readStatus();
          if (pipelineStatus) {
            tui.agentLog(
              "system",
              `Phase: ${pipelineStatus.phase} | Mode: ${pipelineStatus.mode} | Round: ${pipelineStatus.currentRound}/${pipelineStatus.maxRounds}`,
            );
            if (pipelineStatus.history.length > 0) {
              for (const h of pipelineStatus.history) {
                const verdict = h.verdict ? ` [${h.verdict}]` : "";
                const score =
                  h.score !== undefined ? ` score=${h.score.toFixed(1)}` : "";
                tui.agentLog(
                  "system",
                  `  Round ${h.round}:${verdict}${score} build=${h.buildDuration.toFixed(0)}s`,
                );
              }
            }
          } else {
            tui.agentLog("system", "No pipeline status found.");
          }
          break;
        }

        case "abort": {
          if (!tui.isRunning()) {
            tui.agentLog("system", "No pipeline running.");
          } else {
            tui.agentLog("system", "Abort requested. (Pipeline will stop at next pause.)");
            tui.setRunning(false);
            currentOrchestrator = null;
          }
          break;
        }

        case "quit":
        case "exit": {
          tui.destroy();
          process.exit(0);
        }

        default:
          tui.agentLog(
            "system",
            `Unknown command: /${cmd}. Try /run, /agent, /status, /abort, /quit`,
          );
      }
    });
  });

program.parse();
