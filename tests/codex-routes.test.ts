import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerCodexAccountRoutes } from '../src/codex/routes.js';
import { CodexRuntime } from '../src/codex/runtime.js';

test('Codex routes require admin/CSRF, validate inputs, isolate login owner and omit raw errors', async (t) => {
  const app = Fastify(); t.after(() => app.close());
  const runtime = new CodexRuntime({ enabled: false, command: '/not-used', profileDirectory: '/not-used', requestedModel: 'test' });
  let calls = 0; let owner = ''; const audit: unknown[] = [];
  runtime.startLogin = async (id) => { calls++; owner = id; return { status: 'pending', mode: 'device', expiresAt: Date.now() + 1000, userCode: 'FAKE-CODE' }; };
  runtime.usage = async () => { throw new Error('PRIVATE_RUNTIME_TOKEN'); };
  registerCodexAccountRoutes(app, runtime, {
    ensureAdmin: (req, reply) => { if (req.headers.authorization === 'Bearer fixture') return true; reply.code(401).send(); return false; },
    ensureAdminMutation: (req, reply) => { if (req.headers.authorization === 'Bearer fixture' && req.headers['x-csrf'] === 'fixture') return true; reply.code(403).send(); return false; },
    adminCsrf: () => null, audit: (e) => { audit.push(e); },
  });
  assert.equal((await app.inject('/admin/codex/account')).statusCode, 401);
  const headers = { authorization: 'Bearer fixture', 'x-csrf': 'fixture' };
  const snapshot = await app.inject({ url: '/admin/codex/account', headers });
  assert.equal(snapshot.headers['cache-control'], 'no-store');
  assert.equal(snapshot.json().inferenceEnabled, false);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/codex/account/login', headers: { authorization: 'Bearer fixture' }, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/codex/account/login', headers, payload: { mode: 'browser' } })).statusCode, 400);
  assert.equal(calls, 0);
  const login = await app.inject({ method: 'POST', url: '/admin/codex/account/login', headers, payload: {} });
  assert.equal(login.json().userCode, 'FAKE-CODE'); assert.match(owner, /^[a-f0-9]{64}$/);
  const failed = await app.inject({ method: 'POST', url: '/admin/codex/account/usage', headers, payload: {} });
  assert.equal(failed.json().error, 'codex_account_failed');
  assert.equal(JSON.stringify(audit).includes('FAKE-CODE'), false);
  assert.equal(JSON.stringify(audit).includes('PRIVATE_RUNTIME_TOKEN'), false);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/codex/account/browser/login', headers, payload: {} })).statusCode, 404);
});
