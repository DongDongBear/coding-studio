import { input } from "@inquirer/prompts";

const TIMEOUT_MS = 30 * 1000; // 30 seconds

/**
 * Pause execution and wait for user confirmation.
 * Auto-continues after 10 minutes if no response.
 * Returns true to continue, false to abort.
 */
export async function waitForConfirmation(message: string): Promise<boolean> {
  const timeoutMin = TIMEOUT_MS / 60_000;

  const result = await Promise.race([
    // User input path
    input({
      message: `${message}\n  Press Enter to continue, or type "abort" to stop (auto-continue in ${timeoutMin}min):`,
      default: "",
    }).then((answer) => ({ source: "user" as const, abort: answer.trim().toLowerCase() === "abort" })),

    // Timeout path
    new Promise<{ source: "timeout"; abort: false }>((resolve) => {
      const timer = setTimeout(() => resolve({ source: "timeout", abort: false }), TIMEOUT_MS);
      timer.unref();
    }),
  ]);

  if (result.source === "timeout") {
    console.log(`\n  [Auto-continue] No response in ${timeoutMin} minutes. Proceeding with best option.`);
  }

  return !result.abort;
}
