export type GeminiCliAuthBootstrapMode = 'operator' | 'playwright';

export interface GeminiQuotaBucket {
  modelId: string | null;
  remainingAmount: string | null;
  remainingFraction: number | null;
  resetTime: string | null;
  tokenType: string | null;
}

export interface GeminiAvailableCredit {
  creditType: string;
  creditAmount: string;
}

export interface GeminiCliProviderConfig {
  enabled: boolean;
  model: string;
  models: string[];
  timeoutMs: number;
  quotaRefreshMs: number;
  expectAuthCache: boolean;
  authBootstrapEnabled: boolean;
  authBootstrapMode: GeminiCliAuthBootstrapMode;
  userHome?: string;
  dotGeminiDir?: string;
  authClientId?: string;
  authClientSecret?: string;
  callbackHost: string;
  callbackPort?: number;
  autoOpenBrowser: boolean;
  rootDir: string;
}

export interface GeminiCliHealthSnapshot {
  enabled: boolean;
  runtime: 'embedded-codeassist';
  externalDependency: false;
  available: boolean;
  model: string;
  models: string[];
  timeoutMs: number;
  quotaRefreshMs: number;
  userHome: string | null;
  dotGeminiDir: string;
  settingsExists: boolean;
  authCacheDetected: boolean;
  authCacheFiles: string[];
  selectedAuthType: string | null;
  activeAccount: string | null;
  authReady: boolean;
  authVerifiedAt: string | null;
  callbackHost: string;
  callbackPort: number | null;
  autoOpenBrowser: boolean;
  bootstrapEnabled: boolean;
  bootstrapMode: GeminiCliAuthBootstrapMode;
  projectId: string | null;
  userTier: string | null;
  userTierName: string | null;
  availableCredits: GeminiAvailableCredit[];
  quotaBuckets: GeminiQuotaBucket[];
  quotaUpdatedAt: string | null;
  quotaLastError: string | null;
  lastResolvedModel: string | null;
  loginHint: string;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastLatencyMs: number | null;
}
