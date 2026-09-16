import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChatGptRouteHooks } from '../routes.js';
import { PersonalChatController, PersonalControlError, errorCode } from './controller.js';

const fields = {
  expectedAccountLabel: z.string().trim().min(1).max(160).regex(/^[^\r\n\0]+$/u),
  expectedConnectorLabel: z.string().trim().min(1).max(120).regex(/^[^\r\n\0]+$/u),
  operatorResourceConfirmed: z.literal(true),
};
const saveSchema = z.object({ ...fields, chatgptConversationUrl: z.string().max(512), expectedBindingVersion: z.number().int().min(0) }).strict();
const actionSchema = z.object({ confirm: z.literal(true), expectedBindingVersion: z.number().int().positive() }).strict();
const createSchema = z.object({ ...fields, confirm: z.literal(true) }).strict();
const emptySchema = z.object({}).strict();

/** All state-changing calls use existing admin auth + CSRF, never MCP worker OAuth. */
export function registerPersonalControlRoutes(app: FastifyInstance, control: PersonalChatController,
  hooks: Pick<ChatGptRouteHooks, 'ensureAdmin' | 'ensureAdminMutation' | 'adminCsrf' | 'audit'>): void {
  const owner = (request: FastifyRequest) => {
    // Bearer-admin requests are already authenticated by the host hook. Only a
    // one-way session reference crosses into the login lifecycle, never the secret.
    const reference = hooks.adminCsrf(request) || request.headers.authorization;
    if (!reference) throw new PersonalControlError('controller_admin_session_required');
    return createHash('sha256').update(`personal-controller-login:${reference}`).digest('hex');
  };
  void app.register(async (scoped) => {
    scoped.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store').header('pragma', 'no-cache').header('referrer-policy', 'no-referrer');
      if (!(request.method === 'GET' ? hooks.ensureAdmin(request, reply) : hooks.ensureAdminMutation(request, reply))) return reply;
    });
    scoped.setErrorHandler((error, request, reply) => {
      const code = error instanceof z.ZodError ? 'invalid_control_request' : errorCode(error);
      hooks.audit({ type: 'chatgpt.control.admin_failed', requestId: request.id, details: { reasonCode: code } });
      // Never return raw runtime errors, browser text, config paths or auth responses.
      return reply.code(error instanceof z.ZodError ? 400 : code === 'controller_busy' ? 409 : 422).send({ error: code });
    });
    scoped.get('/admin/chatgpt/control', async () => control.snapshot());
    scoped.get('/admin/chatgpt/control/runtime/login', async (request) =>
      await control.runtime.loginStatus(owner(request)) ?? { status: 'cancelled', mode: 'device', expiresAt: 0 });
    scoped.post('/admin/chatgpt/control/runtime/refresh', async (request) => { emptySchema.parse(request.body ?? {}); return { account: await control.runtime.status() }; });
    scoped.post('/admin/chatgpt/control/runtime/login', async (request) => {
      const body = z.object({ mode: z.enum(['device', 'browser']).default('device') }).strict().parse(request.body ?? {});
      control.stopAll();
      // Do not include device/login codes in audit events.
      return control.runtime.startLogin(owner(request), body.mode);
    });
    scoped.post('/admin/chatgpt/control/runtime/login/cancel', async (request) => { emptySchema.parse(request.body ?? {}); await control.runtime.cancelLogin(owner(request)); return { ok: true }; });
    scoped.post('/admin/chatgpt/control/runtime/logout', async (request) => {
      emptySchema.parse(request.body ?? {}); control.stopAll(); await control.runtime.logout();
      return { ok: true, message: 'Controllore Codex scollegato. Il grant MCP esistente non è stato modificato.' };
    });
    scoped.post('/admin/chatgpt/control/browser/login', async (request) => {
      emptySchema.parse(request.body ?? {});
      if (!control.config.enabled) throw new PersonalControlError('controller_disabled');
      return control.browser.launchLogin();
    });
    scoped.put<{ Params: { workerId: string } }>('/admin/chatgpt/control/bindings/:workerId', async (request) => {
      const { expectedBindingVersion, ...input } = saveSchema.parse(request.body);
      const binding = control.saveBinding(request.params.workerId, expectedBindingVersion, input);
      hooks.audit({ type: 'chatgpt.control.binding_saved', requestId: request.id, workerId: binding.workerId });
      return { binding };
    });
    scoped.post<{ Params: { workerId: string; action: string } }>('/admin/chatgpt/control/bindings/:workerId/:action', async (request) => {
      const { workerId, action } = request.params;
      if (action === 'create') {
        const { confirm: _confirm, ...input } = createSchema.parse(request.body);
        return control.create(workerId, input);
      }
      const { expectedBindingVersion } = actionSchema.parse(request.body);
      let result: unknown;
      if (action === 'arm') result = { binding: control.arm(workerId, expectedBindingVersion) };
      else if (action === 'disarm' || action === 'stop') result = { binding: control.stop(workerId, expectedBindingVersion) };
      else if (action === 'inspect') result = { evidence: await control.inspect(workerId, expectedBindingVersion) };
      else if (action === 'diagnostic' || action === 'resume' || action === 'bootstrap') result = await control.send(workerId, expectedBindingVersion, action);
      else throw new PersonalControlError('unknown_control_action');
      hooks.audit({ type: `chatgpt.control.admin_${action}`, requestId: request.id, workerId });
      return result;
    });
  });
}
