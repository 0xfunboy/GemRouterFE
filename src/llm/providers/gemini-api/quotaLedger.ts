import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getGeminiApiLimit } from './rateLimits.js';
import type { GeminiApiProviderConfig, GeminiApiQuotaSource, GeminiApiRateLimit } from './types.js';

export interface WindowCounterEvent {
  ts: number;
  count: number;
  tokens?: number;
  requestId?: string;
}

export interface WindowCounter {
  limit: number | null;
  events: WindowCounterEvent[];
}

export interface GeminiApiModelQuotaLedger {
  model: string;
  rpm: WindowCounter;
  tpm: WindowCounter;
  rpd: WindowCounter;
  cooldownUntil?: string;
  cooldownSource?: 'retry-after' | 'upstream-rate-limit' | 'pacific-reset' | 'high-demand';
  last429At?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureCode?: string;
  lastFailureReason?: string;
  lastFailureStatus?: number;
  // Authoritative limits/remaining from upstream response headers
  upstreamRpmLimit?: number;
  upstreamRpmRemaining?: number;
  upstreamTpmLimit?: number;
  upstreamTpmRemaining?: number;
  upstreamRpdLimit?: number;
  upstreamRpdRemaining?: number;
  upstreamHeadersRaw?: Record<string, string>;
  upstreamHeadersAt?: string;
}

export interface GeminiApiQuotaGroupLedger {
  quotaGroup: string;
  models: Record<string, GeminiApiModelQuotaLedger>;
}

export interface GeminiApiKeyLedger {
  keyId: string;
  lastUsedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureCode?: string;
  lastFailureStatus?: number;
}

export interface GeminiApiQuotaLedgerFile {
  version: 1;
  updatedAt: string;
  groups: Record<string, GeminiApiQuotaGroupLedger>;
  keys: Record<string, GeminiApiKeyLedger>;
}

export interface GeminiApiQuotaMetricSnapshot {
  used: number;
  limit: number | null;
  remaining: number | null;
}

export interface GeminiApiQuotaModelSnapshot {
  model: string;
  rpm: GeminiApiQuotaMetricSnapshot;
  tpm: GeminiApiQuotaMetricSnapshot;
  rpd: GeminiApiQuotaMetricSnapshot;
  cooldownUntil: string | null;
  cooldownSource: 'retry-after' | 'upstream-rate-limit' | 'pacific-reset' | 'high-demand' | null;
  last429At: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  lastFailureReason: string | null;
  lastFailureStatus: number | null;
  source: GeminiApiQuotaSource;
  authoritative: boolean;
  upstreamRpmLimit: number | null;
  upstreamRpmRemaining: number | null;
  upstreamRpdLimit: number | null;
  upstreamRpdRemaining: number | null;
  upstreamHeadersRaw: Record<string, string> | null;
  upstreamHeadersAt: string | null;
}

export interface GeminiApiQuotaGroupSnapshot {
  id: string;
  models: GeminiApiQuotaModelSnapshot[];
}

function nowIso(): string {
  return new Date().toISOString();
}

const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
/** Short skip window applied when Google returns 503 overloaded/unavailable for a model. */
const HIGH_DEMAND_COOLDOWN_MS = 30_000;

function pacificDateParts(epochMs: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function pacificOffsetMs(epochMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  ) - epochMs;
}

/** Gemini RPD resets at midnight in America/Los_Angeles, including PST/PDT changes. */
export function pacificDayStartMs(now = Date.now()): number {
  const { year, month, day } = pacificDateParts(now);
  const nominalUtcMidnight = Date.UTC(year, month - 1, day);
  return nominalUtcMidnight - pacificOffsetMs(nominalUtcMidnight);
}

export function nextPacificDayStartMs(now = Date.now()): number {
  const tomorrow = pacificDateParts(now + 30 * 60 * 60_000);
  const nominalUtcMidnight = Date.UTC(tomorrow.year, tomorrow.month - 1, tomorrow.day);
  return nominalUtcMidnight - pacificOffsetMs(nominalUtcMidnight);
}

