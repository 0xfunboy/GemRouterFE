import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { coerceCompatibilityState, type ApiSurface } from './lib/compatibility.js';
import {
  buildFreeTierModelIds,
  buildPublicModelIds,
  DEFAULT_DIRECT_MODEL_IDS,
  DEFAULT_FREE_TIER_AUDIO_MODEL_IDS,
  DEFAULT_FREE_TIER_EMBEDDING_MODEL_IDS,
  DEFAULT_FREE_TIER_TEXT_MODEL_IDS,
  DEFAULT_TEXT_FALLBACK_MODEL_IDS,
} from './lib/models.js';
import type { LLMBackendId } from './llm/types.js';
import { GEMINI_API_TIER1_LIMITS } from './llm/providers/gemini-api/rateLimits.js';
import type { GeminiApiKeyConfig, GeminiApiProviderConfig, GeminiApiRateLimit } from './llm/providers/gemini-api/types.js';

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
  geminiApi: GeminiApiProviderConfig;
  llmRouting: {
    backendOrder: LLMBackendId[];
  };
  modelIds: string[];
  freeTierPolicy: {
    enabled: boolean;
    pricingUrl: string;
    refreshMs: number;
    parseModel: string;
    storePath: string;
    textModelIds: string[];
    audioModelIds: string[];
    embeddingModelIds: string[];
    fallbackModelIds: string[];
    allModelIds: string[];
  };
  auditLogPath: string;
  appsStorePath: string;
  interactionsStorePath: string;
  publicBaseUrl?: string;
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

function intersectOrFallback(values: string[], allowed: string[], fallback: string[]): string[] {
  const allowedSet = new Set(allowed.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const filtered = values.map((value) => value.trim().toLowerCase()).filter((value) => allowedSet.has(value));
  return filtered.length > 0 ? [...new Set(filtered)] : fallback;
}

function readJsonValue<T>(env: Record<string, string | undefined>, fallback: T, ...keys: string[]): T {
  const value = pick(env, ...keys);
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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

function normalizeBackendId(value: string): LLMBackendId | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'gemini-api' || normalized === 'gemini' || normalized === 'ai-studio') return 'gemini-api';
  return null;
}

function readGeminiApiLimits(
  env: Record<string, string | undefined>,
): Record<string, GeminiApiRateLimit> {
  const pathValue = pick(env, 'GEMROUTER_GEMINI_API_LIMITS_PATH');
  let fileLimits: Record<string, GeminiApiRateLimit> = {};
  if (pathValue && existsSync(pathValue)) {
    try {
      fileLimits = JSON.parse(readFileSync(pathValue, 'utf8')) as Record<string, GeminiApiRateLimit>;
    } catch {
      fileLimits = {};
    }
  }
  const envLimits = readJsonValue<Record<string, GeminiApiRateLimit>>(env, {}, 'GEMROUTER_GEMINI_API_LIMITS_JSON');
  return {
    ...GEMINI_API_TIER1_LIMITS,
    ...fileLimits,
    ...envLimits,
  };
}

