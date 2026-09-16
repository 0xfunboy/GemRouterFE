import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CodexTokenUsage } from './usage.js';
import { isCodexModel } from './models.js';

type Counters = { received: number; succeeded: number; failed: number; quotaBlocked: number; cancelled: number;
  inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number;
  totalTokens: number; usageReportedRequests: number; usageUnknownRequests: number };
const empty = (): Counters => ({ received: 0, succeeded: 0, failed: 0, quotaBlocked: 0, cancelled: 0,
  inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
  usageReportedRequests: 0, usageUnknownRequests: 0 });
type State = { version: 1; since: string; totals: Counters; models: Record<string, Counters> };
/** Local request metrics, not an estimate of the subscription's remaining budget. */
export class CodexMetrics {
  private data: State = { version: 1, since: new Date().toISOString(), totals: empty(), models: {} };
  private storageError: string | null = null;
  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536 || stat.uid !== process.getuid?.()) throw new Error();
      const saved = JSON.parse(readFileSync(file, 'utf8')) as State;
      const valid = (c: Counters) => c && Object.keys(empty()).every((key) => Number.isSafeInteger(c[key as keyof Counters]) && c[key as keyof Counters] >= 0);
      if (saved.version !== 1 || !Number.isFinite(Date.parse(saved.since)) || !valid(saved.totals)
        || !saved.models || Object.keys(saved.models).some((model) => !isCodexModel(model)) || !Object.values(saved.models).every(valid)) throw new Error();
      this.data = saved; chmodSync(file, 0o600);
    } catch { this.storageError = 'codex_metrics_unreadable'; }
  }
  private update(model: string, action: (c: Counters) => void) {
    // Only the fixed provider allowlist may supply model IDs.
    if (!isCodexModel(model)) throw new Error('Unknown Codex metrics model');
    this.data.models[model] ??= empty();
    action(this.data.totals); action(this.data.models[model]);
    this.persist();
  }
  received(model: string) { this.update(model, (c) => c.received++); }
  completed(model: string, outcome: 'succeeded' | 'failed' | 'quotaBlocked' | 'cancelled', usage: CodexTokenUsage | null, dispatched: boolean) {
    this.update(model, (c) => {
      c[outcome]++;
      if (usage?.totalTokens != null) {
        c.usageReportedRequests++; c.totalTokens += usage.totalTokens;
        // Component counters are reported separately; total is never re-derived.
        c.inputTokens += usage.inputTokens ?? 0; c.outputTokens += usage.outputTokens ?? 0;
        c.cachedInputTokens += usage.cachedInputTokens ?? 0; c.reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
      } else if (dispatched) c.usageUnknownRequests++;
    });
  }
  snapshot() { return { ...structuredClone(this.data), storageError: this.storageError, scope: 'gemrouter-codex-requests', remainingTokens: null, remainingRequests: null }; }
  private persist() {
    if (!this.file || this.storageError === 'codex_metrics_unreadable') return;
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw new Error();
      writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file); this.storageError = null;
    } catch { this.storageError = 'codex_metrics_write_failed'; try { unlinkSync(temp); } catch { /* No temporary file. */ } }
  }
}
