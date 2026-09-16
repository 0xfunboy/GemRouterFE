import { normalizeAccountUsage, normalizeRateLimits, normalizeTokenUsage, type CodexUsageSnapshot, type CodexTokenUsage } from './usage.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/** Contract inspected with generate-json-schema --experimental; upgrades require review. */
export const CODEX_RUNTIME_VERSION = '0.154.0-alpha.6.2';
const MAX_LINE_BYTES = 1024 * 1024;
const LOGIN_LIFETIME_MS = 5 * 60_000;

export class CodexRuntimeError extends Error {
  constructor(public readonly code: string, public readonly usage: CodexTokenUsage | null = null) { super(code); this.name = 'CodexRuntimeError'; }
}

export interface CodexInferenceInput {
  model: string; reasoningEffort: string; system: string; input: string;
  outputSchema?: unknown; signal?: AbortSignal; deadline: number; maxOutputBytes?: number;
}
export interface CodexInferenceResult { content: string; model: string; reasoningEffort: string; usage: CodexTokenUsage | null }
type ActiveInference = {
  threadId: string | null; turnId?: string; model: string; usage: CodexTokenUsage | null;
  messages: Map<string, string>; maxOutputBytes: number;
  resolve(): void; reject(error: Error): void;
};

export interface CodexRuntimeOptions {
  enabled: boolean;
  command: string;
  profileDirectory: string;
  requestedModel: string;
  reasoningEffort?: string;
  rpcTimeoutMs?: number;
  /** Private auth storage must not be in any application/backup tree. */
  excludedDirectories?: string[];
}

export interface CodexAccountState {
  enabled: boolean;
  running: boolean;
  authenticated: boolean;
  accountType: 'chatgpt' | 'unsupported' | null;
  email: string | null;
  planType: string | null;
  runtimeVersion: string | null;
  requestedModel: string;
  modelAvailable: boolean;
  reasonCode: string | null;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts: string[];
}

export interface CodexLoginState {
  status: 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled';
  mode: 'device' | 'browser';
  expiresAt: number;
  verificationUrl?: string;
  userCode?: string;
  authUrl?: string;
  callbackHostNotice?: string;
  reasonCode?: string;
}

