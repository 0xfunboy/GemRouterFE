import 'dotenv/config';

import { timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

import { loadConfig } from './config.js';
import { buildCompatibilityRoutes, type ApiSurface } from './lib/compatibility.js';
import {
  buildDiscoveredModelCatalog,
  describePublicModel,
  inferModelCapabilities,
  isGeminiImageGenerationModelId,
  isGemRouterCompatibleModelCapabilities,
} from './lib/models.js';
import {
  buildChatCompletionResponse,
  buildImageGenerationResponse,
  buildOpenAIError,
  buildResponsesApiResponse,
  createRequestFingerprint,
  estimateUsage,
  type ImageGenerationsRequest,
  parseImageGenerationsRequest,
  normalizeModelId,
  parseChatCompletionsRequest,
  parseResponsesRequest,
  sanitizeSessionHint,
  type ChatCompletionsRequest,
  type ResponsesRequest,
  type UsageSummary,
} from './lib/openai.js';
import {
  buildOllamaChatChunk,
  buildOllamaChatDone,
  buildOllamaChatResponse,
  buildOllamaError,
  buildOllamaGenerateChunk,
  buildOllamaGenerateDone,
  buildOllamaGenerateResponse,
  buildOllamaShowResponse,
  buildOllamaTagsResponse,
  parseOllamaChatRequest,
  parseOllamaGenerateRequest,
  type OllamaChatRequest,
  type OllamaGenerateRequest,
} from './lib/ollama.js';
import { createGeminiApiClient } from './llm/providers/gemini-api/client.js';
import { LLMProviderError } from './llm/errors.js';
import { createLlmRouter } from './llm/router.js';
import type { LLMBackendId, LLMBackendPreference, LLMMessage, LLMOptions, LLMResponse } from './llm/types.js';
import type {
  SemanticActionPolicy,
  SemanticChannel,
  SemanticJsonPresentation,
  SemanticOutputMode,
  SemanticProfile,
} from './lib/semantics.js';
import { AuditLogger } from './store/audit.js';
import { AdminSessionStore } from './store/adminSessions.js';
import { AppStore, type ApiAppRecord } from './store/appStore.js';
import { CompatibilityStore } from './store/compatibilityStore.js';
import { InteractionStore } from './store/interactions.js';
import { renderAppShell } from './ui.js';

const PROJECT_NAME = 'GemRouter';
const SERVICE_NAME = 'gem-router';
const ADMIN_COOKIE_NAME = 'gemrouter_admin_session';

const config = loadConfig();
const geminiApiLlm = createGeminiApiClient(config.geminiApi);
const llm = createLlmRouter(config.llmRouting, {
  geminiApi: geminiApiLlm,
});
const appStore = new AppStore(config.appsStorePath);
const audit = new AuditLogger(config.auditLogPath);
const adminSessions = new AdminSessionStore(config.adminSessionTtlMs);
const compatibility = new CompatibilityStore(config.compatibility.settingsStorePath, {
  defaultSurface: config.compatibility.defaultSurface,
  enabledSurfaces: config.compatibility.enabledSurfaces,
});
const interactions = new InteractionStore(config.interactionsStorePath);

const bootstrapApp = appStore.ensureBootstrapApp({
  name: config.bootstrapApp.name,
  rawKey: config.bootstrapApp.apiKey,
  allowedOrigins: config.bootstrapApp.allowedOrigins,
  allowedModels: config.bootstrapApp.allowedModels,
  sessionNamespace: config.bootstrapApp.sessionNamespace,
  rateLimitPerMinute: config.bootstrapApp.rateLimitPerMinute,
  maxConcurrency: config.bootstrapApp.maxConcurrency,
});

const app = Fastify({
  logger: false,
  requestIdHeader: 'x-request-id',
  disableRequestLogging: true,
});

function stableCompare(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type AuthenticatedClientApp = NonNullable<ReturnType<AppStore['verify']>>;
type AuthenticatedClientAccess = {
  release: () => void;
  app: AuthenticatedClientApp;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStartedAt(request: FastifyRequest): number {
  const raw = (request as FastifyRequest & { startedAt?: number }).startedAt;
  return typeof raw === 'number' ? raw : Date.now();
}

function setStartedAt(request: FastifyRequest): void {
  (request as FastifyRequest & { startedAt?: number }).startedAt = Date.now();
}

function getBearerToken(request: FastifyRequest): string | null {
  const auth = String(request.headers.authorization ?? '').trim();
  const bearerMatch = auth.match(/^bearer\s+(.+)$/i);
  if (bearerMatch?.[1]?.trim()) return bearerMatch[1].trim();
  const basicMatch = auth.match(/^basic\s+(.+)$/i);
  if (basicMatch?.[1]) {
    try {
      const decoded = Buffer.from(basicMatch[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        const username = decoded.slice(0, separator).trim();
        const password = decoded.slice(separator + 1).trim();
        return password || username || null;
      }
      return decoded.trim() || null;
    } catch {
      return null;
    }
  }
  const apiKey = String(request.headers['x-api-key'] ?? '').trim();
  return apiKey || null;
}

function parseCookies(request: FastifyRequest): Record<string, string> {
  const raw = String(request.headers.cookie ?? '');
  const entries = raw
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const separator = chunk.indexOf('=');
      if (separator < 0) return [chunk, ''];
      return [chunk.slice(0, separator), decodeURIComponent(chunk.slice(separator + 1))];
    });
  return Object.fromEntries(entries);
}

function getAdminSessionId(request: FastifyRequest): string | undefined {
  return parseCookies(request)[ADMIN_COOKIE_NAME];
}

function getAdminSession(request: FastifyRequest) {
  return adminSessions.read(getAdminSessionId(request));
}

function setAdminCookie(reply: FastifyReply, sessionId: string): void {
  reply.header(
    'set-cookie',
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      config.adminSessionTtlMs / 1000,
    )}`,
  );
}

function clearAdminCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
}

function findDashboardAdminUser(username: string, password: string): { username: string } | null {
  const normalizedUsername = username.trim();
  const normalizedPassword = password.trim();
  if (!normalizedUsername || !normalizedPassword) return null;

  const match = config.dashboardAdminUsers.find((entry) => (
    stableCompare(entry.username, normalizedUsername) &&
    stableCompare(entry.password, normalizedPassword)
  ));
  return match ? { username: match.username } : null;
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  input: { message: string; type: string; code: string; param?: string | null },
): FastifyReply {
  return reply.code(statusCode).send(buildOpenAIError(input));
}

function readHeaderValue(request: FastifyRequest, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = request.headers[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function getRequestOrigin(request: FastifyRequest): string | undefined {
  return readHeaderValue(request, 'origin');
}

function inferPublicBaseUrl(request: FastifyRequest): string {
  if (config.publicBaseUrl?.trim()) return config.publicBaseUrl.trim();
  const proto = readHeaderValue(request, 'x-forwarded-proto') ?? 'http';
  const host = readHeaderValue(request, 'x-forwarded-host') ?? String(request.headers.host ?? `127.0.0.1:${config.port}`);
  return `${proto}://${host}`;
}

function getCompatibilitySnapshot(request: FastifyRequest): {
  defaultSurface: ApiSurface;
  enabledSurfaces: ApiSurface[];
  updatedAt: string;
  endpoints: Record<ApiSurface, { enabled: boolean; routes: ReturnType<typeof buildCompatibilityRoutes>[ApiSurface] }>;
} {
  const state = compatibility.get();
  const routes = buildCompatibilityRoutes(inferPublicBaseUrl(request));
  return {
    defaultSurface: state.defaultSurface,
    enabledSurfaces: state.enabledSurfaces,
    updatedAt: state.updatedAt,
    endpoints: {
      gemrouter: {
        enabled: state.enabledSurfaces.includes('gemrouter'),
        routes: routes.gemrouter,
      },
      openai: {
        enabled: state.enabledSurfaces.includes('openai'),
        routes: routes.openai,
      },
      deepseek: {
        enabled: state.enabledSurfaces.includes('deepseek'),
        routes: routes.deepseek,
      },
      ollama: {
        enabled: state.enabledSurfaces.includes('ollama'),
        routes: routes.ollama,
      },
    },
  };
}

function isSurfaceEnabled(surface: ApiSurface): boolean {
  return compatibility.get().enabledSurfaces.includes(surface);
}

function ensureOpenAiSurfaceEnabled(surface: ApiSurface, reply: FastifyReply): boolean {
  if (isSurfaceEnabled(surface)) return true;
  sendError(reply, 404, {
    message: `${surface} compatibility surface is disabled`,
    type: 'invalid_request_error',
    code: 'surface_disabled',
  });
  return false;
}

function isAnySurfaceEnabled(surfaces: ApiSurface[]): boolean {
  return surfaces.some((surface) => isSurfaceEnabled(surface));
}

function ensureAnySurfaceEnabled(
  surfaces: ApiSurface[],
  reply: FastifyReply,
  label: string,
): boolean {
  if (isAnySurfaceEnabled(surfaces)) return true;
  sendError(reply, 404, {
    message: `${label} compatibility surface is disabled`,
    type: 'invalid_request_error',
    code: 'surface_disabled',
  });
  return false;
}

function sendOllamaError(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply.code(statusCode).send(buildOllamaError(message));
}

function ensureOllamaSurfaceEnabled(reply: FastifyReply): boolean {
  if (isSurfaceEnabled('ollama')) return true;
  sendOllamaError(reply, 404, 'ollama compatibility surface is disabled');
  return false;
}

function wantsHtml(request: FastifyRequest): boolean {
  const accept = String(request.headers.accept ?? '').toLowerCase();
  return accept.includes('text/html');
}

function isSocialPreviewBot(request: FastifyRequest): boolean {
  const userAgent = String(request.headers['user-agent'] ?? '').toLowerCase();
  return /(discordbot|facebookexternalhit|linkedinbot|slackbot|telegrambot|twitterbot|whatsapp|skypeuripreview|embedly|crawler|spider|preview)/i.test(userAgent);
}

function wantsHtmlShell(request: FastifyRequest): boolean {
  return wantsHtml(request) || isSocialPreviewBot(request);
}

function sanitizeAdminApp(appRecord: ApiAppRecord): Omit<ApiAppRecord, 'apiKeyHash'> {
  const { apiKeyHash: _apiKeyHash, ...rest } = appRecord;
  return rest;
}

function setCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
  const origin = getRequestOrigin(request) ?? null;
  if (origin && appStore.isOriginAllowedGlobally(origin)) {
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-credentials', 'true');
  }
  reply.header(
    'access-control-allow-headers',
    [
      'Authorization',
      'Content-Type',
      'x-api-key',
      'x-gemrouter-session',
      'x-gemrouter-user',
      'x-gemrouter-stateful',
      'x-gemrouter-backend',
      'x-baribi-session',
      'x-baribi-user',
      'x-baribi-stateful',
      'x-baribi-backend',
      'OpenAI-Organization',
      'OpenAI-Project',
    ].join(', '),
  );
  reply.header('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
}

function hasAdminAccess(request: FastifyRequest): boolean {
  const token = getBearerToken(request);
  if (token === config.adminToken) return true;
  return getAdminSession(request) !== null;
}

function ensureAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!hasAdminAccess(request)) {
    sendError(reply, 401, {
      message: 'Invalid admin token or session',
      type: 'authentication_error',
      code: 'invalid_admin_token',
    });
    return false;
  }
  return true;
}

