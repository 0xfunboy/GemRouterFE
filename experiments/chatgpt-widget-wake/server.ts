import Fastify, { type FastifyRequest } from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { BUILD, PREFIX, marker, observationSchema } from './protocol.js';
import { ProbeError, ProbeState } from './state.js';

export const RESOURCE = 'ui://gemrouter-wake-probe/card-0.1.3.html';
export type Config = { publicOrigin: string; widgetOrigin: string; html: string; adminToken: string };
const codeSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), mount: z.string().uuid() }).strict();
const idSchema = z.object({ sessionId: z.string().regex(/^session_[a-f0-9]{24}$/) }).strict();
const hash = (s: string) => createHash('sha256').update(s).digest();

export function createProbe(config: Config, state = new ProbeState()) {
  const http = Fastify({ logger: false, bodyLimit: 8192, requestTimeout: 10_000, forceCloseConnections: true });
  const admin = Fastify({ logger: false, bodyLimit: 4096, requestTimeout: 10_000, forceCloseConnections: true });
  for (const app of [http, admin]) {
    app.setErrorHandler((err, _req, reply) => {
      const known = err instanceof ProbeError || err instanceof z.ZodError;
      reply.code(err instanceof ProbeError ? err.status : known ? 400 : 500)
        .send({ error: err instanceof ProbeError ? err.code : known ? 'invalid_input' : 'internal_error' });
    });
    app.addHook('onRequest', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    });
  }
  let rateEpoch = Date.now(), enrollAttempts = 0;
  http.addHook('onRequest', async (req, reply) => {
    // MCP discovery is public/static. Every other endpoint requires the exact
    // declared widget origin AND enrollment or a short-lived capability.
    if (req.url.split('?')[0] === PREFIX + '/mcp') {
      if (req.headers.origin && ![config.widgetOrigin, config.publicOrigin, 'https://chatgpt.com'].includes(req.headers.origin)) throw new ProbeError('origin_denied', 403);
      return;
    }
    if (req.url.includes('?') || req.headers.origin !== config.widgetOrigin) throw new ProbeError('origin_denied', 403);
    reply.header('Access-Control-Allow-Origin', config.widgetOrigin).header('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Probe-Mount')
        .header('Access-Control-Max-Age', '60');
      await reply.code(204).send();
    }
  });
  http.options(PREFIX + '/*', async (_req, reply) => reply.code(204).send());
  function auth(req: FastifyRequest) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''));
    const mount = z.string().uuid().safeParse(req.headers['x-probe-mount']);
    if (!match || !mount.success) throw new ProbeError('invalid_capability', 401);
    return state.authenticate(match[1], mount.data);
  }
  http.post(PREFIX + '/enroll', async req => {
    if (Date.now() - rateEpoch > 60_000) { rateEpoch = Date.now(); enrollAttempts = 0; }
    if (++enrollAttempts > 20) throw new ProbeError('enrollment_rate_limit', 429);
    const data = codeSchema.parse(req.body);
    return state.enroll(data.code, data.mount);
  });
  http.post(PREFIX + '/check', async req => {
    const id = auth(req), { eventId } = z.object({ eventId: marker }).strict().parse(req.body);
    return state.check(id, eventId);
  });
  http.post(PREFIX + '/receipt', async req => { state.receipt(auth(req), req.body); return { recorded: true }; });
  http.get(PREFIX + '/readiness', async req => state.readiness(auth(req)));
  http.post(PREFIX + '/stop', async req => { state.stop(auth(req), 'widget_stop'); return { stopped: true }; });
  http.get(PREFIX + '/events', async (req, reply) => {
    const id = auth(req);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => { clearInterval(heartbeat); if (!reply.raw.writableEnded) reply.raw.end(); };
    const send = (data: unknown, event = 'probe') => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return false;
      // A backpressured stream is ambiguous: stop instead of replaying.
      return reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    state.connect(id, event => send(event), close);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': config.widgetOrigin, 'Vary': 'Origin' });
    send({ sessionId: id }, 'ready');
    heartbeat = setInterval(() => { if (!send({}, 'heartbeat')) state.stop(id, 'sse_write_failed'); }, 15_000);
    reply.raw.once('close', () => { clearInterval(heartbeat); state.stop(id, 'sse_closed'); });
  });

  http.post(PREFIX + '/mcp', async (req, reply) => {
    const server = new McpServer({ name: 'GemRouter Wake Probe', version: BUILD });
    const meta = { ui: { csp: { connectDomains: [config.publicOrigin], resourceDomains: [] }, prefersBorder: true } };
    registerAppResource(server, 'Wake probe card', RESOURCE, { mimeType: RESOURCE_MIME_TYPE, _meta: meta }, async () => ({
      contents: [{ uri: RESOURCE, mimeType: RESOURCE_MIME_TYPE, text: config.html, _meta: meta }],
    }));
    registerAppTool(server, 'render_wake_probe', {
      title: 'Show experimental wake probe',
      description: 'Display a static diagnostic card only when explicitly requested. Does not wake a chat, connect a listener or call any gateway tool. Do not call again in response to probe messages.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: RESOURCE, visibility: ['model'] }, 'openai/outputTemplate': RESOURCE, securitySchemes: [{ type: 'noauth' }] },
    }, async () => ({ content: [{ type: 'text', text: 'Experimental card displayed. Disarmed. Wait for the user; do not call gateway tools or render another card.' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const cleanup = () => { void transport.close(); void server.close(); };
    reply.raw.once('close', cleanup);
    reply.hijack();
    try { await transport.handleRequest(req.raw, reply.raw, req.body); }
    catch { if (!reply.raw.headersSent) reply.raw.writeHead(500); reply.raw.end(); }
  });
  http.get(PREFIX + '/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send({ error: 'stateless_post_only' }));

  admin.addHook('onRequest', async req => {
    if (req.headers.origin || req.url.includes('?') || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) throw new ProbeError('local_only', 403);
    if (!timingSafeEqual(hash(String(req.headers.authorization ?? '')), hash('Bearer ' + config.adminToken))) throw new ProbeError('admin_unauthorized', 401);
  });
  admin.post('/issue', async req => { z.object({}).strict().parse(req.body); return state.issue(); });
  admin.post('/emit', async req => state.emit(idSchema.parse(req.body).sessionId));
  admin.post('/observe', async req => {
    const { sessionId, observation } = z.object({ sessionId: idSchema.shape.sessionId, observation: observationSchema }).strict().parse(req.body);
    state.observe(sessionId, observation); return { recorded: true, source: 'operator_reported', serverVerified: false };
  });
  admin.post('/stop', async req => { state.stop(idSchema.parse(req.body).sessionId); return { stopped: true }; });
  admin.get('/report', async () => ({ build: BUILD, sessions: state.report() }));
  const sweep = setInterval(() => state.sweep(), 1000); sweep.unref();
  let closing: Promise<void> | undefined;
  function close() {
    return closing ??= (async () => { clearInterval(sweep); state.close(); await Promise.all([http.close(), admin.close()]); })();
  }
  return { http, admin, state, close };
}
