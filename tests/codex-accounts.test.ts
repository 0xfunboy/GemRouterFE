import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexAccounts, safeAccount } from '../src/codex/accounts.js';

import { setupAccounts } from './helpers/codex-accounts-fixture.js';

test('account aliases, public quota and all snapshots omit email; longest window and unknown stay accurate', async (t) => {
  const { pool, states } = await setupAccounts(t);
  assert.equal(safeAccount(states[0]).alias, 'Account 1 FX');
  assert(!('email' in pool.snapshot().account));
  const publicData = pool.publicQuota();
  assert.equal(publicData.accounts.length, 1);
  assert.equal(publicData.accounts[0].quotas.length, 2);
  assert.equal(publicData.accounts[0].quotas[0].window?.usedPercent, 69);
  assert.equal(publicData.accounts[0].quotas[0].window?.windowDurationMins, 10080);
  assert(!JSON.stringify([pool.snapshot(),publicData]).includes('@'));
  assert(!JSON.stringify(publicData).includes('planType'));
  pool.entry().provider.invalidate();
  assert.equal(pool.publicQuota().accounts[0].quotas[0].window, null);
});

test('two isolated profiles, persistent manual selection, private registry and independent counters', async (t) => {
  const { root, config, pool, profiles, factory } = await setupAccounts(t);
  const initialProfile = profiles[0];
  pool.add(); await pool.refresh(); pool.select('account-2');
  assert.equal(initialProfile, join(config.privateDirectory, 'codex'));
  assert.equal(profiles[1], join(config.privateDirectory, 'codex-account-2'));
  assert.throws(() => pool.add(), /codex_account_limit/);
  assert.throws(() => pool.select('../../auth.json'), /codex_account_not_found/);
  const registry = await readFile(join(config.privateDirectory, 'accounts.json'), 'utf8');
  assert(!registry.includes('@')); assert(!registry.includes('token'));
  assert.equal((await stat(join(config.privateDirectory, 'accounts.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(config.privateDirectory)).mode & 0o777, 0o700);
  const input = { model:'gpt-5.6-luna', codex:{enabled:true,reasoningEffort:'low',fallbackEnabled:false} };
  assert.equal((await pool.chat([{role:'user',content:'fixture'}],input)).content,'account-2');
  assert.equal(pool.snapshot('account-1').provider.metrics.totals.received,0);
  assert.equal(pool.snapshot('account-2').provider.metrics.totals.totalTokens,5);
  const restored = new CodexAccounts(config,join(root,'data'),[],factory); t.after(() => restored.close());
  await restored.initialize(); assert.equal(restored.snapshot().selectedAccountId,'account-2');
  assert.equal(restored.snapshot().provider.metrics.totals.totalTokens,5);
});

test('switching does not move in-flight or queued inference; destructive account actions reject while busy', async (t) => {
  const { pool } = await setupAccounts(t); pool.add(); await pool.refresh();
  const oldGenerate = pool.entry('account-1').runtime.generate;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered=resolve; });
  pool.entry('account-1').runtime.generate = async (input) => { entered(); await new Promise<void>((resolve) => {release=resolve;}); return oldGenerate(input); };
  const options = {model:'gpt-5.6-luna',codex:{enabled:true,reasoningEffort:'low',fallbackEnabled:false}};
  const first = pool.chat([{role:'user',content:'test'}],options); await started;
  const queued = pool.chat([{role:'user',content:'test'}],options);
  pool.select('account-2');
  await assert.rejects(pool.manage('account-1',async(e)=>e.runtime.logout()),/codex_busy/);
  assert.equal((await pool.chat([{role:'user',content:'test'}],options)).content,'account-2');
  pool.entry('account-1').runtime.generate = oldGenerate; release();
  assert.equal((await first).content,'account-1'); assert.equal((await queued).content,'account-1');
});

test('registry tampering and symlinks are rejected rather than resetting account selection', async (t) => {
  const { pool, root, config, factory } = await setupAccounts(t);
  const file=join(config.privateDirectory,'accounts.json');
  await writeFile(file,JSON.stringify({version:1,selected:'account-2',accounts:['account-1']}));
  const broken = new CodexAccounts(config,join(root,'data'),[],factory); t.after(()=>broken.close());
  await assert.rejects(broken.initialize(),/codex_accounts_registry_invalid/);
  await rm(file); await symlink(join(root,'absent'),file);
  await assert.rejects(broken.initialize(),/codex_accounts_registry_invalid/);
  assert.equal(pool.snapshot().selectedAccountId,'account-1');
});

test('account usage is asynchronous, single-flight, sanitized, and old results are invalidated on logout', async (t) => {
  const { pool } = await setupAccounts(t);
  let reject!: (e: Error) => void, count=0;
  pool.entry().runtime.usage=()=>{count++;return new Promise((_resolve,no)=>{reject=no;});};
  assert.equal(pool.startUsage().status,'pending'); assert.equal(pool.startUsage().status,'pending'); assert.equal(count,1);
  reject(new Error('PRIVATE_UPSTREAM_EMAIL_AND_TOKEN')); await new Promise(setImmediate);
  assert.equal(pool.snapshot().usage.error,'codex_usage_unavailable');
  assert(!JSON.stringify(pool.snapshot()).includes('PRIVATE_UPSTREAM'));
  pool.startUsage(); await pool.manage(undefined,async(e)=>e.runtime.logout());
  reject(new Error('late')); await new Promise(setImmediate);
  assert.equal(pool.snapshot().usage.status,'idle');
});

test('usage timeout is bounded and a late upstream result cannot overwrite it', async (t) => {
  const {pool}=await setupAccounts(t);
  let resolve!: (value:any)=>void;
  pool.entry().runtime.usage=()=>new Promise((done)=>{resolve=done;});
  t.mock.timers.enable({apis:['setTimeout']});
  pool.startUsage(); t.mock.timers.tick(20_000); await new Promise(setImmediate);
  assert.equal(pool.snapshot().usage.status,'failed');
  assert.equal(pool.snapshot().usage.error,'codex_usage_timeout');
  resolve({observedAt:new Date().toISOString(),usage:{summary:{lifetimeTokens:999}},quota:null});
  await new Promise(setImmediate);assert.equal(pool.snapshot().usage.status,'failed');
  t.mock.timers.reset();
});

test('disconnecting the second account preserves the first login and first metrics', async (t) => {
  const {pool}=await setupAccounts(t);pool.add();await pool.refresh();
  await pool.manage('account-2',async(e)=>{await e.runtime.logout();e.provider.invalidate();});
  assert.equal(pool.snapshot('account-1').account.authenticated,true);
  assert.equal(pool.snapshot('account-2').account.authenticated,false);
  assert.throws(()=>pool.select('account-2'),/codex_account_not_ready/);
  assert.equal(pool.snapshot().selectedAccountId,'account-1');
});

test('a quota refresh completing after disconnect cannot restore the old account snapshot', async (t) => {
  const {pool}=await setupAccounts(t);
  let started!:()=>void, resolve!:(value:any)=>void;
  const entered=new Promise<void>((done)=>{started=done;});
  pool.entry().runtime.quota=()=>{started();return new Promise((done)=>{resolve=done;});};
  const refresh=pool.refresh();await entered;
  await pool.manage(undefined,async(e)=>{await e.runtime.logout();e.provider.invalidate();});
  resolve([{limitId:'codex',primary:{usedPercent:75,windowDurationMins:300,resetsAt:1900000000},secondary:null}]);
  await refresh;
  assert.equal(pool.snapshot().provider.quota,null);
  assert.deepEqual(pool.snapshot().provider.models,[]);
});

test('an account with only a subset of allowed models can still be selected', async (t) => {
  const {pool,states}=await setupAccounts(t);pool.add();states[1].modelAvailable=false;
  pool.entry('account-2').runtime.models=async()=>[{id:'gpt-5.6-luna',model:'gpt-5.6-luna',displayName:'Luna',supportedReasoningEfforts:['low']}];
  await pool.refresh();pool.select('account-2');
  assert.equal(pool.snapshot().selectedAccountId,'account-2');
  assert.equal(pool.snapshot().account.inferenceAvailable,true);
  assert.deepEqual(pool.getDiagnostics().models.map((m)=>m.model),['gpt-5.6-luna']);
});
