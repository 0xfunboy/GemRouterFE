import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/** Contract inspected with generate-json-schema --experimental; upgrades require review. */
export const CODEX_CONTROL_RUNTIME_VERSION = '0.154.0-alpha.6.2';
const MAX_LINE_BYTES = 1024 * 1024;
const LOGIN_LIFETIME_MS = 5 * 60_000;

export class CodexRuntimeError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'CodexRuntimeError'; }
}

export interface CodexRuntimeOptions {
  enabled: boolean;
  command: string;
  profileDirectory: string;
  requestedModel: string;
  reasoningEffort?: string;
  rpcTimeoutMs?: number;
  turnTimeoutMs?: number;
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

export interface CodexControlTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface CodexControlResult {
  codexControllerThreadId: string;
  model: string;
  toolInvocations: number;
  /** Controller completion is never an inference completion or proof of web delivery. */
  controllerTurnCompleted: true;
}

type Json = Record<string, any>;
type PendingRpc = { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Login = { owner: string; loginId: string | null; state: CodexLoginState; timer?: NodeJS.Timeout };
type ActiveTurn = {
  threadId: string;
  turnId?: string;
  tool: CodexControlTool;
  signal: AbortSignal;
  invocations: number;
  lastCallId?: string;
  lastArguments?: string;
  toolResult?: Promise<Json>;
  resolve: () => void;
  reject: (e: Error) => void;
};

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
  private active: ActiveTurn | null = null;
  private busy = false;
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
      modelAvailable: false, reasonCode: options.enabled ? 'controller_not_started' : 'controller_disabled',
    };
  }

  get readyCached(): boolean {
    return this.options.enabled && !this.closed && this.login?.state.status !== 'pending'
      && this.state.running && this.state.authenticated && this.state.modelAvailable;
  }

  cachedStatus(): CodexAccountState { return { ...this.state }; }

  /** Call from an explicit authenticated admin inspection, never background admission. */
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

  async models(): Promise<CodexModel[]> {
    await this.ensureStarted();
    let cursor: string | null = null;
    const result: CodexModel[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const response = await this.rpc('model/list', { cursor, limit: 100, includeHidden: false });
      if (!Array.isArray(response.data)) throw new CodexRuntimeError('controller_invalid_catalog');
      for (const row of response.data) {
        if (typeof row.model !== 'string' || typeof row.id !== 'string' || row.hidden === true) continue;
        result.push({ id: row.id, model: row.model, displayName: cleanText(row.displayName, 160) ?? row.model,
          supportedReasoningEfforts: Array.isArray(row.supportedReasoningEfforts)
            ? row.supportedReasoningEfforts.map((entry: Json) => entry.reasoningEffort).filter((effort: unknown) => typeof effort === 'string') : [] });
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
      if (!cursor) break;
      if (seen.has(cursor) || page === 9) throw new CodexRuntimeError('controller_invalid_catalog');
      seen.add(cursor);
    }
    this.modelCatalog = result;
    this.state.modelAvailable = Boolean(this.selectedModel());
    this.state.reasonCode = this.state.authenticated
      ? (this.state.modelAvailable ? null : 'controller_requested_model_unavailable') : 'controller_auth_required';
    return result.map((entry) => ({ ...entry, supportedReasoningEfforts: [...entry.supportedReasoningEfforts] }));
  }

  async startLogin(adminSessionId: string, mode: 'device' | 'browser' = 'device'): Promise<CodexLoginState> {
    if (!adminSessionId || adminSessionId.length > 256) throw new CodexRuntimeError('controller_admin_session_required');
    if (mode !== 'device' && mode !== 'browser') throw new CodexRuntimeError('controller_login_mode_invalid');
    await this.ensureStarted();
    if (this.busy) throw new CodexRuntimeError('controller_busy');
    if (this.login?.state.status === 'pending') throw new CodexRuntimeError('controller_login_in_progress');
    const login: Login = { owner: adminSessionId, loginId: null,
      state: { status: 'pending', mode, expiresAt: this.now() + LOGIN_LIFETIME_MS } };
    this.login = login;
    this.state.authenticated = false;
    this.state.modelAvailable = false;
    try {
      const result = await this.rpc('account/login/start', { type: mode === 'device' ? 'chatgptDeviceCode' : 'chatgpt' });
      if (typeof result.loginId !== 'string') throw new CodexRuntimeError('controller_invalid_login_response');
      login.loginId = result.loginId;
      if (mode === 'device' && result.type === 'chatgptDeviceCode') {
        login.state.verificationUrl = officialLoginUrl(result.verificationUrl);
        login.state.userCode = cleanText(result.userCode, 128) ?? undefined;
        if (!login.state.userCode) throw new CodexRuntimeError('controller_invalid_login_response');
      } else if (mode === 'browser' && result.type === 'chatgpt') {
        login.state.authUrl = officialLoginUrl(result.authUrl);
        login.state.callbackHostNotice = 'Complete this login on the Codex controller host: its loopback callback is not the dashboard device. Prefer device code for a remote server.';
      } else throw new CodexRuntimeError('controller_invalid_login_response');
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
    if (!login || login.owner !== adminSessionId) throw new CodexRuntimeError('controller_login_not_owned');
    this.clearLoginSecret(login, 'cancelled');
    if (login.loginId && this.child) await this.rpc('account/login/cancel', { loginId: login.loginId });
  }

  async logout(): Promise<void> {
    if (!this.options.enabled) return;
    await this.ensureStarted();
    if (this.busy) throw new CodexRuntimeError('controller_busy');
    if (this.login) {
      this.clearLoginSecret(this.login, 'cancelled');
      if (this.login.loginId) await this.rpc('account/login/cancel', { loginId: this.login.loginId }).catch(() => undefined);
    }
    await this.rpc('account/logout', {});
    this.modelCatalog = [];
    this.state = { ...this.state, authenticated: false, accountType: null, email: null, planType: null,
      modelAvailable: false, reasonCode: 'controller_auth_required' };
  }

  async runControl(instruction: string, tool: CodexControlTool, signal: AbortSignal): Promise<CodexControlResult> {
    if (signal.aborted) throw new CodexRuntimeError('controller_cancelled');
    if (this.busy) throw new CodexRuntimeError('controller_busy');
    if (this.login?.state.status === 'pending') throw new CodexRuntimeError('controller_login_in_progress');
    if (!instruction || instruction.length > 16_384 || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
      throw new CodexRuntimeError('controller_invalid_instruction');
    }
    this.busy = true;
    const abort = new AbortController();
    const forwardAbort = () => abort.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    const stopAbortedOperation = () => this.stopProcess(signal.aborted ? 'controller_cancelled' : 'controller_timeout');
    abort.signal.addEventListener('abort', stopAbortedOperation, { once: true });
    const deadline = setTimeout(() => abort.abort(), Math.min(this.options.turnTimeoutMs ?? 90_000, 120_000));
    let threadId: string | undefined;
    try {
      await this.ensureStarted();
      if (abort.signal.aborted) throw new CodexRuntimeError(signal.aborted ? 'controller_cancelled' : 'controller_timeout');
      await this.readAccount();
      if (!this.state.authenticated) throw new CodexRuntimeError('controller_auth_required');
      await this.models();
      const model = this.selectedModel();
      if (!model) throw new CodexRuntimeError('controller_requested_model_unavailable');
      if (abort.signal.aborted) throw new CodexRuntimeError('controller_cancelled');
      const response = await this.rpc('thread/start', {
        model: model.model, allowProviderModelFallback: false, ephemeral: true,
        cwd: join(this.options.profileDirectory, 'controller-cwd'),
        environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [],
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only',
        baseInstructions: 'You are a bounded GemRouter controller, not an inference worker. Call only the supplied control tool once with its prescribed arguments, then finish. Do not access files, shell, browser tools, other apps or other chats. Tool failure means stop. Never claim web delivery based on your own narrative.',
        developerInstructions: 'The tool closure, not model text, is authoritative. Do not request additional permissions or execute job content.',
        dynamicTools: [{ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema }],
        config: restrictedConfig(),
      });
      threadId = typeof response.thread?.id === 'string' ? response.thread.id : undefined;
      if (!threadId || response.model !== model.model || response.approvalPolicy !== 'never'
        || response.sandbox?.type !== 'readOnly' || (response.instructionSources?.length ?? 0) !== 0) {
        throw new CodexRuntimeError('controller_restrictions_unverified');
      }
      let complete!: () => void;
      let fail!: (e: Error) => void;
      const done = new Promise<void>((resolveDone, rejectDone) => { complete = resolveDone; fail = rejectDone; });
      // Attach immediately: a notification can precede the turn/start RPC response.
      void done.catch(() => undefined);
      const active: ActiveTurn = { threadId, tool, signal: abort.signal, invocations: 0, resolve: complete, reject: fail };
      this.active = active;
      const abortTurn = () => fail(new CodexRuntimeError(signal.aborted ? 'controller_cancelled' : 'controller_timeout'));
      abort.signal.addEventListener('abort', abortTurn, { once: true });
      try {
        if (abort.signal.aborted) abortTurn();
        const started = await this.rpc('turn/start', { threadId, model: model.model,
          effort: this.options.reasoningEffort ?? 'high', environments: [], runtimeWorkspaceRoots: [],
          input: [{ type: 'text', text: instruction, text_elements: [] }] });
        if (active.turnId && started.turn?.id !== active.turnId) throw new CodexRuntimeError('controller_turn_mismatch');
        active.turnId = typeof started.turn?.id === 'string' ? started.turn.id : active.turnId;
        await done;
        if (active.toolResult) await untilAborted(active.toolResult, abort.signal);
        return { codexControllerThreadId: threadId, model: model.model,
          toolInvocations: active.invocations, controllerTurnCompleted: true };
      } finally {
        abort.signal.removeEventListener('abort', abortTurn);
      }
    } catch (error) {
      if (threadId && this.child) {
        void this.rpc('turn/interrupt', { threadId, turnId: this.active?.turnId ?? '' }).catch(() => undefined);
      }
      // No ambiguous/late controller tool delivery may survive a failed control operation.
      abort.abort();
      this.stopProcess('controller_operation_stopped');
      throw new CodexRuntimeError(safeCode(error));
    } finally {
      abort.signal.removeEventListener('abort', stopAbortedOperation);
      abort.abort();
      clearTimeout(deadline);
      signal.removeEventListener('abort', forwardAbort);
      this.active = null;
      this.busy = false;
      // Ephemeral threads need unloading to bound app-server's memory over time.
      if (threadId && this.child) await this.rpc('thread/unsubscribe', { threadId }).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.login) this.clearLoginSecret(this.login, 'cancelled');
    const child = this.child;
    this.versionChild?.kill('SIGKILL');
    this.stopProcess('controller_closed');
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 1_000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
  }

  private selectedModel(): CodexModel | undefined {
    // The exact requested ID must also actually be an Astra catalog entry. No marketing-name guessing.
    return this.modelCatalog.find((model) => model.model === this.options.requestedModel
      && /astra/i.test(`${model.model} ${model.displayName}`)
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
      this.state.reasonCode = account ? 'controller_chatgpt_login_required' : 'controller_auth_required';
    }
  }

  private async ensureStarted(): Promise<void> {
    if (!this.options.enabled) throw new CodexRuntimeError('controller_disabled');
    if (this.closed) throw new CodexRuntimeError('controller_closed');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.start().catch((error) => { this.stopProcess(safeCode(error)); throw error; })
      .finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<void> {
    await validatePrivateProfile(this.options.profileDirectory, this.options.excludedDirectories ?? [process.cwd()]);
    const cwd = join(this.options.profileDirectory, 'controller-cwd');
    await validatePrivateProfile(cwd, []);
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
      // This is the official child-process profile selector, never a parent env mutation.
      CODEX_HOME: this.options.profileDirectory,
    };
    this.resolvedCommand ??= await resolveRuntimeExecutable(this.options.command);
    const version = await this.version(env, cwd);
    if (this.closed) throw new CodexRuntimeError('controller_closed');
    if (version !== CODEX_CONTROL_RUNTIME_VERSION) throw new CodexRuntimeError('controller_runtime_version_unsupported');
    this.state.runtimeVersion = version;
    const args = ['app-server', '--listen', 'stdio://'];
    for (const [key, value] of Object.entries(restrictedConfig())) args.push('-c', `${key}=${JSON.stringify(value)}`);
    const child = this.launch(this.resolvedCommand, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', () => undefined); // Drain, never forward runtime logs or credentials.
    child.stdin.on('error', () => this.stopProcess('controller_unreachable'));
    child.on('error', () => this.stopProcess('controller_unreachable'));
    child.on('exit', () => { if (this.child === child) this.stopProcess('controller_disconnected'); });
    const initialized = await this.rpc('initialize', {
      clientInfo: { name: 'gemrouter_personal_chat_control', title: 'GemRouter bounded chat controller', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    if (initialized.codexHome !== this.options.profileDirectory) throw new CodexRuntimeError('controller_profile_mismatch');
    this.send({ method: 'initialized' });
    const effective = await this.rpc('config/read', { includeLayers: false });
    const config = effective.config;
    if (!config || config.forced_login_method !== 'chatgpt' || config.cli_auth_credentials_store !== 'file'
      || config.web_search !== 'disabled' || config.apps?._default?.enabled !== false
      || Object.keys(config.mcp_servers ?? {}).length || Object.keys(config.plugins ?? {}).length
      || Object.entries(config.apps ?? {}).some(([name, app]) => name !== '_default' && (app as Json)?.enabled !== false)
      || Object.entries(restrictedConfig()).some(([key, value]) => key.startsWith('features.') && config.features?.[key.slice(9)] !== value)) {
      throw new CodexRuntimeError('controller_restrictions_unverified');
    }
    this.state.running = true;
    this.state.reasonCode = 'controller_auth_required';
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
          if (!match) reject(new CodexRuntimeError('controller_runtime_version_unsupported'));
          else resolveVersion(match[1]);
        }
      };
      const timer = setTimeout(() => finish(new CodexRuntimeError('controller_timeout')), this.options.rpcTimeoutMs ?? 15_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 256) finish(new CodexRuntimeError('controller_invalid_response')); });
      child.stderr.on('data', () => undefined);
      child.on('error', () => finish(new CodexRuntimeError('controller_unreachable')));
      child.on('exit', (code) => finish(code === 0 ? undefined : new CodexRuntimeError('controller_unreachable')));
      child.stdin.end();
    });
  }

  private rpc(method: string, params: Json): Promise<Json> {
    if (!this.child) return Promise.reject(new CodexRuntimeError('controller_unreachable'));
    const id = this.nextId++;
    return new Promise((resolveRpc, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRuntimeError('controller_timeout'));
      }, this.options.rpcTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve: resolveRpc, reject, timer });
      try { this.send({ id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new CodexRuntimeError('controller_unreachable')); }
    });
  }

  private send(message: Json): void {
    if (!this.child?.stdin.writable) throw new CodexRuntimeError('controller_unreachable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_LINE_BYTES) { this.stopProcess('controller_response_too_large'); return; }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Json;
      try { message = JSON.parse(line); }
      catch { this.stopProcess('controller_invalid_response'); return; }
      if (!message || typeof message !== 'object') { this.stopProcess('controller_invalid_response'); return; }
      if ('id' in message && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new CodexRuntimeError('controller_rpc_failed'));
        else pending.resolve(message.result ?? {});
      } else if ('id' in message) {
        void this.handleServerRequest(message).catch(() => this.stopProcess('controller_tool_failed'));
      } else this.notification(message);
    }
  }

  private notification(message: Json): void {
    const params = message.params ?? {};
    if (message.method === 'account/login/completed' && this.login && params.loginId === this.login.loginId) {
      const expired = this.now() >= this.login.state.expiresAt || this.login.state.status !== 'pending';
      if (!expired) this.clearLoginSecret(this.login, params.success === true ? 'completed' : 'failed',
        params.success === true ? undefined : 'controller_login_failed');
    }
    if (message.method === 'account/updated') {
      this.state.authenticated = false; this.state.modelAvailable = false;
      this.state.reasonCode = 'controller_account_recheck_required';
    }
    const active = this.active;
    if (!active || params.threadId !== active.threadId) return;
    if (message.method === 'turn/started' && typeof params.turn?.id === 'string') active.turnId = params.turn.id;
    if (message.method === 'turn/completed') {
      if (active.turnId && params.turn?.id !== active.turnId) return;
      if (params.turn?.status === 'completed') active.resolve();
      else active.reject(new CodexRuntimeError('controller_turn_failed'));
    }
  }

  private async handleServerRequest(message: Json): Promise<void> {
    const active = this.active;
    const params = message.params ?? {};
    if (message.method !== 'item/tool/call' || !active || active.signal.aborted || params.threadId !== active.threadId
      || params.tool !== active.tool.name || (params.namespace != null && params.namespace !== '')
      || (active.turnId && params.turnId !== active.turnId) || typeof params.turnId !== 'string' || typeof params.callId !== 'string') {
      this.send({ id: message.id, error: { code: -32601, message: 'Controller capability denied' } });
      active?.reject(new CodexRuntimeError('controller_capability_denied'));
      return;
    }
    const argumentKey = JSON.stringify(params.arguments ?? null);
    if (argumentKey.length > 16_384 || (active.invocations
      && (params.callId !== active.lastCallId || argumentKey !== active.lastArguments))) {
      this.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'One control operation per turn; stop.' }] } });
      active.reject(new CodexRuntimeError('controller_tool_budget_exceeded'));
      return;
    }
    if (!active.toolResult) {
      active.invocations++;
      active.lastCallId = params.callId;
      active.lastArguments = argumentKey;
      active.turnId ??= params.turnId;
      active.toolResult = Promise.resolve().then(() => {
        if (active.signal.aborted) throw new CodexRuntimeError('controller_cancelled');
        return active.tool.execute(params.arguments, active.signal);
      }).then((result) => {
        const text = JSON.stringify(result ?? null);
        if (text.length > 8192) throw new CodexRuntimeError('controller_tool_result_too_large');
        return { success: true, contentItems: [{ type: 'inputText', text }] };
      }).catch(() => ({ success: false, contentItems: [{ type: 'inputText', text: 'Control operation failed; stop. Operator action may be required.' }] }));
    }
    const result = await active.toolResult;
    if (this.active === active && !active.signal.aborted && this.child) this.send({ id: message.id, result });
  }

  private clearLoginSecret(login: Login, status: CodexLoginState['status'], reasonCode?: string): void {
    clearTimeout(login.timer);
    login.state = { status, mode: login.state.mode, expiresAt: login.state.expiresAt, ...(reasonCode ? { reasonCode } : {}) };
  }

  private async expireLogin(login: Login): Promise<void> {
    if (this.login !== login || login.state.status !== 'pending') return;
    this.clearLoginSecret(login, 'expired', 'controller_login_expired');
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
    this.active?.reject(new CodexRuntimeError(reasonCode));
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

export type CodexRuntimeClient = Pick<CodexRuntime, 'readyCached' | 'cachedStatus' | 'status' | 'models'
  | 'startLogin' | 'loginStatus' | 'cancelLogin' | 'logout' | 'runControl' | 'close'>;

function safeCode(error: unknown): string { return error instanceof CodexRuntimeError ? error.code : 'controller_unreachable'; }
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new CodexRuntimeError('controller_cancelled');
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new CodexRuntimeError('controller_cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
function cleanText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function officialLoginUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new CodexRuntimeError('controller_invalid_login_response');
  let url: URL;
  try { url = new URL(value); } catch { throw new CodexRuntimeError('controller_invalid_login_response'); }
  if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname)
    || url.username || url.password || url.port) throw new CodexRuntimeError('controller_invalid_login_response');
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
  if (!/^[a-zA-Z0-9._-]+$/.test(command)) throw new CodexRuntimeError('controller_executable_invalid');
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
  throw new CodexRuntimeError('controller_executable_not_found');
}

async function validatePrivateProfile(directory: string, excluded: string[]): Promise<void> {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory === parse(directory).root
    || directory === homedir() || directory.split(sep).includes('.codex')) throw new CodexRuntimeError('controller_private_profile_required');
  for (const forbidden of [join(homedir(), '.codex'), ...excluded]) {
    const rel = relative(resolve(forbidden), directory);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      throw new CodexRuntimeError('controller_private_profile_required');
    }
  }
  const parts: string[] = [];
  let cursor = directory;
  while (cursor !== dirname(cursor)) { parts.unshift(cursor); cursor = dirname(cursor); }
  for (const part of parts) {
    try {
      const stat = await lstat(part);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CodexRuntimeError('controller_profile_symlink_rejected');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(part, { mode: 0o700 });
    }
  }
  const stat = await lstat(directory);
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || await realpath(directory) !== directory) {
    throw new CodexRuntimeError('controller_profile_permissions_invalid');
  }
}
