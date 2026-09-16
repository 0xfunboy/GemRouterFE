import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { spawn } from 'node:child_process';
import { CODEX_RUNTIME_VERSION, CodexRuntime, type CodexRuntimeOptions } from '../src/codex/runtime.js';

/** Deterministic stdio simulator. Does not log in, contact OpenAI, or control any real chat. */
function simulatedRuntime(settings: { authenticated?: boolean; noAstra?: boolean; noTool?: boolean;
  blockTurn?: boolean; wrongModel?: boolean; wrongHome?: boolean; version?: string; badTool?: boolean;
  toolTwice?: boolean; wrongLoginUrl?: boolean; usageUnsupported?: boolean; inferenceError?: string; noUsage?: boolean; capability?: boolean } = {}) {
  const processes: Array<EventEmitter & { killed: boolean; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null }> = [];
  const messages: any[] = [];
  const launches: Array<{ args: string[]; options: any }> = [];
  let authenticated = settings.authenticated ?? false;
  let server: typeof processes[number] | undefined;
  const emit = (message: unknown) => server?.stdout.write(`${JSON.stringify(message)}\n`);
  const launch = ((_command: string, args: string[], options: any) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      exitCode: null as number | null,
      kill() { if (!child.killed) { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); } return true; },
    });
    launches.push({ args, options });
    processes.push(child);
    if (args[0] === '--version') {
      queueMicrotask(() => { child.stdout.write(`codex-cli ${settings.version ?? CODEX_RUNTIME_VERSION}\n`); child.exitCode = 0; child.emit('exit', 0); });
      return child;
    }
    server = child;
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        messages.push(message);
        const answer = (result: unknown) => queueMicrotask(() => emit({ id: message.id, result }));
        if (message.method === 'initialize') answer({ codexHome: settings.wrongHome ? '/another/profile' : options.env.CODEX_HOME,
          userAgent: 'codex/test', platformFamily: 'unix', platformOs: 'linux' });
        else if (message.method === 'config/read') {
          const features = Object.fromEntries(args.filter((arg) => arg.startsWith('features.')).map((arg) => {
            const [key, value] = arg.split('='); return [key.slice(9), JSON.parse(value)];
          }));
          answer({ config: { features, forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file',
            web_search: 'disabled', apps: { _default: { enabled: false } }, mcp_servers: {}, plugins: {} } });
        }
        else if (message.method === 'account/read') answer({ account: authenticated ? {
          type: 'chatgpt', email: 'operator@example.test', planType: 'pro', accessToken: 'NEVER_RETURN_ACCESS_TOKEN',
        } : null, requiresOpenaiAuth: true, secret: 'NEVER_RETURN' });
        else if (message.method === 'model/list') answer({ data: settings.noAstra ? [] : [{ id: 'catalog-astra', model: 'gpt-6-astra',
          displayName: 'GPT-6 Astra', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
        else if (message.method === 'thread/start') answer({ thread: { id: 'thread-fixture' }, model: settings.wrongModel ? 'wrong' : message.params.model,
          cwd: message.params.cwd, approvalPolicy: 'never', sandbox: { type: 'readOnly' }, instructionSources: [], runtimeWorkspaceRoots: [] });
        else if (message.method === 'turn/start') {
          answer({ turn: { id: 'turn-fixture' } });
          if (!settings.blockTurn) queueMicrotask(() => {
            const context = { threadId: 'thread-fixture', turnId: 'turn-fixture' };
            emit({ method: 'turn/started', params: { ...context, turn: { id: 'turn-fixture' } } });
            if (settings.capability) { emit({ id: 912, method: 'item/tool/call', params: { ...context, tool: 'shell' } }); return; }
            if (!settings.noUsage) for (const total of [110, 120, 120, null, 115]) {
              emit({ method: 'thread/tokenUsage/updated', params: { ...context, tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: total } } } });
            }
            const item = { type: 'agentMessage', id: 'final-message', phase: 'final_answer', text: 'FIXTURE_OK' };
            emit({ method: 'item/completed', params: { ...context, item: { ...item, id: 'commentary', phase: 'commentary', text: 'PRIVATE_COMMENTARY' } } });
            emit({ method: 'item/completed', params: { ...context, item } });
            emit({ method: 'turn/completed', params: { ...context, turn: { id: 'turn-fixture', status: settings.inferenceError ? 'failed' : 'completed', items: [item], error: settings.inferenceError ? { codexErrorInfo: settings.inferenceError } : null } } });
          });
        }
        else if (message.method === 'account/login/start') {
          if (message.params.type === 'chatgptDeviceCode') answer({ type: 'chatgptDeviceCode', loginId: 'login-only-controller',
            userCode: 'FAKE-CODE', verificationUrl: settings.wrongLoginUrl ? 'https://evil.test/login' : 'https://auth.openai.com/codex/device' });
          else answer({ type: 'chatgpt', loginId: 'login-only-controller', authUrl: 'https://auth.openai.com/authorize?state=fake' });
        } else if (message.method === 'account/logout') { authenticated = false; answer({}); }
        else if (message.method === 'account/usage/read') {
          if (settings.usageUnsupported) queueMicrotask(() => emit({ id: message.id, error: { code: -32601, message: 'NEVER_RETURN' } }));
          else answer({summary:{lifetimeTokens:100}, dailyUsageBuckets:null, accessToken:'NEVER_RETURN'});
        }
        else if (message.method === 'account/rateLimits/read') answer({rateLimits:{limitId:'codex',primary:{usedPercent:12,windowDurationMins:300,resetsAt:1000}},secret:'NEVER_RETURN'});
        else if (message.method && message.id) answer({});
      }
    });
    queueMicrotask(() => child.stderr.write('NEVER_LOG_ACCESS_TOKEN device-code browser-cookie'));
    return child;
  }) as unknown as typeof spawn;
  return { launch, messages, launches, processes, emit,
    completeLogin() { authenticated = true; emit({ method: 'account/login/completed', params: { loginId: 'login-only-controller', success: true } }); },
  };
}

