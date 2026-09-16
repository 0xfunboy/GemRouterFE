import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { canonicalPersonalChatUrl, PERSONAL_CHAT_TOOLS, publicControlBinding, type ChatGptControlBindingInput, type ChatGptControlVerificationEvidence } from '../src/llm/providers/chatgpt/control/types.js';
import { ChatGptGatewayError } from '../src/llm/providers/chatgpt/errors.js';
import { ChatGptGateway } from '../src/llm/providers/chatgpt/gateway.js';
import { CHATGPT_MCP_OUTPUT_SCHEMAS } from '../src/llm/providers/chatgpt/mcp.js';
import { digestCanonical, validateGatewayExchangeInput } from '../src/llm/providers/chatgpt/protocol.js';
import { ChatGptWorkerRegistry } from '../src/llm/providers/chatgpt/registry.js';
import { ChatGptGatewayStore } from '../src/llm/providers/chatgpt/store.js';
import type { ChatGptGatewayConfig, ChatGptSubmitInput } from '../src/llm/providers/chatgpt/types.js';

const target = 'https://chatgpt.com/c/00000000-0000-0000-0000-b40c114d0582';
const otherTarget = 'https://chatgpt.com/c/00000000-0000-0000-0000-b892dd67c685';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-control-store-'));
  const config: ChatGptGatewayConfig = { enabled: true, publicBaseUrl: 'https://gemr.example.test', dataDir: dir,
    profile: 'compatibility', timeoutMs: 5_000, queueTimeoutMs: 3_000, longPollMs: 100, staleAfterMs: 100,
    maxQueuePerWorker: 4, maxActiveJobs: 8, maxRequestBytes: 16_384, maxResponseBytes: 16_384,
    idempotencyTtlSeconds: 60, retentionHours: 1 };
  const store = new ChatGptGatewayStore(config);
  const registry = new ChatGptWorkerRegistry(store, config, () => new Set());
  registry.create({ id: 'trade', label: 'Trade', publicModelIds: ['air3-trade'], allowedAppIds: ['test-app'], declaredModel: 'Operator-selected model' });
  registry.update('trade', { enabled: true });
  const client = store.createOAuthClient({ workerId: 'trade', clientName: 'Example - Trade', redirectUri: 'http://127.0.0.1/callback' });
  const authorization = store.createAuthorizationRequest({ clientId: client.clientId, workerId: 'trade',
    redirectUri: client.redirectUri, resource: 'https://gemr.example.test/mcp/chatgpt/trade', scope: 'mcp:tools offline_access',
    state: 'test-state', codeChallenge: 'test-challenge', csrfHash: 'test-csrf', expiresAtMs: Date.now() + 60_000 });
  const approved = store.approveAuthorization({ requestId: authorization.id, csrfHash: authorization.csrfHash });
  const grant = store.consumeAuthorizationCode({ code: approved.code, clientId: client.clientId, redirectUri: client.redirectUri, codeChallenge: authorization.codeChallenge });
  assert.ok(grant);
  const tokens = store.issueTokens(grant);
  const gateway = new ChatGptGateway(store, registry);
  const opened = gateway.open(grant, { protocol_version: '1.0', open_id: 'existing-private-bootstrap' });
  const db = new DatabaseSync(store.dbPath);
  let runtimeReady = true;
  store.configureControl({ enabled: true, maxAttempts: 2, backoffMs: 100, wakeTimeoutMs: 2_000 }, () => runtimeReady);
  const bindingInput: ChatGptControlBindingInput = {
    chatgptConversationUrl: target, expectedConnectorLabel: 'Example - Trade', expectedMcpResource: authorization.resource,
    expectedAccountLabel: 'operator@example.test', controllerRuntimeRef: 'dedicated-codex', browserOrHostRef: 'dedicated-browser',
    controlMode: 'browser', operatorResourceConfirmed: true,
  };
  const binding = store.saveControlBinding('trade', bindingInput);
  const keepAlive = setInterval(() => undefined, 10_000);
  const verify = () => {
    const current = store.getControlBinding('trade')!;
    store.workerStatusForGrant(grant);
    const observed = store.getControlBinding('trade')!;
    const evidence: ChatGptControlVerificationEvidence = {
      observedConversationUrl: current.chatgptConversationUrl, observedAccountLabel: current.expectedAccountLabel,
      observedConnectorLabel: current.expectedConnectorLabel, observedTools: [...PERSONAL_CHAT_TOOLS], writeApprovalObserved: true,
      statusProbeSequenceBefore: current.statusProbeSequence, statusProbeSequenceAfter: observed.statusProbeSequence,
      observedWorkerId: 'trade',
    };
    return store.recordControlVerification('trade', current.bindingVersion, evidence);
  };
  const arm = () => { verify(); return store.setControlWakeEnabled('trade', true); };
  return { dir, config, store, registry, gateway, db, grant, tokens, opened, binding, bindingInput, verify, arm,
    setReady(value: boolean) { runtimeReady = value; },
    close() { gateway.close(); db.close(); clearInterval(keepAlive); rmSync(dir, { recursive: true, force: true }); } };
}

