import { LLMProviderError } from './errors.js';
import { isNvidiaTierAlias } from './providers/nvidia/naming.js';
import type { LLMBackendId, LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from './types.js';

interface BackendClient extends LLMClient {
  health?(): unknown;
}

export interface LLMRouterConfig {
  backendOrder: LLMBackendId[];
  /** Models that must never silently spill into another backend. */
  strictModelIds?: string[];
  /**
   * Model ids (and aliases) the NVIDIA catalog can serve. Non-NVIDIA-prefixed models
   * outside this set never spill into the nvidia backend, so a Gemini 429 surfaces
   * as a 429 instead of an nvidia_model_not_found.
   */
  nvidiaServableModelIds?: string[];
  /** Hard ceiling for the whole request across all backends/fallbacks (ms). */
  requestDeadlineMs?: number;
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
  config: LLMRouterConfig,
  backend: LLMBackendId,
  error: LLMProviderError,
  remainingBackends: LLMBackendId[],
  opts?: LLMOptions,
): boolean {
  if (opts?.backendPreference && opts.backendPreference !== 'auto') return false;
  const model = String(opts?.model ?? '').replace(/^models\//, '').trim().toLowerCase();
  if (config.strictModelIds?.includes(model)) return false;
  if (remainingBackends.length === 0) return false;
  if (error.options.fallbackEligible !== true) return false;
  return backend === 'gemini-api' || backend === 'ollama' || backend === 'nvidia';
}

function resolveBackendSequence(config: LLMRouterConfig, opts?: LLMOptions): LLMBackendId[] {
  const preference = opts?.backendPreference ?? 'auto';
  if (preference !== 'auto') return [preference];
  const rawOrder = [...new Set(config.backendOrder)];
  const model = String(opts?.model ?? '').trim().toLowerCase().replace(/^models\//, '');
  const nvidiaCanServe = config.nvidiaServableModelIds?.includes(model) === true;
  const isGeminiModel = /^(gemini|gemma)-/.test(model);
  // NVIDIA-only when it's a tier alias or a catalog name no other backend understands.
  // Gemini-named catalog entries (gemma-* aliases) stay gemini-first with nvidia as
  // spill, so the free Gemini quota is always spent before the NVIDIA budget.
  if (isNvidiaTierAlias(model) || (nvidiaCanServe && !isGeminiModel)) {
    return rawOrder.includes('nvidia') ? ['nvidia'] : [];
  }
  // Models outside the NVIDIA catalog never spill into nvidia: a Gemini 429 must
  // surface as a 429, and namespaced Ollama ids ("ns/model") stay on their backend.
  const order = nvidiaCanServe ? rawOrder : rawOrder.filter((backend) => backend !== 'nvidia');
  if (isGeminiModel) {
    return [
      ...order.filter((backend) => backend === 'gemini-api'),
      ...order.filter((backend) => backend !== 'gemini-api'),
    ];
  }
  return [
    ...order.filter((backend) => backend === 'ollama'),
    ...order.filter((backend) => backend !== 'ollama'),
  ];
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
    geminiApi: BackendClient;
    ollama?: BackendClient;
    nvidia?: BackendClient;
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
    if (backend === 'nvidia') return backends.nvidia;
    return backends.geminiApi;
  }

  // Arm a single hard deadline for the whole request. Every backend attempt shares the
  // same absolute `deadline` and abort `signal`, so the total time a caller waits is
  // bounded no matter how many fallbacks/timeouts stack underneath (a single stuck
  // upstream can no longer run the request for minutes).
  function withRequestDeadline(opts?: LLMOptions): {
    opts: LLMOptions;
    isExpired: () => boolean;
    remainingMs: () => number;
    dispose: () => void;
  } {
    const deadlineMs = config.requestDeadlineMs ?? 75_000;
    const deadline = opts?.deadline ?? Date.now() + deadlineMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('gemrouter_request_deadline')), Math.max(0, deadline - Date.now()));
    timer.unref?.();
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason);
      else opts.signal.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });
    }
    return {
      opts: { ...opts, deadline, signal: controller.signal },
      isExpired: () => Date.now() >= deadline,
      remainingMs: () => Math.max(0, deadline - Date.now()),
      dispose: () => clearTimeout(timer),
    };
  }

  async function dispatchChat(messages: LLMMessage[], rawOpts?: LLMOptions): Promise<LLMResponse> {
    const sequence = resolveBackendSequence(config, rawOpts);
    const deadline = withRequestDeadline(rawOpts);
    const opts = deadline.opts;
    let lastError: LLMProviderError | null = null;

    try {
    for (let index = 0; index < sequence.length; index++) {
      const backend = sequence[index];
        const remaining = sequence.slice(index + 1);
        try {
        if (deadline.isExpired()) {
          throw new LLMProviderError('backend_unavailable', backend, `Request deadline reached before ${backend} could respond.`, {
            statusCode: 504,
            fallbackEligible: false,
          });
        }
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
        if (shouldFallback(config, backend, normalized, remaining, opts)) {
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
      sequence[0] ?? 'gemini-api',
      'No backend could satisfy the request.',
      { statusCode: 503 },
    );
    state.lastBackendUsed = null;
    state.lastFallbackFrom = null;
    state.lastFallbackReason = null;
    state.lastResolutionAt = new Date().toISOString();
    state.lastError = error.message;
    throw error;
    } finally {
      deadline.dispose();
    }
  }

  return {
    provider: 'router',
    model: 'gemini-router',

    async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
      return await dispatchChat(messages, opts);
    },

    async *streamChat(messages: LLMMessage[], rawOpts?: LLMOptions): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
      const sequence = resolveBackendSequence(config, rawOpts);
      const deadline = withRequestDeadline(rawOpts);
      const opts = deadline.opts;
      let lastError: LLMProviderError | null = null;

      try {
      for (let index = 0; index < sequence.length; index++) {
        const backend = sequence[index];
        const remaining = sequence.slice(index + 1);
        try {
          if (deadline.isExpired()) {
            throw new LLMProviderError('backend_unavailable', backend, `Request deadline reached before ${backend} could respond.`, {
              statusCode: 504,
              fallbackEligible: false,
            });
          }
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
          if (shouldFallback(config, backend, normalized, remaining, opts)) {
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
        sequence[0] ?? 'gemini-api',
        'No backend could satisfy the request.',
        { statusCode: 503 },
      );
      state.lastBackendUsed = null;
      state.lastFallbackFrom = null;
      state.lastFallbackReason = null;
      state.lastResolutionAt = new Date().toISOString();
      state.lastError = error.message;
      throw error;
      } finally {
        deadline.dispose();
      }
    },

    getDiagnostics(): Record<string, unknown> {
      const geminiApi = backends.geminiApi.health
        ? (backends.geminiApi.health() as Record<string, unknown>)
        : backends.geminiApi.getDiagnostics?.() ?? null;
      const ollama = backends.ollama?.health
        ? (backends.ollama.health() as Record<string, unknown>)
        : backends.ollama?.getDiagnostics?.() ?? null;
      const nvidia = backends.nvidia?.health
        ? (backends.nvidia.health() as Record<string, unknown>)
        : backends.nvidia?.getDiagnostics?.() ?? null;
      return {
        provider: 'router',
        model: 'gemini-router',
        backendOrder: config.backendOrder,
        configuredDefaultBackend: config.backendOrder[0] ?? 'gemini-api',
        lastBackendUsed: state.lastBackendUsed,
        lastFallbackFrom: state.lastFallbackFrom,
        lastFallbackReason: state.lastFallbackReason,
        lastResolutionAt: state.lastResolutionAt,
        lastError: state.lastError,
        geminiApi,
        ollama,
        nvidia,
      };
    },
  };
}