async function ensureClientAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedClientAccess | null> {
  const token = getBearerToken(request);
  if (!token) {
    sendError(reply, 401, {
      message: 'Missing API key',
      type: 'authentication_error',
      code: 'missing_api_key',
    });
    return null;
  }

  const clientApp = appStore.verify(token);
  if (!clientApp) {
    sendError(reply, 401, {
      message: 'Invalid API key',
      type: 'authentication_error',
      code: 'invalid_api_key',
    });
    return null;
  }

  const origin = getRequestOrigin(request) ?? null;
  if (!appStore.isOriginAllowedForApp(clientApp, origin)) {
    sendError(reply, 403, {
      message: `Origin not allowed for app ${clientApp.name}`,
      type: 'permission_error',
      code: 'origin_not_allowed',
    });
    return null;
  }

  if (!appStore.consumeRateLimit(clientApp)) {
    sendError(reply, 429, {
      message: 'Rate limit exceeded',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    });
    return null;
  }

  let release = appStore.acquireConcurrency(clientApp);
  if (!release && clientApp.maxConcurrency > 0 && config.bootstrapApp.concurrencyWaitMs > 0) {
    const deadline = Date.now() + config.bootstrapApp.concurrencyWaitMs;
    while (!release && Date.now() < deadline) {
      await sleep(250);
      release = appStore.acquireConcurrency(clientApp);
    }
  }

  if (!release) {
    sendError(reply, 429, {
      message: 'Concurrency limit exceeded',
      type: 'rate_limit_error',
      code: 'concurrency_limit_exceeded',
    });
    return null;
  }

  return { app: clientApp, release };
}

function ensureModelAllowed(
  reply: FastifyReply,
  clientApp: AuthenticatedClientApp | ApiAppRecord,
  modelId: string,
): boolean {
  if (!appStore.isModelAllowed(clientApp, modelId)) {
    sendError(reply, 403, {
      message: `Model ${modelId} is not enabled for app ${clientApp.name}`,
      type: 'permission_error',
      code: 'model_not_allowed',
      param: 'model',
    });
    return false;
  }
  return true;
}

function buildSessionOptions(input: {
  model: string;
  allowedModelIds?: string[];
  maxTokens?: number;
  temperature?: number;
  sessionNamespace: string;
  sessionHint?: string;
  user?: string;
  stateful?: boolean;
  fingerprintFallback: string;
  semanticSurface?: ApiSurface;
  backendPreference?: LLMBackendPreference;
}): LLMOptions {
  const rawSessionHint = input.sessionHint || input.user;
  const sessionHint = sanitizeSessionHint(rawSessionHint, input.fingerprintFallback);
  const semanticSurface = input.semanticSurface ?? 'openai';
  const sessionKey = `${input.sessionNamespace}:${semanticSurface}:${sessionHint}`;
  return {
    model: input.model,
    allowedModelIds: input.allowedModelIds,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    sessionKey,
    sessionLabel: sessionKey,
    resetSession: input.stateful !== true,
    backendPreference: input.backendPreference,
  };
}

function parseBackendPreference(request: FastifyRequest): LLMBackendPreference {
  const raw = readHeaderValue(request, 'x-gemrouter-backend', 'x-baribi-backend');
  if (!raw) return 'auto';
  const value = raw.trim().toLowerCase();
  if (value === 'auto') return 'auto';
  if (value === 'gemini-api' || value === 'gemini' || value === 'ai-studio') return 'gemini-api';
  throw new Error(`Unsupported backend override: ${raw}`);
}

function buildRequestLlmOptions(input: {
  request: FastifyRequest;
  user?: string;
  sessionNamespace: string;
  model: string;
  allowedModelIds?: string[];
  maxTokens?: number;
  temperature?: number;
  fingerprintFallback: string;
  semanticSurface?: ApiSurface;
}): LLMOptions {
  const rawSessionHint =
    readHeaderValue(input.request, 'x-gemrouter-session', 'x-baribi-session') ||
    readHeaderValue(input.request, 'x-gemrouter-user', 'x-baribi-user') ||
    input.user;
  const statefulHeader = String(
    readHeaderValue(input.request, 'x-gemrouter-stateful', 'x-baribi-stateful') ?? '',
  )
    .trim()
    .toLowerCase();
  const stateful = ['1', 'true', 'yes', 'on'].includes(statefulHeader);
  return buildSessionOptions({
    backendPreference: parseBackendPreference(input.request),
    model: input.model,
    allowedModelIds: input.allowedModelIds,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    sessionNamespace: input.sessionNamespace,
    sessionHint: rawSessionHint,
    user: input.user,
    stateful,
    fingerprintFallback: input.fingerprintFallback,
    semanticSurface: input.semanticSurface,
  });
}

function buildSemanticProfile(input: {
  surface: ApiSurface;
  channel: SemanticChannel;
  outputMode: SemanticOutputMode;
  jsonSchema?: unknown;
  jsonPresentation?: SemanticJsonPresentation;
  actionPolicy?: SemanticActionPolicy;
}): SemanticProfile {
  return {
    surface: input.surface,
    channel: input.channel,
    outputMode: input.outputMode,
    jsonSchema: input.jsonSchema,
    jsonPresentation: input.jsonPresentation,
    actionPolicy: input.actionPolicy,
  };
}

function flattenPrompt(messages: LLMMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n');
}

function recordInteraction(input: {
  request: FastifyRequest;
  route: string;
  appRecord: ApiAppRecord;
  model: string;
  messages: LLMMessage[];
  responseText?: string;
  usage?: UsageSummary;
  status: 'succeeded' | 'failed';
  statusCode: number;
  provider?: string;
  error?: string;
}): void {
  interactions.record({
    requestId: input.request.id,
    appId: input.appRecord.id,
    appName: input.appRecord.name,
    route: input.route,
    model: input.model,
    prompt: flattenPrompt(input.messages),
    response: input.responseText,
    usage: input.usage,
    status: input.status,
    statusCode: input.statusCode,
    latencyMs: Date.now() - getStartedAt(input.request),
    origin: getRequestOrigin(input.request),
    provider: input.provider,
    error: input.error,
  });
}

function sanitizeLlmDiagnostics(
  input: Record<string, unknown> | null,
  _options?: { includeSensitive?: boolean },
): Record<string, unknown> | null {
  if (!input) return null;
  return {
    provider: input.provider ?? null,
    model: input.model ?? null,
    backendOrder: input.backendOrder ?? [],
    configuredDefaultBackend: input.configuredDefaultBackend ?? null,
    lastBackendUsed: input.lastBackendUsed ?? null,
    lastFallbackFrom: input.lastFallbackFrom ?? null,
    lastFallbackReason: input.lastFallbackReason ?? null,
    lastResolutionAt: input.lastResolutionAt ?? null,
    lastError: input.lastError ?? null,
    geminiApi:
      input.geminiApi && typeof input.geminiApi === 'object'
        ? {
          provider: (input.geminiApi as Record<string, unknown>).provider ?? 'gemini-api',
          enabled: (input.geminiApi as Record<string, unknown>).enabled ?? null,
          available: (input.geminiApi as Record<string, unknown>).available ?? null,
          configuredKeyCount: (input.geminiApi as Record<string, unknown>).configuredKeyCount ?? 0,
          usableKeyCount: (input.geminiApi as Record<string, unknown>).usableKeyCount ?? 0,
          defaultTier: (input.geminiApi as Record<string, unknown>).defaultTier ?? null,
          baseUrl: (input.geminiApi as Record<string, unknown>).baseUrl ?? null,
          version: (input.geminiApi as Record<string, unknown>).version ?? null,
          keys: (input.geminiApi as Record<string, unknown>).keys ?? [],
          quotaGroups: (input.geminiApi as Record<string, unknown>).quotaGroups ?? [],
          quotaUpdatedAt: (input.geminiApi as Record<string, unknown>).quotaUpdatedAt ?? null,
          modelDiscovery: (input.geminiApi as Record<string, unknown>).modelDiscovery ?? null,
          models: (input.geminiApi as Record<string, unknown>).models ?? [],
          lastSelectedKeyId: (input.geminiApi as Record<string, unknown>).lastSelectedKeyId ?? null,
          lastSelectedQuotaGroup: (input.geminiApi as Record<string, unknown>).lastSelectedQuotaGroup ?? null,
          lastResolvedModel: (input.geminiApi as Record<string, unknown>).lastResolvedModel ?? null,
          lastError: (input.geminiApi as Record<string, unknown>).lastError ?? null,
          lastFailureAt: (input.geminiApi as Record<string, unknown>).lastFailureAt ?? null,
          lastSuccessAt: (input.geminiApi as Record<string, unknown>).lastSuccessAt ?? null,
          lastLatencyMs: (input.geminiApi as Record<string, unknown>).lastLatencyMs ?? null,
          lastUpstreamError: (input.geminiApi as Record<string, unknown>).lastUpstreamError ?? null,
        }
        : null,
  };
}

function resolveProviderLabel(response: LLMResponse): string {
  return response.provider || response.backend || 'unknown';
}

