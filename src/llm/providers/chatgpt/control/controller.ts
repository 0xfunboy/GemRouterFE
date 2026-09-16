import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatGptGatewayStore } from '../store.js';
import { buildWorkerPrompt } from '../worker-prompt.js';
import { BrowserControlError, BrowserUiBridge, browserUiProfileSchema, type BrowserTargetEvidence } from './browserBridge.js';
import { CodexRuntime, type CodexRuntimeClient } from './codexRuntime.js';
import type { PersonalControlConfig } from './config.js';
import { controlInstruction, diagnosticPrompt, newChatPrompt, resumePrompt } from './prompts.js';
import { publicControlBinding, type ChatGptControlBinding, type ChatGptControlFailureCode, type ChatGptControlWakeOperation } from './types.js';

export type PersonalBrowserClient = Pick<BrowserUiBridge, 'launched' | 'uiProfileConfigured' | 'launchLogin' | 'inspectConfiguredTarget' | 'ensureConfiguredMcp' | 'sendBoundedWake' | 'createPersonalChat' | 'close'>;
export class PersonalControlError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'PersonalControlError'; }
}

/** The controller cannot read jobs, complete claims, mint grants or open gateway runs. */
export class PersonalChatController {
  private timer?: NodeJS.Timeout;
  private active?: { signal: AbortController; done: Promise<unknown> };
  private closed = false;

  constructor(readonly config: PersonalControlConfig, readonly store: ChatGptGatewayStore,
    readonly runtime: CodexRuntimeClient, readonly browser: PersonalBrowserClient,
    private readonly resourceForWorker: (workerId: string) => string) {
    store.configureControl({ enabled: config.enabled, wakeTimeoutMs: config.operationTimeoutMs, maxConcurrentWakes: 1 }, (binding) => this.bindingRuntimeReady(binding));
  }

