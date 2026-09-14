import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ChatGptOAuthService, OAuthRequestError } from './auth.js';
import { ChatGptGateway } from './gateway.js';
import { buildWorkerPrompt } from './worker-prompt.js';
import { registerChatGptMcpTransport } from './transport.js';

export interface ChatGptRouteHooks {
  isAdmin(request: FastifyRequest): boolean;
  ensureAdmin(request: FastifyRequest, reply: FastifyReply): boolean;
  ensureAdminMutation(request: FastifyRequest, reply: FastifyReply, formCsrf?: string): boolean;
  adminCsrf(request: FastifyRequest): string | null;
  appIds(): string[];
  audit(event: { type: string; requestId?: string; workerId?: string; details?: Record<string, unknown> }): void;
}

export function registerChatGptGatewayRoutes(
  app: FastifyInstance,
  gateway: ChatGptGateway,
  oauth: ChatGptOAuthService,
  hooks: ChatGptRouteHooks,
): void {
  // Keep OAuth's form parser and response protections scoped to this feature.
  void app.register(async (scopedApp) => registerGatewayRoutes(scopedApp, gateway, oauth, hooks));
}

function registerGatewayRoutes(
  app: FastifyInstance,
  gateway: ChatGptGateway,
  oauth: ChatGptOAuthService,
  hooks: ChatGptRouteHooks,
): void {
  const limiter = new OAuthRateLimiter();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('pragma', 'no-cache')
      .header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (request.url.startsWith('/oauth/chatgpt/')) {
      if (!validateOAuthOrigin(request, reply, oauth.issuer)) return reply;
      if (!limiter.allow(request)) return reply.code(429).header('retry-after', '60').send({ error: 'temporarily_unavailable' });
    }
  });
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      try {
        const params = new URLSearchParams(String(body));
        const result: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [key, value] of params) {
          if (Object.hasOwn(result, key)) throw new OAuthRequestError('invalid_request', 'OAuth parameters must occur exactly once.');
          result[key] = value;
        }
        done(null, result);
      } catch (error) {
        done(error as Error);
      }
    });
  }

  app.get('/.well-known/oauth-authorization-server', async () => oauth.authorizationServerMetadata());
  app.get('/.well-known/oauth-authorization-server/*', async () => oauth.authorizationServerMetadata());
  app.get<{ Params: { workerId: string } }>('/.well-known/oauth-protected-resource/mcp/chatgpt/:workerId', async (request, reply) => {
    try {
      if (!gateway.registry.get(request.params.workerId)) return reply.code(404).send({ error: 'worker_not_found' });
    } catch { return reply.code(404).send({ error: 'worker_not_found' }); }
    return oauth.protectedResourceMetadata(request.params.workerId);
  });

  app.post('/oauth/chatgpt/register', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try {
      const client = oauth.registerClient(request.body);
      hooks.audit({ type: 'chatgpt.pairing.registered', requestId: request.id, details: { clientId: client.client_id } });
      return reply.code(201).send(client);
    } catch (error) {
      return sendOAuthError(reply, error);
    }
  });

  app.get('/oauth/chatgpt/authorize', async (request, reply) => {
    if (!hooks.isAdmin(request)) {
      // Never redirect to a caller-supplied location: the dashboard accepts only
      // this exact local OAuth path and continues after its normal login flow.
      const query = request.url.split('?')[1] ?? '';
      if (Buffer.byteLength(query, 'utf8') > 8192) return reply.code(400).send({ error: 'invalid_request' });
      return reply.redirect(`/?chatgpt_authorize=${encodeURIComponent(`/oauth/chatgpt/authorize?${query}`)}`, 303);
    }
    try {
      const result = oauth.beginAuthorization(request.query as Record<string, unknown>);
      const worker = gateway.registry.get(result.request.workerId);
      if (!worker) return reply.code(400).send({ error: 'invalid_target' });
      // no-referrer can make browser form POSTs send Origin:null. Preserve
      // same-origin CSRF checks without disclosing the consent URL externally.
      reply.header('referrer-policy', 'same-origin');
      reply.header('content-security-policy', consentContentSecurityPolicy(result.request.redirectUri));
      return reply.type('text/html; charset=utf-8').send(renderConsent({
        requestId: result.request.id,
        requestCsrfToken: result.csrfToken,
        sessionCsrfToken: hooks.adminCsrf(request) ?? '',
        workerLabel: worker.label,
        workerId: worker.id,
        resource: result.request.resource,
        clientId: result.request.clientId,
        redirectUri: result.request.redirectUri,
        scope: result.request.scope,
      }));
    } catch (error) {
      return sendOAuthError(reply, error);
    }
  });

  app.post('/oauth/chatgpt/authorize', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const body = asRecord(request.body);
    const requestCsrf = String(body.request_csrf_token ?? '');
    const sessionCsrf = String(body.session_csrf_token ?? '');
    if (!hooks.ensureAdminMutation(request, reply, sessionCsrf)) return reply;
    if (body.decision !== 'approve' && body.decision !== 'deny') return reply.code(400).send({ error: 'invalid_request' });
    try {
      const callback = body.decision === 'approve'
        ? oauth.approveAuthorization(String(body.request_id ?? ''), requestCsrf)
        : oauth.denyAuthorization(String(body.request_id ?? ''), requestCsrf);
      hooks.audit({ type: body.decision === 'approve' ? 'chatgpt.pairing.approved' : 'chatgpt.pairing.denied', requestId: request.id });
      reply.header('referrer-policy', 'same-origin');
      reply.header('content-security-policy', consentContentSecurityPolicy(callback));
      return reply.redirect(callback, 303);
    } catch (error) {
      return sendOAuthError(reply, error);
    }
  });

  app.post('/oauth/chatgpt/token', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return oauth.exchangeToken(request.body);
    } catch (error) {
      return sendOAuthError(reply, error);
    }
  });

  app.post('/oauth/chatgpt/revoke', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    oauth.revokeToken(request.body);
    return reply.code(200).send();
  });

  app.get('/admin/chatgpt', async (request, reply) => {
    if (!hooks.ensureAdmin(request, reply)) return reply;
    return adminSnapshot(gateway, oauth, hooks, request);
  });

  app.post('/admin/chatgpt/workers', async (request, reply) => {
    if (!hooks.ensureAdminMutation(request, reply)) return reply;
    try {
      validateAllowedAppIds(request.body, hooks.appIds());
      const worker = gateway.registry.create(request.body);
      hooks.audit({ type: 'chatgpt.worker.created', requestId: request.id, workerId: worker.id });
      return reply.code(201).send({ ok: true, worker });
    } catch (error) {
      return adminError(reply, error);
    }
  });

  app.put<{ Params: { workerId: string } }>('/admin/chatgpt/workers/:workerId', async (request, reply) => {
    if (!hooks.ensureAdminMutation(request, reply)) return reply;
    try {
      validateAllowedAppIds(request.body, hooks.appIds());
      const worker = gateway.registry.update(request.params.workerId, request.body);
      hooks.audit({ type: 'chatgpt.worker.updated', requestId: request.id, workerId: worker.id });
      return { ok: true, worker };
    } catch (error) {
      return adminError(reply, error);
    }
  });

  app.delete<{ Params: { workerId: string } }>('/admin/chatgpt/workers/:workerId', async (request, reply) => {
    if (!hooks.ensureAdminMutation(request, reply)) return reply;
    try {
      gateway.registry.remove(request.params.workerId);
      hooks.audit({ type: 'chatgpt.worker.removed', requestId: request.id, workerId: request.params.workerId });
      return { ok: true };
    } catch (error) {
      return adminError(reply, error);
    }
  });

  app.post<{ Params: { workerId: string } }>('/admin/chatgpt/workers/:workerId/pairing', async (request, reply) => {
    if (!hooks.ensureAdminMutation(request, reply)) return reply;
    try {
      const worker = gateway.registry.get(request.params.workerId);
      if (!worker) return reply.code(404).send({ error: 'worker_not_found' });
      const pairing = gateway.store.openPairingWindow(worker.id);
      const openId = `open_${randomBytes(18).toString('base64url')}`;
      hooks.audit({ type: 'chatgpt.pairing.opened', requestId: request.id, workerId: worker.id });
      return {
        ok: true,
        workerId: worker.id,
        mcpUrl: oauth.workerResource(worker.id),
        expiresAt: pairing.expiresAt,
        openId,
        workerPrompt: buildWorkerPrompt(worker, openId),
      };
    } catch (error) {
      return adminError(reply, error);
    }
  });

  app.post<{ Params: { workerId: string } }>('/admin/chatgpt/workers/:workerId/prompt', async (request, reply) => {
    if (!hooks.ensureAdminMutation(request, reply)) return reply;
    try {
      const worker = gateway.registry.get(request.params.workerId);
      if (!worker) return reply.code(404).send({ error: 'worker_not_found' });
      const openId = `open_${randomBytes(18).toString('base64url')}`;
      return { ok: true, workerId: worker.id, mcpUrl: oauth.workerResource(worker.id), openId, workerPrompt: buildWorkerPrompt(worker, openId) };
    } catch (error) { return adminError(reply, error); }
  });

  app.post<{ Params: { workerId: string } }>('/admin/chatgpt/workers/:workerId/drain', async (request, reply) => {
    if (!hooks.ensureAdminMutation(request, reply)) return reply;
    try {
      gateway.store.drainWorker(request.params.workerId);
      hooks.audit({ type: 'chatgpt.run.drained', requestId: request.id, workerId: request.params.workerId });
      return { ok: true, status: gateway.store.workerStatus(request.params.workerId) };
    } catch (error) {
      return adminError(reply, error);
    }
  });

  app.post<{ Params: { workerId: string }; Body: { reason?: string } }>('/admin/chatgpt/workers/:workerId/release', async (request, reply) => {
    if (!hooks.ensureAdminMutation(request, reply)) return reply;
    try {
      gateway.store.releaseWorker(request.params.workerId, safeReason(request.body?.reason));
      hooks.audit({ type: 'chatgpt.run.released', requestId: request.id, workerId: request.params.workerId });
      return { ok: true, status: gateway.store.workerStatus(request.params.workerId) };
    } catch (error) {
      return adminError(reply, error);
    }
  });

  app.post<{ Params: { grantId: string } }>('/admin/chatgpt/grants/:grantId/revoke', async (request, reply) => {
    if (!hooks.ensureAdminMutation(request, reply)) return reply;
    gateway.store.revokeGrant(request.params.grantId);
    hooks.audit({ type: 'chatgpt.pairing.revoked', requestId: request.id, details: { grantId: request.params.grantId } });
    return { ok: true };
  });

  registerChatGptMcpTransport(app, gateway, oauth);
}

