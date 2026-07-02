import {
  isGeminiEmbeddingModelId,
  isGeminiImageGenerationModelId,
  isGeminiLiveModelId,
  isGeminiLongRunningModelId,
  isGeminiNativeAudioModelId,
  isGeminiTtsModelId,
} from '../../../lib/models.js';
import { applySemanticPrompt, normalizeSemanticOutput } from '../../../lib/semantics.js';
import { GeminiApiProviderError } from './errors.js';
import { GeminiApiKeyPool, type GeminiApiKeyReservation, type GeminiApiLocalBackpressure } from './keyPool.js';
import { GeminiApiModelDiscovery } from './modelDiscovery.js';
import { GeminiApiQuotaLedger } from './quotaLedger.js';
import type { GeminiApiKeyConfig, GeminiApiModelInfo, GeminiApiProviderConfig, GeminiApiUpstreamErrorSnapshot } from './types.js';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../../types.js';

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
        inline_data?: {
          mime_type?: string;
          data?: string;
        };
        thought?: boolean;
      }>;
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

const KEY_RE = /(?:AIza[0-9A-Za-z_-]{10,}|AQ\.[0-9A-Za-z_-]{20,})/g;

function redact(value: string): string {
  return value.replace(KEY_RE, (match) => `${match.slice(0, 4)}...${match.slice(-4)}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new HedgedRequestCancelled());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new HedgedRequestCancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function estimatePromptTokens(messages: LLMMessage[]): number {
  const chars = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateReservationTokens(messages: LLMMessage[], _opts?: LLMOptions): number {
  return estimatePromptTokens(messages);
}

function normalizeGeminiApiModel(model: string | undefined): string {
  const normalized = String(model ?? 'gemini-3.5-flash').trim().toLowerCase();
  return normalized.replace(/^models\//, '');
}

// A completion that comes back with no visible text (e.g. truncated to length with 0 output
// tokens) is retried on the same model with a larger output budget this many times before
// falling through to the next model in the chain.
const EMPTY_RESPONSE_RETRY_LIMIT = 2;
const EMPTY_RESPONSE_RETRY_TOKENS = 1024;
const GEMMA_31B_HEDGED_MODEL = 'gemma-4-31b-it';
const GEMMA_HEDGED_FALLBACK_MODELS = [
  'gemma-4-26b-a4b-it',
] as const;
const GEMMA_HEDGED_SECOND_WAVE_MODELS = [
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-flash-lite',
] as const;
const GEMMA_HEDGED_SECOND_WAVE_DELAY_MS = 30_000;
const LOCAL_BACKPRESSURE_MAX_WAIT_MS = 65_000;

class HedgedRequestCancelled extends Error {
  constructor() {
    super('Gemini API hedged request was cancelled after another model won.');
    this.name = 'HedgedRequestCancelled';
  }
}

function buildThinkingConfig(modelId: string | undefined, opts?: LLMOptions): Record<string, unknown> | null {
  const model = normalizeGeminiApiModel(modelId);
  // Gemma 4 and Gemini 3.5 reject any thinkingConfig, including an otherwise harmless
  // `includeThoughts: false`. Omit the field entirely for those models.
  if (!model.startsWith('gemini-') || /^gemma-/i.test(model) || /^gemini-3\.5-flash/i.test(model)) {
    return null;
  }
  const includeThoughts = opts?.thinking?.includeThoughts === true;
  // gemini-3.5-flash rejects thinkingLevel ("Thinking level is not supported for this model"),
  // so only the gemini-3 reasoning variants (pro / flash-preview / 3.1) get a thinkingLevel.
  if (/^gemini-3/i.test(model) && !/^gemini-3\.5-flash/i.test(model)) {
    return {
      includeThoughts,
      thinkingLevel: opts?.thinking?.thinkingLevel ?? 'minimal',
    };
  }
  if (/^gemini-2\.5-(?:flash|flash-lite)/i.test(model)) {
    return {
      includeThoughts,
      thinkingBudget: typeof opts?.thinking?.thinkingBudget === 'number' ? opts.thinking.thinkingBudget : 0,
    };
  }
  if (/^gemini-2\.5-pro/i.test(model)) {
    return { includeThoughts };
  }
  return { includeThoughts };
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
  const thinkingConfig = buildThinkingConfig(opts?.model, opts);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (Array.isArray(opts?.imageConfig?.responseModalities) && opts.imageConfig.responseModalities.length > 0) {
    generationConfig.responseModalities = opts.imageConfig.responseModalities;
  }
  if (opts?.imageConfig?.aspectRatio || opts?.imageConfig?.imageSize) {
    generationConfig.responseFormat = {
      image: {
        ...(opts.imageConfig.aspectRatio ? { aspectRatio: opts.imageConfig.aspectRatio } : {}),
        ...(opts.imageConfig.imageSize ? { imageSize: opts.imageConfig.imageSize } : {}),
      },
    };
  }
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  return body;
}

function extractParts(payload: GeminiGenerateResponse): Array<{
  text?: string;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
  inline_data?: {
    mime_type?: string;
    data?: string;
  };
  thought?: boolean;
}> {
  return payload.candidates?.[0]?.content?.parts ?? [];
}

function extractText(payload: GeminiGenerateResponse): string {
  return extractParts(payload)
    .filter((part) => part.thought !== true)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function normalizeFinishReason(payload: GeminiGenerateResponse): 'stop' | 'length' | 'content_filter' {
  const reason = payload.candidates?.[0]?.finishReason?.trim().toUpperCase() ?? '';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST') return 'content_filter';
  return 'stop';
}

function extractImages(payload: GeminiGenerateResponse): Array<{ mimeType: string; data: string }> {
  return extractParts(payload)
    .map((part) => {
      const inlineData = part.inlineData ?? (
        part.inline_data
          ? {
            mimeType: part.inline_data.mime_type,
            data: part.inline_data.data,
          }
          : undefined
      );
      if (!inlineData?.mimeType || !inlineData?.data) return null;
      return {
        mimeType: inlineData.mimeType,
        data: inlineData.data,
      };
    })
    .filter((entry): entry is { mimeType: string; data: string } => entry !== null);
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

function isHighDemandCondition(
  status: number,
  googleError: ReturnType<typeof parseGoogleError>,
): boolean {
  if (status !== 503) return false;
  const text = [
    googleError.status,
    googleError.reason,
    googleError.message,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
  return (
    text.includes('high demand') ||
    text.includes('unavailable') ||
    text.includes('overloaded') ||
    text.includes('capacity') ||
    text.includes('try again')
  );
}

function mapErrorCode(
  status: number,
  googleError: ReturnType<typeof parseGoogleError>,
): {
  code: ConstructorParameters<typeof GeminiApiProviderError>[0];
  fallbackEligible: boolean;
} {
  if (status === 400) return { code: 'gemini_api_invalid_request', fallbackEligible: false };
  if (status === 401 || status === 403) return { code: 'gemini_api_auth_failed', fallbackEligible: true };
  if (status === 404) return { code: 'gemini_api_model_not_found', fallbackEligible: true };
  if (status === 429) return { code: 'gemini_api_rate_limited', fallbackEligible: true };
  if (isHighDemandCondition(status, googleError)) return { code: 'gemini_api_high_demand', fallbackEligible: true };
  return { code: 'gemini_api_upstream_error', fallbackEligible: true };
}

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
  if (!match?.[1]) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

function googleRetryDelayMs(payload: unknown): number | undefined {
  const details = (payload as GeminiApiGoogleError | null)?.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    const value = detail as Record<string, unknown>;
    const delay = parseDurationMs(value.retryDelay ?? value.retry_delay);
    if (delay !== undefined) return delay;
  }
  return undefined;
}

function retryAfterMs(response: Response, payload: unknown): number | undefined {
  const value = response.headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  return googleRetryDelayMs(payload);
}

function rateLimitScope(payload: unknown, googleError: ReturnType<typeof parseGoogleError>): 'minute' | 'day' | 'unknown' {
  const text = [
    googleError.message,
    googleError.status,
    googleError.reason,
    JSON.stringify((payload as GeminiApiGoogleError | null)?.error?.details ?? []),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/per.?day|requestsperday|rpd|daily/.test(text)) return 'day';
  if (/per.?minute|requestsperminute|tokensperminute|rpm|tpm|minute/.test(text)) {
    return 'minute';
  }
  return 'unknown';
}

// Capture any header whose name contains quota/ratelimit keywords - works regardless of exact names Gemini uses
function captureRateLimitHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (/ratelimit|rate-limit|quota|x-goog-quota/i.test(key)) {
      result[key.toLowerCase()] = value;
    }
  });
  return result;
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

function hasAnotherConfiguredKeyForModel(
  config: GeminiApiProviderConfig,
  model: string,
  excludedKeyIds: Set<string>,
): boolean {
  return config.keys.some((key) => (
    key.enabled &&
    !excludedKeyIds.has(key.id) &&
    (!key.models || key.models.length === 0 || key.models.includes(model))
  ));
}

function keyAllowsModel(key: { models?: string[] }, model: string): boolean {
  return !key.models || key.models.length === 0 || key.models.includes(model);
}

function shouldRetryWithAnotherKey(error: GeminiApiProviderError): boolean {
  switch (error.code) {
    case 'gemini_api_auth_failed':
    case 'gemini_api_no_key_for_model':
    case 'gemini_api_rate_limited':
    case 'gemini_api_quota_unavailable':
    case 'gemini_api_model_not_found':
    case 'gemini_api_upstream_error':
    case 'gemini_api_timeout':
      return true;
    // gemini_api_high_demand (503 overloaded) is a model-wide condition on Google's side:
    // every account hits the same backend, so retrying other keys is pointless. Skip
    // straight to the next fallback model instead and let the 30s cooldown park this one.
    case 'gemini_api_high_demand':
      return false;
    default:
      return false;
  }
}

function localAvailabilityReasonLabel(input: {
  availability: ReturnType<GeminiApiQuotaLedger['getAvailability']>;
  fallbackCode: string;
}): string {
  const { availability } = input;
  if (availability.reason === 'rpm' && availability.limit.rpm === 0) return 'local_rpm_limit_zero';
  if (availability.reason === 'tpm' && availability.limit.tpm === 0) return 'local_tpm_limit_zero';
  if (availability.reason === 'rpd' && availability.limit.rpd === 0) return 'local_rpd_limit_zero';
  return availability.reason ? `local_${availability.reason}_unavailable` : input.fallbackCode;
}

function withFallbackHistory(
  error: GeminiApiProviderError,
  attempts: NonNullable<LLMResponse['fallbackAttempts']>,
  currentModel?: string,
): GeminiApiProviderError {
  const lastAttempt = attempts.at(-1);
  return new GeminiApiProviderError(error.code as ConstructorParameters<typeof GeminiApiProviderError>[0], error.message, {
    ...error.options,
    fallbackReason: error.options.fallbackReason ?? error.code,
    fallbackAttempts: attempts.length > 0 ? [...attempts] : error.options.fallbackAttempts,
    upstreamModel: error.options.upstreamModel ?? lastAttempt?.model ?? currentModel ?? null,
    upstreamApiKeyId: error.options.upstreamApiKeyId ?? lastAttempt?.keyId ?? null,
    upstreamQuotaGroup: error.options.upstreamQuotaGroup ?? lastAttempt?.quotaGroup ?? null,
    lastUpstreamError: (error.options.lastUpstreamError as GeminiApiUpstreamErrorSnapshot | null | undefined) ?? undefined,
  });
}

function appendLocalAvailabilityAttempts(input: {
  attempts: NonNullable<LLMResponse['fallbackAttempts']>;
  config: GeminiApiProviderConfig;
  ledger: GeminiApiQuotaLedger;
  model: string;
  estimatedTokens: number;
  error: GeminiApiProviderError;
}): void {
  const eligibleKeys = input.config.keys
    .filter((key) => key.enabled)
    .filter((key) => keyAllowsModel(key, input.model));
  if (eligibleKeys.length === 0) {
    input.attempts.push({
      model: input.model,
      backend: 'gemini-api',
      provider: 'gemini-api',
      keyId: null,
      quotaGroup: null,
      reason: input.error.code,
      statusCode: input.error.options.statusCode ?? null,
      availableAfter: null,
      availableAfterSource: null,
    });
    return;
  }
  for (const key of eligibleKeys) {
    const availability = input.ledger.getAvailability(key.quotaGroup, input.model, input.estimatedTokens);
    input.attempts.push({
      model: input.model,
      backend: 'gemini-api',
      provider: 'gemini-api',
      keyId: key.id,
      quotaGroup: key.quotaGroup,
      reason: localAvailabilityReasonLabel({
        availability,
        fallbackCode: input.error.code,
      }),
      statusCode: input.error.options.statusCode ?? null,
      availableAfter: availability.cooldownUntil,
      availableAfterSource: availability.cooldownSource,
    });
  }
}

function shouldRetryReservationFailure(
  error: unknown,
  remainingModels: string[],
  opts?: LLMOptions,
): error is GeminiApiProviderError {
  return error instanceof GeminiApiProviderError && shouldRetryWithFallbackModel(error, remainingModels, opts);
}

function isPureImageRequest(opts?: LLMOptions): boolean {
  const modalities = opts?.imageConfig?.responseModalities;
  return Array.isArray(modalities) && modalities.length > 0 && modalities.every((value) => value === 'IMAGE');
}

function isTextFallbackModelCandidate(
  modelId: string,
  supportedGenerationMethods?: string[],
): boolean {
  if (!modelId.trim()) return false;
  if (isGeminiImageGenerationModelId(modelId)) return false;
  if (isGeminiLiveModelId(modelId)) return false;
  if (isGeminiEmbeddingModelId(modelId)) return false;
  if (isGeminiLongRunningModelId(modelId)) return false;
  if (isGeminiNativeAudioModelId(modelId)) return false;
  if (isGeminiTtsModelId(modelId)) return false;
  if (Array.isArray(supportedGenerationMethods) && supportedGenerationMethods.length > 0) {
    const methods = new Set(supportedGenerationMethods.map((method) => method.trim()));
    return methods.has('generateContent');
  }
  return true;
}

function parseModelVersion(modelId: string): number {
  const match = normalizeGeminiApiModel(modelId).match(/^(?:gemini|gemma)-(\d+(?:\.\d+)?)/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

function classifyTextModel(modelId: string): {
  normalized: string;
  family: string;
  version: number;
  isPro: boolean;
  isFlash: boolean;
  isLite: boolean;
  isPreview: boolean;
} {
  const normalized = normalizeGeminiApiModel(modelId);
  return {
    normalized,
    family: normalized.startsWith('gemma-') ? 'gemma' : 'gemini',
    version: parseModelVersion(normalized),
    isPro: /(^|-)pro(?:-|$)/i.test(normalized),
    isFlash: /flash/i.test(normalized),
    isLite: /lite/i.test(normalized),
    isPreview: /preview/i.test(normalized),
  };
}

function baseTextModelRank(modelId: string): number {
  const model = classifyTextModel(modelId);
  if (model.isPro) return 420;
  if (model.isFlash && !model.isLite) return 320;
  if (model.isFlash && model.isLite) return 280;
  return 180;
}

function textFallbackScore(requestedModelId: string, candidateModelId: string): number {
  const requested = classifyTextModel(requestedModelId);
  const candidate = classifyTextModel(candidateModelId);
  let score = baseTextModelRank(candidate.normalized);

  if (requested.family === candidate.family) score += 24;
  if (requested.isPro && candidate.isPro) score += 180;
  else if (requested.isPro && candidate.isFlash) score += 96;
  else if (requested.isFlash && candidate.isFlash) score += 140;
  else if (requested.isFlash && candidate.isPro) score += 116;
  else if (requested.isLite && candidate.isLite) score += 36;

  if (requested.isLite === candidate.isLite) score += 12;
  if (requested.isPreview === candidate.isPreview) score += 8;

  const versionDistance = Math.abs(requested.version - candidate.version);
  score += Math.max(0, 60 - Math.round(versionDistance * 24));

  if (candidate.version > requested.version) score += 6;
  return score;
}

function buildTextFallbackModels(
  requestedModelId: string,
  allowedModelIds: string[] | undefined,
  preferredFallbackModelIds: string[] | undefined,
  discoveredModels: GeminiApiModelInfo[],
  opts?: LLMOptions,
): string[] {
  if (isPureImageRequest(opts)) return [];
  if (!Array.isArray(allowedModelIds) || allowedModelIds.length === 0) return [];
  const requested = normalizeGeminiApiModel(requestedModelId);
  const allowed = new Set(allowedModelIds.map((modelId) => normalizeGeminiApiModel(modelId)).filter(Boolean));
  const discoveredMethodsById = new Map(
    discoveredModels.map((entry) => [
      normalizeGeminiApiModel(String(entry.id ?? '')),
      Array.isArray(entry.supportedGenerationMethods)
        ? entry.supportedGenerationMethods.map((method) => String(method))
        : [],
    ]),
  );
  const preferred = Array.isArray(preferredFallbackModelIds)
    ? preferredFallbackModelIds.map((modelId) => normalizeGeminiApiModel(modelId)).filter((modelId) => allowed.has(modelId))
    : [];
  const ranked = allowedModelIds
    .map((modelId) => normalizeGeminiApiModel(modelId))
    .filter((modelId) => modelId && modelId !== requested)
    .filter((modelId) => isTextFallbackModelCandidate(modelId, discoveredMethodsById.get(modelId)))
    .sort((left, right) => textFallbackScore(requested, right) - textFallbackScore(requested, left));
  return [...new Set([...preferred, ...ranked])].filter((modelId) => modelId !== requested);
}

function shouldRetryWithFallbackModel(
  error: GeminiApiProviderError,
  remainingModels: string[],
  opts?: LLMOptions,
): boolean {
  if (remainingModels.length === 0) return false;
  if (isPureImageRequest(opts)) return false;
  switch (error.code) {
    case 'gemini_api_auth_failed':
    case 'gemini_api_no_key_for_model':
    case 'gemini_api_rate_limited':
    case 'gemini_api_quota_unavailable':
    case 'gemini_api_high_demand':
    case 'gemini_api_model_not_found':
    case 'gemini_api_upstream_error':
    case 'gemini_api_empty_response':
    case 'gemini_api_timeout':
      return true;
    default:
      return false;
  }
}

function createAttemptOptions(
  opts: LLMOptions | undefined,
  modelId: string,
): LLMOptions | undefined {
  if (!opts) return opts;
  const next = { ...opts, model: modelId };
  if (!next.imageConfig) return next;
  if (isGeminiImageGenerationModelId(modelId)) return next;
  delete next.imageConfig;
  return next;
}

function effectiveRequestTimeoutMs(timeoutMs: number): number {
  // Stay under common reverse-proxy limits so the origin can return a JSON timeout
  // instead of letting an edge proxy replace the response with an HTML 504 page.
  return Math.max(1_000, Math.min(timeoutMs, 90_000));
}

function configuredQuotaGroups(config: GeminiApiProviderConfig, ledgerGroups: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map(ledgerGroups.map((group) => [String(group.id), group]));
  const modelIds = Object.keys(config.limits);
  const configuredModel = (model: string): Record<string, unknown> => {
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
  };
  for (const key of config.keys) {
    const existing = byId.get(key.quotaGroup);
    if (!existing) {
      byId.set(key.quotaGroup, { id: key.quotaGroup, models: modelIds.map(configuredModel) });
      continue;
    }
    const models = Array.isArray(existing.models) ? existing.models as Record<string, unknown>[] : [];
    const knownModels = new Set(models.map((model) => String(model.model)));
    existing.models = [...models, ...modelIds.filter((model) => !knownModels.has(model)).map(configuredModel)];
  }
  return [...byId.values()];
}

export function createGeminiApiClient(config: GeminiApiProviderConfig): LLMClient {
  const ledger = new GeminiApiQuotaLedger(config);
  let keyPool = new GeminiApiKeyPool(config, ledger);
  const discovery = new GeminiApiModelDiscovery(config);
  let lastSelectedKeyId: string | null = null;
  let lastSelectedQuotaGroup: string | null = null;
  let lastResolvedModel: string | null = null;
  let lastError: string | null = null;
  let lastUpstreamError: GeminiApiUpstreamErrorSnapshot | null = null;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastLatencyMs: number | null = null;

  function isGemma31bHedgedRequest(requestedModel: string, opts?: LLMOptions): boolean {
    return requestedModel === GEMMA_31B_HEDGED_MODEL && !isPureImageRequest(opts);
  }

  async function fetchGeneration(
    endpoint: string,
    reservation: GeminiApiKeyReservation,
    messages: LLMMessage[],
    opts: LLMOptions | undefined,
    externalSignal?: AbortSignal,
  ): Promise<{ response: Response; payload: unknown }> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(new Error('gemrouter_attempt_timeout'));
    }, effectiveRequestTimeoutMs(config.timeoutMs));
    const abortFromExternal = (): void => {
      timeoutController.abort(new HedgedRequestCancelled());
    };
    if (externalSignal?.aborted) {
      clearTimeout(timeout);
      throw new HedgedRequestCancelled();
    }
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    try {
      const response = await fetch(withKey(endpoint, reservation.key.key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toGenerationBody(messages, opts)),
        signal: timeoutController.signal,
      });
      const payload = await response.json().catch(() => ({}));
      return { response, payload };
    } catch (error) {
      if (externalSignal?.aborted || error instanceof HedgedRequestCancelled) {
        throw new HedgedRequestCancelled();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  }

  async function reserveWithLocalBackpressure(
    model: string,
    estimatedTokens: number,
    options?: {
      excludeKeyIds?: string[];
      signal?: AbortSignal;
    },
  ): Promise<GeminiApiKeyReservation> {
    while (true) {
      if (options?.signal?.aborted) throw new HedgedRequestCancelled();
      try {
        return keyPool.reserve(model, estimatedTokens, {
          excludeKeyIds: options?.excludeKeyIds,
        });
      } catch (error) {
        if (!(error instanceof GeminiApiProviderError) || error.code !== 'gemini_api_quota_unavailable') throw error;
        const backpressure: GeminiApiLocalBackpressure | null = keyPool.nextLocalBackpressure(model, estimatedTokens, {
          excludeKeyIds: options?.excludeKeyIds,
        });
        if (!backpressure || backpressure.waitMs > LOCAL_BACKPRESSURE_MAX_WAIT_MS) throw error;
        lastError = `local_${backpressure.reason}_backpressure:${model}:${backpressure.quotaGroup}`;
        await sleep(backpressure.waitMs, options?.signal);
      }
    }
  }

  async function runSingleModelAttempt(
    input: {
      messages: LLMMessage[];
      opts?: LLMOptions;
      requestedModel: string;
      model: string;
      estimatedTokens: number;
      started: number;
      fallbackAttempts: NonNullable<LLMResponse['fallbackAttempts']>;
      signal?: AbortSignal;
      claimKeyId?: (keyId: string) => boolean;
      releaseKeyId?: (keyId: string) => void;
    },
  ): Promise<LLMResponse> {
    const { messages, opts, requestedModel, model, estimatedTokens, started, fallbackAttempts, signal, claimKeyId, releaseKeyId } = input;
    const attemptOptions = createAttemptOptions(opts, model);
    const excludedKeyIds = new Set<string>();
    let emptyResponseRetries = 0;
    let effectiveOptions = attemptOptions;
    let lastModelError: GeminiApiProviderError | null = null;

    while (true) {
      if (signal?.aborted) throw new HedgedRequestCancelled();
      let reservation: GeminiApiKeyReservation;
      try {
        reservation = await reserveWithLocalBackpressure(model, estimatedTokens, {
          excludeKeyIds: [...excludedKeyIds],
          signal,
        });
      } catch (error) {
        if (error instanceof GeminiApiProviderError) {
          appendLocalAvailabilityAttempts({
            attempts: fallbackAttempts,
            config,
            ledger,
            model,
            estimatedTokens,
            error,
          });
        }
        throw error instanceof GeminiApiProviderError
          ? withFallbackHistory(error, fallbackAttempts, model)
          : error;
      }
      if (claimKeyId && !claimKeyId(reservation.key.id)) {
        ledger.cancelReservation({
          quotaGroup: reservation.key.quotaGroup,
          keyId: reservation.key.id,
          model,
          requestId: reservation.requestId,
        });
        excludedKeyIds.add(reservation.key.id);
        continue;
      }
      let keyClaimed = claimKeyId ? reservation.key.id : null;

      lastSelectedKeyId = reservation.key.id;
      lastSelectedQuotaGroup = reservation.key.quotaGroup;
      lastResolvedModel = model;
      const endpoint = buildEndpoint(config, model);

      try {
        const { response, payload } = await fetchGeneration(endpoint, reservation, messages, effectiveOptions, signal);
        if (!response.ok) {
          throwGeminiError(response, payload, endpoint, model, reservation);
        }
        const gemini = payload as GeminiGenerateResponse;
        const content = normalizeSemanticOutput(extractText(gemini), attemptOptions?.semanticProfile);
        const finishReason = normalizeFinishReason(gemini);
        const images = extractImages(gemini);
        const usage = gemini.usageMetadata;

        if (content.trim().length === 0 && images.length === 0) {
          if (finishReason === 'length' && emptyResponseRetries < EMPTY_RESPONSE_RETRY_LIMIT) {
            emptyResponseRetries += 1;
            const previous = effectiveOptions?.maxTokens ?? 0;
            effectiveOptions = {
              ...attemptOptions,
              maxTokens: Math.max(previous * 4, EMPTY_RESPONSE_RETRY_TOKENS * emptyResponseRetries),
            };
            continue;
          }
          throw new GeminiApiProviderError('gemini_api_empty_response', `Model ${model} returned an empty completion (finishReason=${finishReason}).`, {
            statusCode: 502,
            fallbackEligible: true,
            upstreamModel: model,
            upstreamApiKeyId: reservation.key.id,
            upstreamQuotaGroup: reservation.key.quotaGroup,
          });
        }

        ledger.markSuccess({
          quotaGroup: reservation.key.quotaGroup,
          keyId: reservation.key.id,
          model,
          requestId: reservation.requestId,
          totalTokens: usage?.totalTokenCount,
          upstreamHeaders: captureRateLimitHeaders(response),
        });
        lastError = null;
        lastUpstreamError = null;
        lastSuccessAt = nowIso();
        lastLatencyMs = Date.now() - started;
        return {
          content,
          finishReason,
          images,
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
          fallbackReason:
            model !== requestedModel
              ? (lastModelError?.code ?? `hedged_model:${requestedModel}`)
              : undefined,
          fallbackAttempts: fallbackAttempts.length > 0 ? fallbackAttempts : undefined,
        };
      } catch (error) {
        if (error instanceof HedgedRequestCancelled) {
          if (keyClaimed) {
            releaseKeyId?.(keyClaimed);
            keyClaimed = null;
          }
          ledger.cancelReservation({
            quotaGroup: reservation.key.quotaGroup,
            keyId: reservation.key.id,
            model,
            requestId: reservation.requestId,
          });
          throw error;
        }
        const providerError = normalizeError(error, endpoint, model, reservation);
        if (keyClaimed) {
          releaseKeyId?.(keyClaimed);
          keyClaimed = null;
        }
        lastModelError = providerError;
        const availability = ledger.getAvailability(reservation.key.quotaGroup, model, estimatedTokens);
        fallbackAttempts.push({
          model,
          backend: 'gemini-api',
          provider: 'gemini-api',
          keyId: reservation.key.id,
          quotaGroup: reservation.key.quotaGroup,
          reason: providerError.code,
          statusCode: providerError.options.statusCode ?? null,
          availableAfter: availability.cooldownUntil,
          availableAfterSource: availability.cooldownSource,
        });
        lastError = providerError.message;
        lastFailureAt = nowIso();
        lastLatencyMs = Date.now() - started;
        excludedKeyIds.add(reservation.key.id);
        if (
          shouldRetryWithAnotherKey(providerError) &&
          hasAnotherConfiguredKeyForModel(config, model, excludedKeyIds)
        ) {
          continue;
        }
        throw withFallbackHistory(providerError, fallbackAttempts, model);
      }
    }
  }

  async function generateGemma31bHedgedRace(
    messages: LLMMessage[],
    opts: LLMOptions | undefined,
    requestedModel: string,
    estimatedTokens: number,
    started: number,
  ): Promise<LLMResponse> {
    const fallbackAttempts: NonNullable<LLMResponse['fallbackAttempts']> = [];
    const controllers: AbortController[] = [];
    const errors: GeminiApiProviderError[] = [];
    const launched = new Set<string>();
    const claimedKeyIds = new Set<string>();
    let active = 0;
    let secondWaveLaunched = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    return await new Promise<LLMResponse>((resolve, reject) => {
      const rejectIfDone = (): void => {
        if (settled || active > 0 || !secondWaveLaunched) return;
        settled = true;
        const error = errors.at(-1) ?? new GeminiApiProviderError(
          'gemini_api_upstream_error',
          'No hedged Gemini API model could satisfy the request.',
          { statusCode: 503, fallbackEligible: true, fallbackAttempts },
        );
        reject(withFallbackHistory(error, fallbackAttempts));
      };

      const launch = (model: string): void => {
        if (settled || launched.has(model)) return;
        launched.add(model);
        const controller = new AbortController();
        controllers.push(controller);
        active += 1;
        runSingleModelAttempt({
          messages,
          opts,
          requestedModel,
          model,
          estimatedTokens,
          started,
          fallbackAttempts,
          signal: controller.signal,
          claimKeyId: (keyId) => {
            if (claimedKeyIds.has(keyId)) return false;
            claimedKeyIds.add(keyId);
            return true;
          },
          releaseKeyId: (keyId) => {
            claimedKeyIds.delete(keyId);
          },
        })
          .then((response) => {
            active -= 1;
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            for (const other of controllers) {
              if (other !== controller) other.abort(new HedgedRequestCancelled());
            }
            resolve(response);
          })
          .catch((error) => {
            active -= 1;
            if (settled) return;
            if (error instanceof GeminiApiProviderError) errors.push(error);
            rejectIfDone();
          });
      };

      launch(GEMMA_31B_HEDGED_MODEL);
      for (const model of GEMMA_HEDGED_FALLBACK_MODELS) launch(model);

      timer = setTimeout(() => {
        if (settled) return;
        secondWaveLaunched = true;
        for (const model of GEMMA_HEDGED_SECOND_WAVE_MODELS) launch(model);
        rejectIfDone();
      }, GEMMA_HEDGED_SECOND_WAVE_DELAY_MS);
    });
  }

  async function generate(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    if (!config.enabled) {
      throw new GeminiApiProviderError('backend_disabled', 'Gemini API backend is disabled.', {
        statusCode: 503,
        fallbackEligible: true,
      });
    }
    void discovery.refreshIfStale();
    const started = Date.now();
    const requestedModel = normalizeGeminiApiModel(opts?.model);
    const estimatedTokens = estimateReservationTokens(messages, opts);
    if (isGemma31bHedgedRequest(requestedModel, opts)) {
      return await generateGemma31bHedgedRace(messages, opts, requestedModel, estimatedTokens, started);
    }
    const modelAttempts = config.strictModelIds.includes(requestedModel)
      ? [requestedModel]
      : [
          requestedModel,
          ...buildTextFallbackModels(
            requestedModel,
            opts?.allowedModelIds,
            config.fallbackModelIds,
            discovery.snapshot().models,
            opts,
          ),
        ];
    let lastProviderError: GeminiApiProviderError | null = null;
    const fallbackAttempts: NonNullable<LLMResponse['fallbackAttempts']> = [];

    for (let modelIndex = 0; modelIndex < modelAttempts.length; modelIndex++) {
      const model = modelAttempts[modelIndex];
      const remainingModels = modelAttempts.slice(modelIndex + 1);
      const attemptOptions = createAttemptOptions(opts, model);
      const excludedKeyIds = new Set<string>();
      let emptyResponseRetries = 0;
      let effectiveOptions = attemptOptions;

      while (true) {
        let reservation: GeminiApiKeyReservation;
        try {
          reservation = await reserveWithLocalBackpressure(model, estimatedTokens, {
            excludeKeyIds: [...excludedKeyIds],
          });
        } catch (error) {
          if (error instanceof GeminiApiProviderError) {
            appendLocalAvailabilityAttempts({
              attempts: fallbackAttempts,
              config,
              ledger,
              model,
              estimatedTokens,
              error,
            });
          }
          if (shouldRetryReservationFailure(error, remainingModels, attemptOptions)) {
            lastProviderError = error;
            break;
          }
          if (lastProviderError) throw withFallbackHistory(lastProviderError, fallbackAttempts, model);
          throw error instanceof GeminiApiProviderError
            ? withFallbackHistory(error, fallbackAttempts, model)
            : error;
        }

        lastSelectedKeyId = reservation.key.id;
        lastSelectedQuotaGroup = reservation.key.quotaGroup;
        lastResolvedModel = model;
        const endpoint = buildEndpoint(config, model);

        try {
          const response = await fetch(withKey(endpoint, reservation.key.key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toGenerationBody(messages, effectiveOptions)),
            signal: AbortSignal.timeout(effectiveRequestTimeoutMs(config.timeoutMs)),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throwGeminiError(response, payload, endpoint, model, reservation);
          }
          const gemini = payload as GeminiGenerateResponse;
          const content = normalizeSemanticOutput(extractText(gemini), attemptOptions?.semanticProfile);
          const finishReason = normalizeFinishReason(gemini);
          const images = extractImages(gemini);
          const usage = gemini.usageMetadata;

          // An empty completion (no text, no image) is never a real success. This happens when
          // the model truncates to the output-token limit before emitting visible text.
          if (content.trim().length === 0 && images.length === 0) {
            // Truncated for length: retry the same model with a larger output budget.
            if (finishReason === 'length' && emptyResponseRetries < EMPTY_RESPONSE_RETRY_LIMIT) {
              emptyResponseRetries += 1;
              const previous = effectiveOptions?.maxTokens ?? 0;
              effectiveOptions = {
                ...attemptOptions,
                maxTokens: Math.max(previous * 4, EMPTY_RESPONSE_RETRY_TOKENS * emptyResponseRetries),
              };
              continue;
            }
            // Still empty (or empty for another reason): fail retryably so the router moves on
            // to the next model in the chain instead of returning an empty 200.
            throw new GeminiApiProviderError('gemini_api_empty_response', `Model ${model} returned an empty completion (finishReason=${finishReason}).`, {
              statusCode: 502,
              fallbackEligible: true,
              upstreamModel: model,
              upstreamApiKeyId: reservation.key.id,
              upstreamQuotaGroup: reservation.key.quotaGroup,
            });
          }

          ledger.markSuccess({
            quotaGroup: reservation.key.quotaGroup,
            keyId: reservation.key.id,
            model,
            requestId: reservation.requestId,
            totalTokens: usage?.totalTokenCount,
            upstreamHeaders: captureRateLimitHeaders(response),
          });
          lastError = null;
          lastUpstreamError = null;
          lastSuccessAt = nowIso();
          lastLatencyMs = Date.now() - started;
          return {
            content,
            finishReason,
            images,
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
            fallbackReason:
              model !== requestedModel
                ? (lastProviderError?.code ?? `fallback_model:${requestedModel}`)
                : undefined,
            fallbackAttempts: fallbackAttempts.length > 0 ? fallbackAttempts : undefined,
          };
        } catch (error) {
          const providerError = normalizeError(error, endpoint, model, reservation);
          lastProviderError = providerError;
          const availability = ledger.getAvailability(reservation.key.quotaGroup, model, estimatedTokens);
          fallbackAttempts.push({
            model,
            backend: 'gemini-api',
            provider: 'gemini-api',
            keyId: reservation.key.id,
            quotaGroup: reservation.key.quotaGroup,
            reason: providerError.code,
            statusCode: providerError.options.statusCode ?? null,
            availableAfter: availability.cooldownUntil,
            availableAfterSource: availability.cooldownSource,
          });
          lastError = providerError.message;
          lastFailureAt = nowIso();
          lastLatencyMs = Date.now() - started;
          excludedKeyIds.add(reservation.key.id);
          if (
            shouldRetryWithAnotherKey(providerError) &&
            hasAnotherConfiguredKeyForModel(config, model, excludedKeyIds)
          ) {
            continue;
          }
          if (shouldRetryWithFallbackModel(providerError, remainingModels, attemptOptions)) {
            break;
          }
          throw withFallbackHistory(providerError, fallbackAttempts, model);
        }
      }
    }

    if (lastProviderError) throw withFallbackHistory(lastProviderError, fallbackAttempts);
    throw new GeminiApiProviderError(
      'gemini_api_upstream_error',
      'No Gemini API model could satisfy the request.',
      {
        statusCode: 503,
        fallbackEligible: true,
        fallbackReason: 'gemini_api_upstream_error',
        fallbackAttempts,
      },
    );
  }

  function throwGeminiError(
    response: Response,
    payload: unknown,
    endpoint: string,
    model: string,
    reservation: GeminiApiKeyReservation,
  ): never {
    const googleError = parseGoogleError(payload);
    const mapped = mapErrorCode(response.status, googleError);
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
      retryAfterMs: retryAfterMs(response, payload),
      highDemand: mapped.code === 'gemini_api_high_demand',
      ...(response.status === 429 ? { rateLimitScope: rateLimitScope(payload, googleError) } : {}),
    });
    throw new GeminiApiProviderError(
      mapped.code,
      redact(googleError.message ?? `Gemini API request failed with HTTP ${response.status}`),
      {
        statusCode: response.status,
        fallbackEligible: mapped.fallbackEligible,
        upstreamModel: model,
        upstreamApiKeyId: reservation.key.id,
        upstreamQuotaGroup: reservation.key.quotaGroup,
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
    const message = isTimeout
      ? 'Gemini API request timed out before the upstream response completed.'
      : redact(error instanceof Error ? error.message : String(error));
    lastUpstreamError = {
      status: null,
      code,
      message,
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
    return new GeminiApiProviderError(code, message || 'Gemini API request failed.', {
      statusCode: isTimeout ? 504 : 502,
      fallbackEligible: true,
      upstreamModel: model,
      upstreamApiKeyId: reservation.key.id,
      upstreamQuotaGroup: reservation.key.quotaGroup,
      lastUpstreamError,
      cause: error,
    });
  }

  return {
    provider: 'gemini-api',
    model: 'gemini-3.5-flash',

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
        fallbackModelIds: config.fallbackModelIds,
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
          lastSuccessAt: quota.apiKeys.find((entry) => entry.keyId === key.id)?.lastSuccessAt ?? null,
        })),
        quotaGroups,
        quotaUpdatedAt: quota.updatedAt,
        modelDiscovery: {
          lastRefreshAt: discoverySnapshot.updatedAt || null,
          lastError: discoverySnapshot.lastError,
        },
        models: discoverySnapshot.models,
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

    async listModels(): Promise<Record<string, unknown>> {
      await discovery.refreshIfStale();
      return {
        ok: true,
        models: discovery.snapshot().models,
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

    resetTelemetry(): Record<string, unknown> {
      ledger.reset();
      lastSelectedKeyId = null;
      lastSelectedQuotaGroup = null;
      lastResolvedModel = null;
      lastError = null;
      lastUpstreamError = null;
      lastSuccessAt = null;
      lastFailureAt = null;
      lastLatencyMs = null;
      return {
        ok: true,
        quota: ledger.snapshot(),
      };
    },

    // Hot-swap the account list (add/remove/enable/priority/allowed-models) without a
    // process restart. The ledger is keyed by quotaGroup+keyId so usage history survives.
    reloadAccounts(keys: GeminiApiKeyConfig[]): Record<string, unknown> {
      config.keys = keys;
      keyPool = new GeminiApiKeyPool(config, ledger);
      return { ok: true, configuredKeyCount: keys.length, usableKeyCount: keys.filter((key) => key.enabled).length };
    },

    // Query Google's model catalog with one account's own key and return the chat/text
    // models it can actually serve, annotated with the limits configured for that account.
    async listAccountModels(accountId: string): Promise<Record<string, unknown>> {
      const account = config.keys.find((key) => key.id === accountId);
      if (!account) {
        return { ok: false, error: 'account_not_found', accountId };
      }
      const url = `${config.baseUrl}/${config.version}/models?key=${encodeURIComponent(account.key)}&pageSize=1000`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        const payload = await response.json().catch(() => ({})) as { models?: Array<Record<string, unknown>>; error?: { message?: string } };
        if (!response.ok) {
          return { ok: false, accountId, status: response.status, error: redact(String(payload.error?.message ?? response.statusText)) };
        }
        const models = (Array.isArray(payload.models) ? payload.models : [])
          .map((model) => {
            const id = String(model.name ?? '').replace(/^models\//, '');
            const methods = Array.isArray(model.supportedGenerationMethods)
              ? (model.supportedGenerationMethods as unknown[]).map((method) => String(method))
              : [];
            const limit = config.groupLimits?.[account.quotaGroup]?.[id] ?? config.limits[id] ?? null;
            return {
              id,
              displayName: typeof model.displayName === 'string' ? model.displayName : id,
              supportedGenerationMethods: methods,
              chat: methods.includes('generateContent'),
              limit,
            };
          })
          .filter((model) => model.chat)
          .sort((left, right) => left.id.localeCompare(right.id));
        return { ok: true, accountId, quotaGroup: account.quotaGroup, models };
      } catch (error) {
        return { ok: false, accountId, error: redact(error instanceof Error ? error.message : String(error)) };
      }
    },
  } as LLMClient & {
    health: () => Record<string, unknown>;
    discoverModels: () => Promise<Record<string, unknown>>;
    listModels: () => Promise<Record<string, unknown>>;
    clearCooldown: () => Record<string, unknown>;
    resetTelemetry: () => Record<string, unknown>;
    reloadAccounts: (keys: GeminiApiKeyConfig[]) => Record<string, unknown>;
    listAccountModels: (accountId: string) => Promise<Record<string, unknown>>;
  };
}