type Json = Record<string, any>;
type PendingRpc = { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Login = { owner: string; loginId: string | null; state: CodexLoginState; timer?: NodeJS.Timeout };

/** Official stdio client. No worker OAuth, MCP grants, web cookies or job payloads enter here. */
export class CodexRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private versionChild: ChildProcessWithoutNullStreams | null = null;
  private resolvedCommand: string | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, PendingRpc>();
  private nextId = 1;
  private stdoutBuffer = '';
  private login: Login | null = null;
  private inference: ActiveInference | null = null;
  private generating = false;
  private closed = false;
  private modelCatalog: CodexModel[] = [];
  private state: CodexAccountState;
  private readonly launch: typeof spawn;
  private readonly now: () => number;

  constructor(private readonly options: CodexRuntimeOptions, dependencies: { spawn?: typeof spawn; now?: () => number } = {}) {
    this.launch = dependencies.spawn ?? spawn;
    this.now = dependencies.now ?? Date.now;
    this.state = {
      enabled: options.enabled, running: false, authenticated: false, accountType: null,
      email: null, planType: null, runtimeVersion: null, requestedModel: options.requestedModel,
      modelAvailable: false, reasonCode: options.enabled ? 'codex_not_started' : 'codex_disabled',
    };
  }

  get readyCached(): boolean {
    return this.connectedCached && this.state.modelAvailable;
  }

  get connectedCached(): boolean {
    return this.options.enabled && !this.closed && this.login?.state.status !== 'pending'
      && this.state.running && this.state.authenticated;
  }

  cachedStatus(): CodexAccountState { return { ...this.state }; }

  /** Read-only account and model inspection; does not create a turn. */
  async status(): Promise<CodexAccountState> {
    if (!this.options.enabled) return this.cachedStatus();
    try {
      await this.ensureStarted();
      await this.readAccount();
      if (this.state.authenticated) await this.models();
    } catch (error) {
      this.state.reasonCode = safeCode(error);
    }
    return this.cachedStatus();
  }

  /** Read-only account metrics: no thread/start, turn/start or quota reset. */
  async usage(): Promise<CodexUsageSnapshot> {
    await this.ensureStarted();
    await this.readAccount();
    if (!this.state.authenticated) throw new CodexRuntimeError('codex_auth_required');
    const [usage, quota] = await Promise.allSettled([
      this.rpc('account/usage/read', {}, 8_000), this.rpc('account/rateLimits/read', {}, 8_000),
    ]);
    return { observedAt: new Date(this.now()).toISOString(), scope: 'account',
      usage: usage.status === 'fulfilled' ? normalizeAccountUsage(usage.value) : null,
      usageError: usage.status === 'rejected' ? safeCode(usage.reason) : null,
      quota: quota.status === 'fulfilled' ? normalizeRateLimits(quota.value) : null,
      quotaError: quota.status === 'rejected' ? safeCode(quota.reason) : null,
    };
  }

  async quota() {
    await this.ensureStarted();
    await this.readAccount();
    if (!this.state.authenticated) throw new CodexRuntimeError('codex_auth_required');
    return normalizeRateLimits(await this.rpc('account/rateLimits/read', {}));
  }

  async models(): Promise<CodexModel[]> {
    await this.ensureStarted();
    let cursor: string | null = null;
    const result: CodexModel[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const response = await this.rpc('model/list', { cursor, limit: 100, includeHidden: false });
      if (!Array.isArray(response.data)) throw new CodexRuntimeError('codex_invalid_catalog');
      for (const row of response.data) {
        if (typeof row.model !== 'string' || typeof row.id !== 'string' || row.hidden === true) continue;
        result.push({ id: row.id, model: row.model, displayName: cleanText(row.displayName, 160) ?? row.model,
          supportedReasoningEfforts: Array.isArray(row.supportedReasoningEfforts)
            ? row.supportedReasoningEfforts.map((entry: Json) => entry.reasoningEffort).filter((effort: unknown) => typeof effort === 'string') : [] });
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
      if (!cursor) break;
      if (seen.has(cursor) || page === 9) throw new CodexRuntimeError('codex_invalid_catalog');
      seen.add(cursor);
    }
    this.modelCatalog = result;
    this.state.modelAvailable = Boolean(this.selectedModel());
    this.state.reasonCode = this.state.authenticated
      ? (this.state.modelAvailable ? null : 'codex_requested_model_unavailable') : 'codex_auth_required';
    return result.map((entry) => ({ ...entry, supportedReasoningEfforts: [...entry.supportedReasoningEfforts] }));
  }

  async startLogin(adminSessionId: string, mode: 'device' | 'browser' = 'device'): Promise<CodexLoginState> {
    if (this.generating) throw new CodexRuntimeError('codex_busy');
    if (!adminSessionId || adminSessionId.length > 256) throw new CodexRuntimeError('codex_admin_session_required');
    if (mode !== 'device' && mode !== 'browser') throw new CodexRuntimeError('codex_login_mode_invalid');
    await this.ensureStarted();
    if (this.login?.state.status === 'pending') throw new CodexRuntimeError('codex_login_in_progress');
    const login: Login = { owner: adminSessionId, loginId: null,
      state: { status: 'pending', mode, expiresAt: this.now() + LOGIN_LIFETIME_MS } };
    this.login = login;
    this.state.authenticated = false;
    this.state.modelAvailable = false;
    try {
      const result = await this.rpc('account/login/start', { type: mode === 'device' ? 'chatgptDeviceCode' : 'chatgpt' });
      if (typeof result.loginId !== 'string') throw new CodexRuntimeError('codex_invalid_login_response');
      login.loginId = result.loginId;
      if (mode === 'device' && result.type === 'chatgptDeviceCode') {
        login.state.verificationUrl = officialLoginUrl(result.verificationUrl);
        login.state.userCode = cleanText(result.userCode, 128) ?? undefined;
        if (!login.state.userCode) throw new CodexRuntimeError('codex_invalid_login_response');
      } else if (mode === 'browser' && result.type === 'chatgpt') {
        login.state.authUrl = officialLoginUrl(result.authUrl);
        login.state.callbackHostNotice = 'Complete this login on the Codex runtime host: its loopback callback is not the dashboard device. Prefer device code for a remote server.';
      } else throw new CodexRuntimeError('codex_invalid_login_response');
      login.timer = setTimeout(() => { void this.expireLogin(login); }, LOGIN_LIFETIME_MS);
      login.timer.unref();
      return { ...login.state };
    } catch (error) {
      this.clearLoginSecret(login, 'failed', safeCode(error));
      if (login.loginId) await this.rpc('account/login/cancel', { loginId: login.loginId }).catch(() => undefined);
      throw new CodexRuntimeError(safeCode(error));
    }
  }

  async loginStatus(adminSessionId: string): Promise<CodexLoginState | null> {
    const login = this.login;
    if (!login || login.owner !== adminSessionId) return null;
    if (login.state.status === 'pending' && this.now() >= login.state.expiresAt) await this.expireLogin(login);
    if (login.state.status === 'completed') await this.status();
    return { ...login.state };
  }

  async cancelLogin(adminSessionId: string): Promise<void> {
    const login = this.login;
    if (!login || login.owner !== adminSessionId) throw new CodexRuntimeError('codex_login_not_owned');
    this.clearLoginSecret(login, 'cancelled');
    if (login.loginId && this.child) await this.rpc('account/login/cancel', { loginId: login.loginId });
  }

  async logout(): Promise<void> {
    if (this.generating) throw new CodexRuntimeError('codex_busy');
    if (!this.options.enabled) return;
    await this.ensureStarted();
    if (this.login) {
      this.clearLoginSecret(this.login, 'cancelled');
      if (this.login.loginId) await this.rpc('account/login/cancel', { loginId: this.login.loginId }).catch(() => undefined);
    }
    await this.rpc('account/logout', {});
    this.modelCatalog = [];
    this.state = { ...this.state, authenticated: false, accountType: null, email: null, planType: null,
      modelAvailable: false, reasonCode: 'codex_auth_required' };
  }

  /** One finite, tool-free inference in a fresh thread. No MCP or chat UI. */
  async generate(input: CodexInferenceInput): Promise<CodexInferenceResult> {
    if (this.generating) throw new CodexRuntimeError('codex_busy');
    if (this.login?.state.status === 'pending') throw new CodexRuntimeError('codex_login_in_progress');
    if (input.signal?.aborted) throw new CodexRuntimeError('codex_cancelled');
    if (!Number.isFinite(input.deadline) || input.deadline <= this.now()) throw new CodexRuntimeError('codex_timeout');
    if (!input.input || Buffer.byteLength(input.input) + Buffer.byteLength(input.system) > 524_288
      || (input.outputSchema !== undefined && JSON.stringify(input.outputSchema).length > 65_536)) throw new CodexRuntimeError('codex_invalid_input');
    const maxOutputBytes = input.maxOutputBytes ?? 1_048_576;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4_194_304) throw new CodexRuntimeError('codex_invalid_input');
    this.generating = true;
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    void done.catch(() => undefined);
    const active: ActiveInference = { threadId: null, model: input.model, usage: null, messages: new Map(), maxOutputBytes, resolve, reject };
    this.inference = active;
    const cancel = () => this.stopProcess(input.signal?.aborted ? 'codex_cancelled' : 'codex_timeout');
    const timer = setTimeout(cancel, Math.max(1, Math.min(600_000, input.deadline - this.now())));
    input.signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.ensureStarted();
      await this.readAccount();
      if (!this.state.authenticated) throw new CodexRuntimeError('codex_auth_required');
      if (!this.modelCatalog.length) await this.models();
      const model = this.modelCatalog.find((item) => item.model === input.model);
      if (!model) throw new CodexRuntimeError('codex_model_unavailable');
      if (!model.supportedReasoningEfforts.includes(input.reasoningEffort)) throw new CodexRuntimeError('codex_reasoning_unsupported');
      if (input.signal?.aborted || this.now() >= input.deadline) throw new CodexRuntimeError('codex_cancelled');
      const cwd = join(this.options.profileDirectory, 'account-cwd');
      const opened = await this.rpc('thread/start', {
        model: input.model, allowProviderModelFallback: false, ephemeral: true, cwd,
        environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [], dynamicTools: [],
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only',
        baseInstructions: 'You are a text inference model. Answer the supplied conversation with only its final assistant payload. No coding-agent workflow, tools, shell, files, browsing, apps, delegation, plans or side effects. Do not expose hidden reasoning.',
        developerInstructions: input.system, config: restrictedConfig(),
      });
      if (typeof opened.thread?.id !== 'string' || opened.model !== input.model || opened.approvalPolicy !== 'never'
        || opened.sandbox?.type !== 'readOnly' || opened.cwd !== cwd || (opened.instructionSources?.length ?? 0)
        || (opened.runtimeWorkspaceRoots?.length ?? 0)) throw new CodexRuntimeError('codex_restrictions_unverified');
      active.threadId = opened.thread.id;
      const started = await this.rpc('turn/start', {
        threadId: active.threadId, model: input.model, effort: input.reasoningEffort,
        environments: [], runtimeWorkspaceRoots: [], summary: 'none',
        input: [{ type: 'text', text: input.input, text_elements: [] }],
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      });
      if (typeof started.turn?.id !== 'string' || (active.turnId && active.turnId !== started.turn.id)) throw new CodexRuntimeError('codex_turn_mismatch');
      active.turnId = started.turn.id;
      await done;
      if (input.signal?.aborted || this.now() >= input.deadline) throw new CodexRuntimeError('codex_cancelled');
      const content = [...active.messages.values()].join('\n');
      if (!content.trim()) throw new CodexRuntimeError('codex_empty_response');
      return { content, model: input.model, reasoningEffort: input.reasoningEffort, usage: active.usage };
    } catch (error) {
      const code = safeCode(error);
      // Kill only our dedicated runtime to prevent ambiguous, late tool/turn effects.
      this.stopProcess(code);
      throw new CodexRuntimeError(code, active.usage);
    } finally {
      clearTimeout(timer); input.signal?.removeEventListener('abort', cancel);
      this.inference = null; this.generating = false;
      if (active.threadId && this.child) void this.rpc('thread/unsubscribe', { threadId: active.threadId }).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.login) this.clearLoginSecret(this.login, 'cancelled');
    const child = this.child;
    this.versionChild?.kill('SIGKILL');
    this.stopProcess('codex_closed');
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 1_000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
  }

  private selectedModel(): CodexModel | undefined {
    // Exact catalog ID and requested effort, with no implicit model fallback.
    return this.modelCatalog.find((model) => model.model === this.options.requestedModel
      && model.supportedReasoningEfforts.includes(this.options.reasoningEffort ?? 'high'));
  }

  private async readAccount(): Promise<void> {
    const result = await this.rpc('account/read', { refreshToken: false });
    const account = result.account;
    this.state.authenticated = account?.type === 'chatgpt';
    this.state.accountType = account ? (account.type === 'chatgpt' ? 'chatgpt' : 'unsupported') : null;
    this.state.email = account?.type === 'chatgpt' ? cleanText(account.email, 320) : null;
    this.state.planType = account?.type === 'chatgpt' ? cleanText(account.planType, 64) : null;
    if (!this.state.authenticated) {
      this.state.modelAvailable = false;
      this.state.reasonCode = account ? 'codex_chatgpt_login_required' : 'codex_auth_required';
    }
  }

  private async ensureStarted(): Promise<void> {
    if (!this.options.enabled) throw new CodexRuntimeError('codex_disabled');
    if (this.closed) throw new CodexRuntimeError('codex_closed');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.start().catch((error) => { this.stopProcess(safeCode(error)); throw error; })
      .finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<void> {
    await validatePrivateProfile(this.options.profileDirectory, this.options.excludedDirectories ?? [process.cwd()]);
    const cwd = join(this.options.profileDirectory, 'account-cwd');
    await validatePrivateProfile(cwd, []);
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
      // This is the official child-process profile selector, never a parent env mutation.
      CODEX_HOME: this.options.profileDirectory,
    };
    this.resolvedCommand ??= await resolveRuntimeExecutable(this.options.command);
    const version = await this.version(env, cwd);
    if (this.closed) throw new CodexRuntimeError('codex_closed');
    if (version !== CODEX_RUNTIME_VERSION) throw new CodexRuntimeError('codex_runtime_version_unsupported');
    this.state.runtimeVersion = version;
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(restrictedConfig())) args.push('-c', `${key}=${JSON.stringify(value)}`);
    const child = this.launch(this.resolvedCommand, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', () => undefined); // Drain, never forward runtime logs or credentials.
    child.stdin.on('error', () => this.stopProcess('codex_unreachable'));
    child.on('error', () => this.stopProcess('codex_unreachable'));
    child.on('exit', () => { if (this.child === child) this.stopProcess('codex_disconnected'); });
    const initialized = await this.rpc('initialize', {
      clientInfo: { name: 'gemrouter_codex_account', title: 'GemRouter Codex account diagnostics', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    if (initialized.codexHome !== this.options.profileDirectory) throw new CodexRuntimeError('codex_profile_mismatch');
    this.send({ method: 'initialized' });
    const effective = await this.rpc('config/read', { includeLayers: false });
    const config = effective.config;
    if (!config || config.forced_login_method !== 'chatgpt' || config.cli_auth_credentials_store !== 'file'
      || config.web_search !== 'disabled' || config.apps?._default?.enabled !== false
      || Object.keys(config.mcp_servers ?? {}).length || Object.keys(config.plugins ?? {}).length
      || Object.entries(config.apps ?? {}).some(([name, app]) => name !== '_default' && (app as Json)?.enabled !== false)
      || Object.entries(restrictedConfig()).some(([key, value]) => key.startsWith('features.') && config.features?.[key.slice(9)] !== value)) {
      throw new CodexRuntimeError('codex_restrictions_unverified');
    }
    this.state.running = true;
    this.state.reasonCode = 'codex_auth_required';
  }

  private version(env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
    return new Promise((resolveVersion, reject) => {
      const child = this.launch(this.resolvedCommand!, ['--version'], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      this.versionChild = child;
      let output = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (this.versionChild === child) this.versionChild = null;
        clearTimeout(timer);
        child.kill();
        if (error) reject(error);
        else {
          const match = /^codex-cli ([a-zA-Z0-9.+-]+)\s*$/.exec(output);
          if (!match) reject(new CodexRuntimeError('codex_runtime_version_unsupported'));
          else resolveVersion(match[1]);
        }
      };
      const timer = setTimeout(() => finish(new CodexRuntimeError('codex_timeout')), this.options.rpcTimeoutMs ?? 15_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 256) finish(new CodexRuntimeError('codex_invalid_response')); });
      child.stderr.on('data', () => undefined);
      child.on('error', () => finish(new CodexRuntimeError('codex_unreachable')));
      child.on('exit', (code) => finish(code === 0 ? undefined : new CodexRuntimeError('codex_unreachable')));
      child.stdin.end();
    });
  }

  private rpc(method: string, params: Json, timeoutMs = this.options.rpcTimeoutMs ?? 15_000): Promise<Json> {
    if (!this.child) return Promise.reject(new CodexRuntimeError('codex_unreachable'));
    const id = this.nextId++;
    return new Promise((resolveRpc, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRuntimeError('codex_timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRpc, reject, timer });
      try { this.send({ id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new CodexRuntimeError('codex_unreachable')); }
    });
  }

  private send(message: Json): void {
    if (!this.child?.stdin.writable) throw new CodexRuntimeError('codex_unreachable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES) { this.stopProcess('codex_response_too_large'); return; }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Json;
      try { message = JSON.parse(line); }
      catch { this.stopProcess('codex_invalid_response'); return; }
      if (!message || typeof message !== 'object') { this.stopProcess('codex_invalid_response'); return; }
      if ('id' in message && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new CodexRuntimeError(message.error.code === -32601 ? 'codex_method_unsupported'
          : codexFailureCode(message.error.data?.codexErrorInfo)));
        else pending.resolve(message.result ?? {});
      } else if ('id' in message) {
        void this.handleServerRequest(message).catch(() => this.stopProcess('codex_tool_failed'));
      } else this.notification(message);
    }
  }

  private notification(message: Json): void {
    const params = message.params ?? {};
    if (message.method === 'account/login/completed' && this.login && params.loginId === this.login.loginId) {
      const expired = this.now() >= this.login.state.expiresAt || this.login.state.status !== 'pending';
      if (!expired) this.clearLoginSecret(this.login, params.success === true ? 'completed' : 'failed',
        params.success === true ? undefined : 'codex_login_failed');
    }
    if (message.method === 'account/updated') {
      this.state.authenticated = false; this.state.modelAvailable = false;
      this.state.reasonCode = 'codex_account_recheck_required';
    }
    const active = this.inference;
    if (!active || !active.threadId || params.threadId !== active.threadId) return;
    if (active.turnId && params.turnId && active.turnId !== params.turnId) return;
    if (message.method === 'turn/started') active.turnId = params.turn?.id;
    if (message.method === 'thread/tokenUsage/updated') {
      if (typeof params.turnId !== 'string') return;
      active.turnId ??= params.turnId;
      const usage = normalizeTokenUsage(params.tokenUsage?.total);
      if (active.usage?.totalTokens == null || (usage.totalTokens != null && usage.totalTokens >= active.usage.totalTokens)) active.usage = usage;
    }
    if (message.method === 'model/rerouted' && params.toModel !== active.model) {
      active.reject(new CodexRuntimeError('codex_model_mismatch')); return;
    }
    if (['item/started', 'item/completed'].includes(message.method) && params.item) {
      if (!['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(params.item.type)) {
        active.reject(new CodexRuntimeError('codex_capability_denied')); return;
      }
      if (message.method === 'item/completed') this.collectInferenceMessage(active, params.item);
    }
    if (message.method === 'turn/completed') {
      if (active.turnId && params.turn?.id !== active.turnId) return;
      active.turnId ??= params.turn?.id;
      if (params.turn?.status !== 'completed') active.reject(new CodexRuntimeError(codexFailureCode(params.turn?.error?.codexErrorInfo)));
      else {
        for (const item of params.turn.items ?? []) this.collectInferenceMessage(active, item);
        active.resolve();
      }
    }
  }

  private collectInferenceMessage(active: ActiveInference, item: Json): void {
    if (item.type !== 'agentMessage' || (item.phase != null && item.phase !== 'final_answer')) return;
    if (typeof item.id !== 'string' || typeof item.text !== 'string') return;
    active.messages.set(item.id, item.text);
    if (active.messages.size > 256 || [...active.messages.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0) > active.maxOutputBytes) {
      active.reject(new CodexRuntimeError('codex_response_too_large'));
    }
  }

  private async handleServerRequest(message: Json): Promise<void> {
    this.send({ id: message.id, error: { code: -32601, message: 'Inference-only runtime: capability denied' } });
    this.inference?.reject(new CodexRuntimeError('codex_capability_denied'));
  }

  private clearLoginSecret(login: Login, status: CodexLoginState['status'], reasonCode?: string): void {
    clearTimeout(login.timer);
    login.state = { status, mode: login.state.mode, expiresAt: login.state.expiresAt, ...(reasonCode ? { reasonCode } : {}) };
  }

  private async expireLogin(login: Login): Promise<void> {
    if (this.login !== login || login.state.status !== 'pending') return;
    this.clearLoginSecret(login, 'expired', 'codex_login_expired');
    if (login.loginId && this.child) await this.rpc('account/login/cancel', { loginId: login.loginId }).catch(() => undefined);
  }

  private stopProcess(reasonCode: string): void {
    const child = this.child;
    this.child = null;
    this.state.running = false;
    this.state.authenticated = false;
    this.state.modelAvailable = false;
    this.state.reasonCode = reasonCode;
    this.stdoutBuffer = '';
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CodexRuntimeError(reasonCode)); }
    this.pending.clear();
    this.inference?.reject(new CodexRuntimeError(reasonCode));
    if (this.login?.state.status === 'pending') this.clearLoginSecret(this.login, 'failed', reasonCode);
    child?.stdin.destroy();
    child?.kill('SIGTERM');
    if (child && child.exitCode === null) {
      const reap = setTimeout(() => child.kill('SIGKILL'), 1_000);
      reap.unref();
      child.once('exit', () => clearTimeout(reap));
    }
  }
}

