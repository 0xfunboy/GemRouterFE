import { GeminiNotReadyError, GeminiQuotaError, GeminiTimeoutError } from './providers/tegem/errors.js';
import { isPlaywrightModelId } from '../lib/models.js';
import { LLMProviderError } from './errors.js';
import type { LLMBackendId, LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from './types.js';

interface BackendClient extends LLMClient {
  health?(): unknown;
}

export interface LLMRouterConfig {
  backendOrder: LLMBackendId[];
  allowPlaywrightFallback: boolean;
  retryOnCliAuthFailure: boolean;
}

interface RouterState {
  lastBackendUsed: LLMBackendId | null;
  lastFallbackFrom: LLMBackendId | null;
  lastFallbackReason: string | null;
  lastResolutionAt: string | null;
  lastError: string | null;
}

function normalizePlaywrightError(error: unknown): LLMProviderError {
  if (error instanceof LLMProviderError) return error;
  if (error instanceof GeminiQuotaError) {
    return new LLMProviderError('playwright_quota', 'playwright', error.message, {
      statusCode: 429,
      fallbackEligible: false,
      cause: error,
    });
  }
  if (error instanceof GeminiTimeoutError) {
    return new LLMProviderError('playwright_timeout', 'playwright', error.message, {
      statusCode: 504,
      fallbackEligible: false,
      cause: error,
    });
  }
  if (error instanceof GeminiNotReadyError) {
    return new LLMProviderError('playwright_not_ready', 'playwright', error.message, {
      statusCode: 503,
      fallbackEligible: false,
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LLMProviderError('playwright_process_error', 'playwright', message, {
    statusCode: 502,
    fallbackEligible: false,
    cause: error,
  });
}

function normalizeBackendError(backend: LLMBackendId, error: unknown): LLMProviderError {
  if (backend === 'playwright') return normalizePlaywrightError(error);
  if (error instanceof LLMProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new LLMProviderError('backend_unavailable', backend, message, {
    statusCode: 502,
    fallbackEligible: backend === 'gemini-cli',
    cause: error,
  });
}

function annotateResponse(
  response: LLMResponse,
  backend: LLMBackendId,
  fallbackFrom?: LLMBackendId,
  fallbackReason?: string,
): LLMResponse {
  const provider = fallbackFrom === 'gemini-cli' && backend === 'playwright'
    ? 'playwright-after-cli-failure'
    : (response.provider || backend);
  return {
    ...response,
    provider,
    backend,
    fallbackFrom,
    fallbackReason,
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
  if (backend !== 'gemini-cli') return false;
  if (!config.allowPlaywrightFallback) return false;
  if (!remainingBackends.includes('playwright')) return false;
  if (error.options.fallbackEligible !== true) return false;
  if ((error.code === 'cli_auth_missing' || error.code === 'cli_auth_expired') && !config.retryOnCliAuthFailure) {
    return false;
  }
  return true;
}

function resolveBackendSequence(config: LLMRouterConfig, opts?: LLMOptions): LLMBackendId[] {
  if (opts?.model && isPlaywrightModelId(opts.model)) return ['playwright'];
  const preference = opts?.backendPreference ?? 'auto';
  if (preference === 'gemini-cli' || preference === 'playwright') return [preference];
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
    geminiCli: BackendClient;
    playwright: BackendClient;
  },
): LLMClient {
  const state: RouterState = {
    lastBackendUsed: null,
    lastFallbackFrom: null,
    lastFallbackReason: null,
    lastResolutionAt: null,
    lastError: null,
  };

  async function dispatchChat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    const sequence = resolveBackendSequence(config, opts);
    let lastError: LLMProviderError | null = null;

    for (let index = 0; index < sequence.length; index++) {
      const backend = sequence[index];
      const remaining = sequence.slice(index + 1);
      try {
        const rawResponse = await (backend === 'gemini-cli'
          ? backends.geminiCli.chat(messages, opts)
          : backends.playwright.chat(messages, opts));
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
      sequence[0] ?? 'gemini-cli',
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
    model: 'gemini-router',

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
          const client = backend === 'gemini-cli' ? backends.geminiCli : backends.playwright;
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
              model: opts?.model ?? 'gemini-web',
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
        sequence[0] ?? 'gemini-cli',
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

    async prewarmSessions(sessions: LLMOptions[]): Promise<void> {
      if (typeof backends.playwright.prewarmSessions === 'function') {
        await backends.playwright.prewarmSessions(sessions);
      }
    },

    getDiagnostics(): Record<string, unknown> {
      const geminiCli = backends.geminiCli.health
        ? (backends.geminiCli.health() as Record<string, unknown>)
        : backends.geminiCli.getDiagnostics?.() ?? null;
      const playwright = backends.playwright.getDiagnostics?.() ?? null;
      return {
        provider: 'router',
        model: 'gemini-router',
        backendOrder: config.backendOrder,
        fallbackEnabled: config.allowPlaywrightFallback,
        retryOnCliAuthFailure: config.retryOnCliAuthFailure,
        configuredDefaultBackend: config.backendOrder[0] ?? 'gemini-cli',
        lastBackendUsed: state.lastBackendUsed,
        lastFallbackFrom: state.lastFallbackFrom,
        lastFallbackReason: state.lastFallbackReason,
        lastResolutionAt: state.lastResolutionAt,
        lastError: state.lastError,
        geminiCli,
        playwright,
        promptPackingStyle:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).promptPackingStyle ?? null
            : null,
        contextAlive:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).contextAlive ?? null
            : null,
        openPages:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).openPages ?? null
            : null,
        storedSessions:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).storedSessions ?? null
            : null,
        respondedOpenTabs:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).respondedOpenTabs ?? null
            : null,
        unresolvedOpenTabs:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).unresolvedOpenTabs ?? null
            : null,
        busyOpenTabs:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).busyOpenTabs ?? null
            : null,
        lastLaunchAt:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).lastLaunchAt ?? null
            : null,
        lastLaunchOkAt:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).lastLaunchOkAt ?? null
            : null,
        lastLaunchError:
          playwright && typeof playwright === 'object'
            ? (playwright as Record<string, unknown>).lastLaunchError ?? null
            : null,
      };
    },
  };
}
