import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { GeminiAccountModelCatalog } from '../src/llm/providers/gemini-api/accountCatalog.js';
import { fetchGeminiCatalog, geminiAccessDenial } from '../src/llm/providers/gemini-api/catalogApi.js';
import { createGeminiApiClient } from '../src/llm/providers/gemini-api/client.js';
import { GeminiApiQuotaLedger } from '../src/llm/providers/gemini-api/quotaLedger.js';

const active = 'gemini-3.8-flash', other = 'gemini-3.7-flash';
const originalFetch = globalThis.fetch;
const directories: string[] = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function config() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-census-')); directories.push(dir);
  return loadConfig({ GEMROUTER_ROOT_DIR: dir, GEMROUTER_ADMIN_TOKEN: 'fixture-admin', GEMROUTER_BOOTSTRAP_API_KEY: 'fixture-client', GEMROUTER_GEMINI_API_ACCOUNT_MODELS_REFRESH_MS: '0',
    GEMROUTER_GEMINI_API_KEYS_JSON: JSON.stringify([{ id: 'first', key: 'test-first-secret', quotaGroup: 'first' }, { id: 'second', key: 'test-second-secret', quotaGroup: 'second' }]),
  }).geminiApi;
}
const listing = (...models: string[]) => ({ models: models.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) });
const ok = { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] };
const zero = { error: { status: 'RESOURCE_EXHAUSTED', message: '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.8-flash' } };

test('catalog reads all pages with header auth, de-duplicates and never places keys in URLs', async () => {
  const c = config(); let calls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.has('key'), false);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), c.keys[0].key);
    calls++;
    return Response.json(calls === 1 ? { ...listing(active), nextPageToken: 'next' } : listing(active, other));
  };
  assert.deepEqual((await fetchGeminiCatalog(c, c.keys[0].key)).map((m) => m.name), [`models/${active}`, `models/${other}`]);
  assert.equal(calls, 2);
});

test('stale and failed refreshes cannot resurrect previously absent models', async () => {
  const c = config();
  writeFileSync(c.accountModelsCachePath, JSON.stringify({ version: 1, updatedAt: '', accounts: {
    first: { accountId: 'first', models: [active], fetchedAt: '2020-01-01T00:00:00Z', error: 'previous_outage' },
  } }));
  const gate = new GeminiAccountModelCatalog(c);
  assert.equal(gate.allows('first', other), false);
  globalThis.fetch = async () => Response.json({ error: { message: 'private-key-must-not-escape' } }, { status: 403 });
  await gate.refresh();
  assert.equal(gate.allows('first', active), true); assert.equal(gate.allows('first', other), false);
  assert.equal(gate.allows('second', active), true); // No successful catalog: unknown, not absence.
  assert.equal(JSON.stringify(gate.snapshot()).includes('private-key'), false);
  assert.equal(statSync(c.accountModelsCachePath).mode & 0o077, 0);
});

test('valid empty catalogs deny all models, while malformed replies remain unknown', async () => {
  const c = config(), gate = new GeminiAccountModelCatalog(c);
  globalThis.fetch = async (_url, init) => new Headers(init?.headers).get('x-goog-api-key') === c.keys[0].key ? Response.json(listing()) : Response.json({});
  await gate.refresh();
  assert.equal(gate.allows('first', active), false); assert.equal(gate.allows('second', active), true);
});

test('legacy first-fetch failure with an empty list stays unknown, not a confirmed empty catalog', () => {
  const c = config();
  writeFileSync(c.accountModelsCachePath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), accounts: {
    first: { accountId: 'first', models: [], fetchedAt: new Date().toISOString(), error: 'HTTP 403' },
  } }));
  const gate = new GeminiAccountModelCatalog(c); assert.equal(gate.allows('first', active), true);
  gate.observeInference('first', active, 429, zero);
  assert.equal(gate.allows('first', active), false); assert.equal(gate.allows('first', other), true);
});

test('partial pagination failures never publish a truncated catalog', async () => {
  const c = config(); c.keys = [c.keys[0]];
  const gate = new GeminiAccountModelCatalog(c); globalThis.fetch = async () => Response.json(listing(active, other));
  await gate.refresh(); let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? Response.json({ ...listing(active), nextPageToken: 'next' }) : Response.json({}, { status: 429 });
  await gate.refresh(); assert.equal(gate.allows('first', other), true);
  globalThis.fetch = async () => Response.json({ ...listing(active), nextPageToken: 'same' });
  await assert.rejects(fetchGeminiCatalog(c, c.keys[0].key), /repeated_page/);
});

