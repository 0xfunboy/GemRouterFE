import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { InteractionStore } from '../src/store/interactions.js';

describe('ChatGPT interaction privacy and unknown usage', () => {
  it('keeps unavailable token accounting unknown in records and aggregates', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-interactions-'));
    try {
      const store = new InteractionStore(path.join(dir, 'interactions.json'));
      const record = store.record({
        appId: 'app',
        appName: 'App',
        route: '/v1/chat/completions',
        model: 'chatgpt-private',
        prompt: '',
        usageSource: 'unavailable',
        status: 'succeeded',
        statusCode: 200,
        provider: 'chatgpt-mcp',
      });
      assert.equal(record.promptExcerpt, '');
      assert.equal(record.responseExcerpt, '');
      assert.equal(record.usage, undefined);
      assert.equal(record.usageSource, 'unavailable');
      const summary = store.summary();
      assert.equal(summary.totals.totalTokens, null);
      assert.equal(summary.totals.promptTokens, null);
      assert.equal(summary.totals.usageUnavailableRequests, 1);
      assert.equal(store.hourlyWindow(1).totals.totalTokens, null);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
