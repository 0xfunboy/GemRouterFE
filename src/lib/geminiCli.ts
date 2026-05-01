import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type {
  GeminiCliHealthSnapshot,
  GeminiCliProviderConfig,
} from '../llm/providers/gemini-cli/types.js';

interface GeminiCliAuthFiles {
  settingsPath: string;
  oauthCredsPath: string;
  googleAccountsPath: string;
  envPath: string;
}

export interface GeminiCliRuntimeState {
  lastError?: string | null;
  lastSuccessAt?: string | null;
  lastLatencyMs?: number | null;
}

export interface GeminiCliInstallCheck {
  resolvedBin: string | null;
  installed: boolean;
  version: string | null;
  error: string | null;
}

function trimLines(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

export function resolveGeminiCliUserHome(config: GeminiCliProviderConfig): string | null {
  if (config.userHome?.trim()) return path.resolve(config.userHome);
  if (config.dotGeminiDir?.trim()) {
    const explicit = path.resolve(config.dotGeminiDir);
    if (path.basename(explicit) === '.gemini') return path.dirname(explicit);
  }
  const home = process.env.HOME?.trim();
  return home ? path.resolve(home) : null;
}

export function resolveGeminiCliDotDir(config: GeminiCliProviderConfig): string {
  if (config.dotGeminiDir?.trim()) return path.resolve(config.dotGeminiDir);
  const home = resolveGeminiCliUserHome(config);
  return path.join(home ?? config.rootDir, '.gemini');
}

export function resolveGeminiCliWorkdir(config: GeminiCliProviderConfig): string {
  if (config.workdir?.trim()) return path.resolve(config.workdir);
  return path.resolve(config.rootDir);
}

export function resolveGeminiCliBinCandidates(config: GeminiCliProviderConfig): string[] {
  const configured = config.bin.trim() || 'gemini';
  const localBin = path.join(config.rootDir, 'node_modules', '.bin', configured);
  const candidates = configured.includes(path.sep)
    ? [path.resolve(resolveGeminiCliWorkdir(config), configured)]
    : [localBin, configured];
  return [...new Set(candidates)];
}

function readAuthFiles(config: GeminiCliProviderConfig): GeminiCliAuthFiles {
  const dotDir = resolveGeminiCliDotDir(config);
  return {
    settingsPath: path.join(dotDir, 'settings.json'),
    oauthCredsPath: path.join(dotDir, 'oauth_creds.json'),
    googleAccountsPath: path.join(dotDir, 'google_accounts.json'),
    envPath: path.join(dotDir, '.env'),
  };
}

export function buildGeminiCliEnv(config: GeminiCliProviderConfig): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...process.env };
  const userHome = resolveGeminiCliUserHome(config);
  if (userHome) {
    nextEnv.HOME = userHome;
    nextEnv.USERPROFILE = userHome;
  }

  // Keep router auth separate from any paid Gemini key path.
  delete nextEnv.GEMINI_API_KEY;
  delete nextEnv.GOOGLE_API_KEY;
  delete nextEnv.GOOGLE_GENAI_USE_VERTEXAI;

  return nextEnv;
}

export function checkGeminiCliInstall(config: GeminiCliProviderConfig): GeminiCliInstallCheck {
  const env = buildGeminiCliEnv(config);
  for (const candidate of resolveGeminiCliBinCandidates(config)) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) continue;
    try {
      const result = spawnSync(candidate, ['--version'], {
        env,
        cwd: resolveGeminiCliWorkdir(config),
        encoding: 'utf8',
        timeout: 2_500,
      });
      const stdout = trimLines(result.stdout ?? '');
      const stderr = trimLines(result.stderr ?? '');
      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return {
          resolvedBin: candidate,
          installed: false,
          version: null,
          error: result.error.message,
        };
      }

      const combined = stdout || stderr;
      return {
        resolvedBin: candidate,
        installed: result.status === 0 || Boolean(combined),
        version: combined.split('\n')[0] ?? null,
        error: result.status === 0 ? null : stderr || stdout || `process exited with ${String(result.status)}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        resolvedBin: candidate,
        installed: false,
        version: null,
        error: message,
      };
    }
  }

  return {
    resolvedBin: null,
    installed: false,
    version: null,
    error: 'gemini binary not found',
  };
}

export function detectGeminiCliAuth(config: GeminiCliProviderConfig): {
  dotGeminiDir: string;
  settingsExists: boolean;
  authCacheDetected: boolean;
  authCacheFiles: string[];
} {
  const dotGeminiDir = resolveGeminiCliDotDir(config);
  const authFiles = readAuthFiles(config);
  const authCacheFiles = [authFiles.oauthCredsPath, authFiles.googleAccountsPath].filter((file) => existsSync(file));
  return {
    dotGeminiDir,
    settingsExists: existsSync(authFiles.settingsPath),
    authCacheDetected: authCacheFiles.length > 0,
    authCacheFiles,
  };
}

export function buildGeminiCliLoginHint(config: GeminiCliProviderConfig): string {
  return `bash ./scripts/login-gemini-cli.sh`;
}

export function buildGeminiCliHealthSnapshot(
  config: GeminiCliProviderConfig,
  runtimeState: GeminiCliRuntimeState = {},
): GeminiCliHealthSnapshot {
  const install = checkGeminiCliInstall(config);
  const auth = detectGeminiCliAuth(config);
  return {
    enabled: config.enabled,
    bin: config.bin,
    resolvedBin: install.resolvedBin,
    installed: install.installed,
    version: install.version,
    model: config.model,
    timeoutMs: config.timeoutMs,
    workdir: resolveGeminiCliWorkdir(config),
    userHome: resolveGeminiCliUserHome(config),
    dotGeminiDir: auth.dotGeminiDir,
    settingsExists: auth.settingsExists,
    authCacheDetected: auth.authCacheDetected,
    authCacheFiles: auth.authCacheFiles,
    authReady: auth.authCacheDetected || !config.expectAuthCache,
    outputFormat: config.outputFormat,
    useStdin: config.useStdin,
    bootstrapEnabled: config.authBootstrapEnabled,
    bootstrapMode: config.authBootstrapMode,
    loginHint: buildGeminiCliLoginHint(config),
    lastError: runtimeState.lastError ?? null,
    lastSuccessAt: runtimeState.lastSuccessAt ?? null,
    lastLatencyMs: runtimeState.lastLatencyMs ?? null,
  };
}