test('only structured model-not-found or explicit Google zero quota mean lost access', () => {
  assert.equal(geminiAccessDenial(429, zero), 'quota_limit_zero');
  assert.equal(geminiAccessDenial(404, { error: { status: 'NOT_FOUND' } }), 'model_not_found');
  for (const status of [400, 401, 403, 500, 503]) assert.equal(geminiAccessDenial(status, zero), null);
  assert.equal(geminiAccessDenial(429, { error: { status: 'RESOURCE_EXHAUSTED', message: zero.error.message.replace('limit: 0', 'limit: 20') } }), null);
  assert.equal(geminiAccessDenial(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Please retry; limit: 0' } }), null);
  assert.equal(geminiAccessDenial(404, {}), null);
});

test('zero-quota observations survive catalog refresh and restart until successful inference', async () => {
  const c = config(), gate = new GeminiAccountModelCatalog(c);
  globalThis.fetch = async () => Response.json(listing(active, other)); await gate.refresh();
  gate.observeInference('first', active, 429, zero);
  assert.equal(gate.allows('first', active), false); assert.equal(gate.allows('second', active), true);
  await gate.refresh(); assert.equal(gate.allows('first', active), false);
  const restored = new GeminiAccountModelCatalog(c); assert.equal(restored.allows('first', active), false);
  restored.observeInference('first', active, 503, {}); restored.observeInference('first', active, 200, {});
  assert.equal(restored.allows('first', active), false);
  restored.observeInference('first', active, 200, ok); assert.equal(restored.allows('first', active), true);
  const cache = readFileSync(c.accountModelsCachePath, 'utf8');
  assert.equal(cache.includes(c.keys[0].key), false); assert.equal(cache.includes('Quota exceeded'), false);
});

test('key rotation invalidates old observations and ignores late replies from the previous key', async () => {
  const c = config(), gate = new GeminiAccountModelCatalog(c), oldKey = c.keys[0].key;
  gate.observeInference('first', active, 429, zero, oldKey); assert.equal(gate.allows('first', active), false);
  c.keys[0].key = 'replacement-secret';
  assert.equal(gate.allows('first', active), true);
  gate.observeInference('first', active, 429, zero, oldKey); assert.equal(gate.allows('first', active), true);
  globalThis.fetch = async () => Response.json(listing(active)); await gate.refresh();
  assert.equal(gate.allows('first', active), true);
});

test('a late old-key catalog refresh cannot overwrite a rotated-key catalog', async () => {
  const c = config(); c.keys = [c.keys[0]]; const gate = new GeminiAccountModelCatalog(c);
  let done!: (r: Response) => void;
  globalThis.fetch = async () => new Promise<Response>((resolve) => { done = resolve; });
  const pending = gate.refresh(); c.keys[0].key = 'replacement-secret'; done(Response.json(listing())); await pending;
  assert.equal(gate.allows('first', active), true);
});

test('inference observations arriving during refresh are retained', async () => {
  const c = config(); c.keys = [c.keys[0]]; const gate = new GeminiAccountModelCatalog(c);
  let done!: (r: Response) => void; globalThis.fetch = async () => new Promise<Response>((resolve) => { done = resolve; });
  const pending = gate.refresh(); gate.observeInference('first', active, 429, zero); done(Response.json(listing(active))); await pending;
  assert.equal(gate.allows('first', active), false);
});

test('routing and capacity both exclude zero-quota pairs and preserve other accounts/models', async () => {
  const c = config(); c.keys.forEach((k) => { k.models = [active, other]; });
  const gate = new GeminiAccountModelCatalog(c); gate.observeInference('first', active, 429, zero);
  const client = createGeminiApiClient(c); const calls: string[] = [];
  globalThis.fetch = async (url) => {
    if (!String(url).includes(':generateContent')) return Response.json(listing(active, other));
    calls.push(String(url)); return Response.json(ok);
  };
  const response = await client.chat([{ role: 'user', content: 'short' }], { model: active, allowedModelIds: [active] });
  assert.equal(response.apiKeyId, 'second'); assert.equal(calls.length, 1);
  const groups = client.getDiagnostics!().quotaGroups as Array<{ id: string; models: Array<{ model: string; accountIds: string[] }> }>;
  assert.equal(groups.find((g) => g.id === 'first')?.models.some((m) => m.model === active), false);
  assert.equal(groups.find((g) => g.id === 'first')?.models.some((m) => m.model === other), true);
  assert.deepEqual(groups.find((g) => g.id === 'second')?.models.find((m) => m.model === active)?.accountIds, ['second']);
  c.keys[0].quotaGroup = 'second';
  const shared = createGeminiApiClient(c).getDiagnostics!().quotaGroups as typeof groups;
  assert.deepEqual(shared.find((g) => g.id === 'second')?.models.find((m) => m.model === active)?.accountIds, ['second']);
  assert.deepEqual(shared.find((g) => g.id === 'second')?.models.find((m) => m.model === other)?.accountIds, ['first', 'second']);
});

test('real provider failures quarantine only the affected model/account for subsequent requests', async () => {
  const c = config(); c.keys.forEach((k) => { k.models = [active, other]; });
  c.quotaCooldownMs = 0;
  const client = createGeminiApiClient(c), calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.includes(':generateContent')) return Response.json(listing(active, other));
    const key = url.searchParams.get('key')!; calls.push(key);
    return key === c.keys[0].key ? Response.json(zero, { status: 429 }) : Response.json(ok);
  };
  for (let i = 0; i < 2; i++) {
    const result = await client.chat([{ role: 'user', content: 'short' }], { model: active, allowedModelIds: [active] });
    assert.equal(result.apiKeyId, 'second');
  }
  assert.deepEqual(calls, [c.keys[0].key, c.keys[1].key, c.keys[1].key]);
  assert.equal(new GeminiAccountModelCatalog(c).allows('first', active), false);
  assert.equal(new GeminiAccountModelCatalog(c).allows('first', other), true);
});

