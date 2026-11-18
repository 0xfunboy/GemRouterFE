import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const decision = 'gemini-decision-1', hydrogen = 'gemini-4-hydrogen', flash = 'gemini-3.8-flash';

test('Gemini HTTP routes enforce per-app access, track decision usage and downgrade Hydrogen on overload', { timeout: 45_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemrouter-models-http-'));
  const fixtureKey = randomBytes(24).toString('hex'), admin = randomBytes(24).toString('hex'), restricted = randomBytes(24).toString('hex');
  const calls: string[] = [];
  let busy = false;
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const payload = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-goog-api-key'] !== fixtureKey && url.searchParams.get('key') !== fixtureKey) return payload(401, {});
    if (url.pathname === '/v1beta/models') {
      return payload(200, { models: [decision, hydrogen, flash].map((id) => ({ name: 'models/' + id,
        supportedGenerationMethods: [id === decision ? 'createDecision' : 'generateContent'] })) });
    }
    calls.push(url.pathname);
    if (url.pathname === '/v1beta/decisions') return payload(200, {
      answers: { red: { type: 'noul', noul: 0.99, confidence: 0.99 } }, usage: { total_input_tokens: 73, total_output_tokens: 0, total_tokens: 73 },
    });
    if (url.pathname === '/v1beta/models/' + hydrogen + ':generateContent' && busy) {
      return payload(503, { error: { status: 'UNAVAILABLE', message: 'Model is overloaded.' } });
    }
    const model = [flash, hydrogen].find((id) => url.pathname === '/v1beta/models/' + id + ':generateContent');
    if (model) return payload(200, { modelVersion: model, candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1, totalTokenCount: 13 } });
    return payload(404, {});
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: path.join(dir, 'no-env'), HOST: '127.0.0.1', PORT: '0',
      GEMROUTER_ROOT_DIR: dir, GEMROUTER_CODEX_ENABLED: 'false', GEMROUTER_CODEX_PRIVATE_DIR: path.join(dir, 'private'),
      GEMROUTER_GEMINI_API_BASE_URL: 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port,
      GEMROUTER_GEMINI_API_ACCOUNT_MODELS_REFRESH_MS: '0', GEMROUTER_GEMINI_API_KEYS_JSON: JSON.stringify([{ id: 'fixture', key: fixtureKey, models: [decision, hydrogen, flash] }]),
      GEMROUTER_ADMIN_TOKEN: admin, GEMROUTER_BOOTSTRAP_API_KEY: restricted, GEMROUTER_BOOTSTRAP_MODEL_ACCESS: 'custom',
      GEMROUTER_BOOTSTRAP_ALLOWED_MODELS: flash, GEMROUTER_FREE_TIER_TEXT_MODELS: [hydrogen, flash].join(','),
      GEMROUTER_TEXT_FALLBACK_MODELS: [hydrogen, flash].join(',') },
  });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill(); await exited;
    }
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  let error = '';
  server.stderr.on('data', (chunk) => { error = (error + chunk).slice(-1000); });
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Router startup timed out')), 20_000);
    let log = '';
    server.stdout.on('data', (chunk) => {
      log = (log + chunk).slice(-4096);
      const address = log.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (address) { clearTimeout(timer); resolve(address); }
    });
    server.once('exit', () => { clearTimeout(timer); reject(Error(error)); });
  });
  const call = (route: string, key?: string, body?: unknown) => fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(key && { authorization: 'Bearer ' + key }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const create = async (name: string, models?: string[]) => {
    const result = await call('/admin/apps', admin, { name, modelAccess: models ? 'custom' : 'all', allowedModels: models });
    assert.equal(result.status, 201, await result.clone().text());
    return (await result.json()).apiKey as string;
  };
  const all = await create('all-models'), explicit = await create('decision-only', [decision]);
  const request = { model: decision, input: 'A red hat.', questions: { red: { type: 'noul', instructions: 'Is it red?' } } };
  const chat = { messages: [{ role: 'user', content: 'Reply OK.' }] };
  assert.equal((await call('/v1beta/decisions', undefined, request)).status, 401);
  assert.equal((await call('/v1beta/decisions', restricted, request)).status, 403);
  assert.equal((await call('/v1beta/decisions', all, { ...request, questions: {} })).status, 400);
  assert.equal((await call('/v1/chat/completions', all, { model: decision, ...chat })).status, 400);
  assert.deepEqual(calls, []);
  for (const key of [all, explicit]) {
    const result = await call('/v1beta/decisions', key, request);
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(result.headers.get('x-gemrouter-backend-model'), decision);
    const body = await result.json();
    assert.equal(body.answers.red.noul, 0.99); assert.equal(body.usage.total_output_tokens, 0);
  }
  const permitted = await (await call('/v1/models', explicit)).json();
  assert.equal(permitted.data.find((m: { id: string }) => m.id === decision)?.endpoint, '/v1beta/decisions');
  const restrictedModels = await (await call('/v1/models', restricted)).json();
  assert.equal(restrictedModels.data.some((m: { id: string }) => [decision, hydrogen].includes(m.id)), false);
  const summary = await (await call('/dashboard/summary')).json();
  assert.equal(summary.stats.promptTokens, 146);
  assert.equal(summary.stats.completionTokens, 0);
  assert.equal(summary.stats.knownTotalTokens, 146);
  const answer = async (key: string) => {
    const result = await call('/v1/chat/completions', key, chat);
    assert.equal(result.status, 200, await result.clone().text());
    return result.headers.get('x-gemrouter-backend-model');
  };
  assert.equal(await answer(all), hydrogen);
  busy = true;
  assert.equal(await answer(all), flash);
  assert.equal(await answer(restricted), flash);
  const generate = (id: string) => '/v1beta/models/' + id + ':generateContent';
  assert.deepEqual(calls, ['/v1beta/decisions', '/v1beta/decisions', generate(hydrogen), generate(hydrogen), generate(flash), generate(flash)]);
});
