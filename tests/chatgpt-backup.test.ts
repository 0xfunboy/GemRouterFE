import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { applyBackup, buildBackup, summarizeBackupContents } from '../src/lib/backup.js';

describe('ChatGPT gateway backup boundary', () => {
  it('excludes OAuth, run, claim and payload storage from export, restore and safety copies', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'gemrouter-chatgpt-backup-'));
    const dataDir = path.join(rootDir, 'data');
    const gatewayDir = path.join(dataDir, 'chatgpt-gateway');
    try {
      mkdirSync(gatewayDir, { recursive: true });
      writeFileSync(path.join(dataDir, 'legacy.json'), '{"safe":true}\n');
      writeFileSync(path.join(gatewayDir, 'gateway.sqlite'), 'oauth-token claim-token private-payload');
      const options = { rootDir, dataDir, excludedPaths: [gatewayDir] };
      const backup = buildBackup(options);
      assert.deepEqual(Object.keys(backup.files), ['legacy.json']);
      assert.equal(summarizeBackupContents(options).dataFiles, 1);

      const result = applyBackup({
        ...options,
        payload: {
          ...backup,
          files: {
            'legacy.json': '{"restored":true}\n',
            'chatgpt-gateway/gateway.sqlite': 'must-not-restore',
          },
        },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.skippedPaths, ['chatgpt-gateway/gateway.sqlite']);
      assert.equal(readFileSync(path.join(dataDir, 'legacy.json'), 'utf8'), '{"restored":true}\n');
      assert.equal(readFileSync(path.join(gatewayDir, 'gateway.sqlite'), 'utf8'), 'oauth-token claim-token private-payload');
      assert.ok(result.safetyCopyDir);
      assert.equal(existsSync(path.join(result.safetyCopyDir!, 'data', 'chatgpt-gateway')), false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
