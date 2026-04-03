import { select, input, password, confirm } from "@inquirer/prompts";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { OAuthLoginCallbacks, OAuthProviderInterface } from "@mariozechner/pi-ai";
import open from "open";

// --- Provider definitions ---

interface ProviderChoice {
  name: string;
  value: string;
  methods: AuthMethod[];
}

type AuthMethod = "api_key" | "oauth" | "env_ref";

function buildProviderChoices(oauthProviders: OAuthProviderInterface[]): ProviderChoice[] {
  const oauthIds = new Set(oauthProviders.map((p) => p.id));

  const choices: ProviderChoice[] = [];

  // OAuth-capable providers first (subscription-based)
  for (const p of oauthProviders) {
    choices.push({
      name: `${p.name} [OAuth Login]`,
      value: p.id,
      methods: ["oauth", "api_key", "env_ref"],
    });
  }

  // API-key-only providers
  const apiKeyOnly = [
    { name: "OpenAI (API Key)", value: "openai" },
    { name: "Google (Gemini)", value: "google" },
    { name: "xAI (Grok)", value: "xai" },
    { name: "Mistral", value: "mistral" },
    { name: "Groq", value: "groq" },
    { name: "Custom (OpenAI-compatible)", value: "custom" },
  ];

  for (const p of apiKeyOnly) {
    if (!oauthIds.has(p.value)) {
      choices.push({ ...p, methods: ["api_key", "env_ref"] });
    }
  }

  return choices;
}

// --- OAuth CLI callbacks ---

function createOAuthCallbacks(): OAuthLoginCallbacks {
  return {
    onAuth: (info) => {
      console.log(`\n  Opening browser for authorization...`);
      console.log(`  URL: ${info.url}`);
      if (info.instructions) {
        console.log(`  ${info.instructions}`);
      }
      // Try to open browser, ignore errors (user can copy URL manually)
      open(info.url).catch(() => {
        console.log("  Could not open browser automatically. Please open the URL manually.");
      });
    },

    onPrompt: async (prompt) => {
      const answer = await input({
        message: prompt.message,
        default: prompt.placeholder ?? "",
      });
      return answer;
    },

    onProgress: (message) => {
      console.log(`  ${message}`);
    },

    onManualCodeInput: async () => {
      const code = await input({
        message: "Paste the authorization code from the browser:",
      });
      return code;
    },
  };
}

// --- Auth method selection ---

function getAuthMethodChoices(methods: AuthMethod[]) {
  const all = [
    { name: "OAuth Login (opens browser)", value: "oauth" as const },
    { name: "API Key (paste your key)", value: "api_key" as const },
    { name: "Environment Variable (reference)", value: "env_ref" as const },
  ];
  return all.filter((m) => methods.includes(m.value));
}

// --- Main setup flow ---

export async function runSetup(authStorage: AuthStorage): Promise<void> {
  console.log("\nWelcome to Coding Studio!\n");

  const oauthProviders = authStorage.getOAuthProviders();
  const providerChoices = buildProviderChoices(oauthProviders);

  let addMore = true;

  while (addMore) {
    const providerId = await select({
      message: "Select a provider to configure:",
      choices: providerChoices.map((p) => ({ name: p.name, value: p.value })),
    });

    const providerDef = providerChoices.find((p) => p.value === providerId)!;

    const method = await select({
      message: `Auth method for ${providerId}:`,
      choices: getAuthMethodChoices(providerDef.methods),
    });

    if (method === "oauth") {
      console.log(`\nStarting OAuth login for ${providerId}...`);
      try {
        await authStorage.login(providerId, createOAuthCallbacks());
        console.log(`\u2713 OAuth login successful for ${providerId}`);
      } catch (err: any) {
        console.log(`\u2717 OAuth login failed: ${err.message}`);
      }
    } else if (method === "api_key") {
      const key = await password({
        message: `Paste your ${providerId} API key:`,
      });
      authStorage.set(providerId, { type: "api_key", key });
      console.log(`\u2713 Saved ${providerId} credential`);
    } else if (method === "env_ref") {
      const envVar = await input({
        message: "Environment variable name:",
        default: `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`,
      });
      const currentValue = process.env[envVar];
      if (currentValue) {
        authStorage.set(providerId, { type: "api_key", key: currentValue });
        console.log(`\u2713 Resolved $${envVar} and saved for ${providerId}`);
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
    console.log(`  ${provider.padEnd(20)} ${cred.type.padEnd(10)} ${masked}`);
  }

  console.log("\nSetup complete! Run `coding-studio run \"your prompt\"` to start.\n");
}
