import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { GeminiAccountModelCatalog } from '../src/llm/providers/gemini-api/accountCatalog.js';
import { buildGeminiModelAttemptPlan, createGeminiApiClient } from '../src/llm/providers/gemini-api/client.js';
import { GEMINI_DECISION_MODEL as model, encodeDecisionRequest, validateDecisionRequest } from '../src/llm/providers/gemini-api/decisions.js';

const request = { model, input: 'A red hat.', questions: { red: { type: 'noul', instructions: 'Is the hat red?' } } };
const response = { answers: { red: { type: 'noul', noul: 0.98, confidence: 0.98 } }, usage: { total_input_tokens: 73, total_tokens: 73 } };

test('decisions validate the native envelope and never appear in a chat attempt', () => {
  assert.deepEqual(validateDecisionRequest(request), request);
  assert.deepEqual(validateDecisionRequest({ ...request, input: [{ type: 'image', data: 'AA==', mime_type: 'image/png' }] }).model, model);
  const imageRequest = validateDecisionRequest({ ...request, input: { type: 'image', mime_type: 'image/png', data: 'A'.repeat(300_000) } });
  assert.equal(encodeDecisionRequest(imageRequest, 50_000).estimatedTokens, 50_000);
  const longText = validateDecisionRequest({ ...request, input: 'A'.repeat(300_000) });
  assert.ok(encodeDecisionRequest(longText, 50_000).estimatedTokens > 50_000);
  assert.throws(() => validateDecisionRequest({ ...request, questions: {} }), /1,000/);
  assert.throws(() => validateDecisionRequest({ ...request, input: { type: 'image', uri: 'files/shared' } }), /inline/);
  assert.throws(() => validateDecisionRequest({ ...request, model: 'gemini-3.8-flash' }), /requires model/);
  assert.deepEqual(buildGeminiModelAttemptPlan({ requestedModelId: model, allowedModelIds: [model, 'gemini-3.8-flash'], strictModelIds: [model] }), []);
  assert.deepEqual(buildGeminiModelAttemptPlan({ requestedModelId: 'gemini-3.8-flash', allowedModelIds: [model, 'gemini-3.8-flash'] }), ['gemini-3.8-flash']);
});

test('decisions route only to authorized native accounts, rotate after 429 and settle the existing quota ledger', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-decisions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = ['wrong', 'first', 'second'].map((id, i) => ({ id, key: `test-${id}`, quotaGroup: id, priority: 10 - i,
    models: i === 0 ? ['gemini-3.8-flash'] : [model] }));
  const config = loadConfig({ GEMROUTER_ROOT_DIR: dir, GEMROUTER_ADMIN_TOKEN: 'fixture-admin', GEMROUTER_BOOTSTRAP_API_KEY: 'fixture-client',
    GEMROUTER_GEMINI_API_ACCOUNT_MODELS_REFRESH_MS: '0', GEMROUTER_GEMINI_API_KEYS_JSON: JSON.stringify(keys) }).geminiApi;
  const calls: string[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/models')) {
      return Response.json({ models: [{ name: `models/${model}`, supportedGenerationMethods: ['createDecision'] }] });
    }
    assert.equal(url.pathname, '/v1beta/decisions');
    assert.equal(url.search, '');
    assert.equal(init?.redirect, 'error');
    const key = new Headers(init?.headers).get('x-goog-api-key')!;
    assert.deepEqual(JSON.parse(String(init?.body)), request);
    calls.push(key);
    if (key === 'test-first') return Response.json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Too many requests.' } }, { status: 429 });
    return Response.json(response);
  };
  const gate = new GeminiAccountModelCatalog(config);
  await gate.refresh();
  assert.equal(gate.allows('first', model), true);
  const client = createGeminiApiClient(config);
  const result = await client.decide(request);
  assert.deepEqual(calls, ['test-first', 'test-second']);
  assert.deepEqual(result, { body: response, keyId: 'second', quotaGroup: 'second' });
  const ledger = JSON.parse(readFileSync(config.ledgerPath, 'utf8'));
  const quota = ledger.groups.second.models[model];
  assert.deepEqual([quota.rpm.limit, quota.tpm.limit, quota.rpd.limit], [200, 50_000, 10_000]);
  assert.equal(quota.tpm.events[0].tokens, 73);
  assert.equal(quota.rpd.events.length, 1);
  assert.equal(quota.rpd.events[0].reservationState, 'completed');
  assert.equal(ledger.groups.first.models[model].lastFailureStatus, 429);
  await assert.rejects(client.decide({ ...request, questions: {} }), /1,000/);
  assert.equal(calls.length, 2);
});
