import test from 'node:test';
import assert from 'node:assert/strict';
import { ProbeState } from '../state.js';
import { SESSION_MS, EVENT_MS, CODE_MS, MAX_REMOTE, STOPPED_RETENTION_MS } from '../protocol.js';
import { WORKER } from '../target.js';

const mount = '00000000-0000-0000-0000-a193fc1c44dd';
function fixture() {
  let mono = 0;
  const state = new ProbeState({ mono: () => mono, wall: () => 1_800_000_000_000 + mono });
  const issued = state.issue(), enrolled = state.enroll(issued.code, mount), id = issued.sessionId;
  const receipt = (eventId: string) => {
    for (const stage of ['received', 'bridge_requested', 'bridge_resolved'] as const) state.receipt(id, {
      eventId, stage, method: 'ui/message', elapsedMs: 1, result: stage === 'bridge_resolved' ? 'accepted' : 'none', visibility: 'visible',
    });
  };
  const observe = (eventId: string, workerId = WORKER) => state.observe(id, {
    eventId, workerId, outcome: 'model-tool', targetConfirmed: true, turnEnded: true, conditions: 'foreground',
  });
  const baseline = () => { receipt(enrolled.manualEvent.eventId); observe(enrolled.manualEvent.eventId); };
  return { state, id, issued, enrolled, receipt, observe, baseline, advance: (ms: number) => { mono += ms; } };
}

