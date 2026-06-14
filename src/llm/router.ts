import { LLMProviderError } from './errors.js';
import type { LLMBackendId, LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from './types.js';

interface BackendClient extends LLMClient {
  health?(): unknown;
}

export interface LLMRouterConfig {
  backendOrder: LLMBackendId[];
}

interface RouterState {
  lastBackendUsed: LLMBackendId | null;
  lastFallbackFrom: LLMBackendId | null;
  lastFallbackReason: string | null;
  lastResolutionAt: string | null;
  lastError: string | null;
}

function normalizeBackendError(backend: LLMBackendId, error: unknown): LLMProviderError {
  if (error instanceof LLMProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new LLMProviderError('backend_unavailable', backend, message, {
    statusCode: 502,
    fallbackEligible: true,
    cause: error,
  });
}

function annotateResponse(
  response: LLMResponse,
  backend: LLMBackendId,
  fallbackFrom?: LLMBackendId,
  fallbackReason?: string,
): LLMResponse {
  return {
    ...response,
    provider: response.provider || backend,
    backend,
    fallbackFrom: fallbackFrom ?? response.fallbackFrom,
    fallbackReason: fallbackReason ?? response.fallbackReason,
  };
}

function shouldFallback(
  backend: LLMBackendId,
  error: LLMProviderError,
  remainingBackends: LLMBackendId[],
  opts?: LLMOptions,
): boolean {
  if (opts?.backendPreference && opts.backendPreference !== 'auto') return false;
  if (remainingBackends.length === 0) return false;
  if (error.options.fallbackEligible !== true) return false;
  return backend === 'ollama' || backend === 'deepseek-api' || backend === 'gemini-api';
}

function resolveBackendSequence(config: LLMRouterConfig, opts?: LLMOptions): LLMBackendId[] {
  const preference = opts?.backendPreference ?? 'auto';
  if (preference !== 'auto') return [preference];
  return [...new Set(config.backendOrder)];
}

async function* singleResponseStream(
  client: LLMClient,
  messages: LLMMessage[],
  opts?: LLMOptions,
): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
  const response = await client.chat(messages, opts);
  if (response.content) {
    yield { content: response.content };
  }
  return response;
}

export function createLlmRouter(
  config: LLMRouterConfig,
  backends: {
    ollama?: BackendClient;
    deepseekApi?: BackendClient;
    geminiApi?: BackendClient;
  },
): LLMClient {
  const state: RouterState = {
    lastBackendUsed: null,
    lastFallbackFrom: null,
    lastFallbackReason: null,
    lastResolutionAt: null,
    lastError: null,
  };

  function getBackendClient(backend: LLMBackendId): BackendClient | undefined {
    if (backend === 'ollama') return backends.ollama;
    if (backend === 'deepseek-api') return backends.deepseekApi;
    return backends.geminiApi;
  }

  async function dispatchChat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    const sequence = resolveBackendSequence(config, opts);
    let lastError: LLMProviderError | null = null;

    for (let index = 0; index < sequence.length; index++) {
      const backend = sequence[index];
        const remaining = sequence.slice(index + 1);
      try {
        const client = getBackendClient(backend);
        if (!client) {
          throw new LLMProviderError('backend_disabled', backend, `Backend ${backend} is not configured.`, {
            statusCode: 503,
            fallbackEligible: true,
          });
        }
        const rawResponse = await client.chat(messages, opts);
        const response = annotateResponse(rawResponse, backend, lastError?.backend, lastError?.code);
        state.lastBackendUsed = response.backend ?? backend;
        state.lastFallbackFrom = response.fallbackFrom ?? null;
        state.lastFallbackReason = response.fallbackReason ?? null;
        state.lastResolutionAt = new Date().toISOString();
        state.lastError = null;
        return response;
      } catch (error) {
        const normalized = normalizeBackendError(backend, error);
        if (shouldFallback(backend, normalized, remaining, opts)) {
          state.lastFallbackFrom = normalized.backend;
          state.lastFallbackReason = normalized.code;
          lastError = normalized;
          continue;
        }
        const finalError = lastError
          ? new LLMProviderError(normalized.code, normalized.backend, normalized.message, {
            ...normalized.options,
            fallbackFrom: lastError.backend,
            fallbackReason: lastError.code,
          })
          : normalized;
        state.lastBackendUsed = null;
        state.lastFallbackFrom = finalError.options.fallbackFrom ?? state.lastFallbackFrom;
        state.lastFallbackReason = finalError.options.fallbackReason ?? state.lastFallbackReason;
        state.lastResolutionAt = new Date().toISOString();
        state.lastError = finalError.message;
        throw finalError;
      }
    }

    const error = lastError ?? new LLMProviderError(
      'backend_unavailable',
      sequence[0] ?? 'ollama',
      'No backend could satisfy the request.',
      { statusCode: 503 },
    );
    state.lastBackendUsed = null;
    state.lastFallbackFrom = null;
    state.lastFallbackReason = null;
    state.lastResolutionAt = new Date().toISOString();
    state.lastError = error.message;
    throw error;
  }

  return {
    provider: 'router',
    model: 'leak-router',

    async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
      return await dispatchChat(messages, opts);
    },

    async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
      const sequence = resolveBackendSequence(config, opts);
      let lastError: LLMProviderError | null = null;

      for (let index = 0; index < sequence.length; index++) {
        const backend = sequence[index];
        const remaining = sequence.slice(index + 1);
        try {
          const client = getBackendClient(backend);
          if (!client) {
            throw new LLMProviderError('backend_disabled', backend, `Backend ${backend} is not configured.`, {
              statusCode: 503,
              fallbackEligible: true,
            });
          }
          const stream = client.streamChat ? client.streamChat(messages, opts) : singleResponseStream(client, messages, opts);
          let finalResponse: LLMResponse | null = null;
          while (true) {
            const next = await stream.next();
            if (next.done) {
              finalResponse = next.value;
              break;
            }
            yield next.value;
          }

          const response = annotateResponse(
            finalResponse ?? {
              content: '',
              provider: backend,
              model: opts?.model ?? client.model,
            },
            backend,
            lastError?.backend,
            lastError?.code,
          );
          state.lastBackendUsed = response.backend ?? backend;
          state.lastFallbackFrom = response.fallbackFrom ?? null;
          state.lastFallbackReason = response.fallbackReason ?? null;
          state.lastResolutionAt = new Date().toISOString();
          state.lastError = null;
          return response;
        } catch (error) {
          const normalized = normalizeBackendError(backend, error);
          if (shouldFallback(backend, normalized, remaining, opts)) {
            state.lastFallbackFrom = normalized.backend;
            state.lastFallbackReason = normalized.code;
            lastError = normalized;
            continue;
          }
          const finalError = lastError
            ? new LLMProviderError(normalized.code, normalized.backend, normalized.message, {
              ...normalized.options,
              fallbackFrom: lastError.backend,
              fallbackReason: lastError.code,
            })
            : normalized;
          state.lastBackendUsed = null;
          state.lastFallbackFrom = finalError.options.fallbackFrom ?? state.lastFallbackFrom;
          state.lastFallbackReason = finalError.options.fallbackReason ?? state.lastFallbackReason;
          state.lastResolutionAt = new Date().toISOString();
          state.lastError = finalError.message;
          throw finalError;
        }
      }

      const error = lastError ?? new LLMProviderError(
        'backend_unavailable',
        sequence[0] ?? 'ollama',
        'No backend could satisfy the request.',
        { statusCode: 503 },
      );
      state.lastBackendUsed = null;
      state.lastFallbackFrom = null;
      state.lastFallbackReason = null;
      state.lastResolutionAt = new Date().toISOString();
      state.lastError = error.message;
      throw error;
    },

    getDiagnostics(): Record<string, unknown> {
      const diagnosticsFor = (client?: BackendClient): Record<string, unknown> | null => {
        if (!client) return null;
        return client.health
          ? (client.health() as Record<string, unknown>)
          : client.getDiagnostics?.() ?? null;
      };
      return {
        provider: 'router',
        model: 'leak-router',
        backendOrder: config.backendOrder,
        configuredDefaultBackend: config.backendOrder[0] ?? 'ollama',
        lastBackendUsed: state.lastBackendUsed,
        lastFallbackFrom: state.lastFallbackFrom,
        lastFallbackReason: state.lastFallbackReason,
        lastResolutionAt: state.lastResolutionAt,
        lastError: state.lastError,
        ollama: diagnosticsFor(backends.ollama),
        deepseekApi: diagnosticsFor(backends.deepseekApi),
        geminiApi: diagnosticsFor(backends.geminiApi),
      };
    },
  };
}