  start(): void {
    if (!this.config.enabled || this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => { try { this.stopAll(); } catch { /* Shutdown may already have closed storage. */ } }); }, this.config.pollIntervalMs);
    this.timer.unref();
  }

  get ready(): boolean { return this.config.enabled && !this.closed && this.runtime.readyCached && this.browser.launched && this.browser.uiProfileConfigured; }
  private runtimeRef(): string {
    const account = this.runtime.cachedStatus();
    return `codex:${createHash('sha256').update(JSON.stringify([this.config.codexProfile, account.email, account.accountType])).digest('hex')}`;
  }
  private bindingRuntimeReady(binding: ChatGptControlBinding): boolean {
    return this.ready && binding.controlMode === 'browser' && binding.controllerRuntimeRef === this.runtimeRef();
  }

  /** Passive admin view: no process launch, network inference, login code or private grant id. */
  snapshot() {
    const workers = this.store.listWorkers().map((worker) => ({ id: worker.id, label: worker.label,
      mcpResource: this.resourceForWorker(worker.id), ...this.store.workerStatus(worker.id) }));
    const suggestion = this.store.listWorkers().find((worker) => worker.publicModelIds.includes('air3-trade'));
    return {
      enabled: this.config.enabled, ready: this.ready, account: this.runtime.cachedStatus(),
      hostState: this.browser.launched ? 'browser_open' : process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'graphical_session_required' : 'browser_not_open',
      reason: !this.config.enabled ? 'controller_disabled' : !this.browser.uiProfileConfigured ? 'ui_profile_required' : this.runtime.cachedStatus().reasonCode,
      workers, bindings: this.store.listControlBindings().map(publicControlBinding),
      operations: this.store.listControlWakeStatus().map(({ marker: _marker, ...metadata }) => metadata),
      // These are admin-only hints; never pre-bind or fabricate a registry worker.
      suggestedWorkerId: suggestion?.id ?? '',
      suggestedConversationUrl: 'https://chatgpt.com/c/00000000-0000-0000-0000-b40c114d0582',
      suggestedConnectorLabel: 'Example - Trade',
    };
  }

  saveBinding(workerId: string, expectedVersion: number, input: {
    chatgptConversationUrl: string; expectedAccountLabel: string; expectedConnectorLabel: string; operatorResourceConfirmed: boolean;
  }) {
    this.requireEnabled();
    if (!this.runtime.readyCached) throw new PersonalControlError('controller_not_authenticated');
    if ((this.store.getControlBinding(workerId)?.bindingVersion ?? 0) !== expectedVersion) throw new PersonalControlError('binding_changed');
    const result = this.store.saveControlBinding(workerId, { ...input, expectedMcpResource: this.resourceForWorker(workerId),
      controllerRuntimeRef: this.runtimeRef(), browserOrHostRef: `host:${createHash('sha256').update(this.config.browserProfile).digest('hex')}`,
      controlMode: 'browser' });
    return publicControlBinding(result);
  }

  arm(workerId: string, version: number) { this.currentBinding(workerId, version); return publicControlBinding(this.store.setControlWakeEnabled(workerId, true)); }
  stop(workerId: string, version: number) {
    this.currentBinding(workerId, version, false);
    this.store.stopControlWorker(workerId);
    // The periodic operation fence aborts a matching active action, not a different worker.
    return publicControlBinding(this.store.getControlBinding(workerId)!);
  }
  stopAll(): void { for (const binding of this.store.listControlBindings()) this.store.stopControlWorker(binding.workerId); this.active?.signal.abort(); }

  async inspect(workerId: string, version: number) {
    const binding = this.currentBinding(workerId, version);
    return this.exclusive(async (signal) => this.control('inspect', signal, async () => {
      await this.browser.inspectConfiguredTarget(binding, { signal });
      this.assertSnapshot(binding);
      return this.browser.ensureConfiguredMcp(binding, { signal });
    }), () => this.assertSnapshot(binding)).catch((error: unknown) => this.invalidateFailedObservation(binding, error));
  }

  async send(workerId: string, version: number, kind: 'diagnostic' | 'resume' | 'bootstrap') {
    const binding = this.currentBinding(workerId, version);
    const worker = this.store.getWorker(workerId)!;
    if (!worker.enabled || worker.draining) throw new PersonalControlError('worker_not_enabled');
    const status = this.store.workerStatus(workerId);
    const originalRunGeneration = worker.runGeneration;
    if (kind === 'resume' && ['released', 'unpaired'].includes(status.state)) throw new PersonalControlError('bootstrap_required');
    if (status.processingClaim || status.pendingWorkerPolls > 0) throw new PersonalControlError('worker_busy');
    const sequence = binding.statusProbeSequence;
    const id = randomUUID();
    const marker = `[gemrouter-control:${id}]`;
    const deadlineAt = Date.now() + this.config.operationTimeoutMs;
    // Bootstrap is explicit, separate from resume and never releases an existing run.
    const prompt = kind === 'diagnostic' ? diagnosticPrompt(binding, marker)
      : kind === 'resume' ? resumePrompt(binding, marker)
      : `${marker}\n${buildWorkerPrompt(worker, this.store.getControlBootstrapId(workerId, version))}\nBounded activation: process at most one job, send its completion with yield_after_completion:true. Stop on idle or yielded; never poll indefinitely. The optional controller can request another bounded activation later.`;
    return this.exclusive(async (signal) => {
      const evidence = await this.control(kind === 'bootstrap' ? 'resume' : kind, signal, async () => {
        await this.browser.inspectConfiguredTarget(binding, { signal });
        return this.browser.sendBoundedWake(binding, { operationId: id, marker, prompt, deadlineAt, diagnostic: kind === 'diagnostic' }, {
          signal, preSend: () => {
            this.assertSnapshot(binding);
            if (this.store.getWorker(workerId)?.runGeneration !== originalRunGeneration) throw new PersonalControlError('binding_changed');
            if (kind === 'bootstrap') this.store.getControlBootstrapId(workerId, version);
            if (Date.now() >= deadlineAt) throw new PersonalControlError('wake_timeout');
          },
        });
      });
      this.assertSnapshot(binding);
      if (kind === 'diagnostic') {
        const after = this.store.getControlBinding(workerId)!;
        this.store.recordControlVerification(workerId, version, {
          observedConversationUrl: evidence.chatgptConversationUrl, observedAccountLabel: evidence.observedAccountLabel,
          observedConnectorLabel: evidence.observedConnectorLabel, connectorIdentityObserved: evidence.connectorIdentityObserved ?? undefined,
          observedTools: evidence.observedTools, writeApprovalObserved: evidence.writeApprovalObserved,
          statusProbeSequenceBefore: sequence, statusProbeSequenceAfter: after.statusProbeSequence,
          observedWorkerId: evidence.statusWorkerId ?? '',
        });
      }
      return { evidence, message: kind === 'diagnostic' ? 'Diagnostica UI e status MCP correlati. Non è una prova di completion.' : 'Messaggio osservato nella chat. Poll e completion restano prove separate rilevate dal gateway.' };
    }, () => this.assertSnapshot(binding)).catch((error: unknown) => this.invalidateFailedObservation(binding, error));
  }

  async create(workerId: string, input: { expectedAccountLabel: string; expectedConnectorLabel: string; operatorResourceConfirmed: boolean }) {
    this.requireReady();
    const worker = this.store.getWorker(workerId);
    // A previously used worker or connector is never repurposed for a new conversation.
    if (!worker || worker.runGeneration !== 0 || this.store.getControlBinding(workerId)
      || worker.publicModelIds.includes('air3-trade') || input.expectedConnectorLabel === 'Example - Trade'
      || this.store.listControlBindings().some((binding) => binding.expectedConnectorLabel === input.expectedConnectorLabel)) throw new PersonalControlError('separate_unused_worker_required');
    const resource = this.resourceForWorker(workerId);
    const grants = this.store.listGrants(workerId).filter((grant) => !grant.revokedAt && grant.resource === resource);
    if (grants.length !== 1 || !input.operatorResourceConfirmed) throw new PersonalControlError('separate_connector_grant_required');
    const originalGrant = grants[0]!.id;
    const assertCurrent = () => {
      if (this.store.getControlBinding(workerId) || this.store.getWorker(workerId)?.runGeneration !== 0
        || !this.store.listGrants(workerId).some((grant) => grant.id === originalGrant && !grant.revokedAt)) throw new PersonalControlError('binding_changed');
    };
    return this.exclusive(async (signal) => {
      // Persist before any UI side effect. A lost/ambiguous response cannot
      // create a second conversation on retry or after process restart.
      const operationId = this.store.claimControlCreation(workerId); const marker = `[gemrouter-control:${operationId}]`;
      const evidence = await this.control('create', signal, () => this.browser.createPersonalChat({
        ...input, workerId, expectedMcpResource: resource, explicitAdminRequest: true,
        operationId, marker, prompt: newChatPrompt(workerId, input.expectedConnectorLabel, marker), deadlineAt: Date.now() + this.config.operationTimeoutMs, diagnostic: true,
      }, { signal, preSend: assertCurrent }));
      assertCurrent();
      const binding = this.saveBinding(workerId, 0, { ...input, chatgptConversationUrl: evidence.chatgptConversationUrl });
      return { evidence, binding, message: 'Nuova chat personale osservata e associata disarmata. Esegui la diagnostica e il bootstrap esplicito per questo worker.' };
    });
  }

  /** One durable wake, one bounded Codex turn, no inference content passed to Codex. */
  async tick(): Promise<void> {
    if (!this.config.enabled || this.closed) return;
    this.store.reconcileControlWakes();
    if (this.active) return;
    const operation = this.store.claimNextControlWake();
    if (!operation) return;
    try { await this.exclusive((signal) => this.executeWake(operation, signal)); }
    catch (error) { this.store.failControlWake(operation.id, failureCode(error), { ambiguous: errorCode(error) === 'delivery_ambiguous', retryable: errorCode(error) === 'controller_busy' }); }
  }

  private async executeWake(operation: ChatGptControlWakeOperation, signal: AbortSignal): Promise<void> {
    const fence = () => { if (signal.aborted) throw new PersonalControlError('operator_stopped'); return this.store.requireCurrentControlWake(operation.id); };
    const watch = setInterval(() => {
      // Successful polling terminalizes the outbox before the controller may
      // finish its UI acknowledgement. Success must not kill a healthy runtime.
      if (this.store.listControlWakeStatus(operation.workerId).find((item) => item.id === operation.id)?.state === 'mcp_poll_observed') return;
      try { fence(); } catch { this.active?.signal.abort(); }
    }, 100);
    watch.unref();
    try {
      await this.control('resume', signal, async () => {
        fence();
        await this.browser.inspectConfiguredTarget(operation.binding, { signal });
        this.store.markControlWake(operation.id, 'target_verified');
        const evidence = await this.browser.sendBoundedWake(operation.binding, { operationId: operation.id, marker: operation.marker,
          prompt: resumePrompt(operation.binding, operation.marker), deadlineAt: operation.deadlineAtMs }, {
          signal, preSend: () => { fence(); }, onDeliveryAttempt: () => { this.store.markControlWake(operation.id, 'wake_delivery_attempted'); },
        });
        // A real poll can beat observation of the sent UI bubble. Do not downgrade that evidence.
        if (this.store.listControlWakeStatus(operation.workerId).find((item) => item.id === operation.id)?.state !== 'mcp_poll_observed') this.store.markControlWake(operation.id, 'wake_delivered_observed');
        return evidence;
      });
    } finally { clearInterval(watch); }
  }

  private async control<T extends BrowserTargetEvidence>(kind: Parameters<typeof controlInstruction>[0], signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    this.requireReady();
    let observed: T | undefined;
    let effect: Promise<T> | undefined;
    let effectFailure: PersonalControlError | undefined;
    try {
      await this.runtime.runControl(controlInstruction(kind), {
        name: 'gemrouter_personal_control', description: 'Execute the single pre-bound personal-chat control operation. No arguments, no arbitrary browser capabilities.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        execute: async (args) => {
          try {
            if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw new PersonalControlError('invalid_control_arguments');
            // Defense in depth: even an unexpected repeated dynamic-tool invocation
            // shares exactly one side effect, including a rejection after an ambiguous send.
            effect ??= Promise.resolve().then(execute);
            observed = await effect;
            return { observed: true, transport: 'browser', evidence: 'accessible_ui', inferenceCompletion: false };
          } catch (error) {
            // App Server intentionally turns tool failures into model-visible safe
            // results. Retain the bounded local reason separately, so onboarding
            // reports the actual account/tool/UI blocker, not missing tool evidence.
            effectFailure ??= new PersonalControlError(error instanceof BrowserControlError || error instanceof PersonalControlError
              ? errorCode(error) : 'controller_operation_failed');
            throw effectFailure;
          }
        },
      }, signal);
    } catch (error) {
      throw effectFailure ?? error;
    }
    if (effectFailure) throw effectFailure;
    if (!observed) throw new PersonalControlError('controller_no_tool_evidence');
    return observed;
  }

  private currentBinding(workerId: string, version: number, requireReady = true): ChatGptControlBinding {
    this.requireEnabled();
    const binding = this.store.getControlBinding(workerId);
    if (!binding || binding.bindingVersion !== version) throw new PersonalControlError('binding_changed');
    if (requireReady && !this.bindingRuntimeReady(binding)) throw new PersonalControlError('controller_not_authenticated');
    if (requireReady && !this.store.listGrants(workerId).some((grant) => !grant.revokedAt && grant.resource === binding.expectedMcpResource
      && (!binding.boundGrantId || grant.id === binding.boundGrantId))) throw new PersonalControlError('grant_revoked');
    return binding;
  }
  private assertSnapshot(binding: ChatGptControlBinding): void {
    const current = this.currentBinding(binding.workerId, binding.bindingVersion);
    if (current.operatorStopGeneration !== binding.operatorStopGeneration) throw new PersonalControlError('operator_stopped');
  }
  private invalidateFailedObservation(binding: ChatGptControlBinding, error: unknown): never {
    const reason = failureCode(error);
    if (['target_mismatch','account_mismatch','connector_mismatch','tools_missing','approval_required','delivery_ambiguous','controller_not_authenticated','browser_not_authenticated','grant_revoked'].includes(reason)
      && this.store.getControlBinding(binding.workerId)?.bindingVersion === binding.bindingVersion) this.store.stopControlWorker(binding.workerId, reason);
    throw error;
  }
  private requireEnabled() { if (!this.config.enabled || this.closed) throw new PersonalControlError('controller_disabled'); }
  private requireReady() {
    this.requireEnabled();
    if (!this.runtime.readyCached) throw new PersonalControlError('controller_not_authenticated');
    if (!this.browser.launched) throw new PersonalControlError('browser_not_authenticated');
    if (!this.browser.uiProfileConfigured) throw new PersonalControlError('ui_profile_required');
  }
  private async exclusive<T>(execute: (signal: AbortSignal) => Promise<T>, fence?: () => void): Promise<T> {
    this.requireEnabled();
    if (this.active) throw new PersonalControlError('controller_busy');
    const signal = new AbortController();
    const timeout = setTimeout(() => signal.abort(), this.config.operationTimeoutMs); timeout.unref();
    const watch = fence ? setInterval(() => { try { fence(); } catch { signal.abort(); } }, 100) : undefined;
    watch?.unref();
    // Install the gate synchronously before executing any browser/runtime task.
    const active = { signal, done: Promise.resolve().then(() => execute(signal.signal)) };
    this.active = active;
    try { return await active.done; } finally { clearTimeout(timeout); if (watch) clearInterval(watch); if (this.active === active) this.active = undefined; }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.stopAll();
    await Promise.allSettled([this.runtime.close(), this.browser.close()]);
    await this.active?.done.catch(() => {});
  }
}

