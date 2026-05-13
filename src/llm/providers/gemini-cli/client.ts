import { randomUUID } from 'node:crypto';

import type { OAuth2Client } from 'google-auth-library';

import { isDirectGeminiModelId, isPlaywrightModelId } from '../../../lib/models.js';
import {
  buildGeminiCliHealthSnapshot,
  loadGeminiCachedOAuthClient,
  type GeminiCliRuntimeState,
} from '../../../lib/geminiCli.js';
import { applySemanticPrompt, normalizeSemanticOutput } from '../../../lib/semantics.js';
import { LLMProviderError, type LLMProviderErrorCode } from '../../errors.js';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse } from '../../types.js';
import type {
  GeminiCliHealthSnapshot,
  GeminiCliProviderConfig,
  GeminiCliUpstreamErrorSnapshot,
  GeminiQuotaBucket,
} from './types.js';

interface CodeAssistCandidatePart {
  text?: string;
}

interface CodeAssistCandidate {
  content?: {
    parts?: CodeAssistCandidatePart[];
  };
  finishReason?: string;
}

interface CodeAssistUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface CodeAssistGenerateContentResponse {
  response?: {
    candidates?: CodeAssistCandidate[];
    promptFeedback?: {
      blockReason?: string;
      blockReasonMessage?: string;
    };
    usageMetadata?: CodeAssistUsageMetadata;
    modelVersion?: string;
  };
  traceId?: string;
  remainingCredits?: Array<{
    creditType?: string;
    creditAmount?: string;
  }>;
}

interface CodeAssistLoadResponse {
  currentTier?: {
    id?: string;
    name?: string;
    hasOnboardedPreviously?: boolean;
  } | null;
  cloudaicompanionProject?: string | null;
  paidTier?: {
    id?: string;
    name?: string;
    availableCredits?: Array<{
      creditType?: string;
      creditAmount?: string;
    }>;
  } | null;
}

interface CodeAssistQuotaResponse {
  buckets?: Array<{
    modelId?: string;
    remainingAmount?: string;
    remainingFraction?: number;
    resetTime?: string;
    tokenType?: string;
  }>;
}

interface CodeAssistRuntime {
  client: OAuth2Client;
  activeAccount: string | null;
  projectId: string | null;
  userTier: string | null;
  userTierName: string | null;
  loadedAt: number;
}

interface GoogleApiErrorEntry {
  message?: string;
  domain?: string;
  reason?: string;
}

interface GoogleApiErrorShape {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown[];
  errors?: GoogleApiErrorEntry[];
}

const CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
const RUNTIME_TTL_MS = 30_000;
const MAX_UPSTREAM_BODY_LENGTH = 4_000;
const UPSTREAM_ERROR_FIELD = '__gemrouterUpstreamError';

function flattenMessages(messages: LLMMessage[]): string {
  const meaningful = messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content);

  if (meaningful.length === 0) return '';
  if (meaningful.length === 1 && meaningful[0]?.role === 'user') return meaningful[0].content;

  const system = meaningful.filter((message) => message.role === 'system').map((message) => message.content);
  const dialog = meaningful.filter((message) => message.role !== 'system');
  const parts: string[] = [];

  if (system.length > 0) {
    parts.push(`System:\n${system.join('\n\n')}`);
  }

  if (dialog.length > 0) {
    parts.push('Conversation so far:');
    for (const message of dialog) {
      const label = message.role === 'assistant' ? 'Assistant' : 'User';
      parts.push(`${label}:\n${message.content}`);
    }
  }

  parts.push('Reply as the assistant.');
  return parts.join('\n\n');
}

function repairJsonContent(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;

  try {
    JSON.parse(text);
    return text;
  } catch {
    // continue
  }

  let repaired = text;
  repaired = repaired.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return text;
  }
}

function toContents(messages: LLMMessage[]): Array<{ role: 'user'; parts: Array<{ text: string }> }> {
  return [{ role: 'user', parts: [{ text: flattenMessages(messages) }] }];
}

