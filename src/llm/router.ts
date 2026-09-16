import { LLMHedgeCancelled, LLMProviderError } from './errors.js';
import { isNvidiaTierAlias } from './providers/nvidia/naming.js';
import { isCodexRequest } from '../codex/models.js';
import type {
  LLMBackendId,
  LLMClient,
  LLMFallbackAttempt,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamChunk,
} from './types.js';

interface BackendClient extends LLMClient {
  health?(): unknown;
}

export interface LLMRouterConfig {
  codexFallbackModels?: () => string[];
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
  /**
   * Gemini model substituted when a NVIDIA-only request (tier alias or namespaced
   * catalog id) falls back to gemini-api. NVIDIA is a best-effort quality surface:
   * when it is cooling down or times out the request downgrades to this model
   * instead of failing. Empty/undefined keeps the old hard-fail behavior.
   */
  nvidiaFallbackModel?: string;
  /**
   * Head start granted to Gemini before one best-effort NVIDIA candidate is
   * launched for a model both providers can serve.
   */
  nvidiaHedgeDelayMs?: number;
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
    fallbackEligible: backend !== 'codex',
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

interface NvidiaRouterHedgeOptions extends LLMOptions {
  /** Internal marker: the NVIDIA client must launch exactly one candidate. */
  __nvidiaRouterHedge?: true;
}

type BackendOutcome =
  | { ok: true; backend: 'gemini-api' | 'nvidia'; response: LLMResponse }
  | { ok: false; backend: 'gemini-api' | 'nvidia'; error: LLMProviderError };

type NvidiaHedgeOutcome =
  | { ok: true; backend: 'nvidia'; response: LLMResponse }
  | { ok: false; backend: 'nvidia'; error: LLMProviderError };

function normalizedModel(rawModel: unknown): string {
  return String(rawModel ?? '').trim().toLowerCase().replace(/^models\//, '');
}

function responseHasUsableOutput(response: LLMResponse): boolean {
  return response.content.trim().length > 0 || (response.images?.length ?? 0) > 0;
}

interface CrossBackendNvidiaHedgePlan {
  model: string;
  tier?: LLMOptions['tier'];
}

function normalizedAllowedModels(opts?: LLMOptions): Set<string> | null {
  if (!Array.isArray(opts?.allowedModelIds)) return null;
  return new Set(opts.allowedModelIds.map(normalizedModel).filter(Boolean));
}

function resolveCrossBackendNvidiaHedge(
  config: LLMRouterConfig,
  sequence: LLMBackendId[],
  opts?: LLMOptions,
): CrossBackendNvidiaHedgePlan | null {
  if ((opts?.backendPreference ?? 'auto') !== 'auto') return null;
  if (sequence[0] !== 'gemini-api' || !config.backendOrder.includes('nvidia')) return null;
  const model = normalizedModel(opts?.model);
  const textGeminiModel = /^(gemini|gemma)-/.test(model)
    && !/(?:embedding|image|audio|tts|live|veo)/.test(model);
  if (!textGeminiModel || config.strictModelIds?.includes(model)) return null;

  const allowed = normalizedAllowedModels(opts);
  if (allowed?.has('nvidia-auto')) {
    return {
      model: 'nvidia-auto',
      tier: model.includes('lite')
        ? 'medium'
        : model.includes('flash')
          ? 'large'
          : opts?.tier,
    };
  }

  // Without explicit nvidia-auto permission, the hedge may preserve only an exact
  // alias that is already allowed for this request. It must never widen an app policy.
  const exactServable = config.nvidiaServableModelIds?.includes(model) === true;
  const exactAllowed = allowed === null || allowed.has(model);
  return exactServable && exactAllowed ? { model, tier: opts?.tier } : null;
}

function nvidiaFailureAttempts(
  error: LLMProviderError | null,
  hedgeModel: string,
): LLMFallbackAttempt[] {
  if (!error) return [];
  if (error.options.fallbackAttempts?.length) {
    return error.options.fallbackAttempts.map((attempt) => ({ ...attempt }));
  }
  const statusCode = error.options.statusCode;
  const hasUpstreamEvidence = Boolean(
    error.options.upstreamModel || error.options.lastUpstreamError,
  );
  return [{
    model: error.options.upstreamModel ?? hedgeModel,
    backend: 'nvidia',
    provider: 'nvidia',
    reason: error.code,
    // Local cooldown/budget errors carry an HTTP-shaped status for the caller, but
    // it is not an upstream response and must not be rendered as one.
    ...(hasUpstreamEvidence && typeof statusCode === 'number' ? { statusCode } : {}),
  }];
}

function withNvidiaFailureTelemetry(
  response: LLMResponse,
  error: LLMProviderError | null,
  hedgeModel: string,
): LLMResponse {
  const hedgeAttempts = nvidiaFailureAttempts(error, hedgeModel);
  if (hedgeAttempts.length === 0) return response;
  return {
    ...response,
    fallbackAttempts: [
      ...(response.fallbackAttempts ?? []),
      ...hedgeAttempts,
    ],
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
  if (backend === 'codex') return error.code === 'codex_quota_depleted'
    && Boolean(config.codexFallbackModels?.().some((id) => !opts?.allowedModelIds || opts.allowedModelIds.includes(id)));
  return backend === 'gemini-api' || backend === 'ollama' || backend === 'nvidia';
}

/**
 * True when only the nvidia backend understands this model id (tier alias or a
 * namespaced catalog name). Such requests need a model remap before any other
 * backend can serve them.
 */
function isNvidiaOnlyModel(config: LLMRouterConfig, rawModel: unknown): boolean {
  const model = String(rawModel ?? '').trim().toLowerCase().replace(/^models\//, '');
  const nvidiaCanServe = config.nvidiaServableModelIds?.includes(model) === true;
  const isGeminiModel = /^(gemini|gemma)-/.test(model);
  return isNvidiaTierAlias(model) || (nvidiaCanServe && !isGeminiModel);
}

function resolveBackendSequence(config: LLMRouterConfig, opts?: LLMOptions): LLMBackendId[] {
  const preference = opts?.backendPreference ?? 'auto';
  if (preference !== 'auto') return [preference];
  if (isCodexRequest(String(opts?.model ?? ''))) {
    if (!config.backendOrder.includes('codex')) return ['codex'];
    return config.backendOrder.includes('gemini-api') && config.codexFallbackModels?.().length
      ? ['codex', 'gemini-api'] : ['codex'];
  }
  const rawOrder = [...new Set(config.backendOrder)].filter((backend) => backend !== 'codex');
  const model = String(opts?.model ?? '').trim().toLowerCase().replace(/^models\//, '');
  const nvidiaCanServe = config.nvidiaServableModelIds?.includes(model) === true;
  const isGeminiModel = /^(gemini|gemma)-/.test(model);
  // NVIDIA-first when it's a tier alias or a catalog name no other backend understands.
  // Gemini-named catalog entries (gemma-* aliases) stay gemini-first with nvidia as
  // spill, so the free Gemini quota is always spent before the NVIDIA budget.
  if (isNvidiaTierAlias(model) || (nvidiaCanServe && !isGeminiModel)) {
    if (!rawOrder.includes('nvidia')) return [];
    // NVIDIA is a quality surface, not a hard dependency: when it fails or cools
    // down, dispatch remaps the model and downgrades to the Gemini fallback.
    return config.nvidiaFallbackModel && rawOrder.includes('gemini-api')
      ? ['nvidia', 'gemini-api']
      : ['nvidia'];
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
    codex?: BackendClient;
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
    if (backend === 'codex') return backends.codex;
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

  // Non-nvidia backends can't serve a NVIDIA-only id: substitute the configured
  // Gemini fallback model for their attempt (the response keeps the real model used).
  function optsForBackend(backend: LLMBackendId, opts: LLMOptions): LLMOptions {
    if (backend === 'gemini-api' && isCodexRequest(String(opts.model ?? ''))) {
      const candidates = config.codexFallbackModels?.().filter((id) => !opts.allowedModelIds || opts.allowedModelIds.includes(id)) ?? [];
      if (!candidates.length) throw new LLMProviderError('codex_fallback_not_allowed', 'codex', 'No authorized Gemini fallback.', { statusCode: 429 });
      return { ...opts, model: candidates[0], codex: undefined };
    }
    if (backend === 'codex' || backend === 'nvidia' || !config.nvidiaFallbackModel) return opts;
    if (!isNvidiaOnlyModel(config, opts.model)) return opts;
    return { ...opts, model: config.nvidiaFallbackModel };
  }

  async function dispatchChat(messages: LLMMessage[], rawOpts?: LLMOptions): Promise<LLMResponse> {
    const sequence = resolveBackendSequence(config, rawOpts);
    const deadline = withRequestDeadline(rawOpts);
    const opts = deadline.opts;
    let lastError: LLMProviderError | null = null;
    const crossBackendHedge = backends.nvidia
      ? resolveCrossBackendNvidiaHedge(config, sequence, opts)
      : null;

    try {
    if (crossBackendHedge) {
      const geminiController = new AbortController();
      const nvidiaController = new AbortController();
      const signalFor = (controller: AbortController): AbortSignal => (
        opts.signal
          ? AbortSignal.any([opts.signal, controller.signal])
          : controller.signal
      );
      const geminiOpts: LLMOptions = { ...opts, signal: signalFor(geminiController) };
      const nvidiaOpts: NvidiaRouterHedgeOptions = {
        ...opts,
        model: crossBackendHedge.model,
        tier: crossBackendHedge.tier,
        signal: signalFor(nvidiaController),
        __nvidiaRouterHedge: true,
      };
      let nvidiaHedgeFailure: LLMProviderError | null = null;
      let releaseNvidia!: () => void;
      let nvidiaReleased = false;
      let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
      const nvidiaGate = new Promise<void>((resolve) => {
        releaseNvidia = () => {
          if (nvidiaReleased) return;
          nvidiaReleased = true;
          if (hedgeTimer) {
            clearTimeout(hedgeTimer);
            hedgeTimer = null;
          }
          resolve();
        };
        hedgeTimer = setTimeout(releaseNvidia, Math.max(0, config.nvidiaHedgeDelayMs ?? 8_000));
        hedgeTimer.unref?.();
      });

      const geminiOutcome = backends.geminiApi.chat(messages, geminiOpts)
        .then<BackendOutcome>((response) => {
          if (!responseHasUsableOutput(response)) {
            throw new LLMProviderError(
              'gemini_api_empty_response',
              'gemini-api',
              'Gemini returned no usable content.',
              { statusCode: 502, fallbackEligible: true },
            );
          }
          return { ok: true, backend: 'gemini-api', response };
        })
        .catch<BackendOutcome>((error: unknown) => ({
          ok: false,
          backend: 'gemini-api',
          error: normalizeBackendError('gemini-api', error),
        }));
      // If Gemini fails before its head start expires, there is no reason to keep the
      // hedge asleep. It still gets exactly one NVIDIA candidate.
      void geminiOutcome.then((outcome) => {
        if (!outcome.ok) releaseNvidia();
      });

      const nvidiaOutcome = nvidiaGate
        .then(() => {
          if (nvidiaOpts.signal?.aborted) throw new LLMHedgeCancelled();
          return backends.nvidia!.chat(messages, nvidiaOpts);
        })
        .then<BackendOutcome>((response) => {
          if (!response.content.trim()) {
            throw new LLMProviderError(
              'nvidia_empty_response',
              'nvidia',
              'NVIDIA hedge returned no usable visible content.',
              { statusCode: 502, fallbackEligible: true },
            );
          }
          return { ok: true, backend: 'nvidia', response };
        })
        .catch<BackendOutcome>((error: unknown) => {
          const normalized = normalizeBackendError('nvidia', error);
          if (!(error instanceof LLMHedgeCancelled)) nvidiaHedgeFailure = normalized;
          return {
            ok: false,
            backend: 'nvidia',
            error: normalized,
          };
        });

      const first = await Promise.race([geminiOutcome, nvidiaOutcome]);
      let resolved = first;
      if (!resolved.ok) {
        // Do not let an opportunistic NVIDIA failure disturb a still-running Gemini
        // request. Conversely, a fast Gemini failure wakes NVIDIA immediately.
        resolved = await (resolved.backend === 'gemini-api' ? nvidiaOutcome : geminiOutcome);
      }

      if (resolved.ok && responseHasUsableOutput(resolved.response)) {
        if (resolved.backend === 'gemini-api') {
          nvidiaController.abort(new LLMHedgeCancelled());
          // Settle a not-yet-launched hedge so it cannot wake up after this request.
          releaseNvidia();
        } else {
          geminiController.abort(new LLMHedgeCancelled());
        }
        const responseWithTelemetry = resolved.backend === 'gemini-api'
          ? withNvidiaFailureTelemetry(
            resolved.response,
            nvidiaHedgeFailure,
            crossBackendHedge.model,
          )
          : resolved.response;
        const response = annotateResponse(
          responseWithTelemetry,
          resolved.backend,
          resolved.backend === 'nvidia' ? 'gemini-api' : undefined,
          resolved.backend === 'nvidia' ? 'nvidia_hedge_won' : undefined,
        );
        state.lastBackendUsed = response.backend ?? resolved.backend;
        state.lastFallbackFrom = response.fallbackFrom ?? null;
        state.lastFallbackReason = response.fallbackReason ?? null;
        state.lastResolutionAt = new Date().toISOString();
        state.lastError = null;
        return response;
      }

      // Both branches failed (or a backend violated the non-empty response contract).
      // Preserve Gemini as the primary error so the remaining serial fallback policy
      // sees the same status/retry semantics it would have seen without the hedge.
      const [geminiResult, nvidiaResult] = await Promise.all([geminiOutcome, nvidiaOutcome]);
      const primaryError = !geminiResult.ok
        ? geminiResult.error
        : !nvidiaResult.ok
          ? nvidiaResult.error
          : new LLMProviderError('backend_unavailable', 'gemini-api', 'Both hedged backends returned empty output.', {
            statusCode: 502,
            fallbackEligible: true,
          });
      lastError = primaryError;
    }

    for (let index = 0; index < sequence.length; index++) {
      const backend = sequence[index];
        // The cross-backend hedge above already spent both the primary Gemini path and
        // the single NVIDIA candidate. If both failed, continue only with other backends.
        if (crossBackendHedge && (backend === 'gemini-api' || backend === 'nvidia')) {
          continue;
        }
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
        const rawResponse = await client.chat(messages, optsForBackend(backend, opts));
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
      const crossBackendHedge = backends.nvidia
        ? resolveCrossBackendNvidiaHedge(config, sequence, opts)
        : null;

      try {
      if (crossBackendHedge) {
        const geminiController = new AbortController();
        const nvidiaController = new AbortController();
        const signalFor = (controller: AbortController): AbortSignal => (
          opts.signal
            ? AbortSignal.any([opts.signal, controller.signal])
            : controller.signal
        );
        const geminiOpts: LLMOptions = { ...opts, signal: signalFor(geminiController) };
        const nvidiaOpts: NvidiaRouterHedgeOptions = {
          ...opts,
          model: crossBackendHedge.model,
          tier: crossBackendHedge.tier,
          signal: signalFor(nvidiaController),
          __nvidiaRouterHedge: true,
        };
        let nvidiaHedgeFailure: LLMProviderError | null = null;
        const geminiStream = backends.geminiApi.streamChat
          ? backends.geminiApi.streamChat(messages, geminiOpts)
          : singleResponseStream(backends.geminiApi, messages, geminiOpts);

        type GeminiStreamStart =
          | { ok: true; backend: 'gemini-api'; kind: 'chunk'; chunk: LLMStreamChunk }
          | { ok: true; backend: 'gemini-api'; kind: 'done'; response: LLMResponse }
          | { ok: false; backend: 'gemini-api'; error: LLMProviderError };

        let releaseNvidia!: () => void;
        let nvidiaReleased = false;
        let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
        const nvidiaGate = new Promise<void>((resolve) => {
          releaseNvidia = () => {
            if (nvidiaReleased) return;
            nvidiaReleased = true;
            if (hedgeTimer) {
              clearTimeout(hedgeTimer);
              hedgeTimer = null;
            }
            resolve();
          };
          hedgeTimer = setTimeout(releaseNvidia, Math.max(0, config.nvidiaHedgeDelayMs ?? 8_000));
          hedgeTimer.unref?.();
        });

        // Commit to Gemini as soon as it has visible output. Until then NVIDIA may
        // complete a full response and safely win without mixing two streams.
        const geminiStart = (async (): Promise<GeminiStreamStart> => {
          try {
            while (true) {
              const next = await geminiStream.next();
              if (next.done) {
                if (!responseHasUsableOutput(next.value)) {
                  throw new LLMProviderError(
                    'gemini_api_empty_response',
                    'gemini-api',
                    'Gemini returned no usable streamed content.',
                    { statusCode: 502, fallbackEligible: true },
                  );
                }
                return { ok: true, backend: 'gemini-api', kind: 'done', response: next.value };
              }
              if (next.value.content.trim()) {
                return { ok: true, backend: 'gemini-api', kind: 'chunk', chunk: next.value };
              }
            }
          } catch (error) {
            return {
              ok: false,
              backend: 'gemini-api',
              error: normalizeBackendError('gemini-api', error),
            };
          }
        })();
        void geminiStart.then((outcome) => {
          if (!outcome.ok) releaseNvidia();
        });

        const nvidiaOutcome: Promise<NvidiaHedgeOutcome> = nvidiaGate
          .then(() => {
            if (nvidiaOpts.signal?.aborted) throw new LLMHedgeCancelled();
            return backends.nvidia!.chat(messages, nvidiaOpts);
          })
          .then<NvidiaHedgeOutcome>((response) => {
            if (!response.content.trim()) {
              throw new LLMProviderError(
                'nvidia_empty_response',
                'nvidia',
                'NVIDIA hedge returned no usable visible content.',
                { statusCode: 502, fallbackEligible: true },
              );
            }
            return { ok: true, backend: 'nvidia', response };
          })
          .catch<NvidiaHedgeOutcome>((error: unknown) => {
            const normalized = normalizeBackendError('nvidia', error);
            if (!(error instanceof LLMHedgeCancelled)) nvidiaHedgeFailure = normalized;
            return {
              ok: false,
              backend: 'nvidia',
              error: normalized,
            };
          });

        const first = await Promise.race([geminiStart, nvidiaOutcome]);
        let resolved: GeminiStreamStart | NvidiaHedgeOutcome = first;
        if (!resolved.ok) {
          resolved = await (
            resolved.backend === 'gemini-api'
              ? nvidiaOutcome
              : geminiStart
          );
        }

        if (resolved.ok && resolved.backend === 'nvidia') {
          geminiController.abort(new LLMHedgeCancelled());
          void geminiStream.return?.(undefined as never).catch(() => {});
          const response = annotateResponse(
            resolved.response,
            'nvidia',
            'gemini-api',
            'nvidia_hedge_won',
          );
          yield { content: response.content };
          state.lastBackendUsed = 'nvidia';
          state.lastFallbackFrom = 'gemini-api';
          state.lastFallbackReason = 'nvidia_hedge_won';
          state.lastResolutionAt = new Date().toISOString();
          state.lastError = null;
          return response;
        }

        if (resolved.ok && resolved.backend === 'gemini-api') {
          nvidiaController.abort(new LLMHedgeCancelled());
          releaseNvidia();
          try {
            let finalResponse: LLMResponse;
            if (resolved.kind === 'done') {
              finalResponse = resolved.response;
              if (finalResponse.content) yield { content: finalResponse.content };
            } else {
              yield resolved.chunk;
              while (true) {
                const next = await geminiStream.next();
                if (next.done) {
                  finalResponse = next.value;
                  break;
                }
                yield next.value;
              }
            }
            const response = annotateResponse(
              withNvidiaFailureTelemetry(
                finalResponse,
                nvidiaHedgeFailure,
                crossBackendHedge.model,
              ),
              'gemini-api',
            );
            state.lastBackendUsed = 'gemini-api';
            state.lastFallbackFrom = response.fallbackFrom ?? null;
            state.lastFallbackReason = response.fallbackReason ?? null;
            state.lastResolutionAt = new Date().toISOString();
            state.lastError = null;
            return response;
          } catch (error) {
            const normalized = normalizeBackendError('gemini-api', error);
            state.lastBackendUsed = null;
            state.lastFallbackFrom = normalized.options.fallbackFrom ?? null;
            state.lastFallbackReason = normalized.options.fallbackReason ?? normalized.code;
            state.lastResolutionAt = new Date().toISOString();
            state.lastError = normalized.message;
            throw normalized;
          }
        }

        // Both pre-commit branches failed. Preserve Gemini as the primary error and
        // continue with any non-NVIDIA serial fallback that has not already run.
        const [geminiResult, nvidiaResult] = await Promise.all([geminiStart, nvidiaOutcome]);
        lastError = !geminiResult.ok
          ? geminiResult.error
          : !nvidiaResult.ok
            ? nvidiaResult.error
            : new LLMProviderError('backend_unavailable', 'gemini-api', 'Both stream hedges failed.', {
              statusCode: 502,
              fallbackEligible: true,
            });
      }

      for (let index = 0; index < sequence.length; index++) {
        const backend = sequence[index];
        if (crossBackendHedge && (backend === 'gemini-api' || backend === 'nvidia')) {
          continue;
        }
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
          const backendOpts = optsForBackend(backend, opts);
          const stream = client.streamChat ? client.streamChat(messages, backendOpts) : singleResponseStream(client, messages, backendOpts);
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
        crossBackendNvidiaHedge: {
          enabled: Boolean(backends.nvidia && config.backendOrder.includes('nvidia')),
          delayMs: config.nvidiaHedgeDelayMs ?? 8_000,
          maxCandidates: 1,
          policy: 'gemini-first',
        },
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