test('SIMULATO: enrollment single use, session-bound capability, no secrets in report', () => {
  const f = fixture();
  assert.throws(() => f.state.enroll(f.issued.code, mount), /invalid_or_expired/);
  assert.equal(f.state.authenticate(f.enrolled.token, mount), f.id);
  assert.throws(() => f.state.authenticate(f.enrolled.token, 'another-mount'), /invalid_capability/);
  const report = JSON.stringify(f.state.report());
  for (const secret of [f.enrolled.token, f.issued.code, mount]) assert.ok(!report.includes(secret));
});
test('SIMULATO: code and session expire independently on monotonic clocks', () => {
  let now = 0; const s = new ProbeState({ wall: () => 1_800_000_000_000, mono: () => now });
  const issued = s.issue(); now += CODE_MS;
  assert.throws(() => s.enroll(issued.code, mount), /invalid_or_expired/);
  const f = fixture(); f.advance(SESSION_MS);
  assert.throws(() => f.state.authenticate(f.enrolled.token, mount), /session_expired/);
});
test('SIMULATO: code remains usable beyond two minutes until the fixed 24-hour deadline, once only', () => {
  assert.equal(CODE_MS, 86_400_000); assert.equal(SESSION_MS, 86_400_000);
  let now = 0;
  const state = new ProbeState({ mono: () => now, wall: () => 1_800_000_000_000 + now });
  const issued = state.issue(); now = 23 * 3_600_000;
  state.sweep();
  const enrolled = state.enroll(issued.code, mount);
  assert.equal(enrolled.remainingSessionMs, 3_600_000);
  assert.equal(enrolled.expiresAt, issued.expiresAt);
  assert.equal(enrolled.remainingEventMs, 60_000);
  assert.throws(() => state.enroll(issued.code, mount), /invalid_or_expired/);
});
test('SIMULATO: successful baseline and idle listener survive the old 15-minute TTL up to 24 hours', () => {
  const f = fixture(); let closes = 0;
  f.baseline(); f.state.connect(f.id, () => true, () => { closes++; });
  f.advance(SESSION_MS - 1); f.state.sweep();
  assert.equal(f.state.authenticate(f.enrolled.token, mount), f.id);
  assert.equal(f.state.report()[0].state, 'armed');
  assert.equal(f.state.report()[0].connected, true);
  assert.equal(f.state.report()[0].stopReason, null);
  assert.equal(closes, 0);
  f.advance(1); f.state.sweep();
  assert.equal(f.state.report()[0].stopReason, 'session_expired');
  assert.equal(f.state.report()[0].connected, false);
  assert.equal(closes, 1);
  assert.throws(() => f.state.authenticate(f.enrolled.token, mount), /session_expired/);
});
test('SIMULATO: a delivered event is not stopped at its TTL; a fresh event can be sent hours later', () => {
  const f = fixture(); f.baseline(); f.state.connect(f.id, () => true, () => {}); f.advance(30_000);
  const first = f.state.emit(f.id); f.receipt(first.eventId);
  f.advance(EVENT_MS); f.state.sweep();
  assert.equal(f.state.report()[0].state, 'armed');
  // Acceptance remains transport-only even with the longer session.
  assert.throws(() => f.state.emit(f.id), /previous_event_requires_observation/);
  f.observe(first.eventId); f.advance(20 * 3_600_000); f.state.sweep();
  const second = f.state.emit(f.id);
  assert.notEqual(second.eventId, first.eventId);
  assert.equal(f.state.check(f.id, second.eventId).remainingMs, 60_000);
  f.advance(EVENT_MS); f.state.sweep();
  assert.equal(f.state.report()[0].stopReason, 'event_expired');
});
test('SIMULATO: first stop reason and timestamp survive cleanup; retention is not extended to 24 hours', () => {
  const f = fixture(); f.baseline(); f.state.connect(f.id, () => true, () => f.state.stop(f.id, 'sse_closed'));
  f.advance(1000); f.state.stop(f.id, 'widget_stop');
  const stopped = f.state.report()[0];
  assert.equal(stopped.stopReason, 'widget_stop'); assert.ok(stopped.stoppedAt);
  f.advance(STOPPED_RETENTION_MS - 1); f.state.stop(f.id, 'operator_stop'); f.state.sweep();
  assert.equal(f.state.report()[0].stopReason, stopped.stopReason);
  assert.equal(f.state.report()[0].stoppedAt, stopped.stoppedAt);
  assert.throws(() => f.state.connect(f.id, () => true, () => {}), /listener_already_used/);
  f.advance(1); f.state.sweep(); assert.deepEqual(f.state.report(), []);
});
test('SIMULATO: bridge acceptance alone cannot arm or certify a model tool call', () => {
  const f = fixture(); f.receipt(f.enrolled.manualEvent.eventId);
  assert.throws(() => f.state.connect(f.id, () => true, () => {}), /manual_baseline_not_verified/);
  assert.equal(f.state.report()[0].modelInvocationVerifiedByServer, false);
});
test('SIMULATO: readiness never consumes a listener or stops the session before operator verification', () => {
  const f = fixture();
  assert.deepEqual(f.state.readiness(f.id), { baselineVerified: false });
  f.receipt(f.enrolled.manualEvent.eventId);
  const before = f.state.report();
  assert.deepEqual(f.state.readiness(f.id), { baselineVerified: false });
  assert.deepEqual(f.state.report(), before);
  assert.throws(() => f.state.connect(f.id, () => true, () => {}), /manual_baseline_not_verified/);
  assert.deepEqual(f.state.report(), before);
  f.observe(f.enrolled.manualEvent.eventId);
  assert.deepEqual(f.state.readiness(f.id), { baselineVerified: true });
  assert.equal(f.state.report()[0].connected, false);
  f.state.connect(f.id, () => true, () => {});
  assert.deepEqual(f.state.readiness(f.id), { baselineVerified: false });
  f.state.stop(f.id);
  assert.deepEqual(f.state.readiness(f.id), { baselineVerified: false });
  assert.throws(() => f.state.connect(f.id, () => true, () => {}), /listener_already_used/);
});
test('SIMULATO: 30-second baseline wait and two-minute idle; one listener and bounded events', () => {
  const f = fixture(), delivered: string[] = []; let closed = 0;
  f.baseline(); f.state.connect(f.id, e => { delivered.push(e.eventId); return true; }, () => { closed++; });
  assert.throws(() => f.state.connect(f.id, () => true, () => {}), /listener_already_used/);
  assert.throws(() => f.state.emit(f.id), /wait_30/);
  f.advance(30_000);
  const first = f.state.emit(f.id);
  assert.throws(() => f.state.emit(f.id), /previous_event_requires_observation/);
  f.receipt(first.eventId); f.observe(first.eventId);
  f.advance(119_999); assert.throws(() => f.state.emit(f.id), /wait_120/); f.advance(1);
  for (let i = 1; i < MAX_REMOTE; i++) {
    const event = f.state.emit(f.id); f.receipt(event.eventId); f.observe(event.eventId); f.advance(120_000);
  }
  assert.equal(delivered.length, MAX_REMOTE); assert.equal(new Set(delivered).size, MAX_REMOTE);
  assert.throws(() => f.state.emit(f.id), /event_limit/); assert.equal(closed, 1);
});
test('SIMULATO: stop/disconnect cannot rearm or replay; event expiry closes listener', () => {
  const f = fixture(); f.baseline(); f.state.connect(f.id, () => true, () => {}); f.advance(30_000);
  const event = f.state.emit(f.id); f.advance(EVENT_MS);
  assert.throws(() => f.state.check(f.id, event.eventId), /event_expired/);
  assert.throws(() => f.state.connect(f.id, () => true, () => {}), /listener_already_used/);
  assert.throws(() => f.state.authenticate(f.enrolled.token, mount), /session_stopped/);
});
test('SIMULATO: wrong worker, duplicate/out-of-order receipts and arbitrary payloads rejected', () => {
  const f = fixture();
  assert.throws(() => f.state.receipt(f.id, { prompt: 'arbitrary' }));
  assert.throws(() => f.state.receipt(f.id, { eventId: f.enrolled.manualEvent.eventId, stage: 'bridge_resolved',
    method: 'ui/message', elapsedMs: 1, result: 'accepted', visibility: 'visible' }), /receipt_out_of_order/);
  f.receipt(f.enrolled.manualEvent.eventId);
  assert.throws(() => f.receipt(f.enrolled.manualEvent.eventId), /duplicate_receipt/);
  f.observe(f.enrolled.manualEvent.eventId, 'wrong-worker');
  assert.equal(f.state.report()[0].state, 'stopped');
});
test('SIMULATO: ambiguous delivery and missing receipts stop; bounded in-memory retention', () => {
  const f = fixture(); f.baseline(); f.state.connect(f.id, () => false, () => {}); f.advance(30_000);
  assert.throws(() => f.state.emit(f.id), /delivery_ambiguous/);
  f.advance(SESSION_MS * 2); f.state.sweep(); assert.deepEqual(f.state.report(), []);
  const g = fixture(); g.advance(EVENT_MS); g.state.sweep(); assert.equal(g.state.report()[0].state, 'stopped');
});
