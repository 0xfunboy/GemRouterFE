/** Administrative diagnostic only. No router instance, threads, database or secret output. */
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config.js';
import { inferModelCapabilities, isRetiredGeminiModelId } from '../src/lib/models.js';
import { fetchGeminiCatalog } from '../src/llm/providers/gemini-api/catalogApi.js';

const args = process.argv.slice(2);
if (args.some((arg) => !['--probe', '--apply'].includes(arg) && !arg.startsWith('--models='))) throw new Error('Usage: pnpm census:gemini [--probe] [--models=ID,ID] [--apply]');
const probing = args.includes('--probe'), applying = args.includes('--apply');
if (applying && !probing) throw new Error('--apply requires --probe; model listing alone is not entitlement evidence.');
const environment = () => ({ ...process.env, ...dotenv.parse(readFileSync('.env')) });
const config = loadConfig(environment());
if (probing) {
  // Fail before any generation or policy mutation if the live service is down.
  const response = await fetch(`http://127.0.0.1:${config.port}/admin/provider/gemini-api/accounts`, {
    headers: { authorization: `Bearer ${config.adminToken}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response?.ok) throw new Error('live_service_unavailable_or_admin_auth_failed');
}
const selected = args.find((arg) => arg.startsWith('--models='))?.slice(9).split(',').filter(Boolean);
if (selected?.some((id) => !/^(?:gemini|gemma)-[a-z0-9.-]+$/.test(id))) throw new Error('Invalid model identifier.');
const keys = config.geminiApi.keys.filter((key) => key.enabled);
let next = 0;
await Promise.all(Array.from({ length: Math.min(2, keys.length) }, async () => {
  for (;;) {
    const key = keys[next++]; if (!key) break;
    const at = new Date().toISOString();
    try {
      const catalog = await fetchGeminiCatalog(config.geminiApi, key.key);
      const text = catalog.filter((m) => {
        const id = m.name.replace(/^models\//, '');
        const flags = inferModelCapabilities(id, m.supportedGenerationMethods);
        return /^(?:gemini|gemma)-/.test(id) && flags.chat && !flags.imageGeneration && !isRetiredGeminiModelId(id);
      }).map((m) => m.name.replace(/^models\//, ''));
      const targets = selected ?? [...new Set([...config.geminiApi.fallbackModelIds, ...Object.keys(config.geminiApi.limits)])]
        .filter((id) => text.includes(id) && (!key.models?.length || key.models.includes(id)));
      if (targets.some((id) => !text.includes(id))) throw new Error('selected_model_not_in_text_catalog');
      const observations = [];
      if (probing) for (const model of targets) {
        const started = Date.now();
        try {
          const response = await fetch(`http://127.0.0.1:${config.port}/admin/provider/gemini-api/accounts/probe-model`, {
            method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ accountId: key.id, model }), signal: AbortSignal.timeout(45_000),
          });
          const payload = await response.json() as { ok?: boolean; status?: number; access?: string; ms?: number; tokens?: number };
          if (!response.ok || !payload.ok) process.exitCode = 1;
          observations.push({ model, status: response.ok && payload.ok ? payload.status ?? null : null, ms: payload.ms ?? Date.now() - started,
            access: response.ok && payload.ok ? payload.access ?? 'inconclusive' : 'inconclusive', tokens: payload.tokens ?? null });
        } catch { process.exitCode = 1; observations.push({ model, status: null, ms: Date.now() - started, access: 'inconclusive', tokens: null }); }
      }
      const denied = observations.filter((o) => ['model_not_found', 'quota_limit_zero'].includes(o.access)).map((o) => o.model);
      let applied = false;
      if (applying && denied.length) {
        // Never overwrite another operator's edits/key rotation made during a long census.
        const currentConfig = loadConfig(environment());
        const current = currentConfig.geminiApi.keys.find((k) => k.id === key.id);
        if (!current || current.key !== key.key || JSON.stringify(current.models) !== JSON.stringify(key.models) || !current.enabled) throw new Error('account_changed_during_census');
        const models = (current.models?.length ? current.models : catalog.filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, '')))
          .filter((id) => !denied.includes(id) && !isRetiredGeminiModelId(id));
        // An empty models array means unrestricted in existing account policy.
        if (!models.length) throw new Error('all_models_denied_manual_review_required');
        const response = await fetch(`http://127.0.0.1:${currentConfig.port}/admin/provider/gemini-api/accounts/update`, {
          method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${currentConfig.adminToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ id: key.id, models }), signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error('live_account_update_failed');
        applied = true;
      }
      console.log(JSON.stringify({ accountId: key.id, at, listedTextModels: text, configuredTier: key.tier,
        tierVerified: false, observations, excluded: denied, applied, source: probing ? 'live-list-and-inference' : 'live-list-only' }));
    } catch (error) {
      // Never print upstream messages, URLs, account identities or credentials.
      const code = error instanceof Error && /^(?:gemini_catalog_[a-z0-9_]+|selected_model_not_in_text_catalog|account_changed_during_census|all_models_denied_manual_review_required|live_account_update_failed)$/.test(error.message)
        ? error.message : 'census_failed';
      console.log(JSON.stringify({ accountId: key.id, at, error: code, applied: false }));
      process.exitCode = 1;
    }
  }
}));
