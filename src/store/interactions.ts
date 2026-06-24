import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

interface UsageSummary {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface InteractionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
  appId: string;
  appName: string;
  route: string;
  model: string;
  requestedModel?: string;
  backendModel?: string;
  apiKeyId?: string;
  quotaGroup?: string;
  promptExcerpt: string;
  responseExcerpt: string;
  promptChars: number;
  responseChars: number;
  usage?: UsageSummary;
  status: 'succeeded' | 'failed';
  statusCode: number;
  latencyMs?: number;
  origin?: string;
  provider?: string;
  fallbackReason?: string;
  finishReason?: 'stop' | 'length' | 'content_filter';
  policyFallbackReason?: string;
  fallbackAttempts?: Array<{
    model: string;
    provider?: string;
    keyId?: string | null;
    quotaGroup?: string | null;
    reason: string;
    statusCode?: number | null;
    availableAfter?: string | null;
    availableAfterSource?: 'retry-after' | 'upstream-rate-limit' | 'pacific-reset' | null;
  }>;
  feedback?: 'good' | 'bad';
  feedbackNotes?: string;
  error?: string;
}

interface PersistedState {
  interactions: InteractionRecord[];
  hourlyMetrics?: HourlyMetricBucket[];
  hourlyMetricsStartedAtMs?: number;
}

interface HourlyMetricBucket {
  hourStartMs: number;
  requests: number;
  succeeded: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyTotalMs: number;
  latencySamples: number;
}

interface RecordInteractionInput {
  requestId?: string;
  appId: string;
  appName: string;
  route: string;
  model: string;
  requestedModel?: string;
  backendModel?: string;
  apiKeyId?: string;
  quotaGroup?: string;
  prompt: string;
  response?: string;
  usage?: UsageSummary;
  status: 'succeeded' | 'failed';
  statusCode: number;
  latencyMs?: number;
  origin?: string;
  provider?: string;
  fallbackReason?: string;
  finishReason?: InteractionRecord['finishReason'];
  policyFallbackReason?: string;
  fallbackAttempts?: InteractionRecord['fallbackAttempts'];
  error?: string;
}

const MAX_RECORDS = 1000;
const METRIC_RETENTION_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;
const MAX_PROMPT_EXCERPT = 1200;
const MAX_RESPONSE_EXCERPT = 1800;

function nowIso(): string {
  return new Date().toISOString();
}

