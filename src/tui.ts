import readline from "node:readline";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { select } from "@inquirer/prompts";
import type { OrchestratorEvent } from "./orchestrator.js";

// ── ANSI helpers ──

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const FG = {
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  white: "\x1b[37m", gray: "\x1b[90m",
  brightCyan: "\x1b[96m", brightGreen: "\x1b[92m", brightYellow: "\x1b[93m",
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
  private onUserChat?: (message: string, phase: string) => void;
  private inputResolver: ((value: string) => void) | null = null;
  private startTime = 0;
  private currentPhase = "";
  private currentRound = 0;
  private decisions: Array<{ time: string; phase: string; reason: string; action: string; auto: boolean }> = [];
  private promptVisible = false;
  private externalUIActive = false;
  private historyFile: string;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinnerIdx = 0;
  private ctrlCPressed = false; // double-press detection

  constructor() {
    // Load input history (like Claude Code's history.ts)
    this.historyFile = path.join(process.cwd(), ".coding-studio", "input-history.json");
    const history = this.loadHistory();

    // Tab completion for slash commands
    this.rl = readline.createInterface({
      ...{ input: process.stdin, output: process.stdout, terminal: true, history, historySize: 100 },
      completer: (line: string) => {
        const commands = ["/run", "/resume", "/agent", "/status", "/abort", "/quit", "/fold", "/unfold", "/clear"];
        if (line.startsWith("/")) {
          const hits = commands.filter((c) => c.startsWith(line));
          return [hits.length ? hits : commands, line];
        }
        return [[], line];
      },
    } as any);

    this.rl.on("line", (line) => {
      this.promptVisible = false;
      this.ctrlCPressed = false;
      const trimmed = line.trim();
      if (trimmed) this.saveToHistory(trimmed);
      this.handleInput(trimmed);
      this.showPrompt();
    });

    // Double Ctrl+C to exit (like Claude Code)
    this.rl.on("close", () => process.exit(0));
    this.rl.on("SIGINT", () => {
      if (this.ctrlCPressed) {
        process.stdout.write("\n");
        process.exit(0);
      }
      this.ctrlCPressed = true;
      this.out(`  ${DIM}Press Ctrl+C again to exit${RESET}`);
      setTimeout(() => { this.ctrlCPressed = false; }, 2000);
    });

    // Set terminal title
    process.stdout.write("\x1b]0;Coding Studio\x07");

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
  // Prompt frame: 3 lines (top sep + input + bottom sep)
  // Cursor sits on the input line (middle)

  private out(text: string): void {
    if (this.externalUIActive) {
      process.stdout.write(text + "\n");
      return;
    }

    if (this.promptVisible) {
      // Cursor is on input line (line 2 of 3). Erase all 3 lines.
      readline.cursorTo(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, -1); // up to top sep
      readline.clearLine(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, 1);  // input line
      readline.clearLine(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, 1);  // bottom sep
      readline.clearLine(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, -2); // back to top sep position
      readline.cursorTo(process.stdout, 0);
    }
    process.stdout.write(text + "\n");
    this.showPrompt();
  }

  private buildTopSep(): string {
    const cols = process.stdout.columns || 80;
    let hint: string;

    if (this.spinnerLabel) {
      const frame = this.spinnerFrames[this.spinnerIdx % this.spinnerFrames.length];
      hint = ` ${frame} ${this.spinnerLabel} `;
    } else if (this.running) {
      hint = " type to chat with planner ";
    } else {
      hint = "";
    }

    if (hint) {
      const topPad = Math.max(0, cols - 2 - hint.length);
      return `${FG.brightGreen}${BOLD}${"━".repeat(2)}${RESET}${FG.brightGreen}${hint}${BOLD}${"━".repeat(topPad)}${RESET}`;
    }
    return `${FG.brightGreen}${BOLD}${"━".repeat(cols)}${RESET}`;
  }

  private showPrompt(): void {
    if (this.externalUIActive) return;

    const cols = process.stdout.columns || 80;
    const icon = this.running ? `${FG.yellow}${BOLD}⚡${RESET}` : `${FG.cyan}${BOLD}❯${RESET}`;

    const topSep = this.buildTopSep();

    // ── Bottom separator: status line ──
    let status = "";
    if (this.running) {
      const phaseIcon = PHASE_ICONS[this.currentPhase] ?? "●";
      const elapsed = this.fmtElapsed();
      const parts = [
        `${phaseIcon} ${this.currentPhase || "starting"}`,
        this.currentRound > 0 ? `R${this.currentRound}` : null,
        `${elapsed}`,
        this.lastScore !== "—" ? `score: ${this.lastScore}` : null,
        this.lastVerdict ? (this.lastVerdict === "pass" ? `${FG.green}PASS${RESET}` : `${FG.red}FAIL${RESET}`) : null,
      ].filter(Boolean).join("  ·  ");
      status = ` ${parts} `;
    } else {
      status = ` ${DIM}ready${RESET} `;
    }
    const botPad = Math.max(0, cols - 2 - this.stripAnsi(status).length);
    const bottomSep = `${FG.brightGreen}${BOLD}${"━".repeat(2)}${RESET}${status}${FG.brightGreen}${BOLD}${"━".repeat(botPad)}${RESET}`;

    process.stdout.write(topSep + "\n");
    this.rl.setPrompt(` ${icon} `);
    this.rl.prompt(true);
    process.stdout.write("\n" + bottomSep);
    readline.moveCursor(process.stdout, 0, -1);
    readline.cursorTo(process.stdout, 4);
    this.promptVisible = true;
  }

  private lastScore = "—";
  private lastVerdict = "";

  private fmtElapsed(): string {
    if (!this.startTime || !this.running) return "0:00";
    const s = Math.floor((Date.now() - this.startTime) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "");
  }

  // ── History replay for /resume ──

  /**
   * Replay saved artifacts so user sees what happened before the interruption.
   */
  replayHistory(artifacts: {
    spec?: string;
    contract?: string;
    evalReports?: Array<{ round: number; verdict: string; overallScore: number; summary: string;
      scores?: Array<{ name: string; score: number; feedback: string }>;
      blockers?: Array<{ severity: string; description: string }>;
      bugs?: Array<{ severity: string; description: string; location?: string }>;
    }>;
    status?: { phase: string; currentRound: number; maxRounds: number };
  }): void {
    // Batch output — write everything at once to avoid prompt flicker
    const lines: string[] = [];
    const w = (s: string) => lines.push(s);

    w(`  ${c("blue", "⚙", true)} ${c("blue", "System", true)}  Restoring previous session...`);
    w("");

    if (artifacts.spec) {
      w(`  ${c("cyan", "⊙ω⊙ ━━━ PLANNING (restored) ━━━━━━━━━━", true)}`);
      const specLines = artifacts.spec.split("\n").slice(0, 8);
      for (const line of specLines) w(`  ${DIM}│${RESET} ${line}`);
      const totalLines = artifacts.spec.split("\n").length;
      if (totalLines > 8) w(`  ${DIM}│ ... (${totalLines} lines total)${RESET}`);
      w("");
    }

    if (artifacts.contract) {
      w(`  ${c("cyan", "✍  ━━━ CONTRACTING (restored) ━━━━━━━━", true)}`);
      const contractLines = artifacts.contract.split("\n").slice(0, 6);
      for (const line of contractLines) w(`  ${DIM}│${RESET} ${line}`);
      const totalLines = artifacts.contract.split("\n").length;
      if (totalLines > 6) w(`  ${DIM}│ ... (${totalLines} lines total)${RESET}`);
      w("");
    }

    if (artifacts.evalReports && artifacts.evalReports.length > 0) {
      for (const report of artifacts.evalReports) {
        const v = report.verdict === "pass";
        const vStr = v ? c("green", "PASS", true) : c("red", "FAIL", true);
        const sStr = v ? c("green", report.overallScore.toFixed(1)) : c("red", report.overallScore.toFixed(1));
        w(`  ${DIM}Round ${report.round}:${RESET} ${vStr} ${sStr}/10  ${DIM}${report.summary.slice(0, 60)}${RESET}`);
      }
      w("");
    }

    if (artifacts.status) {
      w(`  ${c("yellow", "▸", true)} Resuming from ${BOLD}${artifacts.status.phase}${RESET} phase, round ${artifacts.status.currentRound}/${artifacts.status.maxRounds}`);
      w("");
    }

    // Clear prompt if visible, write all lines at once, redraw prompt once
    if (this.promptVisible) {
      readline.moveCursor(process.stdout, 0, -1);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      readline.moveCursor(process.stdout, 0, -2);
      this.promptVisible = false;
    }
    process.stdout.write(lines.join("\n") + "\n");
    this.showPrompt();
  }

  // ── Spinner (embedded in prompt status line, not a separate row) ──

  private spinnerLabel = "";

  startSpinner(label: string): void {
    this.stopSpinner();
    this.spinnerIdx = 0;
    this.spinnerLabel = label;
    this.spinnerTimer = setInterval(() => {
      this.spinnerIdx++;
      this.refreshPromptInPlace();
    }, 80);
  }

  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      this.spinnerLabel = "";
    }
  }

  /** Redraw just the prompt separator + input without erasing output above */
  private refreshPromptInPlace(): void {
    if (this.externalUIActive || !this.promptVisible) return;
    // Cursor is on the input line. Move up to top sep, redraw both lines.
    readline.cursorTo(process.stdout, 0);
    readline.moveCursor(process.stdout, 0, -1); // top sep
    readline.clearLine(process.stdout, 0);
    process.stdout.write(this.buildTopSep());
    readline.moveCursor(process.stdout, 0, 1); // back to input
    readline.cursorTo(process.stdout, 4); // after " ❯ "
  }

  // ── Markdown-lite rendering ──

  /** Simple markdown highlighting for output text */
  static mdHighlight(text: string): string {
    return text
      // Headers
      .replace(/^(#{1,3}) (.+)$/gm, `${BOLD}$1 $2${RESET}`)
      // Bold
      .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
      // Inline code
      .replace(/`([^`]+)`/g, `${FG.cyan}$1${RESET}`)
      // Bullet points
      .replace(/^(\s*[-*]) /gm, `${FG.cyan}$1${RESET} `);
  }

  // ── Public API ──

  setCommandHandler(handler: (cmd: string, args: string) => void): void {
    this.onCommand = handler;
  }

  /** Set handler for user chat during pipeline — Planner responds */
  setUserChatHandler(handler: (message: string, phase: string) => void): void {
    this.onUserChat = handler;
  }

  setRunning(value: boolean): void {
    this.running = value;
    if (value) {
      this.startTime = Date.now();
      this.currentPhase = "";
      this.currentRound = 0;
      this.lastScore = "—";
      this.lastVerdict = "";
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

  // ── Input history (arrow up/down) ──

  private loadHistory(): string[] {
    try {
      if (fs.existsSync(this.historyFile)) {
        return JSON.parse(fs.readFileSync(this.historyFile, "utf-8"));
      }
    } catch {}
    return [];
  }

  private saveToHistory(input: string): void {
    try {
      const history = this.loadHistory();
      // Dedupe: don't add if same as last entry
      if (history[0] === input) return;
      history.unshift(input);
      const trimmed = history.slice(0, 100);
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.historyFile, JSON.stringify(trimmed), "utf-8");
    } catch {}
  }

  /**
   * Interactive session picker using @inquirer/select (↑↓ + Enter).
   */
  async showSessionPicker(sessions: Array<{
    id: string; prompt: string; startedAt: string;
    phase: string; rounds: number; lastScore: number | null; mode: string;
  }>): Promise<number> {
    if (sessions.length === 0) {
      this.out(`  ${DIM}No sessions found.${RESET}`);
      return -1;
    }

    // Hand over terminal to inquirer
    this.externalUIActive = true;
    this.promptVisible = false;
    this.rl.pause();

    try {
      const choices = sessions.map((s, i) => {
        const time = s.startedAt.replace("T", " ").slice(5, 16);
        const score = s.lastScore !== null ? s.lastScore.toFixed(1) : "—";
        const prompt = s.prompt.split("\n")[0].slice(0, 45) + (s.prompt.length > 45 ? "…" : "");
        return {
          name: `${time}  ${s.phase.padEnd(12)} R${s.rounds}  ${score.padEnd(5)}  ${prompt}`,
          value: i,
        };
      });

      const selected = await select({
        message: "Select a session to resume:",
        choices,
      });

      // Restore our terminal control
      this.externalUIActive = false;
      this.rl.resume();
      this.showPrompt();
      return selected;
    } catch {
      this.externalUIActive = false;
      this.rl.resume();
      process.stdout.write(`  ${DIM}Cancelled.${RESET}\n`);
      this.showPrompt();
      return -1;
    }
  }

  destroy(): void {
    this.stopSpinner();
    process.stdout.write("\x1b]0;\x07"); // restore terminal title
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
    this.stopSpinner(); // stop any running spinner when text arrives

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
        this.out(`  ${DIM}│${RESET} ${CodingStudioTUI.mdHighlight(lines[i])}`);
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
      this.stopSpinner();
      this.out(`  ${DIM}│${RESET} ${c(a.color, "▸")} ${BOLD}${tool}${RESET} ${detail ? DIM + detail + RESET : ""}`);
      this.startSpinner(`${tool}...`);
    } else {
      this.stopSpinner();
      if (detail) {
        this.out(`  ${DIM}│  └ ${detail}${RESET}`);
      }
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
    const TIMEOUT_MS = 30 * 1000;

    return new Promise((resolve) => {
      let settled = false;
      let deadline = Date.now() + TIMEOUT_MS;

      this.out("");
      this.out(`  ${c("yellow", "⏸  PAUSE", true)}  ${reason}`);
      this.out(`  ${DIM}Enter to continue, type feedback, or /abort  │  auto-continue in 0:30${RESET}`);

      // Reset timer on any keypress (user is typing)
      const onKeypress = () => { deadline = Date.now() + TIMEOUT_MS; };
      process.stdin.on("keypress", onKeypress);

      const ticker = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        const s = remaining % 60;

        this.rl.setPrompt(`${FG.yellow}${BOLD}⏸ 0:${String(s).padStart(2, "0")}${RESET} ${FG.cyan}❯${RESET} `);
        this.rl.prompt(true);

        if (remaining <= 0 && !settled) {
          settled = true;
          clearInterval(ticker);
          process.stdin.removeListener("keypress", onKeypress);
          this.inputResolver = null;
          this.out(`  ${DIM}⏩ Auto-continuing (30s no input)${RESET}`);
          this.logDecision(reason, "(auto-continue)", true);
          resolve({ response: "", auto: true });
        }
      }, 1000);

      this.inputResolver = (value: string) => {
        if (settled) return;
        settled = true;
        clearInterval(ticker);
        process.stdin.removeListener("keypress", onKeypress);
        this.logDecision(reason, value || "(continue)", false);
        resolve({ response: value, auto: false });
      };
    });
  }

  // ── Orchestrator events ──

  handleOrchestratorEvent(event: OrchestratorEvent): void {
    switch (event.type) {
      case "phase": {
        this.stopSpinner();
        this.flushTextBuffer();
        this.lastAgent = "";
        this.currentPhase = event.phase;
        const icon = PHASE_ICONS[event.phase] ?? "●";
        const a = event.phase === "building" ? "yellow" : event.phase === "evaluating" ? "magenta" : "cyan";
        this.out("");
        this.out(`  ${c(a as keyof typeof FG, `${icon} ━━━ ${event.phase.toUpperCase()} ━━━━━━━━━━━━━━━━━━━━`, true)}`);
        // Update terminal title
        process.stdout.write(`\x1b]0;Coding Studio · ${event.phase}\x07`);
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
        this.lastScore = event.report.overallScore.toFixed(1);
        this.lastVerdict = event.report.verdict;
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
      // Planner responds immediately (like a project manager always on call)
      if (this.onUserChat) {
        this.onUserChat(value, this.currentPhase);
      }
    } else {
      this.agentLog("user", value);
      this.onCommand?.("run", value);
    }
  }

  waitForInput(): Promise<string> {
    return new Promise((resolve) => { this.inputResolver = resolve; });
  }
}
