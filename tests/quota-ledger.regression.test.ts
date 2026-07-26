import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { GeminiApiQuotaLedger } from '../src/llm/providers/gemini-api/quotaLedger.js';
import type { GeminiApiProviderConfig } from '../src/llm/providers/gemini-api/types.js';

const workDirs: string[] = [];
after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

/** Ledger backed by a throwaway file, with generous limits so RPM/RPD never interfere. */
function makeLedger(limits?: Record<string, { rpm: number | null; tpm: number | null; rpd: number | null }>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-ledger-'));
  workDirs.push(dir);
  const config = {
    enabled: true,
    keys: [{ id: 'account1', key: 'k1', quotaGroup: 'group1', enabled: true, priority: 100 }],
    accountsPath: path.join(dir, 'accounts.json'),
    baseUrl: 'https://example.invalid',
    version: 'v1beta',
    defaultTier: 'free',
    defaultQuotaGroupMode: 'per-key',
    limits: limits ?? { 'gemma-4-31b-it': { rpm: 15, tpm: null, rpd: 1500 } },
    groupLimits: {},
    ledgerPath: path.join(dir, 'ledger.json'),
    discoveryCachePath: path.join(dir, 'discovery.json'),
    discoveryRefreshMs: 60_000,
    accountModelsCachePath: path.join(dir, 'account-models.json'),
    accountModelsRefreshMs: 60_000,
    quotaCooldownMs: 60_000,
    rpdWindowMs: 86_400_000,
    rpmWindowMs: 60_000,
    tpmWindowMs: 60_000,
    countTokensPreflight: false,
    countFailed429AsUsage: false,
    timeoutMs: 30_000,
    streamTimeoutMs: 30_000,
    fallbackModelIds: [],
    strictModelIds: [],
  } as unknown as GeminiApiProviderConfig;
  return new GeminiApiQuotaLedger(config);
}

function strike(ledger: GeminiApiQuotaLedger, model: string, requestId: string): void {
  ledger.markFailure({
    quotaGroup: 'group1',
    keyId: 'account1',
    model,
    requestId,
    code: 'gemini_api_rate_limited',
    reason: 'RESOURCE_EXHAUSTED',
    status: 429,
    rateLimited: true,
    rateLimitScope: 'unknown',
  });
}

interface RawModelLedger {
  rateLimitStrikes?: number;
  dailyDepleted?: boolean;
  cooldownUntil?: string;
  cooldownSource?: string;
  last429At?: string;
}

/**
 * These assertions are about ledger internals (the strike ladder is deliberately not part
 * of the public snapshot), so the tests read the raw state rather than the dashboard view.
 */
function stateOf(ledger: GeminiApiQuotaLedger, model: string): RawModelLedger {
  const raw = ledger as unknown as { data: { groups: Record<string, { models: Record<string, RawModelLedger> }> } };
  return raw.data.groups.group1.models[model];
}

