import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerPersonalControlRoutes } from '../src/llm/providers/chatgpt/control/adminRoutes.js';
import type { PersonalChatController } from '../src/llm/providers/chatgpt/control/controller.js';

async function fixture() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const events: unknown[] = [];
  const action = (method: string, response: unknown = { ok: true }) => (...args: unknown[]) => { calls.push({ method, args }); return response; };
  const control = {
    config: { enabled: true }, snapshot: action('snapshot', { privateTarget: 'PRIVATE_ADMIN_CHAT' }), stopAll: action('stopAll'),
    saveBinding: action('saveBinding', { workerId: 'worker-one' }), arm: action('arm'), stop: action('stop'), inspect: action('inspect'), send: action('send'), create: action('create'),
    runtime: { status: action('status'), startLogin: action('startLogin', { status: 'pending', userCode: 'PRIVATE_CODE' }), loginStatus: action('loginStatus'), cancelLogin: action('cancelLogin'), logout: action('logout') },
    browser: { launchLogin: action('launchLogin') },
  } as unknown as PersonalChatController;
  const app = Fastify({ logger: false });
  registerPersonalControlRoutes(app, control, {
    ensureAdmin(request, reply) { if (request.headers.authorization !== 'Bearer ADMIN') { reply.code(401).send({ error: 'unauthorized' }); return false; } return true; },
    ensureAdminMutation(request, reply) { if (request.headers.authorization !== 'Bearer ADMIN' || request.headers['x-csrf'] !== 'CSRF') { reply.code(403).send({ error: 'forbidden' }); return false; } return true; },
    adminCsrf: () => 'CSRF', audit: (event) => { events.push(event); },
  });
  await app.ready();
  return { app, calls, events, headers: { authorization: 'Bearer ADMIN', 'x-csrf': 'CSRF' } };
}

test('control admin routes expose no private metadata to guests and require CSRF for mutations', async () => {
  const f = await fixture();
  try {
    for (const url of ['/admin/chatgpt/control', '/admin/chatgpt/control/runtime/login']) {
      const response = await f.app.inject({ url }); assert.equal(response.statusCode, 401); assert.doesNotMatch(response.body, /PRIVATE/u); assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal((await f.app.inject({ method: 'POST', url: '/admin/chatgpt/control/runtime/login', headers: { authorization: 'Bearer ADMIN' }, payload: { mode: 'device' } })).statusCode, 403);
    assert.deepEqual(f.calls, []);
    assert.equal((await f.app.inject({ url: '/admin/chatgpt/control', headers: f.headers })).json().privateTarget, 'PRIVATE_ADMIN_CHAT');
    assert.equal(f.calls[0]?.method, 'snapshot');
  } finally { await f.app.close(); }
});

test('login owner is hashed and ephemeral codes are not audited', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: 'POST', url: '/admin/chatgpt/control/runtime/login', headers: f.headers, payload: { mode: 'device' } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().userCode, 'PRIVATE_CODE');
    const login = f.calls.find((call) => call.method === 'startLogin')!;
    assert.match(String(login.args[0]), /^[a-f0-9]{64}$/u); assert.equal(login.args[1], 'device');
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_CODE|ADMIN|CSRF/u);
  } finally { await f.app.close(); }
});

test('binding routes reject arbitrary prompts, forged readiness and missing optimistic version', async () => {
  const f = await fixture();
  try {
    const body = { expectedAccountLabel: 'Account', expectedConnectorLabel: 'Connector', operatorResourceConfirmed: true,
      chatgptConversationUrl: 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000001', expectedBindingVersion: 0 };
    for (const payload of [{ ...body, prompt: 'INJECT' }, { ...body, targetVerified: true }, { ...body, expectedBindingVersion: undefined }]) {
      assert.equal((await f.app.inject({ method: 'PUT', url: '/admin/chatgpt/control/bindings/worker-one', headers: f.headers, payload })).statusCode, 400);
    }
    assert.equal(f.calls.length, 0);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/admin/chatgpt/control/bindings/worker-one', headers: f.headers, payload: body })).statusCode, 200);
    assert.equal(f.calls[0]?.method, 'saveBinding');
    for (const payload of [{ confirm: true }, { confirm: false, expectedBindingVersion: 1 }, { confirm: true, expectedBindingVersion: 1, prompt: 'INJECT' }]) {
      assert.equal((await f.app.inject({ method: 'POST', url: '/admin/chatgpt/control/bindings/worker-one/resume', headers: f.headers, payload })).statusCode, 400);
    }
    assert.equal((await f.app.inject({ method: 'POST', url: '/admin/chatgpt/control/bindings/worker-one/bootstrap', headers: f.headers, payload: { confirm: true, expectedBindingVersion: 1 } })).statusCode, 200);
    assert.deepEqual(f.calls.at(-1), { method: 'send', args: ['worker-one', 1, 'bootstrap'] });
  } finally { await f.app.close(); }
});
