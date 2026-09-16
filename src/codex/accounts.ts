import { closeSync, constants, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../llm/types.js';
import { LLMProviderError } from '../llm/errors.js';
import { CodexRuntime, CodexRuntimeError, validatePrivateProfile, type CodexAccountState } from './runtime.js';
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
  private readonly file: string;
  constructor(readonly config: CodexConfig, private readonly dataDirectory: string,
    private readonly excluded: string[], private readonly factory = (profileDirectory: string) => new CodexRuntime({ ...config, profileDirectory, excludedDirectories: excluded })) {
    this.file = join(config.privateDirectory, 'accounts.json');
    this.create('account-1');
  }
  private create(id: AccountId): Entry {
    const runtime = this.factory(id === 'account-1' ? this.config.profileDirectory : join(this.config.privateDirectory, 'codex-account-2'));
    const metrics = new CodexMetrics(join(this.dataDirectory, id === 'account-1' ? 'codex-metrics.json' : 'codex-account-2-metrics.json'));
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
    if (!this.initialized) throw new CodexRuntimeError('codex_disabled');
    if (this.entries.size >= 2) throw new CodexRuntimeError('codex_account_limit');
    this.persist({ ...this.registry, accounts: [...this.registry.accounts, 'account-2'] });
    return this.create('account-2');
  }
  select(id: string) {
    const entry = this.entry(id);
    if (entry.managing || !entry.runtime.connectedCached || !entry.provider.getDiagnostics().available) throw new CodexRuntimeError('codex_account_not_ready');
    this.persist({ ...this.registry, selected: entry.id });
  }
  async manage<T>(id: string | undefined, action: (entry: Entry) => Promise<T>): Promise<T> {
    const entry = this.entry(id), d = entry.provider.getDiagnostics();
    if (entry.managing || d.inflight || d.queued) throw new CodexRuntimeError('codex_busy');
    entry.managing = true;
    entry.usageEpoch++; entry.usage = { status: 'idle', result: null, error: null };
    try { return await action(entry); } finally { entry.managing = false; }
  }
  async refresh() { await Promise.all([...this.entries.values()].map((e) => e.managing ? Promise.resolve() : e.provider.refresh())); }
  async close() { await Promise.all([...this.entries.values()].map((e) => e.runtime.close())); }
  getDiagnostics() { return this.entry().provider.getDiagnostics(); }
  chat(messages: LLMMessage[], opts?: LLMOptions) {
    const entry = this.entry(); // Pin before any await: queued/inflight calls keep their original account.
    if (entry.managing) return Promise.reject(new LLMProviderError('codex_busy', 'codex', 'Account management in progress.', { statusCode: 503 }));
    return entry.provider.chat(messages, opts);
  }
  async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
    const response = await this.chat(messages, opts);
    yield { content: response.content, model: response.model }; return response;
  }
  snapshot(id?: string) {
    const entry = this.entry(id);
    const accountView = (e: Entry) => ({ ...safeAccount(e.runtime.cachedStatus(), e.id), inferenceAvailable: e.runtime.connectedCached && e.provider.getDiagnostics().available });
    return { account: accountView(entry), selectedAccountId: this.registry.selected,
      maxAccounts: 2, inferenceEnabled: this.config.enabled, provider: entry.provider.getDiagnostics(),
      accounts: [...this.entries.values()].map(accountView), usage: entry.usage };
  }
  publicQuota() {
    return { enabled: this.config.enabled, maxAccounts: 2, accounts: [...this.entries.values()].map((entry) => {
      const state = safeAccount(entry.runtime.cachedStatus(), entry.id), d = entry.provider.getDiagnostics();
      return { alias: state.alias, authenticated: state.authenticated, active: this.registry.selected === entry.id,
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
    if (entry.managing) throw new CodexRuntimeError('codex_busy');
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
