/** Experimental, operator-authorized personal ChatGPT UI transport.
 * No ChatGPT HTTP endpoints, cookies, screenshots, transcripts or general-purpose
 * browser operations are exposed to the controller. A verified UI profile is a
 * prerequisite, not evidence that the account or connector has been verified.
 */
import { mkdir, lstat, chmod, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { BrowserContext, Locator, Page } from 'playwright-core';
import { canonicalPersonalChatUrl as parsePersonalChatUrl } from './types.js';

const descriptorSchema = z.object({
  role: z.enum(['button', 'textbox', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'region', 'article', 'group', 'status', 'heading']),
  name: z.string().min(1).max(240),
  state: z.object({ attribute: z.enum(['aria-selected', 'aria-pressed', 'aria-checked']), value: z.literal('true') }).strict().optional(),
}).strict();

export const browserUiProfileSchema = z.object({
  version: z.literal(1),
  operatorObservedAt: z.string().datetime(),
  accountIdentity: descriptorSchema,
  personalMode: descriptorSchema,
  selectedConnector: descriptorSchema,
  composer: descriptorSchema,
  send: descriptorSchema,
  stop: descriptorSchema,
  userMessage: descriptorSchema,
  tools: z.object({ gateway_open: descriptorSchema, gateway_exchange: descriptorSchema, gateway_status: descriptorSchema }).strict(),
  connectorResourceLink: descriptorSchema.optional(),
  toolInventoryOpen: descriptorSchema.optional(),
  toolInventoryClose: descriptorSchema.optional(),
  writeApprovalIndicator: descriptorSchema.optional(),
  statusResult: descriptorSchema.optional(),
  newChat: descriptorSchema.optional(),
  selectConnectorPath: z.array(descriptorSchema).min(1).max(4).optional(),
}).strict().superRefine((profile, ctx) => {
  if (!profile.accountIdentity.name.includes('{account}')) ctx.addIssue({ code: 'custom', message: 'accountIdentity must match the exact expected {account}.' });
  if (!profile.selectedConnector.name.includes('{connector}')) ctx.addIssue({ code: 'custom', message: 'selectedConnector must match the expected {connector}.' });
  if (!profile.personalMode.state) ctx.addIssue({ code: 'custom', message: 'personalMode requires positive selected/pressed accessibility state, not a navigation label.' });
  if (profile.writeApprovalIndicator && !profile.writeApprovalIndicator.state) ctx.addIssue({ code: 'custom', message: 'Write approval requires an observed positive accessibility state.' });
  if (Boolean(profile.toolInventoryOpen) !== Boolean(profile.toolInventoryClose)) ctx.addIssue({ code: 'custom', message: 'Inventory open and close controls must be configured together.' });
});

export type BrowserUiProfile = z.infer<typeof browserUiProfileSchema>;
type UiDescriptor = z.infer<typeof descriptorSchema>;
const TOOL_NAMES = ['gateway_open', 'gateway_exchange', 'gateway_status'] as const;

export interface BrowserTargetBinding {
  workerId: string;
  chatgptConversationUrl: string;
  expectedAccountLabel: string;
  expectedConnectorLabel: string;
  expectedMcpResource: string;
  /** This declaration is not promoted to observed UI resource identity. */
  operatorResourceConfirmed: boolean;
}

export interface BrowserTargetEvidence {
  transport: 'browser';
  chatgptConversationUrl: string;
  chatgptConversationId: string;
  observedAccountLabel: string;
  observedConnectorLabel: string;
  connectorIdentityObserved: string | null;
  resourceIdentityEvidence: 'ui_observed' | 'operator_declared';
  observedTools: string[];
  writeApprovalObserved: boolean;
  targetVerifiedAt: string;
  toolSetVerifiedAt: string | null;
  /** This is UI observation only, never inference or polling confirmation. */
  evidenceSource: 'accessible_ui';
}

export interface BrowserWakeOperation {
  operationId: string;
  marker: string;
  prompt: string;
  deadlineAt: number;
  diagnostic?: boolean;
}

export interface BrowserOperationOptions {
  signal?: AbortSignal;
  /** Caller rechecks the CURRENT binding, grant, generation, stop and deadline. */
  preSend?: () => void | Promise<void>;
  onDeliveryAttempt?: () => void | Promise<void>;
}

export interface BrowserDeliveryEvidence extends BrowserTargetEvidence {
  outcome: 'wake_delivered_observed';
  operationId: string;
  markerRecovered: boolean;
  statusWorkerId?: string;
}

export interface BrowserCreateRequest extends Omit<BrowserTargetBinding, 'chatgptConversationUrl'>, BrowserWakeOperation {
  /** Only a separate worker and separately paired connector may reach this call. */
  explicitAdminRequest: true;
}

export class BrowserControlError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'BrowserControlError'; }
}

