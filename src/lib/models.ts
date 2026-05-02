export const PLAYWRIGHT_MODEL_IDS = ['gemini-web', 'google/gemini-web'] as const;

export const DEFAULT_DIRECT_MODEL_IDS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
] as const;

export interface PublicModelDescriptor {
  id: string;
  kind: 'playwright' | 'direct';
  family: string;
  label: string;
  experimental: boolean;
}

function unique(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))];
}

export function normalizePublicModelId(input: string | undefined): string {
  const value = String(input ?? '').trim().toLowerCase();
  if (!value) throw new Error('model is required');
  return value;
}

export function isPlaywrightModelId(modelId: string): boolean {
  return PLAYWRIGHT_MODEL_IDS.includes(modelId as (typeof PLAYWRIGHT_MODEL_IDS)[number]);
}

export function isDirectGeminiModelId(modelId: string): boolean {
  return !isPlaywrightModelId(modelId) && /^(gemini|gemma)-/i.test(modelId);
}

export function buildPublicModelIds(directModelIds: string[]): string[] {
  return unique([...PLAYWRIGHT_MODEL_IDS, ...directModelIds]);
}

export function buildDirectModelCatalog(configuredModelIds: string[]): PublicModelDescriptor[] {
  return unique(configuredModelIds).map((modelId) => ({
    id: modelId,
    kind: 'direct',
    family: modelId.startsWith('gemma-') ? 'gemma' : 'gemini',
    label: modelId,
    experimental: /preview|experimental|exp/i.test(modelId),
  }));
}

export function describePublicModel(modelId: string): PublicModelDescriptor {
  if (isPlaywrightModelId(modelId)) {
    return {
      id: modelId,
      kind: 'playwright',
      family: 'gemini-web',
      label: modelId === 'google/gemini-web' ? 'Google Gemini Web' : 'Gemini Web',
      experimental: false,
    };
  }

  return {
    id: modelId,
    kind: 'direct',
    family: modelId.startsWith('gemma-') ? 'gemma' : 'gemini',
    label: modelId,
    experimental: /preview|experimental|exp/i.test(modelId),
  };
}
