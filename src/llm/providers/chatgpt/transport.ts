import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ChatGptOAuthService } from './auth.js';
import { ChatGptGateway } from './gateway.js';
import { createChatGptMcpServer } from './mcp.js';
import type { AuthenticatedMcpGrant } from './types.js';

interface ManagedSession {
  grant: AuthenticatedMcpGrant;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  createdAtMs: number;
  lastActivityAtMs: number;
  inFlight: number;
  closing: boolean;
  controller: AbortController;
}

export function registerChatGptMcpTransport(
  app: FastifyInstance,
  gateway: ChatGptGateway,
  oauth: ChatGptOAuthService,
): void {
  const sessions = new Map<string, ManagedSession>();
  const initializing = new Set<ManagedSession>();
  const maxSessions = 32;
  const sessionIdleMs = 10 * 60_000;
  const route = '/mcp/chatgpt/:workerId';
  let shuttingDown = false;

  app.post<{ Params: { workerId: string } }>(route, {
    bodyLimit: gateway.store.config.maxResponseBytes + 128 * 1024,
  }, async (request, reply) => {
    if (shuttingDown) return reply.code(503).send({ error: 'server_shutting_down' });
    if (!validateTransportRequest(request, reply, oauth)) return reply;
    const grant = authenticate(request, reply, oauth);
    if (!grant) return reply;
    const sessionId = singleHeader(request.headers['mcp-session-id']);
    if (sessionId) {
      const managed = sessions.get(sessionId);
      if (!managed || managed.grant.id !== grant.id || managed.grant.workerId !== grant.workerId) return sessionNotFound(reply);
      return handle(managed, request, reply, grant, request.body);
    }
    if (!isInitializeRequest(request.body)) return reply.code(400).send(jsonRpcError('A new MCP session requires an initialize request.'));
    if (sessions.size + initializing.size >= maxSessions) {
      return reply.code(429).header('retry-after', '1').send({ error: 'too_many_mcp_sessions' });
    }

    let managed!: ManagedSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        initializing.delete(managed);
        sessions.set(id, managed);
      },
      enableJsonResponse: true,
    });
    const controller = new AbortController();
    const server = createChatGptMcpServer(gateway, grant, controller.signal);
    managed = {
      grant,
      transport,
      server,
      createdAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
      inFlight: 0,
      closing: false,
      controller,
    };
    initializing.add(managed);
    transport.onclose = () => void closeSession(transport.sessionId, managed, sessions);
    transport.onerror = () => void closeSession(transport.sessionId, managed, sessions);
    try {
      await server.connect(transport);
      return await handle(managed, request, reply, grant, request.body);
    } catch {
      await closeSession(transport.sessionId, managed, sessions);
      if (!reply.sent) return reply.code(500).send(jsonRpcError('MCP transport initialization failed.'));
      return reply;
    } finally {
      initializing.delete(managed);
      if (!transport.sessionId) await closeSession(undefined, managed, sessions);
    }
  });

  app.get<{ Params: { workerId: string } }>(route, async (request, reply) => {
    if (!validateTransportRequest(request, reply, oauth)) return reply;
    const grant = authenticate(request, reply, oauth);
    if (!grant) return reply;
    const sessionId = singleHeader(request.headers['mcp-session-id']);
    if (!sessionId) return sessionNotFound(reply);
    const managed = sessions.get(sessionId);
    if (!managed || managed.grant.id !== grant.id || managed.grant.workerId !== grant.workerId) return sessionNotFound(reply);
    return handle(managed, request, reply, grant);
  });

  app.delete<{ Params: { workerId: string } }>(route, async (request, reply) => {
    if (!validateTransportRequest(request, reply, oauth)) return reply;
    const grant = authenticate(request, reply, oauth);
    if (!grant) return reply;
    const sessionId = singleHeader(request.headers['mcp-session-id']);
    const managed = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId || !managed || managed.grant.id !== grant.id || managed.grant.workerId !== grant.workerId) return sessionNotFound(reply);
    // Let the SDK process the protocol DELETE before disposing our references.
    await handle(managed, request, reply, grant);
    await closeSession(sessionId, managed, sessions);
    return reply;
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, managed] of sessions) {
      if (managed.inFlight === 0 && now - managed.lastActivityAtMs > sessionIdleMs) {
        void closeSession(id, managed, sessions);
      }
    }
  }, 30_000);
  sweep.unref();

  const closeAll = async () => {
    shuttingDown = true;
    clearInterval(sweep);
    await Promise.allSettled([
      ...[...sessions.entries()].map(([id, managed]) => closeSession(id, managed, sessions)),
      ...[...initializing].map((managed) => closeSession(undefined, managed, sessions)),
    ]);
    initializing.clear();
  };
  // Abort long polls before Fastify waits for active HTTP requests to finish.
  app.addHook('preClose', closeAll);
  app.addHook('onClose', closeAll);

  function authenticate(
    request: FastifyRequest<{ Params: { workerId: string } }>,
    reply: FastifyReply,
    service: ChatGptOAuthService,
  ): AuthenticatedMcpGrant | null {
    let grant: AuthenticatedMcpGrant | null = null;
    try {
      grant = service.authenticate(request.headers.authorization, request.params.workerId);
    } catch {
      grant = null;
    }
    if (grant) return grant;
    const metadata = `${service.issuer}/.well-known/oauth-protected-resource/mcp/chatgpt/${encodeURIComponent(request.params.workerId)}`;
    reply.header('www-authenticate', `Bearer resource_metadata="${metadata}", error="invalid_token"`);
    reply.code(401).send({ error: 'invalid_token', error_description: 'A valid worker-scoped MCP Bearer token is required.' });
    return null;
  }

  async function handle(
    managed: ManagedSession,
    request: FastifyRequest,
    reply: FastifyReply,
    grant: AuthenticatedMcpGrant,
    body?: unknown,
  ): Promise<FastifyReply> {
    if (managed.closing) return sessionNotFound(reply);
    managed.inFlight += 1;
    managed.lastActivityAtMs = Date.now();
    // The SDK carries server-authenticated context independently for each RPC.
    // Never mutate a shared grant: another request using a refreshed token must
    // not extend the authorization lifetime of an older, still-pending poll.
    const requestGrant = { ...grant, scopes: [...grant.scopes] };
    (request.raw as typeof request.raw & { auth: AuthInfo }).auth = {
      token: 'verified-worker-token', clientId: grant.clientId, scopes: [...grant.scopes],
      expiresAt: Math.floor(grant.expiresAt / 1000), extra: { gemrouterGrant: requestGrant },
    };
    reply.hijack();
    reply.raw.setHeader('cache-control', 'no-store');
    reply.raw.setHeader('x-content-type-options', 'nosniff');
    try {
      await managed.transport.handleRequest(request.raw, reply.raw, body);
    } catch {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          reply.raw.end(JSON.stringify(jsonRpcError('MCP transport failed.')));
        } else reply.raw.destroy();
      }
      await closeSession(managed.transport.sessionId, managed, sessions);
    } finally {
      managed.inFlight = Math.max(0, managed.inFlight - 1);
      managed.lastActivityAtMs = Date.now();
    }
    return reply;
  }
}

