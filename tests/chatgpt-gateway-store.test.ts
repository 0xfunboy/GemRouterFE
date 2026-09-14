import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ChatGptOAuthService } from '../src/llm/providers/chatgpt/auth.js';
import { readDormantChatGptAliases } from '../src/llm/providers/chatgpt/dormant.js';
import { ChatGptGatewayError } from '../src/llm/providers/chatgpt/errors.js';
import { ChatGptGateway } from '../src/llm/providers/chatgpt/gateway.js';
import { digestCanonical } from '../src/llm/providers/chatgpt/protocol.js';
import { ChatGptWorkerRegistry } from '../src/llm/providers/chatgpt/registry.js';
import { ChatGptGatewayStore, type ChatGptStoreAuditEvent } from '../src/llm/providers/chatgpt/store.js';
import type {
  AuthenticatedMcpGrant,
  ChatGptGatewayConfig,
  ChatGptSubmitInput,
  GatewayExchangeInput,
} from '../src/llm/providers/chatgpt/types.js';

interface Fixture {
  dir: string;
  config: ChatGptGatewayConfig;
  store: ChatGptGatewayStore;
  registry: ChatGptWorkerRegistry;
  gateway: ChatGptGateway;
  oauth: ChatGptOAuthService;
  grant: AuthenticatedMcpGrant;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  close(): void;
}

