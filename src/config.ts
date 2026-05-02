import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { coerceCompatibilityState, type ApiSurface } from './lib/compatibility.js';
import { buildPublicModelIds, DEFAULT_DIRECT_MODEL_IDS } from './lib/models.js';
import type { LLMBackendId } from './llm/types.js';
import type { GeminiCliProviderConfig } from './llm/providers/gemini-cli/types.js';
import type { TeGemProviderConfig } from './llm/providers/tegem/client.js';

export interface BootstrapAppConfig {
  name: string;
  apiKey: string;
  allowedOrigins: string[];
  allowedModels: string[];
  sessionNamespace: string;
  rateLimitPerMinute: number;
  maxConcurrency: number;
  concurrencyWaitMs: number;
}

export interface DashboardAdminUser {
  username: string;
  password: string;
}

export interface RuntimeConfig {
  host: string;
  port: number;
  rootDir: string;
  dataDir: string;
  dashboardEnabled: boolean;
  adminToken: string;
  adminSessionTtlMs: number;
  dashboardAdminUsers: DashboardAdminUser[];
  bootstrapApp: BootstrapAppConfig;
  compatibility: {
    settingsStorePath: string;
    defaultSurface: ApiSurface;
    enabledSurfaces: ApiSurface[];
  };
  geminiCli: GeminiCliProviderConfig;
  llmRouting: {
    backendOrder: LLMBackendId[];
    allowPlaywrightFallback: boolean;
    retryOnCliAuthFailure: boolean;
  };
  llm: TeGemProviderConfig;
  modelIds: string[];
  auditLogPath: string;
  appsStorePath: string;
  interactionsStorePath: string;
  publicBaseUrl?: string;
  vncPublicUrl?: string;
}

function pick(env: Record<string, string | undefined>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function readBoolean(env: Record<string, string | undefined>, fallback: boolean, ...keys: string[]): boolean {
  const value = pick(env, ...keys);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readNumber(env: Record<string, string | undefined>, fallback: number, ...keys: string[]): number {
  const value = Number(pick(env, ...keys));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readList(env: Record<string, string | undefined>, fallback: string[], ...keys: string[]): string[] {
  const value = pick(env, ...keys);
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readDashboardUsers(
  env: Record<string, string | undefined>,
  fallback: DashboardAdminUser[],
  ...keys: string[]
): DashboardAdminUser[] {
  const value = pick(env, ...keys);
  if (!value) return fallback;

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf(':');
      if (separator <= 0) return [];
      const username = entry.slice(0, separator).trim();
      const password = entry.slice(separator + 1).trim();
      if (!username || !password) return [];
      return [{ username, password }];
    });
}

function readPromptPackingStyle(
  env: Record<string, string | undefined>,
  ...keys: string[]
): 'minimal' | 'copilotrm' {
  const value = pick(env, ...keys)?.toLowerCase();
  return value === 'copilotrm' ? 'copilotrm' : 'minimal';
}

function readGeminiCliBootstrapMode(
  env: Record<string, string | undefined>,
  ...keys: string[]
): 'operator' | 'playwright' {
  const value = pick(env, ...keys)?.trim().toLowerCase();
  return value === 'operator' ? 'operator' : 'playwright';
}

function normalizeBackendId(value: string): LLMBackendId | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'gemini-cli') return 'gemini-cli';
  if (normalized === 'playwright' || normalized === 'tegem' || normalized === 'playwright-tegem') {
    return 'playwright';
  }
  return null;
}

function readBackendOrder(
  env: Record<string, string | undefined>,
  fallback: LLMBackendId[],
  ...keys: string[]
): LLMBackendId[] {
  const parsed = readList(env, fallback, ...keys)
    .map((value) => normalizeBackendId(value))
    .filter((value): value is LLMBackendId => value !== null);
  if (parsed.length === 0) return fallback;
  return [...new Set(parsed)];
}

