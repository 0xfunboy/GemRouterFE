export const API_SURFACES = ['openai', 'deepseek', 'ollama'] as const;

export type ApiSurface = (typeof API_SURFACES)[number];

export interface CompatibilityRoutes {
  baseUrl: string;
  apiBaseUrl?: string;
  models: string;
  chat: string;
  responses?: string;
  tags?: string;
  generate?: string;
  show?: string;
  version?: string;
}

export function normalizeApiSurface(value: unknown, fallback: ApiSurface = 'openai'): ApiSurface {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return API_SURFACES.includes(normalized as ApiSurface) ? (normalized as ApiSurface) : fallback;
}

export function normalizeApiSurfaces(
  values: unknown,
  fallback: ApiSurface[] = [...API_SURFACES],
): ApiSurface[] {
  const source = Array.isArray(values)
    ? values
    : String(values ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

  const normalized = source
    .map((value) => normalizeApiSurface(value, '__invalid__' as ApiSurface))
    .filter((value): value is ApiSurface => API_SURFACES.includes(value));

  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique : [...fallback];
}

export function coerceCompatibilityState(input: {
  defaultSurface?: unknown;
  enabledSurfaces?: unknown;
}): { defaultSurface: ApiSurface; enabledSurfaces: ApiSurface[] } {
  const enabledSurfaces = normalizeApiSurfaces(input.enabledSurfaces, [...API_SURFACES]);
  const defaultSurface = normalizeApiSurface(input.defaultSurface, enabledSurfaces[0] ?? 'openai');
  if (!enabledSurfaces.includes(defaultSurface)) {
    enabledSurfaces.unshift(defaultSurface);
  }
  return {
    defaultSurface,
    enabledSurfaces,
  };
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function buildCompatibilityRoutes(baseUrl: string): Record<ApiSurface, CompatibilityRoutes> {
  const root = withoutTrailingSlash(baseUrl);
  return {
    openai: {
      baseUrl: `${root}/v1`,
      models: `${root}/v1/models`,
      chat: `${root}/v1/chat/completions`,
      responses: `${root}/v1/responses`,
    },
    deepseek: {
      baseUrl: root,
      models: `${root}/models`,
      chat: `${root}/chat/completions`,
    },
    ollama: {
      baseUrl: root,
      apiBaseUrl: `${root}/api`,
      models: `${root}/api/tags`,
      tags: `${root}/api/tags`,
      chat: `${root}/api/chat`,
      generate: `${root}/api/generate`,
      show: `${root}/api/show`,
      version: `${root}/api/version`,
    },
  };
}
