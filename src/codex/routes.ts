import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CodexRuntimeError, type CodexRuntimeClient } from './runtime.js';
import type { CodexProvider } from './provider.js';

export interface CodexRouteHooks {
  ensureAdmin(request: FastifyRequest, reply: FastifyReply): boolean;
  ensureAdminMutation(request: FastifyRequest, reply: FastifyReply): boolean;
  adminCsrf(request: FastifyRequest): string | null;
  audit(event: { type: string; requestId?: string; details?: Record<string, unknown> }): void;
}
export function registerCodexAccountRoutes(app: FastifyInstance, runtime: CodexRuntimeClient, hooks: CodexRouteHooks, provider?: CodexProvider): void {
  const owner = (request: FastifyRequest) => {
    const reference = hooks.adminCsrf(request) || request.headers.authorization;
    if (!reference) throw new CodexRuntimeError('codex_admin_session_required');
    return createHash('sha256').update(`codex-account-login:${reference}`).digest('hex');
  };
  void app.register(async (scoped) => {
    scoped.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store').header('pragma', 'no-cache').header('referrer-policy', 'no-referrer');
      if (!(request.method === 'GET' ? hooks.ensureAdmin(request, reply) : hooks.ensureAdminMutation(request, reply))) return reply;
    });
    scoped.setErrorHandler((error, request, reply) => {
      const code = error instanceof z.ZodError ? 'invalid_codex_request' : error instanceof CodexRuntimeError ? error.code : 'codex_account_failed';
      hooks.audit({ type: 'codex.account.failed', requestId: request.id, details: { reasonCode: code } });
      return reply.code(error instanceof z.ZodError ? 400 : 422).send({ error: code });
    });
    const empty = (body: unknown) => z.object({}).strict().parse(body ?? {});
    const snapshot = () => ({ account: runtime.cachedStatus(), inferenceEnabled: provider?.config.enabled ?? false, provider: provider?.getDiagnostics() ?? null });
    scoped.get('/admin/codex/account', async () => snapshot());
    scoped.post('/admin/codex/account/refresh', async (request) => {
      empty(request.body); if (provider) await provider.refresh(); else await runtime.status(); return snapshot();
    });
    scoped.post('/admin/codex/account/usage', async (request) => { empty(request.body); return runtime.usage(); });
    scoped.get('/admin/codex/account/login', async (request) => await runtime.loginStatus(owner(request)) ?? { status: 'not_started' });
    scoped.post('/admin/codex/account/login', async (request) => { empty(request.body); return runtime.startLogin(owner(request), 'device'); });
    scoped.post('/admin/codex/account/login/cancel', async (request) => { empty(request.body); await runtime.cancelLogin(owner(request)); return { ok: true }; });
    scoped.post('/admin/codex/account/logout', async (request) => { empty(request.body); await runtime.logout(); provider?.invalidate(); return { ok: true }; });
  });
}
