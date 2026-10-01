import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodexAccounts } from '../codex/accounts.js';

type AlertState = { active: boolean; changedAt: number; delivered: Record<string, number> };
export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env) {
  const token = env.GEMROUTER_TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const chatIds = [...new Set((env.GEMROUTER_TELEGRAM_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (token && !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('Invalid Telegram token configuration');
  if (chatIds.length > 2 || chatIds.some((id) => !/^-?\d{1,16}$/.test(id))) throw new Error('Invalid Telegram destinations');
  return { enabled: Boolean(token && chatIds.length), token, chatIds };
}
/** Outbound alerts only: no webhook, polling, commands, prompts or account identities. */
export class TelegramAlerts {
  private states: Record<string, AlertState> = {};
  private failures = new Map<string, number>();
  private pending = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private delivery: Record<string, { ok: boolean; code: string | null; at: string }> = {};
  private storageError = false;
  constructor(private readonly config: ReturnType<typeof readTelegramConfig>, private readonly file: string,
    private readonly transport: typeof fetch = fetch, private readonly now = Date.now) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (value.version === 1 && value.states && Object.keys(value.states).length <= 100) {
        for (const [key, state] of Object.entries(value.states)) {
          const row = state as AlertState;
          if (/^[a-z0-9:._-]{1,100}$/.test(key) && typeof row.active === 'boolean' && Number.isFinite(row.changedAt)
            && row.delivered && Object.values(row.delivered).every(Number.isFinite)) this.states[key] = row;
        }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.storageError = true; }
  }
  snapshot() { return { enabled: this.config.enabled, destinations: this.config.chatIds.length,
    delivery: Object.values(this.delivery), storageError: this.storageError, pending: this.pending.size }; }
  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, states: this.states }), { mode: 0o600, flag: 'wx' }); renameSync(temp, this.file);
      this.storageError = false;
    } catch { this.storageError = true; }
  }
  condition(key: string, active: boolean, text: string) {
    if (!/^[a-z0-9:._-]{1,100}$/.test(key)) return;
    let state = this.states[key];
    if (!state || state.active !== active) {
      state = this.states[key] = { active, changedAt: this.now(), delivered: {} }; this.save();
    }
    if (!active || !this.config.enabled || this.pending.has(key)) return;
    const due = this.config.chatIds.filter((id) => state.delivered[id] !== state.changedAt);
    if (!due.length || this.now() - (this.failures.get(key) ?? -Infinity) < 15 * 60_000 || this.pending.size >= 20) return;
    this.pending.add(key);
    this.queue = this.queue.then(async () => {
      for (const chatId of due) {
        if (this.states[key] !== state || !state.active) break;
        try {
          const response = await this.transport(`https://api.telegram.org/bot${this.config.token}/sendMessage`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error',
            body: JSON.stringify({ chat_id: chatId, text: `GemRouter · ${text}`.slice(0, 1500), link_preview_options: { is_disabled: true } }),
          });
          const data = await response.json() as { ok?: boolean; error_code?: number };
          if (!response.ok || data.ok !== true) throw new Error(`telegram_delivery_${Number(data.error_code) || response.status}`);
          state.delivered[chatId] = state.changedAt;
          this.delivery[chatId] = { ok: true, code: null, at: new Date(this.now()).toISOString() }; this.save();
        } catch (e) {
          // Never expose the fetch URL, exception message, token or recipient ID.
          const code = e instanceof Error && /^telegram_delivery_\d+$/.test(e.message) ? e.message : 'telegram_delivery_failed';
          this.delivery[chatId] = { ok: false, code, at: new Date(this.now()).toISOString() }; this.failures.set(key, this.now());
        }
      }
    }).catch(() => {}).finally(() => { this.pending.delete(key); });
  }
  private unhealthy = new Map<string, number>();
  private errorEvents = new Map<string, number[]>();
  recordOutcome(accountId: string, code: string | null) {
    if (!/^account-[12]$/.test(accountId)) return;
    const key = `${accountId}:inference`;
    if (!code) { this.errorEvents.delete(key); this.condition(key, false, ''); return; }
    if (!['codex_timeout','codex_unreachable','codex_disconnected','codex_restrictions_unverified','codex_inference_failed','codex_invalid_output','codex_runtime_version_unsupported'].includes(code)) return;
    const events = (this.errorEvents.get(key) ?? []).filter((t) => this.now() - t < 5 * 60_000); events.push(this.now()); this.errorEvents.set(key, events);
    this.condition(key, events.length >= 3, `${accountId}: repeated serious Codex inference errors (${code}, at least 3 in 5 minutes). Verify the backend in the admin dashboard.`);
  }
  observe(accounts: CodexAccounts) {
    if (!accounts.config.enabled) return;
    const view = accounts.snapshot();
    const enabled = view.accounts.filter((a) => a.authenticated);
    for (const account of view.accounts) {
      const entry = accounts.entry(account.id), quota = entry.provider.quotaState(), state = entry.runtime.cachedStatus();
      const count = account.authenticated ? 0 : (this.unhealthy.get(account.id) ?? 0) + 1;
      this.unhealthy.set(account.id, count);
      // Ignore an unused, never-connected second slot. Alert sustained runtime/login loss.
      const metrics = entry.provider.metrics.snapshot().totals;
      const previouslyConnected = Boolean(this.states[`${account.id}:connected`]) || metrics.succeeded > 0;
      if (account.authenticated && !this.states[`${account.id}:connected`]) {
        this.states[`${account.id}:connected`] = { active: true, changedAt: this.now(), delivered: {} }; this.save();
      }
      this.condition(`${account.id}:login`, !account.authenticated && count >= 3 && previouslyConnected,
        `${account.id}: Codex login/runtime unavailable (${state.reasonCode && /^[a-z_]+$/.test(state.reasonCode) ? state.reasonCode : 'codex_unavailable'}). Verify the account in the admin dashboard.`);
      const bucket = entry.provider.getDiagnostics().quota?.buckets.find((b) => b.limitId === 'codex');
      for (const [key, w] of [['5h', bucket?.primary], ['weekly', bucket?.secondary]] as const) {
        if (!w || w.usedPercent == null) continue; // Unknown is not recovery.
        const exhausted = w?.usedPercent != null && w.usedPercent >= 100;
        const reset = w?.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Rome' }) + ' Europe/Rome' : 'not reported';
        this.condition(`${account.id}:quota:${key}`, exhausted, `${account.id}: Codex ${key} quota exhausted. Next reported reset: ${reset}. Account fallback is quota-only.`);
      }
      const reportedExhaustion = [bucket?.primary, bucket?.secondary].some((w) => w?.usedPercent != null && w.usedPercent >= 100);
      this.condition(`${account.id}:quota:rejected`, quota.depleted && !reportedExhaustion,
        `${account.id}: Codex rejected inference because its quota is exhausted. Verify service quota in the dashboard.`);
    }
    this.condition('codex:all-unavailable', enabled.length === 0 && view.accounts.every((a) => (this.unhealthy.get(a.id) ?? 0) >= 3)
      && view.accounts.some((a) => this.states[`${a.id}:connected`]),
      'CRITICAL: no authenticated Codex account is available. Codex inference cannot be served; login errors do not permit Gemini fallback.');
  }
  critical(code: string) {
    if (/^codex_[a-z_]{1,70}$/.test(code)) this.condition(`runtime:${code}`, true, `CRITICAL: runtime update failed (${code}). The last working runtime is retained; check the admin dashboard.`);
  }
  async close() { await this.queue; }
}