export function canonicalPersonalChatUrl(input: string): { url: string; id: string } {
  try { return parsePersonalChatUrl(input); } catch { throw new BrowserControlError('target_invalid'); }
}

interface BrowserBridgeOptions {
  profileDirectory: string;
  executablePath: string;
  uiProfile?: BrowserUiProfile;
  operationTimeoutMs?: number;
  /** Application data/repository/backup roots, forbidden for private UI storage. */
  excludedDirectories?: string[];
  /** Dependency injection for isolated tests. Never accepted from an HTTP body. */
  launchContext?: () => Promise<BrowserContext>;
}

export class BrowserUiBridge {
  private context?: BrowserContext;
  private page?: Page;
  private active = false;
  private closed = false;
  private profile?: BrowserUiProfile;
  private readonly attempted = new Set<string>();
  private readonly timeoutMs: number;

  constructor(private readonly options: BrowserBridgeOptions) {
    this.profile = options.uiProfile ? browserUiProfileSchema.parse(options.uiProfile) : undefined;
    this.timeoutMs = Math.min(60_000, Math.max(100, options.operationTimeoutMs ?? 20_000));
  }

  get launched(): boolean { return Boolean(this.context && this.page && !this.page.isClosed()); }
  get uiProfileConfigured(): boolean { return Boolean(this.profile); }

  /** Explicit local operator calibration; keep the authenticated browser/profile
   * alive. Never accepted as model arguments or inferred from test fixtures. */
  configureObservedProfile(profile: BrowserUiProfile): void {
    if (this.active || this.closed) throw new BrowserControlError('browser_busy');
    this.profile = browserUiProfileSchema.parse(profile);
  }

