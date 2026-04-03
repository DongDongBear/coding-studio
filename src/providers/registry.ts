import { getProviders, getModels, getModel, type KnownProvider } from "@mariozechner/pi-ai";

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
    const providers: KnownProvider[] = provider
      ? [provider as KnownProvider]
      : getProviders();

    const allModels: any[] = [];
    for (const p of providers) {
      allModels.push(...getModels(p));
    }

    return allModels.map((m: any) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      cost: { input: m.cost.input, output: m.cost.output },
      contextWindow: m.contextWindow,
    }));
  }

  resolveModel(provider: string, modelId: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (getModel as any)(provider, modelId);
    } catch {
      return undefined;
    }
  }
}
