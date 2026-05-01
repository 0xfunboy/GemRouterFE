export type GeminiCliOutputFormat = 'json' | 'text';
export type GeminiCliAuthBootstrapMode = 'operator' | 'playwright';

export interface GeminiCliProviderConfig {
  enabled: boolean;
  bin: string;
  model: string;
  timeoutMs: number;
  workdir?: string;
  outputFormat: GeminiCliOutputFormat;
  useStdin: boolean;
  expectAuthCache: boolean;
  authBootstrapEnabled: boolean;
  authBootstrapMode: GeminiCliAuthBootstrapMode;
  userHome?: string;
  dotGeminiDir?: string;
  rootDir: string;
}

export interface GeminiCliHealthSnapshot {
  enabled: boolean;
  bin: string;
  resolvedBin: string | null;
  installed: boolean;
  version: string | null;
  model: string;
  timeoutMs: number;
  workdir: string;
  userHome: string | null;
  dotGeminiDir: string;
  settingsExists: boolean;
  authCacheDetected: boolean;
  authCacheFiles: string[];
  authReady: boolean;
  outputFormat: GeminiCliOutputFormat;
  useStdin: boolean;
  bootstrapEnabled: boolean;
  bootstrapMode: GeminiCliAuthBootstrapMode;
  loginHint: string;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastLatencyMs: number | null;
}
