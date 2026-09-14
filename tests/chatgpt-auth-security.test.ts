import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import Fastify from 'fastify';

import { canonicalChatGptOrigin, ChatGptOAuthService, OAuthRequestError } from '../src/llm/providers/chatgpt/auth.js';
import { ChatGptGateway } from '../src/llm/providers/chatgpt/gateway.js';
import { CHATGPT_MCP_OUTPUT_SCHEMAS } from '../src/llm/providers/chatgpt/mcp.js';
import { ChatGptWorkerRegistry } from '../src/llm/providers/chatgpt/registry.js';
import { registerChatGptGatewayRoutes } from '../src/llm/providers/chatgpt/routes.js';
import { ChatGptGatewayStore } from '../src/llm/providers/chatgpt/store.js';
import { CHATGPT_GATEWAY_PROTOCOL_VERSION, type ChatGptGatewayConfig } from '../src/llm/providers/chatgpt/types.js';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-oauth-security-'));
  const config: ChatGptGatewayConfig = {
    enabled: true, publicBaseUrl: 'http://127.0.0.1', dataDir: dir, profile: 'compatibility',
    timeoutMs: 2000, queueTimeoutMs: 500, longPollMs: 100, staleAfterMs: 5000,
    maxQueuePerWorker: 4, maxActiveJobs: 8, maxRequestBytes: 16384, maxResponseBytes: 16384,
    idempotencyTtlSeconds: 60, retentionHours: 1,
  };
  const store = new ChatGptGatewayStore(config);
  const registry = new ChatGptWorkerRegistry(store, config, () => new Set());
  registry.create({ id: 'worker', label: 'Worker', declaredModel: 'Test model (unverified)', publicModelIds: ['chatgpt-worker'], allowedAppIds: ['app'] });
  registry.update('worker', { enabled: true });
  const gateway = new ChatGptGateway(store, registry);
  const oauth = new ChatGptOAuthService(store, config.publicBaseUrl!);
  const app = Fastify({ logger: false });
  app.get('/', async () => 'dashboard');
  app.post('/ordinary-route', async () => ({ ok: true }));
  const adminToken = randomBytes(32).toString('base64url');
  const adminHeaders = { host: '127.0.0.1', authorization: `Bearer ${adminToken}` };
  registerChatGptGatewayRoutes(app, gateway, oauth, {
    isAdmin: (request) => request.headers.authorization === adminHeaders.authorization,
    ensureAdmin: (request, reply) => {
      if (request.headers.authorization === adminHeaders.authorization) return true;
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    },
    ensureAdminMutation: (request, reply) => {
      if (request.headers.authorization === adminHeaders.authorization) return true;
      reply.code(403).send({ error: 'forbidden' });
      return false;
    },
    adminCsrf: () => null, appIds: () => ['app'], audit: () => undefined,
  });
  const client = () => {
    store.openPairingWindow('worker');
    return String(oauth.registerClient({ redirect_uris: ['http://127.0.0.1/callback'] }).client_id);
  };
  const authorization = (clientId = client(), scope = 'mcp:tools offline_access') => {
    const verifier = randomBytes(32).toString('base64url');
    const query = {
      client_id: clientId, response_type: 'code', redirect_uri: 'http://127.0.0.1/callback',
      resource: oauth.workerResource('worker'), scope, state: randomBytes(12).toString('hex'),
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
    const consent = oauth.beginAuthorization(query);
    return { clientId, verifier, query, consent };
  };
  const tokenRequest = (scope = 'mcp:tools offline_access') => {
    const auth = authorization(undefined, scope);
    const callback = new URL(oauth.approveAuthorization(auth.consent.request.id, auth.consent.csrfToken));
    return { grant_type: 'authorization_code', client_id: auth.clientId, code: callback.searchParams.get('code')!,
      redirect_uri: auth.query.redirect_uri, code_verifier: auth.verifier };
  };
  return { app, store, gateway, oauth, client, authorization, tokenRequest, adminHeaders,
    async close() { await app.close(); gateway.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function oauthCode(code: string) {
  return (error: unknown) => error instanceof OAuthRequestError && error.errorCode === code;
}

describe('ChatGPT OAuth and HTTP boundary security', () => {
  it('recognizes IPv6 loopback and rejects non-HTTPS/public or credentialed origins', () => {
    assert.equal(canonicalChatGptOrigin('http://[::1]:3456'), 'http://[::1]:3456');
    assert.equal(canonicalChatGptOrigin('https://gemr.airewardrop.xyz/'), 'https://gemr.airewardrop.xyz');
    for (const origin of ['http://example.com', 'https://u:p@example.com', 'https://example.com/path']) {
      assert.throws(() => canonicalChatGptOrigin(origin));
    }
  });

  it('validates registration metadata, exact S256 challenge and RFC7636 verifier without consuming valid codes', async () => {
    const f = fixture();
    try {
      f.store.openPairingWindow('worker');
      assert.throws(() => f.oauth.registerClient({ redirect_uris: ['not a URI'] }), oauthCode('invalid_redirect_uri'));
      assert.throws(() => f.oauth.registerClient({ redirect_uris: ['http://127.0.0.1/callback'], grant_types: 'authorization_code' }), oauthCode('invalid_client_metadata'));
      assert.ok(f.oauth.registerClient({ redirect_uris: ['http://127.0.0.1/callback'], client_uri: 'https://chatgpt.com', logo_uri: 'https://chatgpt.com/logo.png', software_id: 'chatgpt', software_version: '1', contacts: ['support@example.test'] }).client_id);
      const auth = f.authorization();
      assert.throws(() => f.oauth.beginAuthorization({ ...auth.query, code_challenge: 'A'.repeat(44) }), oauthCode('invalid_request'));
      assert.throws(() => f.oauth.beginAuthorization({ ...auth.query, scope: ['mcp:tools'] }), oauthCode('invalid_request'));
      const callback = new URL(f.oauth.approveAuthorization(auth.consent.request.id, auth.consent.csrfToken));
      const request = { grant_type: 'authorization_code', client_id: auth.clientId, code: callback.searchParams.get('code'), redirect_uri: auth.query.redirect_uri, code_verifier: auth.verifier };
      assert.throws(() => f.oauth.exchangeToken({ ...request, code_verifier: '!'.repeat(43) }), oauthCode('invalid_grant'));
      assert.throws(() => f.oauth.exchangeToken({ ...request, code_verifier: 'A'.repeat(129) }), oauthCode('invalid_grant'));
      assert.throws(() => f.oauth.exchangeToken({ ...request, code_verifier: 'A'.repeat(43) }), oauthCode('invalid_grant'));
      assert.ok(f.oauth.exchangeToken(request).access_token);
      assert.throws(() => f.oauth.exchangeToken(request), oauthCode('invalid_grant'));
    } finally { await f.close(); }
  });

  it('binds codes and refresh to the original client/resource and never widens scopes', async () => {
    const f = fixture();
    try {
      const secondClient = f.client();
      const request = f.tokenRequest();
      assert.throws(() => f.oauth.exchangeToken({ ...request, client_id: secondClient }), oauthCode('invalid_grant'));
      assert.throws(() => f.oauth.exchangeToken({ ...request, resource: 'https://evil.example/mcp' }), oauthCode('invalid_target'));
      const tokens = f.oauth.exchangeToken(request);
      const refresh = { grant_type: 'refresh_token', client_id: request.client_id, refresh_token: tokens.refresh_token };
      assert.throws(() => f.oauth.exchangeToken({ ...refresh, client_id: secondClient }), oauthCode('invalid_grant'));
      assert.throws(() => f.oauth.exchangeToken({ ...refresh, resource: 'https://evil.example/mcp' }), oauthCode('invalid_target'));
      assert.throws(() => f.oauth.exchangeToken({ ...refresh, scope: 'mcp:tools' }), oauthCode('invalid_scope'));
      const rotated = f.oauth.exchangeToken(refresh);
      assert.ok(rotated.refresh_token);
      assert.notEqual(rotated.refresh_token, tokens.refresh_token);
      assert.equal(rotated.scope, 'mcp:tools offline_access');
      assert.throws(() => f.oauth.exchangeToken(refresh), oauthCode('invalid_grant'));
      const onlineOnly = f.oauth.exchangeToken(f.tokenRequest('mcp:tools'));
      assert.equal(onlineOnly.scope, 'mcp:tools');
      assert.equal(Object.hasOwn(onlineOnly, 'refresh_token'), false);
    } finally { await f.close(); }
  });

  it('offers safe login continuation and consent cancellation with no-store/frame/referrer protections', async () => {
    const f = fixture();
    try {
      const auth = f.authorization();
      const url = `/oauth/chatgpt/authorize?${new URLSearchParams(auth.query)}`;
      const login = await f.app.inject({ method: 'GET', url, headers: { host: '127.0.0.1' } });
      assert.equal(login.statusCode, 303);
      const continuation = new URL(login.headers.location!, 'http://127.0.0.1');
      assert.equal(continuation.pathname, '/');
      assert.equal(continuation.searchParams.get('chatgpt_authorize'), url);
      assert.equal(login.headers['cache-control'], 'no-store');
      assert.equal(login.headers['referrer-policy'], 'no-referrer');
      const page = await f.app.inject({ method: 'GET', url, headers: f.adminHeaders });
      assert.equal(page.statusCode, 200);
      assert.equal(page.headers['referrer-policy'], 'same-origin');
      assert.equal(page.headers['x-frame-options'], 'DENY');
      assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/u);
      assert.match(String(page.headers['content-security-policy']), /form-action 'self' http:\/\/127\.0\.0\.1;/u);
      assert.match(page.body, /value="deny"/u);
      const dashboard = await f.app.inject('/');
      assert.equal(dashboard.headers['content-security-policy'], undefined);
      const ordinaryForm = await f.app.inject({ method: 'POST', url: '/ordinary-route', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'key=value' });
      assert.equal(ordinaryForm.statusCode, 415);
      const callback = new URL(f.oauth.denyAuthorization(auth.consent.request.id, auth.consent.csrfToken));
      assert.equal(callback.origin, 'http://127.0.0.1');
      assert.equal(callback.searchParams.get('error'), 'access_denied');
      assert.equal(callback.searchParams.get('state'), auth.query.state);
      assert.equal(callback.searchParams.get('iss'), 'http://127.0.0.1');
      assert.equal(f.oauth.authorizationServerMetadata().authorization_response_iss_parameter_supported, true);
      assert.throws(() => f.oauth.approveAuthorization(auth.consent.request.id, auth.consent.csrfToken));
    } finally { await f.close(); }
  });

  it('rejects duplicate form parameters, cross-origin mutations, oversized bodies and registration bursts', async () => {
    const f = fixture();
    try {
      const duplicate = await f.app.inject({ method: 'POST', url: '/oauth/chatgpt/token', headers: { host: '127.0.0.1', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=refresh_token&grant_type=authorization_code' });
      assert.equal(duplicate.statusCode, 400);
      const origin = await f.app.inject({ method: 'POST', url: '/oauth/chatgpt/register', headers: { host: '127.0.0.1', origin: 'https://evil.example' }, payload: {} });
      assert.equal(origin.statusCode, 403);
      const oversized = await f.app.inject({ method: 'POST', url: '/oauth/chatgpt/token', headers: { host: '127.0.0.1' }, payload: { token: 'x'.repeat(17000) } });
      assert.equal(oversized.statusCode, 413);
      const statuses = await Promise.all(Array.from({ length: 18 }, async () => (await f.app.inject({ method: 'POST', url: '/oauth/chatgpt/register', headers: { host: '127.0.0.1' }, payload: {} })).statusCode));
      assert.ok(statuses.includes(429));
      const unknown = await f.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp/chatgpt/%40invalid' });
      assert.equal(unknown.statusCode, 404);
    } finally { await f.close(); }
  });

  it('generates a wake-up prompt without reopening OAuth pairing or changing existing grants', async () => {
    const f = fixture();
    try {
      f.oauth.exchangeToken(f.tokenRequest());
      const grants = f.store.listGrants();
      assert.equal(f.store.activePairingWorker(), null);
      const response = await f.app.inject({ method: 'POST', url: '/admin/chatgpt/workers/worker/prompt', headers: f.adminHeaders });
      assert.equal(response.statusCode, 200);
      assert.match(response.json().workerPrompt, /gateway_open/u);
      assert.equal(f.store.activePairingWorker(), null);
      assert.deepEqual(f.store.listGrants(), grants);
    } finally { await f.close(); }
  });

  it('rejects non-initialize MCP requests and caps parallel session initialization without leaking capacity', async () => {
    const f = fixture();
    try {
      const tokens = f.oauth.exchangeToken(f.tokenRequest());
      const headers = { host: '127.0.0.1', authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' };
      const statuses = await Promise.all(Array.from({ length: 40 }, async () => (await f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker', headers, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).statusCode));
      assert.ok(statuses.every((status) => status === 400));
      const responses = await Promise.all(Array.from({ length: 40 }, async (_, index) => f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker', headers, payload: { jsonrpc: '2.0', id: index + 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'security-test', version: '1' } } } })));
      assert.equal(responses.filter((response) => response.statusCode === 200).length, 32);
      assert.equal(responses.filter((response) => response.statusCode === 429).length, 8);
      const session = responses.find((response) => response.statusCode === 200)!.headers['mcp-session-id'];
      assert.ok(session);
      const sessionHeaders = { ...headers, 'mcp-session-id': String(session) };
      const listing = await f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker', headers: sessionHeaders, payload: { jsonrpc: '2.0', id: 100, method: 'tools/list' } });
      for (const tool of listing.json().result.tools) {
        assert.equal(tool.outputSchema.type, 'object');
        assert.deepEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['mcp:tools'] }]);
      }
      const status = await f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker', headers: sessionHeaders, payload: { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'gateway_status', arguments: {} } } });
      assert.equal(status.json().result.isError, undefined);
      assert.ok(CHATGPT_MCP_OUTPUT_SCHEMAS.status.safeParse(status.json().result.structuredContent).success);
      const opened = await f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker', headers: sessionHeaders, payload: { jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'gateway_open', arguments: { protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION, open_id: 'security-test-open' } } } });
      assert.ok(CHATGPT_MCP_OUTPUT_SCHEMAS.open.safeParse(opened.json().result.structuredContent).success);
      f.gateway.open = () => { throw new Error('SQLITE private_internal_detail'); };
      const sanitized = await f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker', headers: sessionHeaders, payload: { jsonrpc: '2.0', id: 103, method: 'tools/call', params: { name: 'gateway_open', arguments: { protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION, open_id: 'security-test-open' } } } });
      assert.equal(sanitized.json().result.isError, true);
      assert.doesNotMatch(sanitized.body, /SQLITE|private_internal_detail/u);
      const deleted = await f.app.inject({ method: 'DELETE', url: '/mcp/chatgpt/worker', headers: { ...headers, 'mcp-session-id': String(session) } });
      assert.equal(deleted.statusCode, 200);
      const queryToken = await f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker?access_token=redacted', headers, payload: {} });
      assert.equal(queryToken.statusCode, 400);
    } finally { await f.close(); }
  });

  it('keeps each in-flight RPC bound to its own token expiry when another request refreshes the session', async () => {
    const f = fixture();
    try {
      const request = f.tokenRequest();
      const tokens = f.oauth.exchangeToken(request);
      const rotated = f.oauth.exchangeToken({ grant_type: 'refresh_token', client_id: request.client_id, refresh_token: tokens.refresh_token });
      const oldExpiry = Date.now() + 30_000;
      const freshExpiry = oldExpiry + 60_000;
      const authenticate = f.oauth.authenticate.bind(f.oauth);
      f.oauth.authenticate = (authorization, workerId) => {
        const grant = authenticate(authorization, workerId);
        return grant ? { ...grant, expiresAt: authorization === `Bearer ${tokens.access_token}` ? oldExpiry : freshExpiry } : null;
      };
      const headers = { host: '127.0.0.1', authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' };
      const initialized = await f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker', headers, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'expiry-test', version: '1' } } } });
      const sessionHeaders = { ...headers, 'mcp-session-id': String(initialized.headers['mcp-session-id']) };
      let capturedExpiry = 0;
      let observe: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { observe = resolve; });
      let finish: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => { finish = resolve; });
      f.gateway.exchange = async (grant) => {
        observe!();
        await barrier;
        capturedExpiry = grant.expiresAt;
        return { protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION, next_exchange_id: `ex_${'a'.repeat(24)}`, state: 'idle', continue: true, waited_seconds: 0 };
      };
      const polling = f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker', headers: sessionHeaders, payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gateway_exchange', arguments: { run_id: `run_${'a'.repeat(32)}`, exchange_id: `ex_${'a'.repeat(24)}` } } } });
      // LightMyRequest is lazy until its thenable is awaited/observed.
      const pending = Promise.resolve(polling);
      await started;
      const status = await f.app.inject({ method: 'POST', url: '/mcp/chatgpt/worker', headers: { ...sessionHeaders, authorization: `Bearer ${rotated.access_token}` }, payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gateway_status', arguments: {} } } });
      assert.equal(status.statusCode, 200);
      finish!();
      assert.equal((await pending).statusCode, 200);
      assert.equal(capturedExpiry, oldExpiry);
    } finally { await f.close(); }
  });
});