function trimExcerpt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export class InteractionStore {
  private state: PersistedState = {
    interactions: [],
    hourlyMetrics: [],
    hourlyMetricsStartedAtMs: Date.now(),
  };
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  list(limit = 100): InteractionRecord[] {
    return this.state.interactions.slice(0, Math.max(1, limit));
  }

  record(input: RecordInteractionInput): InteractionRecord {
    const timestamp = nowIso();
    const record: InteractionRecord = {
      id: `itx_${randomUUID().replace(/-/g, '')}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      requestId: input.requestId,
      appId: input.appId,
      appName: input.appName,
      route: input.route,
      model: input.model,
      requestedModel: input.requestedModel,
      backendModel: input.backendModel,
      apiKeyId: input.apiKeyId,
      quotaGroup: input.quotaGroup,
      promptExcerpt: trimExcerpt(input.prompt, MAX_PROMPT_EXCERPT),
      responseExcerpt: trimExcerpt(input.response ?? '', MAX_RESPONSE_EXCERPT),
      promptChars: input.prompt.length,
      responseChars: (input.response ?? '').length,
      usage: input.usage,
      status: input.status,
      statusCode: input.statusCode,
      latencyMs: input.latencyMs,
      origin: input.origin,
      provider: input.provider,
      fallbackReason: input.fallbackReason,
      finishReason: input.finishReason,
      policyFallbackReason: input.policyFallbackReason,
      fallbackAttempts: input.fallbackAttempts,
      error: input.error,
    };
    this.state.interactions.unshift(record);
    if (this.state.interactions.length > MAX_RECORDS) {
      this.state.interactions.length = MAX_RECORDS;
    }
    this.recordHourlyMetric(record);
    this.save();
    return record;
  }

  setFeedback(id: string, feedback: 'good' | 'bad', notes?: string): InteractionRecord | null {
    const record = this.state.interactions.find((entry) => entry.id === id);
    if (!record) return null;
    record.feedback = feedback;
    record.feedbackNotes = notes?.trim() || undefined;
    record.updatedAt = nowIso();
    this.save();
    return record;
  }

  clearFeedback(id: string): InteractionRecord | null {
    const record = this.state.interactions.find((entry) => entry.id === id);
    if (!record) return null;
    delete record.feedback;
    delete record.feedbackNotes;
    record.updatedAt = nowIso();
    this.save();
    return record;
  }

  clear(): void {
    this.state = {
      interactions: [],
      hourlyMetrics: [],
      hourlyMetricsStartedAtMs: Date.now(),
    };
    this.save();
  }

  /**
   * Aggregate usage for the current hour plus the preceding complete clock hours. This is separate
   * from the 1,000-record interaction viewer, so dashboard totals do not freeze at its retention
   * cap when traffic is high.
   */
  hourlyWindow(hours = 24): {
    totals: {
      requests: number;
      succeeded: number;
      failed: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      avgLatencyMs: number;
    };
    buckets: Array<{ hourStartMs: number; requests: number; failed: number }>;
    startedAtMs: number;
    complete: boolean;
  } {
    const count = Math.max(1, Math.min(METRIC_RETENTION_HOURS, Math.floor(hours)));
    const currentHour = floorHour(Date.now());
    const startHour = currentHour - (count - 1) * HOUR_MS;
    const byHour = new Map(
      (this.state.hourlyMetrics ?? []).map((bucket) => [bucket.hourStartMs, bucket]),
    );
    const totals = emptyTotals();
    let latencyTotalMs = 0;
    let latencySamples = 0;
    const buckets = Array.from({ length: count }, (_, index) => {
      const hourStartMs = startHour + index * HOUR_MS;
      const bucket = byHour.get(hourStartMs);
      if (bucket) {
        totals.requests += bucket.requests;
        totals.succeeded += bucket.succeeded;
        totals.failed += bucket.failed;
        totals.promptTokens += bucket.promptTokens;
        totals.completionTokens += bucket.completionTokens;
        totals.totalTokens += bucket.totalTokens;
        latencyTotalMs += bucket.latencyTotalMs;
        latencySamples += bucket.latencySamples;
      }
      return {
        hourStartMs,
        requests: bucket?.requests ?? 0,
        failed: bucket?.failed ?? 0,
      };
    });
    totals.avgLatencyMs = latencySamples > 0 ? Math.round(latencyTotalMs / latencySamples) : 0;
    const startedAtMs = this.state.hourlyMetricsStartedAtMs ?? Date.now();
    return {
      totals,
      buckets,
      startedAtMs,
      complete: Date.now() - startedAtMs >= count * HOUR_MS,
    };
  }

  summary(limit = 50): {
    totals: {
      requests: number;
      succeeded: number;
      failed: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      avgLatencyMs: number;
    };
    feedback: {
      good: number;
      bad: number;
      unrated: number;
    };
    byApp: Array<{
      appId: string;
      appName: string;
      requests: number;
      succeeded: number;
      failed: number;
      totalTokens: number;
    }>;
    recent: InteractionRecord[];
  } {
    const totals = {
      requests: 0,
      succeeded: 0,
      failed: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      avgLatencyMs: 0,
    };
    const feedback = {
      good: 0,
      bad: 0,
      unrated: 0,
    };
    const byApp = new Map<string, { appId: string; appName: string; requests: number; succeeded: number; failed: number; totalTokens: number }>();
    let latencySamples = 0;
    let latencyTotal = 0;

    for (const record of this.state.interactions) {
      totals.requests += 1;
      if (record.status === 'succeeded') totals.succeeded += 1;
      if (record.status === 'failed') totals.failed += 1;
      totals.promptTokens += record.usage?.prompt_tokens ?? 0;
      totals.completionTokens += record.usage?.completion_tokens ?? 0;
      totals.totalTokens += record.usage?.total_tokens ?? 0;
      if (typeof record.latencyMs === 'number' && Number.isFinite(record.latencyMs)) {
        latencySamples += 1;
        latencyTotal += record.latencyMs;
      }
      if (record.feedback === 'good') feedback.good += 1;
      else if (record.feedback === 'bad') feedback.bad += 1;
      else feedback.unrated += 1;

      const current =
        byApp.get(record.appId) ??
        {
          appId: record.appId,
          appName: record.appName,
          requests: 0,
          succeeded: 0,
          failed: 0,
          totalTokens: 0,
        };
      current.requests += 1;
      if (record.status === 'succeeded') current.succeeded += 1;
      if (record.status === 'failed') current.failed += 1;
      current.totalTokens += record.usage?.total_tokens ?? 0;
      byApp.set(record.appId, current);
    }

    totals.avgLatencyMs = latencySamples > 0 ? Math.round(latencyTotal / latencySamples) : 0;

    return {
      totals,
      feedback,
      byApp: [...byApp.values()].sort((left, right) => right.requests - left.requests),
      recent: this.list(limit),
    };
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      const persistedMetrics = Array.isArray(parsed.hourlyMetrics) ? parsed.hourlyMetrics : [];
      const hasHourlyLedger = Array.isArray(parsed.hourlyMetrics);
      this.state = {
        interactions: Array.isArray(parsed.interactions) ? parsed.interactions : [],
        hourlyMetrics: persistedMetrics.filter(isHourlyMetricBucket),
        hourlyMetricsStartedAtMs:
          typeof parsed.hourlyMetricsStartedAtMs === 'number'
            ? parsed.hourlyMetricsStartedAtMs
            : Date.now(),
      };
      // The old file retains only 1,000 excerpts, so it cannot reconstruct an exact 24-hour
      // counter. Start an honest ledger at migration time rather than publishing another capped
      // approximation as if it were live telemetry.
      if (!hasHourlyLedger) this.save();
    } catch {
      this.state = {
        interactions: [],
        hourlyMetrics: [],
        hourlyMetricsStartedAtMs: Date.now(),
      };
    }
  }

  private recordHourlyMetric(record: InteractionRecord): void {
    const createdAt = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAt)) return;
    const hourStartMs = floorHour(createdAt);
    let bucket = this.state.hourlyMetrics?.find((entry) => entry.hourStartMs === hourStartMs);
    if (!bucket) {
      bucket = emptyHourlyMetricBucket(hourStartMs);
      (this.state.hourlyMetrics ??= []).push(bucket);
    }
    bucket.requests += 1;
    if (record.status === 'succeeded') bucket.succeeded += 1;
    if (record.status === 'failed') bucket.failed += 1;
    bucket.promptTokens += record.usage?.prompt_tokens ?? 0;
    bucket.completionTokens += record.usage?.completion_tokens ?? 0;
    bucket.totalTokens += record.usage?.total_tokens ?? 0;
    if (typeof record.latencyMs === 'number' && Number.isFinite(record.latencyMs)) {
      bucket.latencyTotalMs += record.latencyMs;
      bucket.latencySamples += 1;
    }
    const minHour = floorHour(Date.now()) - (METRIC_RETENTION_HOURS - 1) * HOUR_MS;
    this.state.hourlyMetrics = (this.state.hourlyMetrics ?? [])
      .filter((entry) => entry.hourStartMs >= minHour)
      .sort((left, right) => left.hourStartMs - right.hourStartMs);
  }

  private save(): void {
    const payload = JSON.stringify(this.state, null, 2);
    this.saveQueue = this.saveQueue
      .then(() => writeFile(this.filePath, payload, 'utf8'))
      .catch((error) => {
        console.error('[interaction-store] save failed:', error);
      });
  }
}

function emptyTotals() {
  return {
    requests: 0,
    succeeded: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    avgLatencyMs: 0,
  };
}

function emptyHourlyMetricBucket(hourStartMs: number): HourlyMetricBucket {
  return {
    hourStartMs,
    requests: 0,
    succeeded: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencyTotalMs: 0,
    latencySamples: 0,
  };
}

function floorHour(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

function isHourlyMetricBucket(value: unknown): value is HourlyMetricBucket {
  if (!value || typeof value !== 'object') return false;
  const bucket = value as Partial<HourlyMetricBucket>;
  return (
    typeof bucket.hourStartMs === 'number' &&
    typeof bucket.requests === 'number' &&
    typeof bucket.succeeded === 'number' &&
    typeof bucket.failed === 'number' &&
    typeof bucket.promptTokens === 'number' &&
    typeof bucket.completionTokens === 'number' &&
    typeof bucket.totalTokens === 'number' &&
    typeof bucket.latencyTotalMs === 'number' &&
    typeof bucket.latencySamples === 'number'
  );
}