function mapQuotaBuckets(input: CodeAssistQuotaResponse | null | undefined): GeminiQuotaBucket[] {
  return Array.isArray(input?.buckets)
    ? input.buckets.map((bucket) => ({
      modelId: typeof bucket.modelId === 'string' && bucket.modelId.trim() ? bucket.modelId.trim() : null,
      remainingAmount:
        typeof bucket.remainingAmount === 'string' && bucket.remainingAmount.trim()
          ? bucket.remainingAmount.trim()
          : null,
      remainingFraction: typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : null,
      resetTime: typeof bucket.resetTime === 'string' && bucket.resetTime.trim() ? bucket.resetTime.trim() : null,
      tokenType: typeof bucket.tokenType === 'string' && bucket.tokenType.trim() ? bucket.tokenType.trim() : null,
    }))
    : [];
}

function isBucketExhausted(bucket: GeminiQuotaBucket | undefined): boolean {
  if (!bucket) return false;
  if (bucket.remainingAmount && Number.isFinite(Number(bucket.remainingAmount))) {
    return Number(bucket.remainingAmount) <= 0;
  }
  if (typeof bucket.remainingFraction === 'number') {
    return bucket.remainingFraction <= 0;
  }
  return false;
}

function extractResponseText(payload: CodeAssistGenerateContentResponse): string {
  const parts = payload.response?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function getEnvProjectId(): string | null {
  const value = process.env.GOOGLE_CLOUD_PROJECT?.trim() || process.env.GOOGLE_CLOUD_PROJECT_ID?.trim() || '';
  return value || null;
}

function sanitizeJsonString(jsonStr: string): string {
  let output = jsonStr;
  let previous = '';
  while (output !== previous) {
    previous = output;
    output = output.replace(/,(\s*),/g, ',$1');
  }
  return output;
}

function parseJsonString(value: string): unknown {
  return JSON.parse(sanitizeJsonString(value.replace(/\u00A0/g, '').replace(/\n/g, ' ')));
}

function toGoogleApiErrorShape(value: unknown): GoogleApiErrorShape | null {
  if (typeof value === 'string') {
    try {
      return toGoogleApiErrorShape(parseJsonString(value));
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? toGoogleApiErrorShape(value[0]) : null;
  }

  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  if (record.error && typeof record.error === 'object') {
    return toGoogleApiErrorShape(record.error);
  }

  const shape: GoogleApiErrorShape = {};
  if (typeof record.code === 'number') shape.code = record.code;
  if (typeof record.message === 'string') shape.message = record.message;
  if (typeof record.status === 'string') shape.status = record.status;
  if (Array.isArray(record.details)) shape.details = record.details;
  if (Array.isArray(record.errors)) {
    shape.errors = record.errors
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        message: typeof entry.message === 'string' ? entry.message : undefined,
        domain: typeof entry.domain === 'string' ? entry.domain : undefined,
        reason: typeof entry.reason === 'string' ? entry.reason : undefined,
      }));
  }

  if (shape.code !== undefined || shape.message || shape.status || shape.details || shape.errors) {
    return shape;
  }

  if (typeof record.message === 'string') {
    try {
      return toGoogleApiErrorShape(parseJsonString(record.message));
    } catch {
      return null;
    }
  }

  return null;
}

function summarizeGoogleError(error: unknown): GoogleApiErrorShape | null {
  if (typeof error === 'string') {
    return toGoogleApiErrorShape(error);
  }

  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  if (record.response && typeof record.response === 'object') {
    const response = record.response as Record<string, unknown>;
    const fromData = toGoogleApiErrorShape(response.data);
    if (fromData) return fromData;
  }

  const direct = toGoogleApiErrorShape(record);
  if (direct) return direct;

  if (typeof record.message === 'string') {
    return toGoogleApiErrorShape(record.message);
  }

  return null;
}

