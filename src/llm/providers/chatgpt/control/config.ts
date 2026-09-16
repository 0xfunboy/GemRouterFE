import os from 'node:os';
import path from 'node:path';

export interface PersonalControlConfig {
  enabled: boolean;
  command: string;
  privateDirectory: string;
  codexProfile: string;
  browserProfile: string;
  uiProfilePath?: string;
  browserExecutable: string;
  requestedModel: string;
  reasoningEffort: string;
  operationTimeoutMs: number;
  pollIntervalMs: number;
}

/** Pure configuration: never starts a runtime, browser, or login. */
export function readPersonalControlConfig(env: NodeJS.ProcessEnv = process.env): PersonalControlConfig {
  const enabled = env.GEMROUTER_CHATGPT_CONTROL_ENABLED === 'true';
  const privateDirectory = path.resolve(env.GEMROUTER_CHATGPT_CONTROL_PRIVATE_DIR || path.join(os.homedir(), '.local/share/gemrouter-personal-control'));
  const timeout = Number(env.GEMROUTER_CHATGPT_CONTROL_TIMEOUT_MS || 45_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 120_000) throw new Error('Invalid personal control timeout (1000–120000 ms).');
  const command = env.GEMROUTER_CHATGPT_CONTROL_CODEX || 'codex';
  if (!command || /[\r\n\0]/u.test(command)) throw new Error('Invalid Codex executable.');
  return {
    enabled, command, privateDirectory,
    codexProfile: path.join(privateDirectory, 'codex'),
    browserProfile: path.join(privateDirectory, 'browser'),
    uiProfilePath: env.GEMROUTER_CHATGPT_CONTROL_UI_PROFILE,
    browserExecutable: env.GEMROUTER_CHATGPT_CONTROL_BROWSER || '/usr/bin/google-chrome',
    // The runtime verifies this requested id against model/list; no fallback.
    requestedModel: env.GEMROUTER_CHATGPT_CONTROL_MODEL || 'gpt-6-astra',
    reasoningEffort: env.GEMROUTER_CHATGPT_CONTROL_EFFORT || 'high',
    operationTimeoutMs: timeout,
    pollIntervalMs: 250,
  };
}
