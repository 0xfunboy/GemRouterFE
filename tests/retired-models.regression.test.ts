import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  buildDiscoveredModelCatalog,
  buildFreeTierModelIds,
  buildPublicModelIds,
  filterRetiredGeminiModelIds,
  isRetiredGeminiModelId,
} from '../src/lib/models.js';
import { GeminiAccountModelCatalog } from '../src/llm/providers/gemini-api/accountCatalog.js';
import { buildGeminiModelAttemptPlan } from '../src/llm/providers/gemini-api/client.js';
import { GeminiApiModelDiscovery } from '../src/llm/providers/gemini-api/modelDiscovery.js';

const retired = 'gemini-3.1-flash-live-preview';

describe('retired Gemini model exclusion', () => {
  it('filters confirmed retired IDs from every model-list builder', () => {
    assert.equal(isRetiredGeminiModelId(retired), true);
    assert.equal(isRetiredGeminiModelId(`models/${retired}`), true);
    assert.deepEqual(filterRetiredGeminiModelIds([retired, 'GEMINI-ACTIVE']), ['gemini-active']);
    assert.deepEqual(buildPublicModelIds([retired, 'gemini-active']), ['gemini-active']);
    assert.deepEqual(buildFreeTierModelIds({
      textModelIds: [retired, 'gemini-active'],
      audioModelIds: [],
      embeddingModelIds: [],
    }), ['gemini-active']);
    assert.deepEqual(buildGeminiModelAttemptPlan({
      requestedModelId: retired,
      strictModelIds: [retired],
      pureImageRequest: true,
    }), []);
    assert.deepEqual(buildDiscoveredModelCatalog([
      { id: retired, supportedGenerationMethods: ['bidiGenerateContent'] },
      { id: 'gemini-active', supportedGenerationMethods: ['generateContent'] },
    ]).map((model) => model.id), ['gemini-active']);
  });

  it('cannot restore a retired ID from environment configuration or cached catalogs', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'gemrouter-retired-model-'));
    try {
      const config = loadConfig({
        GEMROUTER_ROOT_DIR: rootDir,
        GEMROUTER_ADMIN_TOKEN: 'admin-test-token',
        GEMROUTER_BOOTSTRAP_API_KEY: 'bootstrap-test-key',
        GEMROUTER_FREE_TIER_TEXT_MODELS: `${retired},gemini-3.8-flash`,
        GEMROUTER_FREE_TIER_AUDIO_MODELS: `${retired},gemini-3.1-flash-tts-preview`,
        GEMROUTER_FREE_TIER_EMBEDDING_MODELS: `${retired},gemini-embedding-2`,
        GEMROUTER_TEXT_FALLBACK_MODELS: `${retired},gemini-3.8-flash`,
        GEMINI_DIRECT_MODELS: `${retired},gemini-3.8-flash`,
        GEMROUTER_GEMINI_API_STRICT_MODELS: retired,
        GEMROUTER_FREE_TIER_PARSE_MODEL: retired,
        GEMROUTER_GEMINI_API_LIMITS_JSON: JSON.stringify({ [retired]: { rpm: 1, tpm: 1, rpd: 1 } }),
        GEMROUTER_GEMINI_API_GROUP_LIMITS_JSON: JSON.stringify({ test: { [retired]: { rpm: 1, tpm: 1, rpd: 1 } } }),
        GEMROUTER_GEMINI_API_KEYS_JSON: JSON.stringify([{ id: 'test', key: 'secret', models: [retired, 'gemini-3.8-flash'] }]),
      });

      assert.equal(JSON.stringify({
        modelIds: config.modelIds,
        freeTierPolicy: config.freeTierPolicy,
        limits: config.geminiApi.limits,
        groupLimits: config.geminiApi.groupLimits,
        keys: config.geminiApi.keys.map((key) => key.models),
      }).includes(retired), false);
      assert.equal(config.freeTierPolicy.parseModel, 'gemini-3.8-flash');

      mkdirSync(path.dirname(config.geminiApi.discoveryCachePath), { recursive: true });
      writeFileSync(config.geminiApi.discoveryCachePath, JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        lastError: null,
        models: [
          { id: retired, name: `models/${retired}`, supportedGenerationMethods: ['bidiGenerateContent'] },
          { id: 'gemini-3.8-flash', name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        ],
      }));
      writeFileSync(config.geminiApi.accountModelsCachePath, JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        accounts: {
          test: { accountId: 'test', models: [retired, 'gemini-3.8-flash'], fetchedAt: new Date().toISOString(), error: null },
        },
      }));

      assert.deepEqual(new GeminiApiModelDiscovery(config.geminiApi).snapshot().models.map((model) => model.id), ['gemini-3.8-flash']);
      const accountCatalog = new GeminiAccountModelCatalog(config.geminiApi);
      assert.equal(accountCatalog.allows('test', retired), false);
      assert.equal(new GeminiAccountModelCatalog({
        ...config.geminiApi,
        accountModelsCachePath: path.join(rootDir, 'missing-account-catalog.json'),
      }).allows('test', retired), false);
      assert.equal(accountCatalog.allows('test', 'gemini-3.8-flash'), true);
      assert.equal(JSON.stringify(accountCatalog.snapshot()).includes(retired), false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