function applyBackendHeaders(reply: FastifyReply, response: LLMResponse): void {
  if (response.backend) reply.header('x-gemrouter-backend', response.backend);
  reply.header('x-gemrouter-provider', resolveProviderLabel(response));
  if (response.fallbackFrom) reply.header('x-gemrouter-fallback-from', response.fallbackFrom);
  if (response.fallbackReason) reply.header('x-gemrouter-fallback-reason', response.fallbackReason);
  if (response.backendModel) reply.header('x-gemrouter-backend-model', response.backendModel);
  if (response.apiKeyId) reply.header('x-gemrouter-api-key-id', response.apiKeyId);
  if (response.quotaGroup) reply.header('x-gemrouter-quota-group', response.quotaGroup);
  if (response.quotaSource) reply.header('x-gemrouter-quota-source', response.quotaSource);
}

function applyErrorHeaders(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof LLMProviderError)) return;
  reply.header('x-gemrouter-backend', error.backend);
  reply.header('x-gemrouter-provider', error.backend);
  if (error.options.fallbackFrom) reply.header('x-gemrouter-fallback-from', error.options.fallbackFrom);
  if (error.options.fallbackReason) reply.header('x-gemrouter-fallback-reason', error.options.fallbackReason);
}

function buildAuditDetailsFromResponse(response: LLMResponse): Record<string, unknown> {
  return {
    provider: resolveProviderLabel(response),
    backend: response.backend ?? null,
    backendModel: response.backendModel ?? null,
    fallbackFrom: response.fallbackFrom ?? null,
    fallbackReason: response.fallbackReason ?? null,
  };
}

function buildStreamResponseHeaders(request: FastifyRequest, response?: LLMResponse): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-request-id': request.id,
  };
  if (response?.backend) headers['x-gemrouter-backend'] = response.backend;
  if (response?.provider) headers['x-gemrouter-provider'] = response.provider;
  if (response?.fallbackFrom) headers['x-gemrouter-fallback-from'] = response.fallbackFrom;
  if (response?.fallbackReason) headers['x-gemrouter-fallback-reason'] = response.fallbackReason;
  if (response?.backendModel) headers['x-gemrouter-backend-model'] = response.backendModel;
  if (response?.apiKeyId) headers['x-gemrouter-api-key-id'] = response.apiKeyId;
  if (response?.quotaGroup) headers['x-gemrouter-quota-group'] = response.quotaGroup;
  if (response?.quotaSource) headers['x-gemrouter-quota-source'] = response.quotaSource;
  return headers;
}

function buildNdjsonResponseHeaders(request: FastifyRequest, response?: LLMResponse): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-request-id': request.id,
  };
  if (response?.backend) headers['x-gemrouter-backend'] = response.backend;
  if (response?.provider) headers['x-gemrouter-provider'] = response.provider;
  if (response?.fallbackFrom) headers['x-gemrouter-fallback-from'] = response.fallbackFrom;
  if (response?.fallbackReason) headers['x-gemrouter-fallback-reason'] = response.fallbackReason;
  if (response?.backendModel) headers['x-gemrouter-backend-model'] = response.backendModel;
  if (response?.apiKeyId) headers['x-gemrouter-api-key-id'] = response.apiKeyId;
  if (response?.quotaGroup) headers['x-gemrouter-quota-group'] = response.quotaGroup;
  if (response?.quotaSource) headers['x-gemrouter-quota-source'] = response.quotaSource;
  return headers;
}

function mapLlmErrorToHttp(error: unknown): {
  statusCode: number;
  type: string;
  code: string;
  message: string;
} {
  if (error instanceof LLMProviderError) {
    const statusCode = error.options.statusCode ?? 502;
    const type =
      error.code === 'gemini_api_rate_limited' ||
      error.code === 'gemini_api_quota_unavailable'
        ? 'rate_limit_error'
        : error.code === 'gemini_api_invalid_request' ||
            error.code === 'gemini_api_model_not_found'
          ? 'invalid_request_error'
          : 'server_error';
    return {
      statusCode,
      type,
      code: error.code,
      message: error.message,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/unsupported backend override/i.test(message)) {
    return {
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'invalid_backend_override',
      message,
    };
  }
  return {
    statusCode: 500,
    type: 'server_error',
    code: 'llm_request_failed',
    message,
  };
}

function classifyInteractionRoute(route: string): string {
  if (route.includes('/images/generations')) return 'images';
  if (route.includes('/chat/completions')) return 'chat';
  if (route.includes('/responses')) return 'responses';
  if (route.includes('/api/chat')) return 'ollama_chat';
  if (route.includes('/api/generate')) return 'ollama_generate';
  if (route.includes('/models') || route.includes('/api/tags') || route.includes('/api/show')) return 'models';
  return 'other';
}

function formatHourLabel(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 16);
}

function buildProviderModelState(
  geminiApi: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const apiModels = Array.isArray(geminiApi.models) ? geminiApi.models as Record<string, unknown>[] : [];
  const apiModelIds = new Set(apiModels.map((model) => String(model.id ?? '').trim()).filter(Boolean));
  const apiAvailable = geminiApi.available === true;

  return buildCompatibleSurfaceModelCatalog(geminiApi, 'chat-or-image').map((model) => {
    const modelId = String(model.id ?? '').trim();
    const descriptor = describePublicModel(modelId);
    return {
      ...descriptor,
      displayName: model.displayName ?? descriptor.label,
      label: model.label ?? descriptor.label,
      capabilities: model.capabilities ?? inferModelCapabilities(modelId, ['generateContent']),
      available: apiAvailable && (apiModelIds.size === 0 || apiModelIds.has(modelId)),
      backends: {
        geminiApi: apiAvailable && (apiModelIds.size === 0 || apiModelIds.has(modelId)),
      },
    };
  });
}

function buildAdminModelCatalog(
  geminiApi: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const discovered = Array.isArray(geminiApi.models) ? geminiApi.models as Array<Record<string, unknown>> : [];
  if (discovered.length > 0) {
    return buildDiscoveredModelCatalog(
      discovered.map((model) => ({
        id: String(model.id ?? '').trim(),
        displayName: typeof model.displayName === 'string' ? model.displayName : null,
        supportedGenerationMethods: Array.isArray(model.supportedGenerationMethods)
          ? model.supportedGenerationMethods.map((method) => String(method))
          : [],
      })).filter((model) => model.id),
    ) as unknown as Array<Record<string, unknown>>;
  }

  return config.modelIds.map((modelId) => ({
    id: modelId,
    displayName: modelId,
    label: modelId,
    supportedGenerationMethods: ['generateContent'],
    capabilities: inferModelCapabilities(modelId, ['generateContent']),
  }));
}

function modelSupportsSurface(
  model: Record<string, unknown>,
  mode: 'chat' | 'chat-or-image',
): boolean {
  const capabilities = (model.capabilities as Record<string, unknown> | null) ?? null;
  const chat = capabilities?.chat === true;
  const imageGeneration = capabilities?.imageGeneration === true;
  if (mode === 'chat') return chat;
  return chat || imageGeneration;
}

function buildCompatibleSurfaceModelCatalog(
  geminiApi: Record<string, unknown>,
  mode: 'chat' | 'chat-or-image',
): Array<Record<string, unknown>> {
  return buildAdminModelCatalog(geminiApi).filter((model) => {
    const capabilities = model.capabilities as ReturnType<typeof inferModelCapabilities> | undefined;
    if (capabilities) {
      return mode === 'chat'
        ? capabilities.chat
        : isGemRouterCompatibleModelCapabilities(capabilities);
    }
    return modelSupportsSurface(model, mode);
  });
}

function buildCompatibleSurfaceModelIds(
  geminiApi: Record<string, unknown>,
  mode: 'chat' | 'chat-or-image',
): string[] {
  return buildCompatibleSurfaceModelCatalog(geminiApi, mode)
    .map((model) => String(model.id ?? '').trim())
    .filter(Boolean);
}

function buildProviderSnapshot(
  geminiApi: Record<string, unknown>,
): Record<string, unknown> {
  const routedModelIds = buildCompatibleSurfaceModelIds(geminiApi, 'chat');
  return {
    backend: 'gemini-api',
    configuredModel: routedModelIds[0] ?? config.modelIds[0] ?? null,
    geminiApi: {
      enabled: geminiApi.enabled ?? null,
      available: geminiApi.available ?? null,
      configuredKeyCount: geminiApi.configuredKeyCount ?? 0,
      usableKeyCount: geminiApi.usableKeyCount ?? 0,
      defaultTier: geminiApi.defaultTier ?? null,
      modelDiscovery: geminiApi.modelDiscovery ?? null,
      lastSelectedKeyId: geminiApi.lastSelectedKeyId ?? null,
      lastSelectedQuotaGroup: geminiApi.lastSelectedQuotaGroup ?? null,
      lastResolvedModel: geminiApi.lastResolvedModel ?? null,
      lastError: geminiApi.lastError ?? null,
      lastFailureAt: geminiApi.lastFailureAt ?? null,
      lastSuccessAt: geminiApi.lastSuccessAt ?? null,
    },
    quota: {
      apiKeys: geminiApi.keys ?? [],
      quotaGroups: geminiApi.quotaGroups ?? [],
      models: geminiApi.models ?? [],
    },
    models: buildProviderModelState(geminiApi),
  };
}

function resolveActiveDefaultBackend(
  backendOrder: LLMBackendId[],
  geminiApiAvailable: boolean,
): LLMBackendId {
  for (const backend of backendOrder) {
    if (backend === 'gemini-api' && geminiApiAvailable) return backend;
  }
  return backendOrder[0] ?? 'gemini-api';
}

