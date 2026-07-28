import {
  isGeminiEmbeddingModelId,
  isGeminiImageGenerationModelId,
  isGeminiLiveModelId,
  isGeminiLongRunningModelId,
  isGeminiNativeAudioModelId,
  isGeminiTtsModelId,
} from '../../../lib/models.js';
import { applySemanticPrompt, normalizeSemanticOutput } from '../../../lib/semantics.js';
import { LLMHedgeCancelled } from '../../errors.js';
import { GeminiAccountModelCatalog } from './accountCatalog.js';
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
  if (signal?.aborted) return Promise.reject(new LocalWaitCancelled());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new LocalWaitCancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function estimatePromptTokens(messages: LLMMessage[]): number {
  const chars = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

export function estimateGeminiAdmissionTokens(messages: LLMMessage[]): number {
  // Gemini's TPM admission is based on input tokens. chars/4 is deliberately padded:
  // code, JSON and non-English prompts often tokenize more densely, and dispatching a
  // request which already exceeds a model's hard TPM ceiling only creates a useless 429.
  return Math.max(1, Math.ceil(estimatePromptTokens(messages) * 1.15));
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
// Cap how long a single model waits for local RPM/cooldown pressure before giving up on
// that model and moving to the next fallback. Kept short so the fallback chain flows
// instead of stalling on a busy account; the global request deadline is the hard ceiling.
const LOCAL_BACKPRESSURE_MAX_WAIT_MS = 20_000;
// Live traffic showed that two provider timeouts at the previous 25s cap delayed a
// successful downgrade by more than 50s. Cap only candidates which still have a
// fallback; the final candidate retains the remaining global deadline.
const GEMINI_EARLY_ATTEMPT_TIMEOUT_MS = 15_000;
const REQUEST_DEADLINE_RESERVE_MS = 1_000;
export const GEMINI_MAX_UPSTREAM_ATTEMPTS_PER_REQUEST = 6;
// Initial quota-group attempt plus at most two account rotations.
export const GEMINI_MAX_KEY_FANOUT_PER_MODEL = 3;
/**
 * How many upstream quota/availability failures a single model may collect from
 * different accounts before the request moves to the next fallback.
 *
 * Without a cap, one rate-limited model walked the entire key pool (10 accounts) and the
 * chain then repeated that for every fallback model — up to models x accounts upstream
 * calls for a single client request. Account rotation remains useful for a 429/404/auth
 * failure, but is bounded independently of whether a fallback model exists.
 */
export function isKeyFanoutCappedCode(code: string): boolean {
  return (
    code === 'gemini_api_rate_limited' ||
    code === 'gemini_api_model_not_found' ||
    code === 'gemini_api_auth_failed'
  );
}

/**
 * Whether to stop trying further accounts for this model and move to the next fallback.
 * Extracted so the fan-out budget is unit-testable without driving a full request.
 */
export function shouldStopKeyFanout(input: {
  code: string;
  cappedAttempts: number;
}): boolean {
  if (!isKeyFanoutCappedCode(input.code)) return false;
  return input.cappedAttempts >= GEMINI_MAX_KEY_FANOUT_PER_MODEL;
}

class LocalWaitCancelled extends Error {
  constructor() {
    super('Gemini API local backpressure wait was cancelled.');
    this.name = 'LocalWaitCancelled';
  }
}

function buildThinkingConfig(modelId: string | undefined, opts?: LLMOptions): Record<string, unknown> | null {
  const model = normalizeGeminiApiModel(modelId);
  // Gemma 4 rejects any thinkingConfig, including an otherwise harmless `includeThoughts: false`.
  // Omit the field entirely for those models.
  if (!model.startsWith('gemini-') || /^gemma-/i.test(model)) {
    return null;
  }
  const includeThoughts = opts?.thinking?.includeThoughts === true;
  // gemini-3.5-flash is a thinking model: with no thinkingConfig it burns the whole output
  // budget on default (dynamic) reasoning and truncates the visible answer (finishReason=length,
  // ~all tokens counted as thoughtsTokenCount). It rejects `thinkingLevel` but DOES accept
  // `thinkingBudget: 0`, which disables thinking so the full answer fits. The negative
  // lookahead excludes gemini-3.5-flash-lite, which instead REJECTS thinkingBudget (400
  // INVALID_ARGUMENT) and only accepts thinkingLevel — it falls through to the branch below.
  if (/^gemini-3\.5-flash(?!-lite)/i.test(model)) {
    return {
      includeThoughts,
      thinkingBudget: typeof opts?.thinking?.thinkingBudget === 'number' ? opts.thinking.thinkingBudget : 0,
    };
  }
  // Other gemini-3.x reasoning variants (3.6-flash, 3.5-flash-lite, pro, flash-preview, 3.1)
  // take a thinkingLevel; 3.6-flash and 3.5-flash-lite both reject thinkingBudget:0.
  if (/^gemini-3/i.test(model)) {
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
  if (status !== 500 && status !== 503) return false;
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
    text.includes('internal') ||
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
      return true;
    // Timeouts and 5xx responses describe the model/provider path, not a bad API key.
    // Sweeping ten accounts repeats the same slow/failing request and consumes the whole
    // request deadline. Move to the closest fallback model after the first such failure.
    case 'gemini_api_upstream_error':
    case 'gemini_api_timeout':
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
      // No provider call happened. Never mirror the quota-unavailable error's synthetic
      // HTTP 429 into attempt telemetry: the dashboard must distinguish a local skip from
      // a real upstream response.
      statusCode: null,
      availableAfter: null,
      availableAfterSource: null,
    });
    return;
  }
  const availability = eligibleKeys.map((key) => (
    input.ledger.getAvailability(key.quotaGroup, input.model, input.estimatedTokens)
  ));
  const reasonCounts = new Map<string, number>();
  for (const entry of availability) {
    const reason = localAvailabilityReasonLabel({
      availability: entry,
      fallbackCode: input.error.code,
    });
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const reason = [...reasonCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
    ?? input.error.code;
  const retryCandidates = availability
    .map((entry) => ({
      at: entry.cooldownUntil
        ? Date.parse(entry.cooldownUntil)
        : (typeof entry.waitMs === 'number' ? Date.now() + entry.waitMs : Number.NaN),
      source: entry.cooldownSource,
    }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((left, right) => left.at - right.at);
  const earliestRetry = retryCandidates[0];
  input.attempts.push({
    model: input.model,
    backend: 'gemini-api',
    provider: 'gemini-api',
    // This is one scheduler decision, not N upstream attempts. Per-account details remain
    // available in quota diagnostics; Recent Interactions stays compact and truthful.
    keyId: null,
    quotaGroup: null,
    reason,
    statusCode: null,
    availableAfter: earliestRetry ? new Date(earliestRetry.at).toISOString() : null,
    availableAfterSource: earliestRetry?.source ?? null,
  });
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
  if (!String(modelId).trim()) return false;
  if (!/^(?:gemini|gemma)-/i.test(normalizeGeminiApiModel(modelId))) return false;
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

const TEXT_MODEL_CAPABILITY_RANK: Record<string, number> = {
  'gemini-3.6-flash': 380,
  'gemini-3.5-flash': 360,
  'gemini-3-flash': 340,
  'gemini-3-flash-preview': 340,
  'gemma-4-31b-it': 320,
  'gemini-2.5-flash': 310,
  'gemma-4-26b-a4b-it': 285,
  'gemini-3.5-flash-lite': 275,
  'gemini-3.1-flash-lite': 255,
  'gemini-3.1-flash-lite-preview': 255,
  'gemini-2.5-flash-lite': 230,
  'gemini-2.0-flash': 220,
  'gemini-2.0-flash-lite': 200,
};

function textModelCapabilityRank(modelId: string): number {
  const model = classifyTextModel(modelId);
  const explicit = TEXT_MODEL_CAPABILITY_RANK[model.normalized];
  if (explicit !== undefined) return explicit;
  if (model.isPro) return 450 + model.version * 10;
  if (model.isFlash && !model.isLite) return 260 + model.version * 20;
  if (model.isFlash && model.isLite) return 210 + model.version * 15;
  const parameterMatch = model.normalized.match(/-(\d+)b(?:-|$)/i);
  const parameterBillions = Number(parameterMatch?.[1] ?? 0);
  if (model.family === 'gemma' && parameterBillions > 0) return 190 + parameterBillions * 4;
  return 180 + model.version * 10;
}

function compareTextFallbacks(
  requestedModelId: string,
  leftModelId: string,
  rightModelId: string,
  preferredOrder: Map<string, number>,
): number {
  const requested = classifyTextModel(requestedModelId);
  const requestedRank = textModelCapabilityRank(requested.normalized);
  const score = (candidateModelId: string): [number, number, number] => {
    const candidate = classifyTextModel(candidateModelId);
    const candidateRank = textModelCapabilityRank(candidate.normalized);
    // Exhaust equal/lower-capability models first. A slightly stronger model remains a
    // last-resort candidate, but never jumps ahead of the requested model's downgrade path.
    const upgradeBucket = candidateRank > requestedRank ? 1 : 0;
    let distance = Math.abs(requestedRank - candidateRank);
    if (candidate.family !== requested.family) distance += 50;
    if (candidate.isLite !== requested.isLite) distance += 15;
    if (candidate.isPro !== requested.isPro) distance += 10;
    if (candidate.isPreview && !requested.isPreview) distance += 4;
    return [
      upgradeBucket,
      distance,
      preferredOrder.get(candidate.normalized) ?? Number.MAX_SAFE_INTEGER,
    ];
  };
  const left = score(leftModelId);
  const right = score(rightModelId);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || leftModelId.localeCompare(rightModelId);
}

export function buildGeminiModelAttemptPlan(input: {
  requestedModelId: string;
  allowedModelIds?: string[];
  preferredFallbackModelIds?: string[];
  discoveredModels?: GeminiApiModelInfo[];
  strictModelIds?: string[];
  pureImageRequest?: boolean;
}): string[] {
  const requested = normalizeGeminiApiModel(input.requestedModelId);
  const explicitAllowlist = Array.isArray(input.allowedModelIds);
  const requestedIsGeminiProviderModel = /^(?:gemini|gemma)-/i.test(requested);
  const requestedAllowedByPolicy = !explicitAllowlist || (input.allowedModelIds ?? [])
    .map((modelId) => normalizeGeminiApiModel(modelId))
    .includes(requested);
  const allowed = new Set(
    (input.allowedModelIds ?? [])
      .map((modelId) => normalizeGeminiApiModel(modelId))
      .filter((modelId) => isTextFallbackModelCandidate(modelId)),
  );
  const exactAllowed = isTextFallbackModelCandidate(requested) && (!explicitAllowlist || allowed.has(requested));
  const strict = new Set((input.strictModelIds ?? []).map((modelId) => normalizeGeminiApiModel(modelId))).has(requested);
  if (strict || input.pureImageRequest) {
    return requestedIsGeminiProviderModel && requestedAllowedByPolicy ? [requested] : [];
  }
  if (!explicitAllowlist) return exactAllowed ? [requested] : [];

  const discoveredMethodsById = new Map(
    (input.discoveredModels ?? []).map((entry) => [
      normalizeGeminiApiModel(String(entry.id ?? '')),
      Array.isArray(entry.supportedGenerationMethods)
        ? entry.supportedGenerationMethods.map((method) => String(method))
        : [],
    ]),
  );
  const preferredOrder = new Map(
    (input.preferredFallbackModelIds ?? [])
      .map((modelId) => normalizeGeminiApiModel(modelId))
      .map((modelId, index) => [modelId, index]),
  );
  const ranked = (input.allowedModelIds ?? [])
    .map((modelId) => normalizeGeminiApiModel(modelId))
    .filter((modelId) => modelId && modelId !== requested)
    .filter((modelId) => isTextFallbackModelCandidate(modelId, discoveredMethodsById.get(modelId)))
    .sort((left, right) => compareTextFallbacks(requested, left, right, preferredOrder));
  return [...new Set([...(exactAllowed ? [requested] : []), ...ranked])];
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

export function computeGeminiAttemptTimeoutMs(input: {
  providerTimeoutMs: number;
  deadline: number;
  remainingModels: number;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  const remainingMs = Math.max(1_000, input.deadline - now);
  const providerCap = effectiveRequestTimeoutMs(input.providerTimeoutMs);
  if (input.remainingModels <= 0) return Math.max(1_000, Math.min(providerCap, remainingMs));
  // Preserve time for later model candidates. An early model can no longer occupy a
  // large share of the 75s router deadline; the last candidate keeps the remaining time.
  const plannedSlots = Math.min(3, input.remainingModels + 1);
  const fairShareMs = Math.floor(remainingMs / plannedSlots);
  return Math.max(1_000, Math.min(providerCap, GEMINI_EARLY_ATTEMPT_TIMEOUT_MS, fairShareMs));
}

// Combine the per-attempt timeout with the router's global abort signal, so either the
// attempt timeout or the request deadline cancels the in-flight fetch.
function attemptFetchSignal(timeoutMs: number, opts?: LLMOptions): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
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
  // Present every group's models in the configured order (enabled/fallback chain
  // first, then the remaining catalogued models), not in the ledger's historical
  // first-use order — otherwise a newly enabled default model renders last.
  const enabledOrder = new Map(config.fallbackModelIds.map((model, index) => [model.toLowerCase(), index]));
  const limitsOrder = new Map(modelIds.map((model, index) => [model, index]));
  const rank = (model: string): number => {
    const id = model.toLowerCase();
    const enabled = enabledOrder.get(id);
    if (enabled !== undefined) return enabled;
    const catalogued = limitsOrder.get(id);
    return 1_000 + (catalogued !== undefined ? catalogued : 1_000);
  };
  return [...byId.values()].map((group) => {
    const models = Array.isArray(group.models) ? group.models as Record<string, unknown>[] : [];
    return { ...group, models: [...models].sort((a, b) => rank(String(a.model)) - rank(String(b.model))) };
  });
}

export function isGeminiModelHardTpmIneligible(
  config: Pick<GeminiApiProviderConfig, 'keys' | 'limits' | 'groupLimits'>,
  modelId: string,
  estimatedTokens: number,
): boolean {
  const model = normalizeGeminiApiModel(modelId);
  const eligibleKeys = config.keys
    .filter((key) => key.enabled && keyAllowsModel(key, model));
  if (eligibleKeys.length === 0) return false;
  return eligibleKeys.every((key) => {
    const groupLimit = config.groupLimits?.[key.quotaGroup];
    const limit = groupLimit?.[model] ?? config.limits[model];
    return limit?.tpm !== null && limit?.tpm !== undefined && estimatedTokens > limit.tpm;
  });
}

interface GeminiRequestBudget {
  deadline: number;
  upstreamAttempts: number;
  backpressureWaitMs: number;
}

export function createGeminiApiClient(config: GeminiApiProviderConfig): LLMClient {
  const ledger = new GeminiApiQuotaLedger(config);
  const accountCatalog = new GeminiAccountModelCatalog(config);
  let keyPool = new GeminiApiKeyPool(config, ledger, accountCatalog);
  const discovery = new GeminiApiModelDiscovery(config);

  // Google adds/removes free-tier models over time: keep every account's live
  // catalog fresh so curated allowlists act as caps, not stale truth.
  if (config.enabled && config.accountModelsRefreshMs > 0) {
    const accountCatalogTimer = setInterval(() => {
      void accountCatalog.refresh();
    }, config.accountModelsRefreshMs);
    accountCatalogTimer.unref?.();
    if (accountCatalog.isStale(config.accountModelsRefreshMs)) {
      const boot = setTimeout(() => { void accountCatalog.refresh(); }, 30_000);
      boot.unref?.();
    }
  }
  let lastSelectedKeyId: string | null = null;
  let lastSelectedQuotaGroup: string | null = null;
  let lastResolvedModel: string | null = null;
  let lastError: string | null = null;
  let lastUpstreamError: GeminiApiUpstreamErrorSnapshot | null = null;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastLatencyMs: number | null = null;

  async function reserveWithLocalBackpressure(
    model: string,
    estimatedTokens: number,
    budget: GeminiRequestBudget,
    options?: {
      excludeKeyIds?: string[];
      signal?: AbortSignal;
    },
  ): Promise<GeminiApiKeyReservation> {
    while (true) {
      if (options?.signal?.aborted) throw new LocalWaitCancelled();
      try {
        return keyPool.reserve(model, estimatedTokens, {
          excludeKeyIds: options?.excludeKeyIds,
        });
      } catch (error) {
        if (!(error instanceof GeminiApiProviderError) || error.code !== 'gemini_api_quota_unavailable') throw error;
        const backpressure: GeminiApiLocalBackpressure | null = keyPool.nextLocalBackpressure(model, estimatedTokens, {
          excludeKeyIds: options?.excludeKeyIds,
        });
        const remainingDeadlineMs = budget.deadline - Date.now() - REQUEST_DEADLINE_RESERVE_MS;
        const remainingWaitBudgetMs = LOCAL_BACKPRESSURE_MAX_WAIT_MS - budget.backpressureWaitMs;
        if (
          !backpressure ||
          backpressure.waitMs > remainingDeadlineMs ||
          backpressure.waitMs > remainingWaitBudgetMs
        ) {
          throw error;
        }
        lastError = `local_${backpressure.reason}_backpressure:${model}:${backpressure.quotaGroup}`;
        budget.backpressureWaitMs += backpressure.waitMs;
        await sleep(backpressure.waitMs, options?.signal);
      }
    }
  }

  function appendHardTpmSkips(
    attempts: NonNullable<LLMResponse['fallbackAttempts']>,
    model: string,
  ): void {
    attempts.push({
      model,
      backend: 'gemini-api',
      provider: 'gemini-api',
      keyId: null,
      quotaGroup: null,
      reason: 'local_tpm_request_exceeds_model_limit',
      statusCode: null,
      availableAfter: null,
      availableAfterSource: null,
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
    const estimatedTokens = estimateGeminiAdmissionTokens(messages);
    const budget: GeminiRequestBudget = {
      deadline: opts?.deadline ?? started + effectiveRequestTimeoutMs(config.timeoutMs),
      upstreamAttempts: 0,
      backpressureWaitMs: 0,
    };
    const requestOptions: LLMOptions = { ...opts, deadline: budget.deadline };
    const modelAttempts = buildGeminiModelAttemptPlan({
      requestedModelId: requestedModel,
      allowedModelIds: opts?.allowedModelIds,
      preferredFallbackModelIds: config.fallbackModelIds,
      discoveredModels: discovery.snapshot().models,
      strictModelIds: config.strictModelIds,
      pureImageRequest: isPureImageRequest(opts),
    });
    if (modelAttempts.length === 0) {
      throw new GeminiApiProviderError(
        'gemini_api_no_key_for_model',
        `Model ${requestedModel} is not an allowed Gemini API candidate for this request.`,
        { statusCode: 403, fallbackEligible: false, upstreamModel: requestedModel },
      );
    }
    let lastProviderError: GeminiApiProviderError | null = null;
    const fallbackAttempts: NonNullable<LLMResponse['fallbackAttempts']> = [];

    for (let modelIndex = 0; modelIndex < modelAttempts.length; modelIndex++) {
      const model = modelAttempts[modelIndex];
      const remainingModels = modelAttempts.slice(modelIndex + 1);
      const attemptOptions = createAttemptOptions(requestOptions, model);
      const excludedKeyIds = new Set<string>();
      let emptyResponseRetries = 0;
      let effectiveOptions = attemptOptions;
      let cappedKeyAttempts = 0;
      let modelUpstreamAttempts = 0;
      // Spend account rotation on the exact requested model. Once the request has
      // entered the downgrade ladder, breadth is more valuable than retrying several
      // projects on every candidate: one failed account is enough to move to the next
      // closest model while preserving the six-call request budget for high-RPD Lite.
      const modelFanoutLimit = modelIndex === 0
        ? GEMINI_MAX_KEY_FANOUT_PER_MODEL
        : 1;

      if (isGeminiModelHardTpmIneligible(config, model, estimatedTokens)) {
        const error = new GeminiApiProviderError(
          'gemini_api_quota_unavailable',
          `Estimated input (${estimatedTokens} tokens) exceeds the hard TPM limit for ${model}.`,
          {
            statusCode: 429,
            fallbackEligible: true,
            upstreamModel: model,
          },
        );
        appendHardTpmSkips(fallbackAttempts, model);
        lastProviderError = error;
        if (remainingModels.length > 0) continue;
        throw withFallbackHistory(error, fallbackAttempts, model);
      }

      while (true) {
        if (budget.upstreamAttempts >= GEMINI_MAX_UPSTREAM_ATTEMPTS_PER_REQUEST) {
          const error = new GeminiApiProviderError(
            'gemini_api_upstream_error',
            `Gemini request attempt budget exhausted after ${budget.upstreamAttempts} upstream calls.`,
            {
              statusCode: 503,
              fallbackEligible: true,
              upstreamModel: model,
            },
          );
          fallbackAttempts.push({
            model,
            backend: 'gemini-api',
            provider: 'gemini-api',
            keyId: null,
            quotaGroup: null,
            reason: 'local_request_attempt_budget_exhausted',
            statusCode: null,
            availableAfter: null,
            availableAfterSource: null,
          });
          throw withFallbackHistory(error, fallbackAttempts, model);
        }
        let reservation: GeminiApiKeyReservation;
        try {
          reservation = await reserveWithLocalBackpressure(model, estimatedTokens, budget, {
            excludeKeyIds: [...excludedKeyIds],
            signal: requestOptions.signal,
          });
        } catch (error) {
          if (error instanceof LocalWaitCancelled) {
            const timeoutError = new GeminiApiProviderError(
              'gemini_api_timeout',
              'Gemini request was cancelled while waiting for local quota capacity.',
              {
                statusCode: 504,
                fallbackEligible: false,
                upstreamModel: model,
              },
            );
            fallbackAttempts.push({
              model,
              backend: 'gemini-api',
              provider: 'gemini-api',
              keyId: null,
              quotaGroup: null,
              reason: 'local_backpressure_wait_cancelled',
              statusCode: null,
              availableAfter: null,
              availableAfterSource: null,
            });
            throw withFallbackHistory(timeoutError, fallbackAttempts, model);
          }
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

        if (
          requestOptions.signal?.aborted ||
          Date.now() >= budget.deadline ||
          budget.upstreamAttempts >= GEMINI_MAX_UPSTREAM_ATTEMPTS_PER_REQUEST
        ) {
          ledger.cancelReservation({
            quotaGroup: reservation.key.quotaGroup,
            keyId: reservation.key.id,
            model,
            requestId: reservation.requestId,
          });
          const error = new GeminiApiProviderError(
            'gemini_api_timeout',
            'Gemini request deadline or attempt budget was reached before dispatch.',
            {
              statusCode: 504,
              fallbackEligible: false,
              upstreamModel: model,
              upstreamApiKeyId: reservation.key.id,
              upstreamQuotaGroup: reservation.key.quotaGroup,
            },
          );
          fallbackAttempts.push({
            model,
            backend: 'gemini-api',
            provider: 'gemini-api',
            keyId: reservation.key.id,
            quotaGroup: reservation.key.quotaGroup,
            reason: 'local_request_deadline_reached',
            statusCode: null,
            availableAfter: null,
            availableAfterSource: null,
          });
          throw withFallbackHistory(error, fallbackAttempts, model);
        }

        try {
          budget.upstreamAttempts += 1;
          modelUpstreamAttempts += 1;
          ledger.markDispatched({
            quotaGroup: reservation.key.quotaGroup,
            keyId: reservation.key.id,
            model,
            requestId: reservation.requestId,
          });
          const response = await fetch(withKey(endpoint, reservation.key.key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toGenerationBody(messages, effectiveOptions)),
            signal: attemptFetchSignal(computeGeminiAttemptTimeoutMs({
              providerTimeoutMs: config.timeoutMs,
              deadline: budget.deadline,
              remainingModels: remainingModels.length,
            }), requestOptions),
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
            // HTTP 200 still consumed upstream RPM/RPD/TPM. Complete this reservation
            // before any retry; the next loop iteration must reserve a new requestId.
            ledger.markSuccess({
              quotaGroup: reservation.key.quotaGroup,
              keyId: reservation.key.id,
              model,
              requestId: reservation.requestId,
              promptTokens: usage?.promptTokenCount,
              upstreamHeaders: captureRateLimitHeaders(response),
            });
            // Truncated for length: retry the same model with a larger output budget.
            if (finishReason === 'length' && emptyResponseRetries < EMPTY_RESPONSE_RETRY_LIMIT) {
              emptyResponseRetries += 1;
              const previous = effectiveOptions?.maxTokens ?? 0;
              effectiveOptions = {
                ...attemptOptions,
                maxTokens: Math.max(previous * 4, EMPTY_RESPONSE_RETRY_TOKENS * emptyResponseRetries),
              };
              fallbackAttempts.push({
                model,
                backend: 'gemini-api',
                provider: 'gemini-api',
                keyId: reservation.key.id,
                quotaGroup: reservation.key.quotaGroup,
                reason: 'gemini_api_empty_response',
                statusCode: 200,
                availableAfter: null,
                availableAfterSource: null,
              });
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
            promptTokens: usage?.promptTokenCount,
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
          const hedgeCancelled = error instanceof LLMHedgeCancelled ||
            requestOptions.signal?.reason instanceof LLMHedgeCancelled;
          if (hedgeCancelled) {
            ledger.markAbortedAfterDispatch({
              quotaGroup: reservation.key.quotaGroup,
              keyId: reservation.key.id,
              model,
              requestId: reservation.requestId,
            });
            throw error;
          }
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
          if (isKeyFanoutCappedCode(providerError.code)) cappedKeyAttempts += 1;
          const keyFanoutExhausted = shouldStopKeyFanout({
            code: providerError.code,
            cappedAttempts: cappedKeyAttempts,
          });
          if (
            !keyFanoutExhausted &&
            modelUpstreamAttempts < modelFanoutLimit &&
            budget.upstreamAttempts < GEMINI_MAX_UPSTREAM_ATTEMPTS_PER_REQUEST &&
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
        accountModels: accountCatalog.snapshot(),
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

    // Refresh every account's live model catalog now (normally on a 6h timer).
    async refreshAccountModels(): Promise<Record<string, unknown>> {
      return accountCatalog.refresh();
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
      keyPool = new GeminiApiKeyPool(config, ledger, accountCatalog);
      void accountCatalog.refresh();
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
    refreshAccountModels: () => Promise<Record<string, unknown>>;
    listModels: () => Promise<Record<string, unknown>>;
    clearCooldown: () => Record<string, unknown>;
    resetTelemetry: () => Record<string, unknown>;
    reloadAccounts: (keys: GeminiApiKeyConfig[]) => Record<string, unknown>;
    listAccountModels: (accountId: string) => Promise<Record<string, unknown>>;
  };
}