function hasDetailReason(error: GoogleApiErrorShape | null, reason: string): boolean {
  if (!Array.isArray(error?.details)) return false;
  return error.details.some((detail) => {
    if (!detail || typeof detail !== 'object') return false;
    const typed = detail as Record<string, unknown>;
    if (typed.reason === reason) return true;
    const metadata = typed.metadata;
    if (metadata && typeof metadata === 'object') {
      return Object.values(metadata as Record<string, unknown>).includes(reason);
    }
    return false;
  });
}

function getPrimaryGoogleReason(error: GoogleApiErrorShape | null): string | null {
  if (!error) return null;

  if (Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (!detail || typeof detail !== 'object') continue;
      const typed = detail as Record<string, unknown>;
      if (typeof typed.reason === 'string' && typed.reason.trim()) {
        return typed.reason.trim();
      }
      const metadata = typed.metadata;
      if (metadata && typeof metadata === 'object') {
        const values = Object.values(metadata as Record<string, unknown>).find(
          (value) => typeof value === 'string' && value.trim().length > 0,
        );
        if (typeof values === 'string') return values.trim();
      }
    }
  }

  if (Array.isArray(error.errors)) {
    const reason = error.errors.find((entry) => typeof entry.reason === 'string' && entry.reason.trim());
    if (reason?.reason) return reason.reason.trim();
  }

  return null;
}

function hasDailyQuotaSignal(error: GoogleApiErrorShape | null): boolean {
  if (!Array.isArray(error?.details)) return false;
  return error.details.some((detail) => {
    if (!detail || typeof detail !== 'object') return false;
    const typed = detail as Record<string, unknown>;
    const violations = typed.violations;
    if (!Array.isArray(violations)) return false;
    return violations.some((violation) => {
      if (!violation || typeof violation !== 'object') return false;
      const quotaId = String((violation as Record<string, unknown>).quotaId ?? '');
      return /PerDay|Daily/i.test(quotaId);
    });
  });
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /abort|timed out|timeout/i.test(message);
}

function isAuthExpiredError(error: unknown): boolean {
  const googleError = summarizeGoogleError(error);
  const message = String(googleError?.message ?? (error instanceof Error ? error.message : String(error ?? '')));
  return (
    googleError?.code === 401 ||
    /invalid[_ ]grant|refresh token|expired|revoked|unauthorized/i.test(message)
  );
}

function isModelUnsupportedError(error: unknown): boolean {
  const googleError = summarizeGoogleError(error);
  const message = String(googleError?.message ?? (error instanceof Error ? error.message : String(error ?? '')));
  return googleError?.code === 404 || /unknown model|invalid model|unsupported model|model .* not found/i.test(message);
}

function isPolicyBlockedError(error: unknown, payload?: CodeAssistGenerateContentResponse | null): boolean {
  const blockReason = payload?.response?.promptFeedback?.blockReason;
  if (typeof blockReason === 'string' && blockReason.trim()) return true;
  const googleError = summarizeGoogleError(error);
  const message = String(googleError?.message ?? (error instanceof Error ? error.message : String(error ?? '')));
  return /policy|safety|blocked|disallowed/i.test(message);
}

function isValidationRequiredError(error: GoogleApiErrorShape | null): boolean {
  const reason = getPrimaryGoogleReason(error);
  if (reason !== 'VALIDATION_REQUIRED') return false;
  if (!Array.isArray(error?.details)) return false;
  return error.details.some((detail) => {
    if (!detail || typeof detail !== 'object') return false;
    const domain = (detail as Record<string, unknown>).domain;
    return typeof domain === 'string' && /cloudcode-pa\.googleapis\.com/i.test(domain);
  });
}

function stringifyUpstreamBody(value: unknown): string | null {
  if (value == null) return null;
  const text = typeof value === 'string'
    ? value
    : (() => {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })();
  return text.length > MAX_UPSTREAM_BODY_LENGTH
    ? `${text.slice(0, MAX_UPSTREAM_BODY_LENGTH)}…`
    : text;
}

