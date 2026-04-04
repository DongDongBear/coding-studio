import readline from "node:readline";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OrchestratorEvent } from "./orchestrator.js";

// ── ANSI helpers ──

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const FG = {
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  white: "\x1b[37m", gray: "\x1b[90m",
} as const;

function c(fg: keyof typeof FG, text: string, bold = false): string {
  return `${bold ? BOLD : ""}${FG[fg]}${text}${RESET}`;
}

// ── Pixel-art pets ──

const AGENTS: Record<string, { icon: string; color: keyof typeof FG; label: string }> = {
  planner:   { icon: "⊙ω⊙",  color: "cyan",    label: "Planner" },
  generator: { icon: "[▓▓]",  color: "yellow",  label: "Generator" },
  evaluator: { icon: "◉‿◉",  color: "magenta", label: "Evaluator" },
  user:      { icon: "◕‿◕",  color: "green",   label: "You" },
  system:    { icon: "⚙",    color: "blue",    label: "System" },
};

const PHASE_ICONS: Record<string, string> = {
  planning: "⊙ω⊙", contracting: "✍ ", building: "[▓▓]",
  running: "▶▶ ", evaluating: "◉‿◉",
};

function stars(score: number): string {
  const full = Math.floor(score / 2);
  const half = score % 2 >= 1 ? 1 : 0;
  const empty = 5 - full - half;
  return `${FG.yellow}${"★".repeat(full)}${"☆".repeat(half)}${RESET}${DIM}${"·".repeat(empty)}${RESET}`;
}

// ── TUI (stdout + readline, no blessed) ──

export class CodingStudioTUI {
  private rl: readline.Interface;
  private userMessages: string[] = [];
  private textBuffer = "";
  private lastAgent = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private onCommand?: (cmd: string, args: string) => void;
  private inputResolver: ((value: string) => void) | null = null;
  private startTime = 0;
  private currentPhase = "";
  private currentRound = 0;
  private decisions: Array<{ time: string; phase: string; reason: string; action: string; auto: boolean }> = [];
  private promptVisible = false;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.rl.on("line", (line) => {
      this.promptVisible = false;
      this.handleInput(line.trim());
      this.showPrompt();
    });

    this.rl.on("close", () => process.exit(0));

    // Welcome
    console.log("");
    console.log(`  ${c("cyan", "┌─────────────────────────────────────┐", true)}`);
    console.log(`  ${c("cyan", "│", true)}  ${c("cyan", "⊙ω⊙", true)} ${BOLD}Coding Studio${RESET}              ${c("cyan", "│", true)}`);
    console.log(`  ${c("cyan", "│", true)}  ${DIM}Plan → Contract → Build → Eval${RESET}   ${c("cyan", "│", true)}`);
    console.log(`  ${c("cyan", "└─────────────────────────────────────┘", true)}`);
    console.log(`  ${DIM}Type your prompt, or /run  |  /agent /resume /quit${RESET}`);
    console.log("");

