import { test } from 'node:test';
import { smokeCodex } from '../scripts/smoke-codex.js';
test('isolated HTTP surfaces, opt-in, model catalog, usage, buffering and CSRF (simulated Codex)', { timeout: 60000 }, async () => { await smokeCodex(); });
