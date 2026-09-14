import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';
import { canonicalChatGptOrigin } from '../src/llm/providers/chatgpt/auth.js';

describe('ChatGPT gateway feature configuration', () => {
  it('is disabled by default and does not enter the ordinary backend order', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'gemrouter-chatgpt-config-'));
    try {
      const config = loadConfig({
        GEMROUTER_ROOT_DIR: rootDir,
        GEMROUTER_ADMIN_TOKEN: 'test-admin',
        GEMROUTER_BOOTSTRAP_API_KEY: 'test-app',
        GEMROUTER_FREE_TIER_POLICY_ENABLED: 'false',
      });
      assert.equal(config.chatgpt.enabled, false);
      assert.equal(config.chatgpt.profile, 'compatibility');
      assert.equal(config.chatgpt.timeoutMs, 300_000);
      assert.equal(config.chatgpt.queueTimeoutMs, 60_000);
      assert.equal(config.llmRouting.backendOrder.includes('chatgpt'), false);
      assert.equal(existsSync(config.chatgpt.dataDir), false);
      assert.throws(() => loadConfig({
        GEMROUTER_ROOT_DIR: rootDir,
        GEMROUTER_ADMIN_TOKEN: 'test-admin',
        GEMROUTER_BOOTSTRAP_API_KEY: 'test-app',
        GEMROUTER_CHATGPT_PROFILE: 'typo',
      }), /must be compatibility or strict/iu);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('requires a clean HTTPS origin except for explicit loopback tests', () => {
    assert.equal(canonicalChatGptOrigin('https://router.example.com/'), 'https://router.example.com');
    assert.equal(canonicalChatGptOrigin('http://127.0.0.1:4024'), 'http://127.0.0.1:4024');
    assert.throws(() => canonicalChatGptOrigin('http://router.example.com'));
    assert.throws(() => canonicalChatGptOrigin('https://router.example.com/path'));
    assert.throws(() => canonicalChatGptOrigin('https://user:secret@router.example.com'));
  });
});
