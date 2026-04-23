import 'dotenv/config';

import { existsSync } from 'node:fs';
import path from 'node:path';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

import { loadConfig } from './config.js';
import {
  buildChatCompletionResponse,
  buildOpenAIError,
  buildResponsesApiResponse,
  createRequestFingerprint,
  estimateUsage,
  normalizeModelId,
  parseChatCompletionsRequest,
  parseResponsesRequest,
  sanitizeSessionHint,
  type ChatCompletionsRequest,
  type ResponsesRequest,
  type UsageSummary,
} from './lib/openai.js';
import { createTeGemClient } from './llm/providers/tegem/client.js';
import type { LLMMessage, LLMOptions } from './llm/types.js';
import { AuditLogger } from './store/audit.js';
import { AdminSessionStore } from './store/adminSessions.js';
import { AppStore, type ApiAppRecord } from './store/appStore.js';
import { InteractionStore } from './store/interactions.js';
import { renderAppShell } from './ui.js';

const PROJECT_NAME = 'GemRouterFE';
const SERVICE_NAME = 'gem-router-fe';
const STUDY_PATH = '/home/funboy/bairbi-stack/PROJECT_STUDY.md';
const ADMIN_COOKIE_NAME = 'gemrouter_admin_session';

const config = loadConfig();
const llm = createTeGemClient(config.llm);
const appStore = new AppStore(config.appsStorePath);
const audit = new AuditLogger(config.auditLogPath);
const adminSessions = new AdminSessionStore(config.adminSessionTtlMs);
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

type AuthenticatedClientApp = NonNullable<ReturnType<AppStore['verify']>>;
type AuthenticatedClientAccess = {
  release: () => void;
  app: AuthenticatedClientApp;
};

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

function inferVncUrl(request: FastifyRequest): string {
  if (config.vncPublicUrl?.trim()) return config.vncPublicUrl.trim();
  const host = readHeaderValue(request, 'x-forwarded-host') ?? String(request.headers.host ?? '');
  if (/solclawn\.com$/i.test(host)) {
    return 'https://vnc.solclawn.com/vnc.html?autoconnect=true&resize=scale';
  }
  return 'http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale';
}

function wantsHtml(request: FastifyRequest): boolean {
  const accept = String(request.headers.accept ?? '').toLowerCase();
  return accept.includes('text/html');
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
      'x-baribi-session',
      'x-baribi-user',
      'x-baribi-stateful',
      'OpenAI-Organization',
      'OpenAI-Project',
    ].join(', '),
  );
  reply.header('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
}

function hasAdminAccess(request: FastifyRequest): boolean {
  const token = getBearerToken(request);
  if (token === config.adminToken) return true;
  return adminSessions.verify(getAdminSessionId(request));
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

function ensureClientAccess(request: FastifyRequest, reply: FastifyReply): AuthenticatedClientAccess | null {
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

  const release = appStore.acquireConcurrency(clientApp);
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
  maxTokens?: number;
  temperature?: number;
  sessionNamespace: string;
  sessionHint?: string;
  user?: string;
  stateful?: boolean;
  fingerprintFallback: string;
}): LLMOptions {
  const rawSessionHint = input.sessionHint || input.user;
  const sessionHint = sanitizeSessionHint(rawSessionHint, input.fingerprintFallback);
  const sessionKey = `${input.sessionNamespace}:${sessionHint}`;
  return {
    model: input.model,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    sessionKey,
    sessionLabel: sessionKey,
    resetSession: input.stateful !== true,
  };
}

function buildRequestLlmOptions(input: {
  request: FastifyRequest;
  user?: string;
  sessionNamespace: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  fingerprintFallback: string;
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
    model: input.model,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    sessionNamespace: input.sessionNamespace,
    sessionHint: rawSessionHint,
    user: input.user,
    stateful,
    fingerprintFallback: input.fingerprintFallback,
  });
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

