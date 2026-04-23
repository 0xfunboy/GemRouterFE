import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { TeGemProviderConfig } from './llm/providers/tegem/client.js';

export interface BootstrapAppConfig {
  name: string;
  apiKey: string;
  allowedOrigins: string[];
  allowedModels: string[];
  sessionNamespace: string;
  rateLimitPerMinute: number;
  maxConcurrency: number;
}

export interface RuntimeConfig {
  host: string;
  port: number;
  rootDir: string;
  dataDir: string;
  adminToken: string;
  adminSessionTtlMs: number;
  bootstrapApp: BootstrapAppConfig;
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

  const modelIds = ['gemini-web', 'google/gemini-web'];

  return {
    host: pick(env, 'HOST', 'GEMROUTER_HOST', 'BAIRBI_HOST', 'BARIBI_HOST') ?? '0.0.0.0',
    port: readNumber(env, 4024, 'PORT', 'GEMROUTER_PORT', 'BAIRBI_PORT', 'BARIBI_PORT'),
    rootDir,
    dataDir,
    adminToken: requireEnv(env, 'GEMROUTER_ADMIN_TOKEN', 'BAIRBI_ADMIN_TOKEN', 'BARIBI_ADMIN_TOKEN'),
    adminSessionTtlMs: readNumber(env, 24 * 60 * 60_000, 'GEMROUTER_ADMIN_SESSION_TTL_MS', 'BAIRBI_ADMIN_SESSION_TTL_MS', 'BARIBI_ADMIN_SESSION_TTL_MS'),
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
      streamPollIntervalMs: readNumber(env, 700, 'STREAM_POLL_INTERVAL_MS', 'TEGEM_STREAM_POLL_INTERVAL_MS'),
      streamStableTicks: readNumber(env, 4, 'STREAM_STABLE_TICKS', 'TEGEM_STREAM_STABLE_TICKS'),
      streamFirstChunkTimeoutMs: readNumber(env, 25_000, 'STREAM_FIRST_CHUNK_TIMEOUT_MS', 'TEGEM_STREAM_FIRST_CHUNK_TIMEOUT_MS'),
      streamMaxDurationMs: readNumber(env, 90_000, 'STREAM_MAX_DURATION_MS', 'TEGEM_STREAM_MAX_DURATION_MS'),
      legacyProfileImportPath: pick(env, 'TEGEM_IMPORT_PROFILE_FROM'),
    },
    modelIds,
    auditLogPath: path.join(dataDir, 'audit.log'),
    appsStorePath: path.join(dataDir, 'apps.json'),
    interactionsStorePath: path.join(dataDir, 'interactions.json'),
    publicBaseUrl: pick(env, 'GEMROUTER_PUBLIC_BASE_URL', 'BAIRBI_PUBLIC_BASE_URL', 'BARIBI_PUBLIC_BASE_URL'),
    vncPublicUrl: pick(env, 'GEMROUTER_VNC_PUBLIC_URL', 'BAIRBI_VNC_PUBLIC_URL', 'BARIBI_VNC_PUBLIC_URL'),
  };
}
