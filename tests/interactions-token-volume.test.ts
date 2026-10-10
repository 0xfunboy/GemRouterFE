import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { InteractionStore } from '../src/store/interactions.js';

const HOUR_MS = 60 * 60 * 1000;

function fixture(t: TestContext, state: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-token-volume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'interactions.json');
  writeFileSync(file, JSON.stringify({
    interactions: [],
    hourlyMetrics: [],
    hourlyMetricsStartedAtMs: Date.now() - 72 * HOUR_MS,
    ...state,
  }));
  return { file, store: new InteractionStore(file) };
}

function bucket(overrides: Record<string, number> = {}) {
  return {
    hourStartMs: Math.floor(Date.now() / HOUR_MS) * HOUR_MS,
    requests: 1,
    succeeded: 1,
    failed: 0,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    latencyTotalMs: 20,
    latencySamples: 1,
    usageUnavailableRequests: 0,
    ...overrides,
  };
}

describe('guest hourly measured token volume', () => {
  it('preserves measured tokens when an unmetered request makes the exact total unknown', (t) => {
    const { store } = fixture(t, {
      hourlyMetrics: [
        bucket(),
        bucket({
          hourStartMs: Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS,
          requests: 2,
          succeeded: 1,
          failed: 1,
          promptTokens: 12,
          completionTokens: 8,
          totalTokens: 20,
          usageUnavailableRequests: 1,
        }),
      ],
    });
    const { totals } = store.hourlyWindow(24);
    assert.equal(totals.requests, 3);
    assert.equal(totals.knownTotalTokens, 35);
    assert.equal(totals.usageUnavailableRequests, 1);
    assert.equal(totals.totalTokens, null);
    assert.equal(totals.promptTokens, null);
    assert.equal(totals.completionTokens, null);
  });

  it('distinguishes entirely unmetered usage from a complete zero-token window', (t) => {
    const { store } = fixture(t, {
      hourlyMetrics: [bucket({
        requests: 2,
        succeeded: 0,
        failed: 2,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        usageUnavailableRequests: 2,
      })],
    });
    const { totals } = store.hourlyWindow(24);
    assert.equal(totals.knownTotalTokens, 0);
    assert.equal(totals.totalTokens, null);
    assert.equal(totals.usageUnavailableRequests, 2);
  });

  it('keeps exact and measured totals equal when every request reports usage', (t) => {
    const { store } = fixture(t, { hourlyMetrics: [bucket()] });
    const { totals } = store.hourlyWindow(24);
    assert.equal(totals.knownTotalTokens, 15);
    assert.equal(totals.totalTokens, 15);
    assert.equal(totals.promptTokens, 10);
    assert.equal(totals.completionTokens, 5);
    assert.equal(totals.usageUnavailableRequests, 0);
  });

  it('returns zero measured and exact tokens for an empty window', (t) => {
    const { store } = fixture(t, {});
    const { totals } = store.hourlyWindow(24);
    assert.equal(totals.requests, 0);
    assert.equal(totals.knownTotalTokens, 0);
    assert.equal(totals.totalTokens, 0);
    assert.equal(totals.usageUnavailableRequests, 0);
  });

  it('reconstructs measured totals from existing persisted buckets without a schema change', (t) => {
    const { file, store } = fixture(t, {
      hourlyMetrics: [bucket({ usageUnavailableRequests: 1 })],
    });
    const before = store.hourlyWindow(24).totals;
    const after = new InteractionStore(file).hourlyWindow(24).totals;
    assert.equal(before.knownTotalTokens, 15);
    assert.deepEqual(after, before);
    assert.equal(readFileSync(file, 'utf8').includes('knownTotalTokens'), false);
  });

  it('uses the full hourly ledger even when the interaction viewer retains only 1,000 records', (t) => {
    const { store } = fixture(t, {
      interactions: Array.from({ length: 1000 }, () => ({
        appId: 'fixture-app',
        appName: 'Fixture',
        status: 'succeeded',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })),
      hourlyMetrics: [bucket({
        requests: 1500,
        succeeded: 1499,
        failed: 1,
        promptTokens: 14990,
        completionTokens: 7495,
        totalTokens: 22485,
        usageUnavailableRequests: 1,
      })],
    });
    assert.equal(store.list(2000).length, 1000);
    assert.equal(store.summary().totals.totalTokens, 15000);
    assert.equal(store.hourlyWindow(24).totals.requests, 1500);
    assert.equal(store.hourlyWindow(24).totals.knownTotalTokens, 22485);
    assert.equal(store.hourlyWindow(24).totals.totalTokens, null);
  });

  it('excludes measured tokens and unknown-usage requests outside the requested window', (t) => {
    const { store } = fixture(t, {
      hourlyMetrics: [
        bucket(),
        bucket({
          hourStartMs: Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 24 * HOUR_MS,
          totalTokens: 500,
          usageUnavailableRequests: 1,
        }),
      ],
    });
    const { totals } = store.hourlyWindow(24);
    assert.equal(totals.knownTotalTokens, 15);
    assert.equal(totals.totalTokens, 15);
    assert.equal(totals.usageUnavailableRequests, 0);
  });
});