export type CodexRuntimeClient = Pick<CodexRuntime, 'readyCached' | 'cachedStatus' | 'status' | 'models' | 'usage'
  | 'startLogin' | 'loginStatus' | 'cancelLogin' | 'logout' | 'close'>;

function codexFailureCode(info: unknown): string {
  if (info === 'usageLimitExceeded') return 'codex_quota_depleted';
  if (info === 'rateLimitExceeded') return 'codex_rate_limited';
  if (info === 'unauthorized') return 'codex_auth_required';
  if (info === 'contextWindowExceeded') return 'codex_context_exceeded';
  if (info === 'badRequest') return 'codex_invalid_input';
  return 'codex_inference_failed';
}

function safeCode(error: unknown): string { return error instanceof CodexRuntimeError ? error.code : 'codex_unreachable'; }
function cleanText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function officialLoginUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new CodexRuntimeError('codex_invalid_login_response');
  let url: URL;
  try { url = new URL(value); } catch { throw new CodexRuntimeError('codex_invalid_login_response'); }
  if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname)
    || url.username || url.password || url.port) throw new CodexRuntimeError('codex_invalid_login_response');
  return url.href;
}

function restrictedConfig(): Record<string, unknown> {
  return {
    cli_auth_credentials_store: 'file', forced_login_method: 'chatgpt', approval_policy: 'never',
    sandbox_mode: 'read-only', web_search: 'disabled', 'analytics.enabled': false,
    'agents.enabled': false, 'apps._default.enabled': false,
    'features.shell_tool': false, 'features.apply_patch_freeform': false,
    'features.unified_exec': false, 'features.js_repl': false, 'features.code_mode': false,
    'features.computer_use': false, 'features.browser_use': false, 'features.connectors': false,
    'features.multi_agent_v2': false, 'features.collab': false,
    'features.codex_hooks': false, 'features.skip_host_skill_discovery': true,
    'features.skill_search': false, 'features.skill_mcp_dependency_install': false,
    'features.shell_snapshot': false, 'features.shell_snapshot_v2': false,
    'features.view_image': false, 'features.image_generation': false,
    'features.memory_tool': false, 'features.sleep_tool': false,
    'features.remote_plugin': false, 'features.remote_control': false,
    'features.tool_suggest': false, 'features.auth_elicitation': false,
  };
}

