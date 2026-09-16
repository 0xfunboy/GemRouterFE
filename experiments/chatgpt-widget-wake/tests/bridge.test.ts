import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { z } from 'zod';
import { createMountId, selectBridge } from '../bridge.js';

test('SIMULATO: mount UUID works without secure-context-only randomUUID', () => {
  const crypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  const ids = Array.from({ length: 64 }, () => createMountId(crypto));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) { z.uuid().parse(id); assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); }
  assert.throws(() => createMountId(undefined), /secure_random_unavailable/);
});
test('SIMULATO: prefer advertised standard, require handshake for undeclared legacy standard', () => {
  assert.equal(selectBridge(true, { message: { text: {} } }, true).method, 'ui/message');
  assert.equal(selectBridge(true, {}, false).method, 'ui/message');
  assert.equal(selectBridge(true, {}, false).declared, false);
  assert.equal(selectBridge(false, {}, false).method, undefined);
  assert.equal(selectBridge(true, { message: {} }, false).method, undefined);
});
test('SIMULATO: compatibility alias must exist; detecting it never calls it', () => {
  assert.equal(selectBridge(false, undefined, true).method, 'openai.sendFollowUpMessage');
  assert.equal(selectBridge(true, {}, true).method, 'openai.sendFollowUpMessage');
  assert.equal(selectBridge(false, undefined, false).method, undefined);
});
