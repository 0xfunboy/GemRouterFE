import type { GeminiApiRateLimit } from './types.js';

export const GEMINI_API_TIER1_LIMITS = {
  'gemini-2.5-flash': {
    rpm: 1000,
    tpm: 1_000_000,
    rpd: 10_000,
  },
  'gemini-2.5-pro': {
    rpm: 150,
    tpm: 2_000_000,
    rpd: 1_000,
  },
  'gemini-2.0-flash': {
    rpm: 2000,
    tpm: 4_000_000,
    rpd: null,
  },
  'gemini-2.0-flash-lite': {
    rpm: 4000,
    tpm: 4_000_000,
    rpd: null,
  },
  'gemini-2.5-flash-lite': {
    rpm: 4000,
    tpm: 4_000_000,
    rpd: null,
  },
  'gemini-3-flash': {
    rpm: 1000,
    tpm: 2_000_000,
    rpd: 10_000,
  },
  'gemini-3.1-flash-lite': {
    rpm: 4000,
    tpm: 4_000_000,
    rpd: 150_000,
  },
  'gemini-3.1-pro': {
    rpm: 25,
    tpm: 2_000_000,
    rpd: 250,
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
    rpm: 60,
    tpm: 60_000,
    rpd: 1_000,
  };
}