async function setup(t: any, settings: Parameters<typeof simulatedRuntime>[0] = {}, extra: Partial<CodexRuntimeOptions> = {}, now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), 'gemrouter-codex-runtime-test-'));
  const profileDirectory = join(root, 'private-controller');
  const fake = simulatedRuntime(settings);
  const runtime = new CodexRuntime({ enabled: true, command: '/fake/codex', profileDirectory,
    requestedModel: 'gpt-6-astra', rpcTimeoutMs: 500, ...extra }, { spawn: fake.launch, now });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, fake, root, profileDirectory };
}

test('feature-off and cached readiness are inert: no subprocess or profile created', async (t) => {
  const { runtime, fake, profileDirectory } = await setup(t, {}, { enabled: false });
  assert.equal(runtime.readyCached, false);
  assert.equal((await runtime.status()).reasonCode, 'codex_disabled');
  assert.equal(fake.launches.length, 0);
  await assert.rejects(stat(profileDirectory), { code: 'ENOENT' });
});

test('official isolated runtime uses private profile, allowlisted env and safe account DTO', async (t) => {
  const { runtime, fake, profileDirectory } = await setup(t, { authenticated: true });
  assert.equal(runtime.readyCached, false);
  const status = await runtime.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.runtimeVersion, CODEX_RUNTIME_VERSION);
  assert.equal(status.modelAvailable, true);
  assert.equal(runtime.readyCached, true);
  assert.equal(JSON.stringify(status).includes('NEVER_RETURN'), false);
  assert.equal((await stat(profileDirectory)).mode & 0o777, 0o700);
  for (const call of fake.launches) {
    assert.deepEqual(Object.keys(call.options.env).sort(), ['CODEX_HOME', 'LANG', 'PATH']);
    assert.equal(call.options.env.CODEX_HOME, profileDirectory);
    assert.equal(call.options.shell, false);
  }
  await runtime.status();
  assert.equal(fake.launches.length, 2, 'version detection plus one long-lived app-server');
});

