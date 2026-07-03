import type {
  LLMClient,
  LLMFallbackAttempt,
  LLMMessage,
  LLMOptions,
  LLMResponse,
  LLMStreamChunk,
  ModelTier,
} from '../../types.js';
import { NvidiaProviderError, type NvidiaErrorCode } from './errors.js';
import { bareModelName, isNvidiaTierAlias } from './naming.js';
import { NvidiaScoreboard } from './scoreboard.js';
import type {
  NvidiaModelConfig,
  NvidiaProviderConfig,
  NvidiaUpstreamErrorSnapshot,
} from './types.js';

const PROBE_PROMPT = 'Reply with the single word: ok';

interface AttemptResult {
  content: string;
  finishReason: 'stop' | 'length' | 'content_filter';
  ttfbMs: number | null;
  latencyMs: number;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

class AttemptAborted extends Error {
  constructor() {
    super('nvidia attempt aborted by hedged race');
  }
}

function sanitizeKeyPreview(key: string): string {
  if (key.length <= 10) return '***';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function normalizeModel(model: string | undefined): string {
  return String(model ?? '').trim().toLowerCase().replace(/^models\//, '');
}

function stripReasoning(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function sniffImageMime(base64: string): string {
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('R0lGO')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

function toOpenAiMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (Array.isArray(message.images) && message.images.length > 0) {
      return {
        role: message.role,
        content: [
          { type: 'text', text: message.content },
          ...message.images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${sniffImageMime(image)};base64,${image}` },
          })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

export function createNvidiaClient(config: NvidiaProviderConfig): LLMClient {
  const scoreboard = new NvidiaScoreboard(config.scoreboardPath, {
    rateLimitCooldownMs: config.rateLimitCooldownMs,
  });
  const rpmEvents: number[] = [];
  let inflight = 0;
  let lastResolvedModel: string | null = null;
  let lastError: string | null = null;
  let lastUpstreamError: NvidiaUpstreamErrorSnapshot | null = null;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastLatencyMs: number | null = null;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let probeRunning = false;
  let lastProbeAt: string | null = null;
  let lastProbeError: string | null = null;

  const catalog = new Map<string, NvidiaModelConfig>();
  const aliasIndex = new Map<string, string>();
  for (const model of config.models) {
    const id = normalizeModel(model.id);
    if (!id) continue;
    catalog.set(id, { ...model, id });
    const bare = bareModelName(id);
    if (bare && !aliasIndex.has(bare)) aliasIndex.set(bare, id);
    for (const alias of model.aliases ?? []) {
      const normalized = normalizeModel(alias);
      if (normalized) aliasIndex.set(normalized, id);
    }
  }

  function enabledModels(tier?: ModelTier): string[] {
    return [...catalog.values()]
      .filter((model) => model.enabled && (!tier || model.tier === tier))
      .map((model) => model.id);
  }

  function tierOf(model: string): ModelTier {
    return catalog.get(model)?.tier ?? config.defaultTier;
  }

  /**
   * Resolve the requested model into an ordered candidate list.
   * Explicit ids lead their own list and fail over to scoreboard-ranked tier mates;
   * tier aliases (nvidia-auto / nvidia-large / …) are fully scoreboard-driven and race-eligible.
   */
  function resolveCandidates(opts?: LLMOptions): { candidates: string[]; requested: string; raceEligible: boolean } {
    const requested = normalizeModel(opts?.model);
    const now = new Date();

    const tierAlias = isNvidiaTierAlias(requested) ? requested.slice('nvidia-'.length) : null;
    if (!requested || tierAlias || (!requested.includes('/') && !aliasIndex.has(requested) && opts?.tier)) {
      const tier = tierAlias && tierAlias !== 'auto'
        ? tierAlias as ModelTier
        : opts?.tier ?? config.defaultTier;
      // An empty tier falls back to the nearest populated one (small→medium→large, ...).
      const tierLadder: Record<ModelTier, ModelTier[]> = {
        small: ['small', 'medium', 'large'],
        medium: ['medium', 'large', 'small'],
        large: ['large', 'medium', 'small'],
      };
      const pool = tierLadder[tier].map((candidate) => enabledModels(candidate)).find((models) => models.length > 0);
      if (!pool) {
        throw new NvidiaProviderError('nvidia_no_model_available', `No enabled NVIDIA model for tier ${tier}.`, {
          statusCode: 503,
          fallbackEligible: true,
        });
      }
      return { candidates: scoreboard.rank(pool, now), requested: requested || `nvidia-${tier}`, raceEligible: true };
    }

    const direct = catalog.has(requested) ? requested : aliasIndex.get(requested);
    if (!direct) {
      throw new NvidiaProviderError('nvidia_model_not_found', `Model ${requested} is not in the NVIDIA catalog.`, {
        statusCode: 404,
        fallbackEligible: false,
        upstreamModel: requested,
      });
    }
    const mates = scoreboard.rank(
      enabledModels(tierOf(direct)).filter((model) => model !== direct),
      now,
    );
    return { candidates: [direct, ...mates], requested, raceEligible: false };
  }

  function pruneRpmWindow(now = Date.now()): void {
    while (rpmEvents.length > 0 && rpmEvents[0] <= now - 60_000) rpmEvents.shift();
  }

  function localBudgetError(message: string): NvidiaProviderError {
    // Local budget exhaustion is a property of the whole key, not of one model:
    // callers must not score it against the model or retry other candidates.
    const error = new NvidiaProviderError('nvidia_rate_limited', message, {
      statusCode: 429,
      fallbackEligible: true,
    });
    (error as NvidiaProviderError & { localBudget?: boolean }).localBudget = true;
    return error;
  }

  function reserveRpmSlot(): void {
    const now = Date.now();
    pruneRpmWindow(now);
    if (rpmEvents.length >= config.rpmLimit) {
      throw localBudgetError('Local NVIDIA RPM budget exhausted.');
    }
    if (inflight >= config.maxConcurrency) {
      throw localBudgetError('NVIDIA concurrency limit reached.');
    }
    rpmEvents.push(now);
  }

  function snapshotUpstreamError(input: { status: number | null; code: string | null; message: string | null; model: string }): void {
    lastUpstreamError = {
      status: input.status,
      code: input.code,
      message: input.message,
      model: input.model,
      at: new Date().toISOString(),
    };
  }

  async function runAttempt(
    model: string,
    messages: LLMMessage[],
    opts: LLMOptions | undefined,
    signal: AbortSignal,
    onFirstToken: () => void,
  ): Promise<AttemptResult> {
    if (signal.aborted) throw new AttemptAborted();
    reserveRpmSlot();
    inflight += 1;
    const started = Date.now();
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(new AttemptAborted());
    if (signal.aborted) controller.abort(new AttemptAborted());
    signal.addEventListener('abort', onOuterAbort, { once: true });

    const overallTimer = setTimeout(
      () => controller.abort(new NvidiaProviderError('nvidia_timeout', `NVIDIA request to ${model} exceeded ${config.timeoutMs}ms.`, {
        statusCode: 504,
        fallbackEligible: true,
        upstreamModel: model,
      })),
      config.timeoutMs,
    );
    let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => controller.abort(new NvidiaProviderError('nvidia_timeout', `NVIDIA model ${model} produced no token within ${config.firstTokenTimeoutMs}ms.`, {
        statusCode: 504,
        fallbackEligible: true,
        upstreamModel: model,
      })),
      config.firstTokenTimeoutMs,
    );
    const clearFirstTokenTimer = () => {
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
      }
    };

    try {
      const includeThoughts = opts?.thinking?.includeThoughts === true;
      const body: Record<string, unknown> = {
        model,
        messages: toOpenAiMessages(messages),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (typeof opts?.maxTokens === 'number' && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
      if (typeof opts?.temperature === 'number') body.temperature = opts.temperature;

      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new NvidiaProviderError('nvidia_upstream_error', `NVIDIA request failed: ${error instanceof Error ? error.message : String(error)}`, {
          statusCode: 502,
          fallbackEligible: true,
          upstreamModel: model,
          cause: error,
        });
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string }; detail?: string };
        const message = String(payload.error?.message ?? payload.detail ?? response.statusText);
        snapshotUpstreamError({ status: response.status, code: payload.error?.code ?? null, message, model });
        const status = response.status;
        let code: NvidiaErrorCode = 'nvidia_upstream_error';
        let fallbackEligible = true;
        if (status === 401 || status === 403) { code = 'nvidia_auth_failed'; fallbackEligible = false; }
        else if (status === 404) code = 'nvidia_model_not_found';
        else if (status === 429) code = 'nvidia_rate_limited';
        else if (status === 400 || status === 422) { code = 'nvidia_invalid_request'; fallbackEligible = false; }
        const error = new NvidiaProviderError(code, `NVIDIA ${model} responded ${status}: ${message}`, {
          statusCode: status,
          fallbackEligible,
          upstreamModel: model,
          lastUpstreamError,
        });
        if (status === 429) {
          (error as NvidiaProviderError & { retryAfterMs?: number | null }).retryAfterMs = parseRetryAfterMs(response.headers);
        }
        throw error;
      }

      if (!response.body) {
        throw new NvidiaProviderError('nvidia_stream_error', `NVIDIA ${model} returned an empty stream body.`, {
          statusCode: 502,
          fallbackEligible: true,
          upstreamModel: model,
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let content = '';
      let ttfbMs: number | null = null;
      let finishReason: AttemptResult['finishReason'] = 'stop';
      let usage: AttemptResult['usage'] = {};

      const consumeLine = (rawLine: string): void => {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
        const choice = choices[0];
        if (choice) {
          const delta = (choice.delta ?? {}) as Record<string, unknown>;
          const piece = typeof delta.content === 'string' ? delta.content : '';
          const reasoningPiece = includeThoughts && typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : '';
          if (piece || reasoningPiece) {
            if (ttfbMs === null) {
              ttfbMs = Date.now() - started;
              clearFirstTokenTimer();
              onFirstToken();
            }
            content += reasoningPiece + piece;
          }
          const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
          if (finish === 'length') finishReason = 'length';
          else if (finish === 'content_filter') finishReason = 'content_filter';
        }
        const usageChunk = chunk.usage as Record<string, unknown> | undefined;
        if (usageChunk && typeof usageChunk === 'object') {
          usage = {
            promptTokens: typeof usageChunk.prompt_tokens === 'number' ? usageChunk.prompt_tokens : undefined,
            completionTokens: typeof usageChunk.completion_tokens === 'number' ? usageChunk.completion_tokens : undefined,
            totalTokens: typeof usageChunk.total_tokens === 'number' ? usageChunk.total_tokens : undefined,
          };
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let newlineIndex: number;
          while ((newlineIndex = buffered.indexOf('\n')) >= 0) {
            consumeLine(buffered.slice(0, newlineIndex));
            buffered = buffered.slice(newlineIndex + 1);
          }
        }
        // Flush whatever the upstream sent without a trailing newline before closing.
        buffered += decoder.decode();
        if (buffered.trim()) consumeLine(buffered);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new NvidiaProviderError('nvidia_stream_error', `NVIDIA stream from ${model} failed: ${error instanceof Error ? error.message : String(error)}`, {
          statusCode: 502,
          fallbackEligible: true,
          upstreamModel: model,
          cause: error,
        });
      }

      const cleaned = includeThoughts ? content.trim() : stripReasoning(content);
      if (!cleaned) {
        throw new NvidiaProviderError('nvidia_empty_response', `NVIDIA ${model} returned no usable content.`, {
          statusCode: 502,
          fallbackEligible: true,
          upstreamModel: model,
        });
      }
      return { content: cleaned, finishReason, ttfbMs, latencyMs: Date.now() - started, usage };
    } finally {
      clearTimeout(overallTimer);
      clearFirstTokenTimer();
      signal.removeEventListener('abort', onOuterAbort);
      inflight -= 1;
    }
  }

  /**
   * Sequential failover with optional hedging: candidates launch one at a time; in race
   * mode the next candidate also launches when the current ones sit past the hedge delay
   * without a first token. First successful completion wins, everything else is aborted.
   */
  async function generate(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    if (!config.enabled) {
      throw new NvidiaProviderError('backend_disabled', 'NVIDIA backend is disabled.', {
        statusCode: 503,
        fallbackEligible: true,
      });
    }
    if (!config.apiKey) {
      throw new NvidiaProviderError('nvidia_missing_key', 'No NVIDIA API key configured.', {
        statusCode: 503,
        fallbackEligible: true,
      });
    }

    const { candidates, requested, raceEligible } = resolveCandidates(opts);
    const useRace = raceEligible && config.raceEnabled;
    const maxAttempts = useRace
      ? Math.min(candidates.length, Math.max(1, config.raceMaxCandidates))
      : candidates.length;
    const attempts: LLMFallbackAttempt[] = [];
    const requestStarted = Date.now();

    return await new Promise<LLMResponse>((resolve, reject) => {
      let nextIndex = 0;
      let active = 0;
      let settled = false;
      let anyFirstToken = false;
      let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
      let lastAttemptError: NvidiaProviderError | null = null;
      const controllers = new Set<AbortController>();

      const clearHedge = () => {
        if (hedgeTimer) {
          clearTimeout(hedgeTimer);
          hedgeTimer = null;
        }
      };

      const scheduleHedge = () => {
        clearHedge();
        if (!useRace || nextIndex >= maxAttempts) return;
        hedgeTimer = setTimeout(() => {
          if (settled || anyFirstToken) return;
          launchNext();
          // Keep hedging: if this candidate stalls too, the next one gets its own window.
          scheduleHedge();
        }, config.raceHedgeDelayMs);
      };

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearHedge();
        for (const controller of controllers) controller.abort(new AttemptAborted());
        fn();
      };

      const launchNext = (): void => {
        if (settled || nextIndex >= maxAttempts) return;
        const model = candidates[nextIndex];
        nextIndex += 1;
        const controller = new AbortController();
        controllers.add(controller);
        active += 1;
        const source = nextIndex > 1 ? 'hedge' : 'traffic';

        runAttempt(model, messages, opts, controller.signal, () => {
          anyFirstToken = true;
          clearHedge();
        })
          .then((result) => {
            controllers.delete(controller);
            active -= 1;
            scoreboard.recordSuccess(model, {
              latencyMs: result.latencyMs,
              ttfbMs: result.ttfbMs,
              completionTokens: result.usage.completionTokens ?? null,
              source,
            });
            const totalLatencyMs = Date.now() - requestStarted;
            lastResolvedModel = model;
            lastSuccessAt = new Date().toISOString();
            lastLatencyMs = totalLatencyMs;
            lastError = null;
            finish(() => resolve({
              content: result.content,
              finishReason: result.finishReason,
              provider: 'nvidia',
              model: requested,
              backend: 'nvidia',
              backendModel: model,
              tokensUsed: result.usage.totalTokens,
              usage: result.usage,
              fallbackAttempts: attempts.length > 0 ? [...attempts] : undefined,
              latencyMs: totalLatencyMs,
            }));
          })
          .catch((error: unknown) => {
            controllers.delete(controller);
            active -= 1;
            if (error instanceof AttemptAborted) {
              if (!settled && active === 0 && nextIndex >= maxAttempts) {
                finish(() => reject(lastAttemptError ?? new NvidiaProviderError('nvidia_upstream_error', 'All NVIDIA attempts aborted.', { statusCode: 502, fallbackEligible: true })));
              }
              return;
            }
            const providerError = error instanceof NvidiaProviderError
              ? error
              : new NvidiaProviderError('nvidia_upstream_error', error instanceof Error ? error.message : String(error), {
                statusCode: 502,
                fallbackEligible: true,
                upstreamModel: model,
                cause: error,
              });
            const isLocalBudget = (providerError as NvidiaProviderError & { localBudget?: boolean }).localBudget === true;
            if (!isLocalBudget) {
              // Local budget exhaustion is key-wide, not this model's fault: keep it
              // out of the scoreboard so a busy minute can't cool down healthy models.
              const retryAfterMs = (providerError as NvidiaProviderError & { retryAfterMs?: number | null }).retryAfterMs ?? null;
              scoreboard.recordFailure(model, {
                code: providerError.code,
                status: providerError.options.statusCode ?? null,
                latencyMs: null,
                timeout: providerError.code === 'nvidia_timeout',
                retryAfterMs,
                source,
              });
            }
            attempts.push({
              model,
              backend: 'nvidia',
              provider: 'nvidia',
              reason: providerError.code,
              statusCode: providerError.options.statusCode ?? null,
            });
            lastAttemptError = providerError;
            lastError = providerError.message;
            lastFailureAt = new Date().toISOString();

            if (settled) return;
            // A key-wide budget rejection would fail every candidate identically.
            if (isLocalBudget || providerError.options.fallbackEligible === false || nextIndex >= maxAttempts) {
              if (active === 0) {
                finish(() => reject(new NvidiaProviderError(providerError.code as NvidiaErrorCode, providerError.message, {
                  ...providerError.options,
                  fallbackAttempts: attempts,
                  lastUpstreamError,
                })));
              }
              return;
            }
            launchNext();
            scheduleHedge();
          });
      };

      launchNext();
      scheduleHedge();
    });
  }

  async function runProbe(): Promise<void> {
    if (probeRunning || !config.enabled || !config.apiKey) return;
    probeRunning = true;
    try {
      const targets = [...catalog.values()].filter((model) => model.enabled && model.probe !== false);
      for (const target of targets) {
        if (scoreboard.isCoolingDown(target.id)) continue;
        // Leave the bulk of the RPM budget to real traffic.
        pruneRpmWindow();
        if (rpmEvents.length >= Math.max(1, Math.floor(config.rpmLimit / 2))) break;
        const controller = new AbortController();
        try {
          const result = await runAttempt(
            target.id,
            [{ role: 'user', content: PROBE_PROMPT }],
            { maxTokens: config.probeMaxTokens, temperature: 0 },
            controller.signal,
            () => {},
          );
          scoreboard.recordSuccess(target.id, {
            latencyMs: result.latencyMs,
            ttfbMs: result.ttfbMs,
            completionTokens: result.usage.completionTokens ?? null,
            source: 'probe',
          });
          lastProbeError = null;
        } catch (error) {
          const providerError = error instanceof NvidiaProviderError ? error : null;
          scoreboard.recordFailure(target.id, {
            code: providerError?.code ?? 'nvidia_upstream_error',
            status: providerError?.options.statusCode ?? null,
            timeout: providerError?.code === 'nvidia_timeout',
            retryAfterMs: providerError
              ? (providerError as NvidiaProviderError & { retryAfterMs?: number | null }).retryAfterMs ?? null
              : null,
            source: 'probe',
          });
          lastProbeError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
      }
      lastProbeAt = new Date().toISOString();
    } finally {
      probeRunning = false;
    }
  }

  if (config.enabled && config.probeEnabled && config.probeIntervalMs > 0) {
    probeTimer = setInterval(() => { void runProbe(); }, config.probeIntervalMs);
    probeTimer.unref?.();
    // Prime the scoreboard shortly after boot so ranking has fresh data.
    const bootProbe = setTimeout(() => { void runProbe(); }, 60_000);
    bootProbe.unref?.();
  }

  return {
    provider: 'nvidia',
    model: 'nvidia-auto',

    async chat(messages, opts): Promise<LLMResponse> {
      return generate(messages, opts);
    },

    async *streamChat(messages, opts): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
      const response = await generate(messages, opts);
      if (response.content) yield { content: response.content };
      return response;
    },

    getDiagnostics(): Record<string, unknown> {
      const now = new Date();
      const nowMs = now.getTime();
      pruneRpmWindow(nowMs);
      const snapshot = scoreboard.snapshot();
      return {
        provider: 'nvidia',
        enabled: config.enabled,
        available: config.enabled && Boolean(config.apiKey) && catalog.size > 0,
        baseUrl: config.baseUrl,
        keyPreview: config.apiKey ? sanitizeKeyPreview(config.apiKey) : null,
        rpm: { used: rpmEvents.length, limit: config.rpmLimit },
        inflight,
        maxConcurrency: config.maxConcurrency,
        race: {
          enabled: config.raceEnabled,
          hedgeDelayMs: config.raceHedgeDelayMs,
          maxCandidates: config.raceMaxCandidates,
        },
        probe: {
          enabled: config.probeEnabled,
          intervalMs: config.probeIntervalMs,
          lastProbeAt,
          lastProbeError,
        },
        models: [...catalog.values()].map((model) => {
          const score = snapshot.models[model.id];
          const stats = scoreboard.modelStats(model.id, now);
          return {
            id: model.id,
            tier: model.tier,
            enabled: model.enabled,
            probe: model.probe !== false,
            score: Math.round(scoreboard.score(model.id, now) * 10) / 10,
            coolingDown: scoreboard.isCoolingDown(model.id, nowMs),
            cooldownUntil: score?.cooldownUntil ?? null,
            consecutiveFailures: score?.consecutiveFailures ?? 0,
            lastStatus: score?.lastStatus ?? null,
            lastLatencyMs: score?.lastLatencyMs ?? null,
            lastErrorCode: score?.lastErrorCode ?? null,
            lastAt: score?.lastAt ?? null,
            hour: stats.hour,
            overall: stats.overall,
          };
        }).sort((left, right) => right.score - left.score),
        lastResolvedModel,
        lastError,
        lastUpstreamError,
        lastSuccessAt,
        lastFailureAt,
        lastLatencyMs,
        scoreboardUpdatedAt: snapshot.updatedAt,
      };
    },

    health(): Record<string, unknown> {
      return this.getDiagnostics?.() ?? {};
    },

    scoreboardReport(): Record<string, unknown> {
      return { ok: true, hourly: scoreboard.hourlyReport(), updatedAt: scoreboard.snapshot().updatedAt };
    },

    resetScoreboard(): Record<string, unknown> {
      scoreboard.reset();
      return { ok: true };
    },

    async probeNow(): Promise<Record<string, unknown>> {
      await runProbe();
      return { ok: true, lastProbeAt, lastProbeError };
    },

    async listUpstreamModels(): Promise<Record<string, unknown>> {
      try {
        const response = await fetch(`${config.baseUrl}/v1/models`, {
          headers: { authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(20_000),
        });
        const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }> };
        if (!response.ok) return { ok: false, status: response.status };
        return { ok: true, models: (payload.data ?? []).map((model) => String(model.id ?? '')).filter(Boolean).sort() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  } as LLMClient & {
    health: () => Record<string, unknown>;
    scoreboardReport: () => Record<string, unknown>;
    resetScoreboard: () => Record<string, unknown>;
    probeNow: () => Promise<Record<string, unknown>>;
    listUpstreamModels: () => Promise<Record<string, unknown>>;
  };
}
