import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountTokenDelta, normalizeAccountUsage, normalizeRateLimits, type CodexUsageSnapshot } from '../src/codex/usage.js';
import { readCodexConfig } from '../src/codex/config.js';

test('missing and invalid usage stays unknown; unrecognized fields are omitted', () => {
  const result = normalizeAccountUsage({ summary: { lifetimeTokens: -1, peakDailyTokens: NaN, currentStreakDays: 0, token: 'PRIVATE' }, dailyUsageBuckets: [{ startDate: '2026-09-15', tokens: 21, secret: 'PRIVATE' }, { startDate: 'PRIVATE', tokens: 12 }] });
  assert.equal(result.summary.lifetimeTokens, null);
  assert.equal(result.summary.peakDailyTokens, null);
  assert.equal(result.summary.currentStreakDays, 0);
  assert.deepEqual(result.dailyUsageBuckets, [{ startDate: '2026-09-15', tokens: 21 }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(normalizeAccountUsage({}).dailyUsageBuckets, null);
});
test('quota keeps separate windows and buckets, no double counting legacy view', () => {
  const bucket = { limitId: 'codex', primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1000 }, secondary: null };
  assert.deepEqual(normalizeRateLimits({ rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } }), [bucket]);
  assert.deepEqual(normalizeRateLimits({ rateLimits: bucket }), [bucket]);
});
test('delta is account-only and invalid/unavailable/reset counters are not zero', () => {
  const snap = (n: number | null, observedAt = '2026-09-16T00:00:00Z'): CodexUsageSnapshot => ({ observedAt, scope: 'account', usage: normalizeAccountUsage({ summary: { lifetimeTokens: n } }), usageError: null, quota: null, quotaError: null });
  assert.equal(accountTokenDelta(snap(100), snap(150)), 50);
  assert.equal(accountTokenDelta(snap(100), snap(100)), 0);
  assert.equal(accountTokenDelta(snap(100), snap(0)), null);
  assert.equal(accountTokenDelta(snap(null), snap(150)), null);
  assert.equal(accountTokenDelta(snap(100), snap(150, 'invalid')), null);
});
test('disabled by default and legacy login directory preserved without enabling browser control', () => {
  const config = readCodexConfig({ GEMROUTER_CHATGPT_CONTROL_PRIVATE_DIR: '/private/existing', GEMROUTER_CHATGPT_CONTROL_ENABLED: 'true' });
  assert.equal(config.enabled, false);
  assert.equal(config.profileDirectory, '/private/existing/codex');
  assert.equal('browserProfile' in config, false);
});