function buildGuestSummary() {
  const runtime = getRuntimeSnapshot();
  const routing = (runtime.routing as Record<string, unknown> | undefined) ?? {};
  const backends = (runtime.backends as Record<string, unknown> | undefined) ?? {};
  const geminiApi = (backends.geminiApi as Record<string, unknown> | undefined) ?? {};
  const provider = (runtime.provider as Record<string, unknown> | undefined) ?? {};
  const providerQuota = (provider.quota as Record<string, unknown> | undefined) ?? {};
  const publicApiKeys = Array.isArray(providerQuota.apiKeys)
    ? (providerQuota.apiKeys as Record<string, unknown>[]).map((key) => ({
      enabled: key.enabled !== false,
      priority: key.priority ?? 0,
      lastUsedAt: key.lastUsedAt ?? null,
    }))
    : [];
  const publicQuotaGroups = Array.isArray(providerQuota.quotaGroups)
    ? (providerQuota.quotaGroups as Record<string, unknown>[]).map((group) => ({
      models: Array.isArray(group.models)
        ? (group.models as Record<string, unknown>[]).map((model) => ({
          model: model.model ?? 'unknown',
          rpm: model.rpm ?? null,
          tpm: model.tpm ?? null,
          rpd: model.rpd ?? null,
          cooldownUntil: model.cooldownUntil ?? null,
          source: model.source ?? 'local-ledger',
        }))
        : [],
    }))
    : [];
  const providerModels = Array.isArray(provider.models) ? provider.models as Record<string, unknown>[] : [];
  const stats = interactions.summary(24);
  const recent = interactions.list(240);
  const now = Date.now();
  const currentHour = Math.floor(now / (60 * 60_000)) * (60 * 60_000);
  const start = currentHour - 23 * 60 * 60_000;
  const hourBuckets = Array.from({ length: 24 }, (_, index) => {
    const bucketStart = start + index * 60 * 60_000;
    return {
      key: Math.floor(bucketStart / (60 * 60_000)),
      label: formatHourLabel(bucketStart),
      requests: 0,
      failed: 0,
    };
  });
  const hourlyIndex = new Map(hourBuckets.map((bucket) => [bucket.key, bucket]));
  const routeCounts = new Map<string, number>();

  for (const record of recent) {
    const createdAt = Date.parse(record.createdAt);
    if (Number.isFinite(createdAt) && createdAt >= start) {
      const key = Math.floor(createdAt / (60 * 60_000));
      const bucket = hourlyIndex.get(key);
      if (bucket) {
        bucket.requests += 1;
        if (record.status === 'failed') bucket.failed += 1;
      }
    }

    const routeKey = classifyInteractionRoute(record.route);
    routeCounts.set(routeKey, (routeCounts.get(routeKey) ?? 0) + 1);
  }

  const totalRequests = stats.totals.requests || 0;
  const totalSucceeded = stats.totals.succeeded || 0;
  const totalFailed = stats.totals.failed || 0;
  const successRatePct = totalRequests > 0 ? Math.round((totalSucceeded / totalRequests) * 1000) / 10 : 0;

  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    ts: new Date().toISOString(),
    runtime: {
      backendOnly: true,
      activeDefaultBackend: routing.activeDefaultBackend ?? null,
      lastBackendUsed: routing.lastBackendUsed ?? null,
      geminiApiAvailable: geminiApi.available ?? null,
    },
    compatibility: {
      defaultSurface: compatibility.get().defaultSurface,
      enabledSurfaces: compatibility.get().enabledSurfaces,
    },
    provider: {
      configuredModel: provider.configuredModel ?? null,
      directModelCount: providerModels.length,
      quota: {
        apiKeys: publicApiKeys,
        quotaGroups: publicQuotaGroups,
      },
    },
    stats: {
      requests: totalRequests,
      succeeded: totalSucceeded,
      failed: totalFailed,
      successRatePct,
      avgLatencyMs: stats.totals.avgLatencyMs,
      totalTokens: stats.totals.totalTokens,
      promptTokens: stats.totals.promptTokens,
      completionTokens: stats.totals.completionTokens,
    },
    charts: {
      hourly: hourBuckets,
      routes: [...routeCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 6)
        .map(([label, requests]) => ({ label, requests })),
    },
  };
}

function getRuntimeSnapshot(
  request?: FastifyRequest,
  options?: { includeSensitiveLlm?: boolean },
): Record<string, unknown> {
  const rawLlmDiagnostics = typeof llm.getDiagnostics === 'function' ? llm.getDiagnostics() : null;
  const sanitizedLlmDiagnostics = sanitizeLlmDiagnostics(rawLlmDiagnostics, { includeSensitive: options?.includeSensitiveLlm });
  const geminiApiDiagnostics = ((sanitizedLlmDiagnostics?.geminiApi as Record<string, unknown> | undefined) ?? {});
  const backendOrder = (sanitizedLlmDiagnostics?.backendOrder as LLMBackendId[] | undefined) ?? config.llmRouting.backendOrder;
  const configuredDefaultBackend = ((sanitizedLlmDiagnostics?.configuredDefaultBackend as LLMBackendId | undefined) ?? backendOrder[0] ?? 'gemini-api');
  const geminiApiAvailable = Boolean(geminiApiDiagnostics.enabled) && Boolean(geminiApiDiagnostics.available);
  const activeDefaultBackend = resolveActiveDefaultBackend(backendOrder, geminiApiAvailable);
  const provider = buildProviderSnapshot(geminiApiDiagnostics);

  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    ts: new Date().toISOString(),
    backendOrder,
    fallbackEnabled: backendOrder.length > 1,
    routing: {
      configuredDefaultBackend,
      activeDefaultBackend,
      lastBackendUsed: sanitizedLlmDiagnostics?.lastBackendUsed ?? null,
      lastFallbackFrom: sanitizedLlmDiagnostics?.lastFallbackFrom ?? null,
      lastFallbackReason: sanitizedLlmDiagnostics?.lastFallbackReason ?? null,
      lastResolutionAt: sanitizedLlmDiagnostics?.lastResolutionAt ?? null,
    },
    runtime: {
      backendOnly: true,
    },
    provider,
    models: buildCompatibleSurfaceModelIds(geminiApiDiagnostics, 'chat-or-image'),
    backends: {
      geminiApi: geminiApiDiagnostics,
    },
    compatibility: request ? getCompatibilitySnapshot(request) : compatibility.get(),
    llm: sanitizedLlmDiagnostics,
  };
}

function normalizeAllowedModels(values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0) return config.bootstrapApp.allowedModels;
  return values.map((value) => normalizeModelId(String(value)));
}

function listPublicEndpoints(): string[] {
  const endpoints = ['/', '/health', '/admin', '/auth/me', '/dashboard/summary'];
  if (isSurfaceEnabled('openai')) {
    endpoints.push('/v1/models', '/v1/provider/runtime', '/v1/provider/models', '/v1/provider/quota', '/v1/chat/completions', '/v1/responses', '/v1/images/generations');
  }
  if (isAnySurfaceEnabled(['gemrouter', 'deepseek'])) {
    endpoints.push('/models', '/chat/completions', '/images/generations');
  }
  if (isSurfaceEnabled('ollama')) {
    endpoints.push('/api/version', '/api/tags', '/api/chat', '/api/generate', '/api/show');
  }
  return endpoints;
}

async function handleModelsRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  surface: 'openai' | 'gemrouter',
): Promise<FastifyReply | Record<string, unknown>> {
  if (surface === 'openai') {
    if (!ensureOpenAiSurfaceEnabled('openai', reply)) return reply;
  } else if (!ensureAnySurfaceEnabled(['gemrouter', 'deepseek'], reply, 'gemrouter/deepseek')) {
    return reply;
  }
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;
  try {
    const runtime = getRuntimeSnapshot();
    const models = Array.isArray(runtime.models)
      ? runtime.models.map((model) => String(model).trim()).filter(Boolean)
      : config.modelIds;
    return {
      object: 'list',
      data: models
        .filter((modelId) => appStore.isModelAllowed(access.app, modelId))
        .map((modelId) => ({
          id: modelId,
          object: 'model',
          created: 0,
          owned_by: PROJECT_NAME,
        })),
    };
  } finally {
    access.release();
  }
}

function buildProviderRuntimeResponse(request: FastifyRequest, clientApp?: AuthenticatedClientApp | ApiAppRecord): Record<string, unknown> {
  const runtime = getRuntimeSnapshot(request, { includeSensitiveLlm: true });
  const provider = (runtime.provider as Record<string, unknown> | null) ?? {};
  const providerModels = Array.isArray(provider.models) ? provider.models as Record<string, unknown>[] : [];
  const filteredModels = clientApp
    ? providerModels.filter((model) => appStore.isModelAllowed(clientApp, String(model.id ?? '')))
    : providerModels;
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    ts: runtime.ts,
    backendOrder: runtime.backendOrder,
    fallbackEnabled: runtime.fallbackEnabled,
    routing: runtime.routing,
    provider: {
      ...provider,
      models: filteredModels,
    },
    backends: runtime.backends,
    compatibility: getCompatibilitySnapshot(request),
  };
}