test('login is session-owned, secret-free after completion, and unrelated to worker pairing', async (t) => {
  const { runtime, fake } = await setup(t);
  const pending = await runtime.startLogin('session-hash-A');
  assert.equal(pending.userCode, 'FAKE-CODE');
  assert.equal(await runtime.loginStatus('session-hash-B'), null);
  await assert.rejects(runtime.cancelLogin('session-hash-B'), { code: 'codex_login_not_owned' });
  fake.completeLogin();
  const done = await runtime.loginStatus('session-hash-A');
  assert.equal(done?.status, 'completed');
  assert.equal(done?.userCode, undefined);
  assert.equal(runtime.readyCached, true);
  assert.equal(fake.messages.some((message) => /mcp|pair|gateway|grant/i.test(message.method ?? '')), false);
});

test('pending login expires, removes code, cancels official flow and ignores late completion', async (t) => {
  let now = 1_000;
  const { runtime, fake } = await setup(t, {}, {}, () => now);
  const pending = await runtime.startLogin('session-A');
  now = pending.expiresAt + 1;
  assert.equal((await runtime.loginStatus('session-A'))?.status, 'expired');
  assert.equal((await runtime.loginStatus('session-A'))?.userCode, undefined);
  fake.completeLogin();
  assert.equal((await runtime.loginStatus('session-A'))?.status, 'expired');
  assert.equal(fake.messages.some((message) => message.method === 'account/login/cancel'), true);
});

