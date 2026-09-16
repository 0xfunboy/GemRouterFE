import test from 'node:test';
import assert from 'node:assert/strict';
import { ProbeClient } from '../client.js';
import type { Receipt } from '../protocol.js';

const event = { eventId: 'probe_' + 'a'.repeat(24), kind: 'status-probe', emittedAt: '2026-09-16T00:00:00.000Z', expiresAt: '2026-09-16T00:01:00.000Z' };
function fixture(bridge: (prompt: string) => Promise<unknown> = async () => ({})) {
  const messages: string[] = [], receipts: Receipt[] = [], calls: string[] = []; let stops = 0;
  const client = new ProbeClient({ now: () => 10, visibility: () => 'visible',
    bridge: prompt => { calls.push(prompt); return bridge(prompt); },
    receipt: async receipt => { receipts.push(receipt); }, stop: () => { stops++; }, show: message => { messages.push(message); },
  }, 'Fixed diagnostic EVENT_ID', 'ui/message');
  return { client, calls, receipts, messages, stopped: () => stops };
}
test('SIMULATO: mount and arm do not send; manual bridge invocation is synchronous', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); assert.equal(f.client.arm(), false);
  assert.ok(f.client.invoke(event, 'manual', 100)); assert.equal(f.calls.length, 1);
  await Promise.resolve(); await f.client.flush();
  assert.deepEqual(f.receipts.map(r => r.stage), ['received', 'bridge_requested', 'bridge_resolved']);
  assert.ok(f.messages.at(-1)?.includes('NON verificati')); f.client.disarm();
});
test('SIMULATO: duplicate, expired and malformed events cannot trigger another message', async () => {
  const f = fixture(); f.client.invoke(event, 'manual', 100); await Promise.resolve(); await f.client.flush();
  assert.ok(f.client.arm()); assert.equal(f.client.invoke(event, 'remote', 100), false); assert.equal(f.calls.length, 1);
  const g = fixture(); assert.equal(g.client.invoke(event, 'manual', 9), false); assert.equal(g.calls.length, 0);
  const h = fixture(); assert.equal(h.client.invoke({ ...event, prompt: 'injected' }, 'manual', 100), false); assert.equal(h.calls.length, 0);
});
test('SIMULATO: concurrent, stopped or remounted client never sends automatically', async () => {
  const f = fixture(() => new Promise(() => {})); f.client.invoke(event, 'manual', 100);
  assert.equal(f.client.invoke({ ...event, eventId: 'probe_' + 'b'.repeat(24) }, 'manual', 100), false);
  assert.equal(f.calls.length, 1); assert.equal(f.stopped(), 1);
  const remount = fixture(); assert.equal(remount.calls.length, 0); assert.equal(remount.client.arm(), false);
  remount.client.disarm(); assert.equal(remount.client.invoke(event, 'manual', 100), false);
});
test('SIMULATO: host rejection and missing bridge stop without alias retry', async () => {
  for (const bridge of [async () => ({ isError: true }), async () => { throw Object.assign(new Error('not supported'), { code: -32601 }); }]) {
    const f = fixture(bridge); f.client.invoke(event, 'manual', 100);
    await Promise.resolve(); await f.client.flush(); await Promise.resolve();
    assert.equal(f.calls.length, 1); assert.equal(f.stopped(), 1); assert.equal(f.client.arm(), false);
  }
});
test('SIMULATO: ambiguous bridge timeout stops once and tears down its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => new Promise(() => {})); f.client.invoke(event, 'manual', 100);
  t.mock.timers.tick(15_000); await f.client.flush(); await Promise.resolve();
  assert.equal(f.receipts.at(-1)?.stage, 'bridge_ambiguous'); assert.equal(f.stopped(), 1);
  t.mock.timers.tick(120_000); assert.equal(f.calls.length, 1);
  const g = fixture(() => new Promise(() => {})); g.client.invoke(event, 'manual', 100); g.client.disarm();
  t.mock.timers.tick(120_000); await g.client.flush(); assert.equal(g.receipts.length, 2);
});
