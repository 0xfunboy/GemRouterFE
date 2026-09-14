import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';

import { renderAppShell } from '../src/ui.js';

describe('ChatGPT gateway dashboard integration', () => {
  it('renders the dedicated controls and keeps every inline script syntactically valid', () => {
    const html = renderAppShell({ projectName: 'GemRouter', modelIds: [], publicBaseUrl: 'http://127.0.0.1' });
    assert.match(html, /ChatGPT MCP Gateway/u);
    assert.match(html, /data-chatgpt-action="pair"/u);
    assert.match(html, /data-chatgpt-action="drain"/u);
    assert.match(html, /data-chatgpt-action="release"/u);
    assert.match(html, /data-chatgpt-grant/u);
    assert.match(html, /chatgpt-authorizations-table/u);
    assert.match(html, /name="domainLabel"/u);
    assert.match(html, /x-gemrouter-csrf/u);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]);
    assert.ok(scripts.length >= 2);
    scripts.forEach((script, index) => new vm.Script(script, { filename: `gemrouter-ui-${index}.js` }));
  });

  it('provides a gated accessible three-step wizard with honest connection status and safe recovery', () => {
    const html = renderAppShell({ projectName: 'GemRouter', modelIds: [], publicBaseUrl: 'https://gemr.airewardrop.xyz' });
    for (const id of ['chatgpt-wizard', 'chatgpt-wizard-form', 'chatgpt-wizard-panel-1', 'chatgpt-wizard-panel-2', 'chatgpt-wizard-panel-3', 'chatgpt-wizard-resume', 'chatgpt-wizard-url', 'chatgpt-wizard-prompt', 'chatgpt-wizard-disabled']) {
      assert.match(html, new RegExp(`id="${id}"`, 'u'));
    }
    assert.match(html, /<details id="chatgpt-advanced"/u);
    assert.match(html, /name="consent" type="checkbox" required/u);
    assert.match(html, /aria-label="Avanzamento collegamento"/u);
    assert.match(html, /aria-live="polite"/u);
    assert.match(html, /https:\/\/chatgpt\.com\/plugins/u);
    assert.match(html, /https:\/\/developers\.openai\.com\/plugins\/deploy\/connect-chatgpt/u);
    assert.match(html, /non verifica l'identità di ChatGPT/u);
    assert.match(html, /non cambia l'ambiente né riavvia la produzione/u);
    assert.match(html, /\/admin\/chatgpt\/onboarding/u);
    assert.match(html, /Riapri finestra scaduta/u);
    assert.match(html, /window\.confirm\('Drain worker/u);
    assert.match(html, /window\.confirm\('Release worker/u);
    const aliasPattern = html.match(/name="alias"[^>]*pattern="([^"]+)"/u)?.[1];
    assert.ok(aliasPattern);
    const browserPattern = new RegExp(`^(?:${aliasPattern})$`, 'v');
    assert.equal(browserPattern.test('chatgpt-personale'), true);
    assert.equal(browserPattern.test('not a valid alias'), false);
  });

  it('only continues login to an exact same-origin OAuth authorization path', () => {
    const html = renderAppShell({ projectName: 'GemRouter', modelIds: [] });
    const source = html.match(/function chatGptAuthorizationContinuation\(search, origin\) \{[\s\S]*?\n      \}/u)?.[0];
    assert.ok(source);
    const context = vm.createContext({ URL, URLSearchParams });
    vm.runInContext(source, context);
    const check = (value: string) => vm.runInContext(`chatGptAuthorizationContinuation(${JSON.stringify('?chatgpt_authorize=' + encodeURIComponent(value))}, 'https://gemr.airewardrop.xyz')`, context);
    assert.equal(check('/oauth/chatgpt/authorize?client_id=test&state=example'), '/oauth/chatgpt/authorize?client_id=test&state=example');
    for (const invalid of ['https://evil.invalid/oauth/chatgpt/authorize?x=1', '//evil.invalid/oauth/chatgpt/authorize?x=1', '/oauth/chatgpt/authorize/../token?x=1', '/oauth/chatgpt/authorize?x=1#fragment', '/auth/login?x=1', '/oauth/chatgpt/authorize']) {
      assert.equal(check(invalid), null, invalid);
    }
  });
});
