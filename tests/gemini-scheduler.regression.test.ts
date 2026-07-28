import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  buildGeminiModelAttemptPlan,
  computeGeminiAttemptTimeoutMs,
  createGeminiApiClient,
  estimateGeminiAdmissionTokens,
  GEMINI_MAX_UPSTREAM_ATTEMPTS_PER_REQUEST,
  isGeminiModelHardTpmIneligible,
} from '../src/llm/providers/gemini-api/client.js';
import { GeminiApiProviderError } from '../src/llm/providers/gemini-api/errors.js';
import { LLMHedgeCancelled } from '../src/llm/errors.js';
import type { GeminiApiProviderConfig } from '../src/llm/providers/gemini-api/types.js';

const workDirs: string[] = [];
after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

function makeConfig(input?: {
  keyCount?: number;
  limits?: GeminiApiProviderConfig['limits'];
  fallbackModelIds?: string[];
}): GeminiApiProviderConfig {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-scheduler-'));
  workDirs.push(dir);
  const models = Object.keys(input?.limits ?? {
    'gemma-4-31b-it': { rpm: 30, tpm: 16_000, rpd: 14_400 },
    'gemma-4-26b-a4b-it': { rpm: 30, tpm: 16_000, rpd: 14_400 },
    'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
  });
  const discoveryCachePath = path.join(dir, 'discovery.json');
  writeFileSync(discoveryCachePath, `${JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    lastError: null,
    models: models.map((id) => ({
      id,
      name: `models/${id}`,
      displayName: id,
      description: null,
      inputTokenLimit: null,
      outputTokenLimit: null,
      supportedGenerationMethods: ['generateContent'],
      source: 'local-ledger',
      discoveredAt: new Date().toISOString(),
    })),
  })}\n`);
  return {
    enabled: true,
    keys: Array.from({ length: input?.keyCount ?? 3 }, (_, index) => ({
      id: `account${index + 1}`,
      key: `key${index + 1}`,
      quotaGroup: `group${index + 1}`,
      tier: 'free',
      enabled: true,
      priority: 100,
      models,
    })),
    accountsPath: path.join(dir, 'accounts.json'),
    baseUrl: 'https://gemini.test.invalid',
    version: 'v1beta',
    defaultTier: 'free',
    defaultQuotaGroupMode: 'per-key',
    limits: input?.limits ?? {
      'gemma-4-31b-it': { rpm: 30, tpm: 16_000, rpd: 14_400 },
      'gemma-4-26b-a4b-it': { rpm: 30, tpm: 16_000, rpd: 14_400 },
      'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
    },
    groupLimits: {},
    ledgerPath: path.join(dir, 'ledger.json'),
    discoveryCachePath,
    discoveryRefreshMs: 60_000,
    accountModelsCachePath: path.join(dir, 'account-models.json'),
    accountModelsRefreshMs: 0,
    quotaCooldownMs: 60_000,
    rpdWindowMs: 86_400_000,
    rpmWindowMs: 60_000,
    tpmWindowMs: 60_000,
    countTokensPreflight: false,
    countFailed429AsUsage: false,
    timeoutMs: 75_000,
    streamTimeoutMs: 75_000,
    fallbackModelIds: input?.fallbackModelIds ?? models,
    strictModelIds: [],
  };
}

function modelFromUrl(value: URL | RequestInfo): string {
  return decodeURIComponent(String(value).match(/\/models\/([^:]+):generateContent/)?.[1] ?? '');
}