function createFixture(options?: {
  workerId?: string;
  alias?: string;
  queueTimeoutMs?: number;
  timeoutMs?: number;
  auditEvents?: ChatGptStoreAuditEvent[];
}): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-chatgpt-test-'));
  const config: ChatGptGatewayConfig = {
    enabled: true,
    publicBaseUrl: 'http://127.0.0.1',
    dataDir: dir,
    profile: 'compatibility',
    timeoutMs: options?.timeoutMs ?? 2_000,
    queueTimeoutMs: options?.queueTimeoutMs ?? 500,
    longPollMs: 100,
    staleAfterMs: 5_000,
    maxQueuePerWorker: 4,
    maxActiveJobs: 8,
    maxRequestBytes: 16_384,
    maxResponseBytes: 16_384,
    idempotencyTtlSeconds: 60,
    retentionHours: 1,
  };
  const store = new ChatGptGatewayStore(config, (event) => options?.auditEvents?.push(event));
  const registry = new ChatGptWorkerRegistry(store, config, () => new Set(['gemini-test']));
  const workerId = options?.workerId ?? 'research';
  const alias = options?.alias ?? 'chatgpt-research';
  registry.create({
    id: workerId,
    label: 'Research worker',
    publicModelIds: [alias],
    allowedAppIds: ['app-one'],
    declaredModel: 'Operator model',
    timeoutMs: config.timeoutMs,
    queueTimeoutMs: config.queueTimeoutMs,
  });
  registry.update(workerId, { enabled: true });
  const gateway = new ChatGptGateway(store, registry);
  const oauth = new ChatGptOAuthService(store, config.publicBaseUrl!);
  store.openPairingWindow(workerId);
  const client = oauth.registerClient({
    client_name: 'test worker',
    redirect_uris: ['http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  const clientId = String(client.client_id);
  const verifier = 'v'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorization = oauth.beginAuthorization({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'http://127.0.0.1/callback',
    resource: oauth.workerResource(workerId),
    scope: 'mcp:tools offline_access',
    state: 'state-test',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const callback = new URL(oauth.approveAuthorization(authorization.request.id, authorization.csrfToken));
  const tokens = oauth.exchangeToken({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: callback.searchParams.get('code'),
    redirect_uri: 'http://127.0.0.1/callback',
    code_verifier: verifier,
  });
  const accessToken = String(tokens.access_token);
  const grant = oauth.authenticate(`Bearer ${accessToken}`, workerId);
  assert.ok(grant);
  return {
    dir,
    config,
    store,
    registry,
    gateway,
    oauth,
    grant,
    clientId,
    accessToken,
    refreshToken: String(tokens.refresh_token),
    close() {
      gateway.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function submit(alias = 'chatgpt-research', key?: string): ChatGptSubmitInput {
  const messages = [{ role: 'user' as const, content: 'private question' }];
  const controls = {
    present: [],
    warnings: [],
    responseFormat: 'text' as const,
    stream: false,
    includeUsage: false,
    profile: 'compatibility' as const,
  };
  return {
    appId: 'app-one',
    alias,
    messages,
    surface: 'openai',
    fingerprint: digestCanonical({ alias, messages, controls }),
    idempotencyKey: key,
    controls,
  };
}

function authorizeWorker(fixture: Fixture, workerId: string, suffix: string): AuthenticatedMcpGrant {
  fixture.store.openPairingWindow(workerId);
  const redirectUri = `http://127.0.0.1/${suffix}`;
  const client = fixture.oauth.registerClient({
    client_name: suffix,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  const verifier = suffix.padEnd(43, 'v');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorization = fixture.oauth.beginAuthorization({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    resource: fixture.oauth.workerResource(workerId),
    scope: 'mcp:tools offline_access',
    state: suffix,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const callback = new URL(fixture.oauth.approveAuthorization(authorization.request.id, authorization.csrfToken));
  const tokens = fixture.oauth.exchangeToken({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code: callback.searchParams.get('code'),
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const grant = fixture.oauth.authenticate(`Bearer ${String(tokens.access_token)}`, workerId);
  assert.ok(grant);
  return grant;
}

describe('ChatGPT reverse-RPC durable state machine', () => {
  it('creates an owner-only SQLite store and enforces registry collisions/default disable', () => {
    const fixture = createFixture();
    try {
      assert.equal(statSync(fixture.store.dbPath).mode & 0o777, 0o600);
      assert.deepEqual([...readDormantChatGptAliases(fixture.config.dataDir)], ['chatgpt-research']);
      const absentDir = path.join(fixture.dir, 'absent');
      assert.deepEqual([...readDormantChatGptAliases(absentDir)], []);
      assert.equal(existsSync(path.join(absentDir, 'gateway.sqlite')), false);
      assert.throws(() => new ChatGptGatewayStore({
        ...fixture.config,
        dataDir: path.join(fixture.dir, 'invalid-retention'),
        retentionHours: 1 / 3_600,
      }), /must cover idempotency/iu);
      assert.throws(() => new ChatGptGatewayStore(fixture.config), /already owns/u);
      const created = fixture.registry.create({
        id: 'second',
        label: 'Second',
        publicModelIds: ['second-alias'],
        allowedAppIds: ['app-one'],
        declaredModel: 'Second declared model',
      });
      assert.equal(created.enabled, false);
      assert.throws(() => fixture.registry.create({
        id: 'collision',
        label: 'Collision',
        publicModelIds: ['gemini-test'],
        declaredModel: 'X',
      }), /collides/u);
      assert.throws(() => fixture.registry.create({
        id: 'duplicate',
        label: 'Duplicate',
        publicModelIds: ['chatgpt-research'],
        declaredModel: 'X',
      }), /belongs/u);
      fixture.store.openPairingWindow('research');
      fixture.store.openPairingWindow('second');
      assert.throws(() => fixture.oauth.registerClient({
        redirect_uris: ['http://127.0.0.1/ambiguous'],
        grant_types: ['authorization_code', 'refresh_token'],
      }), /exactly one/iu);
      fixture.registry.remove('second');
      assert.equal(fixture.registry.get('second'), null);
    } finally {
      fixture.close();
    }
  });

  it('opens idempotently, refuses run takeover, and isolates two concurrent workers and app policies', async () => {
    const fixture = createFixture();
    try {
      const firstOpen = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_worker_one' });
      assert.deepEqual(
        fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_worker_one' }),
        firstOpen,
      );
      assert.throws(
        () => fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_worker_takeover' }),
        /worker_busy/u,
      );

      fixture.registry.create({
        id: 'coding',
        label: 'Coding worker',
        publicModelIds: ['chatgpt-coding'],
        allowedAppIds: ['app-two'],
        declaredModel: 'Coding model',
      });
      fixture.registry.update('coding', { enabled: true });
      const codingGrant = authorizeWorker(fixture, 'coding', 'coding-callback');
      const secondOpen = fixture.gateway.open(codingGrant, { protocol_version: '1.0', open_id: 'open_worker_two' });
      const firstPoll = fixture.gateway.exchange(fixture.grant, {
        run_id: firstOpen.run_id,
        exchange_id: firstOpen.next_exchange_id,
        maximum_wait_seconds: 1,
      });
      const secondPoll = fixture.gateway.exchange(codingGrant, {
        run_id: secondOpen.run_id,
        exchange_id: secondOpen.next_exchange_id,
        maximum_wait_seconds: 1,
      });
      await assert.rejects(fixture.gateway.submit({ ...submit('chatgpt-coding'), appId: 'app-one' }), (error: unknown) =>
        error instanceof ChatGptGatewayError && error.code === 'chatgpt_model_not_allowed');
      const firstResult = fixture.gateway.submit(submit('chatgpt-research', 'multi-one'));
      const secondResult = fixture.gateway.submit({ ...submit('chatgpt-coding', 'multi-two'), appId: 'app-two' });
      const [firstClaim, secondClaim] = await Promise.all([firstPoll, secondPoll]);
      if (firstClaim.state !== 'request' || secondClaim.state !== 'request') throw new Error('expected concurrent claims');
      assert.notEqual(firstClaim.request.request_id, secondClaim.request.request_id);
      const completingFirst = fixture.gateway.exchange(fixture.grant, {
        run_id: firstOpen.run_id,
        exchange_id: firstClaim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: { request_id: firstClaim.request.request_id, claim_token: firstClaim.request.claim_token, response: 'research' },
      });
      const completingSecond = fixture.gateway.exchange(codingGrant, {
        run_id: secondOpen.run_id,
        exchange_id: secondClaim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: { request_id: secondClaim.request.request_id, claim_token: secondClaim.request.claim_token, response: 'coding' },
      });
      assert.equal((await firstResult).content, 'research');
      assert.equal((await secondResult).content, 'coding');
      fixture.store.releaseWorker('research', 'cleanup');
      fixture.store.releaseWorker('coding', 'cleanup');
      await Promise.all([completingFirst, completingSecond]);
    } finally {
      fixture.close();
    }
  });

  it('fences the old run and claim when a replacement pairing is approved', async () => {
    const fixture = createFixture();
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_before_pairing' });
      const poll = fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: opened.next_exchange_id,
        maximum_wait_seconds: 1,
      });
      const pending = fixture.gateway.submit(submit('chatgpt-research', 'replacement-pairing'));
      const rejected = assert.rejects(pending, (error: unknown) =>
        error instanceof ChatGptGatewayError && error.code === 'chatgpt_worker_unavailable');
      const claim = await poll;
      if (claim.state !== 'request') throw new Error('expected old claim');
      const replacementGrant = authorizeWorker(fixture, 'research', 'replacement-callback');
      await rejected;
      await assert.rejects(fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: claim.next_exchange_id,
        completion: { request_id: claim.request.request_id, claim_token: claim.request.claim_token, response: 'late old answer' },
      }), /grant_revoked/u);
      assert.equal(fixture.oauth.authenticate(`Bearer ${fixture.accessToken}`, 'research'), null);
      const replacement = fixture.gateway.open(replacementGrant, { protocol_version: '1.0', open_id: 'open_after_pairing' });
      assert.ok(replacement.run_generation > opened.run_generation);
      fixture.store.releaseWorker('research', 'cleanup');
    } finally {
      fixture.close();
    }
  });

  it('atomically completes one request, claims the next, and replays the exact exchange', async () => {
    const fixture = createFixture();
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_test_lifecycle' });
      await assert.rejects(fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: `ex_${'x'.repeat(32)}`,
        maximum_wait_seconds: 1,
      }), /exchange_out_of_order/u);
      const pollInput: GatewayExchangeInput = {
        run_id: opened.run_id,
        exchange_id: opened.next_exchange_id,
        maximum_wait_seconds: 1,
      };
      const poll = fixture.gateway.exchange(fixture.grant, pollInput);
      const firstResult = fixture.gateway.submit(submit('chatgpt-research', 'job-one'));
      const firstClaim = await poll;
      assert.equal(firstClaim.state, 'request');
      if (firstClaim.state !== 'request') throw new Error('expected request');
      assert.deepEqual(await fixture.gateway.exchange(fixture.grant, pollInput), firstClaim);

      const secondResult = fixture.gateway.submit(submit('chatgpt-research', 'job-two'));
      const completingFirst: GatewayExchangeInput = {
        run_id: opened.run_id,
        exchange_id: firstClaim.next_exchange_id,
        completion: {
          request_id: firstClaim.request.request_id,
          claim_token: firstClaim.request.claim_token,
          response: 'first answer',
        },
      };
      const secondClaim = await fixture.gateway.exchange(fixture.grant, completingFirst);
      assert.equal(secondClaim.state, 'request');
      assert.equal((await firstResult).content, 'first answer');
      const replay = await fixture.gateway.exchange(fixture.grant, completingFirst);
      assert.deepEqual(replay, secondClaim);
      await assert.rejects(fixture.gateway.exchange(fixture.grant, {
        ...completingFirst,
        completion: { ...completingFirst.completion!, response: 'conflicting answer' },
      }), /exchange_conflict/u);
      if (secondClaim.state !== 'request') throw new Error('expected second request');

      const completingSecond = fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: secondClaim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: {
          request_id: secondClaim.request.request_id,
          claim_token: secondClaim.request.claim_token,
          response: 'second answer',
        },
      });
      assert.equal((await secondResult).content, 'second answer');
      fixture.store.releaseWorker('research', 'test finished');
      assert.equal((await completingSecond).state, 'released');
      assert.equal((await fixture.gateway.submit(submit('chatgpt-research', 'job-one'))).content, 'first answer');
      await assert.rejects(
        fixture.gateway.submit({ ...submit('chatgpt-research', 'job-one'), fingerprint: 'different-payload' }),
        (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_idempotency_conflict',
      );
    } finally {
      fixture.close();
    }
  });

  it('keeps a shared idempotent HTTP job alive until its last consumer disconnects', async () => {
    const fixture = createFixture();
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_shared_http' });
      const poll = fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: opened.next_exchange_id,
        maximum_wait_seconds: 1,
      });
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = fixture.gateway.submit({ ...submit('chatgpt-research', 'shared-http'), signal: firstController.signal });
      const firstRejected = assert.rejects(first, (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_request_cancelled');
      const second = fixture.gateway.submit({ ...submit('chatgpt-research', 'shared-http'), signal: secondController.signal });
      firstController.abort();
      await firstRejected;
      const claim = await poll;
      if (claim.state !== 'request') throw new Error('expected shared job');
      await fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: claim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: {
          request_id: claim.request.request_id,
          claim_token: claim.request.claim_token,
          response: 'shared result',
        },
      });
      assert.equal((await second).content, 'shared result');
    } finally {
      fixture.close();
    }
  });

  it('does not abort a duplicated long poll when only one transport consumer closes', async () => {
    const fixture = createFixture();
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_shared_poll' });
      const input: GatewayExchangeInput = {
        run_id: opened.run_id,
        exchange_id: opened.next_exchange_id,
        maximum_wait_seconds: 1,
      };
      const controller = new AbortController();
      const disconnected = fixture.gateway.exchange(fixture.grant, input, controller.signal);
      const disconnectedResult = assert.rejects(disconnected, /exchange_aborted/u);
      const surviving = fixture.gateway.exchange(fixture.grant, input);
      controller.abort();
      await disconnectedResult;
      const pending = fixture.gateway.submit(submit('chatgpt-research', 'shared-poll-job'));
      const claim = await surviving;
      assert.equal(claim.state, 'request');
      fixture.store.releaseWorker('research', 'test cleanup');
      await assert.rejects(pending);
    } finally {
      fixture.close();
    }
  });

  it('fences wrong claims and never publishes a late completion after cancellation', async () => {
    const fixture = createFixture();
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_test_fencing' });
      const poll = fixture.gateway.exchange(fixture.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 1 });
      const controller = new AbortController();
      const result = fixture.gateway.submit({ ...submit(), signal: controller.signal });
      const claim = await poll;
      assert.equal(claim.state, 'request');
      if (claim.state !== 'request') throw new Error('expected request');
      assert.throws(() => fixture.registry.remove('research'), /active jobs/iu);
      const stale = await fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: claim.next_exchange_id,
        completion: {
          request_id: claim.request.request_id,
          claim_token: `claim_${'x'.repeat(43)}`,
          response: 'must not publish',
        },
      });
      assert.equal(stale.state, 'recovery');
      controller.abort();
      await assert.rejects(result, (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_request_cancelled');
      const late = await fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: stale.next_exchange_id,
        completion: {
          request_id: claim.request.request_id,
          claim_token: claim.request.claim_token,
          response: 'late private answer',
        },
      });
      assert.equal(late.state, 'recovery');
      if (late.state === 'recovery') assert.equal(late.code, 'request_cancelled');
    } finally {
      fixture.close();
    }
  });

  it('expires a queued request quickly while preserving an ambiguous active claim', async () => {
    const fixture = createFixture({ queueTimeoutMs: 100, timeoutMs: 1_200 });
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_test_timeout' });
      const poll = fixture.gateway.exchange(fixture.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 1 });
      const active = fixture.gateway.submit(submit('chatgpt-research', 'active'));
      const claim = await poll;
      assert.equal(claim.state, 'request');
      const queued = fixture.gateway.submit(submit('chatgpt-research', 'queued'));
      await assert.rejects(queued, (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_queue_timeout');
      assert.equal(fixture.store.workerStatus('research').processingClaim, true);
      fixture.store.releaseWorker('research', 'test cleanup');
      await assert.rejects(active);
    } finally {
      fixture.close();
    }
  });

  it('applies queue backpressure and drains admitted work before releasing the run', async () => {
    const fixture = createFixture();
    try {
      fixture.registry.update('research', { maxQueuedRequests: 1 });
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_drain_queue' });
      const poll = fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: opened.next_exchange_id,
        maximum_wait_seconds: 1,
      });
      const first = fixture.gateway.submit(submit('chatgpt-research', 'drain-first'));
      const firstClaim = await poll;
      if (firstClaim.state !== 'request') throw new Error('expected first request');
      const second = fixture.gateway.submit(submit('chatgpt-research', 'drain-second'));
      await assert.rejects(
        fixture.gateway.submit(submit('chatgpt-research', 'queue-overflow')),
        (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_queue_full',
      );
      fixture.store.drainWorker('research');
      await assert.rejects(
        fixture.gateway.submit(submit('chatgpt-research', 'after-drain')),
        (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_worker_unavailable',
      );
      const secondClaim = await fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: firstClaim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: { request_id: firstClaim.request.request_id, claim_token: firstClaim.request.claim_token, response: 'first drained' },
      });
      if (secondClaim.state !== 'request') throw new Error('expected second admitted request');
      assert.equal((await first).content, 'first drained');
      const released = await fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: secondClaim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: { request_id: secondClaim.request.request_id, claim_token: secondClaim.request.claim_token, response: 'second drained' },
      });
      assert.equal((await second).content, 'second drained');
      assert.equal(released.state, 'released');
    } finally {
      fixture.close();
    }
  });

  it('never redelivers a claim after its lease expires', async () => {
    const fixture = createFixture({ timeoutMs: 1_000, queueTimeoutMs: 500 });
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_lease_expiry' });
      const poll = fixture.gateway.exchange(fixture.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 1 });
      const pending = fixture.gateway.submit(submit('chatgpt-research', 'lease-expiry'));
      const pendingRejection = assert.rejects(pending, (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_request_timeout');
      const claim = await poll;
      assert.equal(claim.state, 'request');
      if (claim.state !== 'request') throw new Error('expected claimed request');
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      await pendingRejection;
      const afterExpiry = await fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: claim.next_exchange_id,
        maximum_wait_seconds: 1,
      });
      assert.notEqual(afterExpiry.state, 'request');
    } finally {
      fixture.close();
    }
  });

  it('validates json_object and blocks publication after an app binding is revoked', async () => {
    const fixture = createFixture();
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_json_revoke' });
      const pollJson = fixture.gateway.exchange(fixture.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 1 });
      const jsonRequest = fixture.gateway.submit({
        ...submit('chatgpt-research', 'json-invalid'),
        controls: { ...submit().controls, responseFormat: 'json_object' },
      });
      const invalidJsonRejection = assert.rejects(jsonRequest, (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_invalid_json');
      const jsonClaim = await pollJson;
      if (jsonClaim.state !== 'request') throw new Error('expected JSON request');
      const invalidExchange = fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: jsonClaim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: { request_id: jsonClaim.request.request_id, claim_token: jsonClaim.request.claim_token, response: 'not json' },
      });
      await invalidJsonRejection;
      fixture.store.releaseWorker('research', 'advance after invalid json');
      await invalidExchange;

      const reopened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_revoke_test' });
      const poll = fixture.gateway.exchange(fixture.grant, { run_id: reopened.run_id, exchange_id: reopened.next_exchange_id, maximum_wait_seconds: 1 });
      const pending = fixture.gateway.submit(submit('chatgpt-research', 'revoked-job'));
      const claim = await poll;
      if (claim.state !== 'request') throw new Error('expected revocation request');
      fixture.registry.update('research', { allowedAppIds: [] });
      await assert.rejects(pending, (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_model_not_allowed');
      const late = await fixture.gateway.exchange(fixture.grant, {
        run_id: reopened.run_id,
        exchange_id: claim.next_exchange_id,
        completion: { request_id: claim.request.request_id, claim_token: claim.request.claim_token, response: '{"late":true}' },
      });
      assert.equal(late.state, 'recovery');
      if (late.state === 'recovery') assert.equal(late.code, 'request_cancelled');
    } finally {
      fixture.close();
    }
  });

  it('terminalizes an empty worker response instead of publishing false success', async () => {
    const fixture = createFixture();
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_empty_response' });
      const poll = fixture.gateway.exchange(fixture.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 1 });
      const pending = fixture.gateway.submit(submit('chatgpt-research', 'empty-response'));
      const rejection = assert.rejects(pending, (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_empty_response');
      const claim = await poll;
      if (claim.state !== 'request') throw new Error('expected request');
      await fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: claim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: { request_id: claim.request.request_id, claim_token: claim.request.claim_token, response: '   ' },
      });
      await rejection;
    } finally {
      fixture.close();
    }
  });

  it('audits lifecycle metadata without OAuth, claim, prompt or response secrets', async () => {
    const auditEvents: ChatGptStoreAuditEvent[] = [];
    const fixture = createFixture({ auditEvents });
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_audit_redaction' });
      const poll = fixture.gateway.exchange(fixture.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 1 });
      const pending = fixture.gateway.submit(submit('chatgpt-research', 'audit-private-key'));
      const claim = await poll;
      if (claim.state !== 'request') throw new Error('expected request');
      const completion = fixture.gateway.exchange(fixture.grant, {
        run_id: opened.run_id,
        exchange_id: claim.next_exchange_id,
        maximum_wait_seconds: 1,
        completion: { request_id: claim.request.request_id, claim_token: claim.request.claim_token, response: 'private worker response' },
      });
      await pending;
      fixture.store.releaseWorker('research', 'audit cleanup');
      await completion;
      assert.ok(auditEvents.some((event) => event.type === 'chatgpt.request.enqueued'));
      assert.ok(auditEvents.some((event) => event.type === 'chatgpt.request.claimed'));
      assert.ok(auditEvents.some((event) => event.type === 'chatgpt.request.completed'));
      const serialized = JSON.stringify(auditEvents);
      assert.doesNotMatch(serialized, /private question|private worker response|audit-private-key/u);
      assert.doesNotMatch(serialized, new RegExp(claim.request.claim_token, 'u'));
      assert.doesNotMatch(serialized, new RegExp(fixture.accessToken, 'u'));
    } finally {
      fixture.close();
    }
  });

  it('terminalizes active work on restart and reuses the idempotent terminal outcome', async () => {
    const fixture = createFixture();
    let replacement: ChatGptGateway | undefined;
    try {
      const opened = fixture.gateway.open(fixture.grant, { protocol_version: '1.0', open_id: 'open_before_restart' });
      await fixture.gateway.exchange(fixture.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 1 });
      await fixture.store.enqueue(submit('chatgpt-research', 'restart-key'));
      fixture.gateway.close();

      const store = new ChatGptGatewayStore(fixture.config);
      const registry = new ChatGptWorkerRegistry(store, fixture.config, () => new Set(['gemini-test']));
      replacement = new ChatGptGateway(store, registry);
      const oauth = new ChatGptOAuthService(store, fixture.config.publicBaseUrl!);
      const grant = oauth.authenticate(`Bearer ${fixture.accessToken}`, 'research');
      assert.ok(grant);
      replacement.open(grant, { protocol_version: '1.0', open_id: 'open_after_restart' });
      await assert.rejects(
        replacement.submit(submit('chatgpt-research', 'restart-key')),
        (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_gateway_restarted',
      );
    } finally {
      replacement?.close();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rotates refresh tokens, scopes access to one worker resource, and revokes tokens', () => {
    const fixture = createFixture();
    try {
      assert.equal(fixture.oauth.authenticate(`Bearer ${fixture.accessToken}`, 'other-worker'), null);
      assert.throws(() => fixture.oauth.exchangeToken({
        grant_type: 'refresh_token',
        client_id: 'grmcp_00000000000000000000000000000000',
        refresh_token: fixture.refreshToken,
      }));
      const rotated = fixture.oauth.exchangeToken({
        grant_type: 'refresh_token',
        client_id: fixture.clientId,
        refresh_token: fixture.refreshToken,
      });
      assert.throws(() => fixture.oauth.exchangeToken({
        grant_type: 'refresh_token',
        client_id: fixture.clientId,
        refresh_token: fixture.refreshToken,
      }));
      const access = String(rotated.access_token);
      assert.ok(fixture.oauth.authenticate(`Bearer ${access}`, 'research'));
      fixture.oauth.revokeToken({ token: access });
      assert.equal(fixture.oauth.authenticate(`Bearer ${access}`, 'research'), null);
      assert.equal(fixture.oauth.authenticate(`Bearer ${fixture.accessToken}`, 'research'), null);
      assert.throws(() => fixture.oauth.exchangeToken({
        grant_type: 'refresh_token',
        client_id: fixture.clientId,
        refresh_token: String(rotated.refresh_token),
      }));
      fixture.registry.remove('research');
      assert.equal(fixture.registry.get('research'), null);
    } finally {
      fixture.close();
    }
  });

  it('rechecks grant revocation during a long poll and keeps DCR closed outside pairing', async () => {
    const fixture = createFixture();
    try {
      assert.throws(() => fixture.oauth.registerClient({
        redirect_uris: ['http://127.0.0.1/closed'],
        grant_types: ['authorization_code', 'refresh_token'],
      }), /pairing window/iu);
      assert.equal(fixture.oauth.authorizationServerMetadata().issuer, 'http://127.0.0.1');
      assert.equal(fixture.oauth.protectedResourceMetadata('research').resource, 'http://127.0.0.1/mcp/chatgpt/research');
      assert.throws(() => fixture.oauth.beginAuthorization({
        response_type: 'code',
        client_id: fixture.clientId,
        redirect_uri: 'http://127.0.0.1/not-registered',
      }), /redirect_uri/iu);

      fixture.store.openPairingWindow('research');
      const pkceClient = fixture.oauth.registerClient({
        redirect_uris: ['http://127.0.0.1/pkce'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
      const verifier = 'p'.repeat(48);
      const authorization = fixture.oauth.beginAuthorization({
        response_type: 'code',
        client_id: pkceClient.client_id,
        redirect_uri: 'http://127.0.0.1/pkce',
        resource: fixture.oauth.workerResource('research'),
        scope: 'mcp:tools offline_access',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      const callback = new URL(fixture.oauth.approveAuthorization(authorization.request.id, authorization.csrfToken));
      const code = callback.searchParams.get('code');
      assert.throws(() => fixture.oauth.exchangeToken({
        grant_type: 'authorization_code',
        client_id: pkceClient.client_id,
        code,
        redirect_uri: 'http://127.0.0.1/pkce',
        code_verifier: 'w'.repeat(48),
      }), /invalid/iu);
      const validTokens = fixture.oauth.exchangeToken({
        grant_type: 'authorization_code',
        client_id: pkceClient.client_id,
        code,
        redirect_uri: 'http://127.0.0.1/pkce',
        code_verifier: verifier,
      });
      const currentGrant = fixture.oauth.authenticate(`Bearer ${String(validTokens.access_token)}`, 'research');
      assert.ok(currentGrant);

      assert.throws(() => fixture.gateway.open(
        { ...fixture.grant, expiresAt: Date.now() - 1 },
        { protocol_version: '1.0', open_id: 'open_expired_grant' },
      ), /grant_revoked/u);
      assert.throws(() => fixture.gateway.open(
        { ...fixture.grant, scopes: [] },
        { protocol_version: '1.0', open_id: 'open_missing_scope' },
      ), /grant_revoked/u);
      assert.throws(() => fixture.gateway.open(
        { ...fixture.grant, resource: 'http://127.0.0.1/mcp/chatgpt/other' },
        { protocol_version: '1.0', open_id: 'open_wrong_audience' },
      ), /grant_revoked/u);

      const opened = fixture.gateway.open(currentGrant, { protocol_version: '1.0', open_id: 'open_revoke_poll' });
      const polling = fixture.gateway.exchange(currentGrant, {
        run_id: opened.run_id,
        exchange_id: opened.next_exchange_id,
        maximum_wait_seconds: 1,
      });
      const revoked = assert.rejects(polling, /grant_revoked/u);
      fixture.oauth.revokeToken({ token: String(validTokens.access_token) });
      await revoked;
    } finally {
      fixture.close();
    }
  });
});
