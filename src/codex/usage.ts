/** Public, allowlisted metrics only. Missing counters remain unknown, never zero. */
export interface AccountUsage {
  summary: {
    lifetimeTokens: number | null; peakDailyTokens: number | null;
    longestRunningTurnSec: number | null; currentStreakDays: number | null; longestStreakDays: number | null;
  };
  dailyUsageBuckets: Array<{ startDate: string; tokens: number | null }> | null;
}
export interface QuotaWindow { usedPercent: number | null; windowDurationMins: number | null; resetsAt: number | null }
export interface QuotaBucket { limitId: string; primary: QuotaWindow | null; secondary: QuotaWindow | null }
export interface CodexUsageSnapshot {
  observedAt: string;
  scope: 'account';
  usage: AccountUsage | null;
  usageError: string | null;
  quota: QuotaBucket[] | null;
  quotaError: string | null;
}
export interface CodexTokenUsage {
  inputTokens: number | null; cachedInputTokens: number | null; cacheWriteInputTokens: number | null;
  outputTokens: number | null; reasoningOutputTokens: number | null; totalTokens: number | null;
}
/** A fresh ephemeral thread belongs to exactly one request. Replace cumulative
 * totals on update, never sum them or add reasoning/cache subcounts twice. */
export function normalizeTokenUsage(value: unknown): CodexTokenUsage {
  const row = object(value);
  return {
    inputTokens: counter(row.inputTokens), cachedInputTokens: counter(row.cachedInputTokens),
    cacheWriteInputTokens: counter(row.cacheWriteInputTokens), outputTokens: counter(row.outputTokens),
    reasoningOutputTokens: counter(row.reasoningOutputTokens), totalTokens: counter(row.totalTokens),
  };
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const counter = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const percentage = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function normalizeAccountUsage(value: unknown): AccountUsage {
  const data = object(value), summary = object(data.summary);
  return {
    summary: {
      lifetimeTokens: counter(summary.lifetimeTokens), peakDailyTokens: counter(summary.peakDailyTokens),
      longestRunningTurnSec: counter(summary.longestRunningTurnSec), currentStreakDays: counter(summary.currentStreakDays),
      longestStreakDays: counter(summary.longestStreakDays),
    },
    dailyUsageBuckets: Array.isArray(data.dailyUsageBuckets) ? data.dailyUsageBuckets.slice(0, 3660).flatMap((item) => {
      const row = object(item);
      return typeof row.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.startDate)
        ? [{ startDate: row.startDate, tokens: counter(row.tokens) }] : [];
    }) : null,
  };
}
export function normalizeRateLimits(value: unknown): QuotaBucket[] {
  const data = object(value);
  const map = object(data.rateLimitsByLimitId);
  const entries: Array<[string, unknown]> = Object.keys(map).length ? Object.entries(map) : data.rateLimits ? [['codex', data.rateLimits]] : [];
  const window = (v: unknown): QuotaWindow | null => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const row = object(v);
    return { usedPercent: percentage(row.usedPercent), windowDurationMins: counter(row.windowDurationMins), resetsAt: counter(row.resetsAt) };
  };
  return entries.slice(0, 100).map(([id, value]) => {
    const row = object(value);
    const limitId = typeof row.limitId === 'string' ? row.limitId : id;
    return { limitId: /^[a-zA-Z0-9_.:/-]{1,120}$/.test(limitId) ? limitId : 'unknown', primary: window(row.primary), secondary: window(row.secondary) };
  });
}
/** Account-wide delta, NOT attribution to a GemRouter request or quota conversion. */
export function accountTokenDelta(before: CodexUsageSnapshot, after: CodexUsageSnapshot): number | null {
  if (!Number.isFinite(Date.parse(before.observedAt)) || !Number.isFinite(Date.parse(after.observedAt))
    || Date.parse(after.observedAt) < Date.parse(before.observedAt)) return null;
  const a = before.usage?.summary.lifetimeTokens, b = after.usage?.summary.lifetimeTokens;
  return typeof a === 'number' && typeof b === 'number' && b >= a ? b - a : null;
}
