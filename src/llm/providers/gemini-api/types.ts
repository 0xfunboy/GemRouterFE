export type GeminiApiQuotaSource = 'static-config' | 'local-ledger' | 'upstream-error';

export interface GeminiApiRateLimit {
  rpm: number | null;
  tpm: number | null;
  rpd: number | null;
}

export interface GeminiApiKeyConfig {
  id: string;
  key: string;
  owner?: string;
  projectId?: string;
  quotaGroup: string;
  tier: string;
  priority: number;
  enabled: boolean;
  models?: string[];
}

export interface GeminiApiProviderConfig {
  enabled: boolean;
  keys: GeminiApiKeyConfig[];
  baseUrl: string;
  version: string;
  defaultTier: string;
  defaultQuotaGroupMode: 'per-key' | 'shared';
  limits: Record<string, GeminiApiRateLimit>;
  groupLimits: Record<string, Record<string, GeminiApiRateLimit>>;
  ledgerPath: string;
  discoveryCachePath: string;
  discoveryRefreshMs: number;
  quotaCooldownMs: number;
  rpdWindowMs: number;
  rpmWindowMs: number;
  tpmWindowMs: number;
  countTokensPreflight: boolean;
  countFailed429AsUsage: boolean;
  timeoutMs: number;
  streamTimeoutMs: number;
  fallbackModelIds: string[];
}

export interface GeminiApiModelInfo {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  supportedGenerationMethods: string[];
  source: GeminiApiQuotaSource;
  discoveredAt: string | null;
}

export interface GeminiApiUpstreamErrorSnapshot {
  status: number | null;
  code: string | null;
  message: string | null;
  googleStatus: string | null;
  googleReason: string | null;
  endpoint: string | null;
  model: string | null;
  keyId: string | null;
  quotaGroup: string | null;
  at: string;
}