function getRuntimeSnapshot(): Record<string, unknown> {
  const profileDir = path.join(config.llm.baseProfileDir, config.llm.profileNamespace);
  const cookiesFile = path.join(profileDir, '_shared', 'Default', 'Cookies');
  const executableExists = config.llm.browserExecutablePath ? existsSync(config.llm.browserExecutablePath) : false;
  const profileExists = existsSync(profileDir);
  const cookiesExists = existsSync(cookiesFile);
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    ts: new Date().toISOString(),
    models: config.modelIds,
    runtime: {
      display: process.env.DISPLAY ? 'attached' : null,
      headed: !config.llm.headless,
      profileReady: executableExists && profileExists && cookiesExists,
    },
    playwright: {
      executableExists,
      profileExists,
      cookiesExists,
      profileNamespace: config.llm.profileNamespace,
    },
  };
}

function normalizeAllowedModels(values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0) return config.bootstrapApp.allowedModels;
  return values.map((value) => normalizeModelId(String(value)));
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
  if (wantsHtml(request)) {
    return reply
      .type('text/html; charset=utf-8')
      .send(
        renderAppShell({
          projectName: PROJECT_NAME,
          modelIds: config.modelIds,
        }),
      );
  }
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    endpoints: [
      '/',
      '/health',
      '/v1/models',
      '/v1/chat/completions',
      '/v1/responses',
      '/admin',
    ],
  };
});

app.get('/admin', async (request, reply) =>
  reply
    .type('text/html; charset=utf-8')
    .send(
      renderAppShell({
        projectName: PROJECT_NAME,
        modelIds: config.modelIds,
      }),
    ),
);

app.get('/health', async () => getRuntimeSnapshot());

app.post<{ Body: { token?: string } }>('/admin/login', async (request, reply) => {
  const token = String(request.body?.token ?? '').trim();
  if (token !== config.adminToken) {
    return sendError(reply, 401, {
      message: 'Invalid admin token',
      type: 'authentication_error',
      code: 'invalid_admin_token',
    });
  }
  const sessionId = adminSessions.create();
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
  };
});

app.post('/admin/logout', async (request, reply) => {
  adminSessions.revoke(getAdminSessionId(request));
  clearAdminCookie(reply);
  return {
    ok: true,
  };
});

app.get('/admin/me', async (request, reply) => {
  if (!hasAdminAccess(request)) {
    return sendError(reply, 401, {
      message: 'Admin session required',
      type: 'authentication_error',
      code: 'admin_session_required',
    });
  }
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
  };
});

app.get('/admin/summary', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  const runtime = getRuntimeSnapshot();
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    vncUrl: inferVncUrl(request),
    runtime: {
      displayAttached: process.env.DISPLAY ? true : false,
      headed: !config.llm.headless,
      executableExists: (runtime.playwright as Record<string, unknown>).executableExists,
      profileExists: (runtime.playwright as Record<string, unknown>).profileExists,
      cookiesExists: (runtime.playwright as Record<string, unknown>).cookiesExists,
      profileReady:
        Boolean((runtime.playwright as Record<string, unknown>).executableExists) &&
        Boolean((runtime.playwright as Record<string, unknown>).profileExists) &&
        Boolean((runtime.playwright as Record<string, unknown>).cookiesExists),
      apps: appStore.list().length,
    },
    models: config.modelIds,
    apps: appStore.list().map(sanitizeAdminApp),
    stats: interactions.summary(60),
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
      maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      sessionNamespace: selectedApp.sessionNamespace,
      sessionHint: typeof body.sessionHint === 'string' ? body.sessionHint : undefined,
      stateful: body.stateful === true,
      fingerprintFallback: createRequestFingerprint(messages),
    });
    const response = await llm.chat(messages, options);
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
      usage,
      provider: response.provider,
      latencyMs: Date.now() - getStartedAt(request),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordInteraction({
      request,
      route: request.url,
      appRecord: selectedApp,
      model,
      messages,
      status: 'failed',
      statusCode: 500,
      error: message,
    });
    audit.write({
      type: 'admin.test-chat.error',
      requestId: request.id,
      appId: selectedApp.id,
      route: request.url,
      model,
      statusCode: 500,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: message },
    });
    return sendError(reply, 500, {
      message,
      type: 'server_error',
      code: 'test_chat_failed',
    });
  }
});

