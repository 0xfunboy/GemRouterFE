import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { setupAccounts } from './helpers/codex-accounts-fixture.js';
import { CodexAccounts } from '../src/codex/accounts.js';
import { CodexRuntimeError } from '../src/codex/runtime.js';
import { ManagedCodexRuntime, downloadOfficialRuntime, newerRuntime } from '../src/codex/managed-runtime.js';
import { TelegramAlerts, readTelegramConfig } from '../src/alerts/telegram.js';
import { registerCodexAccountRoutes } from '../src/codex/routes.js';
import { AppStore } from '../src/store/appStore.js';

const messages = [{ role: 'user' as const, content: 'Status' }];
const options = { model: 'gpt-5.6-sol', codex: { enabled: true, reasoningEffort: 'high', fallbackEnabled: true } };
const quota = (usedPercent: number, weekly = false, resetsAt = Math.floor(Date.now() / 1000) + 60) => [{ limitId: 'codex',
  primary: { usedPercent: weekly ? 1 : usedPercent, windowDurationMins: 300, resetsAt },
  secondary: { usedPercent: weekly ? usedPercent : 1, windowDurationMins: 10080, resetsAt } }];
for (const weekly of [false, true]) test(`exhausted ${weekly ? 'weekly' : '5h'} temporarily uses other account, exact model/effort, preferred selection unchanged`, async (t) => {
  const { pool } = await setupAccounts(t); pool.add(); await pool.refresh(); pool.select('account-2');
  let usage = 100, calls = 0;
  pool.entry('account-2').runtime.quota = async () => quota(usage, weekly);
  const generate = pool.entry('account-1').runtime.generate;
  pool.entry('account-1').runtime.generate = async (input) => { calls++; assert.equal(input.model, options.model); assert.equal(input.reasoningEffort, 'high'); return generate(input); };
  await pool.refresh();
  const result = await pool.chat(messages, options);
  assert.equal(result.codexAccountId, 'account-1'); assert.equal(result.codexAccountFallbackFrom, 'account-2');
  assert.equal(pool.snapshot().selectedAccountId, 'account-2'); assert.equal(calls, 1);
  // A passed reset timestamp with still-exhausted upstream quota is NOT a recovery.
  pool.entry('account-2').runtime.quota = async () => quota(100, weekly, 1); await pool.refresh();
  assert.equal((await pool.chat(messages, options)).codexAccountId, 'account-1');
  usage = 1; pool.entry('account-2').runtime.quota = async () => quota(usage, weekly); await pool.refresh();
  assert.equal((await pool.chat(messages, options)).codexAccountId, 'account-2');
  assert.equal(pool.snapshot().lastRouting?.fallbackReason, null);
});
test('both exhausted preserve structured quota error; disabling account fallback never rotates', async (t) => {
  const { pool, config } = await setupAccounts(t); pool.add(); await pool.refresh(); pool.select('account-2');
  for (const id of ['account-1', 'account-2']) pool.entry(id).runtime.quota = async () => quota(100);
  await pool.refresh(); await assert.rejects(pool.chat(messages, options), { code: 'codex_quota_depleted' });
  pool.entry('account-1').runtime.quota = async () => quota(1); await pool.refresh(); config.accountFallbackEnabled = false;
  await assert.rejects(pool.chat(messages, options), { code: 'codex_quota_depleted' });
});
for (const code of ['codex_auth_required','codex_timeout','codex_model_unavailable','codex_rate_limited','codex_restrictions_unverified']) test(`no account fallback on ${code}`, async (t) => {
  const { pool } = await setupAccounts(t); pool.add(); await pool.refresh(); pool.select('account-2');
  pool.entry('account-2').runtime.generate = async () => { throw new CodexRuntimeError(code); };
  let calls = 0; pool.entry('account-1').runtime.generate = async () => { calls++; throw Error('Forbidden'); };
  await assert.rejects(pool.chat(messages, options), { code }); assert.equal(calls, 0);
});
test('upstream exhaustion rotates once, never substitutes unsupported model or thinking', async (t) => {
  const { pool } = await setupAccounts(t); pool.add(); await pool.refresh(); pool.select('account-2');
  pool.entry('account-2').runtime.generate = async () => { throw new CodexRuntimeError('codex_quota_depleted'); };
  assert.equal((await pool.chat(messages, options)).codexAccountId, 'account-1');
  pool.entry('account-1').runtime.models = async () => [{ id: 'other', model: 'gpt-5.6-luna', displayName: 'Luna', supportedReasoningEfforts: ['high'] }];
  await pool.refresh(); await assert.rejects(pool.chat(messages, options), { code: 'codex_quota_depleted' });
});
test('runtime activation keeps selection, metrics and rolls back on pointer-write failure', async (t) => {
  const { pool } = await setupAccounts(t); pool.add(); await pool.refresh(); pool.select('account-2');
  await pool.chat(messages, options); const metrics = pool.entry('account-2').provider.metrics;
  const changes = await pool.replaceRuntime('/fixture/new', '1.2.3');
  assert.equal(pool.snapshot().selectedAccountId, 'account-2'); assert.equal(pool.entry('account-2').provider.metrics, metrics);
  assert.deepEqual(changes.addedModels, []);
  await assert.rejects(pool.replaceRuntime('/fixture/newer', '1.2.4', async () => { throw Error('pointer-write'); }), /pointer-write/);
  assert.equal(pool.entry('account-2').provider.metrics, metrics);
  assert.equal((await pool.chat(messages, options)).content, 'account-2');
});
test('a candidate that breaks an authenticated account is rolled back before committing its pointer', async (t) => {
  const { pool, config, root, factory } = await setupAccounts(t); pool.add(); await pool.refresh(); pool.select('account-2');
  const upgraded = new CodexAccounts(config, join(root, 'data'), [], (profile, override) => {
    const runtime = factory(profile);
    if (override?.command === '/fixture/bad') runtime.status = async () => ({ ...runtime.cachedStatus(), authenticated: false, reasonCode: 'codex_auth_required' });
    return runtime;
  });
  t.after(() => upgraded.close()); await upgraded.initialize(); await upgraded.refresh();
  let committed = false;
  await assert.rejects(upgraded.replaceRuntime('/fixture/bad','1.2.4',async () => { committed = true; }), /codex_update_account_check_failed/);
  assert.equal(committed, false); assert.equal(upgraded.snapshot().selectedAccountId, 'account-2');
  assert.equal((await upgraded.chat(messages, options)).content, 'account-2');
});
test('runtime activation drains existing requests and rejects new management/inference until ready', async (t) => {
  const { pool } = await setupAccounts(t); let finish!: () => void;
  const generate = pool.entry().runtime.generate;
  pool.entry().runtime.generate = async (input) => { await new Promise<void>((resolve) => { finish = resolve; }); return generate(input); };
  const first = pool.chat(messages, options); while (!finish) await new Promise(setImmediate);
  const update = pool.replaceRuntime('/fixture/new', '1.2.4');
  await assert.rejects(pool.chat(messages, options), { code: 'codex_busy' }); assert.throws(() => pool.add(), /codex_busy/);
  assert.throws(() => pool.startUsage(), /codex_busy/); await assert.rejects(pool.refreshAccount(), /codex_busy/);
  finish(); assert.equal((await first).content, 'account-1'); await update;
  assert.equal((await pool.chat(messages, options)).content, 'account-1');
});
test('official latest does not offer runtime downgrades', () => {
  assert.equal(newerRuntime('0.160.0', '0.159.3'), true); assert.equal(newerRuntime('0.159.3','0.160.0'), false);
  assert.equal(newerRuntime('0.159.3','0.159.3'), false); assert.equal(newerRuntime('0.159.3','0.159.3-alpha.1'), true);
});

