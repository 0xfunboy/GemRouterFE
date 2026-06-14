import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { GeminiApiModelInfo, GeminiApiProviderConfig } from './types.js';

interface GeminiApiModelDiscoveryDeps {
  fetch?: typeof fetch;
}

interface GeminiModelApiShape {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GeminiModelCacheFile {
  version: 1;
  updatedAt: string;
  lastError: string | null;
  models: GeminiApiModelInfo[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function modelIdFromName(name: string): string {
  return name.replace(/^models\//, '');
}

export class GeminiApiModelDiscovery {
  private cache: GeminiModelCacheFile;

  private readonly outboundFetch: typeof fetch;

  constructor(private readonly config: GeminiApiProviderConfig, deps: GeminiApiModelDiscoveryDeps = {}) {
    this.outboundFetch = deps.fetch ?? fetch;
    this.cache = this.load();
  }

  private load(): GeminiModelCacheFile {
    if (!existsSync(this.config.discoveryCachePath)) {
      return { version: 1, updatedAt: '', lastError: null, models: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.config.discoveryCachePath, 'utf8')) as GeminiModelCacheFile;
      if (parsed.version === 1 && Array.isArray(parsed.models)) return parsed;
    } catch {
      // fall through
    }
    return { version: 1, updatedAt: '', lastError: null, models: [] };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.config.discoveryCachePath), { recursive: true });
    writeFileSync(this.config.discoveryCachePath, `${JSON.stringify(this.cache, null, 2)}\n`);
  }

  snapshot(): GeminiModelCacheFile {
    return this.cache;
  }

  async refresh(): Promise<GeminiApiModelInfo[]> {
    const key = this.config.keys.find((candidate) => candidate.enabled);
    if (!this.config.enabled || !key) {
      this.cache.lastError = this.config.enabled ? 'No enabled Gemini API key configured.' : 'Gemini API backend disabled.';
      this.persist();
      return this.cache.models;
    }

    const endpoint = `${this.config.baseUrl.replace(/\/+$/, '')}/${this.config.version}/models?key=${encodeURIComponent(key.key)}`;
    try {
      const response = await this.outboundFetch(endpoint, { signal: AbortSignal.timeout(this.config.timeoutMs) });
      if (!response.ok) {
        throw new Error(`Gemini model discovery failed with HTTP ${response.status}`);
      }
      const payload = await response.json() as { models?: GeminiModelApiShape[] };
      const discoveredAt = nowIso();
      this.cache = {
        version: 1,
        updatedAt: discoveredAt,
        lastError: null,
        models: (payload.models ?? []).map((model) => {
          const name = model.name ?? '';
          return {
            id: modelIdFromName(name),
            name,
            displayName: model.displayName ?? null,
            description: model.description ?? null,
            inputTokenLimit: typeof model.inputTokenLimit === 'number' ? model.inputTokenLimit : null,
            outputTokenLimit: typeof model.outputTokenLimit === 'number' ? model.outputTokenLimit : null,
            supportedGenerationMethods: Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [],
            source: 'local-ledger',
            discoveredAt,
          };
        }),
      };
      this.persist();
      return this.cache.models;
    } catch (error) {
      this.cache.lastError = error instanceof Error ? error.message : String(error);
      this.persist();
      return this.cache.models;
    }
  }

  async refreshIfStale(): Promise<void> {
    const updatedAt = Date.parse(this.cache.updatedAt);
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt < this.config.discoveryRefreshMs) return;
    await this.refresh();
  }
}
