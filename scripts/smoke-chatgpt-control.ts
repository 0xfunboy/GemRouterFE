/** LOCAL SIMULATION, NEVER A LIVE CHATGPT TEST.
 * Real SQLite, control coordinator/admin routes and MCP Streamable HTTP; a small
 * authenticated HTTP inference fixture adapter; fake Codex/UI and deterministic
 * MCP worker. The existing smoke-chatgpt-mcp.ts separately exercises index.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createControlFixture, fixtureRequest } from '../tests/helpers/chatgpt-control-fixture.js';
import { ChatGptOAuthService } from '../src/llm/providers/chatgpt/auth.js';
import { registerChatGptMcpTransport } from '../src/llm/providers/chatgpt/transport.js';
import { registerPersonalControlRoutes } from '../src/llm/providers/chatgpt/control/adminRoutes.js';

if (process.argv.length !== 2) throw new Error('This smoke accepts no live mode or remote target arguments.');

const portServer = createServer();
await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const address = portServer.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const fixture = createControlFixture({ origin });
const app = Fastify({ logger: false });
const admin = randomUUID(); const csrf = randomUUID(); const appKey = randomUUID();
const adminHeaders = { authorization: `Bearer ${admin}`, 'content-type': 'application/json', 'x-fixture-csrf': csrf };
registerPersonalControlRoutes(app, fixture.controller, {
  ensureAdmin: (request, reply) => request.headers.authorization === adminHeaders.authorization || (reply.code(401).send({ error: 'unauthorized' }), false),
  ensureAdminMutation: (request, reply) => (request.headers.authorization === adminHeaders.authorization && request.headers['x-fixture-csrf'] === csrf) || (reply.code(403).send({ error: 'forbidden' }), false),
  adminCsrf: () => csrf, audit: () => {},
});
const oauth = new ChatGptOAuthService(fixture.store, origin);
registerChatGptMcpTransport(app, fixture.gateway, oauth);
app.post<{ Body: { model?: string; fixtureKey?: string } }>('/fixture/chat/completions', async (request, reply) => {
  if (request.headers.authorization !== `Bearer ${appKey}`) return reply.code(401).send({ error: 'unauthorized' });
  if (request.body?.model !== 'air3-trade') return reply.code(400).send({ error: 'exact_alias_required' });
  const abort = new AbortController();
  const disconnected = () => { if (!reply.raw.writableEnded) abort.abort(); };
  reply.raw.once('close', disconnected);
  try {
    const result = await fixture.gateway.submit({ ...fixtureRequest(request.body.fixtureKey), signal: abort.signal });
    return reply.header('x-gemrouter-backend', 'chatgpt').send({ model: result.alias, choices: [{ message: { role: 'assistant', content: result.content } }] });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'fixture_error';
    return reply.code(503).send({ error: { code } });
  } finally { reply.raw.removeListener('close', disconnected); }
});

const mcp = new Client({ name: 'SIMULATED-personal-chat-worker', version: '1.0.0' });
let workerFlight: Promise<void> | undefined;
let nextExchange = fixture.opened.next_exchange_id;
let completed = 0;
const timing: Array<{ request: number; elapsedMs: number }> = [];

function payload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, any> {
  if (result.isError) throw new Error('Local MCP tool returned an error; contents intentionally omitted.');
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, any>;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (!first || first.type !== 'text') throw new Error('Missing structured local MCP result');
  return JSON.parse(first.text);
}
async function adminPost(action: string) {
  const response = await fetch(`${origin}/admin/chatgpt/control/bindings/trade/${action}`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ expectedBindingVersion: 1, confirm: true }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `Local admin ${action} failed`);
  return await response.json() as Record<string, any>;
}
async function runWorkerOnce(): Promise<void> {
  const poll = payload(await mcp.callTool({ name: 'gateway_exchange', arguments: { run_id: fixture.opened.run_id, exchange_id: nextExchange, maximum_wait_seconds: 1 } }));
  nextExchange = poll.next_exchange_id;
  assert.equal(poll.state, 'request');
  assert.match(poll.request.messages[0].content, /PRIVATE_JOB_/u);
  const acknowledgement = payload(await mcp.callTool({ name: 'gateway_exchange', arguments: {
    run_id: fixture.opened.run_id, exchange_id: nextExchange, yield_after_completion: true,
    completion: { request_id: poll.request.request_id, claim_token: poll.request.claim_token, response: 'MCP_CONTROL_SMOKE_OK 323' },
  } }));
  nextExchange = acknowledgement.next_exchange_id;
  assert.equal(acknowledgement.state, 'yielded');
  completed++;
}
async function infer(number: number) {
  const started = performance.now();
  const response = await fetch(`${origin}/fixture/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${appKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'air3-trade', fixtureKey: `control-smoke-${number}` }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-gemrouter-backend'), 'chatgpt');
  const body = await response.json() as Record<string, any>;
  assert.equal(body.choices[0].message.content, 'MCP_CONTROL_SMOKE_OK 323');
  timing.push({ request: number, elapsedMs: Math.round(performance.now() - started) });
  await workerFlight;
}

try {
  await app.listen({ host: '127.0.0.1', port });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(fixture.resource('trade')), { requestInit: { headers: { authorization: `Bearer ${fixture.tokens.accessToken}` } } }));
  const tools = await mcp.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['gateway_exchange', 'gateway_open', 'gateway_status']);
  const originalGrant = fixture.store.listGrants('trade').map((grant) => ({ id: grant.id, revokedAt: grant.revokedAt }));
  fixture.behavior.onDiagnostic = async () => String(payload(await mcp.callTool({ name: 'gateway_status', arguments: {} })).workerId);
  const rejected = await fetch(`${origin}/admin/chatgpt/control/bindings/trade/arm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedBindingVersion: 1, confirm: true }) });
  assert.equal(rejected.status, 403);
  await adminPost('diagnostic');
  assert.equal(fixture.store.getControlBinding('trade')!.gatewayStatusVerified, true);
  assert.equal(fixture.store.workerStatus('trade').pendingWorkerPolls, 0, 'Status must not masquerade as polling');
  await adminPost('arm');
  fixture.calls.instructions.length = 0; fixture.calls.sends.length = 0;
  fixture.behavior.onResume = async () => {
    // This fixture callback stands for the personal chat UI reacting to wake.
    // The controller itself never receives the tool call's private job/result.
    workerFlight = runWorkerOnce();
    await workerFlight;
  };
  fixture.controller.start();
  await infer(1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fixture.store.workerStatus('trade').pendingWorkerPolls, 0);
  await infer(2);
  assert.equal(completed, 2);
  assert.equal(fixture.calls.sends.length, 2);
  assert.equal(fixture.calls.creates, 0);
  assert.doesNotMatch(JSON.stringify(fixture.calls.instructions), /PRIVATE_JOB_|control-smoke-|claim_token|MCP_CONTROL_SMOKE_OK/u);
  assert.equal(fixture.store.getWorker('trade')!.runGeneration, 1, 'Resume must preserve the existing run');
  assert.deepEqual(fixture.store.listGrants('trade').map((grant) => ({ id: grant.id, revokedAt: grant.revokedAt })), originalGrant);
  assert.ok(fixture.store.listControlWakeStatus().every((wake) => wake.state === 'mcp_poll_observed'));
  await adminPost('stop');
  assert.equal(fixture.store.getControlBinding('trade')!.wakeEnabled, false);
  process.stdout.write(JSON.stringify({ smoke: 'LOCAL_SIMULATION_ONLY', transport: 'actual HTTP + MCP (three worker tools)',
    inferenceIngress: 'minimal authenticated fixture adapter; production index covered separately', codexAndUi: 'simulated',
    production: 'untouched', liveChatGptVerified: false, inferenceCompletionsFromMcp: completed, repeatedWakePreservesRun: true,
    originalGrantPreserved: true, timings: timing }) + '\n');
} finally {
  await mcp.close().catch(() => {});
  await app.close();
  await fixture.close();
}
