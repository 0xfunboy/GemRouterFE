import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GEMINI_API_TIER1_LIMITS } from '../src/llm/providers/gemini-api/rateLimits.js';

describe('Gemini API configured project quotas', () => {
  const expected = {
    'gemini-3.6-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
    'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
    'gemini-2.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
    'gemini-3.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
    'gemini-3-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
    'gemini-2.5-flash-lite': { rpm: 10, tpm: 250_000, rpd: 20 },
    'gemma-4-31b-it': { rpm: 30, tpm: 16_000, rpd: 14_400 },
    'gemini-3.5-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
    'gemma-4-26b-a4b-it': { rpm: 30, tpm: 16_000, rpd: 14_400 },
  } as const;

  for (const [model, limit] of Object.entries(expected)) {
    it(`${model} matches the quota shown in AI Studio`, () => {
      assert.deepEqual(
        GEMINI_API_TIER1_LIMITS[model as keyof typeof GEMINI_API_TIER1_LIMITS],
        limit,
      );
    });
  }

  it('matches the Gemini 3.7 Flash quota shown for account2 in AI Studio', () => {
    assert.deepEqual(
      GEMINI_API_TIER1_LIMITS['gemini-3.7-flash'],
      expected['gemini-3.6-flash'],
    );
  });

  it('uses the conservative adjacent-Flash budget for Gemini 3.8 Flash', () => {
    assert.deepEqual(
      GEMINI_API_TIER1_LIMITS['gemini-3.8-flash'],
      expected['gemini-3.6-flash'],
    );
  });

  it('keeps the deployed Gemini 3 Flash preview alias on the same budget', () => {
    assert.deepEqual(
      GEMINI_API_TIER1_LIMITS['gemini-3-flash-preview'],
      expected['gemini-3-flash'],
    );
  });
});