function readGeminiApiKeys(
  env: Record<string, string | undefined>,
  defaultTier: string,
  defaultQuotaGroupMode: 'per-key' | 'shared',
): GeminiApiKeyConfig[] {
  const advanced = readJsonValue<Array<Partial<GeminiApiKeyConfig>> | null>(env, null, 'GEMROUTER_GEMINI_API_KEYS_JSON');
  if (Array.isArray(advanced) && advanced.length > 0) {
    return advanced.flatMap((entry, index) => {
      const key = typeof entry.key === 'string' ? entry.key.trim() : '';
      if (!key) return [];
      const id = String(entry.id ?? `key-${index + 1}`).trim();
      return [{
        id,
        key,
        owner: entry.owner,
        projectId: entry.projectId,
        quotaGroup: String(entry.quotaGroup ?? (defaultQuotaGroupMode === 'shared' ? 'default' : id)).trim(),
        tier: String(entry.tier ?? defaultTier).trim(),
        priority: typeof entry.priority === 'number' ? entry.priority : 100,
        enabled: entry.enabled !== false,
        models: Array.isArray(entry.models) ? entry.models.map((model) => String(model).trim().toLowerCase()).filter(Boolean) : undefined,
      }];
    });
  }

  return readList(env, [], 'GEMROUTER_GEMINI_API_KEYS').map((key, index) => {
    const id = `account${index + 1}`;
    return {
      id,
      key,
      quotaGroup: defaultQuotaGroupMode === 'shared' ? 'default' : id,
      tier: defaultTier,
      priority: 100,
      enabled: true,
    };
  });
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

  const freeTierTextModelIds = readList(
    env,
    [...DEFAULT_FREE_TIER_TEXT_MODEL_IDS],
    'GEMROUTER_FREE_TIER_TEXT_MODELS',
  ).map((model) => model.toLowerCase());
  const freeTierAudioModelIds = readList(
    env,
    [...DEFAULT_FREE_TIER_AUDIO_MODEL_IDS],
    'GEMROUTER_FREE_TIER_AUDIO_MODELS',
  ).map((model) => model.toLowerCase());
  const freeTierEmbeddingModelIds = readList(
    env,
    [...DEFAULT_FREE_TIER_EMBEDDING_MODEL_IDS],
    'GEMROUTER_FREE_TIER_EMBEDDING_MODELS',
  ).map((model) => model.toLowerCase());
  const freeTierFallbackModelIds = readList(
    env,
    [...DEFAULT_TEXT_FALLBACK_MODEL_IDS],
    'GEMROUTER_TEXT_FALLBACK_MODELS',
  ).map((model) => model.toLowerCase());
  const freeTierModelIds = buildFreeTierModelIds({
    textModelIds: freeTierTextModelIds,
    audioModelIds: freeTierAudioModelIds,
    embeddingModelIds: freeTierEmbeddingModelIds,
  });

  const configuredDirectModels = readList(
    env,
    freeTierTextModelIds.length > 0 ? freeTierTextModelIds : [...DEFAULT_DIRECT_MODEL_IDS],
    'GEMINI_DIRECT_MODELS',
    'GEMROUTER_DIRECT_MODELS',
  )
    .map((model) => model.toLowerCase())
    .filter((model) => freeTierTextModelIds.includes(model));
  const configuredDirectDefaultModel =
    (() => {
      const requested = pick(env, 'GEMINI_DIRECT_MODEL', 'GEMROUTER_DEFAULT_MODEL')?.trim().toLowerCase();
      return requested && freeTierTextModelIds.includes(requested) ? requested : undefined;
    })() ||
    configuredDirectModels[0] ||
    freeTierTextModelIds[0] ||
    DEFAULT_DIRECT_MODEL_IDS[0];
  const directModels = [...new Set([configuredDirectDefaultModel, ...configuredDirectModels])];
  const modelIds = buildPublicModelIds(directModels);
  const compatibilityState = coerceCompatibilityState({
    defaultSurface: pick(
      env,
      'GEMROUTER_COMPAT_DEFAULT_SURFACE',
      'BAIRBI_COMPAT_DEFAULT_SURFACE',
      'BARIBI_COMPAT_DEFAULT_SURFACE',
    ) ?? 'gemrouter',
    enabledSurfaces: readList(
      env,
      ['gemrouter', 'openai', 'deepseek', 'ollama'],
      'GEMROUTER_COMPAT_ENABLED_SURFACES',
      'BAIRBI_COMPAT_ENABLED_SURFACES',
      'BARIBI_COMPAT_ENABLED_SURFACES',
    ),
  });
  const backendOrder = readBackendOrder(env, ['gemini-api'], 'GEMROUTER_BACKEND_ORDER');
  const geminiApiDefaultTier = pick(env, 'GEMROUTER_GEMINI_API_DEFAULT_TIER') ?? 'tier1';
  const geminiApiQuotaGroupMode = pick(env, 'GEMROUTER_GEMINI_API_DEFAULT_QUOTA_GROUP_MODE') === 'shared'
    ? 'shared'
    : 'per-key';
  const geminiApiKeys = readGeminiApiKeys(env, geminiApiDefaultTier, geminiApiQuotaGroupMode);

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
    adminSessionTtlMs: readNumber(
      env,
      24 * 60 * 60_000,
      'GEMROUTER_ADMIN_SESSION_TTL_MS',
      'BAIRBI_ADMIN_SESSION_TTL_MS',
      'BARIBI_ADMIN_SESSION_TTL_MS',
    ),
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
      name: pick(env, 'GEMROUTER_BOOTSTRAP_APP_NAME', 'BAIRBI_BOOTSTRAP_APP_NAME', 'BARIBI_BOOTSTRAP_APP_NAME') ?? 'local-client',
      apiKey: requireEnv(env, 'GEMROUTER_BOOTSTRAP_API_KEY', 'BAIRBI_BOOTSTRAP_API_KEY', 'BARIBI_BOOTSTRAP_API_KEY'),
      allowedOrigins: readList(
        env,
        ['http://localhost:*', 'http://127.0.0.1:*', 'http://[::1]:*'],
        'GEMROUTER_BOOTSTRAP_ALLOWED_ORIGINS',
        'BAIRBI_BOOTSTRAP_ALLOWED_ORIGINS',
        'BARIBI_BOOTSTRAP_ALLOWED_ORIGINS',
      ),
      allowedModels: intersectOrFallback(
        readList(
          env,
          modelIds,
          'GEMROUTER_BOOTSTRAP_ALLOWED_MODELS',
          'BAIRBI_BOOTSTRAP_ALLOWED_MODELS',
          'BARIBI_BOOTSTRAP_ALLOWED_MODELS',
        ),
        freeTierTextModelIds,
        modelIds,
      ),
      sessionNamespace: pick(
        env,
        'GEMROUTER_BOOTSTRAP_SESSION_NAMESPACE',
        'BAIRBI_BOOTSTRAP_SESSION_NAMESPACE',
        'BARIBI_BOOTSTRAP_SESSION_NAMESPACE',
      ) ?? 'local-client',
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
    geminiApi: {
      enabled: readBoolean(env, geminiApiKeys.length > 0, 'GEMROUTER_GEMINI_API_ENABLED'),
      keys: geminiApiKeys,
      baseUrl: pick(env, 'GEMROUTER_GEMINI_API_BASE_URL') ?? 'https://generativelanguage.googleapis.com',
      version: pick(env, 'GEMROUTER_GEMINI_API_VERSION') ?? 'v1beta',
      defaultTier: geminiApiDefaultTier,
      defaultQuotaGroupMode: geminiApiQuotaGroupMode,
      limits: readGeminiApiLimits(env),
      ledgerPath: path.resolve(
        rootDir,
        pick(env, 'GEMROUTER_GEMINI_API_LEDGER_PATH') ?? 'data/gemini-api-quota-ledger.json',
      ),
      discoveryCachePath: path.resolve(
        rootDir,
        pick(env, 'GEMROUTER_GEMINI_API_DISCOVERY_CACHE_PATH') ?? 'data/gemini-api-models-cache.json',
      ),
      discoveryRefreshMs: readNumber(env, 21_600_000, 'GEMROUTER_GEMINI_API_DISCOVERY_REFRESH_MS'),
      quotaCooldownMs: readNumber(env, 600_000, 'GEMROUTER_GEMINI_API_QUOTA_COOLDOWN_MS'),
      rpdWindowMs: readNumber(env, 86_400_000, 'GEMROUTER_GEMINI_API_RPD_WINDOW_MS'),
      rpmWindowMs: readNumber(env, 60_000, 'GEMROUTER_GEMINI_API_RPM_WINDOW_MS'),
      tpmWindowMs: readNumber(env, 60_000, 'GEMROUTER_GEMINI_API_TPM_WINDOW_MS'),
      countTokensPreflight: readBoolean(env, false, 'GEMROUTER_GEMINI_API_COUNT_TOKENS_PREFLIGHT'),
      countFailed429AsUsage: readBoolean(env, true, 'GEMROUTER_GEMINI_API_COUNT_FAILED_429_AS_USAGE'),
      timeoutMs: readNumber(env, 120_000, 'GEMROUTER_GEMINI_API_TIMEOUT_MS'),
      streamTimeoutMs: readNumber(env, 180_000, 'GEMROUTER_GEMINI_API_STREAM_TIMEOUT_MS'),
      fallbackModelIds: freeTierFallbackModelIds.filter((model) => freeTierTextModelIds.includes(model)),
    },
    llmRouting: {
      backendOrder,
    },
    modelIds,
    freeTierPolicy: {
      enabled: readBoolean(env, true, 'GEMROUTER_FREE_TIER_POLICY_ENABLED'),
      pricingUrl: pick(env, 'GEMROUTER_FREE_TIER_PRICING_URL') ?? 'https://ai.google.dev/gemini-api/docs/pricing',
      refreshMs: readNumber(env, 86_400_000, 'GEMROUTER_FREE_TIER_REFRESH_MS'),
      parseModel: pick(env, 'GEMROUTER_FREE_TIER_PARSE_MODEL') ?? freeTierFallbackModelIds[0] ?? modelIds[0],
      storePath: path.resolve(
        rootDir,
        pick(env, 'GEMROUTER_FREE_TIER_POLICY_PATH') ?? 'data/free-tier-policy.json',
      ),
      textModelIds: freeTierTextModelIds,
      audioModelIds: freeTierAudioModelIds,
      embeddingModelIds: freeTierEmbeddingModelIds,
      fallbackModelIds: freeTierFallbackModelIds.filter((model) => freeTierTextModelIds.includes(model)),
      allModelIds: freeTierModelIds,
    },
    auditLogPath: path.join(dataDir, 'audit.log'),
    appsStorePath: path.join(dataDir, 'apps.json'),
    interactionsStorePath: path.join(dataDir, 'interactions.json'),
    publicBaseUrl: pick(env, 'GEMROUTER_PUBLIC_BASE_URL', 'BAIRBI_PUBLIC_BASE_URL', 'BARIBI_PUBLIC_BASE_URL'),
  };
}
