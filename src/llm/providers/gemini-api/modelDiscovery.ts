import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isRetiredGeminiModelId } from '../../../lib/models.js';
import type { GeminiApiModelInfo, GeminiApiProviderConfig } from './types.js';
import { fetchGeminiCatalog } from './catalogApi.js';

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

  constructor(private readonly config: GeminiApiProviderConfig) {
    this.cache = this.load();
  }

  private load(): GeminiModelCacheFile {
    if (!existsSync(this.config.discoveryCachePath)) {
      return { version: 1, updatedAt: '', lastError: null, models: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.config.discoveryCachePath, 'utf8')) as GeminiModelCacheFile;
      if (parsed.version === 1 && Array.isArray(parsed.models)) {
        return { ...parsed, models: parsed.models.filter((model) => !isRetiredGeminiModelId(model.id || model.name)) };
      }
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

    try {
      const models = await fetchGeminiCatalog(this.config, key.key);
      const discoveredAt = nowIso();
      this.cache = {
        version: 1,
        updatedAt: discoveredAt,
        lastError: null,
        models: models.map((model) => {
          const name = model.name ?? '';
          return {
            id: modelIdFromName(name),
            name,
            displayName: model.displayName ?? null,
            description: model.description ?? null,
            inputTokenLimit: typeof model.inputTokenLimit === 'number' ? model.inputTokenLimit : null,
            outputTokenLimit: typeof model.outputTokenLimit === 'number' ? model.outputTokenLimit : null,
            supportedGenerationMethods: Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [],
            source: 'local-ledger' as const,
            discoveredAt,
          };
        }).filter((model) => !isRetiredGeminiModelId(model.id || model.name)),
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
