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
import type { OutboundProxyConfig, OutboundProxyStrategy } from './net/outboundProxy.js';
import { GEMINI_API_TIER1_LIMITS } from './llm/providers/gemini-api/rateLimits.js';
import type { GeminiApiKeyConfig, GeminiApiProviderConfig, GeminiApiRateLimit } from './llm/providers/gemini-api/types.js';
import type { OllamaRouterConfig } from './llm/providers/ollama/client.js';
import type { DeepSeekApiConfig } from './llm/providers/deepseek-api/client.js';

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
  ollama: OllamaRouterConfig;
  deepseekApi: DeepSeekApiConfig;
  outboundProxy: OutboundProxyConfig;
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
  generation: {
    includeThoughts: boolean;
    stripReasoning: boolean;
    thinkingBudget?: number;
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  };
  auditLogPath: string;
  appsStorePath: string;
  interactionsStorePath: string;
  publicBaseUrl?: string;
}

function isCloudModelName(modelName: string): boolean {
  return /(:cloud|-cloud)(?:$|[^a-z0-9])/i.test(modelName);
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
  const allowedSet = new Set(allowed.map((value) => value.trim()).filter(Boolean));
  const filtered = values.map((value) => value.trim()).filter((value) => allowedSet.has(value));
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
  if (normalized === 'ollama') return 'ollama';
  if (normalized === 'deepseek-api' || normalized === 'deepseek' || normalized === 'deepseek_api') return 'deepseek-api';
  if (normalized === 'gemini-api' || normalized === 'gemini' || normalized === 'ai-studio') return 'gemini-api';
  return null;
}

function normalizeProxyStrategy(value: string | undefined): OutboundProxyStrategy {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'round-robin' || normalized === 'random') return normalized;
  return 'single';
}