/** Backdate the last-429 timestamp to simulate a quiet period between bursts. */
function ageLast429(ledger: GeminiApiQuotaLedger, model: string, minutesAgo: number): void {
  stateOf(ledger, model).last429At = new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('quota ledger: generic 429 strike ladder', () => {
  it('escalates the cooldown while 429s keep arriving', () => {
    const ledger = makeLedger();
    strike(ledger, 'gemma-4-31b-it', 'r1');
    const first = stateOf(ledger, 'gemma-4-31b-it');
    assert.equal(first?.rateLimitStrikes, 1, 'first 429 is one strike');

    strike(ledger, 'gemma-4-31b-it', 'r2');
    strike(ledger, 'gemma-4-31b-it', 'r3');
    const third = stateOf(ledger, 'gemma-4-31b-it');
    assert.equal(third?.rateLimitStrikes, 3, 'back-to-back 429s compound');
    assert.equal(third?.cooldownSource, '429-backoff');
  });

  // Regression: a hedged model (gemma-4-31b-it loses the race to a faster sibling) never
  // reports a success, so strikes could only ever grow. One transient burst pinned it to
  // the top rung for the rest of the Pacific day while the model itself was healthy and
  // its RPD sat at 0 — the router then served every request from a weaker fallback.
  it('restarts the ladder after a quiet period, without needing a success', () => {
    const ledger = makeLedger();
    strike(ledger, 'gemma-4-31b-it', 'r1');
    strike(ledger, 'gemma-4-31b-it', 'r2');
    strike(ledger, 'gemma-4-31b-it', 'r3');
    assert.equal(stateOf(ledger, 'gemma-4-31b-it')?.rateLimitStrikes, 3);

    ageLast429(ledger, 'gemma-4-31b-it', 11); // older than the 10 min decay window
    strike(ledger, 'gemma-4-31b-it', 'r4');

    const after429 = stateOf(ledger, 'gemma-4-31b-it');
    assert.equal(after429?.rateLimitStrikes, 1, 'stale strikes decay instead of compounding');
    const cooldownMs = Date.parse(String(after429?.cooldownUntil)) - Date.now();
    assert.ok(cooldownMs <= 61_000, `expected the first ladder rung (~60s), got ${cooldownMs}ms`);
  });

  it('keeps compounding when 429s stay inside the decay window', () => {
    const ledger = makeLedger();
    strike(ledger, 'gemma-4-31b-it', 'r1');
    strike(ledger, 'gemma-4-31b-it', 'r2');
    ageLast429(ledger, 'gemma-4-31b-it', 2); // still recent: real, ongoing pressure
    strike(ledger, 'gemma-4-31b-it', 'r3');
    assert.equal(stateOf(ledger, 'gemma-4-31b-it')?.rateLimitStrikes, 3);
  });

  it('clears strikes and the backoff cooldown on a success', () => {
    const ledger = makeLedger();
    strike(ledger, 'gemma-4-31b-it', 'r1');
    strike(ledger, 'gemma-4-31b-it', 'r2');
    ledger.markSuccess({ quotaGroup: 'group1', keyId: 'account1', model: 'gemma-4-31b-it', requestId: 'r3' });
    const state = stateOf(ledger, 'gemma-4-31b-it');
    assert.equal(state?.rateLimitStrikes, 0);
    assert.ok(!state?.cooldownUntil, 'a success releases the 429 backoff');
  });

  // Regression: an unknown-scope 429 must never be read as daily exhaustion — that parked
  // healthy accounts until the Pacific reset and emptied the pool for the rest of the day.
  it('never marks a model daily-depleted from an unknown-scope 429', () => {
    const ledger = makeLedger();
    for (let i = 0; i < 5; i += 1) strike(ledger, 'gemma-4-31b-it', `r${i}`);
    const state = stateOf(ledger, 'gemma-4-31b-it');
    assert.equal(state?.dailyDepleted, false);
    assert.equal(state?.cooldownSource, '429-backoff');
  });

  // Regression: Google reports day-scope 429s for models whose real ceiling is lower than
  // the configured one. Trusting those blindly removed accounts with untouched quota for a
  // whole day, so a low local RPD downgrades it to a bounded cooldown instead.
  it('treats a day-scope 429 with low local usage as suspect, not a full-day park', () => {
    const ledger = makeLedger();
    ledger.markFailure({
      quotaGroup: 'group1',
      keyId: 'account1',
      model: 'gemma-4-31b-it',
      requestId: 'r1',
      code: 'gemini_api_rate_limited',
      reason: 'RESOURCE_EXHAUSTED',
      status: 429,
      rateLimited: true,
      rateLimitScope: 'day',
    });
    const state = stateOf(ledger, 'gemma-4-31b-it');
    assert.equal(state?.cooldownSource, 'daily-depleted', 'bounded cooldown, not pacific-reset');
    const cooldownMs = Date.parse(String(state?.cooldownUntil)) - Date.now();
    assert.ok(cooldownMs <= 31 * 60_000, `expected a bounded window, got ${cooldownMs}ms`);
  });
});
