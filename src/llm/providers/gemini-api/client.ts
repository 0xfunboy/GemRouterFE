import { applySemanticPrompt, normalizeSemanticOutput } from '../../../lib/semantics.js';
import { GeminiApiProviderError } from './errors.js';
import { GeminiApiKeyPool, type GeminiApiKeyReservation } from './keyPool.js';
import { GeminiApiModelDiscovery } from './modelDiscovery.js';
import { GeminiApiQuotaLedger } from './quotaLedger.js';
import { getAiStudioQuotaScraperSnapshot } from './aistudioQuotaScraper.js';
import type { GeminiApiProviderConfig, GeminiApiUpstreamErrorSnapshot } from './types.js';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../../types.js';

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
}

interface GeminiApiGoogleError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: unknown[];
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

const KEY_RE = /AIza[0-9A-Za-z_-]{10,}/g;

function redact(value: string): string {
  return value.replace(KEY_RE, (match) => `${match.slice(0, 4)}...${match.slice(-4)}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function estimateTokens(messages: LLMMessage[]): number {
  const chars = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function normalizeGeminiApiModel(model: string | undefined): string {
  const normalized = String(model ?? 'gemini-2.5-flash-lite').trim().toLowerCase();
  if (normalized === 'google/gemini-web' || normalized === 'gemini-web') return 'gemini-2.5-flash-lite';
  return normalized.replace(/^models\//, '');
}

function toGenerationBody(messages: LLMMessage[], opts?: LLMOptions): Record<string, unknown> {
  const semanticMessages = opts?.semanticProfile ? applySemanticPrompt(messages, opts.semanticProfile) : messages;
  const systemTexts = semanticMessages.filter((message) => message.role === 'system').map((message) => message.content.trim()).filter(Boolean);
  const contents = semanticMessages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));
  const body: Record<string, unknown> = {
    contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: '' }] }],
  };
  if (systemTexts.length > 0) {
    body.systemInstruction = {
      parts: [{ text: systemTexts.join('\n\n') }],
    };
  }
  const generationConfig: Record<string, unknown> = {};
  if (typeof opts?.temperature === 'number') generationConfig.temperature = opts.temperature;
  if (typeof opts?.maxTokens === 'number') generationConfig.maxOutputTokens = opts.maxTokens;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  return body;
}

function extractText(payload: GeminiGenerateResponse): string {
  return (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function parseGoogleError(payload: unknown): {
  message: string | null;
  status: string | null;
  reason: string | null;
  code: string | null;
} {
  const error = (payload as GeminiApiGoogleError | null)?.error;
  const reason = error?.errors?.find((entry) => entry.reason)?.reason ?? null;
  return {
    message: error?.message ?? null,
    status: error?.status ?? null,
    reason,
    code: typeof error?.code === 'number' ? String(error.code) : null,
  };
}

function mapErrorCode(status: number): {
  code: ConstructorParameters<typeof GeminiApiProviderError>[0];
  fallbackEligible: boolean;
} {
  if (status === 400) return { code: 'gemini_api_invalid_request', fallbackEligible: false };
  if (status === 401 || status === 403) return { code: 'gemini_api_auth_failed', fallbackEligible: true };
  if (status === 404) return { code: 'gemini_api_model_not_found', fallbackEligible: true };
  if (status === 429) return { code: 'gemini_api_rate_limited', fallbackEligible: true };
  return { code: 'gemini_api_upstream_error', fallbackEligible: true };
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function buildEndpoint(config: GeminiApiProviderConfig, model: string, stream = false): string {
  const base = `${config.baseUrl.replace(/\/+$/, '')}/${config.version}/models/${encodeURIComponent(model)}`;
  return stream ? `${base}:streamGenerateContent` : `${base}:generateContent`;
}

function withKey(endpoint: string, key: string, stream = false): string {
  const url = new URL(endpoint);
  if (stream) url.searchParams.set('alt', 'sse');
  url.searchParams.set('key', key);
  return url.toString();
}

function sanitizeKeyPreview(key: string): string {
  return key.length <= 10 ? 'configured' : `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function configuredQuotaGroups(config: GeminiApiProviderConfig, ledgerGroups: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map(ledgerGroups.map((group) => [String(group.id), group]));
  const modelIds = Object.keys(config.limits);
  for (const key of config.keys) {
    if (byId.has(key.quotaGroup)) continue;
    byId.set(key.quotaGroup, {
      id: key.quotaGroup,
      models: modelIds.map((model) => {
        const limit = config.limits[model] ?? { rpm: null, tpm: null, rpd: null };
        return {
          model,
          rpm: { used: 0, limit: limit.rpm, remaining: limit.rpm },
          tpm: { used: 0, limit: limit.tpm, remaining: limit.tpm },
          rpd: { used: 0, limit: limit.rpd, remaining: limit.rpd },
          cooldownUntil: null,
          last429At: null,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastFailureCode: null,
          lastFailureReason: null,
          lastFailureStatus: null,
          source: 'static-config',
          authoritative: false,
        };
      }),
    });
  }
  return [...byId.values()];
}

export function createGeminiApiClient(config: GeminiApiProviderConfig): LLMClient {
  const ledger = new GeminiApiQuotaLedger(config);
  const keyPool = new GeminiApiKeyPool(config, ledger);
  const discovery = new GeminiApiModelDiscovery(config);
  let lastSelectedKeyId: string | null = null;
  let lastSelectedQuotaGroup: string | null = null;
  let lastResolvedModel: string | null = null;
  let lastError: string | null = null;
  let lastUpstreamError: GeminiApiUpstreamErrorSnapshot | null = null;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastLatencyMs: number | null = null;

  async function generate(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    if (!config.enabled) {
      throw new GeminiApiProviderError('backend_disabled', 'Gemini API backend is disabled.', {
        statusCode: 503,
        fallbackEligible: true,
      });
    }
    void discovery.refreshIfStale();
    const started = Date.now();
    const model = normalizeGeminiApiModel(opts?.model);
    const estimatedTokens = estimateTokens(messages);
    const reservation = keyPool.reserve(model, estimatedTokens);
    lastSelectedKeyId = reservation.key.id;
    lastSelectedQuotaGroup = reservation.key.quotaGroup;
    lastResolvedModel = model;
    const endpoint = buildEndpoint(config, model);

    try {
      const response = await fetch(withKey(endpoint, reservation.key.key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toGenerationBody(messages, opts)),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throwGeminiError(response, payload, endpoint, model, reservation);
      }
      const gemini = payload as GeminiGenerateResponse;
      const content = normalizeSemanticOutput(extractText(gemini), opts?.semanticProfile);
      const usage = gemini.usageMetadata;
      ledger.markSuccess({
        quotaGroup: reservation.key.quotaGroup,
        keyId: reservation.key.id,
        model,
        requestId: reservation.requestId,
        totalTokens: usage?.totalTokenCount,
      });
      lastError = null;
      lastUpstreamError = null;
      lastSuccessAt = nowIso();
      lastLatencyMs = Date.now() - started;
      return {
        content,
        provider: 'gemini-api',
        model: opts?.model ?? model,
        backend: 'gemini-api',
        backendModel: model,
        apiKeyId: reservation.key.id,
        quotaGroup: reservation.key.quotaGroup,
        quotaSource: 'local-ledger',
        usage: {
          promptTokens: usage?.promptTokenCount,
          completionTokens: usage?.candidatesTokenCount,
          totalTokens: usage?.totalTokenCount,
        },
        tokensUsed: usage?.totalTokenCount,
        latencyMs: lastLatencyMs,
      };
    } catch (error) {
      const providerError = normalizeError(error, endpoint, model, reservation);
      lastError = providerError.message;
      lastFailureAt = nowIso();
      lastLatencyMs = Date.now() - started;
      throw providerError;
    }
  }

  function throwGeminiError(
    response: Response,
    payload: unknown,
    endpoint: string,
    model: string,
    reservation: GeminiApiKeyReservation,
  ): never {
    const googleError = parseGoogleError(payload);
    const mapped = mapErrorCode(response.status);
    lastUpstreamError = {
      status: response.status,
      code: googleError.code,
      message: redact(googleError.message ?? response.statusText),
      googleStatus: googleError.status,
      googleReason: googleError.reason,
      endpoint: endpoint.replace(/\?.*$/, ''),
      model,
      keyId: reservation.key.id,
      quotaGroup: reservation.key.quotaGroup,
      at: nowIso(),
    };
    ledger.markFailure({
      quotaGroup: reservation.key.quotaGroup,
      keyId: reservation.key.id,
      model,
      requestId: reservation.requestId,
      code: mapped.code,
      reason: googleError.reason ?? googleError.status ?? response.statusText,
      status: response.status,
      rateLimited: response.status === 429,
      retryAfterMs: retryAfterMs(response),
    });
    throw new GeminiApiProviderError(
      mapped.code,
      redact(googleError.message ?? `Gemini API request failed with HTTP ${response.status}`),
      {
        statusCode: response.status,
        fallbackEligible: mapped.fallbackEligible,
        lastUpstreamError,
      },
    );
  }

  function normalizeError(
    error: unknown,
    endpoint: string,
    model: string,
    reservation: GeminiApiKeyReservation,
  ): GeminiApiProviderError {
    if (error instanceof GeminiApiProviderError) return error;
    const isTimeout = error instanceof Error && /aborted|timeout/i.test(error.message);
    const code = isTimeout ? 'gemini_api_timeout' : 'gemini_api_upstream_error';
    lastUpstreamError = {
      status: null,
      code,
      message: redact(error instanceof Error ? error.message : String(error)),
      googleStatus: null,
      googleReason: null,
      endpoint: endpoint.replace(/\?.*$/, ''),
      model,
      keyId: reservation.key.id,
      quotaGroup: reservation.key.quotaGroup,
      at: nowIso(),
    };
    ledger.markFailure({
      quotaGroup: reservation.key.quotaGroup,
      keyId: reservation.key.id,
      model,
      requestId: reservation.requestId,
      code,
      reason: lastUpstreamError.message ?? undefined,
    });
    return new GeminiApiProviderError(code, lastUpstreamError.message ?? 'Gemini API request failed.', {
      statusCode: isTimeout ? 504 : 502,
      fallbackEligible: true,
      lastUpstreamError,
      cause: error,
    });
  }

  return {
    provider: 'gemini-api',
    model: 'gemini-2.5-flash-lite',

    async chat(messages, opts): Promise<LLMResponse> {
      return generate(messages, opts);
    },

    async *streamChat(messages, opts): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
      const response = await generate(messages, opts);
      if (response.content) yield { content: response.content };
      return response;
    },

    getDiagnostics(): Record<string, unknown> {
      const quota = ledger.snapshot();
      const discoverySnapshot = discovery.snapshot();
      const quotaGroups = configuredQuotaGroups(config, quota.quotaGroups as unknown as Array<Record<string, unknown>>);
      return {
        provider: 'gemini-api',
        enabled: config.enabled,
        available: config.enabled && config.keys.some((key) => key.enabled),
        configuredKeyCount: config.keys.length,
        usableKeyCount: config.keys.filter((key) => key.enabled).length,
        defaultTier: config.defaultTier,
        baseUrl: config.baseUrl,
        version: config.version,
        keys: config.keys.map((key) => ({
          id: key.id,
          preview: sanitizeKeyPreview(key.key),
          owner: key.owner ?? null,
          projectId: key.projectId ?? null,
          quotaGroup: key.quotaGroup,
          priority: key.priority,
          enabled: key.enabled,
          models: key.models ?? [],
          lastUsedAt: quota.apiKeys.find((entry) => entry.keyId === key.id)?.lastUsedAt ?? null,
        })),
        quotaGroups,
        quotaUpdatedAt: quota.updatedAt,
        modelDiscovery: {
          lastRefreshAt: discoverySnapshot.updatedAt || null,
          lastError: discoverySnapshot.lastError,
        },
        models: discoverySnapshot.models,
        aiStudioQuotaScraper: getAiStudioQuotaScraperSnapshot(),
        lastSelectedKeyId,
        lastSelectedQuotaGroup,
        lastResolvedModel,
        lastError,
        lastFailureAt,
        lastSuccessAt,
        lastLatencyMs,
        lastUpstreamError,
      };
    },

    health(): Record<string, unknown> {
      return this.getDiagnostics?.() ?? {};
    },

    async discoverModels(): Promise<Record<string, unknown>> {
      const models = await discovery.refresh();
      return {
        ok: true,
        models,
        modelDiscovery: discovery.snapshot(),
      };
    },

    clearCooldown(): Record<string, unknown> {
      ledger.clearCooldown();
      return {
        ok: true,
        quota: ledger.snapshot(),
      };
    },
  } as LLMClient & {
    health: () => Record<string, unknown>;
    discoverModels: () => Promise<Record<string, unknown>>;
    clearCooldown: () => Record<string, unknown>;
  };
}
