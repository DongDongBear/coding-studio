import fs from "node:fs";
import path from "node:path";
import type { AuthProfile, AuthProfilesData } from "./types.js";

export class AuthProfileStore {
  private data: AuthProfilesData;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): AuthProfilesData {
    if (!fs.existsSync(this.filePath)) {
      return { version: 2, profiles: {}, order: {}, lastGood: {} };
    }
    const raw = fs.readFileSync(this.filePath, "utf-8");
    return JSON.parse(raw) as AuthProfilesData;
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  getProfile(id: string): AuthProfile | undefined {
    return this.data.profiles[id];
  }

  getProviderOrder(provider: string): string[] {
    return this.data.order[provider] ?? [];
  }

  getLastGood(provider: string): string | undefined {
    return this.data.lastGood[provider];
  }

  resolveKey(profileId: string): string | undefined {
    const profile = this.data.profiles[profileId];
    if (!profile) return undefined;
    if (profile.type === "api_key") return profile.key;
    if (profile.type === "token") return profile.token;
    if (profile.type === "oauth") return profile.accessToken;
    return undefined;
  }

  addProfile(id: string, profile: AuthProfile): void {
    this.data.profiles[id] = profile;
    const provider = profile.provider;
    if (!this.data.order[provider]) {
      this.data.order[provider] = [];
    }
    if (!this.data.order[provider].includes(id)) {
      this.data.order[provider].push(id);
    }
    this.save();
  }

  removeProfile(id: string): void {
    const profile = this.data.profiles[id];
    if (!profile) return;
    delete this.data.profiles[id];
    const provider = profile.provider;
    if (this.data.order[provider]) {
      this.data.order[provider] = this.data.order[provider].filter((p) => p !== id);
    }
    if (this.data.lastGood[provider] === id) {
      delete this.data.lastGood[provider];
    }
    this.save();
  }

  setLastGood(provider: string, profileId: string): void {
    this.data.lastGood[provider] = profileId;
    this.save();
  }

  listProviders(): string[] {
    return [...new Set(Object.values(this.data.profiles).map((p) => p.provider))];
  }

  listProfiles(): Array<{ id: string; profile: AuthProfile }> {
    return Object.entries(this.data.profiles).map(([id, profile]) => ({ id, profile }));
  }
}
