import 'dotenv/config';

import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

import { loadConfig } from './config.js';
import { buildCompatibilityRoutes, type ApiSurface } from './lib/compatibility.js';
import {
  buildDiscoveredModelCatalog,
  describePublicModel,
  inferModelCapabilities,
  isGeminiImageGenerationModelId,
  isLeakRouterCompatibleModelCapabilities,
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
import { nextPacificDayStartMs } from './llm/providers/gemini-api/quotaLedger.js';
import { createOllamaRouterClient } from './llm/providers/ollama/client.js';
import { createDeepSeekApiClient } from './llm/providers/deepseek-api/client.js';
import { createProxiedFetch, redactOutboundProxyConfig, OutboundProxyError } from './net/outboundProxy.js';
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

const PROJECT_NAME = 'LeakRouter';
const SERVICE_NAME = 'leak-router';
const ADMIN_COOKIE_NAME = 'leakrouter_admin_session';
const execFileAsync = promisify(execFile);

const config = loadConfig();
const outboundProxy = createProxiedFetch(config.outboundProxy);
const geminiApiLlm = createGeminiApiClient(config.geminiApi, { fetch: outboundProxy.fetch });
const ollamaLlm = createOllamaRouterClient(config.ollama, { fetch: outboundProxy.fetch });
const deepseekApiLlm = createDeepSeekApiClient(config.deepseekApi, { fetch: outboundProxy.fetch });
const llm = createLlmRouter({
  ...config.llmRouting,
  strictModelIds: config.geminiApi.strictModelIds,
}, {
  ollama: ollamaLlm,
  deepseekApi: deepseekApiLlm,
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

interface BenchmarkJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  expectedCount: number | null;
  results: Array<Record<string, unknown>>;
  error: string | null;
  sources: Array<Record<string, string>>;
}

const benchmarkJobs = new Map<string, BenchmarkJob>();

interface GeminiProjectQuotaState {
  updatedAt: string | null;
  source: 'google-service-usage+cloud-monitoring+local-ledger' | 'google-service-usage+local-ledger' | 'local-ledger';
  /** Service Usage can report effective configured limits. */
  limitsAuthoritative: boolean;
  /** AI Studio does not expose exact current RPM/TPM/RPD remaining through these APIs. */
  remainingAuthoritative: false;
  /** Monitoring is delayed telemetry, never an admission authority for AI Studio free tier. */
  authoritative: boolean;
  monitoringAuthoritative: boolean;
  projectQuotas: Array<Record<string, unknown>>;
  lastError: string | null;
}

const GEMINI_PROJECT_QUOTA_REFRESH_MS = 30_000;
let geminiProjectQuotaState: GeminiProjectQuotaState = {
  updatedAt: null,
  source: 'local-ledger',
  limitsAuthoritative: false,
  remainingAuthoritative: false,
  authoritative: false,
  monitoringAuthoritative: false,
  projectQuotas: [],
  lastError: null,
};
let geminiProjectQuotaRefresh: Promise<GeminiProjectQuotaState> | null = null;

const bootstrapApp = appStore.ensureBootstrapApp({
  name: config.bootstrapApp.name,
  rawKey: config.bootstrapApp.apiKey,
  allowedOrigins: config.bootstrapApp.allowedOrigins,
  allowedModels: config.bootstrapApp.allowedModels,
  sessionNamespace: config.bootstrapApp.sessionNamespace,
  rateLimitPerMinute: config.bootstrapApp.rateLimitPerMinute,
  maxConcurrency: config.bootstrapApp.maxConcurrency,
});
appStore.restrictAllowedModels(config.freeTierPolicy.textModelIds);

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

function concurrencyPriority(request: FastifyRequest, app: AuthenticatedClientApp): number {
  // Only the bootstrap credential belongs to GoonersBot. Other API clients cannot
  // self-upgrade their queue position by supplying this header.
  if (app.id !== bootstrapApp.id) return 0;
  const plan = String(request.headers['x-leakrouter-group-plan'] ?? '').trim().toLowerCase();
  if (plan === 'pro') return 2;
  if (plan === 'plus') return 1;
  return 0;
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
      leakrouter: {
        enabled: state.enabledSurfaces.includes('leakrouter'),
        routes: routes.leakrouter,
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
      'x-leakrouter-session',
      'x-leakrouter-user',
      'x-leakrouter-stateful',
      'x-leakrouter-backend',
      'x-leakrouter-session',
      'x-leakrouter-user',
      'x-leakrouter-stateful',
      'x-leakrouter-backend',
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

  const release = await appStore.acquireConcurrency(
    clientApp,
    concurrencyPriority(request, clientApp),
    config.bootstrapApp.concurrencyWaitMs,
  );

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

function isConfiguredTextModel(modelId: string): boolean {
  return config.freeTierPolicy.textModelIds.includes(normalizeModelId(modelId));
}

function textModelsAllowedForApp(clientApp: AuthenticatedClientApp | ApiAppRecord): string[] {
  const appAllowed = new Set(clientApp.allowedModels.map((model) => normalizeModelId(model)));
  return config.freeTierPolicy.textModelIds.filter((modelId) => appAllowed.has(modelId));
}

function resolveTextModelForApp(
  clientApp: AuthenticatedClientApp | ApiAppRecord,
  requestedModel: string,
): { model: string; requestedModel: string; policyFallbackReason?: string; allowedModelIds: string[] } | null {
  const requested = normalizeModelId(requestedModel);
  const allowedModelIds = textModelsAllowedForApp(clientApp);
  if (allowedModelIds.length === 0) return null;
  if (appStore.isModelAllowed(clientApp, requested) && isConfiguredTextModel(requested)) {
    return { model: requested, requestedModel: requested, allowedModelIds };
  }
  const fallback = config.freeTierPolicy.fallbackModelIds.find((modelId) => allowedModelIds.includes(modelId)) ?? allowedModelIds[0];
  return {
    model: fallback,
    requestedModel: requested,
    allowedModelIds,
    policyFallbackReason: isConfiguredTextModel(requested) ? 'app_model_not_allowed' : 'non_free_or_unsupported_model',
  };
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
    thinking: {
      includeThoughts: config.generation.includeThoughts,
      thinkingBudget: config.generation.thinkingBudget,
      thinkingLevel: config.generation.thinkingLevel,
    },
  };
}

function parseBackendPreference(request: FastifyRequest): LLMBackendPreference {
  const raw = readHeaderValue(request, 'x-leakrouter-backend', 'x-leakrouter-backend');
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
    readHeaderValue(input.request, 'x-leakrouter-session', 'x-leakrouter-session') ||
    readHeaderValue(input.request, 'x-leakrouter-user', 'x-leakrouter-user') ||
    input.user;
  const statefulHeader = String(
    readHeaderValue(input.request, 'x-leakrouter-stateful', 'x-leakrouter-stateful') ?? '',
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

interface FreeTierPolicyState {
  checkedAt: string | null;
  pricingUrl: string;
  textModelIds: string[];
  audioModelIds: string[];
  embeddingModelIds: string[];
  addedModelIds: string[];
  removedConfiguredModelIds: string[];
  unavailableConfiguredModelIds: string[];
  alerts: Array<{ level: 'warning' | 'critical'; message: string; modelIds: string[] }>;
  lastError?: string;
}

let freeTierPolicyState: FreeTierPolicyState = loadFreeTierPolicyState();
let freeTierPolicyRefresh: Promise<FreeTierPolicyState> | null = null;

function emptyFreeTierPolicyState(): FreeTierPolicyState {
  return {
    checkedAt: null,
    pricingUrl: config.freeTierPolicy.pricingUrl,
    textModelIds: config.freeTierPolicy.textModelIds,
    audioModelIds: config.freeTierPolicy.audioModelIds,
    embeddingModelIds: config.freeTierPolicy.embeddingModelIds,
    addedModelIds: [],
    removedConfiguredModelIds: [],
    unavailableConfiguredModelIds: [],
    alerts: [],
  };
}

function loadFreeTierPolicyState(): FreeTierPolicyState {
  if (!existsSync(config.freeTierPolicy.storePath)) return emptyFreeTierPolicyState();
  try {
    const parsed = JSON.parse(readFileSync(config.freeTierPolicy.storePath, 'utf8')) as Partial<FreeTierPolicyState>;
    return { ...emptyFreeTierPolicyState(), ...parsed };
  } catch {
    return emptyFreeTierPolicyState();
  }
}

function saveFreeTierPolicyState(state: FreeTierPolicyState): void {
  mkdirSync(path.dirname(config.freeTierPolicy.storePath), { recursive: true });
  writeFileSync(config.freeTierPolicy.storePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function extractJsonObject(value: string): Record<string, unknown> | null {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => normalizeModelId(String(item))).filter(Boolean))]
    : [];
}

function isParsedFreeTierRouterCandidate(modelId: string): boolean {
  if (isGeminiImageGenerationModelId(modelId)) return false;
  if (/robotics|computer-use|deep-research|veo|imagen|lyria|banana/i.test(modelId)) return false;
  return /^(gemini|gemma)-/i.test(modelId);
}

async function refreshFreeTierPolicyIfStale(force = false): Promise<FreeTierPolicyState> {
  if (!config.freeTierPolicy.enabled) return freeTierPolicyState;
  const checkedAt = Date.parse(String(freeTierPolicyState.checkedAt ?? ''));
  if (!force && Number.isFinite(checkedAt) && Date.now() - checkedAt < config.freeTierPolicy.refreshMs) {
    return freeTierPolicyState;
  }
  if (freeTierPolicyRefresh) return freeTierPolicyRefresh;
  freeTierPolicyRefresh = (async () => {
    try {
      const page = await fetch(config.freeTierPolicy.pricingUrl, {
        signal: AbortSignal.timeout(30_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`pricing fetch failed: HTTP ${response.status}`);
        return response.text();
      });
      const text = page
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 120_000);
      const response = await llm.chat([
        {
          role: 'system',
          content: 'Extract Gemini API Free Tier model ids from the pricing page. Return only JSON.',
        },
        {
          role: 'user',
          content: [
            'Return JSON with keys textModelIds, audioModelIds, embeddingModelIds.',
            'Include only models whose standard free tier input and output are free or available free of charge.',
            'Exclude image-generation/video/paid-only models.',
            text,
          ].join('\n'),
        },
      ], {
        model: config.freeTierPolicy.parseModel,
        allowedModelIds: config.freeTierPolicy.fallbackModelIds,
      });
      const parsed = extractJsonObject(response.content) ?? {};
      const textModelIds = readStringList(parsed.textModelIds);
      const audioModelIds = readStringList(parsed.audioModelIds);
      const embeddingModelIds = readStringList(parsed.embeddingModelIds);
      const rawDiagnostics = ((geminiApiLlm.getDiagnostics?.() ?? {}) as Record<string, unknown>);
      const rawApiModelIds = new Set(
        (Array.isArray(rawDiagnostics.models) ? rawDiagnostics.models : [])
          .map((model) => String((model as Record<string, unknown>).id ?? '').trim())
          .filter(Boolean),
      );
      const discoveredFree = new Set([...textModelIds, ...audioModelIds, ...embeddingModelIds]);
      const configuredFree = new Set(config.freeTierPolicy.allModelIds);
      const addedModelIds = [...discoveredFree]
        .filter((modelId) => !configuredFree.has(modelId))
        .filter((modelId) => rawApiModelIds.has(modelId))
        .filter((modelId) => isParsedFreeTierRouterCandidate(modelId))
        .filter((modelId) => !audioModelIds.includes(modelId) && !embeddingModelIds.includes(modelId));
      const removedConfiguredModelIds = [...configuredFree].filter((modelId) =>
        !discoveredFree.has(modelId) && !rawApiModelIds.has(modelId)
      );
      const unavailableConfiguredModelIds = config.freeTierPolicy.textModelIds.filter((modelId) => !rawApiModelIds.has(modelId));
      const alerts: FreeTierPolicyState['alerts'] = [];
      if (addedModelIds.length > 0) {
        alerts.push({ level: 'warning', message: 'attenzione nuovi modelli disponibili', modelIds: addedModelIds });
      }
      if (removedConfiguredModelIds.length > 0 || unavailableConfiguredModelIds.length > 0) {
        alerts.push({
          level: 'critical',
          message: 'attenzione un modello configurato non è più disponibile',
          modelIds: [...new Set([...removedConfiguredModelIds, ...unavailableConfiguredModelIds])],
        });
      }
      freeTierPolicyState = {
        checkedAt: new Date().toISOString(),
        pricingUrl: config.freeTierPolicy.pricingUrl,
        textModelIds: textModelIds.length > 0 ? textModelIds : config.freeTierPolicy.textModelIds,
        audioModelIds: audioModelIds.length > 0 ? audioModelIds : config.freeTierPolicy.audioModelIds,
        embeddingModelIds: embeddingModelIds.length > 0 ? embeddingModelIds : config.freeTierPolicy.embeddingModelIds,
        addedModelIds,
        removedConfiguredModelIds,
        unavailableConfiguredModelIds,
        alerts,
      };
      saveFreeTierPolicyState(freeTierPolicyState);
    } catch (error) {
      freeTierPolicyState = {
        ...freeTierPolicyState,
        checkedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      saveFreeTierPolicyState(freeTierPolicyState);
    } finally {
      freeTierPolicyRefresh = null;
    }
    return freeTierPolicyState;
  })();
  return freeTierPolicyRefresh;
}

function recordInteraction(input: {
  request: FastifyRequest;
  route: string;
  appRecord: ApiAppRecord;
  model: string;
  requestedModel?: string;
  policyFallbackReason?: string;
  messages: LLMMessage[];
  responseText?: string;
  usage?: UsageSummary;
  status: 'succeeded' | 'failed';
  statusCode: number;
  provider?: string;
  response?: Partial<LLMResponse>;
  llmError?: unknown;
  error?: string;
}): void {
  const response = input.response ?? buildInteractionResponseFromError(input.llmError);
  interactions.record({
    requestId: input.request.id,
    appId: input.appRecord.id,
    appName: input.appRecord.name,
    route: input.route,
    model: input.model,
    requestedModel: input.requestedModel ?? input.model,
    backendModel: response?.backendModel,
    apiKeyId: response?.apiKeyId,
    quotaGroup: response?.quotaGroup,
    prompt: flattenPrompt(input.messages),
    response: input.responseText,
    usage: input.usage,
    status: input.status,
    statusCode: input.statusCode,
    latencyMs: Date.now() - getStartedAt(input.request),
    origin: getRequestOrigin(input.request),
    provider: input.provider ?? response?.provider,
    fallbackReason: response?.fallbackReason,
    finishReason: response?.finishReason,
    policyFallbackReason: input.policyFallbackReason,
    fallbackAttempts: response?.fallbackAttempts,
    error: input.error,
  });
}

function buildInteractionResponseFromError(error: unknown): Partial<LLMResponse> | undefined {
  if (!(error instanceof LLMProviderError)) return undefined;
  return {
    provider: error.backend,
    backend: error.backend,
    backendModel: error.options.upstreamModel ?? undefined,
    apiKeyId: error.options.upstreamApiKeyId ?? undefined,
    quotaGroup: error.options.upstreamQuotaGroup ?? undefined,
    fallbackFrom: error.options.fallbackFrom,
    fallbackReason: error.options.fallbackReason ?? error.code,
    fallbackAttempts: error.options.fallbackAttempts,
  };
}

function sanitizeLlmDiagnostics(
  input: Record<string, unknown> | null,
  options?: { includeSensitive?: boolean },
): Record<string, unknown> | null {
  if (!input) return null;
  let geminiApi: Record<string, unknown> | null = null;
  if (input.geminiApi && typeof input.geminiApi === 'object') {
    const raw = input.geminiApi as Record<string, unknown>;
    // The gemini client already masks key material to previews, but the public
    // /health surface should not enumerate keys at all - only enabled/available
    // and the high-level model/quota state are exposed there.
    geminiApi = options?.includeSensitive
      ? raw
      : { ...raw, keys: undefined, quotaGroups: undefined };
  }
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
    ollama: input.ollama && typeof input.ollama === 'object' ? input.ollama : null,
    deepseekApi: input.deepseekApi && typeof input.deepseekApi === 'object' ? input.deepseekApi : null,
    geminiApi,
  };
}

function resolveProviderLabel(response: LLMResponse): string {
  return response.provider || response.backend || 'unknown';
}

function applyBackendHeaders(reply: FastifyReply, response: LLMResponse): void {
  if (response.backend) reply.header('x-leakrouter-backend', response.backend);
  reply.header('x-leakrouter-provider', resolveProviderLabel(response));
  if (response.fallbackFrom) reply.header('x-leakrouter-fallback-from', response.fallbackFrom);
  if (response.fallbackReason) reply.header('x-leakrouter-fallback-reason', response.fallbackReason);
  if (response.backendModel) reply.header('x-leakrouter-backend-model', response.backendModel);
  if (response.apiKeyId) reply.header('x-leakrouter-api-key-id', response.apiKeyId);
  if (response.quotaGroup) reply.header('x-leakrouter-quota-group', response.quotaGroup);
  if (response.quotaSource) reply.header('x-leakrouter-quota-source', response.quotaSource);
}

function withFallbackReason(response: LLMResponse, fallbackReason?: string): LLMResponse {
  if (!fallbackReason || response.fallbackReason) return response;
  return { ...response, fallbackReason };
}

function applyErrorHeaders(reply: FastifyReply, error: unknown): void {
  if (!(error instanceof LLMProviderError)) return;
  reply.header('x-leakrouter-backend', error.backend);
  reply.header('x-leakrouter-provider', error.backend);
  if (error.options.fallbackFrom) reply.header('x-leakrouter-fallback-from', error.options.fallbackFrom);
  if (error.options.fallbackReason) reply.header('x-leakrouter-fallback-reason', error.options.fallbackReason);
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
  if (response?.backend) headers['x-leakrouter-backend'] = response.backend;
  if (response?.provider) headers['x-leakrouter-provider'] = response.provider;
  if (response?.fallbackFrom) headers['x-leakrouter-fallback-from'] = response.fallbackFrom;
  if (response?.fallbackReason) headers['x-leakrouter-fallback-reason'] = response.fallbackReason;
  if (response?.backendModel) headers['x-leakrouter-backend-model'] = response.backendModel;
  if (response?.apiKeyId) headers['x-leakrouter-api-key-id'] = response.apiKeyId;
  if (response?.quotaGroup) headers['x-leakrouter-quota-group'] = response.quotaGroup;
  if (response?.quotaSource) headers['x-leakrouter-quota-source'] = response.quotaSource;
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
  if (response?.backend) headers['x-leakrouter-backend'] = response.backend;
  if (response?.provider) headers['x-leakrouter-provider'] = response.provider;
  if (response?.fallbackFrom) headers['x-leakrouter-fallback-from'] = response.fallbackFrom;
  if (response?.fallbackReason) headers['x-leakrouter-fallback-reason'] = response.fallbackReason;
  if (response?.backendModel) headers['x-leakrouter-backend-model'] = response.backendModel;
  if (response?.apiKeyId) headers['x-leakrouter-api-key-id'] = response.apiKeyId;
  if (response?.quotaGroup) headers['x-leakrouter-quota-group'] = response.quotaGroup;
  if (response?.quotaSource) headers['x-leakrouter-quota-source'] = response.quotaSource;
  return headers;
}

function mapLlmErrorToHttp(error: unknown): {
  statusCode: number;
  type: string;
  code: string;
  message: string;
} {
  if (error instanceof OutboundProxyError) {
    return {
      statusCode: error.statusCode,
      type: 'server_error',
      code: error.code,
      message: error.message,
    };
  }

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

function backendModels(snapshot: Record<string, unknown> | null | undefined): Array<Record<string, unknown>> {
  const models = snapshot && Array.isArray(snapshot.models) ? snapshot.models as Array<Record<string, unknown>> : [];
  return models.map((model) => {
    const id = String(model.id ?? model.name ?? '').trim();
    return {
      ...model,
      id,
      name: String(model.name ?? id),
      label: String(model.label ?? model.name ?? id),
      capabilities: model.capabilities ?? {
        chat: true,
        imageGeneration: false,
        live: false,
        embeddings: false,
        longRunning: false,
        nativeAudio: false,
        tts: false,
      },
    };
  }).filter((model) => model.id);
}

function buildAdminModelCatalog(
  diagnostics: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const configuredBackends = new Set(config.llmRouting.backendOrder);
  const ollama: Array<Record<string, unknown>> = backendModels(diagnostics.ollama as Record<string, unknown> | null | undefined)
    .map((model) => ({ ...model, provider: model.provider ?? 'ollama' }));
  const deepseek: Array<Record<string, unknown>> = backendModels(diagnostics.deepseekApi as Record<string, unknown> | null | undefined)
    .map((model) => ({ ...model, provider: model.provider ?? 'deepseek-api' }));
  const byId = new Map<string, Record<string, unknown>>();
  const configuredModels = [
    ...(configuredBackends.has('ollama') ? ollama : []),
    ...(configuredBackends.has('deepseek-api') ? deepseek : []),
  ];
  for (const model of configuredModels) {
    if (!byId.has(String(model.id))) byId.set(String(model.id), model);
  }
  if (byId.size > 0) return [...byId.values()];

  return config.freeTierPolicy.textModelIds.map((modelId) => ({
    id: modelId,
    name: modelId,
    displayName: modelId,
    label: modelId,
    provider: 'configured',
    capabilities: { chat: true },
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
  diagnostics: Record<string, unknown>,
  mode: 'chat' | 'chat-or-image',
): Array<Record<string, unknown>> {
  return buildAdminModelCatalog(diagnostics).filter((model) => {
    const capabilities = model.capabilities as ReturnType<typeof inferModelCapabilities> | undefined;
    if (capabilities) {
      return mode === 'chat'
        ? capabilities.chat
        : isLeakRouterCompatibleModelCapabilities(capabilities);
    }
    return modelSupportsSurface(model, mode);
  });
}

function buildCompatibleSurfaceModelIds(
  diagnostics: Record<string, unknown>,
  mode: 'chat' | 'chat-or-image',
): string[] {
  return buildCompatibleSurfaceModelCatalog(diagnostics, mode)
    .map((model) => String(model.id ?? '').trim())
    .filter(Boolean);
}

function buildProviderSnapshot(
  diagnostics: Record<string, unknown>,
): Record<string, unknown> {
  const routedModelIds = buildCompatibleSurfaceModelIds(diagnostics, 'chat');
  const ollama = (diagnostics.ollama as Record<string, unknown> | null) ?? {};
  const deepseekApi = (diagnostics.deepseekApi as Record<string, unknown> | null) ?? {};
  const geminiApiState = (diagnostics.geminiApi as Record<string, unknown> | null) ?? {};
  const modeDetails: Record<string, { label: string; state: Record<string, unknown> }> = {
    ollama: { label: 'Ollama', state: ollama },
    'deepseek-api': { label: 'DeepSeek API upstream', state: deepseekApi },
    'gemini-api': { label: 'Gemini API (free tier)', state: geminiApiState },
  };
  return {
    backend: config.llmRouting.backendOrder[0] ?? 'ollama',
    configuredModel: routedModelIds[0] ?? config.modelIds[0] ?? null,
    modes: config.llmRouting.backendOrder.map((backend) => ({
      id: backend,
      label: modeDetails[backend]?.label ?? backend,
      enabled: modeDetails[backend]?.state.enabled === true,
      available: modeDetails[backend]?.state.available === true,
    })),
    ollama: {
      enabled: ollama.enabled ?? false,
      available: ollama.available ?? false,
      configuredEndpointCount: ollama.configuredEndpointCount ?? 0,
      configuredModelCount: ollama.configuredModelCount ?? 0,
      excludeCloudModels: ollama.excludeCloudModels ?? false,
      defaultModel: ollama.defaultModel ?? null,
      lastModel: ollama.lastModel ?? null,
      lastError: ollama.lastError ?? null,
      lastFailureAt: ollama.lastFailureAt ?? null,
      lastSuccessAt: ollama.lastSuccessAt ?? null,
    },
    deepseekApi: {
      enabled: deepseekApi.enabled ?? false,
      available: deepseekApi.available ?? false,
      defaultModel: deepseekApi.defaultModel ?? null,
      modelCount: Array.isArray(deepseekApi.models) ? deepseekApi.models.length : 0,
      lastModel: deepseekApi.lastModel ?? null,
      lastError: deepseekApi.lastError ?? null,
      lastFailureAt: deepseekApi.lastFailureAt ?? null,
      lastSuccessAt: deepseekApi.lastSuccessAt ?? null,
    },
    usage: interactions.summary(60),
    models: buildAdminModelCatalog(diagnostics),
  };
}

function resolveActiveDefaultBackend(
  backendOrder: LLMBackendId[],
  diagnostics: Record<string, unknown>,
): LLMBackendId {
  for (const backend of backendOrder) {
    const key = backend === 'deepseek-api' ? 'deepseekApi' : backend === 'ollama' ? 'ollama' : 'geminiApi';
    const state = diagnostics[key] as Record<string, unknown> | undefined;
    if (state?.enabled === true && state?.available === true) return backend;
  }
  return backendOrder[0] ?? 'ollama';
}

function buildGuestSummary() {
  // Read the complete diagnostics only on the server, then explicitly project the
  // small quota view that is safe to expose on the unauthenticated dashboard.
  const runtime = getRuntimeSnapshot(undefined, { includeSensitiveLlm: true });
  const routing = (runtime.routing as Record<string, unknown> | undefined) ?? {};
  const llm = (runtime.llm as Record<string, unknown> | undefined) ?? {};
  const geminiApi = (llm.geminiApi as Record<string, unknown> | undefined) ?? {};
  const provider = (runtime.provider as Record<string, unknown> | undefined) ?? {};
  const providerQuota = geminiApi;
  const publicApiKeys = Array.isArray(providerQuota.keys)
    ? (providerQuota.keys as Record<string, unknown>[]).map((key) => ({
      id: key.id ?? 'account',
      quotaGroup: key.quotaGroup ?? null,
      enabled: key.enabled !== false,
      priority: key.priority ?? 0,
      lastUsedAt: key.lastUsedAt ?? null,
    }))
    : [];
  const publicQuotaGroups = Array.isArray(providerQuota.quotaGroups)
    ? (providerQuota.quotaGroups as Record<string, unknown>[]).map((group) => ({
      id: group.id ?? 'account',
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
        rpdResetAt: new Date(nextPacificDayStartMs()).toISOString(),
        rpdWindow: 'America/Los_Angeles',
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

async function readGcloudAccessToken(): Promise<string> {
  const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  const token = stdout.trim();
  if (!token) throw new Error('gcloud returned an empty access token');
  return token;
}

interface MonitoringUsageEntry {
  quotaMetric: string;
  limitName: string;
  model: string | null;
  value: number;
}

function parseMonitoringTimeSeries(timeSeries: Array<Record<string, unknown>>): MonitoringUsageEntry[] {
  const results: MonitoringUsageEntry[] = [];
  for (const series of timeSeries) {
    const metric = (series.metric as Record<string, unknown> | undefined) ?? {};
    const labels = (metric.labels as Record<string, unknown> | undefined) ?? {};
    const points = Array.isArray(series.points) ? series.points as Array<Record<string, unknown>> : [];
    const latest = points[0];
    if (!latest) continue;
    const val = (latest.value as Record<string, unknown> | undefined) ?? {};
    let value = 0;
    if (typeof val.int64Value === 'string') value = parseInt(val.int64Value, 10) || 0;
    else if (typeof val.int64Value === 'number') value = val.int64Value;
    else if (typeof val.doubleValue === 'number') value = Math.round(val.doubleValue);
    results.push({
      quotaMetric: String(labels.quota_metric ?? ''),
      limitName: String(labels.limit_name ?? ''),
      model: labels.model ? String(labels.model) : null,
      value,
    });
  }
  return results;
}

function parseRequestCountTimeSeries(timeSeries: Array<Record<string, unknown>>, mostRecentOnly: boolean): number | null {
  if (timeSeries.length === 0) return null;
  let total = 0;
  let hasData = false;
  for (const series of timeSeries) {
    const points = Array.isArray(series.points) ? series.points as Array<Record<string, unknown>> : [];
    const relevant = mostRecentOnly ? points.slice(0, 1) : points;
    for (const point of relevant) {
      const val = (point.value as Record<string, unknown> | undefined) ?? {};
      let value = 0;
      if (typeof val.int64Value === 'string') value = parseInt(val.int64Value, 10) || 0;
      else if (typeof val.int64Value === 'number') value = val.int64Value;
      else if (typeof val.doubleValue === 'number') value = Math.round(val.doubleValue);
      total += value;
      hasData = true;
    }
  }
  return hasData ? total : null;
}

interface FreeTierRow {
  model: string;
  limitName: string;
  value: number;
}

interface FreeTierModelMetrics {
  model: string;
  rpmUsed: number | null;
  rpdUsed: number | null;
  rpmLimit: number | null;
  rpdLimit: number | null;
}

function parseFreeTierTimeSeries(timeSeries: Array<Record<string, unknown>>, mostRecentOnly: boolean): FreeTierRow[] {
  const results: FreeTierRow[] = [];
  for (const s of timeSeries) {
    const metric = (s.metric as Record<string, unknown> | undefined) ?? {};
    const labels = (metric.labels as Record<string, unknown> | undefined) ?? {};
    const model = String(labels.model ?? '').trim();
    const limitName = String(labels.limit_name ?? '').trim();
    if (!model || !limitName) continue;
    const points = Array.isArray(s.points) ? s.points as Array<Record<string, unknown>> : [];
    const relevant = mostRecentOnly ? points.slice(0, 1) : points;
    let value = 0;
    for (const point of relevant) {
      const val = (point.value as Record<string, unknown> | undefined) ?? {};
      if (typeof val.int64Value === 'string') value += parseInt(val.int64Value, 10) || 0;
      else if (typeof val.int64Value === 'number') value += val.int64Value;
      else if (typeof val.doubleValue === 'number') value += Math.round(val.doubleValue);
    }
    results.push({ model, limitName, value });
  }
  return results;
}

function mergeFreeTierMetrics(rpmRows: FreeTierRow[], rpdRows: FreeTierRow[], limitRows: FreeTierRow[]): FreeTierModelMetrics[] {
  const byModel: Record<string, FreeTierModelMetrics> = {};
  const get = (model: string) => {
    if (!byModel[model]) byModel[model] = { model, rpmUsed: null, rpdUsed: null, rpmLimit: null, rpdLimit: null };
    return byModel[model];
  };
  for (const row of rpmRows) {
    if (!row.limitName.toUpperCase().includes('MINUTE')) continue;
    const entry = get(row.model);
    entry.rpmUsed = (entry.rpmUsed ?? 0) + row.value;
  }
  for (const row of rpdRows) {
    if (!row.limitName.toUpperCase().includes('DAY')) continue;
    const entry = get(row.model);
    entry.rpdUsed = (entry.rpdUsed ?? 0) + row.value;
  }
  for (const row of limitRows) {
    const upper = row.limitName.toUpperCase();
    const entry = get(row.model);
    if (upper.includes('MINUTE')) entry.rpmLimit = row.value;
    else if (upper.includes('DAY')) entry.rpdLimit = row.value;
  }
  return Object.values(byModel);
}

async function fetchGeminiQuotaFromMonitoring(
  projectId: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const now = new Date();
  const nowMs = now.getTime();
  // Rate (RPM): GAUGE metric - query last 5 minutes, 60s alignment
  const rateStart = new Date(nowMs - 5 * 60_000);
  // Allocation (RPD): GAUGE metric - query last 6 hours, 3600s alignment, take most recent point
  const allocStart = new Date(nowMs - 6 * 60 * 60_000);
  // api/request_count is CUMULATIVE → ALIGN_DELTA gives count in each alignment window
  const startOfDayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfDay = new Date(startOfDayMs);
  const dayElapsedSeconds = Math.max(120, Math.floor((nowMs - startOfDayMs) / 1000));
  const reqCountRpmStart = new Date(nowMs - 2 * 60_000);
  const headers = { Authorization: `Bearer ${accessToken}` };

  const makeUrl = (filter: string, start: Date, alignPeriod: string, aligner: string): URL => {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries`);
    url.searchParams.set('filter', filter);
    url.searchParams.set('interval.startTime', start.toISOString());
    url.searchParams.set('interval.endTime', now.toISOString());
    url.searchParams.set('aggregation.alignmentPeriod', alignPeriod);
    url.searchParams.set('aggregation.perSeriesAligner', aligner);
    url.searchParams.set('view', 'FULL');
    return url;
  };

  // quota/* metrics: only populated for standard GCP quota (not AI Studio free-tier)
  const GEMINI_QUOTA_FILTER = 'metric.labels.quota_metric : "generativelanguage"';
  const rateUrl = makeUrl(
    `metric.type="serviceruntime.googleapis.com/quota/rate/net_usage" AND ${GEMINI_QUOTA_FILTER}`,
    rateStart, '60s', 'ALIGN_MAX',
  );
  const allocUrl = makeUrl(
    `metric.type="serviceruntime.googleapis.com/quota/allocation/usage" AND ${GEMINI_QUOTA_FILTER}`,
    allocStart, '3600s', 'ALIGN_MAX',
  );
  const limitUrl = makeUrl(
    `metric.type="serviceruntime.googleapis.com/quota/limit" AND ${GEMINI_QUOTA_FILTER}`,
    rateStart, '60s', 'ALIGN_MAX',
  );
  // api/request_count: CUMULATIVE, works for any project making API calls, no per-model breakdown
  const REQ_COUNT_FILTER = 'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api" AND resource.labels.service="generativelanguage.googleapis.com"';
  const reqCountRpmUrl = makeUrl(REQ_COUNT_FILTER, reqCountRpmStart, '60s', 'ALIGN_DELTA');
  const reqCountRpdUrl = makeUrl(REQ_COUNT_FILTER, startOfDay, `${dayElapsedSeconds}s`, 'ALIGN_DELTA');
  // Legacy provider quota metrics kept for migration-only diagnostics.
  const FREE_TIER_USAGE_FILTER = 'metric.type="generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/usage"';
  const FREE_TIER_LIMIT_FILTER = 'metric.type="generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/limit"';
  const freeTierReqsRpmUrl = makeUrl(FREE_TIER_USAGE_FILTER, reqCountRpmStart, '60s', 'ALIGN_DELTA');
  const freeTierReqsRpdUrl = makeUrl(FREE_TIER_USAGE_FILTER, startOfDay, `${dayElapsedSeconds}s`, 'ALIGN_DELTA');
  const freeTierReqsLimitUrl = makeUrl(FREE_TIER_LIMIT_FILTER, allocStart, '3600s', 'ALIGN_NEXT_OLDER');

  const [rateResp, allocResp, limitResp, reqCountRpmResp, reqCountRpdResp, freeTierRpmResp, freeTierRpdResp, freeTierLimitResp] = await Promise.all([
    fetch(rateUrl, { headers, signal: AbortSignal.timeout(25_000) }).catch(() => null),
    fetch(allocUrl, { headers, signal: AbortSignal.timeout(25_000) }).catch(() => null),
    fetch(limitUrl, { headers, signal: AbortSignal.timeout(25_000) }).catch(() => null),
    fetch(reqCountRpmUrl, { headers, signal: AbortSignal.timeout(25_000) }).catch(() => null),
    fetch(reqCountRpdUrl, { headers, signal: AbortSignal.timeout(25_000) }).catch(() => null),
    fetch(freeTierReqsRpmUrl, { headers, signal: AbortSignal.timeout(25_000) }).catch(() => null),
    fetch(freeTierReqsRpdUrl, { headers, signal: AbortSignal.timeout(25_000) }).catch(() => null),
    fetch(freeTierReqsLimitUrl, { headers, signal: AbortSignal.timeout(25_000) }).catch(() => null),
  ]);
  const [ratePay, allocPay, limitPay, reqCountRpmPay, reqCountRpdPay, freeTierRpmPay, freeTierRpdPay, freeTierLimitPay]: [
    Record<string, unknown>, Record<string, unknown>, Record<string, unknown>,
    Record<string, unknown>, Record<string, unknown>,
    Record<string, unknown>, Record<string, unknown>, Record<string, unknown>,
  ] = await Promise.all([
    rateResp ? rateResp.json().catch(() => ({})) as Promise<Record<string, unknown>> : Promise.resolve({}),
    allocResp ? allocResp.json().catch(() => ({})) as Promise<Record<string, unknown>> : Promise.resolve({}),
    limitResp ? limitResp.json().catch(() => ({})) as Promise<Record<string, unknown>> : Promise.resolve({}),
    reqCountRpmResp ? reqCountRpmResp.json().catch(() => ({})) as Promise<Record<string, unknown>> : Promise.resolve({}),
    reqCountRpdResp ? reqCountRpdResp.json().catch(() => ({})) as Promise<Record<string, unknown>> : Promise.resolve({}),
    freeTierRpmResp ? freeTierRpmResp.json().catch(() => ({})) as Promise<Record<string, unknown>> : Promise.resolve({}),
    freeTierRpdResp ? freeTierRpdResp.json().catch(() => ({})) as Promise<Record<string, unknown>> : Promise.resolve({}),
    freeTierLimitResp ? freeTierLimitResp.json().catch(() => ({})) as Promise<Record<string, unknown>> : Promise.resolve({}),
  ]);

  const rateOk = rateResp?.ok ?? false;
  const allocOk = allocResp?.ok ?? false;
  const limitOk = limitResp?.ok ?? false;
  const reqCountOk = (reqCountRpmResp?.ok ?? false) || (reqCountRpdResp?.ok ?? false);

  const rateUsage = parseMonitoringTimeSeries(
    Array.isArray(ratePay.timeSeries) ? ratePay.timeSeries as Array<Record<string, unknown>> : [],
  );
  const allocUsage = parseMonitoringTimeSeries(
    Array.isArray(allocPay.timeSeries) ? allocPay.timeSeries as Array<Record<string, unknown>> : [],
  );
  const limitUsage = parseMonitoringTimeSeries(
    Array.isArray(limitPay.timeSeries) ? limitPay.timeSeries as Array<Record<string, unknown>> : [],
  );
  const requestCountRpm = parseRequestCountTimeSeries(
    Array.isArray(reqCountRpmPay.timeSeries) ? reqCountRpmPay.timeSeries as Array<Record<string, unknown>> : [],
    true,
  );
  const requestCountRpd = parseRequestCountTimeSeries(
    Array.isArray(reqCountRpdPay.timeSeries) ? reqCountRpdPay.timeSeries as Array<Record<string, unknown>> : [],
    false,
  );

  const errorMessage = (pay: Record<string, unknown>): string =>
    String((pay.error as Record<string, unknown> | undefined)?.message ?? '');

  // Native free-tier per-model metrics
  const freeTierRpmRows = parseFreeTierTimeSeries(
    Array.isArray(freeTierRpmPay.timeSeries) ? freeTierRpmPay.timeSeries as Array<Record<string, unknown>> : [],
    true,
  );
  const freeTierRpdRows = parseFreeTierTimeSeries(
    Array.isArray(freeTierRpdPay.timeSeries) ? freeTierRpdPay.timeSeries as Array<Record<string, unknown>> : [],
    false,
  );
  const freeTierLimitRows = parseFreeTierTimeSeries(
    Array.isArray(freeTierLimitPay.timeSeries) ? freeTierLimitPay.timeSeries as Array<Record<string, unknown>> : [],
    true,
  );
  const freeTierPerModel = mergeFreeTierMetrics(freeTierRpmRows, freeTierRpdRows, freeTierLimitRows);
  const freeTierOk = (freeTierRpmResp?.ok ?? false) || (freeTierRpdResp?.ok ?? false) || (freeTierLimitResp?.ok ?? false);

  return {
    projectId,
    ok: rateOk || allocOk || limitOk || reqCountOk || freeTierOk,
    rateOk,
    allocOk,
    limitOk,
    reqCountOk,
    freeTierOk,
    rateUsage,
    allocUsage,
    limitUsage,
    requestCountRpm,
    requestCountRpd,
    freeTierPerModel: freeTierPerModel.length > 0 ? freeTierPerModel : null,
    rateError: !rateOk ? (errorMessage(ratePay) || String(rateResp?.status ?? 'no response')) : null,
    allocError: !allocOk ? (errorMessage(allocPay) || String(allocResp?.status ?? 'no response')) : null,
    limitError: !limitOk ? (errorMessage(limitPay) || String(limitResp?.status ?? 'no response')) : null,
    rateCount: rateUsage.length,
    allocCount: allocUsage.length,
    limitCount: limitUsage.length,
    debug: {
      rateStatus: rateResp?.status ?? null,
      allocStatus: allocResp?.status ?? null,
      limitStatus: limitResp?.status ?? null,
      reqCountRpmStatus: reqCountRpmResp?.status ?? null,
      reqCountRpdStatus: reqCountRpdResp?.status ?? null,
      freeTierRpmStatus: freeTierRpmResp?.status ?? null,
      freeTierRpdStatus: freeTierRpdResp?.status ?? null,
      freeTierLimitStatus: freeTierLimitResp?.status ?? null,
    },
  };
}

function summarizeServiceUsageMetrics(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const metrics = Array.isArray(payload.metrics) ? payload.metrics as Array<Record<string, unknown>> : [];
  return metrics
    .filter((metric) => /generate|token|embedding|embed|request/i.test(String(metric.displayName ?? metric.metric ?? '')))
    .slice(0, 80)
    .map((metric) => ({
      metric: metric.metric ?? null,
      displayName: metric.displayName ?? null,
      unit: metric.unit ?? null,
      limits: (Array.isArray(metric.consumerQuotaLimits) ? metric.consumerQuotaLimits as Array<Record<string, unknown>> : [])
        .slice(0, 8)
        .map((limit) => ({
          name: limit.name ?? null,
          displayName: limit.displayName ?? null,
          unit: limit.unit ?? null,
          quotaBuckets: (Array.isArray(limit.quotaBuckets) ? limit.quotaBuckets as Array<Record<string, unknown>> : [])
            .slice(0, 6)
            .map((bucket) => ({
              effectiveLimit: bucket.effectiveLimit ?? null,
              defaultLimit: bucket.defaultLimit ?? null,
              dimensions: bucket.dimensions ?? null,
            })),
        })),
    }));
}

async function fetchGeminiProjectQuota(projectId: string, accessToken: string): Promise<Record<string, unknown>> {
  const url = new URL(`https://serviceusage.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/services/generativelanguage.googleapis.com/consumerQuotaMetrics`);
  url.searchParams.set('view', 'FULL');
  url.searchParams.set('pageSize', '200');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    return {
      projectId,
      ok: false,
      statusCode: response.status,
      error: (payload.error as Record<string, unknown> | undefined)?.status ?? 'service_usage_error',
      message: (payload.error as Record<string, unknown> | undefined)?.message ?? response.statusText,
    };
  }
  return {
    projectId,
    ok: true,
    source: 'google-service-usage',
    metrics: summarizeServiceUsageMetrics(payload),
  };
}

async function refreshGeminiProjectQuotaState(force = false): Promise<GeminiProjectQuotaState> {
  const updatedAt = Date.parse(String(geminiProjectQuotaState.updatedAt ?? ''));
  if (!force && Number.isFinite(updatedAt) && (Date.now() - updatedAt) < GEMINI_PROJECT_QUOTA_REFRESH_MS) {
    return geminiProjectQuotaState;
  }
  if (geminiProjectQuotaRefresh) return geminiProjectQuotaRefresh;
  geminiProjectQuotaRefresh = (async () => {
    const runtime = getRuntimeSnapshot(undefined, { includeSensitiveLlm: true });
    const geminiApi = ((runtime.backends as Record<string, unknown>)?.geminiApi as Record<string, unknown> | null) ?? {};
    const keys = Array.isArray(geminiApi.keys) ? geminiApi.keys as Array<Record<string, unknown>> : [];
    const projectIds = [...new Set(keys.map((key) => String(key.projectId ?? '').trim()).filter(Boolean))];
    let projectQuotas: Array<Record<string, unknown>> = [];
    let lastError: string | null = null;
    if (projectIds.length > 0) {
      try {
        const token = await readGcloudAccessToken();
        projectQuotas = await Promise.all(projectIds.map(async (projectId) => {
          const [serviceUsageResult, monitoringResult] = await Promise.allSettled([
            fetchGeminiProjectQuota(projectId, token),
            fetchGeminiQuotaFromMonitoring(projectId, token),
          ]);
          const base = serviceUsageResult.status === 'fulfilled'
            ? serviceUsageResult.value
            : { projectId, ok: false, error: 'serviceusage_error', message: serviceUsageResult.reason instanceof Error ? serviceUsageResult.reason.message : String(serviceUsageResult.reason) };
          const monitoring = monitoringResult.status === 'fulfilled'
            ? monitoringResult.value
            : { projectId, ok: false, rateOk: false, allocOk: false, rateUsage: [], allocUsage: [], rateError: monitoringResult.reason instanceof Error ? monitoringResult.reason.message : String(monitoringResult.reason), allocError: null };
          return { ...base, monitoring };
        }));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    const anyServiceUsageOk = projectQuotas.some((quota) => quota.ok === true);
    const anyMonitoringOk = projectQuotas.some((quota) => {
      const m = quota.monitoring as Record<string, unknown> | undefined;
      return m?.ok === true;
    });
    geminiProjectQuotaState = {
      updatedAt: new Date().toISOString(),
      source: anyServiceUsageOk && anyMonitoringOk
        ? 'google-service-usage+cloud-monitoring+local-ledger'
        : anyServiceUsageOk ? 'google-service-usage+local-ledger' : 'local-ledger',
      limitsAuthoritative: anyServiceUsageOk,
      remainingAuthoritative: false,
      authoritative: false,
      monitoringAuthoritative: false,
      projectQuotas,
      lastError,
    };
    geminiProjectQuotaRefresh = null;
    return geminiProjectQuotaState;
  })();
  return geminiProjectQuotaRefresh;
}

function resetGeminiProjectQuotaState(): GeminiProjectQuotaState {
  geminiProjectQuotaState = {
    updatedAt: null,
    source: 'local-ledger',
    limitsAuthoritative: false,
    remainingAuthoritative: false,
    authoritative: false,
    monitoringAuthoritative: false,
    projectQuotas: [],
    lastError: null,
  };
  geminiProjectQuotaRefresh = null;
  return geminiProjectQuotaState;
}

function getRuntimeSnapshot(
  request?: FastifyRequest,
  options?: { includeSensitiveLlm?: boolean },
): Record<string, unknown> {
  const rawLlmDiagnostics = typeof llm.getDiagnostics === 'function' ? llm.getDiagnostics() : null;
  const sanitizedLlmDiagnostics = sanitizeLlmDiagnostics(rawLlmDiagnostics, { includeSensitive: options?.includeSensitiveLlm });
  const backendOrder = (sanitizedLlmDiagnostics?.backendOrder as LLMBackendId[] | undefined) ?? config.llmRouting.backendOrder;
  const configuredDefaultBackend = ((sanitizedLlmDiagnostics?.configuredDefaultBackend as LLMBackendId | undefined) ?? backendOrder[0] ?? 'ollama');
  const diagnostics = (sanitizedLlmDiagnostics ?? {}) as Record<string, unknown>;
  const activeDefaultBackend = resolveActiveDefaultBackend(backendOrder, diagnostics);
  const provider = buildProviderSnapshot(diagnostics);

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
    outboundProxy: redactOutboundProxyConfig(config.outboundProxy),
    models: buildCompatibleSurfaceModelIds(diagnostics, 'chat-or-image'),
    backends: {
      ollama: sanitizedLlmDiagnostics?.ollama ?? null,
      deepseekApi: sanitizedLlmDiagnostics?.deepseekApi ?? null,
    },
    compatibility: request ? getCompatibilitySnapshot(request) : compatibility.get(),
    llm: sanitizedLlmDiagnostics,
  };
}

function normalizeAllowedModels(values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0) return config.bootstrapApp.allowedModels;
  const freeText = new Set(config.freeTierPolicy.textModelIds);
  const models = values.map((value) => normalizeModelId(String(value))).filter((modelId) => freeText.has(modelId));
  return models.length > 0 ? [...new Set(models)] : config.bootstrapApp.allowedModels;
}

function listPublicEndpoints(): string[] {
  const endpoints = ['/', '/health', '/admin', '/auth/me', '/dashboard/summary'];
  if (isSurfaceEnabled('openai')) {
    endpoints.push('/v1/models', '/v1/provider/runtime', '/v1/provider/models', '/v1/provider/quota', '/v1/chat/completions', '/v1/responses', '/v1/images/generations');
  }
  if (isAnySurfaceEnabled(['leakrouter', 'deepseek'])) {
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
  surface: 'openai' | 'leakrouter',
): Promise<FastifyReply | Record<string, unknown>> {
  if (surface === 'openai') {
    if (!ensureOpenAiSurfaceEnabled('openai', reply)) return reply;
  } else if (!ensureAnySurfaceEnabled(['leakrouter', 'deepseek'], reply, 'leakrouter/deepseek')) {
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
  surface: 'openai' | 'leakrouter',
): Promise<FastifyReply | Record<string, unknown>> {
  if (surface === 'openai') {
    if (!ensureOpenAiSurfaceEnabled('openai', reply)) return reply;
  } else if (!ensureAnySurfaceEnabled(['leakrouter', 'deepseek'], reply, 'leakrouter/deepseek')) {
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
    const resolvedModel = resolveTextModelForApp(access.app, parsed.model);
    if (!resolvedModel) {
      return sendError(reply, 403, {
        message: `No free-tier text model is enabled for app ${access.app.name}`,
        type: 'permission_error',
        code: 'no_free_text_model_allowed',
        param: 'model',
      });
    }
    const sessionOptions = buildRequestLlmOptions({
      request,
      user: parsed.user,
      sessionNamespace: access.app.sessionNamespace,
      model: resolvedModel.model,
      allowedModelIds: resolvedModel.allowedModelIds,
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
      applyBackendHeaders(reply, withFallbackReason(response, resolvedModel.policyFallbackReason));
      const usage = estimateUsage(parsed.messages, response.content);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: resolvedModel.model,
        requestedModel: resolvedModel.requestedModel,
        policyFallbackReason: resolvedModel.policyFallbackReason,
        messages: parsed.messages,
        responseText: response.content,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: response.provider,
        response: {
          ...response,
          fallbackReason: response.fallbackReason ?? resolvedModel.policyFallbackReason,
        },
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
      return buildChatCompletionResponse({
        model: parsed.model,
        text: response.content,
        usage,
        finishReason: response.finishReason,
      });
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
    let finalResponse: LLMResponse | undefined;
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalResponse = next.value;
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
        model: resolvedModel.model,
        requestedModel: resolvedModel.requestedModel,
        policyFallbackReason: resolvedModel.policyFallbackReason,
        messages: parsed.messages,
        responseText: finalText,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: finalProvider,
        response: finalResponse,
      });
      sendChunk({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: parsed.model,
        choices: [{ index: 0, delta: {}, finish_reason: finalResponse?.finishReason ?? 'stop' }],
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
        model: resolvedModel.model,
        requestedModel: resolvedModel.requestedModel,
        policyFallbackReason: resolvedModel.policyFallbackReason,
        messages: parsed.messages,
        responseText: finalText || emitted,
        status: 'failed',
        statusCode: http.statusCode,
        llmError: error,
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
      llmError: error,
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
    const resolvedModel = resolveTextModelForApp(access.app, parsed.model);
    if (!resolvedModel) {
      return sendError(reply, 403, {
        message: `No free-tier text model is enabled for app ${access.app.name}`,
        type: 'permission_error',
        code: 'no_free_text_model_allowed',
        param: 'model',
      });
    }
    const sessionOptions = buildRequestLlmOptions({
      request,
      user: parsed.user,
      sessionNamespace: access.app.sessionNamespace,
      model: resolvedModel.model,
      allowedModelIds: resolvedModel.allowedModelIds,
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
      applyBackendHeaders(reply, withFallbackReason(response, resolvedModel.policyFallbackReason));
      const usage = estimateUsage(parsed.messages, response.content);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: resolvedModel.model,
        requestedModel: resolvedModel.requestedModel,
        policyFallbackReason: resolvedModel.policyFallbackReason,
        messages: parsed.messages,
        responseText: response.content,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: response.provider,
        response: {
          ...response,
          fallbackReason: response.fallbackReason ?? resolvedModel.policyFallbackReason,
        },
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
    let finalResponse: LLMResponse | undefined;
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalResponse = next.value;
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
        model: resolvedModel.model,
        requestedModel: resolvedModel.requestedModel,
        policyFallbackReason: resolvedModel.policyFallbackReason,
        messages: parsed.messages,
        responseText: finalText,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: finalProvider,
        response: finalResponse,
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
        model: resolvedModel.model,
        requestedModel: resolvedModel.requestedModel,
        policyFallbackReason: resolvedModel.policyFallbackReason,
        messages: parsed.messages,
        responseText: finalText || emitted,
        status: 'failed',
        statusCode: http.statusCode,
        llmError: error,
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
      llmError: error,
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
  surface: 'openai' | 'leakrouter',
): Promise<FastifyReply | Record<string, unknown>> {
  if (surface === 'openai') {
    if (!ensureOpenAiSurfaceEnabled('openai', reply)) return reply;
  } else if (!ensureAnySurfaceEnabled(['leakrouter', 'deepseek'], reply, 'leakrouter/deepseek')) {
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
      llmError: error,
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
    const resolvedModel = resolveTextModelForApp(access.app, parsed.model);
    if (!resolvedModel) {
      return sendError(reply, 403, {
        message: `No free-tier text model is enabled for app ${access.app.name}`,
        type: 'permission_error',
        code: 'no_free_text_model_allowed',
        param: 'model',
      });
    }
    const sessionOptions = buildRequestLlmOptions({
      request,
      sessionNamespace: access.app.sessionNamespace,
      model: resolvedModel.model,
      allowedModelIds: resolvedModel.allowedModelIds,
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
      applyBackendHeaders(reply, withFallbackReason(response, resolvedModel.policyFallbackReason));
      const usage = estimateUsage(parsed.messages, response.content);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: resolvedModel.model,
        requestedModel: resolvedModel.requestedModel,
        policyFallbackReason: resolvedModel.policyFallbackReason,
        messages: parsed.messages,
        responseText: response.content,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: response.provider,
        response: {
          ...response,
          fallbackReason: response.fallbackReason ?? resolvedModel.policyFallbackReason,
        },
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
    let finalResponse: LLMResponse | undefined;
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalResponse = next.value;
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
        response: finalResponse,
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
        llmError: error,
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
      llmError: error,
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
    const resolvedModel = resolveTextModelForApp(access.app, parsed.model);
    if (!resolvedModel) {
      return sendError(reply, 403, {
        message: `No free-tier text model is enabled for app ${access.app.name}`,
        type: 'permission_error',
        code: 'no_free_text_model_allowed',
        param: 'model',
      });
    }
    const sessionOptions = buildRequestLlmOptions({
      request,
      sessionNamespace: access.app.sessionNamespace,
      model: resolvedModel.model,
      allowedModelIds: resolvedModel.allowedModelIds,
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
      applyBackendHeaders(reply, withFallbackReason(response, resolvedModel.policyFallbackReason));
      const usage = estimateUsage(parsed.messages, response.content);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: resolvedModel.model,
        requestedModel: resolvedModel.requestedModel,
        policyFallbackReason: resolvedModel.policyFallbackReason,
        messages: parsed.messages,
        responseText: response.content,
        usage,
        status: 'succeeded',
        statusCode: 200,
        provider: response.provider,
        response: {
          ...response,
          fallbackReason: response.fallbackReason ?? resolvedModel.policyFallbackReason,
        },
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
    let finalResponse: LLMResponse | undefined;
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalResponse = next.value;
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
        response: finalResponse,
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
        llmError: error,
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
      llmError: error,
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
  const runtime = getRuntimeSnapshot(request, { includeSensitiveLlm: true });
  const llmSnapshot = (runtime.llm as Record<string, unknown> | null) ?? null;
  const routingSnapshot = (runtime.routing as Record<string, unknown> | null) ?? null;
  const backendSnapshot = (runtime.backends as Record<string, unknown> | null) ?? null;
  const providerSnapshot = (runtime.provider as Record<string, unknown> | null) ?? null;
  const diagnostics = llmSnapshot ?? {};
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
    models: buildCompatibleSurfaceModelIds(diagnostics, 'chat-or-image'),
    modelCatalog: buildAdminModelCatalog(diagnostics),
    modelPolicy: {
      configured: config.freeTierPolicy,
    },
    apps: appStore.list().map(sanitizeAdminApp),
    stats: interactions.summary(60),
  };
});

app.post('/admin/reset-telemetry', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  interactions.clear();
  audit.reset();
  return {
    ok: true,
    interactions: 0,
    auditLogReset: true,
  };
});

app.post('/admin/provider/model-api/refresh-quota', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const geminiProjectQuota = await refreshGeminiProjectQuotaState(true);
  const runtime = getRuntimeSnapshot(request, { includeSensitiveLlm: true });
  return {
    ok: true,
    provider: runtime.provider,
    backends: runtime.backends,
    usage: interactions.summary(60),
    geminiProjectQuota,
  };
});

app.post('/admin/provider/model-api/reset-quota', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const client = geminiApiLlm as typeof geminiApiLlm & {
    resetTelemetry?: () => Record<string, unknown>;
  };
  if (typeof client.resetTelemetry !== 'function') {
    return sendError(reply, 503, {
      message: 'Gemini quota ledger is unavailable.',
      type: 'server_error',
      code: 'gemini_quota_ledger_unavailable',
    });
  }
  const quota = client.resetTelemetry();
  const geminiProjectQuota = resetGeminiProjectQuotaState();
  return { ok: true, quota, geminiProjectQuota };
});

app.post<{
  Body: {
    models?: string[];
    timeoutMs?: number;
    concurrency?: number;
  };
}>('/admin/benchmark', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const client = ollamaLlm as typeof ollamaLlm & {
    benchmarkModels?: (input?: {
      models?: string[];
      timeoutMs?: number;
      concurrency?: number;
      onResult?: (result: unknown) => void;
    }) => Promise<Record<string, unknown>>;
  };
  if (typeof client.benchmarkModels !== 'function') {
    return sendError(reply, 503, {
      message: 'Ollama benchmark is not available',
      type: 'server_error',
      code: 'benchmark_unavailable',
    });
  }
  const id = `bench_${Date.now().toString(36)}_${request.id.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
  const job: BenchmarkJob = {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    expectedCount: null,
    results: [],
    error: null,
    sources: [],
  };
  benchmarkJobs.set(id, job);
  void client.benchmarkModels({
    models: Array.isArray(request.body?.models) ? request.body.models : undefined,
    timeoutMs: typeof request.body?.timeoutMs === 'number' ? request.body.timeoutMs : 120_000,
    concurrency: 1,
    onResult: (result) => {
      job.results.push(result as unknown as Record<string, unknown>);
    },
  }).then((result) => {
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.expectedCount = typeof result.count === 'number' ? result.count : job.results.length;
    job.sources = Array.isArray(result.sources) ? result.sources as Array<Record<string, string>> : [];
    job.results = Array.isArray(result.results) ? result.results as Array<Record<string, unknown>> : job.results;
  }).catch((error) => {
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = error instanceof Error ? error.message : String(error);
  });
  return {
    ok: true,
    jobId: id,
    status: job.status,
    startedAt: job.startedAt,
    results: job.results,
  };
});

app.get<{ Params: { id: string } }>('/admin/benchmark/:id', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const job = benchmarkJobs.get(request.params.id);
  if (!job) {
    return sendError(reply, 404, {
      message: 'Benchmark job not found',
      type: 'invalid_request_error',
      code: 'benchmark_not_found',
    });
  }
  return {
    ok: job.status !== 'failed',
    jobId: job.id,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    count: job.results.length,
    expectedCount: job.expectedCount,
    results: job.results,
    sources: job.sources,
    error: job.error,
  };
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
  const resolvedModel = resolveTextModelForApp(selectedApp, model);
  if (!resolvedModel) {
    return sendError(reply, 403, {
      message: `No free-tier text model is enabled for app ${selectedApp.name}`,
      type: 'permission_error',
      code: 'no_free_text_model_allowed',
      param: 'model',
    });
  }

  const messages: LLMMessage[] = [];
  const systemPrompt = String(body.systemPrompt ?? '').trim();
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  try {
    const options = buildSessionOptions({
      model: resolvedModel.model,
      allowedModelIds: resolvedModel.allowedModelIds,
      maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      sessionNamespace: selectedApp.sessionNamespace,
      sessionHint: typeof body.sessionHint === 'string' ? body.sessionHint : undefined,
      stateful: body.stateful === true,
      fingerprintFallback: createRequestFingerprint(messages),
    });
    const response = await llm.chat(messages, options);
    applyBackendHeaders(reply, withFallbackReason(response, resolvedModel.policyFallbackReason));
    const usage = estimateUsage(messages, response.content);
    recordInteraction({
      request,
      route: request.url,
      appRecord: selectedApp,
      model: resolvedModel.model,
      requestedModel: resolvedModel.requestedModel,
      policyFallbackReason: resolvedModel.policyFallbackReason,
      messages,
      responseText: response.content,
      usage,
      status: 'succeeded',
      statusCode: 200,
      provider: response.provider,
      response: {
        ...response,
        fallbackReason: response.fallbackReason ?? resolvedModel.policyFallbackReason,
      },
    });
    return {
      ok: true,
      app: sanitizeAdminApp(selectedApp),
      model: resolvedModel.model,
      requestedModel: resolvedModel.requestedModel,
      text: response.content,
      images: response.images ?? [],
      usage,
      provider: response.provider,
      backend: response.backend ?? null,
      fallbackReason: response.fallbackReason ?? resolvedModel.policyFallbackReason ?? null,
      fallbackAttempts: response.fallbackAttempts ?? [],
      latencyMs: Date.now() - getStartedAt(request),
    };
  } catch (error) {
    const http = mapLlmErrorToHttp(error);
    applyErrorHeaders(reply, error);
    recordInteraction({
      request,
      route: request.url,
      appRecord: selectedApp,
      model: resolvedModel.model,
      requestedModel: resolvedModel.requestedModel,
      policyFallbackReason: resolvedModel.policyFallbackReason,
      messages,
      status: 'failed',
      statusCode: http.statusCode,
      llmError: error,
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
app.get('/models', async (request, reply) => handleModelsRequest(request, reply, 'leakrouter'));
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
    return {
      ok: true,
      modes: provider.modes ?? [],
      usage: provider.usage ?? interactions.summary(60),
      ollama: provider.ollama ?? {},
      deepseekApi: provider.deepseekApi ?? {},
      model: provider.configuredModel ?? null,
    };
  } finally {
    access.release();
  }
});

app.post<{ Body: ChatCompletionsRequest }>('/v1/chat/completions', async (request, reply) =>
  handleChatCompletionsRequest(request, reply, 'openai'),
);
app.post<{ Body: ChatCompletionsRequest }>('/chat/completions', async (request, reply) =>
  handleChatCompletionsRequest(request, reply, 'leakrouter'),
);
app.post<{ Body: ResponsesRequest }>('/v1/responses', async (request, reply) => handleResponsesRequest(request, reply));
app.post<{ Body: ImageGenerationsRequest }>('/v1/images/generations', async (request, reply) =>
  handleImageGenerationsRequest(request, reply, 'openai'),
);
app.post<{ Body: ImageGenerationsRequest }>('/images/generations', async (request, reply) =>
  handleImageGenerationsRequest(request, reply, 'leakrouter'),
);

app.get('/api/version', async (request, reply) => {
  if (!ensureOllamaSurfaceEnabled(reply)) return reply;
  const access = await ensureClientAccess(request, reply);
  if (!access) return reply;
  try {
    return {
      version: '0.1.0-leakrouter',
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
    const llmSnapshot = (runtime.llm as Record<string, unknown> | null) ?? {};
    const allowedModels = buildCompatibleSurfaceModelIds(llmSnapshot, 'chat').filter((modelId) =>
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
