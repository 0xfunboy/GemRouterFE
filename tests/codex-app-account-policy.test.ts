import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LLMOptions } from '../src/llm/types.js';
import { CodexRuntimeError } from '../src/codex/runtime.js';
import { setupAccounts } from './helpers/codex-accounts-fixture.js';

const messages = [{ role: 'user' as const, content: 'Status' }];
const options: LLMOptions = {
  model: 'gpt-5.6-sol',
  codex: { enabled: true, reasoningEffort: 'high', fallbackEnabled: false,
    accountId: 'account-2', accountFallbackEnabled: true },
};
const quota = (usedPercent: number) => [{ limitId: 'codex',
  primary: { usedPercent, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 60 },
  secondary: null }];

test('app account pins override manual selection without changing unpinned app routing or the registry', async (t) => {
  const { pool } = await setupAccounts(t); pool.add(); await pool.refresh();
  assert.equal(pool.snapshot().selectedAccountId, 'account-1');
  const pinned = await pool.chat(messages, options);
  assert.equal(pinned.codexAccountId, 'account-2'); assert.equal(pinned.content, 'account-2');
  assert.equal(pool.snapshot().selectedAccountId, 'account-1');
  assert.equal((await pool.chat(messages, { ...options, codex: { enabled: true, reasoningEffort: 'high' } })).codexAccountId, 'account-1');
  pool.select('account-2');
  assert.equal((await pool.chat(messages, { ...options, codex: { ...options.codex!, accountId: 'account-1' } })).codexAccountId, 'account-1');
  assert.equal(pool.snapshot().selectedAccountId, 'account-2');
});

test('missing, unknown and disconnected pinned accounts fail closed without using the globally selected account', async (t) => {
  const { pool, states } = await setupAccounts(t);
  let globalCalls = 0;
  pool.entry('account-1').runtime.generate = async () => { globalCalls++; throw Error('Unexpected global fallback'); };
  await assert.rejects(pool.chat(messages, options), { code: 'codex_account_not_found' });
  await assert.rejects(pool.chat(messages, { ...options, codex: { ...options.codex!, accountId: 'unknown' as 'account-2' } }), { code: 'codex_account_not_found' });
  pool.add(); states[1].authenticated = false; await pool.refresh();
  await assert.rejects(pool.chat(messages, options), { code: 'codex_auth_required' });
  assert.equal(globalCalls, 0); assert.equal(pool.snapshot().selectedAccountId, 'account-1');
});

test('pinned account quota fallback keeps model and effort, overrides global policy and recovers to its pin', async (t) => {
  const { pool, config } = await setupAccounts(t); pool.add(); await pool.refresh();
  config.accountFallbackEnabled = false;
  pool.entry('account-2').runtime.quota = async () => quota(100); await pool.refresh();
  const original = pool.entry('account-1').runtime.generate;
  let calls = 0;
  pool.entry('account-1').runtime.generate = async (input) => {
    calls++; assert.equal(input.model, options.model); assert.equal(input.reasoningEffort, 'high'); return original(input);
  };
  const result = await pool.chat(messages, options);
  assert.equal(result.codexAccountId, 'account-1'); assert.equal(result.codexAccountFallbackFrom, 'account-2');
  assert.equal(pool.snapshot().selectedAccountId, 'account-1'); assert.equal(calls, 1);
  pool.entry('account-2').runtime.quota = async () => quota(1); await pool.refresh();
  assert.equal((await pool.chat(messages, options)).codexAccountId, 'account-2');
  assert.equal(pool.snapshot().selectedAccountId, 'account-1');
});

test('explicitly disabled app account fallback overrides enabled global fallback', async (t) => {
  const { pool, config } = await setupAccounts(t); pool.add(); await pool.refresh();
  config.accountFallbackEnabled = true;
  pool.entry('account-2').runtime.quota = async () => quota(100); await pool.refresh();
  await assert.rejects(pool.chat(messages, { ...options, codex: { ...options.codex!, accountFallbackEnabled: false } }), { code: 'codex_quota_depleted' });
  assert.equal(pool.snapshot('account-1').provider.metrics.totals.received, 0);
});

for (const code of ['codex_timeout', 'codex_model_unavailable', 'codex_rate_limited']) {
  test(`pinned account never rotates on ${code}`, async (t) => {
    const { pool } = await setupAccounts(t); pool.add(); await pool.refresh();
    pool.entry('account-2').runtime.generate = async () => { throw new CodexRuntimeError(code); };
    await assert.rejects(pool.chat(messages, options), { code });
    assert.equal(pool.snapshot('account-1').provider.metrics.totals.received, 0);
    assert.equal(pool.snapshot().selectedAccountId, 'account-1');
  });
}
