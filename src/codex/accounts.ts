import { closeSync, constants, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../llm/types.js';
import { LLMProviderError } from '../llm/errors.js';
import { CodexRuntime, CodexRuntimeError, validatePrivateProfile, type CodexAccountState, type CodexRuntimeOptions } from './runtime.js';
import { CodexProvider } from './provider.js';
import { CodexMetrics } from './metrics.js';
import type { CodexConfig } from './config.js';
import type { CodexUsageSnapshot, QuotaWindow } from './usage.js';

const ids = ['account-1', 'account-2'] as const;
type AccountId = typeof ids[number];
const registrySchema = z.object({ version: z.literal(1), selected: z.enum(ids),
  accounts: z.array(z.enum(ids)).min(1).max(2),
}).strict().refine((r) => r.accounts[0] === 'account-1' && new Set(r.accounts).size === r.accounts.length && r.accounts.includes(r.selected));
type Registry = z.infer<typeof registrySchema>;
type UsageRead = { status: 'idle' | 'pending' | 'completed' | 'failed'; result: CodexUsageSnapshot | null; error: string | null };
type Entry = { id: AccountId; runtime: CodexRuntime; provider: CodexProvider; usage: UsageRead; usageEpoch: number; managing: boolean };

/** Only an alias crosses the HTTP boundary; the email stays inside the runtime. */
export function safeAccount(state: CodexAccountState, id = 'account-1') {
  const { email: _email, ...safe } = state;
  const initials = (state.email?.split('@')[0].toUpperCase().match(/[BCDFGHJKLMNPQRSTVWXYZ]/g) ?? []).slice(0, 2).join('');
  return { ...safe, id, alias: `Account ${id === 'account-2' ? 2 : 1}${initials ? ` ${initials}` : ''}` };
}

/** Two independent official runtimes. Selection never copies or swaps credential files. */
export class CodexAccounts implements LLMClient {
  readonly provider = 'codex'; readonly model = 'account-selected';
  private registry: Registry = { version: 1, selected: 'account-1', accounts: ['account-1'] };
  private entries = new Map<AccountId, Entry>();
  private initialized = false;
  private maintenance = false;
  private runtimeOverride: Partial<CodexRuntimeOptions> = {};
  private lastRouting: { preferredAccountId: string; accountId: string; fallbackReason: string | null; at: string } | null = null;
  onOutcome: (accountId: string, code: string | null) => void = () => {};
  private readonly file: string;
  constructor(readonly config: CodexConfig, private readonly dataDirectory: string,
    private readonly excluded: string[], private readonly factory = (profileDirectory: string, override: Partial<CodexRuntimeOptions> = {}) => new CodexRuntime({ ...config, ...override, profileDirectory, excludedDirectories: excluded })) {
    this.file = join(config.privateDirectory, 'accounts.json');
    this.create('account-1');
  }
  private create(id: AccountId, retainedMetrics?: CodexMetrics): Entry {
    const runtime = this.factory(id === 'account-1' ? this.config.profileDirectory : join(this.config.privateDirectory, 'codex-account-2'), this.runtimeOverride);
    const metrics = retainedMetrics ?? new CodexMetrics(join(this.dataDirectory, id === 'account-1' ? 'codex-metrics.json' : 'codex-account-2-metrics.json'));
    const entry: Entry = { id, runtime, provider: new CodexProvider(this.config, runtime, metrics),
      usage: { status: 'idle', result: null, error: null }, usageEpoch: 0, managing: false };
    this.entries.set(id, entry); return entry;
  }
  async initialize() {
    if (this.initialized || !this.config.enabled) return;
    await validatePrivateProfile(this.config.privateDirectory, this.excluded);
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw Error();
      const descriptor = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { this.registry = registrySchema.parse(JSON.parse(readFileSync(descriptor, 'utf8'))); }
      finally { closeSync(descriptor); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CodexRuntimeError('codex_accounts_registry_invalid');
      this.persist(this.registry);
    }
    for (const id of this.registry.accounts) if (!this.entries.has(id)) this.create(id);
    this.initialized = true;
  }
  private persist(next: Registry) {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    // Atomic replace; neither the registry nor metrics contain credentials or emails.
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    renameSync(temp, this.file); this.registry = next;
  }
  entry(id?: string): Entry {
    const entry = this.entries.get((id ?? this.registry.selected) as AccountId);
    if (!entry) throw new CodexRuntimeError('codex_account_not_found');
    return entry;
  }
  add() {
    if (this.maintenance) throw new CodexRuntimeError('codex_busy');
    if (!this.initialized) throw new CodexRuntimeError('codex_disabled');
    if (this.entries.size >= 2) throw new CodexRuntimeError('codex_account_limit');
    this.persist({ ...this.registry, accounts: [...this.registry.accounts, 'account-2'] });
    return this.create('account-2');
  }
  select(id: string) {
    if (this.maintenance) throw new CodexRuntimeError('codex_busy');
    const entry = this.entry(id);
    if (entry.managing || !entry.runtime.connectedCached || !entry.provider.getDiagnostics().available) throw new CodexRuntimeError('codex_account_not_ready');
    this.persist({ ...this.registry, selected: entry.id });
  }
  async manage<T>(id: string | undefined, action: (entry: Entry) => Promise<T>): Promise<T> {
    const entry = this.entry(id), d = entry.provider.getDiagnostics();
    if (this.maintenance || entry.managing || d.inflight || d.queued) throw new CodexRuntimeError('codex_busy');
    entry.managing = true;
    entry.usageEpoch++; entry.usage = { status: 'idle', result: null, error: null };
    try { return await action(entry); } finally { entry.managing = false; }
  }
  async refresh() { if (!this.maintenance) await Promise.all([...this.entries.values()].map((e) => e.managing ? Promise.resolve() : e.provider.refresh())); }
  async refreshAccount(id?: string) {
    const entry = this.entry(id);
    if (this.maintenance || entry.managing) throw new CodexRuntimeError('codex_busy');
    await entry.provider.refresh();
  }
  models() {
    const catalog = new Map<string, ReturnType<CodexProvider['getDiagnostics']>['models'][number]>();
    for (const e of this.entries.values()) for (const m of e.provider.getDiagnostics().models) {
      const previous = catalog.get(m.model);
      catalog.set(m.model, { ...m, supportedReasoningEfforts: [...new Set([...(previous?.supportedReasoningEfforts ?? []), ...m.supportedReasoningEfforts])] });
    }
    return [...catalog.values()];
  }
  /** Quiesce both profiles before replacing the executable. Never copy auth files. */
  async replaceRuntime(command: string, version: string, commit: () => Promise<void> = async () => {}) {
    if (this.maintenance || [...this.entries.values()].some((e) => e.managing || e.usage.status === 'pending' || e.runtime.loginPendingCached)) throw new CodexRuntimeError('codex_busy');
    this.maintenance = true;
    const previous = this.runtimeOverride;
    const oldModels = this.models();
    const original = [...this.entries.values()].map((e) => ({ id: e.id, metrics: e.provider.metrics, connected: e.runtime.connectedCached }));
    const rebuild = async (override: Partial<CodexRuntimeOptions>) => {
      for (const e of this.entries.values()) e.provider.invalidate();
      await this.close(); this.entries.clear(); this.runtimeOverride = override;
      for (const e of original) this.create(e.id, e.metrics);
      await Promise.all([...this.entries.values()].map((e) => e.provider.refresh()));
    };
    try {
      const deadline = Date.now() + this.config.timeoutMs + 1000;
      while ([...this.entries.values()].some((e) => { const d = e.provider.getDiagnostics(); return d.inflight || d.queued; })) {
        if (Date.now() >= deadline) throw new CodexRuntimeError('codex_update_drain_timeout');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await rebuild({ command, expectedRuntimeVersion: version });
      if (original.some((e) => e.connected && !this.entry(e.id).provider.getDiagnostics().available)) {
        throw new CodexRuntimeError('codex_update_account_check_failed');
      }
      await commit();
      const next = this.models();
      return { addedModels: next.filter((m) => !oldModels.some((old) => old.model === m.model)),
        removedModels: oldModels.filter((m) => !next.some((n) => n.model === m.model)).map((m) => m.model),
        thinkingChanges: next.filter((m) => oldModels.some((old) => old.model === m.model && JSON.stringify(old.supportedReasoningEfforts) !== JSON.stringify(m.supportedReasoningEfforts))) };
    } catch (e) {
      // An unsuccessful candidate may never strand a working authenticated profile.
      if (this.runtimeOverride !== previous) await rebuild(previous);
      throw e;
    } finally { this.maintenance = false; }
  }
  async close() { await Promise.all([...this.entries.values()].map((e) => e.runtime.close())); }
  getDiagnostics() { return this.entry().provider.getDiagnostics(); }
  async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    // A trusted app pin overrides global selection. Resolve before any await so
    // queued/inflight calls keep their account even if an administrator switches.
    const entry = this.entry(opts?.codex?.accountId);
    const accountFallbackEnabled = opts?.codex?.accountFallbackEnabled ?? this.config.accountFallbackEnabled;
    if (this.maintenance || entry.managing) throw new LLMProviderError('codex_busy', 'codex', 'Account management in progress.', { statusCode: 503 });
    const complete = async (target: Entry) => {
      let response: LLMResponse;
      try { response = await target.provider.chat(messages, opts); this.onOutcome(target.id, null); }
      catch (e) { this.onOutcome(target.id, e instanceof LLMProviderError ? e.code : 'codex_inference_failed'); throw e; }
      this.lastRouting = { preferredAccountId: entry.id, accountId: target.id,
        fallbackReason: target.id === entry.id ? null : 'codex_quota_depleted', at: new Date().toISOString() };
      return { ...response, codexAccountId: target.id, codexAccountFallbackFrom: target.id !== entry.id ? entry.id : undefined };
    };
    try { return await complete(entry); }
    catch (error) {
      if (!(error instanceof LLMProviderError) || error.code !== 'codex_quota_depleted' || !accountFallbackEnabled || opts?.signal?.aborted) throw error;
      const alternate = this.entries.get(entry.id === 'account-1' ? 'account-2' : 'account-1');
      if (!alternate || alternate.managing) throw error;
      await alternate.provider.refresh();
      const effort = opts?.codex?.reasoningEffort ?? this.config.reasoningEffort;
      if (!alternate.runtime.connectedCached || alternate.provider.quotaState().depleted
        || !alternate.provider.getDiagnostics().models.some((m) => m.model === opts?.model && m.supportedReasoningEfforts.includes(effort))) throw error;
      return complete(alternate);
    }
  }
  async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
    const response = await this.chat(messages, opts);
    yield { content: response.content, model: response.model }; return response;
  }
  snapshot(id?: string) {
    const entry = this.entry(id);
    const accountView = (e: Entry) => ({ ...safeAccount(e.runtime.cachedStatus(), e.id), inferenceAvailable: e.runtime.connectedCached && e.provider.getDiagnostics().available });
    return { account: accountView(entry), selectedAccountId: this.registry.selected, accountFallbackEnabled: this.config.accountFallbackEnabled, lastRouting: this.lastRouting,
      maxAccounts: 2, inferenceEnabled: this.config.enabled, provider: entry.provider.getDiagnostics(),
      accounts: [...this.entries.values()].map(accountView), catalog: this.models(), usage: entry.usage };
  }
  publicQuota() {
    return { enabled: this.config.enabled, maxAccounts: 2, accountFallbackEnabled: this.config.accountFallbackEnabled, lastRouting: this.lastRouting, accounts: [...this.entries.values()].map((entry) => {
      const state = safeAccount(entry.runtime.cachedStatus(), entry.id), d = entry.provider.getDiagnostics();
      return { id: entry.id, alias: state.alias, authenticated: state.authenticated, active: this.registry.selected === entry.id, depleted: entry.provider.quotaState().depleted,
        stale: d.quotaStale, observedAt: d.quota?.observedAt ?? null,
        // Only service-reported buckets; preserve every window, including unknown usage.
        // A zero-use 5h window may be hidden, but any positive use must be visible.
        quotas: ['codex', 'codex_bengalfox'].flatMap<{ limitId: string; window: QuotaWindow | null }>((limitId) => {
          const bucket = d.quota?.buckets.find((b) => b.limitId === limitId);
          if (!bucket) return [];
          const windows = [bucket.primary, bucket.secondary].filter((w) => w != null);
          windows.sort((a, b) => (b.windowDurationMins ?? 0) - (a.windowDurationMins ?? 0));
          if (!windows.length) return [{ limitId, window: null }];
          return windows.filter((w) => w.windowDurationMins !== 300 || w.usedPercent !== 0)
            .map((window) => ({ limitId, window }));
        }) };
    }) };
  }
  startUsage(id?: string) {
    const entry = this.entry(id);
    if (this.maintenance || entry.managing) throw new CodexRuntimeError('codex_busy');
    if (entry.usage.status === 'pending') return entry.usage;
    const epoch = ++entry.usageEpoch;
    entry.usage = { status: 'pending', result: entry.usage.result, error: null };
    // HTTP never waits on an upstream account-activity request (or a proxy timeout).
    let timer: ReturnType<typeof setTimeout>;
    const bounded = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CodexRuntimeError('codex_usage_timeout')), 20_000); });
    void Promise.race([entry.runtime.usage(), bounded]).then((result) => {
      if (entry.usageEpoch === epoch) entry.usage = { status: 'completed', result, error: null };
    }, (error) => {
      if (entry.usageEpoch === epoch) entry.usage = { status: 'failed', result: entry.usage.result,
        error: error instanceof CodexRuntimeError ? error.code : 'codex_usage_unavailable' };
    }).finally(() => clearTimeout(timer));
    return entry.usage;
  }
}