  /** The ONLY launch path. Called by an explicit administrator login action.
   * Login/consent/MFA remain manual in the visible window on the controller host.
   */
  async launchLogin(options: Pick<BrowserOperationOptions, 'signal'> = {}): Promise<{ state: 'operator_login_required'; transport: 'browser' }> {
    return this.run(async (signal) => {
      if (!this.context) {
        if (!this.options.launchContext && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new BrowserControlError('graphical_session_required');
        await this.preparePrivateProfile();
        const context = this.options.launchContext ? await this.options.launchContext() : await (await import('playwright-core')).chromium.launchPersistentContext(this.options.profileDirectory, {
          executablePath: this.options.executablePath,
          headless: false,
          chromiumSandbox: true,
          acceptDownloads: false,
          timeout: this.timeoutMs,
        });
        if (signal.aborted || this.closed) { await context.close(); throw new BrowserControlError('control_cancelled'); }
        this.context = context;
        context.setDefaultTimeout(this.timeoutMs);
        this.page = context.pages()[0] ?? await context.newPage();
        context.on('close', () => { if (this.context === context) { this.context = undefined; this.page = undefined; } });
        // No remote-debugging port or websocket server: Playwright's local pipe only.
        await this.page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      }
      return { state: 'operator_login_required', transport: 'browser' };
    }, options.signal);
  }

  async inspectConfiguredTarget(binding: BrowserTargetBinding, options: Pick<BrowserOperationOptions, 'signal'> = {}): Promise<BrowserTargetEvidence> {
    return this.run(async (signal) => {
      const page = this.requirePage();
      this.validateBinding(binding);
      this.guard(signal);
      // Passive inspection may navigate, but never types in a different chat.
      if (!this.isTarget(page, binding)) {
        await this.assertNoDraftOrGeneration(page, binding, true);
        await page.goto(canonicalPersonalChatUrl(binding.chatgptConversationUrl).url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      }
      return this.inspectCurrent(page, binding, false, signal);
    }, options.signal);
  }

  async ensureConfiguredMcp(binding: BrowserTargetBinding, options: Pick<BrowserOperationOptions, 'signal'> = {}): Promise<BrowserTargetEvidence> {
    return this.run(async (signal) => {
      const page = this.requirePage();
      this.validateBinding(binding);
      return this.inspectCurrent(page, binding, true, signal);
    }, options.signal);
  }

  async sendBoundedWake(binding: BrowserTargetBinding, operation: BrowserWakeOperation, options: BrowserOperationOptions = {}): Promise<BrowserDeliveryEvidence> {
    return this.run<BrowserDeliveryEvidence>(async (signal) => {
      const page = this.requirePage();
      this.validateBinding(binding);
      this.validateOperation(operation);
      // Deliberately DO NOT navigate here: a page moved since inspection fences
      // this operation, including any draft the operator may now be composing.
      const evidence = await this.inspectCurrent(page, binding, true, signal);
      if (!operation.diagnostic && !evidence.writeApprovalObserved) throw new BrowserControlError('tool_approval_required');
      const profile = this.requireProfile();
      const messages = this.locator(page, profile.userMessage, binding).filter({ hasText: operation.marker });
      if (await messages.count() > 0) {
        if (operation.diagnostic) throw new BrowserControlError('diagnostic_reverification_required');
        return { ...evidence, operationId: operation.operationId, outcome: 'wake_delivered_observed', markerRecovered: true };
      }
      if (this.attempted.has(operation.operationId)) throw new BrowserControlError('delivery_ambiguous');
      const statusBaseline = operation.diagnostic ? await this.statusResultCount(page, binding) : 0;
      await this.typeAndSend(page, binding, operation, options, signal, () => this.assertTarget(page, binding));
      await this.waitUntil(async () => { this.assertTarget(page, binding); return await messages.count() > 0; }, operation.deadlineAt, signal, 'delivery_ambiguous');
      const statusWorkerId = operation.diagnostic ? await this.readNewStatusWorker(page, binding, statusBaseline, operation.deadlineAt, signal) : undefined;
      return { ...evidence, operationId: operation.operationId, outcome: 'wake_delivered_observed', markerRecovered: false, ...(statusWorkerId ? { statusWorkerId } : {}) };
    }, options.signal, operation.deadlineAt).catch((error: unknown) => {
      if (this.attempted.has(operation.operationId) && error instanceof BrowserControlError && ['control_timeout', 'control_cancelled', 'browser_operation_failed', 'target_moved'].includes(error.code)) throw new BrowserControlError('delivery_ambiguous');
      throw error;
    });
  }

  async createPersonalChat(request: BrowserCreateRequest, options: BrowserOperationOptions = {}): Promise<BrowserDeliveryEvidence> {
    return this.run<BrowserDeliveryEvidence>(async (signal) => {
      if (request.explicitAdminRequest !== true) throw new BrowserControlError('admin_confirmation_required');
      this.validateOperation(request);
      this.validateBinding({ ...request, chatgptConversationUrl: 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000001' });
      if (this.attempted.has(request.operationId)) throw new BrowserControlError('delivery_ambiguous');
      const page = this.requirePage();
      const profile = this.requireProfile();
      if (!profile.newChat || !profile.selectConnectorPath) throw new BrowserControlError('new_chat_ui_profile_required');
      const binding = { ...request, chatgptConversationUrl: page.url() };
      this.assertChatHost(page);
      await this.verifyAccountAndSurface(page, binding);
      await this.assertNoDraftOrGeneration(page, binding);
      const previousUrl = page.url();
      this.guard(signal, request.deadlineAt);
      await options.preSend?.();
      await (await this.one(page, profile.newChat, binding)).click({ timeout: this.remaining(request.deadlineAt) });
      await this.waitUntil(async () => this.isNewChatDraft(page), request.deadlineAt, signal, 'new_chat_not_open');
      const assertDraftTarget = () => { if (!this.isNewChatDraft(page)) throw new BrowserControlError('target_moved'); };
      for (const descriptor of profile.selectConnectorPath) {
        this.guard(signal, request.deadlineAt);
        assertDraftTarget();
        await this.verifyAccountAndSurface(page, binding);
        await (await this.one(page, descriptor, binding)).click({ timeout: this.remaining(request.deadlineAt) });
      }
      await this.verifyConnectorAndTools(page, binding, true, signal);
      await this.typeAndSend(page, binding, request, options, signal, assertDraftTarget);
      await this.waitUntil(async () => {
        try { return canonicalPersonalChatUrl(page.url()).url !== previousUrl; } catch { return false; }
      }, request.deadlineAt, signal, 'delivery_ambiguous');
      // The observed persisted URL, never an invented UUID or a Codex thread ID.
      const observedBinding = { ...binding, chatgptConversationUrl: canonicalPersonalChatUrl(page.url()).url };
      const evidence = await this.inspectCurrent(page, observedBinding, true, signal);
      const messages = this.locator(page, profile.userMessage, observedBinding).filter({ hasText: request.marker });
      await this.waitUntil(async () => { this.assertTarget(page, observedBinding); return await messages.count() > 0; }, request.deadlineAt, signal, 'delivery_ambiguous');
      return { ...evidence, operationId: request.operationId, outcome: 'wake_delivered_observed', markerRecovered: false };
    }, options.signal, request.deadlineAt).catch((error: unknown) => {
      if (this.attempted.has(request.operationId) && error instanceof BrowserControlError && ['control_timeout', 'control_cancelled', 'browser_operation_failed', 'target_moved'].includes(error.code)) throw new BrowserControlError('delivery_ambiguous');
      throw error;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.attempted.clear();
    await context?.close();
  }

  private async preparePrivateProfile(): Promise<void> {
    const directory = this.options.profileDirectory;
    if (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root || directory === process.env.HOME || directory === process.cwd()) throw new BrowserControlError('private_profile_invalid');
    for (const excluded of [path.join(homedir(), '.codex'), ...(this.options.excludedDirectories ?? [])]) {
      const relative = path.relative(path.resolve(excluded), path.resolve(directory));
      if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new BrowserControlError('private_profile_invalid');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new BrowserControlError('private_profile_invalid');
    if (await realpath(directory) !== path.resolve(directory)) throw new BrowserControlError('private_profile_invalid');
    await chmod(directory, 0o700);
  }

  private async inspectCurrent(page: Page, binding: BrowserTargetBinding, checkTools: boolean, signal: AbortSignal): Promise<BrowserTargetEvidence> {
    this.guard(signal);
    this.assertTarget(page, binding);
    await this.verifyAccountAndSurface(page, binding);
    const connector = await this.verifyConnectorAndTools(page, binding, checkTools, signal);
    this.assertTarget(page, binding);
    const target = canonicalPersonalChatUrl(page.url());
    return {
      transport: 'browser', chatgptConversationUrl: target.url, chatgptConversationId: target.id,
      observedAccountLabel: binding.expectedAccountLabel, observedConnectorLabel: binding.expectedConnectorLabel,
      ...connector, targetVerifiedAt: new Date().toISOString(), toolSetVerifiedAt: checkTools ? new Date().toISOString() : null,
      evidenceSource: 'accessible_ui',
    };
  }

  private async verifyAccountAndSurface(page: Page, binding: BrowserTargetBinding): Promise<void> {
    this.assertChatHost(page);
    const profile = this.requireProfile();
    await this.one(page, profile.accountIdentity, binding, 'browser_account_mismatch');
    await this.one(page, profile.personalMode, binding, 'personal_chat_mode_required');
  }

  private async verifyConnectorAndTools(page: Page, binding: BrowserTargetBinding, checkTools: boolean, signal: AbortSignal): Promise<Pick<BrowserTargetEvidence, 'connectorIdentityObserved' | 'resourceIdentityEvidence' | 'observedTools' | 'writeApprovalObserved'>> {
    const profile = this.requireProfile();
    await this.one(page, profile.selectedConnector, binding, 'connector_mismatch');
    let identity: string | null = null;
    if (profile.connectorResourceLink) {
      const resource = await this.one(page, profile.connectorResourceLink, binding, 'connector_resource_unavailable');
      const href = await resource.getAttribute('href');
      if (href !== binding.expectedMcpResource) throw new BrowserControlError('connector_resource_mismatch');
      identity = href;
    } else if (!binding.operatorResourceConfirmed) throw new BrowserControlError('connector_resource_confirmation_required');
    const observedTools: string[] = [];
    let writeApprovalObserved = false;
    if (checkTools) {
      if (profile.toolInventoryOpen) {
        this.guard(signal);
        await (await this.one(page, profile.toolInventoryOpen, binding)).click({ timeout: this.timeoutMs });
      }
      try {
        for (const name of TOOL_NAMES) {
          const tool = await this.one(page, profile.tools[name], binding, 'required_tools_missing');
          if (!await tool.isEnabled()) throw new BrowserControlError('tool_approval_required');
          observedTools.push(name);
        }
        if (profile.writeApprovalIndicator) {
          try {
            await this.one(page, profile.writeApprovalIndicator, binding, 'tool_approval_required');
            writeApprovalObserved = true;
          } catch (error) {
            if (!(error instanceof BrowserControlError) || error.code !== 'tool_approval_required') throw error;
          }
        }
      } finally {
        if (profile.toolInventoryClose) {
          this.guard(signal);
          await (await this.one(page, profile.toolInventoryClose, binding)).click({ timeout: this.timeoutMs });
        }
      }
    }
    return { connectorIdentityObserved: identity, resourceIdentityEvidence: identity ? 'ui_observed' : 'operator_declared', observedTools, writeApprovalObserved };
  }

  private async typeAndSend(page: Page, binding: BrowserTargetBinding, operation: BrowserWakeOperation, options: BrowserOperationOptions, signal: AbortSignal, assertTarget: () => void): Promise<void> {
    const profile = this.requireProfile();
    this.guard(signal, operation.deadlineAt);
    assertTarget();
    await this.verifyAccountAndSurface(page, binding);
    await this.one(page, profile.selectedConnector, binding, 'connector_mismatch');
    await this.assertNoDraftOrGeneration(page, binding);
    const composer = await this.one(page, profile.composer, binding);
    await composer.fill(operation.prompt, { timeout: this.remaining(operation.deadlineAt) });
    let deliveryAttempted = false;
    try {
      // Revalidate after fill and all asynchronous controller callbacks. Never
      // overwrite an operator edit or click Send in a newly selected target.
      await options.preSend?.();
      this.guard(signal, operation.deadlineAt);
      assertTarget();
      await this.verifyAccountAndSurface(page, binding);
      const checked = await this.verifyConnectorAndTools(page, binding, true, signal);
      if (!operation.diagnostic && !checked.writeApprovalObserved) throw new BrowserControlError('tool_approval_required');
      if (await this.composerText(composer) !== operation.prompt) throw new BrowserControlError('composer_changed');
      if (await this.hasVisible(page, profile.stop, binding)) throw new BrowserControlError('chat_busy');
      const send = await this.one(page, profile.send, binding);
      if (!await send.isEnabled()) throw new BrowserControlError('send_unavailable');
      await options.onDeliveryAttempt?.();
      this.guard(signal, operation.deadlineAt);
      assertTarget();
      await this.verifyAccountAndSurface(page, binding);
      const latest = await this.verifyConnectorAndTools(page, binding, true, signal);
      if (!operation.diagnostic && !latest.writeApprovalObserved) throw new BrowserControlError('tool_approval_required');
      this.guard(signal, operation.deadlineAt);
      assertTarget();
      if (await this.composerText(composer) !== operation.prompt) throw new BrowserControlError('composer_changed');
      if (await this.hasVisible(page, profile.stop, binding)) throw new BrowserControlError('chat_busy');
      // Recheck durable cancellation/version/deadline after the final UI reads,
      // immediately before the first non-reversible action.
      await options.preSend?.();
      this.guard(signal, operation.deadlineAt);
      assertTarget();
      this.attempted.add(operation.operationId);
      if (this.attempted.size > 256) this.attempted.delete(this.attempted.values().next().value!);
      deliveryAttempted = true;
      await send.click({ timeout: this.remaining(operation.deadlineAt), noWaitAfter: true });
    } catch (error) {
      if (deliveryAttempted) throw new BrowserControlError('delivery_ambiguous');
      // Remove ONLY our own unsent draft in the same target. Never erase user text.
      try { assertTarget(); if (await this.composerText(composer) === operation.prompt) await composer.fill('', { timeout: 500 }); } catch { /* Target or user draft changed: leave untouched. */ }
      throw error;
    }
  }

  private async assertNoDraftOrGeneration(page: Page, binding: BrowserTargetBinding, allowMissingComposer = false): Promise<void> {
    const profile = this.requireProfile();
    if (await this.hasVisible(page, profile.stop, binding)) throw new BrowserControlError('chat_busy');
    const composer = this.locator(page, profile.composer, binding);
    if (allowMissingComposer && await composer.count() === 0) return;
    const unique = await this.one(page, profile.composer, binding);
    if (await this.composerText(unique)) throw new BrowserControlError('composer_not_empty');
  }

  private async composerText(composer: Locator): Promise<string> {
    // inputValue for inputs; innerText for an accessible contenteditable textbox.
    // Reads only the composer, never conversation history or application state.
    try { return await composer.inputValue({ timeout: 250 }); } catch { return await composer.innerText({ timeout: 250 }); }
  }

  private async statusResultCount(page: Page, binding: BrowserTargetBinding): Promise<number> {
    const descriptor = this.requireProfile().statusResult;
    if (!descriptor) throw new BrowserControlError('diagnostic_ui_profile_required');
    return this.locator(page, descriptor, binding).count();
  }

  private async readNewStatusWorker(page: Page, binding: BrowserTargetBinding, baseline: number, deadlineAt: number, signal: AbortSignal): Promise<string> {
    const descriptor = this.requireProfile().statusResult!;
    let worker: string | undefined;
    await this.waitUntil(async () => {
      this.assertTarget(page, binding);
      const results = this.locator(page, descriptor, binding);
      if (await results.count() <= baseline) return false;
      const latest = results.nth(baseline);
      if (!await latest.isVisible()) return false;
      // Deliberately scoped to a newly-added gateway_status tool result. A normal
      // assistant message, even one claiming success, is never inspected here.
      const text = await latest.innerText({ timeout: 500 });
      if (text.length > 8192) throw new BrowserControlError('diagnostic_result_invalid');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return false; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BrowserControlError('diagnostic_result_invalid');
      const result = parsed as Record<string, unknown>;
      if (result.protocol_version !== '1.0' || typeof result.workerId !== 'string') throw new BrowserControlError('diagnostic_result_invalid');
      if (result.workerId !== binding.workerId) throw new BrowserControlError('diagnostic_worker_mismatch');
      worker = result.workerId;
      return true;
    }, deadlineAt, signal, 'diagnostic_result_unavailable');
    return worker!;
  }

  private validateBinding(binding: BrowserTargetBinding): void {
    canonicalPersonalChatUrl(binding.chatgptConversationUrl);
    for (const value of [binding.workerId, binding.expectedAccountLabel, binding.expectedConnectorLabel]) {
      if (!value || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) throw new BrowserControlError('binding_invalid');
    }
    let resource: URL;
    try { resource = new URL(binding.expectedMcpResource); } catch { throw new BrowserControlError('binding_invalid'); }
    if (!['https:', 'http:'].includes(resource.protocol) || resource.username || resource.password || resource.search || resource.hash) throw new BrowserControlError('binding_invalid');
  }

  private validateOperation(operation: BrowserWakeOperation): void {
    if (!/^[a-z0-9_-]{8,128}$/iu.test(operation.operationId) || operation.marker.length < 8 || operation.marker.length > 200 || /[\u0000-\u001f\u007f]/u.test(operation.marker) || operation.prompt.length > 12000 || !operation.prompt.includes(operation.marker) || !Number.isFinite(operation.deadlineAt)) throw new BrowserControlError('wake_operation_invalid');
  }

  private locator(page: Page, descriptor: UiDescriptor, binding: BrowserTargetBinding): Locator {
    const name = descriptor.name.replaceAll('{account}', binding.expectedAccountLabel).replaceAll('{connector}', binding.expectedConnectorLabel).replaceAll('{mcpResource}', binding.expectedMcpResource);
    return page.getByRole(descriptor.role, { name, exact: true });
  }

  private async one(page: Page, descriptor: UiDescriptor, binding: BrowserTargetBinding, missingCode = 'ui_control_missing'): Promise<Locator> {
    const locator = this.locator(page, descriptor, binding);
    const count = await locator.count();
    if (count === 0) throw new BrowserControlError(missingCode);
    if (count !== 1) throw new BrowserControlError('ui_control_ambiguous');
    if (!await locator.isVisible()) throw new BrowserControlError(missingCode);
    if (descriptor.state && await locator.getAttribute(descriptor.state.attribute) !== descriptor.state.value) throw new BrowserControlError(missingCode);
    return locator;
  }

  private async hasVisible(page: Page, descriptor: UiDescriptor, binding: BrowserTargetBinding): Promise<boolean> {
    const elements = this.locator(page, descriptor, binding);
    const count = await elements.count();
    if (count > 8) throw new BrowserControlError('ui_control_ambiguous');
    for (let index = 0; index < count; index++) if (await elements.nth(index).isVisible()) return true;
    return false;
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed() || !this.context) throw new BrowserControlError('browser_not_started');
    return this.page;
  }
  private requireProfile(): BrowserUiProfile {
    if (!this.profile) throw new BrowserControlError('ui_profile_required');
    return this.profile;
  }
  private assertChatHost(page: Page): void {
    const parsed = new URL(page.url());
    if (parsed.origin !== 'https://chatgpt.com' || parsed.username || parsed.password) throw new BrowserControlError('browser_authentication_required');
  }
  private isNewChatDraft(page: Page): boolean { return page.url() === 'https://chatgpt.com/'; }
  private isTarget(page: Page, binding: BrowserTargetBinding): boolean {
    try { return canonicalPersonalChatUrl(page.url()).url === canonicalPersonalChatUrl(binding.chatgptConversationUrl).url; } catch { return false; }
  }
  private assertTarget(page: Page, binding: BrowserTargetBinding): void {
    if (!this.isTarget(page, binding)) throw new BrowserControlError('target_moved');
  }
  private remaining(deadlineAt: number): number { return Math.max(1, Math.min(this.timeoutMs, deadlineAt - Date.now())); }
  private guard(signal: AbortSignal, deadlineAt?: number): void {
    if (signal.aborted || this.closed) throw new BrowserControlError('control_cancelled');
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new BrowserControlError('control_timeout');
  }
  private async waitUntil(check: () => Promise<boolean>, deadlineAt: number, signal: AbortSignal, timeoutCode: string): Promise<void> {
    while (true) {
      this.guard(signal);
      if (await check()) return;
      if (Date.now() >= deadlineAt) throw new BrowserControlError(timeoutCode);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadlineAt - Date.now()))));
    }
  }

  private async run<T>(operation: (signal: AbortSignal) => Promise<T>, external?: AbortSignal, deadlineAt?: number): Promise<T> {
    if (this.closed) throw new BrowserControlError('control_closed');
    if (this.active) throw new BrowserControlError('browser_busy');
    if (external?.aborted) throw new BrowserControlError('control_cancelled');
    if (deadlineAt !== undefined && deadlineAt <= Date.now()) throw new BrowserControlError('control_timeout');
    this.active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closing: Promise<void> | undefined;
    let rejectCancellation: (reason: Error) => void = () => {};
    const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const abort = (code: string) => {
      controller.abort();
      // Closing only the dedicated UI context also terminates Playwright's
      // outstanding locator action; no delayed click may escape cancellation.
      const context = this.context;
      this.context = undefined;
      this.page = undefined;
      closing = context?.close().catch(() => {});
      rejectCancellation(new BrowserControlError(code));
    };
    const onAbort = () => abort('control_cancelled');
    external?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => abort('control_timeout'), Math.max(1, Math.min(this.timeoutMs, deadlineAt === undefined ? this.timeoutMs : deadlineAt - Date.now())));
    try {
      return await Promise.race([operation(controller.signal), cancellation]);
    } catch (error) {
      if (error instanceof BrowserControlError) throw error;
      // Playwright errors can include DOM text and URLs. Do not propagate them.
      throw new BrowserControlError('browser_operation_failed');
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
      await closing;
      this.active = false;
    }
  }
}
