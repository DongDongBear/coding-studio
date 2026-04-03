export interface ApiKeyProfile {
  type: "api_key";
  provider: string;
  key: string;
}

export interface TokenProfile {
  type: "token";
  provider: string;
  token: string;
  expires?: string;
}

export interface OAuthProfile {
  type: "oauth";
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expires?: string;
}

export type AuthProfile = ApiKeyProfile | TokenProfile | OAuthProfile;

export interface AuthProfilesData {
  version: number;
  profiles: Record<string, AuthProfile>;
  order: Record<string, string[]>;
  lastGood: Record<string, string>;
}

export interface RateLimitInfo {
  profileId: string;
  cooldownUntil: number; // epoch ms
}
