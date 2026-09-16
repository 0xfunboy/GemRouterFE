import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProvider, type InferenceRuntime } from '../src/codex/provider.js';
import { CodexRuntimeError, type CodexAccountState } from '../src/codex/runtime.js';
import { CodexMetrics } from '../src/codex/metrics.js';
import { readCodexConfig } from '../src/codex/config.js';
import { createLlmRouter } from '../src/llm/router.js';
import { LLMProviderError } from '../src/llm/errors.js';
import type { LLMClient, LLMOptions } from '../src/llm/types.js';
import { AppStore } from '../src/store/appStore.js';
import { codexRequestPolicy } from '../src/codex/request.js';
import { responseUsage, buildResponsesApiResponse } from '../src/lib/openai.js';

const config = readCodexConfig({ GEMROUTER_CODEX_ENABLED: 'true' });
const account = { enabled: true, running: true, authenticated: true, modelAvailable: true, reasonCode: null } as CodexAccountState;
const messages = [{ role: 'user' as const, content: 'Hello' }];
const opts: LLMOptions = { model: 'gpt-5.6-luna', codex: { enabled: true, reasoningEffort: 'high', fallbackEnabled: true }, allowedModelIds: ['gpt-5.6-luna', 'gemini-3.8-flash'] };
function fixture(settings: { quota?: number; error?: string; usage?: boolean; auth?: boolean } = {}) {
  let calls = 0;
  const status = { ...account, authenticated: settings.auth !== false };
  const runtime: InferenceRuntime = {
    cachedStatus: () => status, status: async () => status,
    models: async () => [{ id: 'luna', model: 'gpt-5.6-luna', displayName: 'Luna', supportedReasoningEfforts: ['low', 'high'] }],
    quota: async () => [{ limitId: 'codex', primary: { usedPercent: settings.quota ?? 10, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+3600 }, secondary: null },
      { limitId: 'another-model', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+3600 }, secondary: null }],
    generate: async (input) => { calls++; if (settings.error) throw new CodexRuntimeError(settings.error); return { content: 'OK', model: input.model, reasoningEffort: input.reasoningEffort,
      usage: settings.usage === false ? null : { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 2, cacheWriteInputTokens: 0, reasoningOutputTokens: 3 } }; },
  };
  return { provider: new CodexProvider(config, runtime), runtime, calls: () => calls };
}
test('actual usage, explicit app opt-in, model and effort validation', async () => {
  const f = fixture();
  await assert.rejects(f.provider.chat(messages, { ...opts, codex: { enabled: false } }), { code: 'codex_model_not_allowed' });
  await assert.rejects(f.provider.chat(messages, { ...opts, model: 'gpt-fictional' }), { code: 'codex_model_unavailable' });
  await assert.rejects(f.provider.chat(messages, { ...opts, codex: { enabled: true, reasoningEffort: 'ultra' } }), { code: 'codex_reasoning_unsupported' });
  const response = await f.provider.chat(messages, opts);
  assert.equal(response.model, opts.model); assert.equal(response.usage?.totalTokens, 15); assert.equal(f.calls(), 1);
  assert.deepEqual(responseUsage(messages, response.content, response), { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } });
  const unknown = await fixture({ usage: false }).provider.chat(messages, opts);
  assert.equal(responseUsage(messages, unknown.content, unknown), undefined);
  assert.equal(buildResponsesApiResponse({ model: unknown.model!, text: unknown.content }).usage, null);
});
test('quota preflight and upstream quota errors use only authorized Gemini fallback', async () => {
  for (const settings of [{ quota: 100 }, { error: 'codex_quota_depleted' }]) {
    const f = fixture(settings); const received: LLMOptions[] = [];
    const gemini: LLMClient = { provider: 'gemini-api', model: 'default', chat: async (_messages, options) => { received.push(options!); return { content: 'GEMINI', model: options!.model, provider: 'gemini-api' }; } };
    const router = createLlmRouter({ backendOrder: ['gemini-api', 'codex'], codexFallbackModels: () => ['gemini-not-allowed', 'gemini-3.8-flash'] }, { geminiApi: gemini, codex: f.provider });
    const response = await router.chat(messages, opts);
    assert.equal(response.model, 'gemini-3.8-flash'); assert.equal(response.fallbackFrom, 'codex'); assert.equal(response.fallbackReason, 'codex_quota_depleted');
    assert.equal(received[0].codex, undefined); assert.deepEqual(received[0].allowedModelIds, opts.allowedModelIds);
    if (settings.quota) assert.equal(f.calls(), 0);
    await assert.rejects(router.chat(messages, { ...opts, allowedModelIds: ['gpt-5.6-luna'] }), { code: 'codex_quota_depleted' });
    await assert.rejects(router.chat(messages, { ...opts, codex: { ...opts.codex!, fallbackEnabled: false } }), { code: 'codex_quota_depleted' });
    assert.equal(received.length, 1);
  }
});
test('auth, rate limits, failures, and arbitrary error text cannot trigger quota fallback', async () => {
  for (const error of ['codex_auth_required', 'codex_rate_limited', 'codex_timeout', 'codex_inference_failed']) {
    const f = fixture({ error }); let spill = false;
    const router = createLlmRouter({ backendOrder: ['gemini-api', 'codex'], codexFallbackModels: () => ['gemini-3.8-flash'] }, { codex: f.provider, geminiApi: { provider: 'gemini-api', model: '', chat: async () => { spill = true; throw Error('unexpected'); } } });
    await assert.rejects(router.chat(messages, opts), { code: error }); assert.equal(spill, false);
  }
  const f = fixture(); f.runtime.generate = async () => { throw Error('quota depleted'); };
  await assert.rejects(f.provider.chat(messages, opts), (e: LLMProviderError) => e.options.fallbackEligible === false);
});
test('Gemini traffic never consumes Codex quota even when Gemini fails', async () => {
  const f = fixture(); const router = createLlmRouter({ backendOrder: ['gemini-api', 'codex'] }, { codex: f.provider, geminiApi: { provider: 'gemini-api', model: '', chat: async () => { throw new LLMProviderError('backend_unavailable', 'gemini-api', 'offline', { fallbackEligible: true }); } } });
  await assert.rejects(router.chat(messages, { model: 'gemini-3.8-flash' })); assert.equal(f.calls(), 0);
});
test('explicit upstream exhaustion is not immediately retried against a lagging quota snapshot', async () => {
  const f = fixture({ error: 'codex_quota_depleted' });
  await assert.rejects(f.provider.chat(messages, opts), { code: 'codex_quota_depleted' });
  await assert.rejects(f.provider.chat(messages, opts), { code: 'codex_quota_depleted' });
  assert.equal(f.calls(), 1);
});
test('bounded serial queue, cancelled waiter never dispatches and does not block the next request', async () => {
  const f = fixture(); let finish!: () => void;
  const firstResponse = f.runtime.generate;
  f.runtime.generate = async (input) => { await new Promise<void>((resolve) => { finish = resolve; }); return firstResponse(input); };
  const first = f.provider.chat(messages, opts);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = f.provider.chat(messages, { ...opts, signal: controller.signal }); controller.abort();
  await assert.rejects(second, { code: 'codex_cancelled' }); finish(); await first;
  assert.equal(f.provider.getDiagnostics().queued, 0); assert.equal(f.calls(), 1);
});
test('metrics persist without double counting cache/reasoning and missing usage is explicit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-metrics-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'metrics.json'); const metrics = new CodexMetrics(file);
  const f = fixture(); const r = await f.runtime.generate({ model: 'gpt-5.6-luna', reasoningEffort: 'high', input: '', system: '', deadline: Date.now()+1000 });
  metrics.received(r.model); metrics.completed(r.model, 'succeeded', r.usage, true);
  metrics.received(r.model); metrics.completed(r.model, 'failed', null, true);
  const snapshot = new CodexMetrics(file).snapshot(); assert.equal(snapshot.totals.totalTokens, 15); assert.equal(snapshot.totals.usageUnknownRequests, 1);
  assert.equal(snapshot.remainingTokens, null); assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test('app all-model access still requires explicit Codex opt-in and request body cannot override policy', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AppStore(join(dir, 'apps.json')); store.restrictAllowedModels(['gpt-5.6-luna']);
  const { record } = store.create({ name: 'test', allowedModels: [], modelAccess: 'all', allowedOrigins: [], sessionNamespace: 'test', rateLimitPerMinute: 0, maxConcurrency: 0 });
  assert.equal(store.isModelAllowed(record, 'gpt-5.6-luna'), false);
  assert.equal(codexRequestPolicy({ codex: { enabled: true } }, undefined, record).enabled, false);
  store.update(record.id, { codexEnabled: true, codexReasoningEffort: 'low' }); assert.equal(store.isModelAllowed(record, 'gpt-5.6-luna'), true);
  assert.equal(codexRequestPolicy({ reasoning: { effort: 'high' } }, undefined, record).reasoningEffort, 'high');
  assert.throws(() => codexRequestPolicy({ reasoning_effort: 'high' }, 'low', record));
  assert.throws(() => codexRequestPolicy({ tools: [{ type: 'shell' }] }, undefined, record));
});
