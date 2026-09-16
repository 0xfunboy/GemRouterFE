import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts } from '../../src/codex/accounts.js';
import { readCodexConfig } from '../../src/codex/config.js';
import { CodexRuntime, type CodexAccountState } from '../../src/codex/runtime.js';

export async function setupAccounts(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'codex-accounts-test-'));
  const config = readCodexConfig({ GEMROUTER_CODEX_ENABLED: 'true', GEMROUTER_CODEX_PRIVATE_DIR: join(root, 'private') });
  const profiles: string[] = [], states: CodexAccountState[] = [];
  const factory = (profileDirectory: string) => {
    profiles.push(profileDirectory);
    const number = profileDirectory.endsWith('codex-account-2') ? 2 : 1;
    const state: CodexAccountState = { enabled: true, running: true, authenticated: true, email: `fixture${number}@example.test`,
      accountType: 'chatgpt', planType: 'pro', runtimeVersion: 'fixture', requestedModel: 'gpt-6-astra', modelAvailable: true, reasonCode: null };
    states.push(state);
    const runtime = new CodexRuntime({ ...config, profileDirectory });
    runtime.cachedStatus = () => ({ ...state }); runtime.status = async () => ({ ...state });
    Object.defineProperty(runtime, 'readyCached', { get: () => state.authenticated && state.modelAvailable });
    Object.defineProperty(runtime, 'connectedCached', { get: () => state.authenticated });
    runtime.models = async () => config.models.map((model) => ({ id: model, model, displayName: model, supportedReasoningEfforts: ['low','high'] }));
    runtime.quota = async () => [{ limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: number === 1 ? 69 : 2, windowDurationMins: 10080, resetsAt: 1900001000 } },
      { limitId: 'codex_bengalfox', primary: null, secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1900002000 } }];
    runtime.generate = async (input) => ({ model: input.model, reasoningEffort: input.reasoningEffort, content: `account-${number}`, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 } });
    runtime.logout = async () => { state.authenticated = false; state.email = null; };
    return runtime;
  };
  const pool = new CodexAccounts(config, join(root, 'data'), [join(root, 'data')], factory);
  t.after(async () => { await pool.close(); await rm(root, { recursive: true, force: true }); });
  await pool.initialize(); await pool.refresh();
  return { root, config, pool, profiles, states, factory };
}