async function closeSession(
  sessionId: string | undefined,
  managed: ManagedSession,
  sessions: Map<string, ManagedSession>,
): Promise<void> {
  if (managed.closing) return;
  managed.closing = true;
  managed.controller.abort();
  if (sessionId && sessions.get(sessionId) === managed) sessions.delete(sessionId);
  await managed.server.close().catch(() => undefined);
  await managed.transport.close().catch(() => undefined);
}

function validateTransportRequest(request: FastifyRequest<{ Params: { workerId: string } }>, reply: FastifyReply, oauth: ChatGptOAuthService): boolean {
  let expected: URL;
  try {
    expected = new URL(oauth.issuer);
  } catch {
    reply.code(500).send({ error: 'invalid_server_origin' });
    return false;
  }
  const host = String(request.headers.host ?? '').toLowerCase();
  if (!host || host !== expected.host.toLowerCase()) {
    reply.code(421).send({ error: 'misdirected_request' });
    return false;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== expected.origin) {
    reply.code(403).send({ error: 'origin_not_allowed' });
    return false;
  }
  const query = request.query as Record<string, unknown>;
  if (query && ('access_token' in query || 'token' in query)) {
    reply.code(400).send({ error: 'bearer_header_required' });
    return false;
  }
  return true;
}

function sessionNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'mcp_session_not_found' });
}

function jsonRpcError(message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code: -32603, message }, id: null };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