test('browser OAuth displays callback host warning and cancel/logout stay on dedicated runtime', async (t) => {
  const { runtime, fake } = await setup(t);
  const pending = await runtime.startLogin('owner', 'browser');
  assert.match(pending.callbackHostNotice ?? '', /runtime host/);
  assert.match(pending.authUrl ?? '', /^https:\/\/auth\.openai\.com\//);
  await runtime.cancelLogin('owner');
  assert.equal((await runtime.loginStatus('owner'))?.authUrl, undefined);
  await runtime.logout();
  assert.equal(runtime.cachedStatus().authenticated, false);
  assert.deepEqual(fake.messages.filter((m) => m.method?.includes('logout')).map((m) => m.method), ['account/logout']);
});

test('OAuth URL response is constrained to official HTTPS hosts', async (t) => {
  const { runtime } = await setup(t, { wrongLoginUrl: true });
  await assert.rejects(runtime.startLogin('owner'), { code: 'codex_invalid_login_response' });
  assert.equal((await runtime.loginStatus('owner'))?.userCode, undefined);
});

test('profile rejects backup paths, developer .codex, permissive directories and symlinks without touching sentinels', async (t) => {
  const { runtime, fake, root } = await setup(t);
  await runtime.close();
  const target = join(root, 'real');
  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, 'sentinel'), 'existing developer state');
  const linked = join(root, 'linked');
  await symlink(target, linked);
  const permissive = join(root, 'permissive');
  await mkdir(permissive, { mode: 0o755 });
  for (const profile of [linked, permissive, join(root, '.codex', 'child'), join(root, 'backup', 'private')]) {
    const other = new CodexRuntime({ enabled: true, command: '/fake/codex', profileDirectory: profile,
      requestedModel: 'gpt-6-astra', excludedDirectories: [join(root, 'backup')] }, { spawn: fake.launch });
    const status = await other.status();
    assert.match(status.reasonCode ?? '', /^codex_(profile|private_profile)/);
    await other.close();
  }
  assert.equal(fake.launches.length, 0);
  assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'existing developer state');
});
test('usage reads real protocol methods, allowlists metrics and never starts a turn', async (t) => {
  const { runtime, fake } = await setup(t, { authenticated: true });
  const data = await runtime.usage();
  assert.equal(data.usage?.summary.lifetimeTokens, 100);
  assert.equal(data.quota?.[0].primary?.usedPercent, 12);
  assert.equal(JSON.stringify(data).includes('NEVER_RETURN'), false);
  assert.equal(fake.messages.some((m) => /^(thread|turn|item|mcp|gateway)\//.test(m.method || '')), false);
  fake.emit({ id: 999, method: 'item/tool/call', params: { tool: 'shell' } });
  assert.equal(fake.messages.find((m) => m.id === 999)?.error?.code, -32601);
});

test('unsupported usage is unknown while quota remains independently available', async (t) => {
  const { runtime } = await setup(t, { authenticated: true, usageUnsupported: true });
  const data = await runtime.usage();
  assert.equal(data.usage, null);
  assert.equal(data.usageError, 'codex_method_unsupported');
  assert.equal(data.quotaError, null);
  assert.equal(data.quota?.[0].limitId, 'codex');
});

test('usage requires authentication and profile/version mismatches fail closed', async (t) => {
  const { runtime } = await setup(t);
  await assert.rejects(runtime.usage(), { code: 'codex_auth_required' });
  for (const [settings, code] of [
    [{ version: '999.0.0' }, 'codex_runtime_version_unsupported'],
    [{ wrongHome: true }, 'codex_profile_mismatch'],
    [{ authenticated: true, noAstra: true }, 'codex_requested_model_unavailable'],
  ] as const) {
    const fixture = await setup(t, settings);
    assert.equal((await fixture.runtime.status()).reasonCode, code);
  }
});

test('inference is a restricted ephemeral real protocol turn, final text only, usage deduplicated', async (t) => {
  const { runtime, fake } = await setup(t, { authenticated: true });
  const result = await runtime.generate({ model: 'gpt-6-astra', reasoningEffort: 'high', system: 'Be concise.', input: 'hello', deadline: Date.now() + 3000 });
  assert.equal(result.content, 'FIXTURE_OK'); assert.equal(result.usage?.totalTokens, 120);
  assert.equal(result.usage?.cachedInputTokens, 40);
  const start = fake.messages.find((m) => m.method === 'thread/start').params;
  assert.equal(start.ephemeral, true); assert.equal(start.allowProviderModelFallback, false);
  assert.deepEqual(start.dynamicTools, []); assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never'); assert.equal(start.developerInstructions, 'Be concise.');
  const turn = fake.messages.find((m) => m.method === 'turn/start').params;
  assert.equal(turn.effort, 'high'); assert.equal(turn.input[0].text, 'hello');
});
test('inference fails closed for reroute, tool request, unavailable thinking; structured quota keeps usage', async (t) => {
  for (const [settings, code] of [[{ wrongModel: true }, 'codex_restrictions_unverified'], [{ capability: true }, 'codex_capability_denied'], [{ inferenceError: 'usageLimitExceeded' }, 'codex_quota_depleted']] as const) {
    const { runtime, fake } = await setup(t, { authenticated: true, ...settings });
    await assert.rejects(runtime.generate({ model: 'gpt-6-astra', reasoningEffort: 'high', system: '', input: 'hi', deadline: Date.now() + 3000 }), (e: any) => {
      assert.equal(e.code, code); if (settings.inferenceError) assert.equal(e.usage?.totalTokens, 120); return true;
    });
    assert.equal(fake.processes.at(-1)?.killed, true);
  }
  const { runtime, fake } = await setup(t, { authenticated: true });
  await assert.rejects(runtime.generate({ model: 'gpt-6-astra', reasoningEffort: 'ultra', system: '', input: 'hi', deadline: Date.now() + 3000 }), { code: 'codex_reasoning_unsupported' });
  assert.equal(fake.messages.some((m) => m.method === 'turn/start'), false);
});
test('missing usage stays unknown and client abort terminates the owned inference runtime', async (t) => {
  const fixture = await setup(t, { authenticated: true, noUsage: true });
  assert.equal((await fixture.runtime.generate({ model: 'gpt-6-astra', reasoningEffort: 'high', system: '', input: 'hi', deadline: Date.now() + 3000 })).usage, null);
  const { runtime, fake } = await setup(t, { authenticated: true, blockTurn: true });
  const controller = new AbortController();
  const result = runtime.generate({ model: 'gpt-6-astra', reasoningEffort: 'high', system: '', input: 'hi', signal: controller.signal, deadline: Date.now() + 3000 });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(result, { code: 'codex_cancelled' });
  assert.equal(fake.processes.at(-1)?.killed, true);
});