export function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{1,79}$/u.test(code) ? code : 'controller_operation_failed';
}
function failureCode(error: unknown): ChatGptControlFailureCode {
  const code = errorCode(error);
  if (['controller_not_authenticated','browser_not_authenticated','target_mismatch','account_mismatch','connector_mismatch','tools_missing','approval_required','delivery_ambiguous','wake_timeout','binding_changed','operator_stopped','grant_revoked','no_pending_jobs','wake_attempts_exhausted'].includes(code)) return code as ChatGptControlFailureCode;
  if (['target_moved', 'target_invalid', 'personal_chat_mode_required', 'diagnostic_worker_mismatch'].includes(code)) return 'target_mismatch';
  if (code === 'browser_account_mismatch') return 'account_mismatch';
  if (['connector_resource_mismatch', 'connector_resource_unavailable', 'connector_resource_confirmation_required'].includes(code)) return 'connector_mismatch';
  if (code === 'required_tools_missing') return 'tools_missing';
  if (code === 'tool_approval_required') return 'approval_required';
  if (['browser_authentication_required', 'browser_not_started'].includes(code)) return 'browser_not_authenticated';
  if (code === 'controller_auth_required') return 'controller_not_authenticated';
  if (['control_timeout', 'controller_turn_timeout', 'controller_timeout'].includes(code)) return 'wake_timeout';
  return 'controller_unavailable';
}

export function createPersonalChatController(config: PersonalControlConfig, store: ChatGptGatewayStore,
  resourceForWorker: (workerId: string) => string, excludedDirectories: string[]): PersonalChatController {
  // No credentials or files are touched while disabled. The UI profile is operator-owned metadata.
  let uiProfile;
  if (config.enabled && config.uiProfilePath) {
    if (statSync(config.uiProfilePath).size > 32_768) throw new Error('Personal control UI profile is too large.');
    uiProfile = browserUiProfileSchema.parse(JSON.parse(readFileSync(config.uiProfilePath, 'utf8')));
  }
  const excluded = [...excludedDirectories, path.join(os.homedir(), '.codex')];
  const runtime = new CodexRuntime({ enabled: config.enabled, command: config.command, profileDirectory: config.codexProfile,
    requestedModel: config.requestedModel, reasoningEffort: config.reasoningEffort, turnTimeoutMs: config.operationTimeoutMs, excludedDirectories: excluded });
  const browser = new BrowserUiBridge({ profileDirectory: config.browserProfile, executablePath: config.browserExecutable,
    operationTimeoutMs: config.operationTimeoutMs, uiProfile, excludedDirectories: excluded });
  return new PersonalChatController(config, store, runtime, browser, resourceForWorker);
}
