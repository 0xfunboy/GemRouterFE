import type { ModelTier } from '../../types.js';

export interface NvidiaModelConfig {
  /** Upstream model id, e.g. "deepseek-ai/deepseek-v4-pro". */
  id: string;
  tier: ModelTier;
  enabled: boolean;
  /** Optional short aliases resolved to this model (e.g. "deepseek-v4-pro"). */
  aliases?: string[];
  /** Include this model in the periodic latency probe. */
  probe?: boolean;
}

export interface NvidiaProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  /** Path to the curated model catalog file (data/nvidia-models.json). */
  modelsPath: string;
  models: NvidiaModelConfig[];
  defaultTier: ModelTier;
  /** Requests-per-minute budget for the whole key (NVIDIA free tier is ~40 RPM). */
  rpmLimit: number;
  /** Max parallel in-flight upstream calls on the key. */
  maxConcurrency: number;
  timeoutMs: number;
  /** Abort and fail over when the model produces no first token within this window. */
  firstTokenTimeoutMs: number;
  /** Cooldown applied to a model after a 429 without Retry-After. */
  rateLimitCooldownMs: number;
  scoreboardPath: string;
  probeEnabled: boolean;
  probeIntervalMs: number;
  probeMaxTokens: number;
  /** Hedged race for tier/alias requests: launch the next candidate if the first stalls. */
  raceEnabled: boolean;
  raceHedgeDelayMs: number;
  raceMaxCandidates: number;
}

export interface NvidiaUpstreamErrorSnapshot {
  status: number | null;
  code: string | null;
  message: string | null;
  model: string | null;
  at: string;
}

export type NvidiaSampleSource = 'traffic' | 'probe' | 'hedge';

export interface NvidiaHourBucket {
  samples: number;
  successes: number;
  failures: number;
  timeouts: number;
  avgLatencyMs: number | null;
  avgTtfbMs: number | null;
  avgTokensPerSec: number | null;
}

export interface NvidiaModelScore {
  hours: Record<string, NvidiaHourBucket>;
  overall: NvidiaHourBucket;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  last429At: string | null;
  lastStatus: 'success' | 'failure' | 'timeout' | null;
  lastLatencyMs: number | null;
  lastErrorCode: string | null;
  lastAt: string | null;
}

export interface NvidiaScoreboardData {
  version: 1;
  updatedAt: string | null;
  models: Record<string, NvidiaModelScore>;
}