function readOllamaInventoryModelIds(inventoryPath: string, excludeCloudModels: boolean): string[] {
  if (!existsSync(inventoryPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(inventoryPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    const models = parsed.flatMap((endpoint) => {
      if (!endpoint || typeof endpoint !== 'object') return [];
      const typed = endpoint as Record<string, unknown>;
      if (typed.ok === false || !Array.isArray(typed.models)) return [];
      return typed.models.flatMap((model) => {
        if (!model || typeof model !== 'object') return [];
        const name = String((model as Record<string, unknown>).name ?? '').trim();
        if (excludeCloudModels && isCloudModelName(name)) return [];
        return name ? [name] : [];
      });
    });
    return [...new Set(models)];
  } catch {
    return [];
  }
}

function readGeminiApiLimits(
  env: Record<string, string | undefined>,
): Record<string, GeminiApiRateLimit> {
  const pathValue = pick(env, 'LEAKROUTER_GEMINI_API_LIMITS_PATH');
  let fileLimits: Record<string, GeminiApiRateLimit> = {};
  if (pathValue && existsSync(pathValue)) {
    try {
      fileLimits = JSON.parse(readFileSync(pathValue, 'utf8')) as Record<string, GeminiApiRateLimit>;
    } catch {
      fileLimits = {};
    }
  }
  const envLimits = readJsonValue<Record<string, GeminiApiRateLimit>>(env, {}, 'LEAKROUTER_GEMINI_API_LIMITS_JSON');
  return {
    ...GEMINI_API_TIER1_LIMITS,
    ...fileLimits,
    ...envLimits,
  };
}

function readGeminiApiGroupLimits(
  env: Record<string, string | undefined>,
  accounts: Array<Partial<Omit<GeminiApiKeyConfig, 'key'>> & { keyEnv?: string; limits?: Record<string, GeminiApiRateLimit> }>,
): Record<string, Record<string, GeminiApiRateLimit>> {
  const result: Record<string, Record<string, GeminiApiRateLimit>> = {};
  // Per-group overrides from accounts file (quotaGroup → model → rateLimit)
  for (const account of accounts) {
    const group = account.quotaGroup ?? account.id;
    if (group && account.limits && typeof account.limits === 'object') {
      result[String(group)] = account.limits as Record<string, GeminiApiRateLimit>;
    }
  }
  // Env override: LEAKROUTER_GEMINI_API_GROUP_LIMITS_JSON = { "quotaGroup": { "model": { rpm, tpm, rpd } } }
  const envGroupLimits = readJsonValue<Record<string, Record<string, GeminiApiRateLimit>>>(env, {}, 'LEAKROUTER_GEMINI_API_GROUP_LIMITS_JSON');
  for (const [group, limits] of Object.entries(envGroupLimits)) {
    result[group] = { ...(result[group] ?? {}), ...limits };
  }
  return result;
}

function readGeminiAccountMetadata(
  env: Record<string, string | undefined>,
): Array<Partial<Omit<GeminiApiKeyConfig, 'key'>> & { keyEnv?: string }> {
  const pathValue = pick(env, 'LEAKROUTER_GEMINI_API_ACCOUNTS_PATH');
  let fileAccounts: Array<Partial<Omit<GeminiApiKeyConfig, 'key'>> & { keyEnv?: string }> = [];
  if (pathValue && existsSync(pathValue)) {
    try {
      const parsed = JSON.parse(readFileSync(pathValue, 'utf8')) as unknown;
      fileAccounts = Array.isArray(parsed) ? parsed as typeof fileAccounts : [];
    } catch {
      fileAccounts = [];
    }
  }
  const envAccounts = readJsonValue<typeof fileAccounts>(env, [], 'LEAKROUTER_GEMINI_API_ACCOUNTS_JSON');
  return envAccounts.length > 0 ? envAccounts : fileAccounts;
}

function readGeminiApiKeys(
  env: Record<string, string | undefined>,
  defaultTier: string,
  defaultQuotaGroupMode: 'per-key' | 'shared',
): GeminiApiKeyConfig[] {
  const advanced = readJsonValue<Array<Partial<GeminiApiKeyConfig>> | null>(env, null, 'LEAKROUTER_GEMINI_API_KEYS_JSON');
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

  const accounts = readGeminiAccountMetadata(env);
  const rawKeys = readList(env, [], 'LEAKROUTER_GEMINI_API_KEYS');
  return rawKeys.map((key, index) => {
    const account = accounts[index] ?? {};
    const id = String(account.id ?? `account${index + 1}`).trim();
    return {
      id,
      key,
      owner: account.owner,
      projectId: account.projectId,
      quotaGroup: String(account.quotaGroup ?? (defaultQuotaGroupMode === 'shared' ? 'default' : id)).trim(),
      tier: String(account.tier ?? defaultTier).trim(),
      priority: typeof account.priority === 'number' ? account.priority : 100,
      enabled: account.enabled !== false,
      models: Array.isArray(account.models) ? account.models.map((model) => String(model).trim().toLowerCase()).filter(Boolean) : undefined,
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
  const rootDir = path.resolve(pick(env, 'LEAKROUTER_ROOT_DIR', 'LEAKROUTER_ROOT_DIR', 'BAIRBI_ROOT_DIR', 'BARIBI_ROOT_DIR') ?? process.cwd());
  const dataDir = path.resolve(rootDir, pick(env, 'LEAKROUTER_DATA_DIR', 'LEAKROUTER_DATA_DIR', 'BAIRBI_DATA_DIR', 'BARIBI_DATA_DIR') ?? 'data');
  mkdirSync(dataDir, { recursive: true });

  const ollamaInventoryPath = path.resolve(
    rootDir,
    pick(env, 'LEAKROUTER_OLLAMA_INVENTORY_PATH', 'LEAKROUTER_OLLAMA_INVENTORY_PATH') ?? 'ollama-model-inventory.json',
  );
  const excludeCloudModels = readBoolean(env, true, 'LEAKROUTER_OLLAMA_EXCLUDE_CLOUD_MODELS');
  const ollamaModelIds = readOllamaInventoryModelIds(ollamaInventoryPath, excludeCloudModels);
  const deepseekModels = readList(env, ['deepseek-chat', 'deepseek-reasoner'], 'LEAKROUTER_DEEPSEEK_MODELS', 'LEAKROUTER_DEEPSEEK_MODELS');
  const configuredModelIds = readList(
    env,
    [...ollamaModelIds, ...deepseekModels],
    'LEAKROUTER_MODELS',
    'LEAKROUTER_DIRECT_MODELS',
  );

  const geminiApiDefaultTier = pick(env, 'LEAKROUTER_GEMINI_API_DEFAULT_TIER') ?? 'tier1';
  const geminiApiQuotaGroupMode = pick(env, 'LEAKROUTER_GEMINI_API_DEFAULT_QUOTA_GROUP_MODE') === 'shared'
    ? 'shared'
    : 'per-key';
  const geminiApiKeys = readGeminiApiKeys(env, geminiApiDefaultTier, geminiApiQuotaGroupMode);
  // When a Gemini key is configured, ADD the working free-tier Gemini chain to the exposed models.
  // This is additive: the full Ollama inventory stays exposed (so amoral-gemma and other models keep
  // working); we only append Gemini on top. Override the chain with LEAKROUTER_GEMINI_TEXT_MODELS.
  const geminiTextModels = geminiApiKeys.length > 0
    ? readList(
        env,
        ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemma-4-31b-it'],
        'LEAKROUTER_GEMINI_TEXT_MODELS',
      )
    : [];

  const freeTierTextModelIds = [
    ...new Set([
      ...readList(
        env,
        configuredModelIds.length > 0 ? configuredModelIds : [...DEFAULT_FREE_TIER_TEXT_MODEL_IDS],
        'LEAKROUTER_TEXT_MODELS',
        'LEAKROUTER_FREE_TIER_TEXT_MODELS',
      ),
      ...geminiTextModels,
    ]),
  ];
  const freeTierAudioModelIds = readList(
    env,
    [...DEFAULT_FREE_TIER_AUDIO_MODEL_IDS],
    'LEAKROUTER_FREE_TIER_AUDIO_MODELS',
  );
  const freeTierEmbeddingModelIds = readList(
    env,
    [...DEFAULT_FREE_TIER_EMBEDDING_MODEL_IDS],
    'LEAKROUTER_FREE_TIER_EMBEDDING_MODELS',
  );
  const freeTierFallbackModelIds = readList(
    env,
    freeTierTextModelIds.slice(0, 3),
    'LEAKROUTER_FALLBACK_MODELS',
    'LEAKROUTER_TEXT_FALLBACK_MODELS',
  );
  const freeTierModelIds = buildFreeTierModelIds({
    textModelIds: freeTierTextModelIds,
    audioModelIds: freeTierAudioModelIds,
    embeddingModelIds: freeTierEmbeddingModelIds,
  });

  const configuredDirectModels = readList(
    env,
    freeTierTextModelIds.length > 0 ? freeTierTextModelIds : [...DEFAULT_DIRECT_MODEL_IDS],
    'LEAKROUTER_MODELS',
    'GEMINI_DIRECT_MODELS',
    'LEAKROUTER_DIRECT_MODELS',
  )
    .filter((model) => freeTierTextModelIds.includes(model));
  const configuredDirectDefaultModel =
    (() => {
      const requested = pick(env, 'LEAKROUTER_DEFAULT_MODEL', 'GEMINI_DIRECT_MODEL', 'LEAKROUTER_DEFAULT_MODEL')?.trim();
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
      'LEAKROUTER_COMPAT_DEFAULT_SURFACE',
      'LEAKROUTER_COMPAT_DEFAULT_SURFACE',
      'BAIRBI_COMPAT_DEFAULT_SURFACE',
      'BARIBI_COMPAT_DEFAULT_SURFACE',
    ) ?? 'ollama',
    enabledSurfaces: readList(
      env,
      ['openai', 'deepseek', 'ollama'],
      'LEAKROUTER_COMPAT_ENABLED_SURFACES',
      'LEAKROUTER_COMPAT_ENABLED_SURFACES',
      'BAIRBI_COMPAT_ENABLED_SURFACES',
      'BARIBI_COMPAT_ENABLED_SURFACES',
    ),
  });
  const backendOrder = readBackendOrder(env, ['ollama', 'deepseek-api'], 'LEAKROUTER_BACKEND_ORDER', 'LEAKROUTER_BACKEND_ORDER');
  const proxyUrls = readList(env, [], 'LEAKROUTER_OUTBOUND_PROXY_URLS');
  const singleProxyUrl = pick(env, 'LEAKROUTER_OUTBOUND_PROXY_URL');
  const outboundProxyUrls = proxyUrls.length > 0
    ? proxyUrls
    : singleProxyUrl
      ? [singleProxyUrl]
      : [];

  return {
    host: pick(env, 'HOST', 'LEAKROUTER_HOST', 'LEAKROUTER_HOST', 'BAIRBI_HOST', 'BARIBI_HOST') ?? '0.0.0.0',
    port: readNumber(env, 4024, 'PORT', 'LEAKROUTER_PORT', 'LEAKROUTER_PORT', 'BAIRBI_PORT', 'BARIBI_PORT'),
    rootDir,
    dataDir,
    dashboardEnabled: readBoolean(
      env,
      true,
      'LEAKROUTER_DASHBOARD_ENABLED',
      'LEAKROUTER_DASHBOARD_ENABLED',
      'BAIRBI_DASHBOARD_ENABLED',
      'BARIBI_DASHBOARD_ENABLED',
    ),
    adminToken: requireEnv(env, 'LEAKROUTER_ADMIN_TOKEN', 'LEAKROUTER_ADMIN_TOKEN', 'BAIRBI_ADMIN_TOKEN', 'BARIBI_ADMIN_TOKEN'),
    adminSessionTtlMs: readNumber(
      env,
      24 * 60 * 60_000,
      'LEAKROUTER_ADMIN_SESSION_TTL_MS',
      'LEAKROUTER_ADMIN_SESSION_TTL_MS',
      'BAIRBI_ADMIN_SESSION_TTL_MS',
      'BARIBI_ADMIN_SESSION_TTL_MS',
    ),
    dashboardAdminUsers: readDashboardUsers(
      env,
      [
        {
          username: 'admin',
          password: requireEnv(env, 'LEAKROUTER_ADMIN_TOKEN', 'LEAKROUTER_ADMIN_TOKEN', 'BAIRBI_ADMIN_TOKEN', 'BARIBI_ADMIN_TOKEN'),
        },
      ],
      'LEAKROUTER_DASHBOARD_ADMIN_USERS',
      'LEAKROUTER_DASHBOARD_ADMIN_USERS',
      'BAIRBI_DASHBOARD_ADMIN_USERS',
      'BARIBI_DASHBOARD_ADMIN_USERS',
    ),
    bootstrapApp: {
      name: pick(env, 'LEAKROUTER_BOOTSTRAP_APP_NAME', 'LEAKROUTER_BOOTSTRAP_APP_NAME', 'BAIRBI_BOOTSTRAP_APP_NAME', 'BARIBI_BOOTSTRAP_APP_NAME') ?? 'local-client',
      apiKey: requireEnv(env, 'LEAKROUTER_BOOTSTRAP_API_KEY', 'LEAKROUTER_BOOTSTRAP_API_KEY', 'BAIRBI_BOOTSTRAP_API_KEY', 'BARIBI_BOOTSTRAP_API_KEY'),
      allowedOrigins: readList(
        env,
        ['http://localhost:*', 'http://127.0.0.1:*', 'http://[::1]:*'],
        'LEAKROUTER_BOOTSTRAP_ALLOWED_ORIGINS',
        'LEAKROUTER_BOOTSTRAP_ALLOWED_ORIGINS',
        'BAIRBI_BOOTSTRAP_ALLOWED_ORIGINS',
        'BARIBI_BOOTSTRAP_ALLOWED_ORIGINS',
      ),
      allowedModels: intersectOrFallback(
        readList(
          env,
          modelIds,
          'LEAKROUTER_BOOTSTRAP_ALLOWED_MODELS',
          'LEAKROUTER_BOOTSTRAP_ALLOWED_MODELS',
          'BAIRBI_BOOTSTRAP_ALLOWED_MODELS',
          'BARIBI_BOOTSTRAP_ALLOWED_MODELS',
        ),
        freeTierTextModelIds,
        modelIds,
      ),
      sessionNamespace: pick(
        env,
        'LEAKROUTER_BOOTSTRAP_SESSION_NAMESPACE',
        'LEAKROUTER_BOOTSTRAP_SESSION_NAMESPACE',
        'BAIRBI_BOOTSTRAP_SESSION_NAMESPACE',
        'BARIBI_BOOTSTRAP_SESSION_NAMESPACE',
      ) ?? 'local-client',
      rateLimitPerMinute: readNumber(
        env,
        30,
        'LEAKROUTER_BOOTSTRAP_RATE_LIMIT_PER_MINUTE',
        'LEAKROUTER_BOOTSTRAP_RATE_LIMIT_PER_MINUTE',
        'BAIRBI_BOOTSTRAP_RATE_LIMIT_PER_MINUTE',
        'BARIBI_BOOTSTRAP_RATE_LIMIT_PER_MINUTE',
      ),
      maxConcurrency: readNumber(
        env,
        2,
        'LEAKROUTER_BOOTSTRAP_MAX_CONCURRENCY',
        'LEAKROUTER_BOOTSTRAP_MAX_CONCURRENCY',
        'BAIRBI_BOOTSTRAP_MAX_CONCURRENCY',
        'BARIBI_BOOTSTRAP_MAX_CONCURRENCY',
      ),
      concurrencyWaitMs: readNumber(
        env,
        90_000,
        'LEAKROUTER_BOOTSTRAP_CONCURRENCY_WAIT_MS',
        'LEAKROUTER_BOOTSTRAP_CONCURRENCY_WAIT_MS',
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
      enabled: readBoolean(env, geminiApiKeys.length > 0, 'LEAKROUTER_GEMINI_API_ENABLED'),
      keys: geminiApiKeys,
      baseUrl: pick(env, 'LEAKROUTER_GEMINI_API_BASE_URL') ?? 'https://generativelanguage.googleapis.com',
      version: pick(env, 'LEAKROUTER_GEMINI_API_VERSION') ?? 'v1beta',
      defaultTier: geminiApiDefaultTier,
      defaultQuotaGroupMode: geminiApiQuotaGroupMode,
      limits: readGeminiApiLimits(env),
      groupLimits: readGeminiApiGroupLimits(env, readGeminiAccountMetadata(env)),
      ledgerPath: path.resolve(
        rootDir,
        pick(env, 'LEAKROUTER_GEMINI_API_LEDGER_PATH') ?? 'data/gemini-api-quota-ledger.json',
      ),
      discoveryCachePath: path.resolve(
        rootDir,
        pick(env, 'LEAKROUTER_GEMINI_API_DISCOVERY_CACHE_PATH') ?? 'data/gemini-api-models-cache.json',
      ),
      discoveryRefreshMs: readNumber(env, 21_600_000, 'LEAKROUTER_GEMINI_API_DISCOVERY_REFRESH_MS'),
      quotaCooldownMs: readNumber(env, 600_000, 'LEAKROUTER_GEMINI_API_QUOTA_COOLDOWN_MS'),
      rpdWindowMs: readNumber(env, 86_400_000, 'LEAKROUTER_GEMINI_API_RPD_WINDOW_MS'),
      rpmWindowMs: readNumber(env, 60_000, 'LEAKROUTER_GEMINI_API_RPM_WINDOW_MS'),
      tpmWindowMs: readNumber(env, 60_000, 'LEAKROUTER_GEMINI_API_TPM_WINDOW_MS'),
      countTokensPreflight: readBoolean(env, false, 'LEAKROUTER_GEMINI_API_COUNT_TOKENS_PREFLIGHT'),
      countFailed429AsUsage: readBoolean(env, true, 'LEAKROUTER_GEMINI_API_COUNT_FAILED_429_AS_USAGE'),
      timeoutMs: readNumber(env, 120_000, 'LEAKROUTER_GEMINI_API_TIMEOUT_MS'),
      streamTimeoutMs: readNumber(env, 180_000, 'LEAKROUTER_GEMINI_API_STREAM_TIMEOUT_MS'),
      fallbackModelIds: freeTierFallbackModelIds.filter((model) => freeTierTextModelIds.includes(model)),
    },
    ollama: {
      enabled: readBoolean(env, ollamaModelIds.length > 0, 'LEAKROUTER_OLLAMA_ENABLED', 'LEAKROUTER_OLLAMA_ENABLED'),
      inventoryPath: ollamaInventoryPath,
      excludeCloudModels,
      minParameterScore: readNumber(env, 20, 'LEAKROUTER_OLLAMA_MIN_PARAMETER_SCORE'),
      timeoutMs: readNumber(env, 120_000, 'LEAKROUTER_OLLAMA_TIMEOUT_MS', 'LEAKROUTER_OLLAMA_TIMEOUT_MS'),
      streamTimeoutMs: readNumber(env, 180_000, 'LEAKROUTER_OLLAMA_STREAM_TIMEOUT_MS', 'LEAKROUTER_OLLAMA_STREAM_TIMEOUT_MS'),
      defaultModel: configuredDirectDefaultModel,
    },
    deepseekApi: {
      enabled: readBoolean(env, Boolean(pick(env, 'LEAKROUTER_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY')), 'LEAKROUTER_DEEPSEEK_ENABLED', 'LEAKROUTER_DEEPSEEK_ENABLED'),
      apiKey: pick(env, 'LEAKROUTER_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'),
      baseUrl: pick(env, 'LEAKROUTER_DEEPSEEK_BASE_URL', 'DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com/v1',
      models: deepseekModels,
      defaultModel: pick(env, 'LEAKROUTER_DEEPSEEK_DEFAULT_MODEL', 'DEEPSEEK_MODEL') ?? deepseekModels[0] ?? 'deepseek-chat',
      timeoutMs: readNumber(env, 120_000, 'LEAKROUTER_DEEPSEEK_TIMEOUT_MS', 'DEEPSEEK_TIMEOUT_MS'),
    },
    outboundProxy: {
      enabled: readBoolean(env, false, 'LEAKROUTER_OUTBOUND_PROXY_ENABLED'),
      required: readBoolean(env, true, 'LEAKROUTER_OUTBOUND_PROXY_REQUIRED'),
      urls: outboundProxyUrls,
      strategy: normalizeProxyStrategy(pick(env, 'LEAKROUTER_OUTBOUND_PROXY_STRATEGY')),
      connectTimeoutMs: readNumber(env, 10_000, 'LEAKROUTER_PROXY_CONNECT_TIMEOUT_MS'),
      requestTimeoutMs: readNumber(env, 120_000, 'LEAKROUTER_PROXY_REQUEST_TIMEOUT_MS'),
      bypassHosts: readList(env, ['localhost', '127.0.0.1', '::1'], 'LEAKROUTER_OUTBOUND_PROXY_BYPASS_HOSTS'),
      bypassPrivateIps: readBoolean(env, true, 'LEAKROUTER_OUTBOUND_PROXY_BYPASS_PRIVATE_IPS'),
    },
    llmRouting: {
      backendOrder,
    },
    modelIds,
    freeTierPolicy: {
      enabled: readBoolean(env, true, 'LEAKROUTER_FREE_TIER_POLICY_ENABLED'),
      pricingUrl: pick(env, 'LEAKROUTER_MODEL_POLICY_URL', 'LEAKROUTER_FREE_TIER_PRICING_URL') ?? '',
      refreshMs: readNumber(env, 86_400_000, 'LEAKROUTER_FREE_TIER_REFRESH_MS'),
      parseModel: pick(env, 'LEAKROUTER_FREE_TIER_PARSE_MODEL') ?? freeTierFallbackModelIds[0] ?? modelIds[0],
      storePath: path.resolve(rootDir, pick(env, 'LEAKROUTER_MODEL_POLICY_PATH', 'LEAKROUTER_FREE_TIER_POLICY_PATH') ?? 'data/model-policy.json'),
      textModelIds: freeTierTextModelIds,
      audioModelIds: freeTierAudioModelIds,
      embeddingModelIds: freeTierEmbeddingModelIds,
      fallbackModelIds: freeTierFallbackModelIds.filter((model) => freeTierTextModelIds.includes(model)),
      allModelIds: freeTierModelIds,
    },
    generation: {
      includeThoughts: readBoolean(env, false, 'LEAKROUTER_INCLUDE_THOUGHTS'),
      stripReasoning: readBoolean(env, true, 'LEAKROUTER_STRIP_REASONING'),
      thinkingBudget: readNumber(env, 0, 'LEAKROUTER_THINKING_BUDGET'),
      thinkingLevel: (() => {
        const value = pick(env, 'LEAKROUTER_THINKING_LEVEL')?.toLowerCase();
        return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' ? value : 'minimal';
      })(),
    },
    auditLogPath: path.join(dataDir, 'audit.log'),
    appsStorePath: path.join(dataDir, 'apps.json'),
    interactionsStorePath: path.join(dataDir, 'interactions.json'),
    publicBaseUrl: pick(env, 'LEAKROUTER_PUBLIC_BASE_URL', 'LEAKROUTER_PUBLIC_BASE_URL', 'BAIRBI_PUBLIC_BASE_URL', 'BARIBI_PUBLIC_BASE_URL'),
  };
}
