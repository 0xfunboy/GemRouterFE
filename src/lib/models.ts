export const DEFAULT_DIRECT_MODEL_IDS = [
  'gemini-3-flash-preview',
  'gemma-4-31b-it',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
] as const;

export const DEFAULT_FREE_TIER_TEXT_MODEL_IDS = [
  'gemini-3-flash-preview',
  'gemma-4-31b-it',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
] as const;

export const DEFAULT_FREE_TIER_AUDIO_MODEL_IDS = [
  'gemini-3.1-flash-live-preview',
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-2.5-flash-preview-tts',
] as const;

export const DEFAULT_FREE_TIER_EMBEDDING_MODEL_IDS = [
  'gemini-embedding-2',
] as const;

export const DEFAULT_TEXT_FALLBACK_MODEL_IDS = [
  'gemini-3-flash-preview',
  'gemma-4-31b-it',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
] as const;

export interface PublicModelDescriptor {
  id: string;
  kind: 'gemini-api';
  family: string;
  label: string;
  experimental: boolean;
}

export interface ModelCapabilityFlags {
  chat: boolean;
  imageGeneration: boolean;
  live: boolean;
  embeddings: boolean;
  longRunning: boolean;
  nativeAudio: boolean;
  tts: boolean;
}

export interface DiscoveredModelCatalogEntry {
  id: string;
  displayName: string;
  label: string;
  supportedGenerationMethods: string[];
  capabilities: ModelCapabilityFlags;
}

export function isGemRouterCompatibleModelCapabilities(capabilities: ModelCapabilityFlags): boolean {
  return capabilities.chat || capabilities.imageGeneration;
}

function unique(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))];
}

export function normalizePublicModelId(input: string | undefined): string {
  const value = String(input ?? '').trim().toLowerCase();
  if (!value) throw new Error('model is required');
  return value.replace(/^models\//, '');
}

export function isGeminiApiModelId(modelId: string): boolean {
  return /^(gemini|gemma)-/i.test(modelId);
}

export function isDirectGeminiModelId(modelId: string): boolean {
  return isGeminiApiModelId(modelId);
}

export function isGeminiImageGenerationModelId(modelId: string): boolean {
  return /(?:^|-)image(?:-|$)|nano-banana|pro-image/i.test(modelId);
}

export function isGeminiLiveModelId(modelId: string): boolean {
  return /(?:^|-)live(?:-|$)/i.test(modelId);
}

export function isGeminiEmbeddingModelId(modelId: string): boolean {
  return /embedding/i.test(modelId);
}

export function isGeminiLongRunningModelId(modelId: string): boolean {
  return /^veo-/i.test(modelId);
}

export function isGeminiNativeAudioModelId(modelId: string): boolean {
  return /native-audio/i.test(modelId);
}

export function isGeminiTtsModelId(modelId: string): boolean {
  return /(?:^|-)tts(?:-|$)/i.test(modelId);
}

export function inferModelCapabilities(
  modelId: string,
  supportedGenerationMethods: string[] = [],
): ModelCapabilityFlags {
  const methods = new Set(supportedGenerationMethods.map((method) => method.trim()));
  const imageGeneration = isGeminiImageGenerationModelId(modelId);
  const live = methods.has('bidiGenerateContent') || isGeminiLiveModelId(modelId);
  const embeddings = methods.has('embedContent') || methods.has('asyncBatchEmbedContent') || isGeminiEmbeddingModelId(modelId);
  const longRunning = methods.has('predictLongRunning') || isGeminiLongRunningModelId(modelId);
  const nativeAudio = isGeminiNativeAudioModelId(modelId);
  const tts = isGeminiTtsModelId(modelId);
  const generateContent = methods.has('generateContent');

  return {
    chat: generateContent && !live && !embeddings && !longRunning && !nativeAudio && !tts,
    imageGeneration: imageGeneration && generateContent,
    live,
    embeddings,
    longRunning,
    nativeAudio,
    tts,
  };
}

export function buildDiscoveredModelCatalog(
  input: Array<{
    id: string;
    displayName?: string | null;
    supportedGenerationMethods?: string[];
  }>,
): DiscoveredModelCatalogEntry[] {
  return unique(input.map((entry) => entry.id)).map((modelId) => {
    const source = input.find((entry) => entry.id === modelId);
    const displayName = source?.displayName?.trim() || modelId;
    const supportedGenerationMethods = Array.isArray(source?.supportedGenerationMethods)
      ? source.supportedGenerationMethods.filter(Boolean)
      : [];
    const capabilities = inferModelCapabilities(modelId, supportedGenerationMethods);
    const tags = [
      capabilities.imageGeneration ? 'image' : '',
      capabilities.live ? 'live' : '',
      capabilities.embeddings ? 'embeddings' : '',
      capabilities.longRunning ? 'long-running' : '',
      capabilities.nativeAudio ? 'native-audio' : '',
      capabilities.tts ? 'tts' : '',
      capabilities.chat ? 'chat' : '',
    ].filter(Boolean);

    return {
      id: modelId,
      displayName,
      label: tags.length > 0 ? `${displayName} [${tags.join(', ')}]` : displayName,
      supportedGenerationMethods,
      capabilities,
    };
  });
}

export function buildPublicModelIds(directModelIds: string[]): string[] {
  return unique(directModelIds);
}

export function buildFreeTierModelIds(input: {
  textModelIds?: string[];
  audioModelIds?: string[];
  embeddingModelIds?: string[];
} = {}): string[] {
  return unique([
    ...(input.textModelIds ?? [...DEFAULT_FREE_TIER_TEXT_MODEL_IDS]),
    ...(input.audioModelIds ?? [...DEFAULT_FREE_TIER_AUDIO_MODEL_IDS]),
    ...(input.embeddingModelIds ?? [...DEFAULT_FREE_TIER_EMBEDDING_MODEL_IDS]),
  ]);
}

export function buildDirectModelCatalog(configuredModelIds: string[]): PublicModelDescriptor[] {
  return unique(configuredModelIds).map((modelId) => ({
    id: modelId,
    kind: 'gemini-api',
    family: modelId.startsWith('gemma-') ? 'gemma' : 'gemini',
    label: modelId,
    experimental: /preview|experimental|exp/i.test(modelId),
  }));
}

export function describePublicModel(modelId: string): PublicModelDescriptor {
  return {
    id: modelId,
    kind: 'gemini-api',
    family: modelId.startsWith('gemma-') ? 'gemma' : 'gemini',
    label: modelId,
    experimental: /preview|experimental|exp/i.test(modelId),
  };
}
