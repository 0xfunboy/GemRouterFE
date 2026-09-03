import type { GeminiApiRateLimit } from './types.js';

export const GEMINI_API_TIER1_LIMITS = {
  // Confirmed in the account2 AI Studio free-tier limits view on 2026-08-17.
  'gemini-3.7-flash': {
    rpm: 5,
    tpm: 250_000,
    rpd: 20,
  },
  // Conservative Tier 1 admission budget matching the adjacent Flash models.
  // The provider remains authoritative and the local ledger tightens on live 429s.
  'gemini-3.8-flash': {
    rpm: 5,
    tpm: 250_000,
    rpd: 20,
  },
  'gemini-3.6-flash': {
    rpm: 5,
    tpm: 250_000,
    rpd: 20,
  },
  'gemini-2.5-flash': {
    rpm: 5,
    tpm: 250_000,
    rpd: 20,
  },
  // Catalogued so it is recognised as a known model (silences the "new model" alert);
  // not part of the default text chain because it has no usable free-tier RPD here.
  'gemini-2.5-pro': {
    rpm: 5,
    tpm: 250_000,
    rpd: 100,
  },
  'gemini-2.0-flash': {
    rpm: 15,
    tpm: 1_000_000,
    rpd: 200,
  },
  'gemini-2.0-flash-lite': {
    rpm: 30,
    tpm: 1_000_000,
    rpd: 200,
  },
  'gemini-2.5-flash-lite': {
    rpm: 10,
    tpm: 250_000,
    rpd: 20,
  },
  'gemini-3-flash': {
    rpm: 5,
    tpm: 250_000,
    rpd: 20,
  },
  'gemini-3.5-flash': {
    rpm: 5,
    tpm: 250_000,
    rpd: 20,
  },
  // Lite sibling: higher free-tier ceilings than 3.5-flash (mirrors 3.1-flash-lite).
  'gemini-3.5-flash-lite': {
    rpm: 15,
    tpm: 250_000,
    rpd: 500,
  },
  'gemini-3-flash-preview': {
    rpm: 5,
    tpm: 250_000,
    rpd: 20,
  },
  'gemini-3.1-flash-lite': {
    rpm: 15,
    tpm: 250_000,
    rpd: 500,
  },
  'gemini-3.1-flash-lite-preview': {
    rpm: 15,
    tpm: 250_000,
    rpd: 500,
  },
  'gemma-4-31b-it': {
    rpm: 30,
    tpm: 16_000,
    rpd: 14_400,
  },
  'gemma-4-26b-a4b-it': {
    rpm: 30,
    tpm: 16_000,
    rpd: 14_400,
  },
  'gemini-embedding-001': {
    rpm: 3000,
    tpm: 1_000_000,
    rpd: null,
  },
  'gemini-embedding-002': {
    rpm: 3000,
    tpm: 1_000_000,
    rpd: null,
  },
} satisfies Record<string, GeminiApiRateLimit>;

export function getGeminiApiLimit(
  model: string,
  limits: Record<string, GeminiApiRateLimit>,
): GeminiApiRateLimit {
  return limits[model] ?? limits[model.replace(/^models\//, '')] ?? {
    rpm: 5,
    tpm: 250_000,
    rpd: 20,
  };
}
