import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodexConfig } from '../src/codex/config.js';
import { verifyClientSlotRecovery } from './smoke-client-slots.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Separate data directory and ephemeral port. Never loads .env or the live DB. */
export async function smokeCodex(options: { live?: boolean; ui?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemrouter-codex-smoke-'));
  const appRoot = path.join(dir, 'router');
  const adminKey = randomBytes(32).toString('hex'), clientKey = randomBytes(32).toString('hex');
  const config = readCodexConfig();
  const fixture = path.join(dir, 'codex-fixture');
  await copyFile(path.join(root, 'tests/helpers/codex-stdio-fixture.mjs'), fixture); await chmod(fixture, 0o700);
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src/index.ts')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, DOTENV_CONFIG_PATH: path.join(dir, 'no-env-file'), HOST: '127.0.0.1', PORT: '0',
      GEMROUTER_ROOT_DIR: appRoot, GEMROUTER_DATA_DIR: path.join(appRoot, 'data'),
      GEMROUTER_ADMIN_TOKEN: adminKey, GEMROUTER_BOOTSTRAP_API_KEY: clientKey,
      GEMROUTER_CODEX_ENABLED: 'true', GEMROUTER_CODEX_COMMAND: options.live ? config.command : fixture,
      GEMROUTER_CODEX_PRIVATE_DIR: options.live ? config.privateDirectory : path.join(dir, 'private'),
      GEMROUTER_CODEX_TIMEOUT_MS: '120000', GEMROUTER_CODEX_QUOTA_REFRESH_MS: '300000',
      GEMROUTER_BOOTSTRAP_RATE_LIMIT_PER_MINUTE: '0', GEMROUTER_BOOTSTRAP_MAX_CONCURRENCY: '2',
      GEMROUTER_BOOTSTRAP_CONCURRENCY_WAIT_MS: '500',
    },
  });
  let browser: any; let stderr = '';
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let stdout = ''; const timer = setTimeout(() => reject(Error('Isolated startup timeout')), 45000);
      child.stdout.on('data', (data) => { stdout += data; const found = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (found) { clearTimeout(timer); resolve(found[1]); } });
      child.once('exit', () => { clearTimeout(timer); reject(Error('Isolated server exited: ' + stderr)); });
    });
    const call = (route: string, key: string | null, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(origin + route, {
      method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(130000),
    });
    assert.equal((await call('/admin/codex/account', null)).status, 401);
    const publicHealth = await (await call('/health', null)).text(); assert.equal(publicHealth.includes('fixture@example.test'), false);
    const request = { model: 'gpt-5.6-luna', reasoning_effort: 'low', messages: [{ role: 'user', content: 'Reply exactly CODEX_PROVIDER_OK.' }] };
    assert.equal((await call('/v1/chat/completions', clientKey, 'POST', request)).status, 403);
    const create = await call('/admin/apps', adminKey, 'POST', { name: 'isolated-codex-test', modelAccess: 'custom', allowedModels: ['gpt-5.6-luna', 'gemini-3.8-flash'],
      codexEnabled: true, codexReasoningEffort: 'low', codexFallbackEnabled: false, allowedOrigins: ['*'], rateLimitPerMinute: 0, maxConcurrency: 2 });
    assert.equal(create.status, 201, await create.clone().text()); const created = await create.json() as any;
    assert.equal(created.app.codexEnabled, true);
    if (!options.live) await verifyClientSlotRecovery(call, adminKey);
    const models = await (await call('/v1/models', created.apiKey)).json() as any;
    assert(models.data.some((m: any) => m.id === request.model), 'Account Codex model absent from authorized catalog');
    const providerRuntime = await (await call('/v1/provider/runtime', created.apiKey)).json() as any;
    assert.equal(providerRuntime.backends.codex, undefined, 'Account-wide quota is admin-only');
    assert(providerRuntime.provider.models.some((m: any) => m.id === request.model));
    const started = Date.now();
    const completion = await call('/v1/chat/completions', created.apiKey, 'POST', request);
    assert.equal(completion.status, 200, await completion.clone().text());
    const answer = await completion.json() as any;
    assert.equal(completion.headers.get('x-gemrouter-backend'), 'codex'); assert.equal(answer.model, request.model);
    assert.equal(answer.choices[0].message.content.trim(), 'CODEX_PROVIDER_OK'); assert(answer.usage.total_tokens > 0);
    const result = { liveCodex: options.live === true, isolatedHttp: true, model: answer.model, elapsedMs: Date.now()-started, usage: answer.usage, ui: false };
    if (!options.live) {
      assert.equal(answer.usage.total_tokens, 120);
      for (const route of ['/v1/chat/completions', '/chat/completions']) {
        const stream = await call(route, created.apiKey, 'POST', { ...request, stream: true, stream_options: { include_usage: true } });
        assert.equal(stream.status, 200); assert.equal(stream.headers.get('x-gemrouter-stream-mode'), 'buffered');
        const content = await stream.text(); assert.match(content, /CODEX_PROVIDER_OK/); assert.match(content, /"total_tokens":120/); assert.match(content, /\[DONE\]/);
      }
      for (const stream of [false, true]) {
        const response = await call('/v1/responses', created.apiKey, 'POST', { model: request.model, input: 'test', reasoning: { effort: 'low' }, stream });
        assert.equal(response.status, 200); assert.match(await response.text(), /CODEX_PROVIDER_OK/);
        const ollama = await call('/api/chat', created.apiKey, 'POST', { ...request, stream });
        assert.equal(ollama.status, 200); assert.match(await ollama.text(), /CODEX_PROVIDER_OK/);
      }
      assert.equal((await call('/v1/chat/completions', created.apiKey, 'POST', { ...request, reasoning_effort: 'ultra' })).status, 400);
      assert.equal((await call('/v1/chat/completions', created.apiKey, 'POST', { ...request, model: 'gpt-missing' })).status, 404);
      const login = await call('/auth/login', null, 'POST', { username: 'admin', password: adminKey });
      assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const me = await (await call('/auth/me', null, 'GET', undefined, { cookie })).json() as any;
      assert(me.csrfToken);
      assert.equal((await call('/admin/codex/account/refresh', null, 'POST', {}, { cookie })).status, 403);
      assert.equal((await call('/v1/admin/backup/import', null, 'POST', {}, { cookie })).status, 403);
      assert.equal((await call('/admin/codex/account/refresh', null, 'POST', {}, { cookie, 'x-gemrouter-csrf': me.csrfToken, origin })).status, 200);
      assert.equal((await call('/admin/codex/account/refresh', null, 'POST', {}, { cookie, 'x-gemrouter-csrf': me.csrfToken, origin: 'https://evil.test' })).status, 403);
      if (options.ui) {
        const { chromium } = await import('playwright-core');
        browser = await chromium.launch({ executablePath: process.env.GEMROUTER_TEST_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
        const context = await browser.newContext(); const page = await context.newPage(); const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=')+1), url: origin }]);
        await page.goto(origin); await page.locator('#admin-dashboard:not(.hidden)').waitFor();
        assert.equal(await page.locator('#codex-account-panel').isVisible(), false);
        await page.locator('[data-section-toggle="codex-account-panel"]').click();
        await page.getByRole('button', { name: 'Verify account', exact: true }).click();
        await page.getByText('Done. No inference started.', { exact:true }).waitFor();
        assert.match(await page.locator('#codex-account-provider').innerText(), /gpt-6-astra/);
        assert.equal(await page.locator('#codex-quota-rows tr').count(),3);
        assert.match(await page.locator('#codex-quota-rows').innerText(), /5 hour window/);
        assert.match(await page.locator('#codex-quota-rows').innerText(), /Weekly window/);
        assert.match(await page.locator('#codex-quota-rows [data-codex-reset-at]').first().innerText(), /\d+h \d+ min/);
        // Countdown ticks independently of quota HTTP refresh and never fabricates a reset.
        await page.locator('#codex-quota-rows [data-codex-reset-at]').first().evaluate((node) => {
          (node as HTMLElement).dataset.codexResetAt = String(Date.now() + 197 * 60_000);
        });
        await page.waitForFunction(() => document.querySelector('#codex-quota-rows [data-codex-reset-at]')?.textContent === '3h 17 min');
        await page.locator('#codex-quota-rows [data-codex-reset-at]').first().evaluate((node) => {
          (node as HTMLElement).dataset.codexResetAt = '1';
        });
        await page.waitForFunction(() => document.querySelector('#codex-quota-rows [data-codex-reset-at]')?.textContent?.includes('Reset due'));
        assert.equal((await page.locator('#codex-account-section').innerText()).includes('@'),false);
        await page.getByRole('button',{name:'Read account usage',exact:true}).click();
        await page.waitForFunction(()=>document.getElementById('codex-account-usage')?.textContent?.includes('Lifetime tokens: 1,000'));
        await page.getByRole('button',{name:'Add account',exact:true}).click();
        await page.locator('#codex-account-login-code').getByText('FAKE-CODE').waitFor();
        const loginLink = page.getByRole('link', { name: 'Open official login page' });
        assert.equal(await loginLink.getAttribute('href'), 'https://auth.openai.com/codex/device');
        assert.equal(await loginLink.evaluate((node) => getComputedStyle(node).textDecorationLine), 'underline');
        assert((await loginLink.boundingBox())!.height >= 44);
        await page.getByText('Login: completed',{exact:true}).waitFor();
        await page.waitForFunction(()=>document.getElementById('codex-account-state')?.textContent?.includes('Account 2 FX · Connected'));
        assert.equal(await page.locator('#codex-quota-rows tr').count(),6);
        await page.getByRole('button',{name:'Select account for routing',exact:true}).click();
        await page.getByText('Account selected for new requests. No login needed.',{exact:true}).waitFor();
        assert.equal((await (await call('/admin/codex/account',adminKey)).json() as any).selectedAccountId,'account-2');
        await page.locator('#codex-account-select').selectOption('account-1');
        await page.waitForFunction(()=>document.getElementById('codex-account-state')?.textContent?.startsWith('Account 1 FX'));
        await page.getByRole('button',{name:'Select account for routing',exact:true}).click();
        await page.getByText('Account selected for new requests. No login needed.',{exact:true}).waitFor();
        assert.equal((await (await call('/admin/codex/account',adminKey)).json() as any).selectedAccountId,'account-1');
        if (process.env.GEMROUTER_TEST_SCREENSHOT) await page.screenshot({path:process.env.GEMROUTER_TEST_SCREENSHOT,fullPage:true});
        const guest = await browser.newPage({viewport:{width:390,height:844}});
        await guest.goto(origin); await guest.locator('#codex-quota-rows tr').first().waitFor();
        await guest.waitForFunction(()=>document.querySelectorAll('#codex-quota-rows tr').length===6);
        assert.equal(await guest.locator('#codex-quota-section').isVisible(),true);
        assert.equal(await guest.locator('#codex-account-section').isVisible(),false);
        assert.equal((await guest.locator('body').innerText()).includes('fixture@example.test'),false);
        await guest.close();
        await page.locator('[data-section-toggle="apps-section-body"]').click();
        await page.locator('#app-form [name="name"]').fill('ui-codex-test');
        await page.locator('#app-form [name="codexEnabled"]').check();
        await page.locator('#app-form [name="codexReasoningEffort"]').selectOption('low');
        await page.locator('#allowed-models-all').check();
        await page.locator('#app-form button[type="submit"]').click();
        await page.waitForFunction(() => document.getElementById('app-status')?.textContent?.includes('ui-codex-test created'));
        assert.deepEqual(errors, []);
        const apps = await (await call('/admin/apps', adminKey)).json() as any;
        assert.equal(apps.data.find((a: any) => a.name === 'ui-codex-test').codexEnabled, true);
        result.ui = true;
      }
    }
    const stats = await (await call('/admin/codex/account', adminKey)).json() as any;
    assert(stats.provider.metrics.totals.succeeded >= 1); assert(stats.provider.metrics.totals.totalTokens >= answer.usage.total_tokens);
    return result;
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM'); await new Promise<void>((resolve) => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
    await rm(dir, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await smokeCodex({ live: process.argv.includes('--live'), ui: process.argv.includes('--ui') }), null, 2));
}
