/** Real local Chromium, simulated accessible UI. No ChatGPT/account network. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { BrowserUiBridge, BrowserControlError, browserUiProfileSchema, canonicalPersonalChatUrl, type BrowserTargetBinding, type BrowserUiProfile } from '../src/llm/providers/chatgpt/control/browserBridge.js';

const TARGET = 'https://chatgpt.com/c/00000000-0000-0000-0000-b40c114d0582';
const OTHER = 'https://chatgpt.com/c/00000000-0000-0000-0000-bd5818c19cd9';
const CREATED = 'https://chatgpt.com/c/00000000-0000-0000-0000-61d61e666f07';
const binding: BrowserTargetBinding = {
  workerId: 'worker-fixture', chatgptConversationUrl: TARGET,
  expectedAccountLabel: 'Operator fixture', expectedConnectorLabel: 'Example - Trade',
  expectedMcpResource: 'https://gateway.invalid/mcp/chatgpt/worker-fixture', operatorResourceConfirmed: true,
};
const profile: BrowserUiProfile = {
  version: 1, operatorObservedAt: '2026-09-15T00:00:00.000Z',
  accountIdentity: { role: 'button', name: 'Account {account}' },
  personalMode: { role: 'tab', name: 'Chat', state: { attribute: 'aria-selected', value: 'true' } },
  selectedConnector: { role: 'checkbox', name: '{connector}', state: { attribute: 'aria-checked', value: 'true' } },
  composer: { role: 'textbox', name: 'Message' }, send: { role: 'button', name: 'Send' }, stop: { role: 'button', name: 'Stop' },
  userMessage: { role: 'article', name: 'You said:' },
  tools: { gateway_open: { role: 'button', name: 'gateway_open' }, gateway_exchange: { role: 'button', name: 'gateway_exchange' }, gateway_status: { role: 'button', name: 'gateway_status' } },
  statusResult: { role: 'region', name: 'gateway_status tool result' },
  writeApprovalIndicator: { role: 'button', name: 'Writes approved', state: { attribute: 'aria-pressed', value: 'true' } },
  newChat: { role: 'button', name: 'New chat' },
  selectConnectorPath: [{ role: 'button', name: 'Select {connector}' }],
};

function fixtureHtml(): string {
  return `<!doctype html><html><body>
  <button>Account Operator fixture</button><button role="tab" aria-selected="true">Chat</button>
  <div role="checkbox" aria-checked="true" aria-label="Example - Trade">Selected connector</div>
  <button>gateway_open</button><button>gateway_exchange</button><button>gateway_status</button>
  <button aria-pressed="true">Writes approved</button>
  <a aria-label="Selected connector resource" href="https://gateway.invalid/mcp/chatgpt/worker-fixture">Resource</a>
  <textarea aria-label="Message"></textarea><button id="send">Send</button>
  <button id="new">New chat</button><button id="select">Select Separate app</button>
  <div id="messages"></div>
  <script>
    window.sent = 0;
    document.getElementById('send').onclick = () => {
      window.sent++;
      const input = document.querySelector('textarea');
      if (window.ambiguous) { input.value = ''; return; }
      const article = document.createElement('article');
      article.setAttribute('aria-label', 'You said:'); article.textContent = input.value;
      document.getElementById('messages').append(article); input.value = '';
      if (location.pathname === '/') history.pushState({}, '', '${new URL(CREATED).pathname}');
      if (window.statusResult) {
        const result = document.createElement('div'); result.setAttribute('role', 'region');
        result.setAttribute('aria-label', 'gateway_status tool result');
        result.textContent = JSON.stringify({protocol_version: '1.0', workerId: window.statusResult});
        document.getElementById('messages').append(result);
      }
    };
    document.getElementById('new').onclick = () => {
      history.pushState({}, '', '/'); document.getElementById('messages').replaceChildren();
      document.querySelector('[role="checkbox"]').setAttribute('aria-checked', 'false');
    };
    document.getElementById('select').onclick = () => {
      const app = document.querySelector('[role="checkbox"]');
      app.setAttribute('aria-label', 'Separate app'); app.setAttribute('aria-checked', 'true');
    };
  </script></body></html>`;
}

function operation(id = 'wake-fixture-0001', duration = 4000) {
  const marker = `[GemRouter wake: ${id}]`;
  return { operationId: id, marker, prompt: `${marker}\nService-only bounded wake.`, deadlineAt: Date.now() + duration };
}
const code = (expected: string) => (error: unknown) => error instanceof BrowserControlError && error.code === expected;

describe('personal browser control identity/profile validation', () => {
  it('keeps exact personal identity, rejects SSRF/lookalikes and never maps a Codex thread', () => {
    assert.deepEqual(canonicalPersonalChatUrl(TARGET + '#harmless'), { url: TARGET, id: '00000000-0000-0000-0000-b40c114d0582' });
    for (const url of ['http://chatgpt.com/c/00000000-0000-0000-0000-b40c114d0582', TARGET + '/', TARGET.replace('chatgpt.com', 'chatgpt.com:443'), TARGET + '?redirect=evil', TARGET.replace('chatgpt.com', 'chatgpt.com.evil.invalid'), TARGET.replace('chatgpt.com', 'account-474c4438@example.invalid'), 'https://chatgpt.com/share/00000000-0000-0000-0000-b40c114d0582', 'https://chatgpt.com/c/codex-thread-id', 'https://chatgpt.com/work', 'https://chatgpt.com/c/../../settings']) {
      assert.throws(() => canonicalPersonalChatUrl(url), code('target_invalid'), url);
    }
  });
  it('requires observed account/connector locators and a positive personal-mode state', () => {
    assert.equal(browserUiProfileSchema.safeParse(profile).success, true);
    assert.equal(browserUiProfileSchema.safeParse({ ...profile, personalMode: { role: 'button', name: 'Chat' } }).success, false);
    assert.equal(browserUiProfileSchema.safeParse({ ...profile, accountIdentity: { role: 'button', name: 'Account' } }).success, false);
    assert.equal(browserUiProfileSchema.safeParse({ ...profile, selectedConnector: { role: 'button', name: 'Installed apps' } }).success, false);
  });
  it('construction and feature-off inspection never launch a subprocess/browser', async () => {
    let launches = 0;
    const bridge = new BrowserUiBridge({ profileDirectory: '/tmp/not-created-control-fixture', executablePath: '/not-used', launchContext: async () => { launches++; throw new Error('must not launch'); } });
    assert.equal(bridge.launched, false);
    await assert.rejects(bridge.inspectConfiguredTarget(binding), code('browser_not_started'));
    assert.equal(launches, 0);
    await bridge.close();
  });
  it('rejects private profile placement in excluded application/backup roots before launch', async () => {
    let launched = false;
    const bridge = new BrowserUiBridge({ profileDirectory: '/tmp/gemrouter-excluded-fixture/private-browser', executablePath: '/not-used', excludedDirectories: ['/tmp/gemrouter-excluded-fixture'], launchContext: async () => { launched = true; throw new Error('must not launch'); } });
    await assert.rejects(bridge.launchLogin(), code('private_profile_invalid'));
    assert.equal(launched, false);
    await bridge.close();
  });
});

const executablePath = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
describe('isolated real-browser fixture (NOT live ChatGPT)', { skip: !executablePath }, () => {
  let browser: Browser;
  before(async () => { browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-dev-shm-usage'] }); });
  after(async () => { await browser?.close(); });

  async function harness(run: (bridge: BrowserUiBridge, page: Page, context: BrowserContext) => Promise<void>, selectedProfile: BrowserUiProfile = profile) {
    const directory = await mkdtemp(path.join(tmpdir(), 'gemrouter-personal-ui-fixture-'));
    const context = await browser.newContext();
    // Every network request is fulfilled locally. There are no real accounts,
    // cookies, private API calls, OAuth grants or production connections.
    await context.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml() }));
    const page = await context.newPage();
    const bridge = new BrowserUiBridge({ profileDirectory: directory, executablePath: executablePath!, uiProfile: selectedProfile, launchContext: async () => context, operationTimeoutMs: 5000 });
    try {
      await bridge.launchLogin();
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      await bridge.inspectConfiguredTarget(binding);
      await run(bridge, page, context);
    } finally {
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('observes exact target and all three tools without upgrading a declaration to observed identity', async () => harness(async (bridge) => {
    const target = await bridge.inspectConfiguredTarget(binding);
    assert.deepEqual(target.observedTools, []);
    assert.equal(target.toolSetVerifiedAt, null);
    const tools = await bridge.ensureConfiguredMcp(binding);
    assert.deepEqual(tools.observedTools, ['gateway_open', 'gateway_exchange', 'gateway_status']);
    assert.equal(tools.connectorIdentityObserved, null);
    assert.equal(tools.resourceIdentityEvidence, 'operator_declared');
    assert.equal(tools.writeApprovalObserved, true);
    assert.equal(tools.chatgptConversationUrl, TARGET);
    assert.equal('completion' in tools, false);
  }));

  it('does not infer write approval from tool availability, and rechecks revoked approval at send', async () => harness(async (bridge, page) => {
    await page.getByRole('button', { name: 'Writes approved', exact: true }).evaluate((node) => node.setAttribute('aria-pressed', 'false'));
    assert.equal((await bridge.ensureConfiguredMcp(binding)).writeApprovalObserved, false);
    await assert.rejects(bridge.sendBoundedWake(binding, operation()), code('tool_approval_required'));
    await page.getByRole('button', { name: 'Writes approved', exact: true }).evaluate((node) => node.setAttribute('aria-pressed', 'true'));
    await assert.rejects(bridge.sendBoundedWake(binding, operation(), { onDeliveryAttempt: async () => {
      await page.getByRole('button', { name: 'Writes approved', exact: true }).evaluate((node) => node.setAttribute('aria-pressed', 'false'));
    } }), code('tool_approval_required'));
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
  }));

  it('compares observable MCP resource identity instead of trusting a matching connector label', async () => harness(async (bridge, page) => {
    const result = await bridge.ensureConfiguredMcp(binding);
    assert.equal(result.connectorIdentityObserved, binding.expectedMcpResource);
    assert.equal(result.resourceIdentityEvidence, 'ui_observed');
    await page.getByRole('link', { name: 'Selected connector resource', exact: true }).evaluate((node) => node.setAttribute('href', 'https://gateway.invalid/mcp/chatgpt/wrong-worker'));
    await assert.rejects(bridge.sendBoundedWake(binding, operation()), code('connector_resource_mismatch'));
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
  }, { ...profile, connectorResourceLink: { role: 'link', name: 'Selected connector resource' } }));

  it('sends once and recovers the marker without a duplicate or any transcript return', async () => harness(async (bridge, page) => {
    const request = operation();
    const first = await bridge.sendBoundedWake(binding, request);
    const second = await bridge.sendBoundedWake(binding, request);
    assert.equal(first.markerRecovered, false);
    assert.equal(second.markerRecovered, true);
    assert.equal(await page.evaluate(() => (window as any).sent), 1);
    assert.equal(JSON.stringify(first).includes(request.prompt), false);
    assert.equal('response' in first, false);
  }));

  it('rejects a moved target before typing or clicking, even after successful inspection', async () => harness(async (bridge, page) => {
    await page.goto(OTHER);
    await assert.rejects(bridge.sendBoundedWake(binding, operation()), code('target_moved'));
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
    assert.equal(await page.getByRole('textbox').inputValue(), '');
  }));

  it('checks binding stop/cancellation immediately before send and clears only its own unsent draft', async () => harness(async (bridge, page) => {
    await assert.rejects(bridge.sendBoundedWake(binding, operation(), { preSend: () => { throw new BrowserControlError('binding_fenced'); } }), code('binding_fenced'));
    assert.equal(await page.getByRole('textbox').inputValue(), '');
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
  }));

  it('does not overwrite a user draft, including edits made after service fill', async () => harness(async (bridge, page) => {
    await page.getByRole('textbox').fill('Private unfinished user message');
    await assert.rejects(bridge.sendBoundedWake(binding, operation()), code('composer_not_empty'));
    assert.equal(await page.getByRole('textbox').inputValue(), 'Private unfinished user message');
    await page.getByRole('textbox').fill('');
    await assert.rejects(bridge.sendBoundedWake(binding, operation('wake-fixture-race'), { preSend: async () => { await page.getByRole('textbox').fill('User raced with service'); } }), code('composer_changed'));
    assert.equal(await page.getByRole('textbox').inputValue(), 'User raced with service');
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
  }));

  it('never stops a generation or proceeds with status-only / unapproved tools', async () => harness(async (bridge, page) => {
    await page.evaluate(() => { const button = document.createElement('button'); button.textContent = 'Stop'; document.body.append(button); });
    await assert.rejects(bridge.sendBoundedWake(binding, operation()), code('chat_busy'));
    await page.getByRole('button', { name: 'Stop', exact: true }).evaluate((node) => node.remove());
    await page.getByRole('button', { name: 'gateway_exchange', exact: true }).evaluate((node) => node.setAttribute('disabled', ''));
    await assert.rejects(bridge.sendBoundedWake(binding, operation()), code('tool_approval_required'));
    await page.getByRole('button', { name: 'gateway_exchange', exact: true }).evaluate((node) => node.remove());
    await assert.rejects(bridge.ensureConfiguredMcp(binding), code('required_tools_missing'));
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
  }));

  it('rejects wrong account, unselected connector, Work mode, and ambiguous accessible controls', async () => harness(async (bridge, page) => {
    await assert.rejects(bridge.sendBoundedWake({ ...binding, expectedAccountLabel: 'Wrong account' }, operation()), code('browser_account_mismatch'));
    await page.getByRole('tab').evaluate((node) => node.setAttribute('aria-selected', 'false'));
    await assert.rejects(bridge.sendBoundedWake(binding, operation()), code('personal_chat_mode_required'));
    await page.getByRole('tab').evaluate((node) => node.setAttribute('aria-selected', 'true'));
    await page.getByRole('checkbox').evaluate((node) => node.setAttribute('aria-checked', 'false'));
    await assert.rejects(bridge.sendBoundedWake(binding, operation()), code('connector_mismatch'));
    await page.getByRole('checkbox').evaluate((node) => node.setAttribute('aria-checked', 'true'));
    await page.getByRole('button', { name: 'Send', exact: true }).evaluate((node) => node.parentNode!.appendChild(node.cloneNode(true)));
    await assert.rejects(bridge.sendBoundedWake(binding, operation()), code('ui_control_ambiguous'));
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
  }));

  it('revalidates account and target after asynchronous pre-send checks', async () => harness(async (bridge, page) => {
    await assert.rejects(bridge.sendBoundedWake(binding, operation(), { preSend: async () => { await page.goto(OTHER); } }), code('target_moved'));
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
    assert.equal(page.url(), OTHER);
  }));

  it('marks an unobserved click ambiguous and does not silently resend', async () => harness(async (bridge, page) => {
    await page.evaluate(() => { (window as any).ambiguous = true; });
    const request = operation('wake-fixture-ambiguous', 1000);
    await assert.rejects(bridge.sendBoundedWake(binding, request), code('delivery_ambiguous'));
    // An in-flight locator is fenced by context closure on deadline. If the
    // observer expired first, the context can stay open, but retry is still
    // forbidden without finding the marker (a durable outbox fences restarts).
    if (bridge.launched) {
      await assert.rejects(bridge.sendBoundedWake(binding, { ...request, deadlineAt: Date.now() + 4000 }), code('delivery_ambiguous'));
      assert.equal(await page.evaluate(() => (window as any).sent), 1);
    } else {
      await assert.rejects(bridge.sendBoundedWake(binding, { ...request, deadlineAt: Date.now() + 4000 }), code('browser_not_started'));
    }
  }));

  it('uses only a newly added structured gateway_status result, never narrative success', async () => harness(async (bridge, page) => {
    await page.evaluate(() => { (window as any).statusResult = 'worker-fixture'; });
    const evidence = await bridge.sendBoundedWake(binding, { ...operation(), diagnostic: true });
    assert.equal(evidence.statusWorkerId, 'worker-fixture');
    assert.equal('completion' in evidence, false);
    await page.evaluate(() => { (window as any).statusResult = 'wrong-worker'; });
    await assert.rejects(bridge.sendBoundedWake(binding, { ...operation('wake-fixture-wrong-worker'), diagnostic: true }), code('diagnostic_worker_mismatch'));
  }));

  it('creates a separate real-UI fixture conversation and returns its observed URL, not a generated ID', async () => harness(async (bridge, page) => {
    const result = await bridge.createPersonalChat({ ...binding, ...operation('create-fixture-chat'), workerId: 'worker-separate', expectedConnectorLabel: 'Separate app', expectedMcpResource: 'https://gateway.invalid/mcp/chatgpt/worker-separate', explicitAdminRequest: true });
    assert.equal(result.chatgptConversationUrl, CREATED);
    assert.equal(result.observedConnectorLabel, 'Separate app');
    assert.notEqual(result.chatgptConversationUrl, TARGET);
    assert.equal(page.url(), CREATED);
  }));

  it('requires explicit admin creation and preserves existing drafts', async () => harness(async (bridge, page) => {
    const request = { ...binding, ...operation('create-fixture-denied'), explicitAdminRequest: false as unknown as true };
    await assert.rejects(bridge.createPersonalChat(request), code('admin_confirmation_required'));
    await page.getByRole('textbox').fill('User draft before new chat');
    await assert.rejects(bridge.createPersonalChat({ ...request, explicitAdminRequest: true }), code('composer_not_empty'));
    assert.equal(page.url(), TARGET);
    assert.equal(await page.getByRole('textbox').inputValue(), 'User draft before new chat');
  }));

  it('cancels a pending operation and closes only its private browser context', async () => harness(async (bridge, page) => {
    const abort = new AbortController();
    await assert.rejects(bridge.sendBoundedWake(binding, operation(), { signal: abort.signal, preSend: () => { abort.abort(); } }), code('control_cancelled'));
    assert.equal(bridge.launched, false);
    assert.equal(browser.isConnected(), true);
  }));
});
