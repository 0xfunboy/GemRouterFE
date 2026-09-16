import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { spawn } from 'node:child_process';
import { CODEX_CONTROL_RUNTIME_VERSION, CodexRuntime, type CodexRuntimeOptions } from '../src/llm/providers/chatgpt/control/codexRuntime.js';

/** Deterministic stdio simulator. Does not log in, contact OpenAI, or control any real chat. */
function simulatedRuntime(settings: { authenticated?: boolean; noAstra?: boolean; noTool?: boolean;
  blockTurn?: boolean; wrongModel?: boolean; wrongHome?: boolean; version?: string; badTool?: boolean;
  toolTwice?: boolean; wrongLoginUrl?: boolean } = {}) {
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
      queueMicrotask(() => { child.stdout.write(`codex-cli ${settings.version ?? CODEX_CONTROL_RUNTIME_VERSION}\n`); child.exitCode = 0; child.emit('exit', 0); });
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
        else if (message.method === 'account/login/start') {
          if (message.params.type === 'chatgptDeviceCode') answer({ type: 'chatgptDeviceCode', loginId: 'login-only-controller',
            userCode: 'FAKE-CODE', verificationUrl: settings.wrongLoginUrl ? 'https://evil.test/login' : 'https://auth.openai.com/codex/device' });
          else answer({ type: 'chatgpt', loginId: 'login-only-controller', authUrl: 'https://auth.openai.com/authorize?state=fake' });
        } else if (message.method === 'account/logout') { authenticated = false; answer({}); }
        else if (message.method === 'thread/start') answer({ thread: { id: 'codex-controller-NOT-web-chat' },
          model: settings.wrongModel ? 'not-astra' : message.params.model, approvalPolicy: 'never', sandbox: { type: 'readOnly' }, instructionSources: [] });
        else if (message.method === 'turn/start') {
          answer({ turn: { id: 'controller-turn', status: 'inProgress' } });
          if (settings.blockTurn) continue;
          if (settings.noTool) queueMicrotask(() => emit({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'controller-turn', status: 'completed' } } }));
          else queueMicrotask(() => emit({ id: 800, method: 'item/tool/call', params: {
            callId: 'bounded-call', threadId: message.params.threadId, turnId: 'controller-turn',
            tool: settings.badTool ? 'gateway_exchange' : 'control_target', arguments: {},
          } }));
        } else if (message.id === 800 && message.result) {
          if (settings.toolTwice) queueMicrotask(() => emit({ id: 801, method: 'item/tool/call', params: {
            callId: 'second-call', threadId: 'codex-controller-NOT-web-chat', turnId: 'controller-turn', tool: 'control_target', arguments: {},
          } }));
          else queueMicrotask(() => emit({ method: 'turn/completed', params: { threadId: 'codex-controller-NOT-web-chat', turn: { id: 'controller-turn', status: 'completed' } } }));
        } else if (message.method && message.id) answer({});
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
    requestedModel: 'gpt-6-astra', rpcTimeoutMs: 500, turnTimeoutMs: 1000, ...extra }, { spawn: fake.launch, now });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, fake, root, profileDirectory };
}

