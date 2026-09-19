import assert from 'node:assert/strict';

type Call = (route: string, key: string | null, method?: string, body?: unknown, extra?: Record<string, string>) => Promise<Response>;

/** Isolated HTTP regression, using the smoke server's fake upstream and private data. */
export async function verifyClientSlotRecovery(call: Call, adminKey: string) {
  const routes = ['/v1/chat/completions', '/chat/completions', '/v1/responses',
    '/v1/images/generations', '/images/generations', '/api/chat', '/api/generate'];
  const valid = { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'Reply exactly CODEX_PROVIDER_OK.' }] };
  // Independent apps and both supported concurrency limits: never rely on another
  // app's free slot or a process restart to make a poisoned app work again.
  for (const maxConcurrency of [1, 2]) {
    const response = await call('/admin/apps', adminKey, 'POST', {
      name: 'slot-recovery-' + maxConcurrency, modelAccess: 'custom',
      allowedModels: ['gpt-5.6-luna'], codexEnabled: true, codexReasoningEffort: 'low',
      codexFallbackEnabled: false, allowedOrigins: ['*'], rateLimitPerMinute: 0, maxConcurrency,
    });
    assert.equal(response.status, 201);
    const app = await response.json() as { app: { id: string }; apiKey: string };
    try {
      for (const route of routes) {
        for (let attempt = 0; attempt < maxConcurrency + 2; attempt++) {
          const invalid = await call(route, app.apiKey, 'POST', {});
          assert.equal(invalid.status, 400, `${route}: validation leaked a slot (limit ${maxConcurrency}, attempt ${attempt})`);
          await invalid.arrayBuffer();
        }
        const models = await call('/v1/models', app.apiKey);
        assert.equal(models.status, 200, `${route}: models blocked after invalid requests`);
        await models.arrayBuffer();
      }
      const mixed = await Promise.all(routes.map(route => call(route, app.apiKey, 'POST', {})));
      for (const invalid of mixed) { assert.equal(invalid.status, 400); await invalid.arrayBuffer(); }
      // Early model-policy rejection and ordinary provider errors also release.
      for (const model of ['gpt-missing', valid.model]) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const denied = await call('/v1/chat/completions', app.apiKey, 'POST', {
            ...valid, model, ...(model === valid.model ? { reasoning_effort: 'ultra' } : {}),
          });
          assert.equal(denied.status, model === valid.model ? 400 : 404);
          await denied.arrayBuffer();
        }
      }
      for (const stream of [false, true]) {
        const completion = await call('/v1/chat/completions', app.apiKey, 'POST', { ...valid, stream });
        assert.equal(completion.status, 200, 'Valid inference must still work after rejected requests');
        assert.match(await completion.text(), /CODEX_PROVIDER_OK/);
      }
      assert.equal((await call('/v1/models', app.apiKey)).status, 200);
    } finally {
      assert.equal((await call('/admin/apps/' + app.app.id + '/revoke', adminKey, 'POST', {})).status, 200);
      assert.equal((await call('/admin/apps/' + app.app.id, adminKey, 'DELETE')).status, 200);
    }
  }
}
