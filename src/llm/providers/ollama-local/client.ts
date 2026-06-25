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

export interface OllamaLocalClient {
  config: OllamaLocalConfig;
  isEmbeddingModel(model: string): boolean;
  isVisionModel(model: string): boolean;
  embed(model: string, input: string[]): Promise<number[][]>;
  visionChat(model: string, messages: LLMMessage[]): Promise<{ content: string }>;
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
      const payload = await postJson('/api/embed', { model, input });
      const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings as number[][] : [];
      return embeddings;
    },
    async visionChat(model: string, messages: LLMMessage[]): Promise<{ content: string }> {
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
