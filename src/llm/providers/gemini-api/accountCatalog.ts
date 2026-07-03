import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { GeminiApiProviderConfig } from './types.js';

/**
 * Live per-account model availability, refreshed from each account's own
 * /models endpoint. Google adds and removes free-tier models over time, so the
 * curated `models` list in accounts.json acts as a cap, not as truth: a key only
 * serves a model when the curated list allows it AND the account's live catalog
 * still contains it. Missing or stale live data fails open (curated list wins)
 * so a Google outage can never empty the pool.
 */

const STALE_AFTER_MS = 48 * 3_600_000;

interface AccountCatalogEntry {
  accountId: string;
  models: string[];
  fetchedAt: string;
  error: string | null;
}

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
        if (parsed?.version === 1 && parsed.accounts) return parsed;
      } catch {
        // Cache is derived data; refetch rather than fail.
      }
    }
    return { version: 1, updatedAt: null, accounts: {} };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.config.accountModelsCachePath), { recursive: true });
    this.data.updatedAt = new Date().toISOString();
    writeFileSync(this.config.accountModelsCachePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  /** True when the account's live catalog serves the model; fails open on no/stale data. */
  allows(accountId: string, model: string): boolean {
    const entry = this.data.accounts[accountId];
    if (!entry || entry.error || entry.models.length === 0) return true;
    if (Date.now() - Date.parse(entry.fetchedAt) > STALE_AFTER_MS) return true;
    return entry.models.includes(model.trim().toLowerCase().replace(/^models\//, ''));
  }

  isStale(refreshMs: number): boolean {
    const updatedAt = Date.parse(String(this.data.updatedAt ?? ''));
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= refreshMs;
  }

  async refresh(): Promise<Record<string, unknown>> {
    if (this.refreshing) return { ok: false, reason: 'already_running' };
    this.refreshing = true;
    try {
      const keys = this.config.keys.filter((key) => key.enabled);
      const results = await Promise.all(keys.map(async (key) => {
        const url = `${this.config.baseUrl}/${this.config.version}/models?key=${encodeURIComponent(key.key)}&pageSize=1000`;
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
          const payload = await response.json().catch(() => ({})) as {
            models?: Array<{ name?: string; supportedGenerationMethods?: unknown[] }>;
            error?: { message?: string };
          };
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${payload.error?.message ?? 'unknown error'}`);
          }
          const models = (Array.isArray(payload.models) ? payload.models : [])
            .filter((model) => Array.isArray(model.supportedGenerationMethods)
              && model.supportedGenerationMethods.map(String).includes('generateContent'))
            .map((model) => String(model.name ?? '').replace(/^models\//, '').trim().toLowerCase())
            .filter(Boolean)
            .sort();
          return { accountId: key.id, models, fetchedAt: new Date().toISOString(), error: null };
        } catch (error) {
          return {
            accountId: key.id,
            // Keep the previous catalog on fetch failure so a blip does not fail-open everything.
            models: this.data.accounts[key.id]?.models ?? [],
            fetchedAt: this.data.accounts[key.id]?.fetchedAt ?? new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }));
      for (const result of results) this.data.accounts[result.accountId] = result;
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
            .filter((model) => result.models.length > 0 && !result.error && !result.models.includes(model)),
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
          .filter((model) => entry.models.length > 0 && !entry.error && !entry.models.includes(model)),
      })),
    };
  }
}
