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
import type { GeminiCliHealthSnapshot, GeminiCliProviderConfig, GeminiQuotaBucket } from './types.js';

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

interface GoogleApiErrorShape {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown[];
}

const CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
const RUNTIME_TTL_MS = 30_000;

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

function upsertQuotaBucket(buckets: GeminiQuotaBucket[], next: GeminiQuotaBucket): GeminiQuotaBucket[] {
  const existing = buckets.findIndex((bucket) => bucket.modelId === next.modelId);
  if (existing < 0) return [...buckets, next];
  const copy = [...buckets];
  copy[existing] = next;
  return copy;
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

function summarizeGoogleError(error: unknown): GoogleApiErrorShape | null {
  const parseMessage = (value: string): GoogleApiErrorShape | null => {
    try {
      const parsed = JSON.parse(value.replace(/\u00A0/g, '').replace(/\n/g, ' ')) as { error?: unknown };
      if (parsed?.error && typeof parsed.error === 'object') {
        return parsed.error as GoogleApiErrorShape;
      }
      if (parsed && typeof parsed === 'object') {
        return parsed as unknown as GoogleApiErrorShape;
      }
      return null;
    } catch {
      return null;
    }
  };

  if (!error || typeof error !== 'object') {
    return typeof error === 'string' ? parseMessage(error) : null;
  }

  const record = error as Record<string, unknown>;
  if (record.response && typeof record.response === 'object') {
    const response = record.response as Record<string, unknown>;
    const data = response.data;
    if (data && typeof data === 'object') {
      const object = data as Record<string, unknown>;
      if (object.error && typeof object.error === 'object') {
        return object.error as GoogleApiErrorShape;
      }
      return object as GoogleApiErrorShape;
    }
  }

  if (record.error && typeof record.error === 'object') {
    return record.error as GoogleApiErrorShape;
  }

  if (typeof record.message === 'string') {
    return parseMessage(record.message);
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
    const violations = typed.violations;
    if (!Array.isArray(violations)) return false;
    return violations.some((violation) => {
      if (!violation || typeof violation !== 'object') return false;
      const v = violation as Record<string, unknown>;
      return v.reason === reason || String(v.description ?? '').includes(reason);
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

function isQuotaError(error: unknown): boolean {
  const googleError = summarizeGoogleError(error);
  const message = String(googleError?.message ?? (error instanceof Error ? error.message : String(error ?? '')));
  return (
    googleError?.code === 429 ||
    googleError?.status === 'RESOURCE_EXHAUSTED' ||
    /resource has been exhausted|quota|credits/i.test(message) ||
    hasDetailReason(googleError, 'RATE_LIMIT_EXCEEDED') ||
    hasDetailReason(googleError, 'QUOTA_EXHAUSTED') ||
    hasDetailReason(googleError, 'INSUFFICIENT_G1_CREDITS_BALANCE')
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

async function requestJson<T>(
  client: OAuth2Client,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
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
      data: payload,
      responseType: 'json',
      signal: controller.signal,
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
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveModelAttemptSequence(config: GeminiCliProviderConfig, requestedModel: string | undefined, runtimeState: GeminiCliRuntimeState): string[] {
  const primary = requestedModel && isDirectGeminiModelId(requestedModel) ? requestedModel : config.model;
  const ordered = [primary, ...config.models];
  const unique = [...new Set(ordered.map((value) => value.trim().toLowerCase()).filter(Boolean))];
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
    lastSuccessAt: null,
    lastLatencyMs: null,
    lastResolvedModel: null,
    projectId: null,
    userTier: null,
    userTierName: null,
    availableCredits: [],
    quotaBuckets: [],
    quotaUpdatedAt: null,
    quotaLastError: null,
  };

  let runtimeCache: CodeAssistRuntime | null = null;
  let runtimePromise: Promise<CodeAssistRuntime> | null = null;

  async function loadRuntime(): Promise<CodeAssistRuntime> {
    const cached = await loadGeminiCachedOAuthClient(config).catch((error) => {
      runtimeState.authReady = false;
      runtimeState.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });

    if (!cached) {
      runtimeState.authReady = false;
      throw buildProviderError(
        'cli_auth_missing',
        'Gemini cached Google auth is missing. Run pnpm login:gemini-cli.',
        {
          statusCode: 503,
          fallbackEligible: true,
        },
      );
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
    ).catch((error) => {
      if (error instanceof LLMProviderError) throw error;
      if (isAuthExpiredError(error)) {
        runtimeState.authReady = false;
        throw buildProviderError('cli_auth_expired', 'Gemini cached Google auth expired or was revoked.', {
          statusCode: 503,
          fallbackEligible: true,
          cause: error,
        });
      }
      if (isQuotaError(error)) {
        throw buildProviderError('cli_quota_exhausted', 'Gemini direct quota is exhausted right now.', {
          statusCode: 429,
          fallbackEligible: true,
          cause: error,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw buildProviderError('cli_process_error', message, {
        statusCode: 502,
        fallbackEligible: true,
        cause: error,
      });
    });

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
      runtimeState.quotaUpdatedAt = new Date().toISOString();
      runtimeState.quotaLastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtimeState.quotaLastError = message;
      if (error instanceof LLMProviderError && error.code === 'cli_quota_exhausted') {
        runtimeState.quotaUpdatedAt = new Date().toISOString();
      }
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
    ).catch((error) => {
      if (error instanceof LLMProviderError) throw error;
      if (isModelUnsupportedError(error)) {
        throw buildProviderError('cli_model_unsupported', `Gemini direct model ${model} is not available for this account.`, {
          statusCode: 400,
          fallbackEligible: false,
          cause: error,
        });
      }
      if (isAuthExpiredError(error)) {
        runtimeState.authReady = false;
        throw buildProviderError('cli_auth_expired', 'Gemini cached Google auth expired or was revoked.', {
          statusCode: 503,
          fallbackEligible: true,
          cause: error,
        });
      }
      if (isQuotaError(error)) {
        runtimeState.quotaBuckets = upsertQuotaBucket(runtimeState.quotaBuckets ?? [], {
          modelId: model,
          remainingAmount: '0',
          remainingFraction: 0,
          resetTime: null,
          tokenType: null,
        });
        runtimeState.quotaUpdatedAt = new Date().toISOString();
        runtimeState.quotaLastError = error instanceof Error ? error.message : String(error);
        throw buildProviderError('cli_quota_exhausted', `Gemini direct quota is exhausted for ${model}.`, {
          statusCode: 429,
          fallbackEligible: true,
          cause: error,
        });
      }
      if (isPolicyBlockedError(error)) {
        throw buildProviderError('cli_policy_blocked', 'Gemini direct request was blocked by policy or safety controls.', {
          statusCode: 400,
          fallbackEligible: false,
          cause: error,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw buildProviderError('cli_process_error', message, {
        statusCode: 502,
        fallbackEligible: true,
        cause: error,
      });
    });

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
            (normalized.code === 'cli_quota_exhausted' || normalized.code === 'cli_model_unsupported') &&
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
