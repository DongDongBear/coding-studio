import { getProviders, getModels, getModel } from "@mariozechner/pi-ai";

export class ProviderRegistry {
  listProviders(): string[] {
    return getProviders();
  }

  listModels(provider?: string): Array<{
    id: string;
    name: string;
    provider: string;
    cost: { input: number; output: number };
    contextWindow: number;
  }> {
    const models = getModels(provider);
    return models.map((m: any) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      cost: { input: m.cost.input, output: m.cost.output },
      contextWindow: m.contextWindow,
    }));
  }

  resolveModel(provider: string, modelId: string) {
    try {
      return getModel(provider, modelId);
    } catch {
      return undefined;
    }
  }
}