async function fixtureBundle(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'managed-codex-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'vendor/codex/linux-x64'); await mkdir(dir, { recursive: true });
  const binary = Buffer.from('isolated executable fixture'), zipped = gzipSync(binary);
  const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
  await writeFile(join(dir, 'codex.gz.001'), zipped);
  await writeFile(join(root, 'vendor/codex/manifest.json'), JSON.stringify({ version: '1.2.3', platform: 'linux-x64',
    sha256: sha(binary), archiveSha256: sha(zipped), archiveParts: 1, integrity: 'sha512-' + Buffer.alloc(64).toString('base64'), license: 'Apache-2.0' }));
  return { root, manager: new ManagedCodexRuntime(root, true) };
}
test('managed runtime prepares offline, verifies hashes, private pointer and ignores PATH', async (t) => {
  const { root, manager } = await fixtureBundle(t); const asset = await manager.prepare();
  assert.equal(asset?.version, '1.2.3'); assert(asset?.command.startsWith(join(root, '.runtime/codex/versions')));
  assert.equal((await readFile(asset!.command, 'utf8')), 'isolated executable fixture');
  assert.deepEqual(await new ManagedCodexRuntime(root, true).prepare(), asset);
  await writeFile(asset!.command, 'tampered');
  await assert.rejects(new ManagedCodexRuntime(root, true).prepare(), /codex_runtime_integrity_failed/);
});
test('bundled archive corruption and unsafe pointers fail closed', async (t) => {
  const { root, manager } = await fixtureBundle(t);
  await writeFile(join(root, 'vendor/codex/linux-x64/codex.gz.001'), 'tampered');
  await assert.rejects(manager.prepare(), /codex_runtime_integrity_failed/);
  await writeFile(join(root, '.runtime/codex/current.json'), '{}', { mode: 0o600 });
  await assert.rejects(manager.prepare(), /codex_runtime_pointer_invalid/);
});
test('update check is cached/public-safe; failed integrity keeps the active pointer and never activates', async (t) => {
  const { root, manager } = await fixtureBundle(t); await manager.prepare();
  const original = await readFile(join(root, '.runtime/codex/current.json'), 'utf8');
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/latest')) return Response.json({ name: '@openai/codex', version: '1.2.4' });
    if (url.endsWith('1.2.4-linux-x64')) return Response.json({ name: '@openai/codex', version: '1.2.4-linux-x64', dist: { integrity: 'sha512-' + Buffer.alloc(64).toString('base64'), tarball: 'https://registry.npmjs.org/@openai/codex/-/codex-1.2.4-linux-x64.tgz' } });
    return new Response('wrong integrity');
  });
  await manager.check(); assert.equal(manager.snapshot().updateAvailable, true);
  let activated = false; manager.update(async () => { activated = true; });
  assert.throws(() => manager.update(async () => {}), /codex_update_busy/);
  await manager.close(); assert.equal(activated, false); assert.equal(manager.snapshot().error, 'codex_update_integrity_failed');
  assert.equal(await readFile(join(root, '.runtime/codex/current.json'), 'utf8'), original);
  assert(!JSON.stringify(manager.snapshot()).includes(root));
});
test('runtime downloader rejects nonofficial URLs before requesting tarballs', async (t) => {
  const { root } = await fixtureBundle(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ name: '@openai/codex', version: '1.2.4-linux-x64', dist: { integrity: 'sha512-AA==', tarball: 'https://evil.example.test/artifact.tgz' } }); });
  await assert.rejects(downloadOfficialRuntime('1.2.4', join(root, 'download')), /codex_update_source_invalid/); assert.equal(calls, 1);
});
test('model discovery extends only Codex-opted apps, preserving explicit existing model exclusions', async (t) => {
  const { root } = await fixtureBundle(t); const store = new AppStore(join(root, 'apps.json'));
  const input = { name: 'fixture', allowedOrigins: ['*'], allowedModels: ['gpt-5.6-luna'], sessionNamespace: 'test', rateLimitPerMinute: 1, maxConcurrency: 1 };
  const enabled = store.create({ ...input, codexEnabled: true }).record, other = store.create(input).record;
  store.addDiscoveredCodexModels(['gpt-5.6-luna','gpt-5.6-sol','gpt-6.1-sol'], ['gpt-6.1-sol']);
  assert.deepEqual(enabled.allowedModels, ['gpt-5.6-luna','gpt-6.1-sol']); assert.deepEqual(other.allowedModels, ['gpt-5.6-luna']);
});
test('public update status is read-only and admin update requires authorized mutation', async (t) => {
  const { pool } = await setupAccounts(t); const { manager } = await fixtureBundle(t); await manager.prepare();
  const app = Fastify(); t.after(() => app.close());
  const requireAdmin = (r: any, p: any) => { if (r.headers.authorization === 'Bearer fixture-admin') return true; p.code(401).send({ error: 'unauthorized' }); return false; };
  registerCodexAccountRoutes(app, pool, { ensureAdmin: requireAdmin, ensureAdminMutation: requireAdmin, adminCsrf: () => null, audit: () => {} }, manager);
  const publicStatus = await app.inject({ url: '/dashboard/codex/runtime' }); assert.equal(publicStatus.statusCode, 200); assert.equal(publicStatus.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ method: 'POST', url: '/admin/codex/runtime/update', payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/codex/runtime/update', headers: { authorization: 'Bearer fixture-admin' }, payload: { url: 'https://evil.example.test' } })).statusCode, 400);
});

async function notifier(t: any, fail = false) {
  const root = await mkdtemp(join(tmpdir(), 'telegram-alert-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const requests: any[] = []; let now = 1900000000000;
  const config = { enabled: true, token: 'fixture-token-not-real', chatIds: ['101','202'] };
  const transport: typeof fetch = async (url: any, options: any) => { requests.push(JSON.parse(options.body)); if (fail) throw Error(String(url)); return Response.json({ ok: true }); };
  const file = join(root, 'state.json');
  const alerts = new TelegramAlerts(config, file, transport, () => now);
  return { root, alerts, requests, config, file, transport, advance: () => { now += 1; } };
}
test('Telegram alerts use only authorized destinations, once per incident, including across restarts', async (t) => {
  const f = await notifier(t); f.alerts.condition('codex:test', true, 'Quota exhausted'); f.alerts.condition('codex:test', true, 'duplicate'); await f.alerts.close();
  assert.deepEqual(f.requests.map((r) => r.chat_id), ['101','202']);
  const restarted = new TelegramAlerts(f.config, f.file, f.transport); restarted.condition('codex:test', true, 'duplicate'); await restarted.close(); assert.equal(f.requests.length, 2);
  f.advance(); f.alerts.condition('codex:test', false, ''); f.alerts.condition('codex:test', true, 'new incident'); await f.alerts.close(); assert.equal(f.requests.length, 4);
});
test('Telegram failures are sanitized and cooldown-bounded, never propagated into inference', async (t) => {
  const f = await notifier(t, true); f.alerts.critical('codex_update_failed'); await f.alerts.close();
  assert.equal(f.requests.length, 2); assert(!JSON.stringify(f.alerts.snapshot()).includes(f.config.token));
  f.alerts.critical('codex_update_failed'); await f.alerts.close(); assert.equal(f.requests.length, 2);
  assert.equal(f.alerts.snapshot().delivery[0].code, 'telegram_delivery_failed');
});
test('Telegram does not alert on a never-connected second slot or isolated transient errors', async (t) => {
  const { pool, states } = await setupAccounts(t); const f = await notifier(t);
  pool.add(); states[1].authenticated = false; await pool.refresh();
  for (let i = 0; i < 4; i++) f.alerts.observe(pool);
  f.alerts.recordOutcome('account-1','codex_timeout'); f.alerts.recordOutcome('account-1','codex_timeout'); await f.alerts.close(); assert.equal(f.requests.length, 0);
  f.alerts.recordOutcome('account-1','codex_timeout'); await f.alerts.close(); assert.equal(f.requests.length, 2);
  f.alerts.recordOutcome('account-1',null); f.advance();
  states[0].authenticated = false; await pool.refresh();
  for (let i = 0; i < 3; i++) f.alerts.observe(pool);
  await f.alerts.close(); assert(f.requests.some((r) => r.text.includes('login/runtime unavailable')));
  assert(!JSON.stringify(f.requests).includes('@'));
});
test('Telegram config validates bounded numeric destinations and does not enable itself by default', () => {
  assert.equal(readTelegramConfig({}).enabled, false);
  assert.throws(() => readTelegramConfig({ GEMROUTER_TELEGRAM_BOT_TOKEN: 'invalid' }));
  assert.throws(() => readTelegramConfig({ GEMROUTER_TELEGRAM_CHAT_IDS: '@arbitrary' }));
});