app.get('/v1/models', async (request, reply) => {
  const access = ensureClientAccess(request, reply);
  if (!access) return reply;
  try {
    return {
      object: 'list',
      data: config.modelIds
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
});

app.post<{ Body: ChatCompletionsRequest }>('/v1/chat/completions', async (request, reply) => {
  const access = ensureClientAccess(request, reply);
  if (!access) return reply;

  try {
    const parsed = parseChatCompletionsRequest(request.body ?? {});
    if (!ensureModelAllowed(reply, access.app, parsed.model)) return reply;
    const sessionOptions = buildRequestLlmOptions({
      request,
      user: parsed.user,
      sessionNamespace: access.app.sessionNamespace,
      model: parsed.model,
      maxTokens: parsed.maxTokens,
      temperature: parsed.temperature,
      fingerprintFallback: createRequestFingerprint(parsed.messages),
    });

    if (!parsed.stream) {
      const response = await llm.chat(parsed.messages, sessionOptions);
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
      });
      return buildChatCompletionResponse({ model: parsed.model, text: response.content, usage });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'x-request-id': request.id,
    });

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
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalText = next.value.content;
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
      });
      reply.raw.end();
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText || emitted,
        status: 'failed',
        statusCode: 500,
        error: message,
      });
      sendChunk(
        buildOpenAIError({
          message,
          type: 'server_error',
          code: 'stream_failed',
        }),
      );
      reply.raw.end();
      audit.write({
        type: 'chat.stream.error',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 500,
        latencyMs: Date.now() - getStartedAt(request),
        details: { error: message },
      });
      return reply;
    }
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
  } finally {
    access.release();
  }
});

app.post<{ Body: ResponsesRequest }>('/v1/responses', async (request, reply) => {
  const access = ensureClientAccess(request, reply);
  if (!access) return reply;

  try {
    const parsed = parseResponsesRequest(request.body ?? {});
    if (!ensureModelAllowed(reply, access.app, parsed.model)) return reply;
    const sessionOptions = buildRequestLlmOptions({
      request,
      user: parsed.user,
      sessionNamespace: access.app.sessionNamespace,
      model: parsed.model,
      maxTokens: parsed.maxTokens,
      temperature: parsed.temperature,
      fingerprintFallback: createRequestFingerprint(parsed.messages),
    });

    if (!parsed.stream) {
      const response = await llm.chat(parsed.messages, sessionOptions);
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
      });
      return buildResponsesApiResponse({ model: parsed.model, text: response.content, usage });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'x-request-id': request.id,
    });

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
    try {
      const stream = llm.streamChat ? llm.streamChat(parsed.messages, sessionOptions) : null;
      if (!stream) throw new Error('Streaming is not available');
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalText = next.value.content;
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
      });
      reply.raw.end();
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordInteraction({
        request,
        route: request.url,
        appRecord: access.app,
        model: parsed.model,
        messages: parsed.messages,
        responseText: finalText || emitted,
        status: 'failed',
        statusCode: 500,
        error: message,
      });
      sendEvent({
        type: 'error',
        error: buildOpenAIError({
          message,
          type: 'server_error',
          code: 'stream_failed',
        }).error,
      });
      reply.raw.end();
      audit.write({
        type: 'responses.stream.error',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 500,
        latencyMs: Date.now() - getStartedAt(request),
        details: { error: message },
      });
      return reply;
    }
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
  } finally {
    access.release();
  }
});

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
    name: String(body.name ?? '').trim() || 'frontend-app',
    allowedOrigins: Array.isArray(body.allowedOrigins) ? body.allowedOrigins : config.bootstrapApp.allowedOrigins,
    allowedModels: normalizeAllowedModels(body.allowedModels),
    sessionNamespace: String(body.sessionNamespace ?? body.name ?? 'frontend-app'),
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
  const runtime = getRuntimeSnapshot();
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    profileDir: (runtime.playwright as Record<string, unknown>).profileDir,
    executablePath: (runtime.playwright as Record<string, unknown>).executablePath,
    executableExists: (runtime.playwright as Record<string, unknown>).executableExists,
    display: process.env.DISPLAY ?? null,
    headless: config.llm.headless,
    apps: appStore.list().length,
    auditLogPath: config.auditLogPath,
    publicBaseUrl: inferPublicBaseUrl(request),
    vncUrl: inferVncUrl(request),
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
