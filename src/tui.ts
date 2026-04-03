import blessed from "blessed";
import { spawn } from "node:child_process";
import type { OrchestratorEvent } from "./orchestrator.js";

export class CodingStudioTUI {
  private screen: blessed.Widgets.Screen;
  private statusBar: blessed.Widgets.BoxElement;
  private outputArea: blessed.Widgets.Log;
  private inputBox: blessed.Widgets.TextboxElement;
  private userMessages: string[] = [];
  private textBuffer: Map<string, string> = new Map(); // agent → buffered text
  private lastAgent = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private onCommand?: (cmd: string, args: string) => void;
  private inputResolver: ((value: string) => void) | null = null;

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Coding Studio",
      fullUnicode: true,
    });

    // Status bar at top
    this.statusBar = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      content: " Coding Studio — Ready",
      style: { fg: "white", bg: "blue", bold: true },
    });

    // Main output area (scrollable log)
    this.outputArea = blessed.log({
      top: 1,
      left: 0,
      width: "100%",
      height: "100%-3",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "cyan" } } as any,
      mouse: true,
      keys: true,
      vi: true,
      style: { fg: "white", bg: "black" },
      tags: true,
    } as any);

    // Input box at bottom
    this.inputBox = blessed.textbox({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: { type: "line" },
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "cyan" },
        focus: { border: { fg: "green" } },
      },
      inputOnFocus: true,
      mouse: true,
    });

    this.screen.append(this.statusBar);
    this.screen.append(this.outputArea);
    this.screen.append(this.inputBox);

    // Handle input submission
    this.inputBox.on("submit", (value: string) => {
      this.handleInput(value.trim());
      (this.inputBox as any).clearValue();
      this.inputBox.focus();
      this.screen.render();
    });

    // Ctrl+C to quit
    this.screen.key(["C-c"], () => {
      this.destroy();
      process.exit(0);
    });

    // Escape returns focus to input
    this.screen.key(["escape"], () => {
      this.inputBox.focus();
      this.screen.render();
    });

    this.inputBox.focus();
    this.screen.render();
  }

  /** Set command handler */
  setCommandHandler(handler: (cmd: string, args: string) => void): void {
    this.onCommand = handler;
  }

  /** Update status bar */
  setStatus(text: string): void {
    this.statusBar.setContent(` Coding Studio — ${text}`);
    this.screen.render();
  }

  /** Append a line to the output with blessed color tags */
  log(text: string): void {
    (this.outputArea as any).log(text);
    this.screen.render();
  }

  /** Append text without newline (for streaming) */
  write(text: string): void {
    (this.outputArea as any).log(text.replace(/\n$/, ""));
    this.screen.render();
  }

  private getAgentLabel(agent: string): string {
    const labels: Record<string, string> = {
      planner: "{cyan-fg}{bold}[Planner]{/bold}{/cyan-fg}",
      generator: "{yellow-fg}{bold}[Generator]{/bold}{/yellow-fg}",
      evaluator: "{magenta-fg}{bold}[Evaluator]{/bold}{/magenta-fg}",
      user: "{green-fg}{bold}[User]{/bold}{/green-fg}",
      system: "{blue-fg}{bold}[System]{/bold}{/blue-fg}",
    };
    return labels[agent] ?? `{white-fg}[${agent}]{/white-fg}`;
  }

  /** Log a complete message with agent label */
  agentLog(
    agent: "planner" | "generator" | "evaluator" | "user" | "system",
    text: string,
  ): void {
    this.flushTextBuffer(); // flush any streaming in progress
    this.log(`${this.getAgentLabel(agent)} ${text}`);
  }

  /** Stream a text delta — buffers and flushes complete lines */
  agentStreamDelta(agent: string, delta: string): void {
    // Print agent header on switch
    if (this.lastAgent !== agent) {
      this.flushTextBuffer();
      this.log(`\n${this.getAgentLabel(agent)}`);
      this.lastAgent = agent;
    }

    const buf = (this.textBuffer.get(agent) ?? "") + delta;
    this.textBuffer.set(agent, buf);

    // Flush complete lines
    const lines = buf.split("\n");
    if (lines.length > 1) {
      // All but the last are complete lines
      for (let i = 0; i < lines.length - 1; i++) {
        this.log(`  ${lines[i]}`);
      }
      this.textBuffer.set(agent, lines[lines.length - 1]);
    }

    // Debounced flush for partial lines (after 100ms of no new deltas)
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushTextBuffer(), 100);
  }

  /** Flush any remaining text in the buffer */
  private flushTextBuffer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const [agent, buf] of this.textBuffer) {
      if (buf.trim()) {
        this.log(`  ${buf}`);
      }
    }
    this.textBuffer.clear();
  }

  /** Log a tool call */
  toolLog(
    agent: string,
    tool: string,
    status: "start" | "end",
    detail?: string,
  ): void {
    const agentColors: Record<string, string> = {
      planner: "cyan",
      generator: "yellow",
      evaluator: "magenta",
    };
    const color = agentColors[agent] ?? "white";
    if (status === "start") {
      this.log(
        `  {${color}-fg}▸{/${color}-fg} {bold}${tool}{/bold} ${
          detail ? `{#666-fg}${detail}{/#666-fg}` : ""
        }`,
      );
    } else if (detail) {
      this.log(`    {#666-fg}${detail}{/#666-fg}`);
    }
  }

  /** Show eval result */
  evalLog(
    verdict: string,
    score: number,
    scores: Array<{ name: string; score: number; feedback: string }>,
    blockers: Array<{ severity: string; description: string }>,
    bugs: Array<{
      severity: string;
      description: string;
      location?: string;
    }>,
  ): void {
    const vColor = verdict === "pass" ? "green" : "red";
    this.log(
      `\n{${vColor}-fg}{bold}━━━ Eval: ${verdict.toUpperCase()} (${score.toFixed(1)}/10) ━━━{/bold}{/${vColor}-fg}`,
    );
    for (const s of scores) {
      const sColor =
        s.score >= 7 ? "green" : s.score >= 5 ? "yellow" : "red";
      this.log(
        `  ${s.name.padEnd(18)} {${sColor}-fg}${s.score}{/${sColor}-fg}/10  {#666-fg}${s.feedback.slice(0, 60)}{/#666-fg}`,
      );
    }
    if (blockers.length > 0) {
      this.log(`{red-fg}Blockers:{/red-fg}`);
      for (const b of blockers) {
        this.log(`  {red-fg}[${b.severity}]{/red-fg} ${b.description}`);
      }
    }
    if (bugs.length > 0) {
      this.log(`{yellow-fg}Bugs:{/yellow-fg}`);
      for (const bug of bugs.slice(0, 5)) {
        const loc = bug.location
          ? ` {#666-fg}(${bug.location}){/#666-fg}`
          : "";
        this.log(
          `  {yellow-fg}[${bug.severity}]{/yellow-fg}${loc} ${bug.description}`,
        );
      }
    }
  }

  /** Get and clear queued user messages */
  drainUserMessages(): string[] {
    const msgs = [...this.userMessages];
    this.userMessages = [];
    return msgs;
  }

  /** Check if there are pending user messages */
  hasUserMessages(): boolean {
    return this.userMessages.length > 0;
  }

  /** Handle an orchestrator event */
  handleOrchestratorEvent(event: OrchestratorEvent): void {
    switch (event.type) {
      case "phase":
        this.log(
          `\n{bold}{blue-fg}━━━ ${event.phase.toUpperCase()} ━━━{/blue-fg}{/bold}`,
        );
        this.setStatus(`Phase: ${event.phase}`);
        break;
      case "round":
        this.log(
          `\n{bold}{yellow-fg}═══ Round ${event.round} ═══{/yellow-fg}{/bold}`,
        );
        this.setStatus(`Round ${event.round}`);
        break;
      case "log":
        this.log(`{#666-fg}${event.message}{/#666-fg}`);
        break;
      case "agent_text":
        this.agentStreamDelta(event.agent, event.delta);
        break;
      case "tool_use":
        this.toolLog(
          event.agent,
          event.tool,
          event.status,
          event.status === "start"
            ? event.args?.slice(0, 80)
            : event.result?.slice(0, 120),
        );
        break;
      case "eval":
        this.evalLog(
          event.report.verdict,
          event.report.overallScore,
          event.report.scores,
          event.report.blockers,
          event.report.bugs,
        );
        break;
      case "pause":
        this.log(`\n{yellow-fg}[PAUSE]{/yellow-fg} ${event.reason}`);
        this.log(
          "{green-fg}Type your feedback, press Enter to continue, or type /abort{/green-fg}",
        );
        break;
      case "complete": {
        const h = event.status.history;
        const lastScore =
          h.length > 0
            ? (h[h.length - 1].score?.toFixed(1) ?? "N/A")
            : "N/A";
        this.log(
          `\n{green-fg}{bold}Pipeline complete{/bold}{/green-fg} (${event.status.mode}, ${h.length} rounds, score: ${lastScore})`,
        );
        this.setStatus("Ready");
        this.running = false;
        break;
      }
    }
  }

  /** Mark pipeline as running */
  setRunning(value: boolean): void {
    this.running = value;
  }

  /** Returns whether pipeline is currently running */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Spawn interactive claude CLI (takes over terminal).
   * Destroys the blessed screen first, then spawns claude with stdio:inherit.
   * After claude exits, logs a note and exits — the user should restart the TUI.
   */
  async spawnAgent(): Promise<void> {
    this.screen.destroy();
    process.stdout.write("\n[Coding Studio] Spawning claude CLI...\n");

    return new Promise((resolve) => {
      const proc = spawn("claude", [], {
        stdio: "inherit",
        cwd: process.cwd(),
      });

      proc.on("exit", (code) => {
        process.stdout.write(
          `\n[Coding Studio] claude exited (code ${code ?? "null"}).\n`,
        );
        process.stdout.write(
          "[Coding Studio] TUI was destroyed. Run `coding-studio` again to restart.\n",
        );
        resolve();
      });

      proc.on("error", (err) => {
        process.stdout.write(
          `\n[Coding Studio] Failed to spawn claude: ${err.message}\n`,
        );
        process.stdout.write(
          "[Coding Studio] TUI was destroyed. Run `coding-studio` again to restart.\n",
        );
        resolve();
      });
    });
  }

  destroy(): void {
    this.screen.destroy();
  }

  private handleInput(value: string): void {
    // If pipeline is waiting for confirmation (pause), resolve the waiter
    if (this.inputResolver) {
      this.agentLog("user", value || "(continue)");
      const resolve = this.inputResolver;
      this.inputResolver = null;
      resolve(value);
      return;
    }

    if (!value) return;

    // Commands
    if (value.startsWith("/")) {
      const parts = value.slice(1).split(" ");
      const cmd = parts[0] ?? "";
      const args = parts.slice(1).join(" ");
      this.onCommand?.(cmd, args);
      return;
    }

    // Plain text behavior depends on pipeline state
    if (this.running) {
      // Pipeline running → queue as steering feedback
      this.agentLog("user", value);
      this.userMessages.push(value);
      this.log("{#666-fg}  (feedback queued for next agent checkpoint){/#666-fg}");
    } else {
      // No pipeline → auto-start /run
      this.agentLog("user", value);
      this.log("{#666-fg}  Starting pipeline...{/#666-fg}");
      this.onCommand?.("run", value);
    }
  }

  /** Wait for user input at a pause point. Next submit goes here, not to handleInput's normal flow. */
  waitForInput(): Promise<string> {
    return new Promise((resolve) => {
      this.inputResolver = resolve;
    });
  }
}
