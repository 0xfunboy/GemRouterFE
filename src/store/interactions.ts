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
  feedback?: 'good' | 'bad';
  feedbackNotes?: string;
  error?: string;
}

interface PersistedState {
  interactions: InteractionRecord[];
}

interface RecordInteractionInput {
  requestId?: string;
  appId: string;
  appName: string;
  route: string;
  model: string;
  prompt: string;
  response?: string;
  usage?: UsageSummary;
  status: 'succeeded' | 'failed';
  statusCode: number;
  latencyMs?: number;
  origin?: string;
  provider?: string;
  error?: string;
}

const MAX_RECORDS = 1000;
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
  private state: PersistedState = { interactions: [] };
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
      error: input.error,
    };
    this.state.interactions.unshift(record);
    if (this.state.interactions.length > MAX_RECORDS) {
      this.state.interactions.length = MAX_RECORDS;
    }
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
      this.state = {
        interactions: Array.isArray(parsed.interactions) ? parsed.interactions : [],
      };
    } catch {
      this.state = { interactions: [] };
    }
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
