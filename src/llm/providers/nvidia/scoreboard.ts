import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  NvidiaHourBucket,
  NvidiaModelScore,
  NvidiaSampleSource,
  NvidiaScoreboardData,
} from './types.js';

// Newer samples dominate so the ranking follows intraday shifts instead of ancient history.
const EMA_ALPHA = 0.3;
// A model with too few samples in the current hour gets an optimistic exploration bonus
// so the router keeps probing it instead of locking onto the first winner forever.
const EXPLORATION_SAMPLE_THRESHOLD = 5;
const EXPLORATION_BONUS = 250;
const MAX_FAILURE_COOLDOWN_MS = 10 * 60_000;

function emptyBucket(): NvidiaHourBucket {
  return {
    samples: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    avgLatencyMs: null,
    avgTtfbMs: null,
    avgTokensPerSec: null,
  };
}

function emptyScore(): NvidiaModelScore {
  return {
    hours: {},
    overall: emptyBucket(),
    consecutiveFailures: 0,
    cooldownUntil: null,
    last429At: null,
    lastStatus: null,
    lastLatencyMs: null,
    lastErrorCode: null,
    lastAt: null,
  };
}

function ema(previous: number | null, sample: number): number {
  if (previous === null || !Number.isFinite(previous)) return sample;
  return previous * (1 - EMA_ALPHA) + sample * EMA_ALPHA;
}

function bucketScore(bucket: NvidiaHourBucket): number | null {
  if (bucket.samples === 0) return null;
  const successRate = bucket.successes / bucket.samples;
  const latency = bucket.avgTtfbMs ?? bucket.avgLatencyMs ?? 10_000;
  // Higher is better: perfect reliability with instant first token approaches 1000.
  return (successRate * 1000) / (1 + latency / 1000);
}

