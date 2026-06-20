import { randomUUID } from 'node:crypto';

import { GeminiApiProviderError } from './errors.js';
import type { GeminiApiQuotaLedger } from './quotaLedger.js';
import type { GeminiApiKeyConfig, GeminiApiProviderConfig } from './types.js';

export interface GeminiApiKeyReservation {
  key: GeminiApiKeyConfig;
  model: string;
  requestId: string;
  estimatedTokens: number;
}

function allowsModel(key: GeminiApiKeyConfig, model: string): boolean {
  return !key.models || key.models.length === 0 || key.models.includes(model);
}

function capacityScore(input: {
  rpmRemaining: number | null;
  tpmRemaining: number | null;
  rpdRemaining: number | null;
  limit: { rpm: number | null; tpm: number | null; rpd: number | null };
}): number {
  const rpmRatio = input.limit.rpm && input.rpmRemaining !== null ? input.rpmRemaining / input.limit.rpm : 1;
  const tpmRatio = input.limit.tpm && input.tpmRemaining !== null ? input.tpmRemaining / input.limit.tpm : 1;
  const rpdRatio = input.limit.rpd && input.rpdRemaining !== null ? input.rpdRemaining / input.limit.rpd : 1;
  return rpmRatio * 30 + tpmRatio * 30 + rpdRatio * 30;
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rotationTimestamp(input: { lastSuccessAt?: string; lastUsedAt?: string }): number {
  return parseTimestamp(input.lastSuccessAt) || parseTimestamp(input.lastUsedAt);
}

export class GeminiApiKeyPool {
  constructor(
    private readonly config: GeminiApiProviderConfig,
    private readonly ledger: GeminiApiQuotaLedger,
  ) {}

  reserve(
    model: string,
    estimatedTokens: number,
    options?: {
      excludeKeyIds?: string[];
    },
  ): GeminiApiKeyReservation {
    if (!this.config.enabled) {
      throw new GeminiApiProviderError('backend_disabled', 'Gemini API backend is disabled.', {
        statusCode: 503,
        fallbackEligible: true,
      });
    }
    if (this.config.keys.length === 0) {
      throw new GeminiApiProviderError('gemini_api_missing_key', 'No Gemini API keys are configured.', {
        statusCode: 503,
        fallbackEligible: true,
      });
    }

    const excludedKeyIds = new Set((options?.excludeKeyIds ?? []).map((value) => value.trim()).filter(Boolean));
    const keyOrder = new Map(this.config.keys.map((key, index) => [key.id, index]));
    const candidates = this.config.keys
      .filter((key) => key.enabled)
      .filter((key) => allowsModel(key, model))
      .filter((key) => !excludedKeyIds.has(key.id))
      .map((key) => {
        const availability = this.ledger.getAvailability(key.quotaGroup, model, estimatedTokens);
        const keyState = this.ledger.getKeyState(key.id);
        return {
          key,
          availability,
          keyState,
          rotationAt: rotationTimestamp(keyState),
          order: keyOrder.get(key.id) ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .filter((candidate) => candidate.availability.available)
      .sort((left, right) => {
        if (left.key.priority !== right.key.priority) {
          return right.key.priority - left.key.priority;
        }
        if (left.rotationAt !== right.rotationAt) {
          return left.rotationAt - right.rotationAt;
        }
        const capacityDelta = capacityScore({
          rpmRemaining: right.availability.rpmRemaining,
          tpmRemaining: right.availability.tpmRemaining,
          rpdRemaining: right.availability.rpdRemaining,
          limit: right.availability.limit,
        }) - capacityScore({
          rpmRemaining: left.availability.rpmRemaining,
          tpmRemaining: left.availability.tpmRemaining,
          rpdRemaining: left.availability.rpdRemaining,
          limit: left.availability.limit,
        });
        if (capacityDelta !== 0) return capacityDelta;
        return left.order - right.order;
      });

    if (candidates.length === 0) {
      const anyForModel = this.config.keys.some((key) => key.enabled && allowsModel(key, model));
      throw new GeminiApiProviderError(
        anyForModel ? 'gemini_api_quota_unavailable' : 'gemini_api_no_key_for_model',
        anyForModel
          ? `No Gemini API quota group is currently available for ${model}.`
          : `No enabled Gemini API key allows model ${model}.`,
        {
          statusCode: anyForModel ? 429 : 503,
          fallbackEligible: true,
        },
      );
    }

    const selected = candidates[0].key;
    const requestId = randomUUID();
    this.ledger.reserve({
      quotaGroup: selected.quotaGroup,
      keyId: selected.id,
      model,
      estimatedTokens,
      requestId,
    });
    return { key: selected, model, requestId, estimatedTokens };
  }
}