const tool = (execute: () => Promise<unknown>) => ({ name: 'control_target', description: 'Execute this one server-scoped control operation.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} }, execute });

test('feature-off and cached readiness are inert: no subprocess or profile created', async (t) => {
  const { runtime, fake, profileDirectory } = await setup(t, {}, { enabled: false });
  assert.equal(runtime.readyCached, false);
  assert.equal((await runtime.status()).reasonCode, 'controller_disabled');
  assert.equal(fake.launches.length, 0);
  await assert.rejects(stat(profileDirectory), { code: 'ENOENT' });
});

test('official isolated runtime uses private profile, allowlisted env and safe account DTO', async (t) => {
  const { runtime, fake, profileDirectory } = await setup(t, { authenticated: true });
  assert.equal(runtime.readyCached, false);
  const status = await runtime.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.runtimeVersion, CODEX_CONTROL_RUNTIME_VERSION);
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
  await assert.rejects(runtime.cancelLogin('session-hash-B'), { code: 'controller_login_not_owned' });
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
  assert.match(pending.callbackHostNotice ?? '', /controller host/);
  assert.match(pending.authUrl ?? '', /^https:\/\/auth\.openai\.com\//);
  await runtime.cancelLogin('owner');
  assert.equal((await runtime.loginStatus('owner'))?.authUrl, undefined);
  await runtime.logout();
  assert.equal(runtime.cachedStatus().authenticated, false);
  assert.deepEqual(fake.messages.filter((m) => m.method?.includes('logout')).map((m) => m.method), ['account/logout']);
});

test('OAuth URL response is constrained to official HTTPS hosts', async (t) => {
  const { runtime } = await setup(t, { wrongLoginUrl: true });
  await assert.rejects(runtime.startLogin('owner'), { code: 'controller_invalid_login_response' });
  assert.equal((await runtime.loginStatus('owner'))?.userCode, undefined);
});

test('controller executes one bounded closure with no shell, environment, model fallback or web chat substitution', async (t) => {
  const { runtime, fake } = await setup(t, { authenticated: true });
  let calls = 0;
  const result = await runtime.runControl('Inspect only the bound target.', tool(async () => { calls++; return { observed: true }; }), new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(result.codexControllerThreadId, 'codex-controller-NOT-web-chat');
  assert.equal(result.toolInvocations, 1);
  assert.equal('completion' in result, false);
  const start = fake.messages.find((message) => message.method === 'thread/start').params;
  assert.deepEqual(start.environments, []);
  assert.deepEqual(start.selectedCapabilityRoots, []);
  assert.equal(start.ephemeral, true);
  assert.equal(start.allowProviderModelFallback, false);
  assert.equal(start.config['features.shell_tool'], false);
  assert.equal(start.dynamicTools.length, 1);
  assert.equal(fake.messages.some((message) => message.method === 'thread/unsubscribe'), true);
});

test('a narrative-only completed controller turn is explicitly no tool evidence', async (t) => {
  const { runtime } = await setup(t, { authenticated: true, noTool: true });
  const result = await runtime.runControl('Inspect target.', tool(async () => { throw new Error('must not run'); }), new AbortController().signal);
  assert.equal(result.toolInvocations, 0);
  assert.equal(result.controllerTurnCompleted, true);
  assert.equal('supported' in result, false);
});

test('unavailable Astra, incorrect returned model and unsupported runtime fail closed', async (t) => {
  for (const [settings, code] of [
    [{ authenticated: true, noAstra: true }, 'controller_requested_model_unavailable'],
    [{ authenticated: true, wrongModel: true }, 'controller_restrictions_unverified'],
    [{ version: '999.0.0' }, 'controller_runtime_version_unsupported'],
    [{ wrongHome: true }, 'controller_profile_mismatch'],
  ] as const) {
    const { runtime } = await setup(t, settings);
    await assert.rejects(runtime.runControl('Inspect target.', tool(async () => ({})), new AbortController().signal), { code });
  }
});

test('unexpected gateway capability and second control call never execute', async (t) => {
  for (const [settings, code, expected] of [
    [{ authenticated: true, badTool: true }, 'controller_capability_denied', 0],
    [{ authenticated: true, toolTwice: true }, 'controller_tool_budget_exceeded', 1],
  ] as const) {
    const { runtime } = await setup(t, settings);
    let calls = 0;
    await assert.rejects(runtime.runControl('Inspect target.', tool(async () => { calls++; return {}; }), new AbortController().signal), { code });
    assert.equal(calls, expected);
  }
});

test('single-flight control aborts on deadline and leaves no live child', async (t) => {
  const { runtime, fake } = await setup(t, { authenticated: true, blockTurn: true }, { turnTimeoutMs: 40 });
  const running = runtime.runControl('Inspect target.', tool(async () => ({})), new AbortController().signal);
  await assert.rejects(runtime.runControl('Other.', tool(async () => ({})), new AbortController().signal), { code: 'controller_busy' });
  await assert.rejects(running, { code: 'controller_timeout' });
  assert.equal(fake.processes.every((child) => child.killed), true);
  assert.equal(runtime.readyCached, false);
});

test('caller cancellation and explicit shutdown interrupt pending turns', async (t) => {
  for (const close of [false, true]) {
    const { runtime, fake } = await setup(t, { authenticated: true, blockTurn: true });
    await runtime.status();
    const abort = new AbortController();
    const running = runtime.runControl('Inspect target.', tool(async () => ({})), abort.signal);
    const rejected = assert.rejects(running, { code: close ? 'controller_closed' : 'controller_cancelled' });
    await new Promise((done) => setTimeout(done, 5));
    if (close) await runtime.close(); else abort.abort();
    await rejected;
    assert.equal(fake.processes.every((child) => child.killed), true);
  }
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
    assert.match(status.reasonCode ?? '', /^controller_(profile|private_profile)/);
    await other.close();
  }
  assert.equal(fake.launches.length, 0);
  assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'existing developer state');
});
