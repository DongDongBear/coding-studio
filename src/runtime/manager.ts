import { spawn, execSync, type ChildProcess } from "node:child_process";

export interface RuntimeConfig {
  install: { command: string };
  build: { command: string };
  start: {
    command: string;
    url: string;
    readyPattern: string;
    timeoutSec: number;
  };
  healthcheck: {
    type: "http" | "tcp" | "command";
    target: string;
  };
  captureLogs: boolean;
}

import type { RuntimeState as RuntimeStateArtifact } from "../artifacts/types.js";

export interface InternalRuntimeState {
  status: "starting" | "ready" | "failed" | "stopped";
  url?: string;
  pid?: number;
  startedAt?: string;
  logs: string[];
  error?: string;
}

export type { RuntimeStateArtifact };

export class RuntimeManager {
  private config: RuntimeConfig;
  private process: ChildProcess | null = null;
  private state: InternalRuntimeState = { status: "stopped", logs: [] };

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  getState(): InternalRuntimeState {
    return { ...this.state };
  }

  /** Run install + build commands synchronously */
  prepare(cwd: string): void {
    try {
      execSync(this.config.install.command, { cwd, stdio: "pipe" });
    } catch (err: any) {
      this.state = { status: "failed", logs: [], error: `Install failed: ${err.message}` };
      throw new Error(`Install failed: ${err.message}`);
    }
    try {
      execSync(this.config.build.command, { cwd, stdio: "pipe" });
    } catch (err: any) {
      this.state = { status: "failed", logs: [], error: `Build failed: ${err.message}` };
      throw new Error(`Build failed: ${err.message}`);
    }
  }

  /** Start dev server and wait for ready pattern */
  async start(cwd: string): Promise<InternalRuntimeState> {
    this.state = { status: "starting", logs: [], url: this.config.start.url };

    this.process = spawn(this.config.start.command, [], {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.state.pid = this.process.pid;
    this.state.startedAt = new Date().toISOString();

    return new Promise<InternalRuntimeState>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.state.status = "failed";
        this.state.error = `Timeout: ready pattern "${this.config.start.readyPattern}" not seen within ${this.config.start.timeoutSec}s`;
        reject(new Error(this.state.error));
      }, this.config.start.timeoutSec * 1000);

      const onData = (chunk: Buffer) => {
        const line = chunk.toString();
        if (this.config.captureLogs) {
          this.state.logs.push(line);
        }
        if (line.includes(this.config.start.readyPattern)) {
          clearTimeout(timeout);
          this.state.status = "ready";
          resolve(this.getState());
        }
      };

      this.process!.stdout?.on("data", onData);
      this.process!.stderr?.on("data", onData);

      this.process!.on("error", (err) => {
        clearTimeout(timeout);
        this.state.status = "failed";
        this.state.error = err.message;
        reject(err);
      });

      this.process!.on("exit", (code) => {
        clearTimeout(timeout);
        if (this.state.status === "starting") {
          this.state.status = "failed";
          this.state.error = `Process exited with code ${code} before ready`;
          reject(new Error(this.state.error));
        }
      });
    });
  }

  /** HTTP health check */
  async healthcheck(): Promise<{ ok: boolean; detail?: string }> {
    if (this.config.healthcheck.type !== "http") {
      return { ok: true, detail: "non-http healthcheck not implemented" };
    }
    try {
      const url = this.state.url
        ? new URL(this.config.healthcheck.target, this.state.url).toString()
        : this.config.healthcheck.target;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, detail: `${res.status} ${res.statusText}` };
    } catch (err: any) {
      return { ok: false, detail: err.message };
    }
  }

  /** Stop the running process */
  stop(): void {
    const proc = this.process;
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
      timer.unref(); // don't block Node exit
    }
    this.state.status = "stopped";
    this.process = null;
  }

  /** Get last N lines of captured logs */
  getRecentLogs(n: number = 50): string[] {
    return this.state.logs.slice(-n);
  }
}
