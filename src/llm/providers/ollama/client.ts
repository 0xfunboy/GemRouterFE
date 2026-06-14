import { existsSync, readFileSync } from 'node:fs';

import { LLMProviderError } from '../../errors.js';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../../types.js';

export interface OllamaEndpointModel {
  name: string;
  sizeBytes?: number;
  size?: string;
  family?: string | null;
  parameterSize?: string | null;
  quantization?: string | null;
  score?: number;
}

export interface OllamaEndpointInventory {
  url: string;
  ok?: boolean;
  latencyMs?: number;
  models?: OllamaEndpointModel[];
  bestModel?: OllamaEndpointModel | null;
  bestScore?: number;
}

export interface OllamaRouterConfig {
  enabled: boolean;
  inventoryPath: string;
  timeoutMs: number;
  streamTimeoutMs: number;
  defaultModel?: string;
}

interface ModelRoute {
  model: OllamaEndpointModel;
  endpointCount: number;
  endpoints: string[];
}

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

function extractResponseText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const typed = body as Record<string, unknown>;
  if (typeof typed.response === 'string') return typed.response;
  const message = typed.message;
  if (message && typeof message === 'object' && typeof (message as Record<string, unknown>).content === 'string') {
    return String((message as Record<string, unknown>).content);
  }
  return '';
}

function usageFromOllama(body: unknown): LLMResponse['usage'] {
  if (!body || typeof body !== 'object') return undefined;
  const typed = body as Record<string, unknown>;
  const promptTokens = typeof typed.prompt_eval_count === 'number' ? typed.prompt_eval_count : undefined;
  const completionTokens = typeof typed.eval_count === 'number' ? typed.eval_count : undefined;
  const totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  return promptTokens || completionTokens
    ? {
      promptTokens,
      completionTokens,
      totalTokens,
    }
    : undefined;
}

function messagesToPrompt(messages: LLMMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n');
}

function readInventory(path: string): OllamaEndpointInventory[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed as OllamaEndpointInventory[] : [];
  } catch {
    return [];
  }
}