test('explicit bounded admin probes recover access only on real inference and never leak upstream error text', async (t) => {
  const c = config(); let time = Date.now(); t.mock.method(Date, 'now', () => time);
  const client = createGeminiApiClient(c) as ReturnType<typeof createGeminiApiClient> & { probeAccountModel: (id: string, model: string) => Promise<Record<string, unknown>> };
  let successful = false, generationCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.has('key'), false);
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), c.keys[0].key);
    if (!url.pathname.includes(':generateContent')) return Response.json(listing(active));
    generationCalls++;
    const body = JSON.parse(String(init?.body)); assert.equal(body.generationConfig.maxOutputTokens, 128);
    return Response.json(successful ? ok : zero, { status: successful ? 200 : 429 });
  };
  const denied = await client.probeAccountModel('first', active);
  assert.equal(denied.access, 'quota_limit_zero'); assert.equal(JSON.stringify(denied).includes('Quota exceeded'), false);
  assert.equal(new GeminiAccountModelCatalog(c).allows('first', active), false);
  assert.equal((await client.probeAccountModel('first', active)).error, 'account_probe_busy'); assert.equal(generationCalls, 1);
  successful = true; time += 60_001;
  assert.equal((await client.probeAccountModel('first', active)).access, 'inference_verified');
  assert.equal(new GeminiAccountModelCatalog(c).allows('first', active), true);
  assert.equal((await client.probeAccountModel('first', 'gemini-3-pro-image')).error, 'model_not_in_text_catalog');
  assert.equal((await client.probeAccountModel('absent', active)).error, 'invalid_account_model');
  assert.equal(generationCalls, 2);
});

test('capacity hides disabled/deleted groups, honors group overrides and counts shared quota once', () => {
  const c = config(); c.keys[0].models = [active, other]; c.keys[1].models = [active, other];
  c.groupLimits.first = { [active]: { rpm: 0, tpm: 100, rpd: 100 }, [other]: { rpm: 3, tpm: 100, rpd: 7 } };
  const ledger = new GeminiApiQuotaLedger(c); ledger.reserve({ quotaGroup: 'orphan', keyId: 'deleted', model: active, requestId: 'old', estimatedTokens: 1 });
  c.keys[1].enabled = false;
  const groups = createGeminiApiClient(c).getDiagnostics!().quotaGroups as Array<{ id: string; models: Array<{ model: string; rpd: { limit: number } }> }>;
  assert.deepEqual(groups.map((g) => g.id), ['first']); assert.deepEqual(groups[0].models.map((m) => m.model), [other]); assert.equal(groups[0].models[0].rpd.limit, 7);
  c.keys[1].enabled = true; c.keys[1].quotaGroup = 'first';
  assert.equal((createGeminiApiClient(c).getDiagnostics!().quotaGroups as unknown[]).length, 1);
});
