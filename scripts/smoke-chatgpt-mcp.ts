import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function jsonRequest(url: string, init?: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let value: any;
  try { value = text ? JSON.parse(text) : {}; } catch { value = text; }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${new URL(url).pathname}: request failed (response omitted to protect credentials)`);
  return value as Record<string, any>;
}

async function expectOpenAiError(url: string, status: number, code: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  const body = await response.json() as { error?: { code?: string } };
  assert.equal(response.status, status);
  assert.equal(body.error?.code, code);
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`GemRouter exited early (${child.exitCode}).\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The isolated local process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the isolated GemRouter process.\n${logs()}`);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try { await exit; } finally { clearTimeout(force); }
}

function hiddenValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`OAuth consent page omitted ${name}`);
  return match[1].replace(/&amp;/gu, '&').replace(/&#39;/gu, "'").replace(/&quot;/gu, '"');
}

function toolPayload(result: { structuredContent?: unknown; content?: unknown }): Record<string, any> {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, any>;
  const first = Array.isArray(result.content) ? result.content[0] as { text?: string } : undefined;
  return JSON.parse(String(first?.text ?? '{}')) as Record<string, any>;
}

async function liveMain(): Promise<void> {
  const baseUrl = String(process.env.GEMROUTER_BASE_URL ?? '').replace(/\/$/u, '');
  const apiKey = String(process.env.GEMROUTER_API_KEY ?? '');
  const alias = String(process.env.GEMROUTER_CHATGPT_ALIAS ?? '');
  if (!baseUrl || !apiKey || !alias) {
    throw new Error('Live mode requires GEMROUTER_BASE_URL, GEMROUTER_API_KEY and GEMROUTER_CHATGPT_ALIAS.');
  }
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('Live mode requires a public HTTPS GemRouter origin.');
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'x-gemrouter-backend': 'chatgpt',
  };
  const textResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': `live-text-${randomUUID()}` },
    body: JSON.stringify({
      model: alias,
      messages: [{ role: 'user', content: process.env.GEMROUTER_CHATGPT_LIVE_PROMPT ?? 'Reply exactly: GATEWAY_LIVE_OK' }],
    }),
    signal: AbortSignal.timeout(320_000),
  });
  if (!textResponse.ok) throw new Error(`Live ChatGPT text request failed with HTTP ${textResponse.status}.`);
  assert.equal(textResponse.headers.get('x-gemrouter-backend'), 'chatgpt');
  assert.equal(textResponse.headers.get('x-gemrouter-usage'), 'unavailable');
  const textBody = await textResponse.json() as Record<string, any>;
  assert.equal(textBody.model, alias);
  assert.equal('usage' in textBody, false);
  assert.ok(String(textBody.choices?.[0]?.message?.content ?? '').trim());

  const streamResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': `live-stream-${randomUUID()}` },
    body: JSON.stringify({
      model: alias,
      stream: true,
      messages: [{ role: 'user', content: 'Reply exactly: GATEWAY_LIVE_STREAM_OK' }],
    }),
    signal: AbortSignal.timeout(320_000),
  });
  if (!streamResponse.ok) throw new Error(`Live ChatGPT buffered stream request failed with HTTP ${streamResponse.status}.`);
  assert.equal(streamResponse.headers.get('x-gemrouter-backend'), 'chatgpt');
  assert.equal(streamResponse.headers.get('x-gemrouter-stream'), 'buffered');
  const streamBody = await streamResponse.text();
  assert.match(streamBody, /data: \[DONE\]/u);
  assert.doesNotMatch(streamBody, /prompt_tokens|completion_tokens/u);
  process.stdout.write('REMOTE gateway smoke: text and buffered SSE passed. Actual ChatGPT conversation identity must be verified separately by the operator.\n');
}

async function simulatedMain(): Promise<void> {
  const entrypoint = path.resolve('dist/index.js');
  const adminToken = `smoke-admin-${randomUUID()}`;
  const appToken = `smoke-app-${randomUUID()}`;
  // No inherited provider credentials or repository .env: the smoke can only
  // access its temporary state and explicitly configured loopback listeners.
  const isolatedEnv = {
    PATH: process.env.PATH,
    GEMROUTER_GEMINI_API_ENABLED: 'false',
    GEMROUTER_NVIDIA_ENABLED: 'false',
    GEMROUTER_NVIDIA_PROBE_ENABLED: 'false',
    GEMROUTER_AGNES_ENABLED: 'false',
    GEMROUTER_OLLAMA_ENABLED: 'false',
    GEMROUTER_OLLAMA_LOCAL_ENABLED: 'false',
    GEMROUTER_BACKEND_ORDER: 'gemini-api',
  };
  const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'gemrouter-chatgpt-smoke-'));
  const disabledRoot = path.join(isolatedRoot, 'disabled');
  const disabledPort = await freePort();
  const disabledBaseUrl = `http://127.0.0.1:${disabledPort}`;
  let disabledLogs = '';
  const disabledChild = spawn(process.execPath, [entrypoint], {
    cwd: isolatedRoot,
    env: {
      ...isolatedEnv,
      HOST: '127.0.0.1',
      PORT: String(disabledPort),
      GEMROUTER_ROOT_DIR: disabledRoot,
      GEMROUTER_DATA_DIR: 'data',
      GEMROUTER_ADMIN_TOKEN: adminToken,
      GEMROUTER_BOOTSTRAP_API_KEY: appToken,
      GEMROUTER_CHATGPT_ENABLED: 'false',
      GEMROUTER_FREE_TIER_POLICY_ENABLED: 'false',
      GEMROUTER_GEMINI_API_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  disabledChild.stdout?.on('data', (chunk) => { disabledLogs += String(chunk); });
  disabledChild.stderr?.on('data', (chunk) => { disabledLogs += String(chunk); });
  try {
    await waitForHealth(disabledBaseUrl, disabledChild, () => disabledLogs);
    const disabledSummary = await jsonRequest(`${disabledBaseUrl}/admin/summary`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(disabledSummary.chatgpt.enabled, false);
    assert.equal((await fetch(`${disabledBaseUrl}/oauth/chatgpt/register`, { method: 'POST' })).status, 404);
  } finally {
    await terminateChild(disabledChild);
  }
  assert.equal(existsSync(path.join(disabledRoot, 'data', 'chatgpt-gateway', 'gateway.sqlite')), false);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, [entrypoint], {
    cwd: isolatedRoot,
    env: {
      ...isolatedEnv,
      HOST: '127.0.0.1',
      PORT: String(port),
      GEMROUTER_ROOT_DIR: isolatedRoot,
      GEMROUTER_DATA_DIR: 'data',
      GEMROUTER_ADMIN_TOKEN: adminToken,
      GEMROUTER_BOOTSTRAP_API_KEY: appToken,
      GEMROUTER_BOOTSTRAP_APP_NAME: 'smoke-app',
      GEMROUTER_BOOTSTRAP_ALLOWED_ORIGINS: '*',
      GEMROUTER_BOOTSTRAP_MODEL_ACCESS: 'all',
      GEMROUTER_CHATGPT_ENABLED: 'true',
      GEMROUTER_CHATGPT_PUBLIC_BASE_URL: baseUrl,
      GEMROUTER_CHATGPT_DATA_DIR: 'data/chatgpt-gateway',
      GEMROUTER_CHATGPT_TIMEOUT_MS: '5000',
      GEMROUTER_CHATGPT_QUEUE_TIMEOUT_MS: '2000',
      GEMROUTER_CHATGPT_LONG_POLL_MS: '1000',
      GEMROUTER_CHATGPT_STALE_AFTER_MS: '5000',
      GEMROUTER_FREE_TIER_POLICY_ENABLED: 'false',
      GEMROUTER_GEMINI_API_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => { logs += String(chunk); });
  child.stderr?.on('data', (chunk) => { logs += String(chunk); });
  const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  let mcpClient: Client | undefined;
  try {
    await waitForHealth(baseUrl, child, () => logs);
    const discovery = await jsonRequest(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(discovery.issuer, baseUrl);
    assert.equal(discovery.registration_endpoint, `${baseUrl}/oauth/chatgpt/register`);
    const closedRegistration = await fetch(`${baseUrl}/oauth/chatgpt/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(closedRegistration.status, 400);
    assert.equal((await closedRegistration.json() as { error?: string }).error, 'registration_closed');
    const summary = await jsonRequest(`${baseUrl}/admin/summary`, { headers: adminHeaders });
    const appId = String(summary.apps[0].id);
    await jsonRequest(`${baseUrl}/admin/chatgpt/workers`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({
        id: 'smoke-worker',
        label: 'Simulated smoke worker',
        publicModelIds: ['chatgpt-smoke'],
        allowedAppIds: [appId],
        declaredModel: 'Simulated ChatGPT model',
        timeoutMs: 5_000,
        queueTimeoutMs: 2_000,
      }),
    });
    await jsonRequest(`${baseUrl}/admin/chatgpt/workers/smoke-worker`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ enabled: true }),
    });
    const guestSummary = await jsonRequest(`${baseUrl}/dashboard/summary`);
    assert.doesNotMatch(JSON.stringify(guestSummary), /chatgpt-smoke|smoke-worker/u);
    for (const shell of ['/', '/admin']) {
      assert.doesNotMatch(await (await fetch(`${baseUrl}${shell}`, { headers: { accept: 'text/html' } })).text(), /chatgpt-smoke|smoke-worker/u);
    }
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
    });
    assert.equal(login.status, 200);
    const sessionCookie = String(login.headers.get('set-cookie') ?? '').split(';', 1)[0];
    const me = await jsonRequest(`${baseUrl}/auth/me`, { headers: { cookie: sessionCookie } });
    for (const route of ['/auth/me', '/admin/summary', '/admin/chatgpt']) {
      const crossOrigin = await fetch(`${baseUrl}${route}`, { headers: { cookie: sessionCookie, origin: 'https://untrusted.example' } });
      assert.equal(crossOrigin.headers.get('access-control-allow-origin'), null, 'App wildcard CORS must not expose the admin plane');
      assert.equal(crossOrigin.headers.get('cache-control'), 'no-store');
    }
    const crossMutation = await fetch(`${baseUrl}/admin/chatgpt/workers/smoke-worker`, {
      method: 'PUT', headers: { cookie: sessionCookie, origin: 'https://untrusted.example', 'content-type': 'application/json', 'x-gemrouter-csrf': String(me.csrfToken) },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(crossMutation.status, 403);
    assert.equal((await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: JSON.stringify({ token: adminToken }),
    })).status, 403);
    const missingCsrf = await fetch(`${baseUrl}/admin/chatgpt/workers/smoke-worker/pairing`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json() as { error?: { code?: string } }).error?.code, 'invalid_csrf_token');
    assert.equal((await fetch(`${baseUrl}/admin/chatgpt/workers/smoke-worker/pairing`, {
      method: 'POST',
      headers: { cookie: sessionCookie, 'x-gemrouter-csrf': String(me.csrfToken), 'content-type': 'application/json' },
      body: '{}',
    })).status, 200);
    const isolatedApp = await jsonRequest(`${baseUrl}/admin/apps`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({
        name: 'not-allowed',
        modelAccess: 'custom',
        allowedModels: ['chatgpt-smoke'],
      }),
    });
    const chatBody = JSON.stringify({ model: 'chatgpt-smoke', messages: [{ role: 'user', content: 'must not enqueue' }] });
    await expectOpenAiError(`${baseUrl}/v1/chat/completions`, 403, 'chatgpt_model_not_allowed', {
      method: 'POST', headers: { authorization: `Bearer ${isolatedApp.apiKey}`, 'content-type': 'application/json' }, body: chatBody,
    });
    const isolatedModels = await jsonRequest(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${isolatedApp.apiKey}` } });
    assert.equal(isolatedModels.data.some((model: { id?: string }) => model.id === 'chatgpt-smoke'), false);
    // Unknown ordinary models must not fall back to an otherwise allowed worker alias.
    const ordinaryDenied = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${isolatedApp.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'unknown-ordinary-model', messages: [{ role: 'user', content: 'do not route to a worker' }] }),
    });
    assert.equal(ordinaryDenied.status, 403);
    const wizardSetup = { label: 'Guided worker', alias: 'guided-private', appId: isolatedApp.app.id };
    assert.equal((await fetch(`${baseUrl}/admin/chatgpt/onboarding`, {
      method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json' }, body: JSON.stringify(wizardSetup),
    })).status, 403);
    const guided = await jsonRequest(`${baseUrl}/admin/chatgpt/onboarding`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify(wizardSetup),
    });
    assert.equal(guided.worker.enabled, false);
    assert.equal(guided.worker.modelVerified, false);
    assert.equal((await fetch(`${baseUrl}/admin/chatgpt/workers/${guided.worker.id}/activate`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ appId }),
    })).status, 400);
    const activated = await jsonRequest(`${baseUrl}/admin/chatgpt/workers/${guided.worker.id}/activate`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ appId: isolatedApp.app.id }),
    });
    assert.equal(activated.worker.enabled, true);
    const updatedSummary = await jsonRequest(`${baseUrl}/admin/summary`, { headers: adminHeaders });
    assert.deepEqual(updatedSummary.apps.find((entry: { id: string }) => entry.id === isolatedApp.app.id).allowedModels.sort(), ['chatgpt-smoke', 'guided-private']);
    await expectOpenAiError(`${baseUrl}/v1/chat/completions`, 400, 'chatgpt_backend_mismatch', {
      method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json', 'x-gemrouter-backend': 'nvidia' }, body: chatBody,
    });
    await expectOpenAiError(`${baseUrl}/v1/chat/completions`, 404, 'chatgpt_model_not_found', {
      method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json', 'x-gemrouter-backend': 'chatgpt' }, body: JSON.stringify({ model: 'missing-alias', messages: [{ role: 'user', content: 'x' }] }),
    });
    await expectOpenAiError(`${baseUrl}/v1/responses`, 400, 'chatgpt_unsupported_surface', {
      method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'chatgpt-smoke', input: 'x' }),
    });
    await expectOpenAiError(`${baseUrl}/api/show`, 400, 'chatgpt_unsupported_surface', {
      method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'chatgpt-smoke' }),
    });
    await expectOpenAiError(`${baseUrl}/v1/chat/completions`, 400, 'chatgpt_unsupported_parameter', {
      method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'chatgpt-smoke', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'x' } }] }),
    });
    await expectOpenAiError(`${baseUrl}/v1/chat/completions`, 503, 'chatgpt_worker_unavailable', {
      method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' }, body: chatBody,
    });
    const pairing = await jsonRequest(`${baseUrl}/admin/chatgpt/workers/smoke-worker/pairing`, {
      method: 'POST', headers: adminHeaders, body: '{}',
    });
    assert.equal(pairing.mcpUrl, `${baseUrl}/mcp/chatgpt/smoke-worker`);
    assert.match(String(pairing.workerPrompt), /gateway_exchange/u);
    const protectedResource = await jsonRequest(`${baseUrl}/.well-known/oauth-protected-resource/mcp/chatgpt/smoke-worker`);
    assert.equal(protectedResource.resource, pairing.mcpUrl);

    const unauthenticatedMcp = await fetch(pairing.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(unauthenticatedMcp.status, 401);
    const appKeyOnMcp = await fetch(pairing.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(appKeyOnMcp.status, 401);

    const redirectUri = `${baseUrl}/smoke-oauth-callback`;
    const registration = await jsonRequest(`${baseUrl}/oauth/chatgpt/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        client_name: 'GemRouter simulated smoke',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const verifier = 's'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${baseUrl}/oauth/chatgpt/authorize`);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      resource: pairing.mcpUrl,
      scope: 'mcp:tools offline_access',
      state: 'smoke-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    const consentResponse = await fetch(authorize, { headers: { authorization: adminHeaders.authorization } });
    assert.equal(consentResponse.status, 200);
    const consent = await consentResponse.text();
    const approval = await fetch(`${baseUrl}/oauth/chatgpt/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: adminHeaders.authorization, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: hiddenValue(consent, 'request_id'),
        request_csrf_token: hiddenValue(consent, 'request_csrf_token'),
        session_csrf_token: '',
        decision: 'approve',
      }),
    });
    assert.equal(approval.status, 303);
    const callback = new URL(String(approval.headers.get('location')));
    assert.equal(callback.searchParams.get('state'), 'smoke-state');
    const token = await jsonRequest(`${baseUrl}/oauth/chatgpt/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registration.client_id,
        code: String(callback.searchParams.get('code')),
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    const reusedCode = await fetch(`${baseUrl}/oauth/chatgpt/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registration.client_id,
        code: String(callback.searchParams.get('code')),
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    assert.equal(reusedCode.status, 400);
    assert.equal((await reusedCode.json() as { error?: string }).error, 'invalid_grant');
    assert.equal((await fetch(`${baseUrl}/admin/chatgpt`, { headers: { authorization: `Bearer ${token.access_token}` } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/admin/chatgpt`, { headers: { authorization: `Bearer ${appToken}` } })).status, 401);
    await expectOpenAiError(`${baseUrl}/v1/chat/completions`, 401, 'invalid_api_key', {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
      body: chatBody,
    });
    const wrongWorkerMcp = await fetch(`${baseUrl}/mcp/chatgpt/other-worker`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(wrongWorkerMcp.status, 401);
    const hostileHost = await fetch(pairing.mcpUrl, {
      method: 'POST',
      headers: { host: 'attacker.invalid', authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.ok([400, 421].includes(hostileHost.status));
    const hostileOrigin = await fetch(pairing.mcpUrl, {
      method: 'POST',
      headers: { origin: 'https://attacker.invalid', authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(hostileOrigin.status, 403);

    mcpClient = new Client({ name: 'gemrouter-simulated-worker', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(pairing.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token.access_token}` } },
    });
    await mcpClient.connect(transport);
    const tools = await mcpClient.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['gateway_exchange', 'gateway_open', 'gateway_status']);
    assert.equal(tools.tools.find((tool) => tool.name === 'gateway_status')?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === 'gateway_exchange')?.annotations?.readOnlyHint, false);
    const opened = toolPayload(await mcpClient.callTool({
      name: 'gateway_open',
      arguments: { protocol_version: '1.0', open_id: pairing.openId },
    }));

    const firstPoll = mcpClient.callTool({
      name: 'gateway_exchange',
      arguments: { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const httpCompletion = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'smoke-http-1',
      },
      body: JSON.stringify({
        model: 'chatgpt-smoke',
        messages: [{ role: 'user', content: 'simulated private request' }],
        temperature: 0.2,
      }),
    });
    const claim = toolPayload(await firstPoll);
    assert.equal(claim.state, 'request');
    assert.equal(claim.request.model_alias, 'chatgpt-smoke');
    const completionExchange = mcpClient.callTool({
      name: 'gateway_exchange',
      arguments: {
        run_id: opened.run_id,
        exchange_id: claim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: {
          request_id: claim.request.request_id,
          claim_token: claim.request.claim_token,
          response: 'simulated worker answer',
        },
      },
    });
    const httpResponse = await httpCompletion;
    assert.equal(httpResponse.status, 200);
    assert.equal(httpResponse.headers.get('x-gemrouter-backend'), 'chatgpt');
    assert.equal(httpResponse.headers.get('x-gemrouter-usage'), 'unavailable');
    assert.equal(httpResponse.headers.get('x-gemrouter-stream'), 'buffered');
    assert.match(String(httpResponse.headers.get('x-gemrouter-gateway-warnings')), /ignored_temperature/u);
    const completionBody = await httpResponse.json() as Record<string, any>;
    assert.equal(completionBody.choices[0].message.content, 'simulated worker answer');
    assert.equal(completionBody.model, 'chatgpt-smoke');
    assert.equal('usage' in completionBody, false);
    const idle = toolPayload(await completionExchange);

    const jsonPoll = mcpClient.callTool({
      name: 'gateway_exchange',
      arguments: { run_id: opened.run_id, exchange_id: idle.next_exchange_id, maximum_wait_seconds: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const jsonCompletion = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'chatgpt-smoke',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'return an object' }] }],
        response_format: { type: 'json_object' },
      }),
    });
    const jsonClaim = toolPayload(await jsonPoll);
    const afterJson = mcpClient.callTool({
      name: 'gateway_exchange',
      arguments: {
        run_id: opened.run_id,
        exchange_id: jsonClaim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: {
          request_id: jsonClaim.request.request_id,
          claim_token: jsonClaim.request.claim_token,
          response: '{"gateway":true}',
        },
      },
    });
    const jsonResponse = await jsonCompletion;
    assert.equal(jsonResponse.status, 200);
    assert.equal((await jsonResponse.json() as Record<string, any>).choices[0].message.content, '{"gateway":true}');
    const afterJsonState = toolPayload(await afterJson);

    await expectOpenAiError(`${baseUrl}/v1/chat/completions`, 400, 'chatgpt_unsupported_parameter', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appToken}`,
        'content-type': 'application/json',
        'x-gemrouter-gateway-profile': 'strict',
      },
      body: JSON.stringify({ model: 'chatgpt-smoke', messages: [{ role: 'user', content: 'strict' }], temperature: 0 }),
    });

    const streamPoll = mcpClient.callTool({
      name: 'gateway_exchange',
      arguments: { run_id: opened.run_id, exchange_id: afterJsonState.next_exchange_id, maximum_wait_seconds: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const bufferedStream = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json', origin: 'https://authorized-app.example' },
      body: JSON.stringify({
        model: 'chatgpt-smoke',
        messages: [{ role: 'user', content: 'buffered request' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const streamClaim = toolPayload(await streamPoll);
    const finalExchange = mcpClient.callTool({
      name: 'gateway_exchange',
      arguments: {
        run_id: opened.run_id,
        exchange_id: streamClaim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: {
          request_id: streamClaim.request.request_id,
          claim_token: streamClaim.request.claim_token,
          response: 'buffered answer',
        },
      },
    });
    const streamResponse = await bufferedStream;
    assert.equal(streamResponse.status, 200);
    assert.equal(streamResponse.headers.get('access-control-allow-origin'), 'https://authorized-app.example');
    assert.equal(streamResponse.headers.get('x-gemrouter-stream'), 'buffered');
    assert.equal(streamResponse.headers.get('x-gemrouter-context-epoch'), '1');
    assert.equal(streamResponse.headers.get('x-gemrouter-instruction-version'), '1');
    assert.match(streamResponse.headers.get('x-gemrouter-queue-wait-ms') ?? '', /^\d+$/u);
    assert.match(streamResponse.headers.get('x-gemrouter-processing-wait-ms') ?? '', /^\d+$/u);
    assert.match(String(streamResponse.headers.get('x-gemrouter-gateway-warnings')), /usage_unavailable/u);
    const sse = await streamResponse.text();
    assert.match(sse, /buffered answer/u);
    assert.match(sse, /data: \[DONE\]/u);
    assert.doesNotMatch(sse, /prompt_tokens|completion_tokens/u);
    const finalState = toolPayload(await finalExchange);

    const visibleModels = await jsonRequest(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${appToken}` } });
    assert.ok(visibleModels.data.some((model: { id?: string }) => model.id === 'chatgpt-smoke'));
    const capabilities = await jsonRequest(`${baseUrl}/v1/chatgpt/capabilities?model=chatgpt-smoke`, { headers: { authorization: `Bearer ${appToken}` } });
    assert.equal(capabilities.responseFormats.json_object, 'gateway_validated');
    assert.equal(capabilities.declaration.verification, 'operator_declared');
    assert.equal(capabilities.usage, 'unavailable');

    const status = toolPayload(await mcpClient.callTool({ name: 'gateway_status', arguments: {} }));
    assert.equal(status.workerId, 'smoke-worker');
    assert.equal('run_id' in status, false);
    await jsonRequest(`${baseUrl}/admin/chatgpt/workers/smoke-worker/release`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ reason: 'simulated smoke release' }),
    });
    const released = toolPayload(await mcpClient.callTool({
      name: 'gateway_exchange',
      arguments: { run_id: opened.run_id, exchange_id: finalState.next_exchange_id, maximum_wait_seconds: 1 },
    }));
    assert.equal(released.state, 'released');
    await fetch(`${baseUrl}/oauth/chatgpt/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: String(token.access_token) }),
    });
    const revokedMcp = await fetch(pairing.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    });
    assert.equal(revokedMcp.status, 401);

    await mcpClient.close();
    mcpClient = undefined;
    await terminateChild(child);
    const dormantPort = await freePort();
    const dormantBaseUrl = `http://127.0.0.1:${dormantPort}`;
    let dormantLogs = '';
    const dormantChild = spawn(process.execPath, [entrypoint], {
      cwd: isolatedRoot,
      env: {
        ...isolatedEnv,
        HOST: '127.0.0.1',
        PORT: String(dormantPort),
        GEMROUTER_ROOT_DIR: isolatedRoot,
        GEMROUTER_DATA_DIR: 'data',
        GEMROUTER_ADMIN_TOKEN: adminToken,
        GEMROUTER_BOOTSTRAP_API_KEY: appToken,
        GEMROUTER_BOOTSTRAP_APP_NAME: 'smoke-app',
        GEMROUTER_BOOTSTRAP_MODEL_ACCESS: 'all',
        GEMROUTER_CHATGPT_ENABLED: 'false',
        GEMROUTER_CHATGPT_DATA_DIR: 'data/chatgpt-gateway',
        GEMROUTER_FREE_TIER_POLICY_ENABLED: 'false',
        GEMROUTER_GEMINI_API_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    dormantChild.stdout?.on('data', (chunk) => { dormantLogs += String(chunk); });
    dormantChild.stderr?.on('data', (chunk) => { dormantLogs += String(chunk); });
    try {
      await waitForHealth(dormantBaseUrl, dormantChild, () => dormantLogs);
      const dormantSummary = await jsonRequest(`${dormantBaseUrl}/admin/summary`, { headers: adminHeaders });
      const preservedApp = dormantSummary.apps.find((entry: { id?: string }) => entry.id === isolatedApp.app.id);
      assert.ok(preservedApp.allowedModels.includes('chatgpt-smoke'));
      await expectOpenAiError(`${dormantBaseUrl}/v1/chat/completions`, 503, 'chatgpt_feature_disabled', {
        method: 'POST',
        headers: { authorization: `Bearer ${isolatedApp.apiKey}`, 'content-type': 'application/json' },
        body: chatBody,
      });
      const dormantModels = await jsonRequest(`${dormantBaseUrl}/v1/models`, { headers: { authorization: `Bearer ${isolatedApp.apiKey}` } });
      assert.equal(dormantModels.data.some((model: { id?: string }) => model.id === 'chatgpt-smoke'), false);
    } finally {
      await terminateChild(dormantChild);
    }

    process.stdout.write('ChatGPT gateway simulated smoke: feature-off/dormant aliases + HTTP text/JSON/buffered SSE + OAuth + Streamable HTTP MCP + release/revoke passed.\n');
  } finally {
    await mcpClient?.close().catch(() => undefined);
    await terminateChild(child);
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes('--live')) await liveMain();
else await simulatedMain();
