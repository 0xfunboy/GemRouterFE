import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CodexRuntimeError } from './runtime.js';
import type { CodexAccounts } from './accounts.js';

export interface CodexRouteHooks {
  ensureAdmin(request: FastifyRequest, reply: FastifyReply): boolean;
  ensureAdminMutation(request: FastifyRequest, reply: FastifyReply): boolean;
  adminCsrf(request: FastifyRequest): string | null;
  audit(event: { type: string; requestId?: string; details?: Record<string, unknown> }): void;
}
export function registerCodexAccountRoutes(app: FastifyInstance, accounts: CodexAccounts, hooks: CodexRouteHooks): void {
  const owner = (request: FastifyRequest) => {
    const reference = hooks.adminCsrf(request) || request.headers.authorization;
    if (!reference) throw new CodexRuntimeError('codex_admin_session_required');
    return createHash('sha256').update(`codex-account-login:${reference}`).digest('hex');
  };
  const idSchema = z.object({ accountId: z.enum(['account-1', 'account-2']).optional() }).strict();
  const bodyId = (request: FastifyRequest) => idSchema.parse(request.body ?? {}).accountId;
  const queryId = (request: FastifyRequest) => idSchema.parse(request.query ?? {}).accountId;
  // Cached, deliberately minimal public projection. Never contacts upstream on guest traffic.
  app.get('/dashboard/codex-quota', async (_request, reply) => reply.header('cache-control', 'no-store').send(accounts.publicQuota()));
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
    scoped.get('/admin/codex/account', async (request) => accounts.snapshot(queryId(request)));
    scoped.post('/admin/codex/accounts', async (request, reply) => {
      z.object({}).strict().parse(request.body ?? {});
      const entry = accounts.add();
      hooks.audit({ type: 'codex.account.added', requestId: request.id, details: { accountId: entry.id } });
      return reply.code(201).send(accounts.snapshot(entry.id));
    });
    scoped.post('/admin/codex/account/select', async (request) => {
      const id = z.object({ accountId: z.enum(['account-1', 'account-2']) }).strict().parse(request.body).accountId;
      accounts.select(id);
      hooks.audit({ type: 'codex.account.selected', requestId: request.id, details: { accountId: id } });
      return accounts.snapshot(id);
    });
    scoped.post('/admin/codex/account/refresh', async (request) => {
      const id = bodyId(request); await accounts.entry(id).provider.refresh(); return accounts.snapshot(id);
    });
    scoped.post('/admin/codex/account/usage', async (request, reply) => reply.code(202).send(accounts.startUsage(bodyId(request))));
    scoped.get('/admin/codex/account/usage', async (request) => accounts.entry(queryId(request)).usage);
    scoped.get('/admin/codex/account/login', async (request) => await accounts.entry(queryId(request)).runtime.loginStatus(owner(request)) ?? { status: 'not_started' });
    scoped.post('/admin/codex/account/login', async (request) => accounts.manage(bodyId(request), async (e) => {
      if (e.runtime.cachedStatus().authenticated) throw new CodexRuntimeError('codex_account_already_connected');
      e.provider.invalidate(); return e.runtime.startLogin(owner(request), 'device');
    }));
    scoped.post('/admin/codex/account/login/cancel', async (request) => accounts.manage(bodyId(request), async (e) => {
      await e.runtime.cancelLogin(owner(request)); return { ok: true };
    }));
    scoped.post('/admin/codex/account/logout', async (request) => accounts.manage(bodyId(request), async (e) => {
      await e.runtime.logout(); e.provider.invalidate(); return { ok: true };
    }));
  });
}