async function resolveRuntimeExecutable(command: string): Promise<string> {
  if (isAbsolute(command)) return command;
  if (!/^[a-zA-Z0-9._-]+$/.test(command)) throw new CodexRuntimeError('codex_executable_invalid');
  // Read the operator's executable search path once, never pass it or secret env to Codex.
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = await realpath(join(directory, command));
      if (!(await lstat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next absolute directory; never run a shell resolver. */ }
  }
  throw new CodexRuntimeError('codex_executable_not_found');
}

export async function validatePrivateProfile(directory: string, excluded: string[]): Promise<void> {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory === parse(directory).root
    || directory === homedir() || directory.split(sep).includes('.codex')) throw new CodexRuntimeError('codex_private_profile_required');
  for (const forbidden of [join(homedir(), '.codex'), ...excluded]) {
    const rel = relative(resolve(forbidden), directory);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      throw new CodexRuntimeError('codex_private_profile_required');
    }
  }
  const parts: string[] = [];
  let cursor = directory;
  while (cursor !== dirname(cursor)) { parts.unshift(cursor); cursor = dirname(cursor); }
  for (const part of parts) {
    try {
      const stat = await lstat(part);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CodexRuntimeError('codex_profile_symlink_rejected');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(part, { mode: 0o700 });
    }
  }
  const stat = await lstat(directory);
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || await realpath(directory) !== directory) {
    throw new CodexRuntimeError('codex_profile_permissions_invalid');
  }
}
