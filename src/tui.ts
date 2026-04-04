import blessed from "blessed";
import { spawn } from "node:child_process";
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
  private separator: blessed.Widgets.BoxElement;
  private inputBox: blessed.Widgets.TextboxElement;
  private hintBar: blessed.Widgets.BoxElement;

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

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Coding Studio",
      fullUnicode: true,
    });

    // ── Status bar ──
    this.statusBar = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
      style: { fg: "white", bg: "blue", bold: true },
    });
    this.updateStatusBar("Ready");

    // ── Main output ──
    this.outputArea = blessed.log({
      top: 1,
      left: 0,
      width: "100%",
      height: "100%-4",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " ", style: { bg: "gray" } } as any,
      mouse: true,
      keys: true,
      vi: true,
      tags: false, // We use raw ANSI, not blessed tags
      style: { fg: "white" },
    } as any);

    // ── Separator line ──
    this.separator = blessed.box({
      bottom: 2,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
      content: `${DIM}${"─".repeat(200)}${RESET}`,
      style: { fg: "gray" },
    });

    // ── Input box ──
    this.inputBox = blessed.textbox({
      bottom: 1,
      left: 0,
      width: "100%",
      height: 1,
      inputOnFocus: true,
      mouse: true,
      tags: false,
      style: { fg: "white" },
    });

    // ── Hint bar ──
    this.hintBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: false,
      content: ` ${DIM}/run${RESET}${DIM} start${RESET}  ${DIM}/agent${RESET}${DIM} claude${RESET}  ${DIM}/abort${RESET}  ${DIM}/quit${RESET}  ${DIM}or just type your prompt${RESET}`,
      style: { fg: "gray" },
    });

    this.screen.append(this.statusBar);
    this.screen.append(this.outputArea);
    this.screen.append(this.separator);
    this.screen.append(this.inputBox);
    this.screen.append(this.hintBar);

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
    if (value) this.startTime = Date.now();
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

  // ── Status bar ──

  private updateStatusBar(label: string): void {
    let elapsed = "";
    if (this.startTime > 0 && this.running) {
      const s = Math.floor((Date.now() - this.startTime) / 1000);
      const m = Math.floor(s / 60);
      elapsed = ` ${DIM}${m}:${String(s % 60).padStart(2, "0")}${RESET}`;
    }

    const phase = this.currentPhase ? ` ${PHASE_ICONS[this.currentPhase] ?? "●"} ${this.currentPhase}` : "";
    const round = this.currentRound > 0 ? ` R${this.currentRound}` : "";

    this.statusBar.setContent(
      ` ${BOLD}Coding Studio${RESET}${BG.blue}${FG.white}  ${label}${phase}${round}${elapsed} `,
    );
    this.screen.render();
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
        break;
      }

      case "round":
        this.flushTextBuffer();
        this.lastAgent = "";
        this.currentRound = event.round;
        this.log("");
        this.log(`  ${c("yellow", `═══ Round ${event.round} ═══`, true)}`);
        this.updateStatusBar("Running");
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
        this.evalLog(
          event.report.verdict,
          event.report.overallScore,
          event.report.scores,
          event.report.blockers,
          event.report.bugs,
        );
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