function readHeaderValue(headers: Record<string, unknown>, key: string): string | null {
  const direct = headers[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const lower = headers[key.toLowerCase()];
  if (typeof lower === 'string' && lower.trim()) return lower.trim();
  return null;
}

function buildUpstreamErrorSnapshot(
  error: unknown,
  context: { method: string; model?: string | null },
): GeminiCliUpstreamErrorSnapshot {
  const response = error && typeof error === 'object' && 'response' in error
    ? (error as { response?: Record<string, unknown> }).response
    : undefined;
  const headers = response && typeof response.headers === 'object'
    ? response.headers as Record<string, unknown>
    : {};
  const googleError = summarizeGoogleError(error);
  const statusCode =
    typeof response?.status === 'number'
      ? response.status
      : (typeof googleError?.code === 'number' ? googleError.code : null);
  const message =
    String(
      googleError?.message ??
      (error instanceof Error ? error.message : String(error ?? '')),
    ).trim() || null;

  return {
    at: new Date().toISOString(),
    method: context.method,
    endpoint: `${CODE_ASSIST_BASE_URL}:${context.method}`,
    model: context.model ?? null,
    statusCode,
    statusText: typeof response?.statusText === 'string' ? response.statusText : null,
    googleCode: typeof googleError?.code === 'number' ? googleError.code : null,
    googleStatus: typeof googleError?.status === 'string' ? googleError.status : null,
    googleReason: getPrimaryGoogleReason(googleError),
    requestId: readHeaderValue(headers, 'x-request-id') ?? readHeaderValue(headers, 'x-guploader-uploadid'),
    message,
    body: stringifyUpstreamBody(response?.data ?? (error instanceof Error ? error.message : error)),
    retryable: null,
    terminal: null,
  };
}

function attachUpstreamError(
  error: unknown,
  upstream: GeminiCliUpstreamErrorSnapshot,
): unknown {
  if (error && typeof error === 'object') {
    (error as Record<string, unknown>)[UPSTREAM_ERROR_FIELD] = upstream;
    return error;
  }
  const wrapped = new Error(String(error ?? 'Unknown Gemini upstream error'));
  (wrapped as unknown as Record<string, unknown>)[UPSTREAM_ERROR_FIELD] = upstream;
  return wrapped;
}

function getAttachedUpstreamError(error: unknown): GeminiCliUpstreamErrorSnapshot | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as Record<string, unknown>)[UPSTREAM_ERROR_FIELD];
  return value && typeof value === 'object' ? value as GeminiCliUpstreamErrorSnapshot : null;
}

function buildProviderError(code: LLMProviderErrorCode, message: string, options?: {
  statusCode?: number;
  fallbackEligible?: boolean;
  cause?: unknown;
}): LLMProviderError {
  return new LLMProviderError(code, 'gemini-cli', message, {
    statusCode: options?.statusCode,
    fallbackEligible: options?.fallbackEligible,
    cause: options?.cause,
  });
}

