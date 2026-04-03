import { input } from "@inquirer/prompts";

/**
 * Pause execution and wait for user confirmation.
 * Returns true to continue, false to abort.
 */
export async function waitForConfirmation(message: string): Promise<boolean> {
  const answer = await input({
    message: `${message}\n  Press Enter to continue, or type "abort" to stop:`,
    default: "",
  });
  return answer.trim().toLowerCase() !== "abort";
}
