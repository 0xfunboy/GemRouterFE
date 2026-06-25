import { existsSync, readFileSync } from 'node:fs';

import { LLMProviderError } from '../../errors.js';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../../types.js';

interface OllamaRouterDeps {
  fetch?: typeof fetch;
}

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
  excludeCloudModels: boolean;
  minParameterScore: number;
  timeoutMs: number;
  streamTimeoutMs: number;
  defaultModel?: string;
}

interface ModelRoute {
  model: OllamaEndpointModel;
  endpointCount: number;
  endpoints: string[];
}

interface BenchmarkResult {
  model: string;
  endpointIndex: number;
  endpointLabel: string;
  ok: boolean;
  parameterScore: number;
  benchmarkPriority: number;
  latencyMs: number | null;
  tokensPerSecond: number | null;
  outputTokens: number | null;
  responseChars: number;
  endpointCount: number;
  workingEndpointCount: number;
  failedEndpointCount: number;
  testedAt: string;
  error: string | null;
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

function ollamaTokenStats(body: unknown, fallbackText: string, latencyMs: number): {
  outputTokens: number | null;
  tokensPerSecond: number | null;
} {
  if (body && typeof body === 'object') {
    const typed = body as Record<string, unknown>;
    const outputTokens = typeof typed.eval_count === 'number' ? typed.eval_count : null;
    const evalDurationNs = typeof typed.eval_duration === 'number' ? typed.eval_duration : null;
    if (outputTokens && evalDurationNs && evalDurationNs > 0) {
      return {
        outputTokens,
        tokensPerSecond: Math.round((outputTokens / (evalDurationNs / 1_000_000_000)) * 100) / 100,
      };
    }
    if (outputTokens && latencyMs > 0) {
      return {
        outputTokens,
        tokensPerSecond: Math.round((outputTokens / (latencyMs / 1000)) * 100) / 100,
      };
    }
  }

  const estimatedTokens = Math.max(1, Math.ceil(fallbackText.length / 4));
  return {
    outputTokens: estimatedTokens,
    tokensPerSecond: latencyMs > 0 ? Math.round((estimatedTokens / (latencyMs / 1000)) * 100) / 100 : null,
  };
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

export function createOllamaRouterClient(config: OllamaRouterConfig, deps: OllamaRouterDeps = {}): LLMClient & {
  health(): Record<string, unknown>;
  listPublicModels(): Array<Record<string, unknown>>;
  benchmarkModels(input?: {
    models?: string[];
    timeoutMs?: number;
    concurrency?: number;
    onResult?: (result: BenchmarkResult) => void;
  }): Promise<Record<string, unknown>>;
} {
  const outboundFetch = deps.fetch ?? fetch;
  const inventory = readInventory(config.inventoryPath).filter((endpoint) => endpoint.ok !== false && endpoint.url);
  const routes = new Map<string, ModelRoute>();
  const failures = new Map<string, { failedAt: string; error: string }>();
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastModel: string | null = null;
  let lastError: string | null = null;
  let lastBenchmarks: BenchmarkResult[] = [];

  for (const endpoint of inventory) {
    for (const model of endpoint.models ?? []) {
      const name = String(model.name ?? '').trim();
      if (!name) continue;
      if (config.excludeCloudModels && isCloudModelName(name)) continue;
      if (modelPowerScore(model) < config.minParameterScore) continue;
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
    .sort(comparePublicModels);

  const defaultModel = config.defaultModel && routes.has(normalizeModelId(config.defaultModel))
    ? config.defaultModel
    : String(publicModels[0]?.id ?? '');

  function rankedEndpoints(route: ModelRoute, model: string, sessionKey?: string): string[] {
    const seed = Array.from(sessionKey ?? model).reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const endpoints = route.endpoints.map((url, index) => {
      const benchmark = lastBenchmarks.find((result) => result.model === route.model.name && result.ok);
      return {
        url,
        index,
        failed: failures.has(`${url}|${normalizeModelId(model)}`),
        benchmarkSpeed: benchmark?.tokensPerSecond ?? 0,
        stableOffset: (index - (seed % route.endpoints.length) + route.endpoints.length) % route.endpoints.length,
      };
    });

    return endpoints
      .sort((left, right) =>
        Number(left.failed) - Number(right.failed) ||
        right.benchmarkSpeed - left.benchmarkSpeed ||
        left.stableOffset - right.stableOffset ||
        left.index - right.index,
      )
      .map((entry) => entry.url);
  }

  function selectEndpoint(model: string, sessionKey?: string): { url: string; route: ModelRoute } {
    const route = routes.get(normalizeModelId(model));
    if (!route) {
      throw new LLMProviderError('ollama_model_not_found', 'ollama', `Model ${model} is not available in the Ollama inventory.`, {
        statusCode: 404,
        fallbackEligible: true,
        upstreamModel: model,
      });
    }
    return { url: rankedEndpoints(route, model, sessionKey)[0], route };
  }

  function fallbackModelSequence(requestedModel: string): string[] {
    const requestedRoute = routes.get(normalizeModelId(requestedModel));
    const requestedScore = requestedRoute?.model.score ?? Number.POSITIVE_INFINITY;
    const requestedFamily = requestedRoute ? inferFamily(requestedRoute.model.name) : '';
    return [...routes.values()]
      .filter((route) => route.model.name !== requestedRoute?.model.name)
      .filter((route) => Number(route.model.score ?? 0) < requestedScore)
      .sort((left, right) => {
        const leftSameFamily = requestedFamily && inferFamily(left.model.name) === requestedFamily ? 0 : 1;
        const rightSameFamily = requestedFamily && inferFamily(right.model.name) === requestedFamily ? 0 : 1;
        return (
          leftSameFamily - rightSameFamily ||
          Number(right.model.score ?? 0) - Number(left.model.score ?? 0) ||
          genericBenchmarkPriority(right.model.name) - genericBenchmarkPriority(left.model.name) ||
          left.model.name.localeCompare(right.model.name)
        );
      })
      .map((route) => route.model.name);
  }

  async function postJson(url: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await outboundFetch(`${url}${path}`, {
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
      const modelCandidates = [
        requestedModel,
        ...fallbackModelSequence(requestedModel),
      ].filter(Boolean);
      const fallbackAttempts = [];
      let lastThrown: unknown = null;

      for (const candidate of modelCandidates) {
        const route = routes.get(normalizeModelId(candidate));
        if (!route) continue;
        const model = route.model.name;
        const endpoints = rankedEndpoints(route, model, opts?.sessionKey);
        for (const url of endpoints) {
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
              fallbackReason: model !== requestedModel ? 'ollama_model_fallback' : undefined,
              fallbackAttempts,
              latencyMs: Date.now() - startedAt,
            };
          } catch (error) {
            lastThrown = error;
            lastFailureAt = new Date().toISOString();
            lastError = error instanceof Error ? error.message : String(error);
            failures.set(`${url}|${normalizeModelId(model)}`, { failedAt: lastFailureAt, error: lastError });
            fallbackAttempts.push({
              model,
              backend: 'ollama' as const,
              provider: 'ollama',
              reason: error instanceof Error ? error.message : String(error),
              statusCode: error instanceof LLMProviderError ? error.options.statusCode ?? null : null,
            });
          }
        }
      }

      throw lastThrown ?? new LLMProviderError('ollama_model_not_found', 'ollama', `Model ${requestedModel} is not available in the Ollama inventory.`, {
        statusCode: 404,
        fallbackEligible: true,
        upstreamModel: requestedModel,
      });
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
        excludeCloudModels: config.excludeCloudModels,
        minParameterScore: config.minParameterScore,
        defaultModel,
        models: publicModels,
        benchmarks: lastBenchmarks,
        lastModel,
        lastSuccessAt,
        lastFailureAt,
        lastError,
      };
    },

    listPublicModels(): Array<Record<string, unknown>> {
      return publicModels;
    },

    async benchmarkModels(input = {}): Promise<Record<string, unknown>> {
      const requested = new Set((input.models ?? []).map((model) => normalizeModelId(model)).filter(Boolean));
      const models = [...routes.values()]
        .filter((route) => requested.size === 0 || requested.has(normalizeModelId(route.model.name)))
        .sort((left, right) =>
          Number(right.model.score ?? 0) - Number(left.model.score ?? 0) ||
          genericBenchmarkPriority(right.model.name) - genericBenchmarkPriority(left.model.name) ||
          left.model.name.localeCompare(right.model.name),
        );
      const timeoutMs = input.timeoutMs ?? Math.min(config.timeoutMs, 120_000);
      const prompt = 'Reply only with OK.';
      const results: BenchmarkResult[] = [];
      for (const route of models) {
        const model = route.model.name;
        const endpoints = rankedEndpoints(route, model, `benchmark:${model}`);
        for (let index = 0; index < endpoints.length; index += 1) {
          const url = endpoints[index];
          const startedAt = Date.now();
          const testedAt = new Date().toISOString();
          let result: BenchmarkResult;
          try {
            const body = await postJson(url, '/api/chat', {
              model,
              messages: [{ role: 'user', content: prompt }],
              stream: false,
            }, timeoutMs);
            const text = extractResponseText(body);
            const latencyMs = Date.now() - startedAt;
            const stats = ollamaTokenStats(body, text, latencyMs);
            if (!text.trim()) {
              throw new Error('Empty benchmark response.');
            }
            result = {
              model,
              endpointIndex: index + 1,
              endpointLabel: `endpoint ${index + 1}`,
              ok: true,
              parameterScore: modelPowerScore(route.model),
              benchmarkPriority: genericBenchmarkPriority(model),
              latencyMs,
              tokensPerSecond: stats.tokensPerSecond,
              outputTokens: stats.outputTokens,
              responseChars: text.length,
              endpointCount: route.endpointCount,
              workingEndpointCount: 1,
              failedEndpointCount: 0,
              testedAt,
              error: null,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.set(`${url}|${normalizeModelId(model)}`, { failedAt: new Date().toISOString(), error: message });
            result = {
            model,
            endpointIndex: index + 1,
            endpointLabel: `endpoint ${index + 1}`,
            ok: false,
            parameterScore: modelPowerScore(route.model),
            benchmarkPriority: genericBenchmarkPriority(model),
            latencyMs: Date.now() - startedAt,
            tokensPerSecond: null,
            outputTokens: null,
            responseChars: 0,
            endpointCount: route.endpointCount,
            workingEndpointCount: 0,
            failedEndpointCount: 1,
            testedAt,
            error: message,
            };
          }
          results.push(result);
          input.onResult?.(result);
        }
      }
      lastBenchmarks = results.sort(compareBenchmarkResults);
      return {
        ok: true,
        testedAt: new Date().toISOString(),
        count: lastBenchmarks.length,
        results: lastBenchmarks,
        sources: genericBenchmarkSources(),
      };
    },
  };
}

function inferFamily(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.includes('/')) return normalized.split('/')[0];
  return normalized.split(/[:-]/)[0] || 'ollama';
}

function isCloudModelName(modelName: string): boolean {
  return /(:cloud|-cloud)(?:$|[^a-z0-9])/i.test(modelName);
}

function inferParameterScoreFromLabel(value: unknown): number {
  const match = String(value ?? '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*([bmk])/);
  if (!match) return 0;
  const numeric = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(numeric)) return 0;
  if (unit === 'b') return numeric;
  if (unit === 'm') return numeric / 1000;
  if (unit === 'k') return numeric / 1_000_000;
  return 0;
}

function inferParameterLabelFromName(name: string): string | null {
  const match = name.toLowerCase().match(/(?:^|[:-])(\d+(?:\.\d+)?\s*[bmk])(?:$|[-_:])/);
  return match ? match[1] : null;
}

function modelPowerScore(model: OllamaEndpointModel): number {
  const explicit = inferParameterScoreFromLabel(model.parameterSize);
  if (explicit > 0) return explicit;
  const fromName = inferParameterScoreFromLabel(inferParameterLabelFromName(model.name));
  if (fromName > 0) return fromName;
  return Number(model.score ?? 0);
}

function genericBenchmarkPriority(model: string): number {
  const normalized = model.toLowerCase();
  if (/deepseek-v3|deepseek-r1|deepseek-v2/.test(normalized)) return 98;
  if (/qwen3|qwen2\.5|qwen/.test(normalized)) return 94;
  if (/llama3\.3|llama3\.1|llama/.test(normalized)) return 90;
  if (/mixtral|mistral/.test(normalized)) return 86;
  if (/nemotron/.test(normalized)) return 84;
  if (/gemma/.test(normalized)) return 80;
  if (/phi/.test(normalized)) return 74;
  if (/granite/.test(normalized)) return 72;
  if (/nomic|embed|gte/.test(normalized)) return 20;
  return 50;
}

function comparePublicModels(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return (
    Number(right.score ?? 0) - Number(left.score ?? 0) ||
    genericBenchmarkPriority(String(right.id ?? right.name ?? '')) - genericBenchmarkPriority(String(left.id ?? left.name ?? '')) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareBenchmarkResults(left: BenchmarkResult, right: BenchmarkResult): number {
  const leftSpeed = left.tokensPerSecond ?? 0;
  const rightSpeed = right.tokensPerSecond ?? 0;
  return (
    Number(right.ok) - Number(left.ok) ||
    right.parameterScore - left.parameterScore ||
    right.benchmarkPriority - left.benchmarkPriority ||
    rightSpeed - leftSpeed ||
    (left.latencyMs ?? Number.MAX_SAFE_INTEGER) - (right.latencyMs ?? Number.MAX_SAFE_INTEGER) ||
    left.model.localeCompare(right.model)
  );
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function genericBenchmarkSources(): Array<Record<string, string>> {
  return [
    {
      name: 'Artificial Analysis',
      url: 'https://artificialanalysis.ai/leaderboards/models',
      note: 'Uses output speed, latency and intelligence leaderboards across hosted LLMs.',
    },
    {
      name: 'Artificial Analysis methodology',
      url: 'https://artificialanalysis.ai/methodology/performance-benchmarking',
      note: 'Defines output speed as tokens per second after the first token.',
    },
    {
      name: 'OpenRouter rankings',
      url: 'https://openrouter.ai/rankings',
      note: 'Used as a popularity and usage signal for model families.',
    },
  ];
}