function classifyUpstreamError(
  error: unknown,
  upstream: GeminiCliUpstreamErrorSnapshot,
): {
  code: LLMProviderErrorCode;
  message: string;
  statusCode: number;
  fallbackEligible: boolean;
  retryable: boolean;
  terminal: boolean;
} {
  const googleError = summarizeGoogleError(error);
  const statusCode = upstream.statusCode ?? googleError?.code ?? 502;
  const reason = upstream.googleReason;
  const message = upstream.message ?? 'Gemini direct request failed upstream.';

  if (isModelUnsupportedError(error)) {
    return {
      code: 'cli_model_unsupported',
      message: `Gemini direct model ${upstream.model ?? 'unknown'} is not available for this account.`,
      statusCode: 400,
      fallbackEligible: false,
      retryable: false,
      terminal: true,
    };
  }

  if (isAuthExpiredError(error)) {
    return {
      code: 'cli_auth_expired',
      message: 'Gemini cached Google auth expired or was revoked.',
      statusCode: 503,
      fallbackEligible: true,
      retryable: false,
      terminal: false,
    };
  }

  if (statusCode === 403 && isValidationRequiredError(googleError)) {
    return {
      code: 'cli_validation_required',
      message: 'Gemini direct account validation is required upstream.',
      statusCode: 403,
      fallbackEligible: true,
      retryable: false,
      terminal: true,
    };
  }

  if (statusCode === 403) {
    return {
      code: 'cli_permission_denied',
      message: 'Gemini direct upstream denied this account or project.',
      statusCode: 403,
      fallbackEligible: true,
      retryable: false,
      terminal: true,
    };
  }

  if (
    statusCode === 429 ||
    statusCode === 499 ||
    statusCode === 503 ||
    upstream.googleStatus === 'RESOURCE_EXHAUSTED'
  ) {
    const terminalQuota =
      reason === 'QUOTA_EXHAUSTED' ||
      reason === 'INSUFFICIENT_G1_CREDITS_BALANCE' ||
      hasDailyQuotaSignal(googleError);
    if (terminalQuota) {
      return {
        code: 'cli_quota_exhausted',
        message,
        statusCode: 429,
        fallbackEligible: true,
        retryable: false,
        terminal: true,
      };
    }
    return {
      code: 'cli_rate_limited',
      message,
      statusCode,
      fallbackEligible: true,
      retryable: true,
      terminal: false,
    };
  }

  if (isPolicyBlockedError(error)) {
    return {
      code: 'cli_policy_blocked',
      message: 'Gemini direct request was blocked by policy or safety controls.',
      statusCode: 400,
      fallbackEligible: false,
      retryable: false,
      terminal: true,
    };
  }

  return {
    code: 'cli_process_error',
    message,
    statusCode: 502,
    fallbackEligible: true,
    retryable: false,
    terminal: false,
  };
}

async function requestJson<T>(
  client: OAuth2Client,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  options?: { retryDelayMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Gemini request timed out after ${timeoutMs}ms.`)), timeoutMs);
  timer.unref();

  try {
    const response = await client.request<T>({
      url: `${CODE_ASSIST_BASE_URL}:${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      responseType: 'json',
      signal: controller.signal,
      retryConfig: {
        retryDelay: options?.retryDelayMs ?? 100,
        retry: 3,
        noResponseRetries: 3,
        statusCodesToRetry: [
          [429, 429],
          [499, 499],
          [500, 599],
        ],
      },
    });
    return response.data;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw buildProviderError('cli_timeout', 'Gemini Code Assist request timed out.', {
        statusCode: 504,
        fallbackEligible: true,
        cause: error,
      });
    }
    throw attachUpstreamError(error, buildUpstreamErrorSnapshot(error, {
      method,
      model: typeof payload.model === 'string' ? payload.model : null,
    }));
  } finally {
    clearTimeout(timer);
  }
}

