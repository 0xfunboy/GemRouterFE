import { pacificDayStartMs } from '../gemini-api/quotaLedger.js';
import type { LLMMessage } from '../../types.js';

export interface OllamaLocalConfig {
  enabled: boolean;
  baseUrl: string;
  embeddingModel: string | null;
  embeddingRpd: number | null;
  visionModel: string | null;
  visionRpd: number | null;
  timeoutMs: number;
}

export interface OllamaLocalModelUsage {
  model: string;
  kind: 'embedding' | 'vision' | 'text';
  used: number;
  limit: number | null;
}

export interface OllamaLocalClient {
  config: OllamaLocalConfig;
  isEmbeddingModel(model: string): boolean;
  isVisionModel(model: string): boolean;
  embed(model: string, input: string[]): Promise<number[][]>;
  visionChat(model: string, messages: LLMMessage[]): Promise<{ content: string }>;
  usage(): OllamaLocalModelUsage[];
  health(): Promise<Record<string, unknown>>;
}

function normalize(model: string | undefined): string {
  return String(model ?? '').trim().toLowerCase();
}

/**
 * Minimal client for a single local Ollama instance that serves exactly the
 * embedding and vision models. These are reached only on a direct request for
 * the configured model id and never participate in the Gemini fallback chain.
 */
export function createOllamaLocalClient(config: OllamaLocalConfig): OllamaLocalClient {
  const base = config.baseUrl.replace(/\/+$/, '');

  // In-memory daily request counters, reset at the Pacific midnight rollover to match
  // the Gemini ledger. Local models have no upstream quota; these are soft budgets.
  const counters = new Map<string, number>();
  let countersDay = pacificDayStartMs();
  function bump(model: string): void {
    const today = pacificDayStartMs();
    if (today !== countersDay) {
      counters.clear();
      countersDay = today;
    }
    counters.set(model, (counters.get(model) ?? 0) + 1);
  }

  async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
      throw new Error(`ollama-local ${path} failed: ${message}`);
    }
    return payload;
  }

  return {
    config,
    isEmbeddingModel(model: string): boolean {
      return Boolean(config.embeddingModel) && normalize(model) === normalize(config.embeddingModel ?? undefined);
    },
    isVisionModel(model: string): boolean {
      return Boolean(config.visionModel) && normalize(model) === normalize(config.visionModel ?? undefined);
    },
    async embed(model: string, input: string[]): Promise<number[][]> {
      bump(model);
      const payload = await postJson('/api/embed', { model, input });
      const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings as number[][] : [];
      return embeddings;
    },
    async visionChat(model: string, messages: LLMMessage[]): Promise<{ content: string }> {
      bump(model);
      const payload = await postJson('/api/chat', {
        model,
        stream: false,
        messages: messages.map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
          content: message.content,
          ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
        })),
      });
      const message = (payload.message as { content?: unknown } | undefined) ?? {};
      return { content: typeof message.content === 'string' ? message.content : '' };
    },
    usage(): OllamaLocalModelUsage[] {
      const today = pacificDayStartMs();
      if (today !== countersDay) {
        counters.clear();
        countersDay = today;
      }
      const rows: OllamaLocalModelUsage[] = [];
      if (config.embeddingModel) {
        rows.push({ model: config.embeddingModel, kind: 'embedding', used: counters.get(config.embeddingModel) ?? 0, limit: config.embeddingRpd });
      }
      if (config.visionModel) {
        rows.push({ model: config.visionModel, kind: 'vision', used: counters.get(config.visionModel) ?? 0, limit: config.visionRpd });
      }
      return rows;
    },

    async health(): Promise<Record<string, unknown>> {
      if (!config.enabled) return { enabled: false, available: false };
      try {
        const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(Math.min(5000, config.timeoutMs)) });
        const payload = await response.json().catch(() => ({})) as { models?: Array<{ name?: string }> };
        const names = Array.isArray(payload.models) ? payload.models.map((m) => String(m.name ?? '')) : [];
        return {
          enabled: true,
          available: response.ok,
          baseUrl: base,
          embeddingModel: config.embeddingModel,
          visionModel: config.visionModel,
          installedModels: names,
        };
      } catch (error) {
        return { enabled: true, available: false, baseUrl: base, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