function parseHeaderInt(headers: Record<string, string>, ...names: string[]): number | undefined {
  for (const name of names) {
    const v = headers[name] ?? headers[name.toLowerCase()];
    if (v !== undefined) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function emptyLedger(): GeminiApiQuotaLedgerFile {
  return {
    version: 1,
    updatedAt: nowIso(),
    groups: {},
    keys: {},
  };
}

function sumEvents(events: WindowCounterEvent[]): number {
  return events.reduce((total, event) => total + (event.tokens ?? event.count), 0);
}

function metric(counter: WindowCounter): GeminiApiQuotaMetricSnapshot {
  const used = sumEvents(counter.events);
  return {
    used,
    limit: counter.limit,
    remaining: counter.limit === null ? null : Math.max(0, counter.limit - used),
  };
}

export class GeminiApiQuotaLedger {
  private data: GeminiApiQuotaLedgerFile;

  constructor(private readonly config: GeminiApiProviderConfig) {
    this.data = this.load();
    this.pruneAll(Date.now());
    this.persist();
  }

  private load(): GeminiApiQuotaLedgerFile {
    if (!existsSync(this.config.ledgerPath)) return emptyLedger();
    try {
      const parsed = JSON.parse(readFileSync(this.config.ledgerPath, 'utf8')) as GeminiApiQuotaLedgerFile;
      if (parsed.version === 1 && parsed.groups && parsed.keys) return parsed;
    } catch {
      // fall through
    }
    return emptyLedger();
  }

  private persist(): void {
    mkdirSync(path.dirname(this.config.ledgerPath), { recursive: true });
    this.data.updatedAt = nowIso();
    writeFileSync(this.config.ledgerPath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  private getLimitForGroup(quotaGroup: string, model: string): import('./types.js').GeminiApiRateLimit {
    const groupOverride = this.config.groupLimits?.[quotaGroup];
    const bare = model.replace(/^models\//, '');
    if (groupOverride && (groupOverride[model] || groupOverride[bare])) {
      return groupOverride[model] ?? groupOverride[bare]!;
    }
    return getGeminiApiLimit(model, this.config.limits);
  }

  private getModelLedger(quotaGroup: string, model: string): GeminiApiModelQuotaLedger {
    const group = this.data.groups[quotaGroup] ?? {
      quotaGroup,
      models: {},
    };
    this.data.groups[quotaGroup] = group;
    const limit = this.getLimitForGroup(quotaGroup, model);
    const modelLedger = group.models[model] ?? {
      model,
      rpm: { limit: limit.rpm, events: [] },
      tpm: { limit: limit.tpm, events: [] },
      rpd: { limit: limit.rpd, events: [] },
    };
    modelLedger.rpm.limit = limit.rpm;
    modelLedger.tpm.limit = limit.tpm;
    modelLedger.rpd.limit = limit.rpd;
    group.models[model] = modelLedger;
    return modelLedger;
  }

  private getKeyLedger(keyId: string): GeminiApiKeyLedger {
    const key = this.data.keys[keyId] ?? { keyId };
    this.data.keys[keyId] = key;
    return key;
  }

  getKeyState(keyId: string): GeminiApiKeyLedger {
    const key = this.getKeyLedger(keyId);
    return { ...key };
  }

  private pruneCounter(counter: WindowCounter, windowMs: number, now: number): void {
    const cutoff = now - windowMs;
    counter.events = counter.events.filter((event) => event.ts >= cutoff);
  }

  // Google Gemini RPD resets at midnight Pacific time, not UTC.
  private pruneRpdCounter(counter: WindowCounter, now: number): void {
    counter.events = counter.events.filter((event) => event.ts >= pacificDayStartMs(now));
  }

  private pruneModel(model: GeminiApiModelQuotaLedger, now: number): void {
    this.pruneCounter(model.rpm, this.config.rpmWindowMs, now);
    this.pruneCounter(model.tpm, this.config.tpmWindowMs, now);
    this.pruneRpdCounter(model.rpd, now);
  }

  pruneAll(now = Date.now()): void {
    for (const group of Object.values(this.data.groups)) {
      for (const model of Object.values(group.models)) {
        this.pruneModel(model, now);
      }
    }
  }

  getAvailability(quotaGroup: string, model: string, estimatedTokens: number): {
    available: boolean;
    reason: string | null;
    rpmRemaining: number | null;
    tpmRemaining: number | null;
    rpdRemaining: number | null;
    cooldownUntil: string | null;
    cooldownSource: 'retry-after' | 'upstream-rate-limit' | 'pacific-reset' | 'high-demand' | null;
    limit: GeminiApiRateLimit;
  } {
    const now = Date.now();
    const ledger = this.getModelLedger(quotaGroup, model);
    this.pruneModel(ledger, now);
    const cooldownUntil = ledger.cooldownUntil ?? null;
    const groupLimit = this.getLimitForGroup(quotaGroup, model);
    if (cooldownUntil && Date.parse(cooldownUntil) > now) {
      return {
        available: false,
        reason: 'cooldown',
        rpmRemaining: metric(ledger.rpm).remaining,
        tpmRemaining: metric(ledger.tpm).remaining,
        rpdRemaining: metric(ledger.rpd).remaining,
        cooldownUntil,
        cooldownSource: ledger.cooldownSource ?? null,
        limit: groupLimit,
      };
    }
    const rpm = metric(ledger.rpm);
    const tpm = metric(ledger.tpm);
    const rpd = metric(ledger.rpd);
    const cooldownSource = ledger.cooldownSource ?? null;
    if (rpm.remaining !== null && rpm.remaining <= 0) return { available: false, reason: 'rpm', rpmRemaining: rpm.remaining, tpmRemaining: tpm.remaining, rpdRemaining: rpd.remaining, cooldownUntil, cooldownSource, limit: groupLimit };
    if (tpm.remaining !== null && tpm.remaining < estimatedTokens) return { available: false, reason: 'tpm', rpmRemaining: rpm.remaining, tpmRemaining: tpm.remaining, rpdRemaining: rpd.remaining, cooldownUntil, cooldownSource, limit: groupLimit };
    if (rpd.remaining !== null && rpd.remaining <= 0) return { available: false, reason: 'rpd', rpmRemaining: rpm.remaining, tpmRemaining: tpm.remaining, rpdRemaining: rpd.remaining, cooldownUntil, cooldownSource, limit: groupLimit };
    return { available: true, reason: null, rpmRemaining: rpm.remaining, tpmRemaining: tpm.remaining, rpdRemaining: rpd.remaining, cooldownUntil, cooldownSource, limit: groupLimit };
  }

  reserve(input: { quotaGroup: string; keyId: string; model: string; estimatedTokens: number; requestId: string }): void {
    const now = Date.now();
    const ledger = this.getModelLedger(input.quotaGroup, input.model);
    this.pruneModel(ledger, now);
    ledger.rpm.events.push({ ts: now, count: 1, requestId: input.requestId });
    if (ledger.rpd.limit !== null) ledger.rpd.events.push({ ts: now, count: 1, requestId: input.requestId });
    ledger.tpm.events.push({ ts: now, count: 1, tokens: input.estimatedTokens, requestId: input.requestId });
    this.getKeyLedger(input.keyId).lastUsedAt = nowIso();
    this.persist();
  }

  markSuccess(input: {
    quotaGroup: string;
    keyId: string;
    model: string;
    requestId: string;
    totalTokens?: number;
    upstreamHeaders?: Record<string, string>;
  }): void {
    const ledger = this.getModelLedger(input.quotaGroup, input.model);
    const now = nowIso();
    ledger.lastSuccessAt = now;
    if (typeof input.totalTokens === 'number' && Number.isFinite(input.totalTokens)) {
      const event = ledger.tpm.events.find((candidate) => candidate.requestId === input.requestId);
      if (event) event.tokens = input.totalTokens;
    }
    if (input.upstreamHeaders && Object.keys(input.upstreamHeaders).length > 0) {
      ledger.upstreamHeadersRaw = input.upstreamHeaders;
      ledger.upstreamHeadersAt = now;
      ledger.upstreamRpmLimit = parseHeaderInt(input.upstreamHeaders, 'x-ratelimit-limit-requests');
      ledger.upstreamRpmRemaining = parseHeaderInt(input.upstreamHeaders, 'x-ratelimit-remaining-requests');
      ledger.upstreamTpmLimit = parseHeaderInt(input.upstreamHeaders, 'x-ratelimit-limit-tokens');
      ledger.upstreamTpmRemaining = parseHeaderInt(input.upstreamHeaders, 'x-ratelimit-remaining-tokens');
      ledger.upstreamRpdLimit = parseHeaderInt(input.upstreamHeaders, 'x-ratelimit-limit-requests-day', 'x-ratelimit-limit-requests-per-day');
      ledger.upstreamRpdRemaining = parseHeaderInt(input.upstreamHeaders, 'x-ratelimit-remaining-requests-day', 'x-ratelimit-remaining-requests-per-day');
    }
    const key = this.getKeyLedger(input.keyId);
    key.lastSuccessAt = now;
    this.persist();
  }

  markFailure(input: {
    quotaGroup: string;
    keyId: string;
    model: string;
    requestId: string;
    code: string;
    reason?: string;
    status?: number;
    rateLimited?: boolean;
    retryAfterMs?: number;
    rateLimitScope?: 'minute' | 'day' | 'unknown';
    highDemand?: boolean;
  }): void {
    const ledger = this.getModelLedger(input.quotaGroup, input.model);
    const now = Date.now();
    const nowString = new Date(now).toISOString();
    ledger.lastFailureAt = nowString;
    ledger.lastFailureCode = input.code;
    ledger.lastFailureReason = input.reason;
    ledger.lastFailureStatus = input.status;
    // Google returned 503 "overloaded/unavailable" for this model. It is not a quota
    // problem and never executed, so apply a short cooldown to stop hammering the same
    // model on every request and let the fallback chain move on quickly.
    if (input.highDemand && !input.rateLimited) {
      ledger.cooldownUntil = new Date(now + HIGH_DEMAND_COOLDOWN_MS).toISOString();
      ledger.cooldownSource = 'high-demand';
      for (const counter of [ledger.rpm, ledger.tpm, ledger.rpd]) {
        counter.events = counter.events.filter((event) => event.requestId !== input.requestId);
      }
    }
    if (input.rateLimited) {
      ledger.last429At = nowString;
      if (typeof input.retryAfterMs === 'number' && input.retryAfterMs > 0) {
        ledger.cooldownUntil = new Date(now + input.retryAfterMs).toISOString();
        ledger.cooldownSource = 'retry-after';
      } else if (input.rateLimitScope === 'day') {
        ledger.cooldownUntil = new Date(nextPacificDayStartMs(now)).toISOString();
        ledger.cooldownSource = 'pacific-reset';
      } else {
        ledger.cooldownUntil = new Date(now + this.config.quotaCooldownMs).toISOString();
        ledger.cooldownSource = 'upstream-rate-limit';
      }
      if (!this.config.countFailed429AsUsage) {
        for (const counter of [ledger.rpm, ledger.tpm, ledger.rpd]) {
          counter.events = counter.events.filter((event) => event.requestId !== input.requestId);
        }
      }
    }
    const key = this.getKeyLedger(input.keyId);
    key.lastFailureAt = nowString;
    key.lastFailureCode = input.code;
    key.lastFailureStatus = input.status;
    this.persist();
  }

  clearCooldown(quotaGroup?: string, model?: string): void {
    for (const [groupId, group] of Object.entries(this.data.groups)) {
      if (quotaGroup && quotaGroup !== groupId) continue;
      for (const [modelId, modelLedger] of Object.entries(group.models)) {
        if (model && model !== modelId) continue;
        delete modelLedger.cooldownUntil;
        delete modelLedger.cooldownSource;
      }
    }
    this.persist();
  }

  reset(): void {
    this.data = emptyLedger();
    this.persist();
  }

  snapshot(): { apiKeys: GeminiApiKeyLedger[]; quotaGroups: GeminiApiQuotaGroupSnapshot[]; updatedAt: string } {
    this.pruneAll(Date.now());
    return {
      apiKeys: Object.values(this.data.keys),
      quotaGroups: Object.values(this.data.groups).map((group) => ({
        id: group.quotaGroup,
        models: Object.values(group.models).map((model) => {
          // Always reflect current configured limits (file may have stale values)
          const configuredLimit = this.getLimitForGroup(group.quotaGroup, model.model);
          model.rpm.limit = configuredLimit.rpm;
          model.tpm.limit = configuredLimit.tpm;
          model.rpd.limit = configuredLimit.rpd;
          return ({
          model: model.model,
          rpm: metric(model.rpm),
          tpm: metric(model.tpm),
          rpd: metric(model.rpd),
          cooldownUntil: model.cooldownUntil ?? null,
          cooldownSource: model.cooldownSource ?? null,
          last429At: model.last429At ?? null,
          lastSuccessAt: model.lastSuccessAt ?? null,
          lastFailureAt: model.lastFailureAt ?? null,
          lastFailureCode: model.lastFailureCode ?? null,
          lastFailureReason: model.lastFailureReason ?? null,
          lastFailureStatus: model.lastFailureStatus ?? null,
          source: 'local-ledger',
          authoritative: false,
          upstreamRpmLimit: model.upstreamRpmLimit ?? null,
          upstreamRpmRemaining: model.upstreamRpmRemaining ?? null,
          upstreamRpdLimit: model.upstreamRpdLimit ?? null,
          upstreamRpdRemaining: model.upstreamRpdRemaining ?? null,
          upstreamHeadersRaw: model.upstreamHeadersRaw ?? null,
          upstreamHeadersAt: model.upstreamHeadersAt ?? null,
        });
        }),
      })),
      updatedAt: this.data.updatedAt,
    };
  }
}