function resolveModelAttemptSequence(config: GeminiCliProviderConfig, requestedModel: string | undefined, runtimeState: GeminiCliRuntimeState): string[] {
  const primary = requestedModel && isDirectGeminiModelId(requestedModel) ? requestedModel : config.model;
  const ordered = [primary, ...config.models];
  const unique = [...new Set(ordered.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (runtimeState.quotaAuthoritative !== true) {
    return unique;
  }
  const buckets = runtimeState.quotaBuckets ?? [];
  const available = unique.filter((modelId) => {
    const bucket = buckets.find((entry) => entry.modelId === modelId);
    return !isBucketExhausted(bucket);
  });
  const exhausted = unique.filter((modelId) => !available.includes(modelId));
  return [...available, ...exhausted];
}

export function createGeminiCliClient(config: GeminiCliProviderConfig): LLMClient & {
  health(): GeminiCliHealthSnapshot;
  refreshHealth(): Promise<GeminiCliHealthSnapshot>;
} {
  const runtimeState: GeminiCliRuntimeState = {
    authReady: null,
    authVerifiedAt: null,
    lastError: null,
    lastMappedErrorCode: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    lastLatencyMs: null,
    lastResolvedModel: null,
    projectId: null,
    userTier: null,
    userTierName: null,
    availableCredits: [],
    quotaBuckets: [],
    quotaAuthoritative: false,
    quotaUpdatedAt: null,
    quotaLastError: null,
    lastUpstreamError: null,
  };

  let runtimeCache: CodeAssistRuntime | null = null;
  let runtimePromise: Promise<CodeAssistRuntime> | null = null;

  function buildSyntheticUpstreamError(
    method: string,
    model: string | null,
    message: string,
    statusCode: number | null,
  ): GeminiCliUpstreamErrorSnapshot {
    return {
      at: new Date().toISOString(),
      method,
      endpoint: `${CODE_ASSIST_BASE_URL}:${method}`,
      model,
      statusCode,
      statusText: null,
      googleCode: statusCode,
      googleStatus: null,
      googleReason: null,
      requestId: null,
      message,
      body: null,
      retryable: null,
      terminal: null,
    };
  }

  function recordNormalizedError(
    error: LLMProviderError,
    upstream: GeminiCliUpstreamErrorSnapshot,
    options?: { retryable?: boolean; terminal?: boolean },
  ): LLMProviderError {
    runtimeState.lastError = error.message;
    runtimeState.lastMappedErrorCode = error.code;
    runtimeState.lastFailureAt = upstream.at ?? new Date().toISOString();
    runtimeState.lastUpstreamError = {
      ...upstream,
      retryable: typeof options?.retryable === 'boolean' ? options.retryable : upstream.retryable,
      terminal: typeof options?.terminal === 'boolean' ? options.terminal : upstream.terminal,
    };
    if (error.code === 'cli_auth_expired' || error.code === 'cli_auth_missing') {
      runtimeState.authReady = false;
    }
    return error;
  }

  function normalizeAndRecordError(
    error: unknown,
    context: { method: string; model?: string | null },
  ): LLMProviderError {
    if (error instanceof LLMProviderError) {
      const upstream = getAttachedUpstreamError(error) ?? buildSyntheticUpstreamError(
        context.method,
        context.model ?? null,
        error.message,
        error.options.statusCode ?? null,
      );
      return recordNormalizedError(error, upstream);
    }

    const upstream = getAttachedUpstreamError(error) ?? buildUpstreamErrorSnapshot(error, context);
    const classification = classifyUpstreamError(error, upstream);
    return recordNormalizedError(
      buildProviderError(classification.code, classification.message, {
        statusCode: classification.statusCode,
        fallbackEligible: classification.fallbackEligible,
        cause: error,
      }),
      upstream,
      {
        retryable: classification.retryable,
        terminal: classification.terminal,
      },
    );
  }

  async function loadRuntime(): Promise<CodeAssistRuntime> {
    const cached = await loadGeminiCachedOAuthClient(config).catch((error) => {
      runtimeState.authReady = false;
      runtimeState.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });

    if (!cached) {
      runtimeState.authReady = false;
      throw recordNormalizedError(buildProviderError(
        'cli_auth_missing',
        'Gemini cached Google auth is missing. Run pnpm login:gemini-cli.',
        {
          statusCode: 503,
          fallbackEligible: true,
        },
      ), buildSyntheticUpstreamError('loadCodeAssist', null, 'Gemini cached Google auth is missing. Run pnpm login:gemini-cli.', 503));
    }

    const loadedAt = new Date().toISOString();
    runtimeState.authReady = true;
    runtimeState.authVerifiedAt = loadedAt;

    const loadResponse = await requestJson<CodeAssistLoadResponse>(
      cached.client,
      'loadCodeAssist',
      {
        cloudaicompanionProject: getEnvProjectId(),
        metadata: {
          ideType: 'IDE_UNSPECIFIED',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI',
          duetProject: getEnvProjectId(),
        },
        mode: 'HEALTH_CHECK',
      },
      Math.min(config.timeoutMs, 45_000),
    ).catch((error) => { throw normalizeAndRecordError(error, { method: 'loadCodeAssist' }); });

    runtimeState.projectId =
      (typeof loadResponse.cloudaicompanionProject === 'string' && loadResponse.cloudaicompanionProject.trim()
        ? loadResponse.cloudaicompanionProject.trim()
        : getEnvProjectId()) ?? null;
    runtimeState.userTier =
      loadResponse.paidTier?.id?.trim() ||
      loadResponse.currentTier?.id?.trim() ||
      null;
    runtimeState.userTierName =
      loadResponse.paidTier?.name?.trim() ||
      loadResponse.currentTier?.name?.trim() ||
      null;
    runtimeState.availableCredits = Array.isArray(loadResponse.paidTier?.availableCredits)
      ? loadResponse.paidTier.availableCredits
        .filter((credit): credit is { creditType: string; creditAmount: string } => (
          typeof credit?.creditType === 'string' &&
          credit.creditType.trim().length > 0 &&
          typeof credit.creditAmount === 'string' &&
          credit.creditAmount.trim().length > 0
        ))
        .map((credit) => ({
          creditType: credit.creditType.trim(),
          creditAmount: credit.creditAmount.trim(),
        }))
      : [];
    runtimeState.lastError = null;

    return {
      client: cached.client,
      activeAccount: cached.activeAccount ?? null,
      projectId: runtimeState.projectId,
      userTier: runtimeState.userTier,
      userTierName: runtimeState.userTierName,
      loadedAt: Date.parse(loadedAt),
    };
  }

  async function ensureRuntime(force = false): Promise<CodeAssistRuntime> {
    if (!config.enabled) {
      throw buildProviderError('backend_disabled', 'Gemini direct backend is disabled.', {
        statusCode: 503,
        fallbackEligible: false,
      });
    }

    if (!force && runtimeCache && (Date.now() - runtimeCache.loadedAt) < RUNTIME_TTL_MS) {
      return runtimeCache;
    }

    if (!force && runtimePromise) {
      return await runtimePromise;
    }

    runtimePromise = (async () => {
      try {
        const runtime = await loadRuntime();
        runtimeCache = runtime;
        return runtime;
      } finally {
        runtimePromise = null;
      }
    })();

    return await runtimePromise;
  }

  async function refreshQuota(runtime: CodeAssistRuntime, force = false): Promise<void> {
    if (!runtime.projectId) return;
    if (!force && runtimeState.quotaUpdatedAt) {
      const age = Date.now() - Date.parse(runtimeState.quotaUpdatedAt);
      if (Number.isFinite(age) && age < config.quotaRefreshMs) return;
    }

    try {
      const quota = await requestJson<CodeAssistQuotaResponse>(
        runtime.client,
        'retrieveUserQuota',
        {
          project: runtime.projectId,
        },
        Math.min(config.timeoutMs, 30_000),
      );
      runtimeState.quotaBuckets = mapQuotaBuckets(quota);
      runtimeState.quotaAuthoritative = true;
      runtimeState.quotaUpdatedAt = new Date().toISOString();
      runtimeState.quotaLastError = null;
    } catch (error) {
      const normalized = normalizeAndRecordError(error, { method: 'retrieveUserQuota' });
      runtimeState.quotaAuthoritative = false;
      runtimeState.quotaUpdatedAt = new Date().toISOString();
      runtimeState.quotaLastError = normalized.message;
    }
  }

  async function executeModel(runtime: CodeAssistRuntime, model: string, messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    const startedAt = Date.now();
    const semanticMessages = applySemanticPrompt(messages, opts?.semanticProfile);
    const payload = await requestJson<CodeAssistGenerateContentResponse>(
      runtime.client,
      'generateContent',
      {
        model,
        project: runtime.projectId ?? undefined,
        user_prompt_id: randomUUID(),
        request: {
          contents: toContents(semanticMessages),
          generationConfig: {
            temperature: opts?.temperature,
            maxOutputTokens: opts?.maxTokens,
            responseMimeType: opts?.semanticProfile?.outputMode === 'json' ? 'application/json' : undefined,
            responseSchema: opts?.semanticProfile?.jsonSchema,
          },
        },
      },
      config.timeoutMs,
      { retryDelayMs: 1_000 },
    ).catch((error) => { throw normalizeAndRecordError(error, { method: 'generateContent', model }); });

    if (isPolicyBlockedError(null, payload)) {
      throw buildProviderError('cli_policy_blocked', 'Gemini direct request was blocked by policy or safety controls.', {
        statusCode: 400,
        fallbackEligible: false,
      });
    }

    const rawText = extractResponseText(payload);
    if (!rawText) {
      throw buildProviderError('cli_bad_output', 'Gemini direct backend returned an empty or unparsable response.', {
        statusCode: 502,
        fallbackEligible: true,
      });
    }

    if (Array.isArray(payload.remainingCredits)) {
      runtimeState.availableCredits = payload.remainingCredits
        .filter((credit): credit is { creditType: string; creditAmount: string } => (
          typeof credit?.creditType === 'string' &&
          credit.creditType.trim().length > 0 &&
          typeof credit.creditAmount === 'string' &&
          credit.creditAmount.trim().length > 0
        ))
        .map((credit) => ({
          creditType: credit.creditType.trim(),
          creditAmount: credit.creditAmount.trim(),
        }));
    }

    runtimeState.lastResolvedModel = model;
    runtimeState.lastSuccessAt = new Date().toISOString();
    runtimeState.lastLatencyMs = Date.now() - startedAt;
    runtimeState.lastError = null;
    void refreshQuota(runtime).catch(() => undefined);

    return {
      content: normalizeSemanticOutput(repairJsonContent(rawText), opts?.semanticProfile),
      provider: 'gemini-cli',
      model: opts?.model ?? model,
      tokensUsed: payload.response?.usageMetadata?.totalTokenCount,
      backend: 'gemini-cli',
      backendModel: payload.response?.modelVersion ?? model,
      latencyMs: runtimeState.lastLatencyMs ?? undefined,
    };
  }

  void ensureRuntime().then((runtime) => refreshQuota(runtime, true)).catch(() => undefined);

  return {
    provider: 'gemini-cli',
    model: config.model,

    async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
      if (opts?.model && isPlaywrightModelId(opts.model)) {
        throw buildProviderError('cli_model_unsupported', `Model ${opts.model} is reserved for the Playwright Gemini Web backend.`, {
          statusCode: 400,
          fallbackEligible: false,
        });
      }

      const runtime = await ensureRuntime();
      await refreshQuota(runtime).catch(() => undefined);

      const attempts = resolveModelAttemptSequence(config, opts?.model, runtimeState);
      let lastError: LLMProviderError | null = null;

      for (const model of attempts) {
        try {
          return await executeModel(runtime, model, messages, opts);
        } catch (error) {
          const normalized = error instanceof LLMProviderError
            ? error
            : buildProviderError('cli_process_error', error instanceof Error ? error.message : String(error), {
              statusCode: 502,
              fallbackEligible: true,
              cause: error,
            });
          runtimeState.lastError = normalized.message;
          lastError = normalized;
          const canTryNextModel =
            attempts.length > 1 &&
            (
              normalized.code === 'cli_quota_exhausted' ||
              normalized.code === 'cli_rate_limited' ||
              normalized.code === 'cli_model_unsupported'
            ) &&
            model !== attempts[attempts.length - 1];
          if (canTryNextModel) continue;
          throw normalized;
        }
      }

      throw lastError ?? buildProviderError('cli_process_error', 'Gemini direct backend did not return a response.', {
        statusCode: 502,
        fallbackEligible: true,
      });
    },

    getDiagnostics(): Record<string, unknown> {
      return this.health() as unknown as Record<string, unknown>;
    },

    health(): GeminiCliHealthSnapshot {
      return buildGeminiCliHealthSnapshot(config, runtimeState);
    },

    async refreshHealth(): Promise<GeminiCliHealthSnapshot> {
      const runtime = await ensureRuntime(true);
      await refreshQuota(runtime, true);
      return buildGeminiCliHealthSnapshot(config, runtimeState);
    },
  };
}
