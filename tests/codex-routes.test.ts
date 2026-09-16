import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerCodexAccountRoutes } from '../src/codex/routes.js';
import { setupAccounts } from './helpers/codex-accounts-fixture.js';

test('multi-account routes protect mutations, expose no emails and never block on usage', async (t) => {
  const {pool,states}=await setupAccounts(t);
  const app=Fastify();t.after(()=>app.close());const audit:unknown[]=[];
  let owner='';
  pool.entry().runtime.startLogin=async(id)=>{owner=id;return {status:'pending',mode:'device',expiresAt:Date.now()+1000,userCode:'FAKE-CODE'};};
  registerCodexAccountRoutes(app,pool,{
    ensureAdmin:(req,reply)=>{if(req.headers.authorization==='Bearer fixture')return true;reply.code(401).send();return false;},
    ensureAdminMutation:(req,reply)=>{if(req.headers.authorization==='Bearer fixture'&&req.headers['x-csrf']==='fixture')return true;reply.code(403).send();return false;},
    adminCsrf:()=>null,audit:(event)=>audit.push(event),
  });
  assert.equal((await app.inject('/admin/codex/account')).statusCode,401);
  const publicResponse=await app.inject('/dashboard/codex-quota');assert.equal(publicResponse.statusCode,200);
  assert(!publicResponse.body.includes('@'));assert(!publicResponse.body.includes('profileDirectory'));
  const headers={authorization:'Bearer fixture','x-csrf':'fixture'};
  const call=(action:string,payload:unknown={},authorized=true)=>app.inject({method:'POST',url:'/admin/codex/'+action,headers:authorized?headers:{authorization:'Bearer fixture'},payload});
  assert.equal((await call('accounts',{},false)).statusCode,403);
  assert.equal((await call('account/select',{accountId:'account-1'},false)).statusCode,403);
  assert.equal((await call('account/login',{mode:'browser'})).statusCode,400);
  assert.equal((await call('account/refresh',{accountId:'../../auth.json'})).statusCode,400);
  assert.equal((await call('account/login')).json().error,'codex_account_already_connected');
  states[0].authenticated=false;
  const login=await call('account/login'); assert.equal(login.json().userCode,'FAKE-CODE'); assert.match(owner,/^[a-f0-9]{64}$/);
  const created=await call('accounts');assert.equal(created.statusCode,201);assert.equal(created.json().account.id,'account-2');
  assert.equal(created.json().selectedAccountId,'account-1');
  states[1].authenticated=false;
  assert.equal((await call('account/select',{accountId:'account-2'})).json().error,'codex_account_not_ready');
  states[1].authenticated=true;
  await pool.refresh();
  assert.equal((await call('account/select',{accountId:'account-2'})).statusCode,200);
  assert.equal((await call('accounts')).json().error,'codex_account_limit');
  pool.entry().runtime.usage=async()=>{throw new Error('PRIVATE_RUNTIME_TOKEN');};
  assert.equal((await call('account/usage')).statusCode,202);await new Promise(setImmediate);
  const read=await app.inject({url:'/admin/codex/account/usage',headers});assert.equal(read.json().error,'codex_usage_unavailable');
  const snapshot=await app.inject({url:'/admin/codex/account',headers});
  assert.equal(snapshot.headers['cache-control'],'no-store');assert(!snapshot.body.includes('@'));
  assert(!JSON.stringify(audit).includes('FAKE-CODE'));assert(!JSON.stringify(audit).includes('PRIVATE_RUNTIME_TOKEN'));
});