function adminSnapshot(gateway: ChatGptGateway, oauth: ChatGptOAuthService, hooks: ChatGptRouteHooks, request: FastifyRequest) {
  return {
    ok: true,
    enabled: true,
    publicBaseUrl: oauth.issuer,
    profile: gateway.store.config.profile,
    usage: 'unavailable',
    streaming: 'buffered',
    contextMode: 'persistent_chat',
    modelVerification: 'operator_declared',
    csrfToken: hooks.adminCsrf(request),
    availableAppIds: hooks.appIds(),
    workers: gateway.registry.list().map((worker) => ({
      ...worker,
      mcpUrl: oauth.workerResource(worker.id),
      status: gateway.store.workerStatus(worker.id),
    })),
    grants: gateway.store.listGrants(),
    authorizationRequests: gateway.store.listAuthorizationRequests(),
  };
}

function renderConsent(input: {
  requestId: string;
  requestCsrfToken: string;
  sessionCsrfToken: string;
  workerLabel: string;
  workerId: string;
  resource: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Collega ChatGPT · GemRouter</title><style>body{font:16px/1.6 system-ui;max-width:720px;margin:48px auto;padding:0 20px;background:#101218;color:#eee}.card{padding:28px;border:1px solid #343947;border-radius:20px;background:#181b23}h1{line-height:1.2}dt{font-weight:700}dd{margin:0 0 12px;overflow-wrap:anywhere}button{padding:12px 18px;border:1px solid #8074ff;border-radius:10px;background:#6d5dfc;color:white;font:inherit;font-weight:700;cursor:pointer}button:focus-visible{outline:3px solid #b3caff;outline-offset:4px}.secondary{background:transparent;border-color:#687084}form{display:flex;gap:12px;flex-wrap:wrap}summary{cursor:pointer}small{color:#b9c1d1}</style></head><body><main class="card"><small>GEMROUTER · COLLEGAMENTO PROTETTO</small><h1>Collega la tua chat a ${escapeHtml(input.workerLabel)}</h1><p>ChatGPT potrà ricevere e completare le richieste delle applicazioni autorizzate per questo worker. Non avrà accesso alla gestione di GemRouter o agli altri worker.</p><p>Conferma solo se hai appena avviato il collegamento dall’area riservata. Un nuovo consenso sostituisce il collegamento precedente e interrompe le richieste ancora attive.</p><dl><dt>Worker selezionato</dt><dd>${escapeHtml(input.workerLabel)} (${escapeHtml(input.workerId)})</dd></dl><details><summary>Dettagli del collegamento</summary><dl><dt>Risorsa</dt><dd>${escapeHtml(input.resource)}</dd><dt>Client</dt><dd>${escapeHtml(input.clientId)}</dd><dt>Indirizzo di ritorno registrato</dt><dd>${escapeHtml(input.redirectUri)}</dd><dt>Permessi</dt><dd>${escapeHtml(input.scope)}</dd></dl></details><p>Dopo la conferma tornerai a ChatGPT. Potrai revocare il collegamento in qualsiasi momento dall’area riservata.</p><form method="post" action="/oauth/chatgpt/authorize"><input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}"><input type="hidden" name="request_csrf_token" value="${escapeHtml(input.requestCsrfToken)}"><input type="hidden" name="session_csrf_token" value="${escapeHtml(input.sessionCsrfToken)}"><button type="submit" name="decision" value="approve">Conferma collegamento</button><button class="secondary" type="submit" name="decision" value="deny">Annulla</button></form></main></body></html>`;
}

function sendOAuthError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof OAuthRequestError) {
    return reply.code(error.statusCode).send({ error: error.errorCode, error_description: error.message });
  }
  const known = error instanceof Error ? error.message : '';
  if (['invalid_consent', 'invalid_client', 'invalid_refresh_token', 'grant_revoked'].includes(known)) {
    return reply.code(400).send({ error: known === 'invalid_client' ? known : 'invalid_grant', error_description: 'Authorization is invalid or expired. Restart the connection from the dashboard.' });
  }
  if (known === 'OAuth client registration capacity reached.' || known === 'Pending OAuth authorization capacity reached.') {
    return reply.code(429).header('retry-after', '60').send({ error: 'temporarily_unavailable' });
  }
  return reply.code(400).send({ error: 'invalid_request', error_description: 'The OAuth request could not be completed. Restart the connection from the dashboard.' });
}

