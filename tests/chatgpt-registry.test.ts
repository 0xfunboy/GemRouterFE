import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { loadConfig } from '../src/config.js';
import { ChatGptWorkerRegistry } from '../src/llm/providers/chatgpt/registry.js';
import { ChatGptGatewayStore } from '../src/llm/providers/chatgpt/store.js';

it('validates registry mutations and clears only explicitly removed optional fields', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gemrouter-registry-review-'));
  const config = loadConfig({ GEMROUTER_ROOT_DIR: root, GEMROUTER_ADMIN_TOKEN: 'test-admin', GEMROUTER_BOOTSTRAP_API_KEY: 'test-app' }).chatgpt;
  const store = new ChatGptGatewayStore(config);
  try {
    const registry = new ChatGptWorkerRegistry(store, config, () => new Set(['gemini-test']));
    const input = { id: 'worker', label: 'Worker', declaredModel: 'Unverified', publicModelIds: ['private-alias'], allowedAppIds: ['app-one'], domainLabel: 'Domain', declaredReasoning: 'High' };
    for (const change of [{ id: 12 }, { publicModelIds: [12] }, { enabled: 'false' }, { allowedAppIds: 'app-one' },
      { publicModelIds: ['private-alias', 'PRIVATE-ALIAS'] }, { timeoutMs: '1000' }, { secret: true }]) {
      assert.throws(() => registry.create({ ...input, ...change }));
    }
    registry.create(input);
    assert.equal(registry.get('bad/id'), null);
    assert.throws(() => registry.update('worker', null));
    assert.throws(() => registry.update('worker', { modelVerified: true }));
    assert.equal(registry.update('worker', { label: 'Renamed' }).domainLabel, 'Domain');
    const cleared = registry.update('worker', { domainLabel: '', declaredReasoning: null });
    assert.equal(cleared.domainLabel, undefined);
    assert.equal(cleared.declaredReasoning, undefined);
    assert.equal(cleared.label, 'Renamed');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
