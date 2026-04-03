export interface RateLimitInfo {
  provider: string;
  cooldownUntil: number; // epoch ms
}