function okResponse(model: string, promptTokens = 100): Response {
  return Response.json({
    candidates: [{ content: { parts: [{ text: `ok:${model}` }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 2, totalTokenCount: promptTokens + 2 },
  });
}

describe('Gemini request scheduler', () => {
  it('plans exact -> closest downgrade and rejects candidates from other providers', () => {
    const allowed = [
      'nvidia-auto',
      'qwen/qwen3.5-397b-a17b',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-2.5-flash',
      'gemini-3.1-flash-lite',
      'gemma-4-31b-it',
      'gemma-4-26b-a4b-it',
    ];
    assert.deepEqual(
      buildGeminiModelAttemptPlan({
        requestedModelId: 'gemma-4-31b-it',
        allowedModelIds: allowed,
        preferredFallbackModelIds: allowed,
      }).slice(0, 3),
      ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-2.5-flash'],
    );
    assert.deepEqual(
      buildGeminiModelAttemptPlan({
        requestedModelId: 'gemini-3.6-flash',
        allowedModelIds: allowed,
        preferredFallbackModelIds: [...allowed].reverse(),
      }).slice(0, 4),
      ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemma-4-31b-it'],
    );
    assert.equal(
      buildGeminiModelAttemptPlan({
        requestedModelId: 'gemini-3.6-flash',
        allowedModelIds: allowed,
      }).some((model) => model.includes('/') || model.startsWith('nvidia-')),
      false,
    );
  });

  it('respects both strict models and the per-request allowlist', () => {
    assert.deepEqual(
      buildGeminiModelAttemptPlan({
        requestedModelId: 'gemini-3.6-flash',
        allowedModelIds: ['gemini-3.6-flash', 'gemini-3.5-flash'],
        strictModelIds: ['gemini-3.6-flash'],
      }),
      ['gemini-3.6-flash'],
    );
    assert.deepEqual(
      buildGeminiModelAttemptPlan({
        requestedModelId: 'gemini-3.6-flash',
        allowedModelIds: ['gemini-3.1-flash-lite'],
        strictModelIds: ['gemini-3.6-flash'],
      }),
      [],
    );
  });

  it('time-slices early attempts so fallbacks retain deadline budget', () => {
    assert.equal(computeGeminiAttemptTimeoutMs({
      providerTimeoutMs: 120_000,
      deadline: 75_000,
      remainingModels: 4,
      now: 0,
    }), 15_000);
    assert.equal(computeGeminiAttemptTimeoutMs({
      providerTimeoutMs: 120_000,
      deadline: 50_000,
      remainingModels: 1,
      now: 0,
    }), 15_000);
    assert.equal(computeGeminiAttemptTimeoutMs({
      providerTimeoutMs: 120_000,
      deadline: 40_000,
      remainingModels: 0,
      now: 0,
    }), 40_000);
  });

  it('treats a request larger than every account TPM as locally ineligible', () => {
    const config = makeConfig();
    assert.equal(isGeminiModelHardTpmIneligible(config, 'gemma-4-31b-it', 16_001), true);
    assert.equal(isGeminiModelHardTpmIneligible(config, 'gemma-4-31b-it', 16_000), false);
    assert.ok(estimateGeminiAdmissionTokens([{ role: 'user', content: 'x'.repeat(60_000) }]) > 16_000);
  });

  it('does not sweep accounts after a 5xx; it moves to the closest fallback', async () => {
    const config = makeConfig();
    const client = createGeminiApiClient(config);
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const model = modelFromUrl(url);
      calls.push(model);
      if (model === 'gemma-4-31b-it') {
        return Response.json({ error: { code: 500, status: 'INTERNAL', message: 'internal failure' } }, { status: 500 });
      }
      return okResponse(model);
    };
    try {
      const response = await client.chat([{ role: 'user', content: 'short' }], {
        model: 'gemma-4-31b-it',
        allowedModelIds: ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'],
      });
      assert.equal(response.backendModel, 'gemma-4-26b-a4b-it');
      assert.deepEqual(calls, ['gemma-4-31b-it', 'gemma-4-26b-a4b-it']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports locally unavailable accounts as skips, never as synthetic upstream 429s', async () => {
    const config = makeConfig({
      keyCount: 2,
      limits: {
        'gemma-4-31b-it': { rpm: 0, tpm: 16_000, rpd: 14_400 },
        'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
      },
    });
    const client = createGeminiApiClient(config);
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const model = modelFromUrl(url);
      calls.push(model);
      return okResponse(model);
    };
    try {
      const response = await client.chat([{ role: 'user', content: 'short' }], {
        model: 'gemma-4-31b-it',
        allowedModelIds: ['gemma-4-31b-it', 'gemini-3.1-flash-lite'],
      });
      assert.deepEqual(calls, ['gemini-3.1-flash-lite']);
      const localSkips = response.fallbackAttempts?.filter((attempt) => attempt.reason === 'local_rpm_limit_zero') ?? [];
      assert.equal(localSkips.length, 1);
      assert.equal(localSkips[0]?.keyId, null);
      assert.equal(localSkips.every((attempt) => attempt.statusCode === null), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('waits for a near local RPM slot before downgrading the requested model', async () => {
    const config = makeConfig({
      keyCount: 1,
      limits: {
        'gemma-4-31b-it': { rpm: 1, tpm: 16_000, rpd: 14_400 },
        'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
      },
    });
    config.rpmWindowMs = 500;
    const client = createGeminiApiClient(config);
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const model = modelFromUrl(url);
      calls.push(model);
      return okResponse(model);
    };
    try {
      const options = {
        model: 'gemma-4-31b-it',
        allowedModelIds: ['gemma-4-31b-it', 'gemini-3.1-flash-lite'],
      };
      await client.chat([{ role: 'user', content: 'first' }], options);
      const started = Date.now();
      const response = await client.chat([{ role: 'user', content: 'second' }], options);
      assert.equal(response.backendModel, 'gemma-4-31b-it');
      assert.deepEqual(calls, ['gemma-4-31b-it', 'gemma-4-31b-it']);
      assert.ok(Date.now() - started >= 650, 'the scheduler should absorb short local pressure');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rotates the exact model, then preserves breadth across fallback models', async () => {
    const models = {
      'gemini-3.6-flash': { rpm: 100, tpm: 250_000, rpd: 1_000 },
      'gemini-3.5-flash': { rpm: 100, tpm: 250_000, rpd: 1_000 },
      'gemini-3-flash-preview': { rpm: 100, tpm: 250_000, rpd: 1_000 },
      'gemini-2.5-flash': { rpm: 100, tpm: 250_000, rpd: 1_000 },
    };
    const config = makeConfig({ keyCount: 10, limits: models });
    const client = createGeminiApiClient(config);
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(modelFromUrl(url));
      return Response.json({
        error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exhausted' },
      }, { status: 429 });
    };
    try {
      await assert.rejects(
        client.chat([{ role: 'user', content: 'short' }], {
          model: 'gemini-3.6-flash',
          allowedModelIds: Object.keys(models),
        }),
        (error: unknown) => {
          assert.ok(error instanceof GeminiApiProviderError);
          assert.equal(calls.length, GEMINI_MAX_UPSTREAM_ATTEMPTS_PER_REQUEST);
          assert.equal(calls.filter((model) => model === 'gemini-3.6-flash').length, 3);
          assert.equal(calls.filter((model) => model === 'gemini-3.5-flash').length, 1);
          assert.equal(calls.filter((model) => model === 'gemini-3-flash-preview').length, 1);
          assert.equal(calls.filter((model) => model === 'gemini-2.5-flash').length, 1);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips oversized Gemma locally without poisoning a later short request', async () => {
    const config = makeConfig();
    const client = createGeminiApiClient(config);
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const model = modelFromUrl(url);
      calls.push(model);
      return okResponse(model);
    };
    try {
      const longResponse = await client.chat([{ role: 'user', content: 'x'.repeat(60_000) }], {
        model: 'gemma-4-31b-it',
        allowedModelIds: ['gemma-4-31b-it', 'gemini-3.1-flash-lite'],
      });
      assert.equal(longResponse.backendModel, 'gemini-3.1-flash-lite');
      assert.deepEqual(calls, ['gemini-3.1-flash-lite']);
      assert.equal(
        longResponse.fallbackAttempts?.every((attempt) => (
          attempt.reason !== 'local_tpm_request_exceeds_model_limit' || attempt.statusCode === null
        )),
        true,
      );

      const shortResponse = await client.chat([{ role: 'user', content: 'short' }], {
        model: 'gemma-4-31b-it',
        allowedModelIds: ['gemma-4-31b-it', 'gemini-3.1-flash-lite'],
      });
      assert.equal(shortResponse.backendModel, 'gemma-4-31b-it');
      assert.deepEqual(calls, ['gemini-3.1-flash-lite', 'gemma-4-31b-it']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps a dispatched hedge loser in quota without recording an upstream failure', async () => {
    const config = makeConfig({ keyCount: 1 });
    const client = createGeminiApiClient(config);
    const controller = new AbortController();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const signal = init?.signal;
      notifyStarted();
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    try {
      const pending = client.chat([{ role: 'user', content: 'short' }], {
        model: 'gemma-4-31b-it',
        allowedModelIds: ['gemma-4-31b-it'],
        signal: controller.signal,
      });
      await started;
      controller.abort(new LLMHedgeCancelled());
      await assert.rejects(pending, (error: unknown) => error instanceof LLMHedgeCancelled);

      const diagnostics = client.getDiagnostics?.() ?? {};
      assert.equal(diagnostics.lastFailureAt, null);
      const quotaGroups = diagnostics.quotaGroups as Array<{
        models: Array<{ model: string; rpm: { used: number }; lastFailureAt: string | null }>;
      }>;
      const modelState = quotaGroups[0]?.models.find((entry) => entry.model === 'gemma-4-31b-it');
      assert.equal(modelState?.rpm.used, 1);
      assert.equal(modelState?.lastFailureAt, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
