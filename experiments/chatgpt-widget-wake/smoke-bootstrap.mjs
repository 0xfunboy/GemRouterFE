// SIMULATED UI bootstrap regression only. Uses the checkout's existing test
// dependency, an ephemeral unauthenticated browser and NO network access.
// Not a runtime controller and not evidence about the real ChatGPT host.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const html = await readFile(new URL('./build/card.html', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.PROBE_TEST_CHROME ?? '/usr/bin/google-chrome', headless: true });
const outcomes = [];
async function run(name, capabilities, mode, verify) {
  const context = await browser.newContext();
  const errors = [], network = [];
  await context.route('**/*', route => { network.push(route.request().url()); return route.abort(); });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  const override = `<script>Object.defineProperty(crypto, 'randomUUID', {value: undefined});
    ${mode === 'no-rng' ? "Object.defineProperty(crypto, 'getRandomValues', {value: undefined});" : ''}
    window.__aliasCalls = 0;
    ${mode === 'arming-fixture' ? `
    window.__baselineVerified = false; window.__apiPaths = [];
    window.openai = { sendFollowUpMessage: async () => { window.__aliasCalls++; return {}; } };
    window.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname; window.__apiPaths.push(path);
      const json = value => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}});
      if (path.endsWith('/enroll')) return json({token:'SIMULATED-capability',sessionId:'SIMULATED-session',
        remainingEventMs:60000,remainingSessionMs:86400000,expiresAt:'2030-01-02T00:00:00.000Z',
        manualEvent:{eventId:'probe_'+'a'.repeat(24),kind:'status-probe',emittedAt:'2030-01-01T00:00:00.000Z',expiresAt:'2030-01-01T00:01:00.000Z'},
        promptTemplate:'SIMULATED manual EVENT_ID'});
      if (path.endsWith('/receipt') || path.endsWith('/stop')) return json({recorded:true});
      if (path.endsWith('/readiness')) return json({baselineVerified:window.__baselineVerified});
      if (path.endsWith('/events')) return new Response(new ReadableStream({start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ready\\ndata: {}\\n\\n'));
        options.signal.addEventListener('abort', () => controller.close(), {once:true});
      }}), {headers:{'Content-Type':'text/event-stream'}});
      throw new Error('Unexpected SIMULATED request');
    };` : ''}
    </script>`;
  const srcdoc = (override + html).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const host = `<script>
    window.__methods = [];
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
      window.__methods.push(msg.method);
      if (msg.method === 'ui/initialize') event.source.postMessage(${mode === 'reject'
        ? "{jsonrpc:'2.0', id:msg.id, error:{code:-32601,message:'SIMULATED unsupported'}}"
        : `{jsonrpc:'2.0',id:msg.id,result:{protocolVersion:msg.params.protocolVersion,
          hostInfo:{name:'SIMULATED',version:'1'},hostCapabilities:${JSON.stringify(capabilities)},hostContext:{}}}`}, '*');
    });
    </script><iframe id="probe" sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe>`;
  try {
    await page.setContent(host);
    const frame = page.frameLocator('#probe');
    await verify(frame, page);
    assert.deepEqual(errors, [], 'No uncaught bootstrap errors');
    assert.deepEqual(network, [], 'No actual network request is allowed in this simulated regression');
    const methods = await page.evaluate(() => window.__methods);
    assert.ok(!methods.some(method => ['ui/message', 'tools/call', 'sampling/createMessage'].includes(method)), 'Detection never sends a message or calls a tool');
    assert.equal(await frame.locator('body').evaluate(() => window.__aliasCalls), mode === 'arming-fixture' ? 1 : 0);
    outcomes.push({ name, result: 'PASS', scope: 'SIMULATED; no ChatGPT account, no model turn' });
  } finally { await context.close(); }
}
try {
  await run('missing randomUUID: declared standard initializes', { message: { text: {} } }, 'ok', async frame => {
    await frame.locator('#diagnostics').filter({ hasText: 'initialize: riuscita' }).waitFor();
    assert.equal(await frame.locator('#enroll').isDisabled(), false);
    assert.equal(await frame.locator('#method').inputValue(), 'ui/message');
    await frame.locator('#recheck').click();
  });
  await run('legacy host: optional message capability omitted, manual baseline permitted', {}, 'ok', async frame => {
    await frame.locator('#diagnostics').filter({ hasText: 'initialize: riuscita' }).waitFor();
    assert.equal(await frame.locator('#enroll').isDisabled(), false);
    assert.match(await frame.locator('#capabilities').textContent(), /non dichiarata.*verifica manuale/);
  });
  await run('explicitly missing text modality stays disabled', { message: {} }, 'ok', async frame => {
    await frame.locator('#diagnostics').filter({ hasText: 'initialize: riuscita' }).waitFor();
    assert.equal(await frame.locator('#enroll').isDisabled(), true);
  });
  await run('late compatibility alias is detected; Stop cannot be undone', {}, 'reject', async frame => {
    await frame.locator('#diagnostics').filter({ hasText: 'initialize: non riuscita' }).waitFor();
    assert.equal(await frame.locator('#enroll').isDisabled(), true);
    await frame.locator('body').evaluate(() => {
      window.openai = { sendFollowUpMessage: async () => { window.__aliasCalls++; } };
      window.dispatchEvent(new Event('openai:set_globals'));
    });
    assert.equal(await frame.locator('#enroll').isDisabled(), false);
    assert.equal(await frame.locator('#method').inputValue(), 'openai.sendFollowUpMessage');
    await frame.locator('#stop').click();
    await frame.locator('body').evaluate(() => window.dispatchEvent(new Event('openai:set_globals')));
    assert.equal(await frame.locator('#enroll').isDisabled(), true);
  });
  await run('no CSPRNG: visible error, no insecure identifier fallback', {}, 'no-rng', async frame => {
    await frame.locator('#capabilities').filter({ hasText: 'secure_random_unavailable' }).waitFor();
    assert.equal(await frame.locator('#enroll').isDisabled(), true);
  });
  await run('early arm is non-terminal; verified baseline later connects once without another bridge send', {}, 'arming-fixture', async frame => {
    await frame.locator('#diagnostics').filter({ hasText: 'initialize: riuscita' }).waitFor();
    await frame.locator('#code').fill('A'.repeat(43));
    await frame.locator('#enroll').click();
    await frame.locator('#manual').click();
    await frame.locator('#status').filter({ hasText: 'bridge accepted' }).waitFor();
    await frame.locator('#arm').click();
    await frame.locator('#connection').filter({ hasText: 'Sessione ancora valida' }).waitFor();
    assert.equal(await frame.locator('#arm').isDisabled(), false);
    assert.equal(await frame.locator('#manual').isDisabled(), true);
    const pathsBefore = await frame.locator('body').evaluate(() => window.__apiPaths);
    assert.ok(!pathsBefore.some(path => path.endsWith('/events') || path.endsWith('/stop')));
    // Simulate ONLY the operator's preflight result, never a real model trace.
    await frame.locator('body').evaluate(() => { window.__baselineVerified = true; });
    await frame.locator('#arm').click();
    await frame.locator('#connection').filter({ hasText: 'Armato, SSE connesso' }).waitFor();
    assert.equal(await frame.locator('#arm').isDisabled(), true);
    const pathsAfter = await frame.locator('body').evaluate(() => window.__apiPaths);
    assert.equal(pathsAfter.filter(path => path.endsWith('/events')).length, 1);
    assert.equal(pathsAfter.filter(path => path.endsWith('/readiness')).length, 2);
    await frame.locator('#stop').click();
    assert.equal(await frame.locator('#arm').isDisabled(), true);
  });
  console.log(JSON.stringify({ scope: 'SIMULATED bootstrap regression; no live wake verification', outcomes }, null, 2));
} finally { await browser.close(); }
