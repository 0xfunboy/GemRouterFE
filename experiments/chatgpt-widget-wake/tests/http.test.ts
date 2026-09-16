import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, lstat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProbe, RESOURCE } from '../server.js';
import { PREFIX } from '../protocol.js';
import { WORKER } from '../target.js';
import { ProbeState } from '../state.js';

const origin = 'https://gemrouter.example.com', widgetOrigin = 'https://web-sandbox.oaiusercontent.com';
const adminToken = 'A'.repeat(43), mount = '00000000-0000-0000-0000-a193fc1c44dd';
const headers = { origin: widgetOrigin, 'x-probe-mount': mount };
const adminHeaders = { host: '127.0.0.1:8808', authorization: 'Bearer ' + adminToken };
const config = { publicOrigin: origin, widgetOrigin, html: '<h1>SIMULATO static renderer</h1>', adminToken };

test('SIMULATO HTTP: app-scoped iframe origin is exact, siblings and generic default remain denied', async t => {
  const scopedOrigin = 'https://asdk_app_fixture.web-sandbox.oaiusercontent.com';
  const p = createProbe({ ...config, widgetOrigin: scopedOrigin }); t.after(() => p.close());
  const request = { method: 'OPTIONS' as const, url: PREFIX + '/enroll', headers: { origin: scopedOrigin,
    'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } };
  const allowed = await p.http.inject(request);
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], scopedOrigin);
  for (const denied of [widgetOrigin, 'https://another-app.web-sandbox.oaiusercontent.com', scopedOrigin + '.evil.example', 'null']) {
    const response = await p.http.inject({ ...request, headers: { ...request.headers, origin: denied } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const invalid = await p.http.inject({ method: 'POST', url: PREFIX + '/enroll',
    headers: { origin: scopedOrigin }, payload: { code: 'X'.repeat(43), mount } });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.headers['access-control-allow-origin'], scopedOrigin);
  assert.equal(invalid.json().error, 'invalid_or_expired_code');
});

test('SIMULATO HTTP: exact origin, admin auth, one-time code and capability separation', async t => {
  const p = createProbe(config); t.after(() => p.close());
  const preflight = await p.http.inject({ method: 'OPTIONS', url: PREFIX + '/events', headers: { ...headers,
    'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,x-probe-mount' } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], widgetOrigin);
  assert.match(String(preflight.headers['access-control-allow-headers']), /Authorization/);
  assert.equal((await p.admin.inject({ method: 'POST', url: '/issue', payload: {}, headers: { host: adminHeaders.host } })).statusCode, 401);
  assert.equal((await p.admin.inject({ method: 'POST', url: '/issue', payload: {}, headers: { ...adminHeaders, origin: widgetOrigin } })).statusCode, 403);
  const issue = (await p.admin.inject({ method: 'POST', url: '/issue', payload: {}, headers: adminHeaders })).json();
  const enrollment = { code: issue.code, mount };
  for (const bad of ['null', 'https://evil.example', '']) assert.equal((await p.http.inject({ method: 'POST', url: PREFIX + '/enroll', payload: enrollment, headers: { origin: bad } })).statusCode, 403);
  const enrolled = (await p.http.inject({ method: 'POST', url: PREFIX + '/enroll', payload: enrollment, headers })).json();
  const auth = { ...headers, authorization: 'Bearer ' + enrolled.token };
  assert.equal((await p.http.inject({ method: 'POST', url: PREFIX + '/enroll', payload: enrollment, headers })).statusCode, 401);
  assert.equal((await p.http.inject({ method: 'POST', url: PREFIX + '/check', payload: { eventId: enrolled.manualEvent.eventId, prompt: 'attack' }, headers: auth })).statusCode, 400);
  assert.equal((await p.http.inject({ method: 'POST', url: PREFIX + '/check', payload: { eventId: enrolled.manualEvent.eventId }, headers: auth })).statusCode, 200);
  assert.equal((await p.http.inject({ method: 'GET', url: PREFIX + '/events?token=forbidden', headers: auth })).statusCode, 403);
  assert.equal((await p.http.inject({ method: 'POST', url: PREFIX + '/emit', payload: {}, headers: auth })).statusCode, 404);
  assert.equal((await p.admin.inject({ method: 'POST', url: '/emit', payload: { sessionId: issue.sessionId, prompt: 'attack' }, headers: adminHeaders })).statusCode, 400);
  assert.equal((await p.http.inject({ method: 'POST', url: PREFIX + '/stop', payload: {}, headers: auth })).statusCode, 200);
  assert.equal((await p.http.inject({ method: 'POST', url: PREFIX + '/check', payload: { eventId: enrolled.manualEvent.eventId }, headers: auth })).statusCode, 410);
});
test('SIMULATO HTTP/MCP: SDK initialize/discovery/static render/resource, no AIR3 calls', async t => {
  const html = await readFile(new URL('../build/card.html', import.meta.url), 'utf8');
  const p = createProbe({ ...config, html }); t.after(() => p.close());
  const address = await p.http.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'SIMULATED-local-inspector', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(address + PREFIX + '/mcp')));
  const list = await client.listTools(); assert.deepEqual(list.tools.map(x => x.name), ['render_wake_probe']);
  const result = await client.callTool({ name: 'render_wake_probe', arguments: {} }); assert.ok(!result.isError);
  const resources = await client.listResources(); assert.equal(resources.resources[0].uri, RESOURCE);
  const resource = await client.readResource({ uri: RESOURCE });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  const text = (resource.contents[0] as { text: string }).text;
  assert.ok(text.includes('Prova manuale del bridge'));
  assert.ok(text.includes('24 ore'));
  assert.ok(text.includes('scadenza del singolo evento 60 secondi'));
  for (const privateValue of [WORKER, 'Example - Trade', '00000000-0000-0000-0000-b40c114d0582', adminToken]) assert.ok(!text.includes(privateValue));
  assert.deepEqual(p.state.report(), []);
});
test('SIMULATO HTTP: readiness requires exact origin and capability, cannot approve or stop a baseline', async t => {
  const p = createProbe(config); t.after(() => p.close());
  const issued = p.state.issue(), enrolled = p.state.enroll(issued.code, mount);
  const auth = { ...headers, authorization: 'Bearer ' + enrolled.token };
  const read = (requestHeaders = auth) => p.http.inject({ method: 'GET', url: PREFIX + '/readiness', headers: requestHeaders });
  assert.equal((await read({ ...auth, origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await read({ ...auth, authorization: '' })).statusCode, 401);
  assert.equal((await read({ ...auth, 'x-probe-mount': 'bad' })).statusCode, 401);
  assert.deepEqual((await read()).json(), { baselineVerified: false });
  assert.equal(p.state.report()[0].state, 'authorized');
  assert.equal(p.state.report()[0].connected, false);
  assert.equal((await p.http.inject({ method: 'POST', url: PREFIX + '/readiness', headers: auth,
    payload: { baselineVerified: true } })).statusCode, 404);
  for (const stage of ['received', 'bridge_requested', 'bridge_resolved'] as const) p.state.receipt(issued.sessionId, {
    eventId: enrolled.manualEvent.eventId, stage, method: 'ui/message', elapsedMs: 1,
    result: stage === 'bridge_resolved' ? 'accepted' : 'none', visibility: 'visible',
  });
  assert.deepEqual((await read()).json(), { baselineVerified: false });
  p.state.observe(issued.sessionId, { eventId: enrolled.manualEvent.eventId, outcome: 'model-tool',
    workerId: WORKER, conditions: 'foreground', targetConfirmed: true, turnEnded: true });
  assert.deepEqual((await read()).json(), { baselineVerified: true });
  assert.equal(p.state.report()[0].connected, false);
  p.state.stop(issued.sessionId);
  assert.equal((await read()).statusCode, 410);
});
test('SIMULATO HTTP/SSE: one stream, one event, no replay after disconnect, timer cleanup', async t => {
  let time = 0;
  const state = new ProbeState({ mono: () => time, wall: () => 1_800_000_000_000 + time });
  const p = createProbe(config, state); t.after(() => p.close());
  const base = await p.http.listen({ host: '127.0.0.1', port: 0 });
  const issued = state.issue(), enrolled = state.enroll(issued.code, mount);
  for (const stage of ['received', 'bridge_requested', 'bridge_resolved'] as const) state.receipt(issued.sessionId, {
    eventId: enrolled.manualEvent.eventId, stage, method: 'ui/message', elapsedMs: 1, result: 'none', visibility: 'visible',
  });
  state.observe(issued.sessionId, { eventId: enrolled.manualEvent.eventId, outcome: 'model-tool', workerId: WORKER, conditions: 'foreground', targetConfirmed: true, turnEnded: true });
  const abort = new AbortController(); t.after(() => abort.abort());
  const auth = { ...headers, authorization: 'Bearer ' + enrolled.token };
  const response = await fetch(base + PREFIX + '/events', { headers: auth, signal: abort.signal });
  assert.equal(response.status, 200); const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  assert.equal((await fetch(base + PREFIX + '/events', { headers: auth })).status, 409);
  time += 30_000; const event = state.emit(issued.sessionId);
  assert.match(new TextDecoder().decode((await reader.read()).value), new RegExp(event.eventId));
  await reader.cancel(); abort.abort();
  for (let i = 0; i < 100 && state.report()[0].state !== 'stopped'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.report()[0].stopReason, 'sse_closed');
  // Stop explicitly as well: shutdown is idempotent and cleans stream heartbeat.
  state.stop(issued.sessionId); assert.equal(state.report()[0].connected, false);
  assert.equal(state.report()[0].stopReason, 'sse_closed');
  assert.equal((await fetch(base + PREFIX + '/events', { headers: auth })).status, 410);
});
test('SIMULATO: feature off creates no private files; own widget source never invokes gateway tools', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gemrouter-widget-off-'));
  try {
    const privatePath = join(temp, 'not-created');
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'main.ts'], { cwd: new URL('..', import.meta.url), env: { ...process.env, WIDGET_WAKE_ENABLED: '0', WIDGET_WAKE_PRIVATE_DIR: privatePath }, encoding: 'utf8' });
    assert.match(out, /disabled/); await assert.rejects(lstat(privatePath), { code: 'ENOENT' });
  } finally { await rmdir(temp); }
  for (const file of ['widget.ts', 'client.ts']) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.callTool\s*\(|\.callServerTool\s*\(|\.createSamplingMessage\s*\(|tools\/call|localStorage|sessionStorage|window\.parent\./);
  }
});