export class NvidiaScoreboard {
  private data: NvidiaScoreboardData;
  private readonly rateLimitCooldownMs: number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly storePath: string, options?: { rateLimitCooldownMs?: number }) {
    this.data = this.load();
    this.rateLimitCooldownMs = options?.rateLimitCooldownMs ?? 60_000;
  }

  private load(): NvidiaScoreboardData {
    if (existsSync(this.storePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as NvidiaScoreboardData;
        if (parsed && parsed.version === 1 && parsed.models && typeof parsed.models === 'object') {
          return parsed;
        }
      } catch {
        // Corrupt scoreboard is telemetry, not state we must preserve: start fresh.
      }
    }
    return { version: 1, updatedAt: null, models: {} };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.data.updatedAt = new Date().toISOString();
    writeFileSync(this.storePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  // Samples arrive on every request, hedge, and probe: coalesce disk writes instead
  // of re-serializing the whole scoreboard on each one. Telemetry may lose the last
  // second on a hard kill, which is acceptable.
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 1000);
    this.persistTimer.unref?.();
  }

  private scoreFor(model: string): NvidiaModelScore {
    const existing = this.data.models[model];
    if (existing) return existing;
    const created = emptyScore();
    this.data.models[model] = created;
    return created;
  }

  private touchBuckets(model: string, now: Date): NvidiaHourBucket[] {
    const score = this.scoreFor(model);
    const hourKey = String(now.getHours());
    const hourBucket = score.hours[hourKey] ?? (score.hours[hourKey] = emptyBucket());
    return [hourBucket, score.overall];
  }

  recordSuccess(model: string, input: {
    latencyMs: number;
    ttfbMs?: number | null;
    completionTokens?: number | null;
    source: NvidiaSampleSource;
  }): void {
    const now = new Date();
    const score = this.scoreFor(model);
    for (const bucket of this.touchBuckets(model, now)) {
      bucket.samples += 1;
      bucket.successes += 1;
      bucket.avgLatencyMs = ema(bucket.avgLatencyMs, input.latencyMs);
      if (typeof input.ttfbMs === 'number' && Number.isFinite(input.ttfbMs)) {
        bucket.avgTtfbMs = ema(bucket.avgTtfbMs, input.ttfbMs);
      }
      if (
        typeof input.completionTokens === 'number' &&
        input.completionTokens > 0 &&
        input.latencyMs > 0
      ) {
        bucket.avgTokensPerSec = ema(bucket.avgTokensPerSec, input.completionTokens / (input.latencyMs / 1000));
      }
    }
    score.consecutiveFailures = 0;
    score.cooldownUntil = null;
    score.lastStatus = 'success';
    score.lastLatencyMs = Math.round(input.latencyMs);
    score.lastErrorCode = null;
    score.lastAt = now.toISOString();
    this.schedulePersist();
  }

  recordFailure(model: string, input: {
    code: string;
    status?: number | null;
    latencyMs?: number | null;
    timeout?: boolean;
    retryAfterMs?: number | null;
    source: NvidiaSampleSource;
  }): void {
    const now = new Date();
    const score = this.scoreFor(model);
    for (const bucket of this.touchBuckets(model, now)) {
      bucket.samples += 1;
      bucket.failures += 1;
      if (input.timeout) bucket.timeouts += 1;
    }
    score.consecutiveFailures += 1;
    score.lastStatus = input.timeout ? 'timeout' : 'failure';
    score.lastLatencyMs = typeof input.latencyMs === 'number' ? Math.round(input.latencyMs) : null;
    score.lastErrorCode = input.code;
    score.lastAt = now.toISOString();

    if (input.status === 429) {
      score.last429At = now.toISOString();
      const waitMs = typeof input.retryAfterMs === 'number' && input.retryAfterMs > 0
        ? input.retryAfterMs
        : this.rateLimitCooldownMs;
      score.cooldownUntil = new Date(now.getTime() + waitMs).toISOString();
    } else {
      // Escalating pause: 15s, 30s, 60s, ... capped, so a stalled model stops eating hedge slots.
      const backoffMs = Math.min(MAX_FAILURE_COOLDOWN_MS, 15_000 * 2 ** (score.consecutiveFailures - 1));
      score.cooldownUntil = new Date(now.getTime() + backoffMs).toISOString();
    }
    this.schedulePersist();
  }

  isCoolingDown(model: string, now = Date.now()): boolean {
    const score = this.data.models[model];
    if (!score?.cooldownUntil) return false;
    return Date.parse(score.cooldownUntil) > now;
  }

  /**
   * Ranking score for a model at the given moment. Prefers the current-hour bucket,
   * falls back to the overall bucket, and grants an exploration bonus to models with
   * little data for this hour so the scoreboard keeps learning the daily pattern.
   */
  score(model: string, now = new Date()): number {
    const score = this.data.models[model];
    if (!score) return EXPLORATION_BONUS;
    const hourBucket = score.hours[String(now.getHours())];
    const hourScore = hourBucket ? bucketScore(hourBucket) : null;
    const overallScore = bucketScore(score.overall);
    let value = hourScore ?? overallScore ?? 0;
    if (!hourBucket || hourBucket.samples < EXPLORATION_SAMPLE_THRESHOLD) {
      value += EXPLORATION_BONUS * (1 - (hourBucket?.samples ?? 0) / EXPLORATION_SAMPLE_THRESHOLD);
    }
    return value;
  }

  rank(candidates: string[], now = new Date()): string[] {
    const nowMs = now.getTime();
    const usable = candidates.filter((model) => !this.isCoolingDown(model, nowMs));
    const pool = usable.length > 0 ? usable : candidates;
    return [...pool].sort((left, right) => this.score(right, now) - this.score(left, now));
  }

  snapshot(): NvidiaScoreboardData {
    return this.data;
  }

  /** Current-hour and overall bucket summaries for one model, for diagnostics/dashboard. */
  modelStats(model: string, now = new Date()): {
    hour: { samples: number; successRate: number; avgTtfbMs: number | null; avgLatencyMs: number | null } | null;
    overall: { samples: number; successRate: number; avgTtfbMs: number | null; avgLatencyMs: number | null } | null;
  } {
    const score = this.data.models[model];
    const summarize = (bucket: NvidiaHourBucket | undefined) => {
      if (!bucket || bucket.samples === 0) return null;
      return {
        samples: bucket.samples,
        successRate: Math.round((bucket.successes / bucket.samples) * 100) / 100,
        avgTtfbMs: bucket.avgTtfbMs === null ? null : Math.round(bucket.avgTtfbMs),
        avgLatencyMs: bucket.avgLatencyMs === null ? null : Math.round(bucket.avgLatencyMs),
      };
    };
    return {
      hour: summarize(score?.hours[String(now.getHours())]),
      overall: summarize(score?.overall),
    };
  }

  /** Per-hour ranking table: for each hour with data, models ordered by score. */
  hourlyReport(): Record<string, Array<{ model: string; score: number; samples: number; avgTtfbMs: number | null; successRate: number }>> {
    const report: Record<string, Array<{ model: string; score: number; samples: number; avgTtfbMs: number | null; successRate: number }>> = {};
    for (const [model, score] of Object.entries(this.data.models)) {
      for (const [hour, bucket] of Object.entries(score.hours)) {
        if (bucket.samples === 0) continue;
        (report[hour] ??= []).push({
          model,
          score: Math.round((bucketScore(bucket) ?? 0) * 10) / 10,
          samples: bucket.samples,
          avgTtfbMs: bucket.avgTtfbMs === null ? null : Math.round(bucket.avgTtfbMs),
          successRate: Math.round((bucket.successes / bucket.samples) * 100) / 100,
        });
      }
    }
    for (const entries of Object.values(report)) {
      entries.sort((left, right) => right.score - left.score);
    }
    return report;
  }

  reset(): void {
    this.data = { version: 1, updatedAt: null, models: {} };
    this.persist();
  }
}