async function handleChatCompletionsRequest(
  request: FastifyRequest<{ Body: ChatCompletionsRequest }>,
  reply: FastifyReply,
  surface: 'openai' | 'gemrouter',
): Promise<FastifyReply | Record<string, unknown>> {
  if (surface === 'openai') {
    if (!ensureOpenAiSurfaceEnabled('openai', reply)) return reply;
  } else if (!ensureAnySurfaceEnabled(['gemrouter', 'deepseek'], reply, 'gemrouter/deepseek')) {
    return reply;
  }
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;

  let parsed: ReturnType<typeof parseChatCompletionsRequest>;
  try {
    parsed = parseChatCompletionsRequest(request.body ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit.write({
      type: 'chat.completion.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      statusCode: 400,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: message },
    });
    return sendError(reply, 400, {
      message,
      type: 'invalid_request_error',
      code: 'invalid_request',
    });
  }

  try {
    if (!ensureModelAllowed(reply, access.app, parsed.model)) return reply;
    const sessionOptions = buildRequestLlmOptions({
      request,
      user: parsed.user,
      sessionNamespace: access.app.sessionNamespace,
      model: parsed.model,
      allowedModelIds: access.app.allowedModels,
      maxTokens: parsed.maxTokens,
      temperature: parsed.temperature,
      fingerprintFallback: createRequestFingerprint(parsed.messages),
      semanticSurface: surface,
    });
    sessionOptions.semanticProfile = buildSemanticProfile({
      surface,
      channel: 'chat',
      outputMode: parsed.outputMode,
      jsonSchema: parsed.jsonSchema,
      jsonPresentation: parsed.jsonPresentation,
      actionPolicy: parsed.actionPolicy,
    });

    if (!parsed.stream) {
      const response = await llm.chat(parsed.messages, sessionOptions);
      applyBackendHeaders(reply, response);
      const usage = estimateUsage(parsed.messages, response.content);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: response.content,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: response.provider,
      });
      audit.write({
        type: 'chat.completion',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 200,
        latencyMs: Date.now() - getStartedAt(request),
        details: buildAuditDetailsFromResponse(response),
      });
      return buildChatCompletionResponse({ model: parsed.model, text: response.content, usage });
    }

    reply.raw.writeHead(200, buildStreamResponseHeaders(request));

    const completionId = `chatcmpl_${request.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    const sendChunk = (payload: unknown): void => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    sendChunk({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: parsed.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      usage: null,
    });

    let emitted = '';
    let finalText = '';
    let finalProvider: string | undefined;
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalText = next.value.content;
          finalProvider = next.value.provider;
          break;
        }
        const latest = next.value.content;
        const delta = latest.startsWith(emitted) ? latest.slice(emitted.length) : latest;
        emitted = latest;
        if (!delta) continue;
        sendChunk({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: parsed.model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          usage: null,
        });
      }

      const usage = estimateUsage(parsed.messages, finalText);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: finalProvider,
      });
      sendChunk({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: parsed.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: null,
      });
      if (parsed.includeUsageChunk) {
        sendChunk({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: parsed.model,
          choices: [],
          usage,
        });
      }
      reply.raw.write('data: [DONE]\n\n');
      audit.write({
        type: 'chat.stream',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 200,
        latencyMs: Date.now() - getStartedAt(request),
        details: {
          provider: finalProvider ?? null,
        },
      });
      reply.raw.end();
      return reply;
    } catch (error) {
      const http = mapLlmErrorToHttp(error);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText || emitted,
        status: 'failed',
        statusCode: http.statusCode,
        error: http.message,
      });
      sendChunk(
        buildOpenAIError({
          message: http.message,
          type: http.type,
          code: http.code,
        }),
      );
      reply.raw.end();
      audit.write({
        type: 'chat.stream.error',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: http.statusCode,
        latencyMs: Date.now() - getStartedAt(request),
        details: { error: http.message, code: http.code },
      });
      return reply;
    }
  } catch (error) {
    const http = mapLlmErrorToHttp(error);
    applyErrorHeaders(reply, error);
    audit.write({
      type: 'chat.completion.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      model: parsed.model,
      statusCode: http.statusCode,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: http.message, code: http.code },
    });
    recordInteraction({
      request,
      route: request.url,
      appRecord: access.app,
      model: parsed.model,
      messages: parsed.messages,
      status: 'failed',
      statusCode: http.statusCode,
      error: http.message,
    });
    return sendError(reply, http.statusCode, {
      message: http.message,
      type: http.type,
      code: http.code,
    });
  } finally {
    access.release();
  }
}

async function handleResponsesRequest(
  request: FastifyRequest<{ Body: ResponsesRequest }>,
  reply: FastifyReply,
): Promise<FastifyReply | Record<string, unknown>> {
  if (!ensureOpenAiSurfaceEnabled('openai', reply)) return reply;
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;

  let parsed: ReturnType<typeof parseResponsesRequest>;
  try {
    parsed = parseResponsesRequest(request.body ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit.write({
      type: 'responses.create.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      statusCode: 400,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: message },
    });
    return sendError(reply, 400, {
      message,
      type: 'invalid_request_error',
      code: 'invalid_request',
    });
  }

  try {
    if (!ensureModelAllowed(reply, access.app, parsed.model)) return reply;
    const sessionOptions = buildRequestLlmOptions({
      request,
      user: parsed.user,
      sessionNamespace: access.app.sessionNamespace,
      model: parsed.model,
      allowedModelIds: access.app.allowedModels,
      maxTokens: parsed.maxTokens,
      temperature: parsed.temperature,
      fingerprintFallback: createRequestFingerprint(parsed.messages),
      semanticSurface: 'openai',
    });
    sessionOptions.semanticProfile = buildSemanticProfile({
      surface: 'openai',
      channel: 'responses',
      outputMode: parsed.outputMode,
      jsonSchema: parsed.jsonSchema,
      jsonPresentation: parsed.jsonPresentation,
      actionPolicy: parsed.actionPolicy,
    });

    if (!parsed.stream) {
      const response = await llm.chat(parsed.messages, sessionOptions);
      applyBackendHeaders(reply, response);
      const usage = estimateUsage(parsed.messages, response.content);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: response.content,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: response.provider,
      });
      audit.write({
        type: 'responses.create',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 200,
        latencyMs: Date.now() - getStartedAt(request),
        details: buildAuditDetailsFromResponse(response),
      });
      return buildResponsesApiResponse({ model: parsed.model, text: response.content, usage });
    }

    reply.raw.writeHead(200, buildStreamResponseHeaders(request));

    const responseId = `resp_${request.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    const messageId = `msg_${request.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const sendEvent = (payload: unknown): void => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    sendEvent({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        model: parsed.model,
        status: 'in_progress',
      },
    });
    sendEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: messageId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
      },
    });
    sendEvent({
      type: 'response.content_part.added',
      output_index: 0,
      item_id: messageId,
      content_index: 0,
      part: {
        type: 'output_text',
        text: '',
        annotations: [],
      },
    });

    let emitted = '';
    let finalText = '';
    let finalProvider: string | undefined;
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalText = next.value.content;
          finalProvider = next.value.provider;
          break;
        }
        const latest = next.value.content;
        const delta = latest.startsWith(emitted) ? latest.slice(emitted.length) : latest;
        emitted = latest;
        if (!delta) continue;
        sendEvent({
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: messageId,
          content_index: 0,
          delta,
        });
      }

      const usage = estimateUsage(parsed.messages, finalText);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: finalProvider,
      });
      sendEvent({
        type: 'response.output_text.done',
        output_index: 0,
        item_id: messageId,
        content_index: 0,
        text: finalText,
      });
      sendEvent({
        type: 'response.content_part.done',
        output_index: 0,
        item_id: messageId,
        content_index: 0,
        part: {
          type: 'output_text',
          text: finalText,
          annotations: [],
        },
      });
      sendEvent({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: messageId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: finalText,
              annotations: [],
            },
          ],
        },
      });
      sendEvent({
        type: 'response.completed',
        response: buildResponsesApiResponse({
          id: responseId,
          model: parsed.model,
          text: finalText,
          usage,
          createdAt,
        }),
      });
      audit.write({
        type: 'responses.stream',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 200,
        latencyMs: Date.now() - getStartedAt(request),
        details: {
          provider: finalProvider ?? null,
        },
      });
      reply.raw.end();
      return reply;
    } catch (error) {
      const http = mapLlmErrorToHttp(error);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText || emitted,
        status: 'failed',
        statusCode: http.statusCode,
        error: http.message,
      });
      sendEvent({
        type: 'error',
        error: buildOpenAIError({
          message: http.message,
          type: http.type,
          code: http.code,
        }).error,
      });
      reply.raw.end();
      audit.write({
        type: 'responses.stream.error',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: http.statusCode,
        latencyMs: Date.now() - getStartedAt(request),
        details: { error: http.message, code: http.code },
      });
      return reply;
    }
  } catch (error) {
    const http = mapLlmErrorToHttp(error);
    applyErrorHeaders(reply, error);
    audit.write({
      type: 'responses.create.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      model: parsed.model,
      statusCode: http.statusCode,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: http.message, code: http.code },
    });
    recordInteraction({
      request,
      route: request.url,
      appRecord: access.app,
      model: parsed.model,
      messages: parsed.messages,
      status: 'failed',
      statusCode: http.statusCode,
      error: http.message,
    });
    return sendError(reply, http.statusCode, {
      message: http.message,
      type: http.type,
      code: http.code,
    });
  } finally {
    access.release();
  }
}

async function handleImageGenerationsRequest(
  request: FastifyRequest<{ Body: ImageGenerationsRequest }>,
  reply: FastifyReply,
  surface: 'openai' | 'gemrouter',
): Promise<FastifyReply | Record<string, unknown>> {
  if (surface === 'openai') {
    if (!ensureOpenAiSurfaceEnabled('openai', reply)) return reply;
  } else if (!ensureAnySurfaceEnabled(['gemrouter', 'deepseek'], reply, 'gemrouter/deepseek')) {
    return reply;
  }
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;

  let parsed: ReturnType<typeof parseImageGenerationsRequest>;
  try {
    parsed = parseImageGenerationsRequest(request.body ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit.write({
      type: 'images.generate.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      statusCode: 400,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: message },
    });
    return sendError(reply, 400, {
      message,
      type: 'invalid_request_error',
      code: 'invalid_request',
    });
  }

  try {
    if (!ensureModelAllowed(reply, access.app, parsed.model)) return reply;
    if (!isGeminiImageGenerationModelId(parsed.model)) {
      return sendError(reply, 400, {
        message: `Model ${parsed.model} is not configured as an image generation model`,
        type: 'invalid_request_error',
        code: 'image_model_required',
        param: 'model',
      });
    }

    const messages: LLMMessage[] = [{ role: 'user', content: parsed.prompt }];
    const options = buildSessionOptions({
      model: parsed.model,
      allowedModelIds: access.app.allowedModels,
      sessionNamespace: access.app.sessionNamespace,
      sessionHint: parsed.user,
      fingerprintFallback: createRequestFingerprint(messages),
    });
    options.imageConfig = {
      responseModalities: parsed.responseFormat === 'url' ? ['IMAGE'] : ['IMAGE'],
    };

    const response = await llm.chat(messages, options);
    applyBackendHeaders(reply, response);
    const image = response.images?.[0];
    if (!image) {
      return sendError(reply, 502, {
        message: `Model ${parsed.model} did not return an image`,
        type: 'server_error',
        code: 'image_not_returned',
      });
    }

    const responseText = response.content || '[generated image]';
    recordInteraction({
      request,
      route: request.url,
      appRecord: access.app,
      model: parsed.model,
      messages,
      responseText,
      usage: estimateUsage(messages, responseText),
      status: 'succeeded',
      statusCode: 200,
      provider: response.provider,
    });
    audit.write({
      type: 'images.generate',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      model: parsed.model,
      statusCode: 200,
      latencyMs: Date.now() - getStartedAt(request),
      details: buildAuditDetailsFromResponse(response),
    });
    return buildImageGenerationResponse({
      mimeType: image.mimeType,
      data: image.data,
      responseFormat: parsed.responseFormat,
      revisedPrompt: response.content || undefined,
    });
  } catch (error) {
    const http = mapLlmErrorToHttp(error);
    applyErrorHeaders(reply, error);
    recordInteraction({
      request,
      route: request.url,
      appRecord: access.app,
      model: parsed.model,
      messages: [{ role: 'user', content: parsed.prompt }],
      status: 'failed',
      statusCode: http.statusCode,
      error: http.message,
    });
    audit.write({
      type: 'images.generate.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      model: parsed.model,
      statusCode: http.statusCode,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: http.message, code: http.code },
    });
    return sendError(reply, http.statusCode, {
      message: http.message,
      type: http.type,
      code: http.code,
    });
  } finally {
    access.release();
  }
}

async function handleOllamaChatRequest(
  request: FastifyRequest<{ Body: OllamaChatRequest }>,
  reply: FastifyReply,
): Promise<FastifyReply | Record<string, unknown>> {
  if (!ensureOllamaSurfaceEnabled(reply)) return reply;
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;

  let parsed: ReturnType<typeof parseOllamaChatRequest>;
  try {
    parsed = parseOllamaChatRequest(request.body ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit.write({
      type: 'ollama.chat.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      statusCode: 400,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: message },
    });
    return sendError(reply, 400, {
      message,
      type: 'invalid_request_error',
      code: 'invalid_request',
    });
  }

  try {
    if (!ensureModelAllowed(reply, access.app, parsed.model)) return reply;
    const sessionOptions = buildRequestLlmOptions({
      request,
      sessionNamespace: access.app.sessionNamespace,
      model: parsed.model,
      allowedModelIds: access.app.allowedModels,
      maxTokens: parsed.maxTokens,
      temperature: parsed.temperature,
      fingerprintFallback: createRequestFingerprint(parsed.messages),
      semanticSurface: 'ollama',
    });
    sessionOptions.semanticProfile = buildSemanticProfile({
      surface: 'ollama',
      channel: 'chat',
      outputMode: parsed.outputMode,
      jsonSchema: parsed.jsonSchema,
    });
    if (parsed.stateful) sessionOptions.resetSession = false;

    if (!parsed.stream) {
      const response = await llm.chat(parsed.messages, sessionOptions);
      applyBackendHeaders(reply, response);
      const usage = estimateUsage(parsed.messages, response.content);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: response.content,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: response.provider,
      });
      audit.write({
        type: 'ollama.chat',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 200,
        latencyMs: Date.now() - getStartedAt(request),
        details: buildAuditDetailsFromResponse(response),
      });
      return buildOllamaChatResponse({ model: parsed.model, text: response.content, usage });
    }

    reply.raw.writeHead(200, buildNdjsonResponseHeaders(request));

    const sendChunk = (payload: unknown): void => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`${JSON.stringify(payload)}\n`);
      }
    };

    let emitted = '';
    let finalText = '';
    let finalProvider: string | undefined;
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalText = next.value.content;
          finalProvider = next.value.provider;
          break;
        }
        const latest = next.value.content;
        const delta = latest.startsWith(emitted) ? latest.slice(emitted.length) : latest;
        emitted = latest;
        if (!delta) continue;
        sendChunk(buildOllamaChatChunk({ model: parsed.model, text: delta }));
      }

      const usage = estimateUsage(parsed.messages, finalText);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: finalProvider,
      });
      sendChunk(buildOllamaChatDone({ model: parsed.model, usage }));
      audit.write({
        type: 'ollama.chat.stream',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 200,
        latencyMs: Date.now() - getStartedAt(request),
        details: {
          provider: finalProvider ?? null,
        },
      });
      reply.raw.end();
      return reply;
    } catch (error) {
      const http = mapLlmErrorToHttp(error);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText || emitted,
        status: 'failed',
        statusCode: http.statusCode,
        error: http.message,
      });
      sendChunk(buildOllamaError(http.message));
      reply.raw.end();
      audit.write({
        type: 'ollama.chat.stream.error',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: http.statusCode,
        latencyMs: Date.now() - getStartedAt(request),
        details: { error: http.message, code: http.code },
      });
      return reply;
    }
  } catch (error) {
    const http = mapLlmErrorToHttp(error);
    applyErrorHeaders(reply, error);
    audit.write({
      type: 'ollama.chat.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      model: parsed.model,
      statusCode: http.statusCode,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: http.message, code: http.code },
    });
    recordInteraction({
      request,
      route: request.url,
      appRecord: access.app,
      model: parsed.model,
      messages: parsed.messages,
      status: 'failed',
      statusCode: http.statusCode,
      error: http.message,
    });
    return sendError(reply, http.statusCode, {
      message: http.message,
      type: http.type,
      code: http.code,
    });
  } finally {
    access.release();
  }
}

async function handleOllamaGenerateRequest(
  request: FastifyRequest<{ Body: OllamaGenerateRequest }>,
  reply: FastifyReply,
): Promise<FastifyReply | Record<string, unknown>> {
  if (!ensureOllamaSurfaceEnabled(reply)) return reply;
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;

  let parsed: ReturnType<typeof parseOllamaGenerateRequest>;
  try {
    parsed = parseOllamaGenerateRequest(request.body ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit.write({
      type: 'ollama.generate.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      statusCode: 400,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: message },
    });
    return sendError(reply, 400, {
      message,
      type: 'invalid_request_error',
      code: 'invalid_request',
    });
  }

  try {
    if (!ensureModelAllowed(reply, access.app, parsed.model)) return reply;
    const sessionOptions = buildRequestLlmOptions({
      request,
      sessionNamespace: access.app.sessionNamespace,
      model: parsed.model,
      allowedModelIds: access.app.allowedModels,
      maxTokens: parsed.maxTokens,
      temperature: parsed.temperature,
      fingerprintFallback: createRequestFingerprint(parsed.messages),
      semanticSurface: 'ollama',
    });
    sessionOptions.semanticProfile = buildSemanticProfile({
      surface: 'ollama',
      channel: 'generate',
      outputMode: parsed.outputMode,
      jsonSchema: parsed.jsonSchema,
    });
    if (parsed.stateful) sessionOptions.resetSession = false;

    if (!parsed.stream) {
      const response = await llm.chat(parsed.messages, sessionOptions);
      applyBackendHeaders(reply, response);
      const usage = estimateUsage(parsed.messages, response.content);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: response.content,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: response.provider,
      });
      audit.write({
        type: 'ollama.generate',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 200,
        latencyMs: Date.now() - getStartedAt(request),
        details: buildAuditDetailsFromResponse(response),
      });
      return buildOllamaGenerateResponse({ model: parsed.model, text: response.content, usage });
    }

    reply.raw.writeHead(200, buildNdjsonResponseHeaders(request));

    const sendChunk = (payload: unknown): void => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`${JSON.stringify(payload)}\n`);
      }
    };

    let emitted = '';
    let finalText = '';
    let finalProvider: string | undefined;
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalText = next.value.content;
          finalProvider = next.value.provider;
          break;
        }
        const latest = next.value.content;
        const delta = latest.startsWith(emitted) ? latest.slice(emitted.length) : latest;
        emitted = latest;
        if (!delta) continue;
        sendChunk(buildOllamaGenerateChunk({ model: parsed.model, text: delta }));
      }

      const usage = estimateUsage(parsed.messages, finalText);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: finalProvider,
      });
      sendChunk(buildOllamaGenerateDone({ model: parsed.model, usage }));
      audit.write({
        type: 'ollama.generate.stream',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 200,
        latencyMs: Date.now() - getStartedAt(request),
        details: {
          provider: finalProvider ?? null,
        },
      });
      reply.raw.end();
      return reply;
    } catch (error) {
      const http = mapLlmErrorToHttp(error);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText || emitted,
        status: 'failed',
        statusCode: http.statusCode,
        error: http.message,
      });
      sendChunk(buildOllamaError(http.message));
      reply.raw.end();
      audit.write({
        type: 'ollama.generate.stream.error',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: http.statusCode,
        latencyMs: Date.now() - getStartedAt(request),
        details: { error: http.message, code: http.code },
      });
      return reply;
    }
  } catch (error) {
    const http = mapLlmErrorToHttp(error);
    applyErrorHeaders(reply, error);
    audit.write({
      type: 'ollama.generate.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      model: parsed.model,
      statusCode: http.statusCode,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: http.message, code: http.code },
    });
    recordInteraction({
      request,
      route: request.url,
      appRecord: access.app,
      model: parsed.model,
      messages: parsed.messages,
      status: 'failed',
      statusCode: http.statusCode,
      error: http.message,
    });
    return sendError(reply, http.statusCode, {
      message: http.message,
      type: http.type,
      code: http.code,
    });
  } finally {
    access.release();
  }
}

app.addHook('onRequest', async (request, reply) => {
  setStartedAt(request);
  setCorsHeaders(request, reply);
  reply.header('x-request-id', request.id);
  if (request.method === 'OPTIONS') {
    return reply.code(204).send();
  }
});

app.addHook('onSend', async (request, reply, payload) => {
  const elapsed = String(Date.now() - getStartedAt(request));
  reply.header('openai-version', '2020-10-01');
  reply.header('openai-processing-ms', elapsed);
  return payload;
});

app.get('/', async (request, reply) => {
  if (config.dashboardEnabled && wantsHtmlShell(request)) {
    return reply
      .type('text/html; charset=utf-8')
      .send(
        renderAppShell({
          projectName: PROJECT_NAME,
          modelIds: config.modelIds,
          publicBaseUrl: inferPublicBaseUrl(request),
        }),
      );
  }
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    dashboardEnabled: config.dashboardEnabled,
    endpoints: listPublicEndpoints(),
  };
});

app.get('/admin', async (request, reply) =>
  reply
    .type('text/html; charset=utf-8')
    .send(
      renderAppShell({
        projectName: PROJECT_NAME,
        modelIds: config.modelIds,
        publicBaseUrl: inferPublicBaseUrl(request),
      }),
    ),
);

app.get('/health', async (request) => getRuntimeSnapshot(request));

async function handleDashboardLogin(request: FastifyRequest<{ Body: { token?: string; username?: string; password?: string } }>, reply: FastifyReply) {
  const token = String(request.body?.token ?? '').trim();
  const username = String(request.body?.username ?? '').trim();
  const password = String(request.body?.password ?? '').trim();

  const adminUser = token === config.adminToken
    ? { username: 'token-admin' }
    : findDashboardAdminUser(username, password);

  if (!adminUser) {
    return sendError(reply, 401, {
      message: 'Invalid dashboard credentials',
      type: 'authentication_error',
      code: 'invalid_dashboard_credentials',
    });
  }

  const sessionId = adminSessions.create({ username: adminUser.username });
  setAdminCookie(reply, sessionId);
  audit.write({
    type: 'admin.login',
    requestId: request.id,
    route: request.url,
    statusCode: 200,
    latencyMs: Date.now() - getStartedAt(request),
  });
  return {
    ok: true,
    project: PROJECT_NAME,
    role: 'admin',
    username: adminUser.username,
  };
}

async function handleDashboardLogout(request: FastifyRequest, reply: FastifyReply) {
  adminSessions.revoke(getAdminSessionId(request));
  clearAdminCookie(reply);
  return {
    ok: true,
  };
}

app.get('/dashboard/summary', async () => buildGuestSummary());

app.post<{ Body: { token?: string; username?: string; password?: string } }>('/auth/login', async (request, reply) =>
  handleDashboardLogin(request, reply),
);
app.post('/auth/logout', async (request, reply) => handleDashboardLogout(request, reply));
app.get('/auth/me', async (request) => {
  const session = getAdminSession(request);
  if (!session) {
    return {
      ok: true,
      authenticated: false,
      role: 'guest',
    };
  }
  return {
    ok: true,
    authenticated: true,
    role: 'admin',
    username: session.username ?? 'admin',
    project: PROJECT_NAME,
    service: SERVICE_NAME,
  };
});

app.post<{ Body: { token?: string; username?: string; password?: string } }>('/admin/login', async (request, reply) =>
  handleDashboardLogin(request, reply),
);
app.post('/admin/logout', async (request, reply) => handleDashboardLogout(request, reply));

app.get('/admin/me', async (request, reply) => {
  const session = getAdminSession(request);
  if (!hasAdminAccess(request)) {
    return sendError(reply, 401, {
      message: 'Admin session required',
      type: 'authentication_error',
      code: 'admin_session_required',
    });
  }
  return {
    ok: true,
    role: 'admin',
    username: session?.username ?? 'admin',
    project: PROJECT_NAME,
    service: SERVICE_NAME,
  };
});

app.get('/admin/summary', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  let runtime = getRuntimeSnapshot(request, { includeSensitiveLlm: true });
  const initialBackends = (runtime.backends as Record<string, unknown> | null) ?? null;
  const initialGeminiApi = (initialBackends?.geminiApi as Record<string, unknown> | null) ?? null;
  const lastRefreshAt = typeof initialGeminiApi?.modelDiscovery === 'object'
    ? Date.parse(String((initialGeminiApi.modelDiscovery as Record<string, unknown>).lastRefreshAt ?? ''))
    : Number.NaN;
  const shouldRefreshModels = !Number.isFinite(lastRefreshAt) || (Date.now() - lastRefreshAt) >= config.geminiApi.discoveryRefreshMs;
  if (shouldRefreshModels) {
    const client = geminiApiLlm as typeof geminiApiLlm & {
      listModels?: () => Promise<Record<string, unknown>>;
    };
    if (typeof client.listModels === 'function') {
      await client.listModels();
      runtime = getRuntimeSnapshot(request, { includeSensitiveLlm: true });
    }
  }
  const llmSnapshot = (runtime.llm as Record<string, unknown> | null) ?? null;
  const routingSnapshot = (runtime.routing as Record<string, unknown> | null) ?? null;
  const backendSnapshot = (runtime.backends as Record<string, unknown> | null) ?? null;
  const providerSnapshot = (runtime.provider as Record<string, unknown> | null) ?? null;
  const geminiApiSnapshot = (backendSnapshot?.geminiApi as Record<string, unknown> | null) ?? {};
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    compatibility: getCompatibilitySnapshot(request),
    runtime: {
      backendOnly: true,
      apps: appStore.list().length,
    },
    routing: routingSnapshot,
    provider: providerSnapshot,
    backends: backendSnapshot,
    llm: llmSnapshot,
    models: buildCompatibleSurfaceModelIds(geminiApiSnapshot, 'chat-or-image'),
    modelCatalog: buildAdminModelCatalog(geminiApiSnapshot),
    apps: appStore.list().map(sanitizeAdminApp),
    stats: interactions.summary(60),
  };
});

app.post('/admin/provider/gemini-api/discover-models', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const client = geminiApiLlm as typeof geminiApiLlm & {
    discoverModels?: () => Promise<Record<string, unknown>>;
  };
  if (typeof client.discoverModels !== 'function') {
    return sendError(reply, 503, {
      message: 'Gemini API model discovery is not available',
      type: 'server_error',
      code: 'gemini_api_discovery_unavailable',
    });
  }
  return client.discoverModels();
});

app.post('/admin/provider/gemini-api/refresh-quota', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const runtime = getRuntimeSnapshot(request, { includeSensitiveLlm: true });
  return {
    ok: true,
    source: 'local-ledger',
    authoritative: false,
    geminiApi: (runtime.backends as Record<string, unknown>).geminiApi ?? null,
  };
});

app.post('/admin/provider/gemini-api/clear-cooldown', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const client = geminiApiLlm as typeof geminiApiLlm & {
    clearCooldown?: () => Record<string, unknown>;
  };
  if (typeof client.clearCooldown !== 'function') {
    return sendError(reply, 503, {
      message: 'Gemini API cooldown controls are not available',
      type: 'server_error',
      code: 'gemini_api_cooldown_unavailable',
    });
  }
  return client.clearCooldown();
});

app.post<{
  Body: {
    defaultSurface?: ApiSurface;
    enabledSurfaces?: ApiSurface[];
  };
}>('/admin/compatibility', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const updated = compatibility.update({
    defaultSurface: request.body?.defaultSurface,
    enabledSurfaces: request.body?.enabledSurfaces,
  });
  audit.write({
    type: 'admin.compatibility.updated',
    requestId: request.id,
    route: request.url,
    statusCode: 200,
    latencyMs: Date.now() - getStartedAt(request),
    details: { ...updated },
  });
  return {
    ok: true,
    compatibility: getCompatibilitySnapshot(request),
  };
});

app.get('/admin/interactions', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  return {
    ok: true,
    ...interactions.summary(100),
  };
});

app.post<{ Params: { id: string }; Body: { feedback?: string; notes?: string } }>(
  '/admin/interactions/:id/feedback',
  async (request, reply) => {
    if (!ensureAdmin(request, reply)) return reply;
    const feedback = String(request.body?.feedback ?? '').trim().toLowerCase();
    if (feedback !== 'good' && feedback !== 'bad') {
      return sendError(reply, 400, {
        message: 'feedback must be "good" or "bad"',
        type: 'invalid_request_error',
        code: 'invalid_feedback',
      });
    }
    const updated = interactions.setFeedback(request.params.id, feedback, request.body?.notes);
    if (!updated) {
      return sendError(reply, 404, {
        message: 'Interaction not found',
        type: 'invalid_request_error',
        code: 'interaction_not_found',
      });
    }
    return {
      ok: true,
      interaction: updated,
    };
  },
);

app.delete<{ Params: { id: string } }>('/admin/interactions/:id/feedback', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const updated = interactions.clearFeedback(request.params.id);
  if (!updated) {
    return sendError(reply, 404, {
      message: 'Interaction not found',
      type: 'invalid_request_error',
      code: 'interaction_not_found',
    });
  }
  return {
    ok: true,
    interaction: updated,
  };
});

app.post<{
  Body: {
    appId?: string;
    prompt?: string;
    systemPrompt?: string;
    model?: string;
    sessionHint?: string;
    stateful?: boolean;
    maxTokens?: number;
    temperature?: number;
  };
}>('/admin/test-chat', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const body = request.body ?? {};
  const selectedApp = (body.appId && appStore.findById(String(body.appId))) || bootstrapApp;
  if (!selectedApp || selectedApp.revokedAt) {
    return sendError(reply, 404, {
      message: 'App not found',
      type: 'invalid_request_error',
      code: 'app_not_found',
    });
  }

  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) {
    return sendError(reply, 400, {
      message: 'prompt is required',
      type: 'invalid_request_error',
      code: 'missing_prompt',
    });
  }

  const model = normalizeModelId(body.model);
  if (!ensureModelAllowed(reply, selectedApp, model)) return reply;

  const messages: LLMMessage[] = [];
  const systemPrompt = String(body.systemPrompt ?? '').trim();
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  try {
    const options = buildSessionOptions({
      model,
      allowedModelIds: selectedApp.allowedModels,
      maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      sessionNamespace: selectedApp.sessionNamespace,
      sessionHint: typeof body.sessionHint === 'string' ? body.sessionHint : undefined,
      stateful: body.stateful === true,
      fingerprintFallback: createRequestFingerprint(messages),
    });
    if (isGeminiImageGenerationModelId(model)) {
      options.imageConfig = {
        responseModalities: ['TEXT', 'IMAGE'],
      };
    }
    const response = await llm.chat(messages, options);
    applyBackendHeaders(reply, response);
    const usage = estimateUsage(messages, response.content);
    recordInteraction({
      request,
      route: request.url,
      appRecord: selectedApp,
      model,
      messages,
      responseText: response.content,
      usage,
      status: 'succeeded',
      statusCode: 200,
      provider: response.provider,
    });
    return {
      ok: true,
      app: sanitizeAdminApp(selectedApp),
      model,
      text: response.content,
      images: response.images ?? [],
      usage,
      provider: response.provider,
      backend: response.backend ?? null,
      fallbackReason: response.fallbackReason ?? null,
      latencyMs: Date.now() - getStartedAt(request),
    };
  } catch (error) {
    const http = mapLlmErrorToHttp(error);
    applyErrorHeaders(reply, error);
    recordInteraction({
      request,
      route: request.url,
      appRecord: selectedApp,
      model,
      messages,
      status: 'failed',
      statusCode: http.statusCode,
      error: http.message,
    });
    audit.write({
      type: 'admin.test-chat.error',
      requestId: request.id,
      appId: selectedApp.id,
      route: request.url,
      model,
      statusCode: http.statusCode,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: http.message, code: http.code },
    });
    return sendError(reply, http.statusCode, {
      message: http.message,
      type: http.type,
      code: http.code === 'llm_request_failed' ? 'test_chat_failed' : http.code,
    });
  }
});

app.get('/v1/models', async (request, reply) => handleModelsRequest(request, reply, 'openai'));
app.get('/models', async (request, reply) => handleModelsRequest(request, reply, 'gemrouter'));
app.get('/v1/provider/runtime', async (request, reply) => {
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;
  try {
    return buildProviderRuntimeResponse(request, access.app);
  } finally {
    access.release();
  }
});
app.get('/v1/provider/models', async (request, reply) => {
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;
  try {
    const runtime = buildProviderRuntimeResponse(request, access.app);
    return {
      object: 'list',
      data: ((runtime.provider as Record<string, unknown>).models as unknown[]) ?? [],
    };
  } finally {
    access.release();
  }
});
app.get('/v1/provider/quota', async (request, reply) => {
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;
  try {
    const runtime = buildProviderRuntimeResponse(request, access.app);
    const provider = (runtime.provider as Record<string, unknown> | null) ?? {};
    const backends = (runtime.backends as Record<string, unknown> | null) ?? {};
    const geminiApi = (backends.geminiApi as Record<string, unknown> | null) ?? {};
    return {
      ok: true,
      geminiApi: {
        enabled: geminiApi.enabled ?? false,
        source: 'local-ledger',
        authoritative: false,
        apiKeys: geminiApi.keys ?? [],
        quotaGroups: geminiApi.quotaGroups ?? [],
        models: geminiApi.models ?? [],
        updatedAt: geminiApi.quotaUpdatedAt ?? null,
        modelDiscovery: geminiApi.modelDiscovery ?? null,
      },
      model: provider.configuredModel ?? null,
      lastResolvedModel: provider.lastResolvedModel ?? null,
      availableCredits: provider.availableCredits ?? [],
      quotaBuckets: provider.quotaBuckets ?? [],
      quotaAuthoritative: provider.quotaAuthoritative ?? false,
      quotaUpdatedAt: provider.quotaUpdatedAt ?? null,
      quotaLastError: provider.quotaLastError ?? null,
      lastMappedErrorCode: provider.lastMappedErrorCode ?? null,
      lastUpstreamError: provider.lastUpstreamError ?? null,
    };
  } finally {
    access.release();
  }
});

app.post<{ Body: ChatCompletionsRequest }>('/v1/chat/completions', async (request, reply) =>
  handleChatCompletionsRequest(request, reply, 'openai'),
);
app.post<{ Body: ChatCompletionsRequest }>('/chat/completions', async (request, reply) =>
  handleChatCompletionsRequest(request, reply, 'gemrouter'),
);
app.post<{ Body: ResponsesRequest }>('/v1/responses', async (request, reply) => handleResponsesRequest(request, reply));
app.post<{ Body: ImageGenerationsRequest }>('/v1/images/generations', async (request, reply) =>
  handleImageGenerationsRequest(request, reply, 'openai'),
);
app.post<{ Body: ImageGenerationsRequest }>('/images/generations', async (request, reply) =>
  handleImageGenerationsRequest(request, reply, 'gemrouter'),
);

app.get('/api/version', async (request, reply) => {
  if (!ensureOllamaSurfaceEnabled(reply)) return reply;
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;
  try {
    return {
      version: '0.1.0-gemrouter',
    };
  } finally {
    access.release();
  }
});

app.get('/api/tags', async (request, reply) => {
  if (!ensureOllamaSurfaceEnabled(reply)) return reply;
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;
  try {
    const runtime = getRuntimeSnapshot();
    const backends = (runtime.backends as Record<string, unknown> | null) ?? {};
    const geminiApi = (backends.geminiApi as Record<string, unknown> | null) ?? {};
    const allowedModels = buildCompatibleSurfaceModelIds(geminiApi, 'chat').filter((modelId) =>
      appStore.isModelAllowed(access.app, modelId),
    );
    return buildOllamaTagsResponse(allowedModels);
  } finally {
    access.release();
  }
});

app.post<{ Body: { name?: string; model?: string } }>('/api/show', async (request, reply) => {
  if (!ensureOllamaSurfaceEnabled(reply)) return reply;
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;
  try {
    const requestedModel = normalizeModelId(String(request.body?.name ?? request.body?.model ?? '').trim() || undefined);
    if (!ensureModelAllowed(reply, access.app, requestedModel)) return reply;
    return buildOllamaShowResponse(requestedModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendError(reply, 400, {
      message,
      type: 'invalid_request_error',
      code: 'invalid_request',
    });
  } finally {
    access.release();
  }
});

app.post<{ Body: OllamaChatRequest }>('/api/chat', async (request, reply) => handleOllamaChatRequest(request, reply));
app.post<{ Body: OllamaGenerateRequest }>('/api/generate', async (request, reply) =>
  handleOllamaGenerateRequest(request, reply),
);

app.get('/admin/apps', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  return {
    object: 'list',
    data: appStore.list().map(sanitizeAdminApp),
  };
});

app.post<{
  Body: {
    name?: string;
    allowedOrigins?: string[];
    allowedModels?: string[];
    sessionNamespace?: string;
    rateLimitPerMinute?: number;
    maxConcurrency?: number;
  };
}>('/admin/apps', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const body = request.body ?? {};
  const created = appStore.create({
    name: String(body.name ?? '').trim() || 'local-app',
    allowedOrigins: Array.isArray(body.allowedOrigins) ? body.allowedOrigins : config.bootstrapApp.allowedOrigins,
    allowedModels: normalizeAllowedModels(body.allowedModels),
    sessionNamespace: String(body.sessionNamespace ?? body.name ?? 'local-app'),
    rateLimitPerMinute:
      typeof body.rateLimitPerMinute === 'number' ? body.rateLimitPerMinute : config.bootstrapApp.rateLimitPerMinute,
    maxConcurrency: typeof body.maxConcurrency === 'number' ? body.maxConcurrency : config.bootstrapApp.maxConcurrency,
  });
  audit.write({
    type: 'admin.app.created',
    requestId: request.id,
    appId: created.record.id,
    route: request.url,
    statusCode: 201,
    latencyMs: Date.now() - getStartedAt(request),
  });
  return reply.code(201).send({
    ok: true,
    app: sanitizeAdminApp(created.record),
    apiKey: created.rawKey,
  });
});

app.put<{
  Params: { id: string };
  Body: {
    name?: string;
    allowedOrigins?: string[];
    allowedModels?: string[];
    sessionNamespace?: string;
    rateLimitPerMinute?: number;
    maxConcurrency?: number;
  };
}>('/admin/apps/:id', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const body = request.body ?? {};
  const updated = appStore.update(request.params.id, {
    name: typeof body.name === 'string' ? body.name : undefined,
    allowedOrigins: Array.isArray(body.allowedOrigins) ? body.allowedOrigins : undefined,
    allowedModels: Array.isArray(body.allowedModels) ? normalizeAllowedModels(body.allowedModels) : undefined,
    sessionNamespace: typeof body.sessionNamespace === 'string' ? body.sessionNamespace : undefined,
    rateLimitPerMinute: typeof body.rateLimitPerMinute === 'number' ? body.rateLimitPerMinute : undefined,
    maxConcurrency: typeof body.maxConcurrency === 'number' ? body.maxConcurrency : undefined,
  });
  if (!updated) {
    return sendError(reply, 404, {
      message: 'App not found',
      type: 'invalid_request_error',
      code: 'app_not_found',
    });
  }
  audit.write({
    type: 'admin.app.updated',
    requestId: request.id,
    appId: updated.id,
    route: request.url,
    statusCode: 200,
    latencyMs: Date.now() - getStartedAt(request),
  });
  return {
    ok: true,
    app: sanitizeAdminApp(updated),
  };
});

app.post<{ Params: { id: string } }>('/admin/apps/:id/rotate', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const rotated = appStore.rotate(request.params.id);
  if (!rotated) {
    return sendError(reply, 404, {
      message: 'App not found',
      type: 'invalid_request_error',
      code: 'app_not_found',
    });
  }
  audit.write({
    type: 'admin.app.rotated',
    requestId: request.id,
    appId: rotated.record.id,
    route: request.url,
    statusCode: 200,
    latencyMs: Date.now() - getStartedAt(request),
  });
  return {
    ok: true,
    app: sanitizeAdminApp(rotated.record),
    apiKey: rotated.rawKey,
  };
});

app.post<{ Params: { id: string } }>('/admin/apps/:id/revoke', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const revoked = appStore.revoke(request.params.id);
  if (!revoked) {
    return sendError(reply, 404, {
      message: 'App not found',
      type: 'invalid_request_error',
      code: 'app_not_found',
    });
  }
  audit.write({
    type: 'admin.app.revoked',
    requestId: request.id,
    appId: revoked.id,
    route: request.url,
    statusCode: 200,
    latencyMs: Date.now() - getStartedAt(request),
  });
  return {
    ok: true,
    app: sanitizeAdminApp(revoked),
  };
});

app.get('/admin/runtime', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const runtime = getRuntimeSnapshot(request);
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    backendOrder: runtime.backendOrder,
    backendOnly: true,
    apps: appStore.list().length,
    auditLogPath: config.auditLogPath,
    publicBaseUrl: inferPublicBaseUrl(request),
    compatibility: getCompatibilitySnapshot(request),
  };
});

const shutdown = async (): Promise<void> => {
  await app.close().catch(() => undefined);
};

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

app
  .listen({ host: config.host, port: config.port })
  .then((address) => {
    console.log(`${PROJECT_NAME} listening on ${address}`);
    console.log(`bootstrap app: ${bootstrapApp.id} (${bootstrapApp.name})`);
  })
  .catch((error) => {
    console.error(`failed to start ${PROJECT_NAME}:`, error);
    process.exit(1);
  });
