/** Isolated real-browser onboarding smoke. No production or ChatGPT account access. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';

const executablePath = process.env.GEMROUTER_BROWSER_EXECUTABLE || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!executablePath) throw new Error('Install Chrome/Chromium or set GEMROUTER_BROWSER_EXECUTABLE. No browser is downloaded automatically.');
const portServer = createServer();
await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const address = portServer.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'gemrouter-chatgpt-ui-'));
const adminToken = randomUUID();
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const child = spawn(process.execPath, [path.resolve('dist/index.js')], {
  cwd: temporaryRoot,
  env: {
    PATH: process.env.PATH,
    HOST: '127.0.0.1', PORT: String(address.port),
    GEMROUTER_ROOT_DIR: temporaryRoot,
    GEMROUTER_ADMIN_TOKEN: adminToken,
    GEMROUTER_BOOTSTRAP_API_KEY: randomUUID(),
    GEMROUTER_BOOTSTRAP_APP_NAME: 'Browser smoke app',
    GEMROUTER_BOOTSTRAP_MODEL_ACCESS: 'custom',
    GEMROUTER_CHATGPT_ENABLED: 'true',
    GEMROUTER_CHATGPT_PUBLIC_BASE_URL: baseUrl,
    GEMROUTER_CHATGPT_DATA_DIR: 'data/chatgpt-gateway',
    GEMROUTER_GEMINI_API_ENABLED: 'false', GEMROUTER_NVIDIA_ENABLED: 'false',
    GEMROUTER_NVIDIA_PROBE_ENABLED: 'false', GEMROUTER_AGNES_ENABLED: 'false',
    GEMROUTER_OLLAMA_ENABLED: 'false', GEMROUTER_OLLAMA_LOCAL_ENABLED: 'false',
    GEMROUTER_FREE_TIER_POLICY_ENABLED: 'false', GEMROUTER_BACKEND_ORDER: 'gemini-api',
  },
  stdio: 'ignore',
});
const pageErrors: string[] = [];
const errors: string[] = [];
let callbackReceived = false;
const callbackServer = createHttpServer((request, response) => {
  callbackReceived = Boolean(request.url?.startsWith('/browser-smoke-callback?'));
  response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  response.end('Local callback received.');
});
await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
const callbackAddress = callbackServer.address();
assert.ok(callbackAddress && typeof callbackAddress !== 'string');
const callbackOrigin = `http://127.0.0.1:${callbackAddress.port}`;
async function login(page: Page) {
  await page.locator('#login-form [name="username"]').fill('admin');
  await page.locator('#login-form [name="password"]').fill(adminToken);
  await page.locator('#login-form button[type="submit"]').click();
}
async function adminJson(route: string) {
  const response = await fetch(baseUrl + route, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(response.status, 200);
  return await response.json() as Record<string, any>;
}

try {
  const deadline = Date.now() + 15_000;
  while (true) {
    if (child.exitCode !== null) throw new Error('Isolated UI server exited before startup.');
    try { if ((await fetch(baseUrl + '/health')).ok) break; } catch { /* Still starting. */ }
    if (Date.now() > deadline) throw new Error('Isolated UI server did not start.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  context.setDefaultTimeout(15_000);
  // The browser is confined to this test server. Opening a real ChatGPT tab is
  // intentionally never part of this smoke.
  await context.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(baseUrl);
  process.stdout.write('Browser: guest page loaded; testing authenticated onboarding.\n');
  assert.equal(await page.locator('#chatgpt-wizard').isVisible(), false, 'Guest must not see the reserved wizard');
  await page.locator('#menu-toggle').click();
  await login(page);
  await page.locator('#chatgpt-wizard-form').waitFor({ state: 'visible' });
  await page.locator('#menu-toggle').click();
  await page.locator('#chatgpt-wizard').scrollIntoViewIfNeeded();
  if (process.env.GEMROUTER_UI_SCREENSHOT_DIR) await page.locator('#chatgpt-wizard').screenshot({ path: path.join(process.env.GEMROUTER_UI_SCREENSHOT_DIR, 'chatgpt-wizard-prepare-desktop.png'), style: '.site-header { visibility: hidden }' });
  assert.equal(await page.locator('#chatgpt-advanced').getAttribute('open'), null);
  await page.locator('#chatgpt-wizard-form [name="label"]').fill('Browser smoke chat');
  await page.locator('#chatgpt-wizard-form [name="alias"]').fill('chatgpt-browser-smoke');
  const summaryBefore = await adminJson('/admin/summary');
  const selectedApp = summaryBefore.apps[0];
  await page.locator('#chatgpt-wizard-form [name="appId"]').selectOption(selectedApp.id);
  await page.locator('#chatgpt-wizard-form [name="consent"]').check();
  await page.locator('#chatgpt-wizard-form button[type="submit"]').click();
  await page.waitForFunction(() => document.getElementById('chatgpt-wizard-status')?.textContent?.includes('Indirizzo pronto'));
  const gateway = await adminJson('/admin/chatgpt');
  assert.equal(gateway.workers.length, 1);
  const worker = gateway.workers[0];
  assert.equal(worker.enabled, true);
  assert.deepEqual(worker.allowedAppIds, [selectedApp.id]);
  const after = await adminJson('/admin/summary');
  assert.ok(after.apps.find((app: any) => app.id === selectedApp.id).allowedModels.includes('chatgpt-browser-smoke'));
  for (const model of selectedApp.allowedModels) assert.ok(after.apps[0].allowedModels.includes(model), 'Existing app permissions preserved');
  assert.equal(await page.locator('#chatgpt-wizard-next').isDisabled(), true, 'Cannot advance without an actual grant');
  assert.equal(await page.locator('#chatgpt-wizard-url').inputValue(), `${baseUrl}/mcp/chatgpt/${worker.id}`);

  // Real local OAuth registration, login continuation and consent. The callback
  // is simulated locally; no ChatGPT identity is implied by this grant.
  const redirectUri = callbackOrigin + '/browser-smoke-callback';
  const registration = await fetch(baseUrl + '/oauth/chatgpt/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Isolated browser simulator', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json() as { client_id: string };
  const verifier = randomUUID() + randomUUID();
  const authorizeUrl = baseUrl + '/oauth/chatgpt/authorize?' + new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    scope: 'mcp:tools offline_access', resource: worker.mcpUrl, state: randomUUID(),
  });
  const consentContext = await browser.newContext();
  consentContext.setDefaultTimeout(15_000);
  await consentContext.route('**/*', (route) => [baseUrl, callbackOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  const consentPage = await consentContext.newPage();
  consentPage.on('pageerror', (error) => pageErrors.push(error.message));
  await consentPage.goto(authorizeUrl);
  await consentPage.locator('#login-form').waitFor({ state: 'visible' });
  assert.equal(new URL(consentPage.url()).searchParams.has('chatgpt_authorize'), false, 'Continuation removed from browser history');
  await login(consentPage);
  await consentPage.waitForURL(baseUrl + '/oauth/chatgpt/authorize?**');
  const consentResponse = consentPage.waitForResponse((response) => response.url().startsWith(baseUrl + '/oauth/chatgpt/authorize') && response.request().method() === 'POST');
  await consentPage.locator('button[value="approve"]').click();
  const approved = await consentResponse;
  assert.equal(approved.status(), 303, 'Local OAuth consent must redirect successfully');
  await consentPage.waitForURL(callbackOrigin + '/browser-smoke-callback?**');
  assert.equal(callbackReceived, true, 'Browser follows approved cross-origin callback');
  await consentContext.close();
  await page.waitForFunction(() => !(document.getElementById('chatgpt-wizard-next') as HTMLButtonElement)?.disabled, undefined, { timeout: 12_000 });
  await page.locator('#chatgpt-wizard-next').click();
  await page.locator('#chatgpt-wizard-panel-3').waitFor({ state: 'visible' });
  assert.match(await page.locator('#chatgpt-wizard-contact').innerText(), /In attesa/u);
  assert.ok((await page.locator('#chatgpt-wizard-prompt').inputValue()).includes('gateway_open'));

  // Status-only simulation verifies honest state labels without falsely calling
  // this an end-to-end ChatGPT test. Backend onboarding and OAuth above are real.
  await page.route(baseUrl + '/admin/chatgpt', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.workers[0].status.state = 'polling';
    data.workers[0].status.lastExchangeAt = new Date().toISOString();
    await route.fulfill({ response, json: data });
  });
  await page.waitForFunction(() => document.getElementById('chatgpt-wizard-contact')?.textContent?.includes('sta attendendo richieste'), undefined, { timeout: 12_000 });
  const screenshots = process.env.GEMROUTER_UI_SCREENSHOT_DIR;
  if (screenshots) await page.locator('#chatgpt-wizard').screenshot({ path: path.join(screenshots, 'chatgpt-wizard-desktop.png'), style: '.site-header { visibility: hidden }' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#chatgpt-wizard').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#chatgpt-wizard').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'Wizard must not overflow on mobile');
  if (screenshots) await page.locator('#chatgpt-wizard').screenshot({ path: path.join(screenshots, 'chatgpt-wizard-mobile.png'), style: '.site-header { visibility: hidden }' });
  await page.reload();
  await page.locator('#chatgpt-wizard-panel-2').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#chatgpt-wizard-resume').inputValue(), worker.id, 'Selection resumes after reload');
  await page.locator('#chatgpt-wizard-next').click();
  await page.locator('#chatgpt-wizard-panel-3').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#chatgpt-wizard-prompt').inputValue()).includes('gateway_open'), 'Prompt-only resume endpoint works');
  assert.equal((await adminJson('/admin/chatgpt')).grants.filter((grant: any) => !grant.revokedAt).length, 1, 'Resume must preserve the approved grant');
  await page.locator('#chatgpt-wizard-panel-3 [data-chatgpt-wizard-new]').click();
  await page.locator('#chatgpt-wizard-panel-1').waitFor({ state: 'visible' });
  assert.ok(await page.locator('#chatgpt-wizard').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'Preparation form fits mobile width');
  if (screenshots) await page.locator('#chatgpt-wizard').screenshot({ path: path.join(screenshots, 'chatgpt-wizard-prepare-mobile.png'), style: '.site-header { visibility: hidden }' });
  // Read-only disabled-state simulation; no feature flags or processes changed.
  await page.unroute(baseUrl + '/admin/chatgpt');
  await page.route(baseUrl + '/admin/chatgpt', (route) => route.fulfill({ contentType: 'application/json', json: { enabled: false } }));
  await page.reload();
  await page.locator('#chatgpt-wizard-disabled').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#chatgpt-wizard-form').isVisible(), false);
  assert.match(await page.locator('#chatgpt-wizard-disabled').innerText(), /non cambia l'ambiente né riavvia/u);
  assert.deepEqual(pageErrors, [], 'No browser JavaScript errors');
  assert.deepEqual(errors, [], 'No browser console errors');
  process.stdout.write('Browser smoke passed: reserved onboarding, exact app permission, OAuth login/consent, gated progress, prompt resume, desktop/mobile layout. Worker polling was simulated; no live ChatGPT connection verified.\n');
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => callbackServer.close((error) => error ? reject(error) : resolve()));
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    await stopped;
    clearTimeout(force);
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
