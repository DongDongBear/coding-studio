import { select, input, password, confirm } from "@inquirer/prompts";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";

const KNOWN_PROVIDERS = [
  { name: "Anthropic", value: "anthropic" },
  { name: "OpenAI", value: "openai" },
  { name: "Google (Gemini)", value: "google" },
  { name: "xAI (Grok)", value: "xai" },
  { name: "Custom (OpenAI-compatible)", value: "custom" },
];

const AUTH_METHODS = [
  { name: "API Key (paste your key)", value: "api_key" },
  { name: "Setup Token (OAuth token from claude setup-token)", value: "token" },
  { name: "Environment Variable (reference)", value: "env_ref" },
];

export async function runSetup(authStorage: AuthStorage): Promise<void> {
  console.log("\nWelcome to Coding Studio!\n");

  let addMore = true;

  while (addMore) {
    const provider = await select({
      message: "Select a provider to configure:",
      choices: KNOWN_PROVIDERS,
    });

    const method = await select({
      message: `Auth method for ${provider}:`,
      choices: AUTH_METHODS,
    });

    if (method === "api_key") {
      const key = await password({
        message: `Paste your ${provider} API key:`,
      });
      authStorage.set(provider, { type: "api_key", key });
      console.log(`\u2713 Saved ${provider} credential`);
    } else if (method === "token") {
      const token = await password({
        message: `Paste your ${provider} OAuth/setup token:`,
      });
      authStorage.set(provider, { type: "api_key", key: token });
      console.log(`\u2713 Saved ${provider} token (pi will auto-detect OAuth via sk-ant-oat prefix)`);
    } else if (method === "env_ref") {
      const envVar = await input({
        message: "Environment variable name:",
        default: `${provider.toUpperCase()}_API_KEY`,
      });
      const currentValue = process.env[envVar];
      if (currentValue) {
        authStorage.set(provider, { type: "api_key", key: currentValue });
        console.log(`\u2713 Resolved $${envVar} and saved for ${provider}`);
      } else {
        console.log(`\u2717 $${envVar} is not set. Skipping.`);
      }
    }

    addMore = await confirm({ message: "Add another provider?", default: false });
  }

  // Summary
  console.log("\nConfigured providers:");
  const all = authStorage.getAll();
  for (const [provider, cred] of Object.entries(all)) {
    const key = await authStorage.getApiKey(provider);
    const masked = key ? key.slice(0, 8) + "..." : "N/A";
    console.log(`  ${provider.padEnd(14)} ${cred.type.padEnd(10)} ${masked}`);
  }

  console.log("\nSetup complete! Run `coding-studio run \"your prompt\"` to start.\n");
}