    this.showPrompt();
  }

  // ── Output (straight to stdout — native scroll + selection) ──

  /**
   * Write a line to stdout.
   * Mimics ink's <Static> pattern: clear the dynamic prompt area,
   * write permanent content, then redraw the prompt at the bottom.
   */
  private out(text: string): void {
    if (this.promptVisible) {
      // Erase the prompt line so output appears cleanly above it
      readline.moveCursor(process.stdout, 0, 0);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    // Write the permanent line (goes into terminal scrollback)
    process.stdout.write(text + "\n");
    // Immediately redraw prompt below the new output
    this.showPrompt();
  }

  private showPrompt(): void {
    const prefix = this.running
      ? `${FG.yellow}${BOLD}⚡${RESET} `
      : `${FG.cyan}${BOLD}❯${RESET} `;
    this.rl.setPrompt(prefix);
    this.rl.prompt(true);
    this.promptVisible = true;
  }

  // ── Public API ──

  setCommandHandler(handler: (cmd: string, args: string) => void): void {
    this.onCommand = handler;
  }

  setRunning(value: boolean): void {
    this.running = value;
    if (value) {
      this.startTime = Date.now();
      this.currentPhase = "";
      this.currentRound = 0;
    }
    this.showPrompt();
  }

  isRunning(): boolean { return this.running; }

  drainUserMessages(): string[] {
    const msgs = [...this.userMessages];
    this.userMessages = [];
    return msgs;
  }

  hasUserMessages(): boolean { return this.userMessages.length > 0; }

  destroy(): void {
    this.rl.close();
  }

  // ── Agent logging ──

  agentLog(agent: "planner" | "generator" | "evaluator" | "user" | "system", text: string): void {
    this.flushTextBuffer();
    const a = AGENTS[agent] ?? AGENTS.system;
    this.out(`  ${c(a.color, a.icon, true)} ${c(a.color, a.label, true)}  ${text}`);
  }

  // ── Streaming text ──

  agentStreamDelta(agent: string, delta: string): void {
    if (this.lastAgent !== agent) {
      this.flushTextBuffer();
      const a = AGENTS[agent] ?? AGENTS.system;
      this.out("");
      this.out(`  ${c(a.color, a.icon, true)} ${c(a.color, a.label, true)}`);
      this.lastAgent = agent;
    }

    this.textBuffer += delta;
    const lines = this.textBuffer.split("\n");
    if (lines.length > 1) {
      for (let i = 0; i < lines.length - 1; i++) {
        this.out(`  ${DIM}│${RESET} ${lines[i]}`);
      }
      this.textBuffer = lines[lines.length - 1];
    }

    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushTextBuffer(), 150);
  }

  private flushTextBuffer(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.textBuffer.trim()) {
      this.out(`  ${DIM}│${RESET} ${this.textBuffer}`);
    }
    this.textBuffer = "";
  }

  // ── Tool calls ──

  private toolLog(agent: string, tool: string, status: "start" | "end", detail?: string): void {
    const a = AGENTS[agent] ?? AGENTS.system;
    if (status === "start") {
      this.out(`  ${DIM}│${RESET} ${c(a.color, "▸")} ${BOLD}${tool}${RESET} ${detail ? DIM + detail + RESET : ""}`);
    } else if (detail) {
      this.out(`  ${DIM}│  └ ${detail}${RESET}`);
    }
  }

  // ── Eval result ──

  private evalLog(
    verdict: string, score: number,
    scores: Array<{ name: string; score: number; feedback: string }>,
    blockers: Array<{ severity: string; description: string }>,
    bugs: Array<{ severity: string; description: string; location?: string }>,
  ): void {
    const v = verdict === "pass";
    const vStr = v ? c("green", "PASS", true) : c("red", "FAIL", true);
    const sStr = v ? c("green", score.toFixed(1)) : c("red", score.toFixed(1));

    this.out("");
    this.out(`  ╔${"═".repeat(52)}╗`);
    this.out(`  ║  ${c("magenta", "◉‿◉", true)} Eval: ${vStr}  ${sStr}/10  ${stars(score)}`);
    this.out(`  ╠${"═".repeat(52)}╣`);

    for (const s of scores) {
      const sc = s.score >= 7 ? c("green", String(s.score)) : s.score >= 5 ? c("yellow", String(s.score)) : c("red", String(s.score));
      const bar = `${FG.cyan}${"█".repeat(Math.round(s.score))}${RESET}${DIM}${"░".repeat(10 - Math.round(s.score))}${RESET}`;
      this.out(`  ║  ${s.name.padEnd(16)} ${bar} ${sc}  ${DIM}${s.feedback.slice(0, 30)}${RESET}`);
    }

    if (blockers.length > 0) {
      this.out(`  ╟${"─".repeat(52)}╢`);
      for (const b of blockers) this.out(`  ║  ${c("red", "✖")} ${b.description.slice(0, 46)}`);
    }
    if (bugs.length > 0) {
      this.out(`  ╟${"─".repeat(52)}╢`);
      for (const bug of bugs.slice(0, 3)) {
        const loc = bug.location ? `${DIM}(${bug.location})${RESET} ` : "";
        this.out(`  ║  ${c("yellow", "⚠")} ${loc}${bug.description.slice(0, 42)}`);
      }
    }
    this.out(`  ╚${"═".repeat(52)}╝`);
  }

  // ── Decisions ──

  logDecision(reason: string, action: string, auto: boolean): void {
    this.decisions.push({ time: new Date().toISOString(), phase: this.currentPhase, reason, action, auto });
  }

  flushDecisionLog(): void {
    if (this.decisions.length === 0) return;
    const dir = path.join(process.cwd(), ".coding-studio");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const lines = [
      "# Decision Log", "",
      `> Generated ${new Date().toISOString()}`, "",
      "| # | Time | Phase | Decision | Action | Auto? |",
      "|---|------|-------|----------|--------|-------|",
    ];
    for (let i = 0; i < this.decisions.length; i++) {
      const d = this.decisions[i];
      const t = d.time.replace("T", " ").slice(0, 19);
      lines.push(`| ${i + 1} | ${t} | ${d.phase} | ${d.reason.slice(0, 40)} | ${d.action.slice(0, 30)} | ${d.auto ? "Yes" : "No"} |`);
    }
    fs.writeFileSync(path.join(dir, "decisions.md"), lines.join("\n") + "\n", "utf-8");
  }

  // ── Pause with countdown ──

  waitForDecision(reason: string): Promise<{ response: string; auto: boolean }> {
    const TIMEOUT_MS = 2 * 60 * 1000;

    return new Promise((resolve) => {
      let settled = false;
      const deadline = Date.now() + TIMEOUT_MS;

      this.out("");
      this.out(`  ${c("yellow", "⏸  PAUSE", true)}  ${reason}`);
      this.out(`  ${DIM}Enter to continue, type feedback, or /abort  │  auto-continue in 2:00${RESET}`);

      const ticker = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;

        // Update prompt with countdown
        this.rl.setPrompt(`${FG.yellow}${BOLD}⏸ ${m}:${String(s).padStart(2, "0")}${RESET} ${FG.cyan}❯${RESET} `);
        this.rl.prompt(true);

        if (remaining <= 0 && !settled) {
          settled = true;
          clearInterval(ticker);
          this.inputResolver = null;
          this.out(`  ${DIM}⏩ Auto-continuing (timeout)${RESET}`);
          this.logDecision(reason, "(auto-continue)", true);
          resolve({ response: "", auto: true });
        }
      }, 1000);

      this.inputResolver = (value: string) => {
        if (settled) return;
        settled = true;
        clearInterval(ticker);
        this.logDecision(reason, value || "(continue)", false);
        resolve({ response: value, auto: false });
      };
    });
  }

  // ── Orchestrator events ──

  handleOrchestratorEvent(event: OrchestratorEvent): void {
    switch (event.type) {
      case "phase": {
        this.flushTextBuffer();
        this.lastAgent = "";
        this.currentPhase = event.phase;
        const icon = PHASE_ICONS[event.phase] ?? "●";
        const a = event.phase === "building" ? "yellow" : event.phase === "evaluating" ? "magenta" : "cyan";
        this.out("");
        this.out(`  ${c(a as keyof typeof FG, `${icon} ━━━ ${event.phase.toUpperCase()} ━━━━━━━━━━━━━━━━━━━━`, true)}`);
        break;
      }
      case "round":
        this.flushTextBuffer();
        this.lastAgent = "";
        this.currentRound = event.round;
        this.out("");
        this.out(`  ${c("yellow", "╭──────────────────╮", true)}`);
        this.out(`  ${c("yellow", `│  ⚡ Round ${String(event.round).padEnd(2)}     │`, true)}`);
        this.out(`  ${c("yellow", "╰──────────────────╯", true)}`);
        break;
      case "log":
        this.out(`  ${DIM}${event.message}${RESET}`);
        break;
      case "agent_text":
        this.agentStreamDelta(event.agent, event.delta);
        break;
      case "tool_use":
        this.toolLog(event.agent, event.tool, event.status,
          event.status === "start" ? event.args?.slice(0, 80) : event.result?.slice(0, 100));
        break;
      case "eval":
        this.flushTextBuffer();
        this.evalLog(event.report.verdict, event.report.overallScore,
          event.report.scores, event.report.blockers, event.report.bugs);
        break;
      case "pause":
        this.flushTextBuffer();
        break;
      case "complete": {
        this.flushTextBuffer();
        const h = event.status.history;
        const sc = h.length > 0 ? (h[h.length - 1].score ?? 0) : 0;
        const elapsed = this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;

        this.out("");
        this.out(`  ${c("green", "╔════════════════════════════════════════╗", true)}`);
        this.out(`  ${c("green", "║", true)}  ${c("green", "⊙ω⊙  Pipeline Complete!", true)}  ${stars(sc)}`);
        this.out(`  ${c("green", "║", true)}  ${DIM}Rounds: ${h.length} | Score: ${sc > 0 ? sc.toFixed(1) : "—"}/10 | ${m}:${String(s).padStart(2, "0")}${RESET}`);
        this.out(`  ${c("green", "╚════════════════════════════════════════╝", true)}`);
        this.out("");
        this.running = false;
        this.showPrompt();
        break;
      }
    }
  }

  // ── Agent spawn ──

  async spawnAgent(): Promise<void> {
    this.rl.close();
    process.stdout.write("\n  Spawning claude CLI...\n\n");

    return new Promise((resolve) => {
      const proc = spawn("claude", [], { stdio: "inherit", cwd: process.cwd() });
      proc.on("exit", (code) => {
        process.stdout.write(`\n  claude exited (code ${code ?? "null"}). Run \`coding-studio\` to return.\n`);
        resolve();
      });
      proc.on("error", (err) => {
        process.stdout.write(`\n  Failed: ${err.message}\n`);
        resolve();
      });
    });
  }

  // ── Input handling ──

  private handleInput(value: string): void {
    if (this.inputResolver) {
      this.agentLog("user", value || "(continue)");
      const resolve = this.inputResolver;
      this.inputResolver = null;
      resolve(value);
      return;
    }

    if (!value) return;

    if (value.startsWith("/")) {
      const parts = value.slice(1).split(" ");
      const cmd = parts[0] ?? "";
      const args = parts.slice(1).join(" ");
      this.onCommand?.(cmd, args);
      return;
    }

    if (this.running) {
      this.agentLog("user", value);
      this.userMessages.push(value);
      this.out(`  ${DIM}  queued for next checkpoint${RESET}`);
    } else {
      this.agentLog("user", value);
      this.onCommand?.("run", value);
    }
  }

  waitForInput(): Promise<string> {
    return new Promise((resolve) => { this.inputResolver = resolve; });
  }
}
