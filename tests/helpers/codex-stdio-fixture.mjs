#!/usr/bin/env node
// Deterministic protocol fixture. Never authenticates or contacts any service.
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.154.0-alpha.6.2'); process.exit(0); }
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const models = ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra'];
let sequence = 0;
let authenticated = !process.env.CODEX_HOME?.endsWith('codex-account-2');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line); if (!message.id) return;
  const reply = (result) => send({ id: message.id, result });
  const params = message.params ?? {};
  if (message.method === 'initialize') reply({ codexHome: process.env.CODEX_HOME });
  else if (message.method === 'config/read') {
    const features = Object.fromEntries(process.argv.filter((a) => a.startsWith('features.')).map((a) => { const [key, value] = a.split('='); return [key.slice(9), JSON.parse(value)]; }));
    reply({ config: { features, forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file', web_search: 'disabled', apps: { _default: { enabled: false } }, mcp_servers: {}, plugins: {} } });
  } else if (message.method === 'account/read') reply({ account: authenticated ? { type: 'chatgpt', email: 'fixture@example.test', planType: 'pro' } : null });
  else if (message.method === 'account/login/start') {
    reply({ type: 'chatgptDeviceCode', loginId: 'fixture-login', userCode: 'FAKE-CODE', verificationUrl: 'https://auth.openai.com/codex/device' });
    setTimeout(() => { authenticated = true; send({ method:'account/login/completed', params:{loginId:'fixture-login',success:true} }); }, 1500);
  }
  else if (message.method === 'account/logout') { authenticated=false; reply({}); }
  else if (message.method === 'model/list') reply({ data: models.map((model) => ({ id: model, model, displayName: model, supportedReasoningEfforts: ['low', 'high'].map((reasoningEffort) => ({ reasoningEffort })) })), nextCursor: null });
  else if (message.method === 'account/rateLimits/read') reply({ rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+3600 }, secondary:{usedPercent:69,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400} },
    codex_bengalfox: {limitId:'codex_bengalfox',secondary:{usedPercent:2,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+172800}},
  } });
  else if (message.method === 'account/usage/read') reply({ summary: { lifetimeTokens: 1000 }, dailyUsageBuckets: [] });
  else if (message.method === 'thread/start') reply({ thread: { id: 'thread-'+(++sequence) }, model: params.model, cwd: params.cwd, approvalPolicy: 'never', sandbox: { type: 'readOnly' }, runtimeWorkspaceRoots: [], instructionSources: [] });
  else if (message.method === 'turn/start') {
    const turn = { id: 'turn-'+sequence, status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', id: 'answer-'+sequence, text: params.outputSchema ? '{"ok":true}' : 'CODEX_PROVIDER_OK' }] };
    reply({ turn: { id: turn.id } });
    const context = { threadId: params.threadId, turnId: turn.id };
    send({ method: 'turn/started', params: { ...context, turn: { id: turn.id } } });
    send({ method: 'thread/tokenUsage/updated', params: { ...context, tokenUsage: { total: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40, reasoningOutputTokens: 10 } } } });
    send({ method: 'item/completed', params: { ...context, item: turn.items[0] } });
    send({ method: 'turn/completed', params: { ...context, turn } });
  } else reply({});
});
