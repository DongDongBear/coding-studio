import blessed from "blessed";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OrchestratorEvent } from "./orchestrator.js";

// ── ANSI helpers (blessed tags crash on unescaped {}, so we use raw ANSI) ──

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

const FG = {
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
} as const;

const BG = {
  blue: "\x1b[44m",
  black: "\x1b[40m",
} as const;

function c(fg: keyof typeof FG, text: string, bold = false): string {
  return `${bold ? BOLD : ""}${FG[fg]}${text}${RESET}`;
}

// ── Constants ──

const AGENT_STYLES = {
  planner: { icon: "◆", color: "cyan" as const, label: "Planner" },
  generator: { icon: "◆", color: "yellow" as const, label: "Generator" },
  evaluator: { icon: "◆", color: "magenta" as const, label: "Evaluator" },
  user: { icon: "▶", color: "green" as const, label: "You" },
  system: { icon: "●", color: "blue" as const, label: "System" },
} as const;

const PHASE_ICONS: Record<string, string> = {
  planning: "📋",
  contracting: "📝",
  building: "🔨",
  running: "🚀",
  evaluating: "🔍",
};

// ── TUI Class ──

export class CodingStudioTUI {
  private screen: blessed.Widgets.Screen;
  private statusBar: blessed.Widgets.BoxElement;
  private outputArea: blessed.Widgets.Log;
  private inputBox: blessed.Widgets.TextboxElement;
  private statusPanel: blessed.Widgets.BoxElement;

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
  private maxRounds = 3;
  private lastScore = "—";
  private lastVerdict = "";
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private prompt = "";
  private decisions: Array<{ time: string; phase: string; reason: string; action: string; auto: boolean }> = [];

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Coding Studio",
      fullUnicode: true,
    });

    // Layout (top to bottom):
    //   [status bar]      1 line
    //   [output area]     flexible
    //   [input box]       1 line
    //   [status panel]    4 lines - progress, phase, score, hints

    // ── Status bar (top) ──
    this.statusBar = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
      style: { fg: "white", bg: "blue", bold: true },
    });
    this.updateStatusBar("Ready");

    // ── Main output (scrollable via keyboard, mouse free for text selection) ──
    this.outputArea = blessed.log({
      top: 1,
      left: 0,
      width: "100%",
      height: "100%-6",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", style: { bg: "gray" } } as any,
      mouse: false, // Let terminal handle mouse selection/copy
      keys: true,
      vi: true,
      tags: false,
      style: { fg: "white" },
    } as any);

    // ── Input prompt label ──
    const inputLabel = blessed.box({
      bottom: 4,
      left: 1,
      width: 3,
      height: 1,
      tags: false,
      content: `${FG.cyan}${BOLD}❯${RESET}`,
      style: { fg: "cyan" },
    });

    // ── Input box ──
    this.inputBox = blessed.textbox({
      bottom: 4,
      left: 4,
      width: "100%-5",
      height: 1,
      inputOnFocus: true,
      mouse: true,
      tags: false,
      style: { fg: "white", bold: true },
    });

    // ── Status panel (bottom) ──
    this.statusPanel = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 4,
      tags: false,
      style: { fg: "white" },
    });
    this.renderStatusPanel();

    this.screen.append(this.statusBar);
    this.screen.append(this.outputArea);
    this.screen.append(inputLabel);
    this.screen.append(this.inputBox);
    this.screen.append(this.statusPanel);

    // ── Input handling ──
    this.inputBox.on("submit", (value: string) => {
      this.handleInput(value.trim());
      (this.inputBox as any).clearValue();
      this.inputBox.focus();
      this.screen.render();
    });

    this.screen.key(["C-c"], () => {
      this.destroy();
      process.exit(0);
    });

    this.screen.key(["escape"], () => {
      this.inputBox.focus();
      this.screen.render();
    });

    this.inputBox.focus();
    this.screen.render();

    // Welcome
    this.log("");
    this.log(`  ${BOLD}Coding Studio${RESET}`);
    this.log(`  ${DIM}Type a prompt to start building, or use /run <prompt>${RESET}`);
    this.log("");
  }

  // ── Public API ──

  setCommandHandler(handler: (cmd: string, args: string) => void): void {
    this.onCommand = handler;
  }

  setRunning(value: boolean): void {
    this.running = value;
    if (value) {
      this.startTime = Date.now();
      this.lastScore = "—";
      this.lastVerdict = "";
      this.currentPhase = "";
      this.currentRound = 0;
      this.startStatusTimer();
      this.renderStatusPanel();
    } else {
      this.stopStatusTimer();
      this.renderStatusPanel();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  drainUserMessages(): string[] {
    const msgs = [...this.userMessages];
    this.userMessages = [];
    return msgs;
  }

  hasUserMessages(): boolean {
    return this.userMessages.length > 0;
  }

  destroy(): void {
    this.stopStatusTimer();
    this.screen.destroy();
  }

  // ── Logging ──

  private log(text: string): void {
    (this.outputArea as any).log(text);
    this.screen.render();
  }

  agentLog(agent: "planner" | "generator" | "evaluator" | "user" | "system", text: string): void {
    this.flushTextBuffer();
    const s = AGENT_STYLES[agent];
    this.log(`  ${c(s.color, s.icon)} ${c(s.color, s.label, true)}  ${text}`);
  }

  // ── Streaming text ──

  agentStreamDelta(agent: string, delta: string): void {
    if (this.lastAgent !== agent) {
      this.flushTextBuffer();
      const s = AGENT_STYLES[agent as keyof typeof AGENT_STYLES] ?? AGENT_STYLES.system;
      this.log("");
      this.log(`  ${c(s.color, s.icon)} ${c(s.color, s.label, true)}`);
      this.lastAgent = agent;
    }

    this.textBuffer += delta;

    const lines = this.textBuffer.split("\n");
    if (lines.length > 1) {
      for (let i = 0; i < lines.length - 1; i++) {
        this.log(`  ${DIM}│${RESET} ${lines[i]}`);
      }
      this.textBuffer = lines[lines.length - 1];
    }

    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushTextBuffer(), 150);
  }

  private flushTextBuffer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.textBuffer.trim()) {
      this.log(`  ${DIM}│${RESET} ${this.textBuffer}`);
    }
    this.textBuffer = "";
  }

  // ── Tool calls ──

  private toolLog(agent: string, tool: string, status: "start" | "end", detail?: string): void {
    const s = AGENT_STYLES[agent as keyof typeof AGENT_STYLES] ?? AGENT_STYLES.system;
    if (status === "start") {
      this.log(`  ${DIM}│${RESET} ${c(s.color, "▸")} ${BOLD}${tool}${RESET} ${detail ? DIM + detail + RESET : ""}`);
    } else if (detail) {
      this.log(`  ${DIM}│  └ ${detail}${RESET}`);
    }
  }

  // ── Eval result ──

  private evalLog(
    verdict: string,
    score: number,
    scores: Array<{ name: string; score: number; feedback: string }>,
    blockers: Array<{ severity: string; description: string }>,
    bugs: Array<{ severity: string; description: string; location?: string }>,
  ): void {
    const v = verdict === "pass";
    const vStr = v ? c("green", "PASS", true) : c("red", "FAIL", true);
    const sStr = v ? c("green", score.toFixed(1)) : c("red", score.toFixed(1));

    this.log("");
    this.log(`  ┌─ Eval Result: ${vStr} ${sStr}/10 ${"─".repeat(40)}`);

    for (const s of scores) {
      const sc = s.score >= 7 ? c("green", String(s.score)) : s.score >= 5 ? c("yellow", String(s.score)) : c("red", String(s.score));
      const bar = "█".repeat(Math.round(s.score)) + `${DIM}${"░".repeat(10 - Math.round(s.score))}${RESET}`;
      this.log(`  │ ${s.name.padEnd(18)} ${bar} ${sc}  ${DIM}${s.feedback.slice(0, 50)}${RESET}`);
    }

    if (blockers.length > 0) {
      this.log(`  │`);
      this.log(`  │ ${c("red", "Blockers:", true)}`);
      for (const b of blockers) {
        this.log(`  │  ${c("red", "✖")} ${b.description.slice(0, 100)}`);
      }
    }

    if (bugs.length > 0) {
      this.log(`  │`);
      this.log(`  │ ${c("yellow", "Bugs:", true)}`);
      for (const bug of bugs.slice(0, 5)) {
        const loc = bug.location ? `${DIM}(${bug.location})${RESET} ` : "";
        this.log(`  │  ${c("yellow", "⚠")} ${loc}${bug.description.slice(0, 80)}`);
      }
    }

    this.log(`  └${"─".repeat(60)}`);
  }

  // ── Decision logging ──

  logDecision(reason: string, action: string, auto: boolean): void {
    this.decisions.push({
      time: new Date().toISOString(),
      phase: this.currentPhase,
      reason,
      action,
      auto,
    });
  }

  /** Write all decisions to .coding-studio/decisions.md */
  flushDecisionLog(): void {
    if (this.decisions.length === 0) return;
    const dir = path.join(process.cwd(), ".coding-studio");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const lines = [
      `# Decision Log`,
      ``,
      `> Generated by Coding Studio on ${new Date().toISOString()}`,
      ``,
      `| # | Time | Phase | Decision Point | Action | Auto? |`,
      `|---|------|-------|---------------|--------|-------|`,
    ];
    for (let i = 0; i < this.decisions.length; i++) {
      const d = this.decisions[i];
      const t = d.time.replace("T", " ").slice(0, 19);
      const auto = d.auto ? "Yes (timeout)" : "No (user)";
      lines.push(`| ${i + 1} | ${t} | ${d.phase} | ${d.reason.slice(0, 50)} | ${d.action.slice(0, 40)} | ${auto} |`);
    }
    lines.push("");

    fs.writeFileSync(path.join(dir, "decisions.md"), lines.join("\n"), "utf-8");
  }

  /**
   * Wait for user decision with 2-minute timeout.
   * Returns the user's input, or auto-continues after timeout.
   */
  waitForDecision(reason: string): Promise<{ response: string; auto: boolean }> {
    const TIMEOUT_MS = 2 * 60 * 1000;

    return new Promise((resolve) => {
      let settled = false;
      let countdown: ReturnType<typeof setInterval> | null = null;
      const deadline = Date.now() + TIMEOUT_MS;

      // Show countdown in status panel
      countdown = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        this.updateStatusBar(`Waiting for input ${FG.yellow}${m}:${String(s).padStart(2, "0")}${RESET}`);
        if (remaining <= 0 && !settled) {
          settled = true;
          if (countdown) clearInterval(countdown);
          this.inputResolver = null;
          this.log(`  ${DIM}Auto-continuing (2min timeout)${RESET}`);
          this.logDecision(reason, "(auto-continue)", true);
          resolve({ response: "", auto: true });
        }
      }, 1000);

      // Wait for user input
      this.inputResolver = (value: string) => {
        if (settled) return;
        settled = true;
        if (countdown) clearInterval(countdown);
        const action = value || "(continue)";
        this.logDecision(reason, action, false);
        resolve({ response: value, auto: false });
      };
    });
  }

  // ── Status bar ──

  private updateStatusBar(label: string): void {
    const phase = this.currentPhase ? ` ${PHASE_ICONS[this.currentPhase] ?? "●"} ${this.currentPhase}` : "";
    const round = this.currentRound > 0 ? ` R${this.currentRound}` : "";

    this.statusBar.setContent(
      ` ${BOLD}Coding Studio${RESET}${BG.blue}${FG.white}  ${label}${phase}${round} `,
    );
    this.screen.render();
  }

  // ── Status panel (bottom) ──

  private fmtElapsed(): string {
    if (!this.startTime || !this.running) return "—";
    const s = Math.floor((Date.now() - this.startTime) / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  private renderStatusPanel(): void {
    const w = (this.screen as any).width ?? 80;
    const sep = `${DIM}${"─".repeat(w)}${RESET}`;

    const phases = ["planning", "contracting", "building", "evaluating"];
    const phaseLine = phases.map((p) => {
      const icon = PHASE_ICONS[p] ?? "●";
      if (p === this.currentPhase) return `${BOLD}${FG.cyan}${icon} ${p}${RESET}`;
      if (phases.indexOf(p) < phases.indexOf(this.currentPhase)) return `${FG.green}${icon} ${p}${RESET}`;
      return `${DIM}${icon} ${p}${RESET}`;
    }).join("  ");

    const elapsed = this.fmtElapsed();
    const round = this.currentRound > 0 ? `Round ${this.currentRound}/${this.maxRounds}` : "—";
    const score = this.lastScore;
    const verdict = this.lastVerdict ? (this.lastVerdict === "pass" ? `${FG.green}PASS${RESET}` : `${FG.red}FAIL${RESET}`) : "—";

    const infoLine = `  ${DIM}Time:${RESET} ${elapsed}  ${DIM}Round:${RESET} ${round}  ${DIM}Score:${RESET} ${score}  ${DIM}Last:${RESET} ${verdict}  ${DIM}│${RESET}  ${DIM}/run  /agent  /abort  /quit${RESET}`;

    this.statusPanel.setContent(`${sep}\n${phaseLine.length > 0 ? `  ${phaseLine}` : ""}\n${infoLine}\n  ${DIM}Type your prompt to start, or use commands above${RESET}`);
    this.screen.render();
  }

  private startStatusTimer(): void {
    if (this.statusTimer) return;
    this.statusTimer = setInterval(() => {
      if (this.running) this.renderStatusPanel();
    }, 1000);
  }

  private stopStatusTimer(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  // ── Orchestrator events ──

  handleOrchestratorEvent(event: OrchestratorEvent): void {
    switch (event.type) {
      case "phase": {
        this.flushTextBuffer();
        this.lastAgent = "";
        this.currentPhase = event.phase;
        const icon = PHASE_ICONS[event.phase] ?? "●";
        this.log("");
        this.log(`  ${BOLD}${icon} ${event.phase.toUpperCase()}${RESET}`);
        this.log(`  ${DIM}${"─".repeat(50)}${RESET}`);
        this.updateStatusBar("Running");
        this.renderStatusPanel();
        break;
      }

      case "round":
        this.flushTextBuffer();
        this.lastAgent = "";
        this.currentRound = event.round;
        this.log("");
        this.log(`  ${c("yellow", `═══ Round ${event.round} ═══`, true)}`);
        this.updateStatusBar("Running");
        this.renderStatusPanel();
        break;

      case "log":
        this.log(`  ${DIM}${event.message}${RESET}`);
        break;

      case "agent_text":
        this.agentStreamDelta(event.agent, event.delta);
        break;

      case "tool_use":
        this.toolLog(
          event.agent,
          event.tool,
          event.status,
          event.status === "start" ? event.args?.slice(0, 80) : event.result?.slice(0, 100),
        );
        break;

      case "eval":
        this.flushTextBuffer();
        this.lastScore = event.report.overallScore.toFixed(1);
        this.lastVerdict = event.report.verdict;
        this.evalLog(
          event.report.verdict,
          event.report.overallScore,
          event.report.scores,
          event.report.blockers,
          event.report.bugs,
        );
        this.renderStatusPanel();
        break;

      case "pause":
        this.flushTextBuffer();
        this.log("");
        this.log(`  ${c("yellow", "⏸  PAUSE", true)}  ${event.reason}`);
        this.log(`  ${DIM}Press Enter to continue, or type feedback / /abort${RESET}`);
        this.updateStatusBar("Paused");
        break;

      case "complete": {
        this.flushTextBuffer();
        const h = event.status.history;
        const lastScore = h.length > 0 ? (h[h.length - 1].score?.toFixed(1) ?? "—") : "—";
        const elapsed = this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;

        this.log("");
        this.log(`  ${c("green", "✓  Pipeline complete", true)}`);
        this.log(`  ${DIM}Mode: ${event.status.mode} | Rounds: ${h.length} | Score: ${lastScore} | Time: ${m}:${String(s).padStart(2, "0")}${RESET}`);
        this.log("");

        this.running = false;
        this.currentPhase = "";
        this.currentRound = 0;
        this.updateStatusBar("Ready");
        break;
      }
    }
  }

  // ── Agent spawn ──

  async spawnAgent(): Promise<void> {
    this.screen.destroy();
    process.stdout.write("\n  Spawning claude CLI...\n\n");

    return new Promise((resolve) => {
      const proc = spawn("claude", [], {
        stdio: "inherit",
        cwd: process.cwd(),
      });

      proc.on("exit", (code) => {
        process.stdout.write(`\n  claude exited (code ${code ?? "null"}). Run \`coding-studio\` to return.\n`);
        resolve();
      });

      proc.on("error", (err) => {
        process.stdout.write(`\n  Failed to spawn claude: ${err.message}\n`);
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
      this.log(`  ${DIM}  queued for next checkpoint${RESET}`);
    } else {
      this.agentLog("user", value);
      this.onCommand?.("run", value);
    }
  }

  waitForInput(): Promise<string> {
    return new Promise((resolve) => {
      this.inputResolver = resolve;
    });
  }
}