function resolveDefaultChromePath(rootDir: string): string | undefined {
  const homeDir = pick(process.env, 'HOME') ?? path.dirname(rootDir);
  const candidates = [
    path.join(homeDir, '.local/bin/google-chrome-stable'),
    path.join(homeDir, '.local/share/tegem/browser/chrome-linux64/chrome'),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function resolveProfileNamespace(browserChannel?: string, executablePath?: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  if (executablePath?.includes('google-chrome')) return 'chrome-stable';
  if (browserChannel) return browserChannel;
  return 'chromium';
}

function requireEnv(env: Record<string, string | undefined>, ...keys: string[]): string {
  const value = pick(env, ...keys);
  if (!value) throw new Error(`Missing required environment variable: ${keys.join(' | ')}`);
  return value;
}

export function loadConfig(
  env: Record<string, string | undefined> = (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  ),
): RuntimeConfig {
  const rootDir = path.resolve(pick(env, 'GEMROUTER_ROOT_DIR', 'BAIRBI_ROOT_DIR', 'BARIBI_ROOT_DIR') ?? process.cwd());
  const dataDir = path.resolve(rootDir, pick(env, 'GEMROUTER_DATA_DIR', 'BAIRBI_DATA_DIR', 'BARIBI_DATA_DIR') ?? 'data');
  mkdirSync(dataDir, { recursive: true });

  const browserChannel = pick(env, 'PLAYWRIGHT_BROWSER_CHANNEL');
  const browserExecutablePath = pick(env, 'PLAYWRIGHT_EXECUTABLE_PATH') ?? resolveDefaultChromePath(rootDir);
  const profileNamespace = resolveProfileNamespace(
    browserChannel,
    browserExecutablePath,
    pick(env, 'PLAYWRIGHT_PROFILE_NAMESPACE'),
  );

  const configuredDirectModels = readList(
    env,
    [...DEFAULT_DIRECT_MODEL_IDS],
    'GEMINI_DIRECT_MODELS',
    'GEMINI_CLI_MODELS',
    'GEMROUTER_DIRECT_MODELS',
  );
  const configuredDirectDefaultModel =
    pick(env, 'GEMINI_DIRECT_MODEL', 'GEMINI_CLI_MODEL')?.trim().toLowerCase() ||
    configuredDirectModels[0] ||
    DEFAULT_DIRECT_MODEL_IDS[0];
  const directModels = [...new Set([configuredDirectDefaultModel, ...configuredDirectModels])];
  const modelIds = buildPublicModelIds(directModels);
  const compatibilityState = coerceCompatibilityState({
    defaultSurface: pick(
      env,
      'GEMROUTER_COMPAT_DEFAULT_SURFACE',
      'BAIRBI_COMPAT_DEFAULT_SURFACE',
      'BARIBI_COMPAT_DEFAULT_SURFACE',
    ) ?? 'openai',
    enabledSurfaces: readList(
      env,
      ['openai', 'deepseek', 'ollama'],
      'GEMROUTER_COMPAT_ENABLED_SURFACES',
      'BAIRBI_COMPAT_ENABLED_SURFACES',
      'BARIBI_COMPAT_ENABLED_SURFACES',
    ),
  });
  const geminiCliUserHome = pick(env, 'GEMINI_CLI_USER_HOME')?.trim() || undefined;
  const geminiCliDotDir = pick(env, 'GEMINI_CLI_DOT_GEMINI_DIR')?.trim() || undefined;
  const geminiCliEnabled = readBoolean(env, true, 'GEMINI_CLI_ENABLED');
  const backendOrder = readBackendOrder(env, ['gemini-cli', 'playwright'], 'GEMROUTER_BACKEND_ORDER');

  return {
    host: pick(env, 'HOST', 'GEMROUTER_HOST', 'BAIRBI_HOST', 'BARIBI_HOST') ?? '0.0.0.0',
    port: readNumber(env, 4024, 'PORT', 'GEMROUTER_PORT', 'BAIRBI_PORT', 'BARIBI_PORT'),
    rootDir,
    dataDir,
    dashboardEnabled: readBoolean(
      env,
      true,
      'GEMROUTER_DASHBOARD_ENABLED',
      'BAIRBI_DASHBOARD_ENABLED',
      'BARIBI_DASHBOARD_ENABLED',
    ),
    adminToken: requireEnv(env, 'GEMROUTER_ADMIN_TOKEN', 'BAIRBI_ADMIN_TOKEN', 'BARIBI_ADMIN_TOKEN'),
    adminSessionTtlMs: readNumber(env, 24 * 60 * 60_000, 'GEMROUTER_ADMIN_SESSION_TTL_MS', 'BAIRBI_ADMIN_SESSION_TTL_MS', 'BARIBI_ADMIN_SESSION_TTL_MS'),
    dashboardAdminUsers: readDashboardUsers(
      env,
      [
        {
          username: 'admin',
          password: requireEnv(env, 'GEMROUTER_ADMIN_TOKEN', 'BAIRBI_ADMIN_TOKEN', 'BARIBI_ADMIN_TOKEN'),
        },
      ],
      'GEMROUTER_DASHBOARD_ADMIN_USERS',
      'BAIRBI_DASHBOARD_ADMIN_USERS',
      'BARIBI_DASHBOARD_ADMIN_USERS',
    ),
    bootstrapApp: {
      name: pick(env, 'GEMROUTER_BOOTSTRAP_APP_NAME', 'BAIRBI_BOOTSTRAP_APP_NAME', 'BARIBI_BOOTSTRAP_APP_NAME') ?? 'local-frontend',
      apiKey: requireEnv(env, 'GEMROUTER_BOOTSTRAP_API_KEY', 'BAIRBI_BOOTSTRAP_API_KEY', 'BARIBI_BOOTSTRAP_API_KEY'),
      allowedOrigins: readList(
        env,
        ['http://localhost:*', 'http://127.0.0.1:*', 'http://[::1]:*'],
        'GEMROUTER_BOOTSTRAP_ALLOWED_ORIGINS',
        'BAIRBI_BOOTSTRAP_ALLOWED_ORIGINS',
        'BARIBI_BOOTSTRAP_ALLOWED_ORIGINS',
      ),
      allowedModels: readList(
        env,
        modelIds,
        'GEMROUTER_BOOTSTRAP_ALLOWED_MODELS',
        'BAIRBI_BOOTSTRAP_ALLOWED_MODELS',
        'BARIBI_BOOTSTRAP_ALLOWED_MODELS',
      ),
      sessionNamespace: pick(
        env,
        'GEMROUTER_BOOTSTRAP_SESSION_NAMESPACE',
        'BAIRBI_BOOTSTRAP_SESSION_NAMESPACE',
        'BARIBI_BOOTSTRAP_SESSION_NAMESPACE',
      ) ?? 'local-frontend',
      rateLimitPerMinute: readNumber(
        env,
        30,
        'GEMROUTER_BOOTSTRAP_RATE_LIMIT_PER_MINUTE',
        'BAIRBI_BOOTSTRAP_RATE_LIMIT_PER_MINUTE',
        'BARIBI_BOOTSTRAP_RATE_LIMIT_PER_MINUTE',
      ),
      maxConcurrency: readNumber(
        env,
        2,
        'GEMROUTER_BOOTSTRAP_MAX_CONCURRENCY',
        'BAIRBI_BOOTSTRAP_MAX_CONCURRENCY',
        'BARIBI_BOOTSTRAP_MAX_CONCURRENCY',
      ),
      concurrencyWaitMs: readNumber(
        env,
        90_000,
        'GEMROUTER_BOOTSTRAP_CONCURRENCY_WAIT_MS',
        'BAIRBI_BOOTSTRAP_CONCURRENCY_WAIT_MS',
        'BARIBI_BOOTSTRAP_CONCURRENCY_WAIT_MS',
      ),
    },
    compatibility: {
      settingsStorePath: path.join(dataDir, 'compatibility.json'),
      defaultSurface: compatibilityState.defaultSurface,
      enabledSurfaces: compatibilityState.enabledSurfaces,
    },
    geminiCli: {
      enabled: geminiCliEnabled,
      model: configuredDirectDefaultModel,
      models: directModels,
      timeoutMs: readNumber(env, 120_000, 'GEMINI_CLI_TIMEOUT_MS'),
      quotaRefreshMs: readNumber(env, 60_000, 'GEMINI_CLI_QUOTA_REFRESH_MS', 'GEMINI_DIRECT_QUOTA_REFRESH_MS'),
      expectAuthCache: readBoolean(env, true, 'GEMINI_CLI_EXPECT_AUTH_CACHE'),
      authBootstrapEnabled: readBoolean(env, true, 'GEMINI_CLI_AUTH_BOOTSTRAP_ENABLED'),
      authBootstrapMode: readGeminiCliBootstrapMode(env, 'GEMINI_CLI_AUTH_BOOTSTRAP_MODE'),
      userHome: geminiCliUserHome ? path.resolve(geminiCliUserHome) : undefined,
      dotGeminiDir: geminiCliDotDir ? path.resolve(geminiCliDotDir) : undefined,
      authClientId: pick(env, 'GEMINI_AUTH_CLIENT_ID') ?? undefined,
      authClientSecret: pick(env, 'GEMINI_AUTH_CLIENT_SECRET') ?? undefined,
      callbackHost: pick(env, 'GEMINI_AUTH_CALLBACK_HOST', 'OAUTH_CALLBACK_HOST') ?? '127.0.0.1',
      callbackPort: (() => {
        const value = Number(pick(env, 'GEMINI_AUTH_CALLBACK_PORT', 'OAUTH_CALLBACK_PORT'));
        return Number.isFinite(value) && value > 0 ? value : undefined;
      })(),
      autoOpenBrowser: readBoolean(env, true, 'GEMINI_AUTH_AUTO_OPEN_BROWSER'),
      rootDir,
    },
    llmRouting: {
      backendOrder,
      allowPlaywrightFallback: readBoolean(env, true, 'GEMROUTER_ALLOW_PLAYWRIGHT_FALLBACK'),
      retryOnCliAuthFailure: readBoolean(env, true, 'GEMROUTER_BACKEND_RETRY_ON_CLI_AUTH_FAILURE'),
    },
    llm: {
      baseUrl: pick(env, 'TEGEM_BASE_URL') ?? 'https://gemini.google.com/app',
      headless: readBoolean(env, false, 'PLAYWRIGHT_HEADLESS', 'TEGEM_HEADLESS'),
      browserChannel,
      browserExecutablePath,
      baseProfileDir: path.resolve(
        rootDir,
        pick(env, 'PLAYWRIGHT_BASE_PROFILE_DIR', 'TEGEM_BASE_PROFILE_DIR') ?? '.playwright/profiles',
      ),
      profileNamespace,
      sessionIdleTimeoutMs: readNumber(env, 30 * 60_000, 'SESSION_IDLE_TIMEOUT_MS', 'TEGEM_SESSION_IDLE_TIMEOUT_MS'),
      conversationTtlMs: readNumber(env, 24 * 60 * 60_000, 'SESSION_CONVERSATION_TTL_MS', 'TEGEM_SESSION_CONVERSATION_TTL_MS'),
      maxSessionTabs: readNumber(env, 20, 'MAX_SESSION_TABS', 'TEGEM_MAX_SESSION_TABS'),
      respondedSessionTtlMs: readNumber(
        env,
        90_000,
        'RESPONDED_SESSION_TTL_MS',
        'TEGEM_RESPONDED_SESSION_TTL_MS',
      ),
      orphanSessionTtlMs: readNumber(
        env,
        10 * 60_000,
        'ORPHAN_SESSION_TTL_MS',
        'TEGEM_ORPHAN_SESSION_TTL_MS',
      ),
      streamPollIntervalMs: readNumber(env, 700, 'STREAM_POLL_INTERVAL_MS', 'TEGEM_STREAM_POLL_INTERVAL_MS'),
      streamStableTicks: readNumber(env, 4, 'STREAM_STABLE_TICKS', 'TEGEM_STREAM_STABLE_TICKS'),
      streamFirstChunkTimeoutMs: readNumber(env, 25_000, 'STREAM_FIRST_CHUNK_TIMEOUT_MS', 'TEGEM_STREAM_FIRST_CHUNK_TIMEOUT_MS'),
      streamMaxDurationMs: readNumber(env, 90_000, 'STREAM_MAX_DURATION_MS', 'TEGEM_STREAM_MAX_DURATION_MS'),
      legacyProfileImportPath: pick(env, 'TEGEM_IMPORT_PROFILE_FROM'),
      promptPackingStyle: readPromptPackingStyle(env, 'TEGEM_PROMPT_PACKING_STYLE'),
    },
    modelIds,
    auditLogPath: path.join(dataDir, 'audit.log'),
    appsStorePath: path.join(dataDir, 'apps.json'),
    interactionsStorePath: path.join(dataDir, 'interactions.json'),
    publicBaseUrl: pick(env, 'GEMROUTER_PUBLIC_BASE_URL', 'BAIRBI_PUBLIC_BASE_URL', 'BARIBI_PUBLIC_BASE_URL'),
    vncPublicUrl: pick(env, 'GEMROUTER_VNC_PUBLIC_URL', 'BAIRBI_VNC_PUBLIC_URL', 'BARIBI_VNC_PUBLIC_URL'),
  };
}
