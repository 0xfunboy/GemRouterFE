import type { NvidiaModelConfig } from './types.js';

/** nvidia-auto plus the per-tier aliases (nvidia-small / nvidia-medium / nvidia-large). */
export function isNvidiaTierAlias(model: string): boolean {
  return /^nvidia-(auto|small|medium|large)$/.test(model);
}

/** The id after the vendor prefix works as an implicit alias ("deepseek-ai/x" → "x"). */
export function bareModelName(id: string): string {
  return id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
}

/**
 * Every name the NVIDIA client resolves: catalog ids, their bare names, and declared
 * aliases. The router uses this set to decide which models may route to the nvidia
 * backend — keep it derived from the same catalog the client indexes.
 */
export function buildNvidiaServableModelIds(models: NvidiaModelConfig[]): string[] {
  return [...new Set(models
    .filter((model) => model.enabled)
    .flatMap((model) => [
      model.id,
      bareModelName(model.id),
      ...(model.aliases ?? []),
    ]))];
}
