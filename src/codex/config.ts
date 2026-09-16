import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_MODELS } from './models.js';

export function readCodexConfig(env: NodeJS.ProcessEnv = process.env) {
  // Keep the established authenticated profile. No credential copy or new login required.
  const privateDirectory = env.GEMROUTER_CODEX_PRIVATE_DIR?.trim()
    || env.GEMROUTER_CHATGPT_CONTROL_PRIVATE_DIR?.trim()
    || join(homedir(), '.local/share/gemrouter-personal-control');
  const command = env.GEMROUTER_CODEX_COMMAND?.trim() || env.GEMROUTER_CHATGPT_CONTROL_COMMAND?.trim() || 'codex';
  if (/[\r\n\0]/.test(command)) throw new Error('Invalid Codex executable.');
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  return {
    enabled: env.GEMROUTER_CODEX_ENABLED === 'true', command, privateDirectory,
    profileDirectory: join(privateDirectory, 'codex'),
    requestedModel: env.GEMROUTER_CODEX_MODEL?.trim() || 'gpt-6-astra',
    reasoningEffort: env.GEMROUTER_CODEX_REASONING_EFFORT?.trim() || 'high',
    models: [...CODEX_MODELS] as string[],
    timeoutMs: bounded('GEMROUTER_CODEX_TIMEOUT_MS', 120_000, 1000, 600_000),
    maxQueued: bounded('GEMROUTER_CODEX_MAX_QUEUED', 16, 0, 128),
    quotaRefreshMs: bounded('GEMROUTER_CODEX_QUOTA_REFRESH_MS', 30_000, 1000, 300_000),
    fallbackEnabled: env.GEMROUTER_CODEX_FALLBACK_ENABLED !== 'false',
  };
}
export type CodexConfig = ReturnType<typeof readCodexConfig>;
