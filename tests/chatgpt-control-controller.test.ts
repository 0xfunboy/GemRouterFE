/** Controller integration: simulated Codex/UI, real SQLite and gateway protocol. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BrowserControlError } from '../src/llm/providers/chatgpt/control/browserBridge.js';
import { createControlFixture, deferred, fixtureRequest, CONTROL_FIXTURE_CREATED_TARGET, CONTROL_FIXTURE_TARGET } from './helpers/chatgpt-control-fixture.js';

describe('personal chat controller (Codex/UI explicitly simulated)', () => {
  it('is inert while disabled: snapshot/start/tick never launch runtimes or browser', async () => {
    const f = createControlFixture({ enabled: false });
    try {
      f.controller.start(); await f.controller.tick();
      assert.equal(f.controller.snapshot().ready, false);
      await assert.rejects(f.controller.inspect('trade', 1), /controller_disabled/u);
      assert.equal(f.calls.loginStarts, 0);
      assert.equal(f.calls.instructions.length, 0);
      assert.equal(f.calls.browserInspections, 0);
      assert.equal(f.calls.creates, 0);
    } finally { await f.close(); }
  });

  it('keeps Codex OAuth identity, personal conversation and MCP grant independent', async () => {
    const f = createControlFixture();
    try {
      const original = f.store.listGrants('trade');
      const target = await f.controller.inspect('trade', 1);
      assert.equal(target.chatgptConversationUrl, CONTROL_FIXTURE_TARGET);
      assert.notEqual(target.chatgptConversationId, 'codex-controller-fixture-not-chat-id');
      assert.deepEqual(f.store.listGrants('trade'), original);
      assert.equal(f.store.getControlBinding('trade')!.wakeEnabled, false);
      assert.equal(f.store.getControlBinding('trade')!.targetVerified, false, 'Passive UI inspection alone is not the diagnostic');
      const snapshot = JSON.stringify(f.controller.snapshot());
      assert.equal(snapshot.includes(f.tokens.accessToken), false);
      assert.equal(snapshot.includes(f.tokens.refreshToken), false);
      assert.equal(snapshot.includes(f.grant.id), false);
    } finally { await f.close(); }
  });

  it('rejects a completed Codex narrative without execution of the restricted tool', async () => {
    const f = createControlFixture();
    try {
      f.behavior.runtimeMode = 'narrative_only';
      await assert.rejects(f.controller.send('trade', 1, 'diagnostic'), /controller_no_tool_evidence/u);
      assert.equal(f.calls.sends.length, 0);
      assert.equal(f.store.getControlBinding('trade')!.gatewayStatusVerified, false);
      assert.throws(() => f.controller.arm('trade', 1), /not verified/u);
    } finally { await f.close(); }
  });

  it('preserves safe browser blockers when the runtime converts a tool failure into a result', async () => {
    for (const code of ['browser_account_mismatch', 'required_tools_missing'] as const) {
      const f = createControlFixture();
      try {
        await f.arm();
        const original = f.runtime.runControl;
        f.runtime.runControl = (instruction, tool, signal) => original(instruction, { ...tool,
          // Match the real runtime's handling: the turn can finish after a failed tool.
          execute: async (args, toolSignal) => { try { return await tool.execute(args, toolSignal); } catch { return { success: false }; } },
        }, signal);
        f.browser.ensureConfiguredMcp = async () => { throw new BrowserControlError(code); };
        await assert.rejects(f.controller.inspect('trade', 1), { code });
        assert.equal(f.store.getControlBinding('trade')!.wakeEnabled, false);
        assert.equal(f.store.getControlBinding('trade')!.operatorStopped, true);
        assert.equal(f.calls.sends.length, 0);
      } finally { await f.close(); }
    }
  });

  it('does not expose raw bridge failure details while preserving a local failure through runtime rejection', async () => {
    const f = createControlFixture();
    try {
      const original = f.runtime.runControl;
      f.runtime.runControl = async (instruction, tool, signal) => {
        await original(instruction, { ...tool,
          execute: async (args, toolSignal) => { try { return await tool.execute(args, toolSignal); } catch { return { success: false }; } },
        }, signal);
        throw new Error('controller_turn_failed');
      };
      f.browser.ensureConfiguredMcp = async () => { throw new Error('Private browser text, token and URL must not escape'); };
      await assert.rejects(f.controller.inspect('trade', 1), { code: 'controller_operation_failed', message: 'controller_operation_failed' });
      assert.equal(f.calls.sends.length, 0);
    } finally { await f.close(); }
  });

  it('rejects arbitrary tool arguments and incomplete/wrong diagnostic evidence', async () => {
    const f = createControlFixture();
    try {
      f.behavior.runtimeMode = 'bad_arguments';
      await assert.rejects(f.controller.inspect('trade', 1), /invalid_control_arguments/u);
      assert.equal(f.calls.browserInspections, 0);
      f.behavior.runtimeMode = 'execute';
      f.behavior.evidenceOverride.observedTools = ['gateway_status'];
      await assert.rejects(f.controller.send('trade', 1, 'diagnostic'), /tools_missing/u);
      assert.equal(f.store.getControlBinding('trade')!.toolSetVerified, false);
      f.behavior.evidenceOverride = {};
      f.behavior.diagnosticWorker = 'wrong-worker';
      await assert.rejects(f.controller.send('trade', 1, 'diagnostic'), /status was not observed/u);
      assert.equal(f.store.getControlBinding('trade')!.gatewayStatusVerified, false);
    } finally { await f.close(); }
  });

  it('does not pass job payload, handles, arbitrary URLs or model choices to Codex', async () => {
    const f = createControlFixture();
    try {
      await f.arm();
      const { job } = await f.store.enqueue(fixtureRequest('controller-privacy'));
      await f.controller.tick();
      assert.equal(f.calls.instructions.length, 1);
      assert.doesNotMatch(JSON.stringify(f.calls.instructions), /PRIVATE_JOB_|execute shell|fixture-existing-original-bootstrap|claim_token|6aa91a7a|Example - Trade/u);
      assert.deepEqual(f.calls.toolSchemas.at(-1), { type: 'object', properties: {}, required: [], additionalProperties: false });
      assert.equal(f.calls.sends.length, 1);
      assert.doesNotMatch(f.calls.sends[0].prompt, /PRIVATE_JOB_|controller-privacy|fixture-existing-original-bootstrap/u);
      assert.match(f.calls.sends[0].prompt, /yield_after_completion:true/u);
      assert.equal(f.store.listControlWakeStatus()[0].state, 'wake_delivered_observed');
      assert.equal(f.store.workerStatus('trade').pendingWorkerPolls, 0);
      assert.equal(f.store.workerStatus('trade').queueLength, 1);
    } finally { await f.close(); }
  });

  it('coalesces a burst into one bounded controller turn and does not wake a valid claim', async () => {
    const f = createControlFixture();
    const entered = deferred(); const release = deferred();
    try {
      await f.arm();
      await Promise.all([f.store.enqueue(fixtureRequest('burst-a')), f.store.enqueue(fixtureRequest('burst-b'))]);
      f.behavior.beforeTool = async () => { entered.resolve(); await release.promise; };
      const first = f.controller.tick(); await entered.promise;
      await Promise.all([f.controller.tick(), f.controller.tick()]);
      await assert.rejects(f.controller.inspect('trade', 1), /controller_busy/u);
      release.resolve(); await first;
      assert.equal(f.calls.instructions.length, 1);
      assert.equal(f.calls.sends.length, 1);
      const claim = await f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: f.opened.next_exchange_id });
      assert.equal(claim.state, 'request');
      await f.controller.tick();
      assert.equal(f.calls.sends.length, 1);
    } finally { release.resolve(); await f.close(); }
  });

  it('fences an automatic wake stopped between UI inspection and its final pre-send check', async () => {
    const f = createControlFixture();
    try {
      await f.arm();
      const { job } = await f.store.enqueue(fixtureRequest('stop-race'));
      f.behavior.beforeSend = () => { f.controller.stop('trade', 1); };
      await f.controller.tick();
      assert.equal(f.calls.sends.length, 0);
      assert.equal(f.store.getControlBinding('trade')!.operatorStopped, true);
      const terminal = await f.store.waitForJob(job.requestId);
      assert.equal(terminal.status, 'failed');
      assert.equal(terminal.errorCode, 'chatgpt_control_stopped');
      assert.equal(f.calls.creates, 0);
    } finally { await f.close(); }
  });

  it('fences an explicit resume stopped while the controller is reaching its pre-send check', async () => {
    const f = createControlFixture();
    try {
      f.behavior.beforeSend = () => { f.controller.stop('trade', 1); };
      await assert.rejects(f.controller.send('trade', 1, 'resume'), /operator_stopped|binding_changed/u);
      assert.equal(f.calls.sends.length, 0);
    } finally { await f.close(); }
  });

  it('does not create/bootstrap a replacement chat on controller failure or released run', async () => {
    const f = createControlFixture();
    try {
      await f.arm();
      await f.store.enqueue(fixtureRequest('no-fallback'));
      f.behavior.runtimeMode = 'narrative_only';
      await f.controller.tick();
      assert.equal(f.calls.sends.length, 0);
      assert.equal(f.calls.creates, 0);
      assert.equal(f.store.getWorker('trade')!.runGeneration, 1);
      f.store.releaseWorker('trade');
      await assert.rejects(f.controller.send('trade', 1, 'resume'), /bootstrap_required|operator_stopped/u);
      assert.equal(f.calls.creates, 0);
      assert.equal(f.store.listGrants('trade').filter((grant) => !grant.revokedAt).length, 1);
    } finally { await f.close(); }
  });

  it('accepts inference only from gateway_exchange completion, never UI/Codex success', async () => {
    const f = createControlFixture();
    try {
      await f.arm();
      let resolved = false;
      const inference = f.gateway.submit(fixtureRequest('completion-proof')).then((value) => { resolved = true; return value; });
      await new Promise((resolve) => setImmediate(resolve));
      await f.controller.tick();
      assert.equal(resolved, false);
      const claim = await f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: f.opened.next_exchange_id });
      if (claim.state !== 'request') throw new Error('Expected a real claim.');
      await f.gateway.exchange(f.grant, { run_id: f.opened.run_id, exchange_id: claim.next_exchange_id, yield_after_completion: true,
        completion: { request_id: claim.request.request_id, claim_token: claim.request.claim_token, response: 'MCP_ONLY_323' } });
      const response = await inference;
      assert.equal(response.content, 'MCP_ONLY_323');
      assert.equal(response.alias, 'air3-trade');
      assert.ok(f.store.workerStatus('trade').lastSuccessfulCompletionAt);
      assert.equal(f.calls.creates, 0);
    } finally { await f.close(); }
  });

  it('requires a separate unused worker and preserves the original grant when creating another chat', async () => {
    const f = createControlFixture();
    try {
      const input = { expectedAccountLabel: 'fixture@example.test', expectedConnectorLabel: 'Separate fixture app', operatorResourceConfirmed: true };
      await assert.rejects(f.controller.create('trade', input), /separate_unused_worker_required/u);
      f.registry.create({ id: 'new-worker', label: 'New fixture worker', publicModelIds: ['new-chat-fixture'], allowedAppIds: [], declaredModel: 'Operator-selected model' });
      await assert.rejects(f.controller.create('new-worker', input), /separate_connector_grant_required/u);
      f.pair('new-worker', input.expectedConnectorLabel);
      const original = f.store.listGrants('trade');
      const created = await f.controller.create('new-worker', input);
      assert.equal(created.binding.chatgptConversationUrl, CONTROL_FIXTURE_CREATED_TARGET);
      assert.equal(created.binding.wakeEnabled, false);
      assert.equal(created.binding.toolSetVerified, false);
      assert.deepEqual(f.store.getWorker('new-worker')!.allowedAppIds, []);
      assert.deepEqual(f.store.listGrants('trade'), original);
      assert.equal(f.store.getControlBinding('trade')!.chatgptConversationUrl, CONTROL_FIXTURE_TARGET);
      assert.equal(f.calls.creates, 1);
    } finally { await f.close(); }
  });
});
