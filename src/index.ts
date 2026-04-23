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
} from './lib/openai.js';
import { createTeGemClient } from './llm/providers/tegem/client.js';
import type { LLMOptions } from './llm/types.js';
import { AuditLogger } from './store/audit.js';
import { AppStore } from './store/appStore.js';

const PROJECT_NAME = 'GemRouterFE';
const SERVICE_NAME = 'gem-router-fe';
const STUDY_PATH = '/home/funboy/bairbi-stack/PROJECT_STUDY.md';

const config = loadConfig();
const llm = createTeGemClient(config.llm);
const appStore = new AppStore(config.appsStorePath);
const audit = new AuditLogger(config.auditLogPath);

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

function setCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : null;
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
  reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
}

function ensureAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const token = getBearerToken(request);
  if (token !== config.adminToken) {
    sendError(reply, 401, {
      message: 'Invalid admin token',
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

  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : null;
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
  request: FastifyRequest,
  reply: FastifyReply,
  clientApp: AuthenticatedClientApp,
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

function buildLlmOptions(input: {
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
  ).trim().toLowerCase();
  const stateful = ['1', 'true', 'yes', 'on'].includes(statefulHeader);
  const sessionHint = sanitizeSessionHint(rawSessionHint, input.fingerprintFallback);
  const sessionKey = `${input.sessionNamespace}:${sessionHint}`;
  return {
    model: input.model,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    sessionKey,
    sessionLabel: sessionKey,
    resetSession: !stateful,
  };
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

app.get('/', async () => ({
  ok: true,
  project: PROJECT_NAME,
  service: SERVICE_NAME,
  repoPath: config.rootDir,
  studyPath: STUDY_PATH,
  endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/responses'],
}));

app.get('/health', async () => {
  const profileDir = path.join(config.llm.baseProfileDir, config.llm.profileNamespace);
  const cookiesFile = path.join(profileDir, '_shared', 'Default', 'Cookies');
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    studyPath: STUDY_PATH,
    ts: new Date().toISOString(),
    bootstrapAppId: bootstrapApp.id,
    models: config.modelIds,
    runtime: {
      display: process.env.DISPLAY ?? null,
      headless: config.llm.headless,
    },
    playwright: {
      executablePath: config.llm.browserExecutablePath ?? null,
      executableExists: config.llm.browserExecutablePath ? existsSync(config.llm.browserExecutablePath) : false,
      profileDir,
      profileExists: existsSync(profileDir),
      cookiesExists: existsSync(cookiesFile),
      profileNamespace: config.llm.profileNamespace,
    },
  };
});

app.get('/v1/models', async (request, reply) => {
  const access = ensureClientAccess(request, reply);
  if (!access) return reply;
  access.release();
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
});

app.post<{ Body: ChatCompletionsRequest }>('/v1/chat/completions', async (request, reply) => {
  const access = ensureClientAccess(request, reply);
  if (!access) return reply;

  try {
    const parsed = parseChatCompletionsRequest(request.body ?? {});
    if (!ensureModelAllowed(request, reply, access.app, parsed.model)) return reply;
    const sessionOptions = buildLlmOptions({
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
      const stream = llm.streamChat
        ? llm.streamChat(parsed.messages, sessionOptions)
        : null;
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
      sendChunk(buildOpenAIError({
        message: error instanceof Error ? error.message : String(error),
        type: 'server_error',
        code: 'stream_failed',
      }));
      reply.raw.end();
      audit.write({
        type: 'chat.stream.error',
        requestId: request.id,
        appId: access.app.id,
        route: request.url,
        model: parsed.model,
        statusCode: 500,
        latencyMs: Date.now() - getStartedAt(request),
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      return reply;
    }
  } catch (error) {
    audit.write({
      type: 'chat.completion.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      statusCode: 400,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    return sendError(reply, 400, {
      message: error instanceof Error ? error.message : String(error),
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
    if (!ensureModelAllowed(request, reply, access.app, parsed.model)) return reply;
    const sessionOptions = buildLlmOptions({
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
      const stream = llm.streamChat
        ? llm.streamChat(parsed.messages, sessionOptions)
        : null;
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
      sendEvent({
        type: 'error',
        error: buildOpenAIError({
          message: error instanceof Error ? error.message : String(error),
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
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      return reply;
    }
  } catch (error) {
    audit.write({
      type: 'responses.create.error',
      requestId: request.id,
      appId: access.app.id,
      route: request.url,
      statusCode: 400,
      latencyMs: Date.now() - getStartedAt(request),
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    return sendError(reply, 400, {
      message: error instanceof Error ? error.message : String(error),
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
    data: appStore.list(),
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
    allowedModels: Array.isArray(body.allowedModels)
      ? body.allowedModels.map((value) => normalizeModelId(value))
      : config.bootstrapApp.allowedModels,
    sessionNamespace: String(body.sessionNamespace ?? body.name ?? 'frontend-app'),
    rateLimitPerMinute: typeof body.rateLimitPerMinute === 'number' ? body.rateLimitPerMinute : config.bootstrapApp.rateLimitPerMinute,
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
    app: created.record,
    apiKey: created.rawKey,
  });
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
    app: rotated.record,
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
    app: revoked,
  };
});

app.get('/admin/runtime', async (request, reply) => {
  if (!ensureAdmin(request, reply)) return reply;
  return {
    ok: true,
    project: PROJECT_NAME,
    service: SERVICE_NAME,
    profileDir: path.join(config.llm.baseProfileDir, config.llm.profileNamespace),
    executablePath: config.llm.browserExecutablePath ?? null,
    executableExists: config.llm.browserExecutablePath ? existsSync(config.llm.browserExecutablePath) : false,
    display: process.env.DISPLAY ?? null,
    headless: config.llm.headless,
    apps: appStore.list().length,
    auditLogPath: config.auditLogPath,
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

app.listen({ host: config.host, port: config.port })
  .then((address) => {
    console.log(`${PROJECT_NAME} listening on ${address}`);
    console.log(`bootstrap app: ${bootstrapApp.id} (${bootstrapApp.name})`);
  })
  .catch((error) => {
    console.error(`failed to start ${PROJECT_NAME}:`, error);
    process.exit(1);
  });
