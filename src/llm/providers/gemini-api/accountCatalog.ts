import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { filterRetiredGeminiModelIds, isRetiredGeminiModelId } from '../../../lib/models.js';
import type { GeminiApiProviderConfig } from './types.js';
import { fetchGeminiCatalog, geminiAccessDenial, type GeminiAccessDenial } from './catalogApi.js';

/**
 * Live per-account model availability, refreshed from each account's own
 * /models endpoint. Google adds and removes free-tier models over time, so the
 * curated `models` list in accounts.json acts as a cap, not as truth: a key only
 * serves a model when the curated list allows it AND the account's live catalog
 * still contains it. Unknown data preserves the curated policy; a refresh
 * failure or old timestamp never resurrects a known unavailable model.
 * Listing is not proof of inference entitlement: explicit zero quota and
 * model-not-found responses remain separate observations.
 */

interface AccountCatalogEntry {
  accountId: string;
  models: string[];
  fetchedAt: string;
  error: string | null;
  fingerprint?: string;
  unavailable?: Record<string, { reason: GeminiAccessDenial; observedAt: string }>;
}

const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex');
const normalize = (model: string) => model.trim().toLowerCase().replace(/^models\//, '');

interface AccountCatalogFile {
  version: 1;
  updatedAt: string | null;
  accounts: Record<string, AccountCatalogEntry>;
}

export class GeminiAccountModelCatalog {
  private data: AccountCatalogFile;
  private refreshing = false;

  constructor(private readonly config: GeminiApiProviderConfig) {
    this.data = this.load();
  }

  private load(): AccountCatalogFile {
    if (existsSync(this.config.accountModelsCachePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.config.accountModelsCachePath, 'utf8')) as AccountCatalogFile;
        if (parsed?.version === 1 && parsed.accounts) {
          return {
            ...parsed,
            accounts: Object.fromEntries(Object.entries(parsed.accounts).map(([accountId, entry]) => [
              accountId,
              { ...entry, models: filterRetiredGeminiModelIds(Array.isArray(entry.models) ? entry.models : []),
                // Legacy first-fetch failures used a timestamp despite having no
                // successful catalog. Do not reinterpret them as a valid empty list.
                fetchedAt: !entry.fingerprint && entry.error && !entry.models?.length ? '' : entry.fetchedAt },
            ])),
          };
        }
      } catch {
        // Cache is derived data; refetch rather than fail.
      }
    }
    return { version: 1, updatedAt: null, accounts: {} };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.config.accountModelsCachePath), { recursive: true });
    this.data.updatedAt = new Date().toISOString();
    const temporary = `${this.config.accountModelsCachePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.config.accountModelsCachePath);
  }

  /** Last successful catalog wins during outages, including a valid empty catalog. */
  allows(accountId: string, model: string): boolean {
    if (isRetiredGeminiModelId(model)) return false;
    const entry = this.data.accounts[accountId];
    const key = this.config.keys.find((candidate) => candidate.id === accountId);
    if (!entry || (entry.fingerprint && key && entry.fingerprint !== fingerprint(key.key))) return true;
    const id = normalize(model);
    if (entry.unavailable?.[id]) return false;
    if (!Number.isFinite(Date.parse(entry.fetchedAt))) return true;
    return entry.models.includes(id);
  }

  observeInference(accountId: string, model: string, status: number, payload: unknown, dispatchedKey?: string): void {
    const reason = geminiAccessDenial(status, payload);
    const key = this.config.keys.find((candidate) => candidate.id === accountId);
    if (!key || (dispatchedKey != null && key.key !== dispatchedKey) || (!reason && status !== 200)) return;
    if (!reason && !Array.isArray((payload as { candidates?: unknown } | null)?.candidates)) return;
    const old = this.data.accounts[accountId];
    const entry = old && (!old.fingerprint || old.fingerprint === fingerprint(key.key)) ? old : {
      accountId, models: [], fetchedAt: '', error: null,
    };
    const id = normalize(model);
    if (!reason && !entry.unavailable?.[id] && (!Number.isFinite(Date.parse(entry.fetchedAt)) || entry.models.includes(id))) return;
    entry.fingerprint = fingerprint(key.key);
    entry.unavailable ??= {};
    if (reason) entry.unavailable[id] = { reason, observedAt: new Date().toISOString() };
    else {
      delete entry.unavailable[id];
      if (!entry.models.includes(id)) entry.models.push(id);
    }
    this.data.accounts[accountId] = entry;
    this.persist();
  }

  isStale(refreshMs: number): boolean {
    return this.config.keys.filter((key) => key.enabled).some((key) => {
      const entry = this.data.accounts[key.id];
      const fetchedAt = Date.parse(String(entry?.fetchedAt ?? ''));
      return !Number.isFinite(fetchedAt) || Date.now() - fetchedAt >= refreshMs
        || (entry?.fingerprint != null && entry.fingerprint !== fingerprint(key.key));
    });
  }

  async refresh(): Promise<Record<string, unknown>> {
    if (this.refreshing) return { ok: false, reason: 'already_running' };
    this.refreshing = true;
    try {
      const keys = this.config.keys.filter((key) => key.enabled).map((key) => ({ ...key }));
      const results = await Promise.all(keys.map(async (key) => {
        try {
          const catalog = await fetchGeminiCatalog(this.config, key.key);
          const models = filterRetiredGeminiModelIds(catalog
            .filter((model) => Array.isArray(model.supportedGenerationMethods)
              && model.supportedGenerationMethods.map(String).includes('generateContent'))
            .map((model) => String(model.name ?? '').replace(/^models\//, '').trim().toLowerCase())
            .filter(Boolean)).sort();
          const old = this.data.accounts[key.id];
          return { accountId: key.id, models, fetchedAt: new Date().toISOString(), error: null,
            fingerprint: fingerprint(key.key), unavailable: (!old?.fingerprint || old.fingerprint === fingerprint(key.key)) ? old?.unavailable : {} };
        } catch (error) {
          const old = this.data.accounts[key.id];
          const previous = (!old?.fingerprint || old.fingerprint === fingerprint(key.key)) ? old : undefined;
          return {
            accountId: key.id,
            // Keep the previous catalog on fetch failure so a blip does not fail-open everything.
            models: previous?.models ?? [],
            fetchedAt: previous?.fetchedAt ?? '',
            fingerprint: fingerprint(key.key), unavailable: previous?.unavailable,
            error: error instanceof Error && /^gemini_catalog_[a-z0-9_]+$/.test(error.message) ? error.message : 'gemini_catalog_fetch_failed',
          };
        }
      }));
      for (const result of results) {
        const currentKey = this.config.keys.find((key) => key.id === result.accountId);
        if (!currentKey || fingerprint(currentKey.key) !== result.fingerprint) continue;
        const current = this.data.accounts[result.accountId];
        if (current?.fingerprint === result.fingerprint) result.unavailable = current.unavailable;
        this.data.accounts[result.accountId] = result;
      }
      this.persist();
      return {
        ok: true,
        accounts: results.map((result) => ({
          accountId: result.accountId,
          models: result.models.length,
          error: result.error,
          // Curated models the account can no longer serve upstream — routing already
          // skips them via allows(); this list is the operator-facing alert.
          curatedMissing: (this.config.keys.find((key) => key.id === result.accountId)?.models ?? [])
            .filter((model) => !this.allows(result.accountId, model)),
          unavailable: result.unavailable ?? {},
        })),
      };
    } finally {
      this.refreshing = false;
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      updatedAt: this.data.updatedAt,
      accounts: Object.values(this.data.accounts).map((entry) => ({
        accountId: entry.accountId,
        modelCount: entry.models.length,
        fetchedAt: entry.fetchedAt,
        error: entry.error,
        curatedMissing: (this.config.keys.find((key) => key.id === entry.accountId)?.models ?? [])
          .filter((model) => !this.allows(entry.accountId, model)),
        unavailable: entry.unavailable ?? {},
      })),
    };
  }
}