function adminError(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : 'chatgpt_admin_error';
  const status = /not found/iu.test(message) ? 404 : /already|collides|duplicate/iu.test(message) ? 409 : 400;
  return reply.code(status).send({ error: { code: 'chatgpt_admin_error', type: 'invalid_request_error', message } });
}

function safeReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Worker released by administrator';
  return value.replace(/[\0\r\n]/gu, ' ').slice(0, 500);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validateAllowedAppIds(value: unknown, available: string[]): void {
  const record = asRecord(value);
  if (record.allowedAppIds === undefined) return;
  if (!Array.isArray(record.allowedAppIds)) throw new Error('allowedAppIds must be an array');
  const allowed = new Set(available);
  const unknown = record.allowedAppIds.map(String).filter((appId) => !allowed.has(appId));
  if (unknown.length > 0) throw new Error(`Unknown or revoked app IDs: ${unknown.join(', ')}`);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

function validateOAuthOrigin(request: FastifyRequest, reply: FastifyReply, issuer: string): boolean {
  const expected = new URL(issuer);
  if (request.headers.host?.toLowerCase() !== expected.host.toLowerCase()) {
    reply.code(421).send({ error: 'misdirected_request' });
    return false;
  }
  if (request.method !== 'GET' && request.headers.origin !== undefined && request.headers.origin !== issuer) {
    reply.code(403).send({ error: 'origin_not_allowed' });
    return false;
  }
  return true;
}

function consentContentSecurityPolicy(callback: string): string {
  // Browsers can enforce form-action on the POST's cross-origin 303 redirect.
  // Permit only this consent's exact registered callback origin, never a wildcard.
  const callbackOrigin = new URL(callback).origin;
  return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`;
}

/** Bounded, process-local abuse protection; persisted record caps are enforced by the store. */
class OAuthRateLimiter {
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();

  allow(request: FastifyRequest): boolean {
    const now = Date.now();
    for (const [key, window] of this.windows) if (window.expiresAt <= now) this.windows.delete(key);
    const registration = request.url.split('?')[0] === '/oauth/chatgpt/register';
    const category = registration ? 'register' : 'oauth';
    // Socket peer is deliberately used instead of caller-controlled forwarded IPs.
    const keys: Array<[string, number]> = [[`global:${category}`, registration ? 64 : 512], [`${category}:${request.raw.socket.remoteAddress ?? 'unknown'}`, registration ? 16 : 120]];
    if (this.windows.size > 2048) return false;
    if (keys.some(([key, limit]) => (this.windows.get(key)?.count ?? 0) >= limit)) return false;
    for (const [key] of keys) {
      const current = this.windows.get(key) ?? { count: 0, expiresAt: now + 60_000 };
      current.count += 1;
      this.windows.set(key, current);
    }
    return true;
  }
}