export function createOllamaRouterClient(config: OllamaRouterConfig): LLMClient & {
  health(): Record<string, unknown>;
  listPublicModels(): Array<Record<string, unknown>>;
} {
  const inventory = readInventory(config.inventoryPath).filter((endpoint) => endpoint.ok !== false && endpoint.url);
  const routes = new Map<string, ModelRoute>();
  const failures = new Map<string, { failedAt: string; error: string }>();
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastModel: string | null = null;
  let lastError: string | null = null;

  for (const endpoint of inventory) {
    for (const model of endpoint.models ?? []) {
      const name = String(model.name ?? '').trim();
      if (!name) continue;
      const key = normalizeModelId(name);
      const existing = routes.get(key);
      if (existing) {
        existing.endpointCount += 1;
        existing.endpoints.push(endpoint.url);
      } else {
        routes.set(key, {
          model: { ...model, name },
          endpointCount: 1,
          endpoints: [endpoint.url],
        });
      }
    }
  }

  const publicModels = [...routes.values()]
    .map((route) => ({
      id: route.model.name,
      name: route.model.name,
      provider: 'ollama',
      family: route.model.family ?? inferFamily(route.model.name),
      parameterSize: route.model.parameterSize ?? null,
      quantization: route.model.quantization ?? null,
      size: route.model.size ?? null,
      score: route.model.score ?? 0,
      endpointCount: route.endpointCount,
      capabilities: {
        chat: true,
        imageGeneration: false,
        live: false,
        embeddings: false,
        longRunning: false,
        nativeAudio: false,
        tts: false,
      },
    }))
    .sort((left, right) =>
      Number(right.score ?? 0) - Number(left.score ?? 0) ||
      String(left.id).localeCompare(String(right.id)),
    );

  const defaultModel = config.defaultModel && routes.has(normalizeModelId(config.defaultModel))
    ? config.defaultModel
    : String(publicModels[0]?.id ?? '');

  function selectEndpoint(model: string, sessionKey?: string): { url: string; route: ModelRoute } {
    const route = routes.get(normalizeModelId(model));
    if (!route) {
      throw new LLMProviderError('ollama_model_not_found', 'ollama', `Model ${model} is not available in the Ollama inventory.`, {
        statusCode: 404,
        fallbackEligible: true,
        upstreamModel: model,
      });
    }
    const seed = Array.from(sessionKey ?? model).reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const start = seed % route.endpoints.length;
    for (let offset = 0; offset < route.endpoints.length; offset += 1) {
      const url = route.endpoints[(start + offset) % route.endpoints.length];
      if (!failures.has(`${url}|${normalizeModelId(model)}`)) return { url, route };
    }
    return { url: route.endpoints[start], route };
  }

  async function postJson(url: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) as unknown : {};
      if (!response.ok) {
        throw new LLMProviderError('ollama_upstream_error', 'ollama', `Ollama upstream returned HTTP ${response.status}.`, {
          statusCode: response.status,
          fallbackEligible: response.status >= 500 || response.status === 404 || response.status === 429,
          lastUpstreamError: parsed,
        });
      }
      return parsed;
    } catch (error) {
      if (error instanceof LLMProviderError) throw error;
      const isAbort = error instanceof Error && error.name === 'AbortError';
      throw new LLMProviderError(isAbort ? 'ollama_timeout' : 'ollama_upstream_error', 'ollama', isAbort ? 'Ollama request timed out.' : String(error instanceof Error ? error.message : error), {
        statusCode: isAbort ? 504 : 502,
        fallbackEligible: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    provider: 'ollama',
    model: defaultModel,

    async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
      if (!config.enabled) {
        throw new LLMProviderError('backend_disabled', 'ollama', 'Ollama backend is disabled.', { statusCode: 503, fallbackEligible: true });
      }
      if (routes.size === 0) {
        throw new LLMProviderError('ollama_missing_endpoint', 'ollama', 'No Ollama inventory endpoints are configured.', { statusCode: 503, fallbackEligible: true });
      }

      const requestedModel = opts?.model ?? defaultModel;
      const { url, route } = selectEndpoint(requestedModel, opts?.sessionKey);
      const model = route.model.name;
      lastModel = model;
      const startedAt = Date.now();
      try {
        const body = await postJson(url, '/api/chat', {
          model,
          messages,
          stream: false,
          options: {
            temperature: opts?.temperature,
            num_predict: opts?.maxTokens,
          },
        }, config.timeoutMs);
        const content = extractResponseText(body);
        lastSuccessAt = new Date().toISOString();
        lastError = null;
        return {
          content,
          provider: 'ollama',
          model,
          backend: 'ollama',
          backendModel: model,
          usage: usageFromOllama(body),
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        lastFailureAt = new Date().toISOString();
        lastError = error instanceof Error ? error.message : String(error);
        failures.set(`${url}|${normalizeModelId(model)}`, { failedAt: lastFailureAt, error: lastError });
        throw error;
      }
    },

    async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
      const response = await this.chat(messages, opts);
      if (response.content) yield { content: response.content };
      return response;
    },

    health(): Record<string, unknown> {
      return {
        enabled: config.enabled,
        available: config.enabled && routes.size > 0,
        provider: 'ollama',
        configuredEndpointCount: inventory.length,
        configuredModelCount: routes.size,
        defaultModel,
        models: publicModels,
        lastModel,
        lastSuccessAt,
        lastFailureAt,
        lastError,
      };
    },

    listPublicModels(): Array<Record<string, unknown>> {
      return publicModels;
    },
  };
}

function inferFamily(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.includes('/')) return normalized.split('/')[0];
  return normalized.split(/[:-]/)[0] || 'ollama';
}
