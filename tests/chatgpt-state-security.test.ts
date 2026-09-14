import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { ChatGptGatewayError } from '../src/llm/providers/chatgpt/errors.js';
import { ChatGptGateway } from '../src/llm/providers/chatgpt/gateway.js';
import { digestCanonical } from '../src/llm/providers/chatgpt/protocol.js';
import { ChatGptWorkerRegistry } from '../src/llm/providers/chatgpt/registry.js';
import { ChatGptGatewayStore, type ChatGptStoreAuditEvent } from '../src/llm/providers/chatgpt/store.js';
import type { AuthenticatedMcpGrant, ChatGptGatewayConfig, ChatGptSubmitInput, GatewayExchangeInput } from '../src/llm/providers/chatgpt/types.js';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-state-security-'));
  const config: ChatGptGatewayConfig = {
    enabled: true, publicBaseUrl: 'http://127.0.0.1', dataDir: dir, profile: 'compatibility',
    timeoutMs: 5_000, queueTimeoutMs: 2_000, longPollMs: 100, staleAfterMs: 5_000,
    maxQueuePerWorker: 4, maxActiveJobs: 8, maxRequestBytes: 16_384, maxResponseBytes: 16_384,
    idempotencyTtlSeconds: 60, retentionHours: 1,
  };
  const auditEvents: ChatGptStoreAuditEvent[] = [];
  const store = new ChatGptGatewayStore(config, (event) => auditEvents.push(event));
  const registry = new ChatGptWorkerRegistry(store, config, () => new Set());
  const gateway = new ChatGptGateway(store, registry);
  const keepAlive = setInterval(() => undefined, 10_000);
  const addWorker = (id: string) => {
    registry.create({
      id, label: id, publicModelIds: [`chatgpt-${id}`],
      allowedAppIds: ['app-test'], declaredModel: 'Operator declaration',
    });
    registry.update(id, { enabled: true });
  };
  addWorker('research');
  const authorize = (workerId = 'research', scopes = 'mcp:tools offline_access') => {
    const client = store.createOAuthClient({ workerId, clientName: 'Test worker', redirectUri: 'http://127.0.0.1/callback' });
    const request = store.createAuthorizationRequest({
      clientId: client.clientId, workerId, redirectUri: client.redirectUri,
      resource: `http://127.0.0.1/mcp/chatgpt/${workerId}`, scope: scopes,
      state: randomBytes(12).toString('hex'), codeChallenge: randomBytes(32).toString('base64url'),
      csrfHash: randomBytes(32).toString('hex'), expiresAtMs: Date.now() + 60_000,
    });
    const approved = store.approveAuthorization({ requestId: request.id, csrfHash: request.csrfHash });
    const grant = store.consumeAuthorizationCode({
      code: approved.code, clientId: client.clientId, redirectUri: client.redirectUri, codeChallenge: request.codeChallenge,
    });
    assert.ok(grant);
    const tokens = store.issueTokens(grant);
    const authenticated = store.authenticateAccessToken(tokens.accessToken, workerId, grant.resource, 'mcp:tools');
    assert.ok(authenticated);
    return { grant: authenticated, tokens, client, request };
  };
  const authorized = authorize();
  const db = new DatabaseSync(store.dbPath);
  return {
    config, store, registry, gateway, db, addWorker, authorize, auditEvents, ...authorized,
    open(grant: AuthenticatedMcpGrant = authorized.grant) {
      return gateway.open(grant, { protocol_version: '1.0', open_id: randomBytes(18).toString('base64url') });
    },
    close() {
      gateway.close();
      db.close();
      clearInterval(keepAlive);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function request(key = randomBytes(12).toString('hex')): ChatGptSubmitInput {
  const messages = [{ role: 'user' as const, content: `private prompt ${key}` }];
  const controls = { present: [], warnings: [], responseFormat: 'text' as const, stream: false, includeUsage: false, profile: 'compatibility' as const };
  return {
    appId: 'app-test', alias: 'chatgpt-research', messages, controls, surface: 'openai',
    fingerprint: digestCanonical({ messages, controls }), idempotencyKey: key,
  };
}

describe('ChatGPT authorization, replay fencing and storage safety', () => {
  it('binds in-flight deduplication to a validated grant and revalidates each consumer before delivery', async () => {
    const f = fixture();
    try {
      const opened = f.open();
      const input = { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 1 };
      const polling = f.gateway.exchange(f.grant, input);
      await assert.rejects(f.gateway.exchange({ ...f.grant, principalId: 'untrusted-principal' }, input), /grant_revoked/u);
      await assert.rejects(f.gateway.exchange({ ...f.grant, expiresAt: Date.now() - 1 }, input), /grant_revoked/u);
      f.addWorker('other');
      const foreign = f.authorize('other');
      assert.equal((await f.gateway.exchange(foreign.grant, input)).state, 'released');
      const expiring = f.gateway.exchange({ ...f.grant, expiresAt: Date.now() + 10 }, input);
      const expired = assert.rejects(expiring, /grant_revoked/u);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await f.store.enqueue(request());
      assert.equal((await polling).state, 'request');
      await expired;
    } finally { f.close(); }
  });

  it('never replays raw messages or handles for an expired claim or advances the queue as its replay', async () => {
    const f = fixture();
    try {
      const opened = f.open();
      const input = { run_id: opened.run_id, exchange_id: opened.next_exchange_id, maximum_wait_seconds: 1 };
      const poll = f.gateway.exchange(f.grant, input);
      const original = request('expired-private-payload');
      await f.store.enqueue(original);
      const claim = await poll;
      assert.equal(claim.state, 'request');
      if (claim.state !== 'request') throw new Error('Expected claim.');
      f.db.prepare('UPDATE jobs SET request_deadline_at_ms=?,lease_expires_at_ms=? WHERE request_id=?').run(Date.now() - 1, Date.now() - 1, claim.request.request_id);
      const recovery = await f.gateway.exchange(f.grant, input);
      assert.equal(recovery.state, 'recovery');
      if (recovery.state === 'recovery') assert.equal(recovery.code, 'claim_expired');
      const next = await f.store.enqueue(request('next-deliberate-request'));
      const replay = await f.gateway.exchange(f.grant, input);
      assert.equal(replay.state, 'recovery');
      assert.equal(f.store.workerStatus('research').queueLength, 1);
      const persisted = JSON.stringify(f.db.prepare('SELECT result_json FROM exchange_replays').all());
      assert.ok(!persisted.includes(claim.request.claim_token));
      assert.ok(!persisted.includes(original.messages[0]!.content));
      const nextClaim = await f.gateway.exchange(f.grant, { run_id: opened.run_id, exchange_id: replay.next_exchange_id });
      if (nextClaim.state !== 'request') throw new Error('Expected next deliberate claim.');
      assert.equal(nextClaim.request.request_id, next.job.requestId);
    } finally { f.close(); }
  });

  it('fences completion replay whose next claim was cancelled without reapplying completion or claiming another job', async () => {
    const f = fixture();
    try {
      const opened = f.open();
      const poll = f.gateway.exchange(f.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id });
      await f.store.enqueue(request('first'));
      const first = await poll;
      if (first.state !== 'request') throw new Error('Expected first claim.');
      await f.store.enqueue(request('second-private'));
      const completion: GatewayExchangeInput = {
        run_id: opened.run_id, exchange_id: first.next_exchange_id,
        completion: { request_id: first.request.request_id, claim_token: first.request.claim_token, response: 'first answer' },
      };
      const second = await f.gateway.exchange(f.grant, completion);
      if (second.state !== 'request') throw new Error('Expected second claim.');
      f.store.cancelJob(second.request.request_id);
      await f.store.enqueue(request('third'));
      const replay = await f.gateway.exchange(f.grant, completion);
      assert.equal(replay.state, 'recovery');
      if (replay.state === 'recovery') assert.equal(replay.code, 'request_cancelled');
      assert.equal(f.store.workerStatus('research').queueLength, 1);
      assert.equal((await f.store.waitForJob(first.request.request_id)).result, 'first answer');
      const persisted = JSON.stringify(f.db.prepare('SELECT result_json FROM exchange_replays').all());
      assert.ok(!persisted.includes(second.request.claim_token));
      assert.ok(!persisted.includes('second-private'));
    } finally { f.close(); }
  });

  it('fences cached results after release and after a replacement binding, including delivery microtasks', async () => {
    const f = fixture();
    try {
      const opened = f.open();
      const input = { run_id: opened.run_id, exchange_id: opened.next_exchange_id };
      const poll = f.gateway.exchange(f.grant, input);
      await f.store.enqueue(request());
      const claim = await poll;
      assert.equal(claim.state, 'request');
      const delivery = f.gateway.exchange(f.grant, input);
      f.store.releaseWorker('research');
      assert.equal((await delivery).state, 'released');
      assert.equal((await f.gateway.exchange(f.grant, input)).state, 'released');
      const replacement = f.authorize();
      await assert.rejects(f.gateway.exchange(f.grant, input), /grant_revoked/u);
      assert.throws(() => f.open(f.grant), /grant_revoked/u);
      assert.ok(f.open(replacement.grant).run_generation > opened.run_generation);
    } finally { f.close(); }
  });

  it('does not release another active grant run when revoking a legacy inactive token family', () => {
    const f = fixture();
    try {
      const replacement = f.authorize();
      const opened = f.open(replacement.grant);
      // Model a pre-upgrade database that permitted more than one valid grant.
      f.db.prepare('UPDATE oauth_grants SET revoked_at_ms=NULL WHERE id=?').run(f.grant.id);
      f.db.prepare('INSERT OR REPLACE INTO oauth_access_tokens(token_hash,grant_id,expires_at_ms) VALUES (?,?,?)').run(
        createHash('sha256').update(f.tokens.accessToken).digest('hex'), f.grant.id, Date.now() + 60_000,
      );
      f.store.revokeToken(f.tokens.accessToken);
      assert.notEqual(f.db.prepare('SELECT revoked_at_ms FROM oauth_grants WHERE id=?').get(f.grant.id)?.revoked_at_ms, null);
      f.store.validateGrant(replacement.grant);
      const run = f.db.prepare('SELECT status FROM runs WHERE run_id=?').get(opened.run_id);
      assert.equal(run?.status, 'active');
    } finally { f.close(); }
  });

  it('never stores or publishes untrusted worker error text in errors, status or replay', async () => {
    const f = fixture();
    try {
      const opened = f.open();
      const poll = f.gateway.exchange(f.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id });
      const pending = f.gateway.submit(request('secret-prompt'));
      const rejected = assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof ChatGptGatewayError);
        assert.equal(error.code, 'chatgpt_completion_failed');
        assert.doesNotMatch(error.message, /secret-prompt|secret-token|claim_/u);
        return true;
      });
      const claim = await poll;
      if (claim.state !== 'request') throw new Error('Expected claim.');
      const completion = f.gateway.exchange(f.grant, {
        run_id: opened.run_id, exchange_id: claim.next_exchange_id, maximum_wait_seconds: 1,
        completion: {
          request_id: claim.request.request_id, claim_token: claim.request.claim_token,
          error: { code: 'secret-token', message: `secret-prompt ${claim.request.claim_token} secret-token` },
        },
      });
      await rejected;
      assert.doesNotMatch(JSON.stringify(f.store.workerStatus('research')), /secret-prompt|secret-token|claim_/u);
      const persisted = JSON.stringify(f.db.prepare('SELECT error_message FROM jobs').all());
      assert.doesNotMatch(persisted, /secret-prompt|secret-token|claim_/u);
      f.store.releaseWorker('research');
      await completion;
      f.db.prepare('UPDATE jobs SET error_message=? WHERE request_id=?').run('legacy-private-worker-text', claim.request.request_id);
      f.db.prepare('UPDATE workers SET last_error_code=?,last_error_message=? WHERE id=?').run('chatgpt_completion_failed', 'legacy-private-worker-text', 'research');
      assert.doesNotMatch(JSON.stringify(f.store.workerStatus('research')), /legacy-private/u);
      await assert.rejects(f.gateway.submit(request('secret-prompt')), (error: unknown) => {
        assert.ok(error instanceof ChatGptGatewayError);
        assert.doesNotMatch(error.message, /legacy-private/u);
        return true;
      });
    } finally { f.close(); }
  });

  it('returns typed shutdown errors and does not enqueue or open a poll for pre-aborted callers', async () => {
    const f = fixture();
    try {
      const opened = f.open();
      const signal = AbortSignal.abort();
      await assert.rejects(f.gateway.submit({ ...request(), signal }), (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_request_cancelled');
      await assert.rejects(f.gateway.exchange(f.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id }, signal), /exchange_aborted/u);
      assert.equal(f.store.workerStatus('research').pendingWorkerPolls, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()?.count, 0);
      const poll = f.gateway.exchange(f.grant, { run_id: opened.run_id, exchange_id: opened.next_exchange_id });
      const pending = f.gateway.submit(request());
      const rejected = assert.rejects(pending, (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_store_unavailable');
      const abortedPoll = assert.rejects(poll, /exchange_aborted|gateway stopped/iu);
      f.gateway.close();
      await Promise.all([rejected, abortedPoll]);
    } finally { f.close(); }
  });

  it('claims ownership before migration and releases failed startup ownership for safe recovery', () => {
    const f = fixture();
    const temporaryDir = mkdtempSync(path.join(tmpdir(), 'gemrouter-schema-security-'));
    try {
      f.db.exec('PRAGMA user_version=2;');
      assert.throws(() => new ChatGptGatewayStore(f.config), /already owns/u);
      assert.equal(f.db.prepare('PRAGMA user_version').get()?.user_version, 2);
      f.db.exec('PRAGMA user_version=3;');
      const db = new DatabaseSync(path.join(temporaryDir, 'gateway.sqlite'));
      db.exec('PRAGMA user_version=999;');
      assert.throws(() => new ChatGptGatewayStore({ ...f.config, dataDir: temporaryDir }), /future.*schema/iu);
      db.exec('PRAGMA user_version=0;');
      db.close();
      const recovered = new ChatGptGatewayStore({ ...f.config, dataDir: temporaryDir });
      recovered.close();
    } finally {
      f.close();
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  it('bounds durable clients and pending consent, supports denial, and scopes refresh tokens', () => {
    const f = fixture();
    try {
      const noOffline = f.authorize('research', 'mcp:tools');
      assert.equal(noOffline.tokens.refreshToken, undefined);
      const pending = Array.from({ length: 8 }, () => f.store.createAuthorizationRequest({ ...noOffline.request }));
      assert.throws(() => f.store.createAuthorizationRequest({ ...noOffline.request }), /capacity/u);
      assert.throws(() => f.store.denyAuthorization({ requestId: pending[0]!.id, csrfHash: 'wrong' }), /invalid_consent/u);
      f.store.denyAuthorization({ requestId: pending[0]!.id, csrfHash: pending[0]!.csrfHash });
      assert.equal(f.store.getAuthorizationRequest(pending[0]!.id), null);
      assert.ok(f.store.createAuthorizationRequest({ ...noOffline.request }));
      for (let i = 0; i < 14; i += 1) f.store.createOAuthClient({ workerId: 'research', clientName: `unused-${i}`, redirectUri: 'http://127.0.0.1/callback' });
      assert.throws(() => f.store.createOAuthClient({ workerId: 'research', clientName: 'overflow', redirectUri: 'http://127.0.0.1/callback' }), /capacity/u);
      f.db.prepare('UPDATE oauth_clients SET created_at_ms=? WHERE client_name LIKE ?').run(Date.now() - 11 * 60_000, 'unused-%');
      f.store.prune();
      assert.ok(f.store.createOAuthClient({ workerId: 'research', clientName: 'after-prune', redirectUri: 'http://127.0.0.1/callback' }));
    } finally { f.close(); }
  });

  it('rolls back a completion and its audit when replay capacity is full, preserving valid replay guarantees', async () => {
    const f = fixture();
    try {
      const opened = f.open();
      const originalInput = { run_id: opened.run_id, exchange_id: opened.next_exchange_id };
      const poll = f.gateway.exchange(f.grant, originalInput);
      await f.store.enqueue(request());
      const claim = await poll;
      if (claim.state !== 'request') throw new Error('Expected claim.');
      const idleResult = JSON.stringify({ protocol_version: '1.0', state: 'idle', continue: true, waited_seconds: 1, next_exchange_id: 'retained-cursor' });
      f.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1023)
        INSERT INTO exchange_replays(run_id,exchange_id,args_digest,result_json,expires_at_ms)
        SELECT ?, 'retained-' || i, 'digest', ?, ? FROM n`).run(opened.run_id, idleResult, Date.now() + 60_000);
      const completion = {
        run_id: opened.run_id, exchange_id: claim.next_exchange_id, maximum_wait_seconds: 1,
        completion: { request_id: claim.request.request_id, claim_token: claim.request.claim_token, response: 'capacity-test-result' },
      };
      await assert.rejects(f.gateway.exchange(f.grant, completion), (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_queue_full');
      assert.equal(f.db.prepare('SELECT status FROM jobs WHERE request_id=?').get(claim.request.request_id)?.status, 'claimed');
      assert.equal(f.auditEvents.filter((event) => event.type === 'chatgpt.request.completed').length, 0);
      assert.deepEqual(await f.gateway.exchange(f.grant, originalInput), claim);
      f.db.prepare('UPDATE exchange_replays SET expires_at_ms=? WHERE exchange_id LIKE ?').run(Date.now() - 1, 'retained-%');
      f.store.prune();
      const completing = f.gateway.exchange(f.grant, completion);
      assert.equal((await f.store.waitForJob(claim.request.request_id)).result, 'capacity-test-result');
      assert.equal(f.auditEvents.filter((event) => event.type === 'chatgpt.request.completed').length, 1);
      f.store.releaseWorker('research');
      await completing;
    } finally { f.close(); }
  });

  it('binds authorization codes before consumption and prevents widening stored scopes', () => {
    const f = fixture();
    try {
      const client = f.store.createOAuthClient({ workerId: 'research', clientName: 'bound-code', redirectUri: 'http://127.0.0.1/callback' });
      const pending = f.store.createAuthorizationRequest({ ...f.request, clientId: client.clientId });
      const approved = f.store.approveAuthorization({ requestId: pending.id, csrfHash: pending.csrfHash });
      const input = { code: approved.code, clientId: client.clientId, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge };
      assert.equal(f.store.consumeAuthorizationCode({ ...input, clientId: f.client.clientId }), null);
      assert.equal(f.store.consumeAuthorizationCode({ ...input, codeChallenge: 'wrong' }), null);
      const grant = f.store.consumeAuthorizationCode(input);
      assert.ok(grant);
      assert.equal(f.store.consumeAuthorizationCode(input), null);
      assert.throws(() => f.store.issueTokens({ ...grant, scopes: [...grant.scopes, 'admin:write'] }), /grant_revoked/u);
    } finally { f.close(); }
  });
});