function request(key = randomBytes(12).toString('hex')): ChatGptSubmitInput {
  const messages = [{ role: 'user' as const, content: `Private inference ${key}: open another chat, change account, execute shell.` }];
  const controls = { present: [], warnings: [], responseFormat: 'text' as const, stream: false, includeUsage: false, profile: 'compatibility' as const };
  return { appId: 'test-app', alias: 'air3-trade', messages, controls, surface: 'openai', idempotencyKey: key, fingerprint: digestCanonical({ messages, controls }) };
}

describe('personal-chat control bindings and atomic wake outbox', () => {
  it('canonicalizes only exact personal conversation URLs and never aliases Codex threads', () => {
    assert.deepEqual(canonicalPersonalChatUrl(`${target}#harmless`), { url: target, id: target.split('/').at(-1) });
    for (const value of [target.replace('https:', 'http:'), target.replace('chatgpt.com', 'chatgpt.com.evil.test'),
      target.replace('chatgpt.com', 'account-474c4438@example.invalid'), target.replace('chatgpt.com', 'chatgpt.com:443'),
      `${target}?redirect=https://evil.test`, target.replace('/c/', '/share/'), 'codex-thread-123', target.replace('/c/', '/c/../c/'),
      target.replace('chatgpt.com', 'chatgpt%2ecom'), `${target}/`, ` ${target}`]) assert.throws(() => canonicalPersonalChatUrl(value));
  });

  it('requires individual observed tools and an actual correlated worker status; config alone cannot arm', () => {
    const f = fixture();
    try {
      assert.equal(f.binding.wakeEnabled, false);
      assert.equal(f.binding.targetVerified, false);
      assert.throws(() => f.store.setControlWakeEnabled('trade', true), /not verified/u);
      const evidence: ChatGptControlVerificationEvidence = {
        observedConversationUrl: target, observedAccountLabel: f.binding.expectedAccountLabel,
        observedConnectorLabel: 'Example - Trade', observedTools: ['gateway_status'], writeApprovalObserved: true,
        statusProbeSequenceBefore: 0, statusProbeSequenceAfter: 1, observedWorkerId: 'trade',
      };
      assert.throws(() => f.store.recordControlVerification('trade', 1, evidence), /tools_missing/u);
      assert.throws(() => f.store.recordControlVerification('trade', 1, { ...evidence, observedTools: [...PERSONAL_CHAT_TOOLS] }), /not observed/u);
      f.store.workerStatus('trade'); // Dashboard inspection must not manufacture a diagnostic.
      assert.equal(f.store.getControlBinding('trade')!.statusProbeSequence, 0);
      const verified = f.verify();
      assert.equal(verified.boundGrantId, f.grant.id);
      assert.ok(!('boundGrantId' in publicControlBinding(verified)));
      assert.ok(f.store.authenticateAccessToken(f.tokens.accessToken, 'trade', f.binding.expectedMcpResource, 'mcp:tools'));
      assert.equal(f.store.listGrants('trade').length, 1);
      assert.equal(f.store.setControlWakeEnabled('trade', true).wakeEnabled, true);
      f.setReady(false);
      assert.throws(() => f.store.setControlWakeEnabled('trade', true), /not verified/u);
    } finally { f.close(); }
  });

  it('atomically admits a stale exact worker and deduplicates a burst without giving control access to prompts', async () => {
    const f = fixture();
    try {
      await assert.rejects(f.store.enqueue(request()), /not actively polling/u);
      f.arm();
      const jobs = await Promise.all(Array.from({ length: 4 }, (_, i) => f.store.enqueue(request(`burst-${i}`))));
      assert.equal(new Set(jobs.map(({ job }) => job.requestId)).size, 4);
      assert.equal(f.store.listControlWakeStatus().length, 1);
      await assert.rejects(f.store.enqueue(request('queue-overflow')), (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_queue_full');
      const operation = f.store.claimNextControlWake();
      assert.ok(operation);
      assert.equal(f.store.claimNextControlWake(), null);
      assert.equal(operation.state, 'controller_accepted');
      assert.equal(operation.binding.chatgptConversationUrl, target);
      assert.doesNotMatch(JSON.stringify(operation), /Private inference|execute shell|claim_token|messages|existing-private-bootstrap/u);
      assert.equal(f.store.requireCurrentControlWake(operation.id).deadlineAtMs, operation.deadlineAtMs);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE control_operation_id=?').get(operation.id)?.count, 4);
    } finally { f.close(); }
  });

  it('rolls back the job if the durable wake intent cannot be committed', async () => {
    const f = fixture();
    try {
      f.arm();
      f.db.exec("CREATE TRIGGER reject_test_wake BEFORE INSERT ON control_wakes BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END;");
      await assert.rejects(f.store.enqueue(request()), /outbox failure/u);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()?.count, 0);
      assert.equal(f.store.listControlWakeStatus().length, 0);
      assert.equal(f.store.getControlBinding('trade')!.activationGeneration, 0);
    } finally { f.close(); }
  });

  it('preserves feature-off admission and rejects expired deadlines, disabled workers, and stopped control', async () => {
    const f = fixture();
    try {
      f.arm();
      await assert.rejects(f.store.enqueue({ ...request(), deadline: Date.now() - 1 }), (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_request_timeout');
      f.store.stopControlWorker('trade');
      await assert.rejects(f.store.enqueue(request()), /not actively polling/u);
      f.store.setControlWakeEnabled('trade', true);
      f.registry.update('trade', { enabled: false });
      await assert.rejects(f.store.enqueue(request()), /not actively polling/u);
      assert.equal(f.store.listControlWakeStatus().length, 0);
      f.store.configureControl({ enabled: false }, () => true);
      assert.equal(f.store.claimNextControlWake(), null);
      assert.equal(f.store.getControlBinding('trade')!.wakeEnabled, false);
    } finally { f.close(); }
  });

  it('cancels an unsent wake when its last shared HTTP consumer disconnects', async () => {
    const f = fixture();
    try {
      f.arm();
      const one = new AbortController();
      const two = new AbortController();
      const first = f.gateway.submit({ ...request('shared'), signal: one.signal });
      const second = f.gateway.submit({ ...request('shared'), signal: two.signal });
      const firstRejection = assert.rejects(first, /cancelled/u);
      const secondRejection = assert.rejects(second, /cancelled/u);
      await new Promise((resolve) => setImmediate(resolve));
      one.abort();
      await firstRejection;
      assert.equal(f.store.listControlWakeStatus()[0]!.state, 'wake_requested');
      two.abort();
      await secondRejection;
      assert.equal(f.store.listControlWakeStatus()[0]!.state, 'cancelled');
      assert.equal(f.store.claimNextControlWake(), null);
    } finally { f.close(); }
  });

  it('fences queued work and in-flight control when target version, stop, or grant changes', async () => {
    const f = fixture();
    try {
      f.arm();
      const { job } = await f.store.enqueue(request());
      const operation = f.store.claimNextControlWake()!;
      const next = f.store.saveControlBinding('trade', { ...f.bindingInput, chatgptConversationUrl: otherTarget });
      assert.equal(next.bindingVersion, 2);
      assert.equal(next.targetVerified, false);
      assert.equal(next.wakeEnabled, false);
      assert.throws(() => f.store.requireCurrentControlWake(operation.id), /binding_changed/u);
      assert.equal((await f.store.waitForJob(job.requestId)).errorCode, 'chatgpt_control_binding_changed');
      f.arm();
      await f.store.enqueue(request());
      const second = f.store.claimNextControlWake()!;
      f.store.revokeGrant(f.grant.id);
      assert.throws(() => f.store.requireCurrentControlWake(second.id));
      assert.equal(f.store.getControlBinding('trade')!.gatewayStatusVerified, false);
      assert.equal(f.store.getControlBinding('trade')!.wakeEnabled, false);
    } finally { f.close(); }
  });

  it('uses bounded backoff without extending deadlines and never blindly retries ambiguous delivery', async () => {
    const f = fixture();
    try {
      f.arm();
      const { job } = await f.store.enqueue(request());
      const one = f.store.claimNextControlWake()!;
      f.store.failControlWake(one.id, 'controller_unavailable', { retryable: true });
      assert.equal(f.store.claimNextControlWake(), null);
      f.db.prepare('UPDATE control_wakes SET next_attempt_at_ms=? WHERE id=?').run(Date.now() - 1, one.id);
      const two = f.store.claimNextControlWake()!;
      assert.equal(two.id, one.id);
      assert.equal(two.attempts, 2);
      assert.equal(two.deadlineAtMs, one.deadlineAtMs);
      f.store.markControlWake(two.id, 'target_verified');
      f.store.markControlWake(two.id, 'wake_delivery_attempted');
      f.store.failControlWake(two.id, 'delivery_ambiguous', { retryable: true, ambiguous: true });
      assert.equal(f.store.listControlWakeStatus()[0]!.state, 'operator_action_required');
      assert.equal(f.store.claimNextControlWake(), null);
      assert.equal(f.store.getControlBinding('trade')!.wakeEnabled, false);
      assert.equal((await f.store.waitForJob(job.requestId)).status, 'failed');
    } finally { f.close(); }
  });

  it('expires the wake inside its original request budget without delivering stale jobs', async () => {
    const f = fixture();
    try {
      f.arm();
      const deadline = Date.now() + 1_000;
      const { job } = await f.store.enqueue({ ...request(), deadline });
      const operation = f.store.claimNextControlWake()!;
      assert.ok(operation.deadlineAtMs <= deadline);
      f.db.prepare('UPDATE control_wakes SET deadline_at_ms=? WHERE id=?').run(Date.now() - 1, operation.id);
      f.store.reconcileControlWakes();
      assert.equal(f.store.listControlWakeStatus()[0]!.state, 'wake_expired');
      assert.equal((await f.store.waitForJob(job.requestId)).errorCode, 'chatgpt_wake_timeout');
      assert.equal(f.store.claimNextControlWake(), null);
    } finally { f.close(); }
  });

  it('observes real worker polling, suppresses wake while polling/claimed, and yields the final completion without a new claim', async () => {
    const f = fixture();
    try {
      f.arm();
      const queued = await f.store.enqueue(request('first'));
      const first = await f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: f.opened.next_exchange_id });
      if (first.state !== 'request') throw new Error('Expected first claim.');
      assert.equal(f.store.listControlWakeStatus()[0]!.state, 'mcp_poll_observed');
      assert.ok(f.store.getControlBinding('trade')!.lastPollingObservedAt);
      const second = await f.store.enqueue(request('second'));
      assert.equal(f.store.listControlWakeStatus().length, 1);
      assert.equal(f.store.claimNextControlWake(), null);
      const input = {
        run_id: f.opened.run_id, exchange_id: first.next_exchange_id, yield_after_completion: true,
        completion: { request_id: first.request.request_id, claim_token: first.request.claim_token, response: 'only from MCP' },
      };
      assert.equal(validateGatewayExchangeInput(input, 55).yield_after_completion, true);
      const yielded = await f.gateway.exchange(f.grant, input);
      assert.equal(yielded.state, 'yielded');
      assert.equal(yielded.continue, true);
      assert.ok(CHATGPT_MCP_OUTPUT_SCHEMAS.exchange.safeParse(yielded).success);
      assert.equal((await f.store.waitForJob(queued.job.requestId)).result, 'only from MCP');
      assert.equal(f.db.prepare('SELECT status FROM jobs WHERE request_id=?').get(second.job.requestId)?.status, 'queued');
      assert.deepEqual(await f.gateway.exchange(f.grant, input), yielded);
      assert.equal(f.store.listControlWakeStatus().filter((wake) => wake.state === 'wake_requested').length, 1);
      assert.ok(f.store.claimNextControlWake());
      const nextClaim = await f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: yielded.next_exchange_id });
      if (nextClaim.state !== 'request') throw new Error('Expected second claim after deliberate resume.');
      assert.equal(nextClaim.request.request_id, second.job.requestId);
      await assert.rejects(f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: nextClaim.next_exchange_id, yield_after_completion: true }), /requires a completion/u);
    } finally { f.close(); }
  });

  it('keeps explicit bootstrap private/idempotent and refuses takeover of an active run', () => {
    const f = fixture();
    try {
      assert.throws(() => f.store.getControlBootstrapId('trade', 1), /worker_busy/u);
      f.store.releaseWorker('trade');
      const openId = f.store.getControlBootstrapId('trade', 1);
      assert.equal(f.store.getControlBootstrapId('trade', 1), openId);
      assert.ok(!JSON.stringify(f.store.getControlBinding('trade')).includes(openId));
      const opened = f.gateway.open(f.grant, { protocol_version: '1.0', open_id: openId });
      assert.ok(opened.run_generation > f.opened.run_generation);
      assert.deepEqual(opened.limits.extensions, ['yield_after_completion_v1']);
      assert.ok(CHATGPT_MCP_OUTPUT_SCHEMAS.open.safeParse(opened).success);
      assert.throws(() => f.store.getControlBootstrapId('trade', 1), /worker_busy/u);
      f.store.releaseWorker('trade');
      const nextOpenId = f.store.getControlBootstrapId('trade', 1);
      assert.notEqual(nextOpenId, openId);
      assert.equal(f.store.getControlBootstrapId('trade', 1), nextOpenId);
      assert.ok(f.gateway.open(f.grant, { protocol_version: '1.0', open_id: nextOpenId }).run_generation > opened.run_generation);
    } finally { f.close(); }
  });

  it('cancels orphan jobs/outbox and disarms verification on restart while preserving the worker grant', async () => {
    const f = fixture();
    let replacement: ChatGptGatewayStore | undefined;
    try {
      f.arm();
      const { job } = await f.store.enqueue(request());
      f.store.claimNextControlWake();
      f.gateway.close();
      replacement = new ChatGptGatewayStore(f.config);
      assert.equal((await replacement.waitForJob(job.requestId)).errorCode, 'chatgpt_gateway_restarted');
      assert.equal(replacement.getControlBinding('trade')!.wakeEnabled, false);
      assert.equal(replacement.getControlBinding('trade')!.targetVerified, false);
      assert.equal(replacement.listControlWakeStatus()[0]!.state, 'cancelled');
      assert.ok(replacement.authenticateAccessToken(f.tokens.accessToken, 'trade', f.binding.expectedMcpResource, 'mcp:tools'));
      assert.equal(replacement.claimNextControlWake(), null);
    } finally { replacement?.close(); f.close(); }
  });

  it('retains evidence of an already-attempted send when its last pending job is cancelled', async () => {
    const f = fixture();
    try {
      f.arm();
      const { job } = await f.store.enqueue(request());
      const operation = f.store.claimNextControlWake()!;
      f.store.markControlWake(operation.id, 'target_verified');
      f.store.markControlWake(operation.id, 'wake_delivery_attempted');
      f.store.markControlWake(operation.id, 'wake_delivered_observed');
      f.store.cancelJob(job.requestId);
      const status = f.store.listControlWakeStatus()[0]!;
      assert.equal(status.state, 'cancelled');
      assert.ok(status.deliveryAttemptedAtMs);
      assert.ok(status.deliveredObservedAtMs);
      assert.throws(() => f.store.requireCurrentControlWake(operation.id), /no_pending_jobs/u);
      const latePoll = await f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: f.opened.next_exchange_id, maximum_wait_seconds: 1 });
      assert.equal(latePoll.state, 'idle');
      assert.equal((await f.store.waitForJob(job.requestId)).status, 'cancelled');
    } finally { f.close(); }
  });

  it('lets an ordinary control stop finish an existing claim but revocation prevents a late result', async () => {
    for (const revoke of [false, true]) {
      const f = fixture();
      try {
        f.arm();
        const { job } = await f.store.enqueue(request());
        const claim = await f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: f.opened.next_exchange_id });
        if (claim.state !== 'request') throw new Error('Expected claim.');
        if (revoke) f.store.revokeGrant(f.grant.id); else f.store.stopControlWorker('trade');
        const completion = f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: claim.next_exchange_id, yield_after_completion: true,
          completion: { request_id: claim.request.request_id, claim_token: claim.request.claim_token, response: 'authorized existing claim' } });
        if (revoke) {
          await assert.rejects(completion, /grant_revoked/u);
          assert.equal((await f.store.waitForJob(job.requestId)).result, null);
        } else {
          assert.equal((await completion).state, 'yielded');
          assert.equal((await f.store.waitForJob(job.requestId)).result, 'authorized existing claim');
        }
      } finally { f.close(); }
    }
  });

  it('treats an ambiguous idle replay as observed MCP contact without claiming a different job or extending its budget', async () => {
    const f = fixture();
    try {
      f.arm();
      const initial = { run_id: f.opened.run_id, exchange_id: f.opened.next_exchange_id, maximum_wait_seconds: 1 };
      const idle = await f.gateway.exchange(f.grant, initial);
      assert.equal(idle.state, 'idle');
      const { job } = await f.store.enqueue(request());
      const operation = f.store.claimNextControlWake()!;
      f.store.markControlWake(operation.id, 'target_verified');
      f.store.markControlWake(operation.id, 'wake_delivery_attempted');
      f.store.markControlWake(operation.id, 'wake_delivered_observed');
      assert.deepEqual(await f.gateway.exchange(f.grant, initial), idle);
      const old = f.store.listControlWakeStatus().find((wake) => wake.id === operation.id)!;
      assert.equal(old.state, 'mcp_poll_observed');
      assert.ok(old.pollingObservedAtMs);
      assert.equal(f.db.prepare('SELECT status FROM jobs WHERE request_id=?').get(job.requestId)?.status, 'queued');
      assert.equal(f.db.prepare('SELECT control_wake_count FROM jobs WHERE request_id=?').get(job.requestId)?.control_wake_count, 1);
      const next = f.store.listControlWakeStatus().find((wake) => wake.state === 'wake_requested')!;
      assert.ok(next.deadlineAtMs <= job.queueDeadlineAtMs);
      const claim = await f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: idle.next_exchange_id });
      if (claim.state !== 'request') throw new Error('Expected original pending job.');
      assert.equal(claim.request.request_id, job.requestId);
    } finally { f.close(); }
  });

  it('expires an old wake before admitting a new deliberate request instead of attaching it to a dead operation', async () => {
    const f = fixture();
    try {
      f.arm();
      const oldJob = await f.store.enqueue(request());
      const oldWake = f.store.listControlWakeStatus()[0]!;
      f.db.prepare('UPDATE control_wakes SET deadline_at_ms=? WHERE id=?').run(Date.now() - 1, oldWake.id);
      const nextJob = await f.store.enqueue(request());
      assert.equal((await f.store.waitForJob(oldJob.job.requestId)).errorCode, 'chatgpt_wake_timeout');
      const next = f.store.claimNextControlWake()!;
      assert.notEqual(next.id, oldWake.id);
      assert.equal(f.db.prepare('SELECT status FROM jobs WHERE request_id=?').get(nextJob.job.requestId)?.status, 'queued');
    } finally { f.close(); }
  });

  it('requires fresh verification after a dangerous administrative control failure', () => {
    const f = fixture();
    try {
      f.arm();
      f.store.stopControlWorker('trade', 'account_mismatch');
      const binding = f.store.getControlBinding('trade')!;
      assert.equal(binding.targetVerified, false);
      assert.equal(binding.gatewayStatusVerified, false);
      assert.equal(binding.boundGrantId, null);
      assert.throws(() => f.store.setControlWakeEnabled('trade', true), /not verified/u);
      assert.ok(f.store.authenticateAccessToken(f.tokens.accessToken, 'trade', f.binding.expectedMcpResource, 'mcp:tools'));
    } finally { f.close(); }
  });

  it('does not share targets, gateway observations, or admission across workers', async () => {
    const f = fixture();
    try {
      f.arm();
      f.registry.create({ id: 'other', label: 'Other', publicModelIds: ['other'], allowedAppIds: ['test-app'], declaredModel: 'Other' });
      f.registry.update('other', { enabled: true });
      const otherInput = { ...f.bindingInput, expectedMcpResource: 'https://gemr.example.test/mcp/chatgpt/other' };
      assert.throws(() => f.store.saveControlBinding('other', otherInput), /already bound/u);
      f.store.saveControlBinding('other', { ...otherInput, chatgptConversationUrl: otherTarget });
      f.store.workerStatusForGrant(f.grant);
      assert.equal(f.store.getControlBinding('other')!.statusProbeSequence, 0);
      await assert.rejects(f.store.enqueue({ ...request(), alias: 'other' }), /not actively polling/u);
      await assert.rejects(f.store.enqueue({ ...request(), appId: 'unauthorized-app' }), /not authorized/u);
      assert.equal(f.store.listControlWakeStatus().length, 0);
    } finally { f.close(); }
  });

  it('persists a single creation intent across errors/restart until an observed binding is explicitly saved', () => {
    const f = fixture();
    let restarted: ChatGptGatewayStore | undefined;
    try {
      f.registry.create({ id: 'newchat', label: 'New chat', publicModelIds: ['newchat'], allowedAppIds: [], declaredModel: 'Operator declaration' });
      const operationId = f.store.claimControlCreation('newchat');
      assert.match(operationId, /^create_/u);
      assert.throws(() => f.store.claimControlCreation('newchat'), /personal_chat_creation_pending/u);
      f.gateway.close();
      restarted = new ChatGptGatewayStore(f.config);
      restarted.configureControl({ enabled: true }, () => true);
      assert.throws(() => restarted!.claimControlCreation('newchat'), /personal_chat_creation_pending/u);
      restarted.saveControlBinding('newchat', { ...f.bindingInput, chatgptConversationUrl: otherTarget,
        expectedMcpResource: 'https://gemr.example.test/mcp/chatgpt/newchat', expectedConnectorLabel: 'New isolated connector' });
      assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM control_creation').get()?.count, 0);
      assert.throws(() => restarted!.claimControlCreation('newchat'), /personal_chat_already_bound/u);
      assert.ok(restarted.authenticateAccessToken(f.tokens.accessToken, 'trade', f.binding.expectedMcpResource, 'mcp:tools'));
      assert.equal(restarted.listGrants('trade').length, 1);
    } finally { restarted?.close(); f.close(); }
  });
});
