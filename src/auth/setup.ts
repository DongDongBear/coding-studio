import { select, input, password, confirm } from "@inquirer/prompts";
import { AuthProfileStore } from "./profiles.js";

const KNOWN_PROVIDERS = [
  { name: "Anthropic", value: "anthropic" },
  { name: "OpenAI", value: "openai" },
  { name: "Google (Gemini)", value: "google" },
  { name: "xAI (Grok)", value: "xai" },
  { name: "Custom (OpenAI-compatible)", value: "custom" },
];

const AUTH_METHODS = [
  { name: "API Key (paste your key)", value: "api_key" },
  { name: "Setup Token (from claude setup-token)", value: "token" },
  { name: "Environment Variable (reference)", value: "env_ref" },
];

export async function runSetup(profilesPath: string): Promise<void> {
  console.log("\nWelcome to Coding Studio!\n");

  const store = new AuthProfileStore(profilesPath);
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

    const profileName = await input({
      message: "Profile name (e.g. main, backup):",
      default: "main",
    });

    const profileId = `${provider}:${profileName}`;

    if (method === "api_key") {
      const key = await password({
        message: `Paste your ${provider} API key:`,
      });
      store.addProfile(profileId, { type: "api_key", provider, key });
      console.log(`\u2713 Saved ${profileId} to auth-profiles.json`);
    } else if (method === "token") {
      const token = await password({
        message: `Paste your ${provider} setup token:`,
      });
      const expiresIn = await input({
        message: "Token expires (ISO date, or leave blank for no expiry):",
        default: "",
      });
      store.addProfile(profileId, {
        type: "token",
        provider,
        token,
        ...(expiresIn ? { expires: expiresIn } : {}),
      });
      console.log(`\u2713 Saved ${profileId} to auth-profiles.json`);
    } else if (method === "env_ref") {
      const envVar = await input({
        message: "Environment variable name:",
        default: `${provider.toUpperCase()}_API_KEY`,
      });
      const currentValue = process.env[envVar];
      if (currentValue) {
        store.addProfile(profileId, { type: "api_key", provider, key: currentValue });
        console.log(`\u2713 Resolved $${envVar} and saved ${profileId}`);
      } else {
        console.log(`\u2717 $${envVar} is not set. Skipping.`);
      }
    }

    addMore = await confirm({ message: "Add another provider?", default: false });
  }

  // Summary
  console.log("\nConfigured profiles:");
  const profiles = store.listProfiles();
  for (const { id, profile } of profiles) {
    const keyPreview = store.resolveKey(id);
    const masked = keyPreview ? keyPreview.slice(0, 8) + "..." : "N/A";
    console.log(`  ${profile.provider.padEnd(14)} ${id.padEnd(24)} ${profile.type.padEnd(10)} ${masked}`);
  }

  console.log("\nSetup complete! Run `coding-studio run \"your prompt\"` to start.\n");
}
