import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { createNvidiaClient, type NvidiaClient } from '../src/llm/providers/nvidia/client.js';
import type { NvidiaProviderConfig } from '../src/llm/providers/nvidia/types.js';

const target = 'nvidia/nemotron-3-super-120b-a12b', other = 'vendor/other';
const originalFetch = globalThis.fetch, directories: string[] = [];
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });
const bucket = () => ({ samples: 7, successes: 4, failures: 3, timeouts: 0, avgLatencyMs: 1000, avgTtfbMs: 500, avgTokensPerSec: 10 });
function fixture(overrides: Partial<NvidiaProviderConfig> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gemrouter-nvidia-target-')); directories.push(directory);
  const scoreboardPath = path.join(directory, 'scoreboard.json');
  const score = () => ({ hours: {}, overall: bucket(), sources: {}, consecutiveFailures: 3,
    cooldownUntil: '9999-12-31T23:59:59.999Z', last429At: null, lastStatus: 'failure',
    lastLatencyMs: null, lastErrorCode: 'nvidia_model_not_found', lastAt: '2026-10-03T00:00:00.000Z' });
  writeFileSync(scoreboardPath, JSON.stringify({ version: 1, updatedAt: '', models: { [target]: score(), [other]: score() } }));
  return createNvidiaClient({ enabled: true, apiKey: 'fixture-private-key', baseUrl: 'https://nvidia.invalid',
    modelsPath: path.join(directory, 'models.json'), models: [target, other].map((id) => ({ id, tier: 'large', enabled: true })),
    defaultTier: 'large', rpmLimit: 10, maxConcurrency: 2, timeoutMs: 1000, firstTokenTimeoutMs: 500,
    rateLimitCooldownMs: 60_000, scoreboardPath, probeEnabled: false, probeIntervalMs: 0, probeMaxTokens: 4,
    raceEnabled: false, raceHedgeDelayMs: 20, raceMaxCandidates: 1, ...overrides } as NvidiaProviderConfig);
}
function models(client: NvidiaClient) {
  return client.getDiagnostics!().models as Array<{ id: string; coolingDown: boolean; cooldownUntil: string | null;
    consecutiveFailures: number; lastErrorCode: string | null; overall: { samples: number; successRate: number } }>;
}
const success = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
{ headers: { 'content-type': 'text/event-stream' } });

test('targeted success recovers a stale 410 quarantine and preserves all previous model statistics', async () => {
  const client = fixture(), untouched = structuredClone(models(client).find((m) => m.id === other));
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.equal(body.model, target); assert.equal(body.max_tokens, 128);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply OK.' }]);
    return success();
  };
  const result = await client.probeModel(target);
  assert.equal(result.ok, true); assert.equal(result.access, 'inference_verified'); assert.equal(result.tokens, 5);
  const recovered = models(client).find((m) => m.id === target)!;
  assert.equal(recovered.coolingDown, false); assert.equal(recovered.cooldownUntil, null);
  assert.equal(recovered.consecutiveFailures, 0); assert.equal(recovered.overall.samples, 8);
  assert.equal(recovered.overall.successRate, 0.63); assert.deepEqual(models(client).find((m) => m.id === other), untouched);
  assert.equal((client.getDiagnostics!().rpm as { used: number }).used, 1);
  assert.equal((await client.probeModel(target)).error, 'nvidia_probe_busy'); assert.equal(calls, 1);
});

test('targeted probes reject aliases, disabled ids and unavailable providers without inference', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return success(); };
  const client = fixture({ models: [{ id: target, tier: 'large', enabled: false }] });
  for (const model of [target, 'nvidia-auto', 'nemotron-3-super-120b-a12b', 'unconfigured/model'])
    assert.equal((await client.probeModel(model)).error, 'invalid_nvidia_model');
  assert.equal((await fixture({ enabled: false }).probeModel(target)).error, 'backend_disabled');
  assert.equal((await fixture({ apiKey: '' }).probeModel(target)).error, 'nvidia_missing_key');
  assert.equal(calls, 0);
});

test('local NVIDIA RPM exhaustion prevents probing without altering model quarantine or history', async () => {
  const client = fixture({ rpmLimit: 0 }), before = structuredClone(models(client));
  let calls = 0; globalThis.fetch = async () => { calls++; return success(); };
  const result = await client.probeModel(target);
  assert.equal(result.ok, false); assert.equal(result.status, null); assert.equal(result.error, 'local_nvidia_rpm_unavailable');
  assert.equal(calls, 0); assert.deepEqual(models(client), before);
});

test('a repeated upstream 410 retains quarantine, counts quota and never exposes the upstream secret message', async () => {
  const client = fixture(), untouched = structuredClone(models(client).find((m) => m.id === other));
  globalThis.fetch = async () => Response.json({ error: { message: 'fixture-private-key must not escape' } }, { status: 410 });
  const result = await client.probeModel(target);
  assert.equal(result.ok, false); assert.equal(result.status, 410); assert.equal(result.error, 'nvidia_model_not_found');
  assert.equal(JSON.stringify(result).includes('fixture-private-key'), false);
  const failed = models(client).find((m) => m.id === target)!;
  assert.equal(failed.cooldownUntil, '9999-12-31T23:59:59.999Z'); assert.equal(failed.overall.samples, 8);
  assert.equal((client.getDiagnostics!().rpm as { used: number }).used, 1);
  assert.deepEqual(models(client).find((m) => m.id === other), untouched);
});

test('targeted probes serialize globally and preserve structured 429 backoff only on the target', async () => {
  const client = fixture(), untouched = structuredClone(models(client).find((m) => m.id === other));
  let finish!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>((resolve) => { finish = resolve; });
  const pending = client.probeModel(target);
  assert.equal((await client.probeModel(other)).error, 'nvidia_probe_busy');
  finish(Response.json({ error: { message: 'rate limit' } }, { status: 429, headers: { 'retry-after': '90' } }));
  const result = await pending; assert.equal(result.status, 429); assert.equal(result.error, 'nvidia_rate_limited');
  const failed = models(client).find((m) => m.id === target)!;
  assert.equal(failed.coolingDown, true); assert.ok(Date.parse(failed.cooldownUntil!) > Date.now() + 80_000);
  assert.deepEqual(models(client).find((m) => m.id === other), untouched);
});
