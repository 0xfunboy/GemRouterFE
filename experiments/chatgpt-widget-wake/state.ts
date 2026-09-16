import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CODE_MS, EVENT_MS, MAX_REMOTE, SESSION_MS, STOPPED_RETENTION_MS, receiptSchema, observationSchema, type ProbeEvent, type Receipt } from './protocol.js';
import { WORKER, promptTemplate } from './target.js';

export class ProbeError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
const fail = (code: string, status?: number): never => { throw new ProbeError(code, status); };
const secret = () => randomBytes(32).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s).digest();
const equal = (a: Buffer, s: string) => timingSafeEqual(a, digest(s));
type EventRecord = {
  event: ProbeEvent; mode: 'manual' | 'remote'; emittedMono: number;
  receipts: (Receipt & { serverAt: string; emissionToReceiptMs: number })[];
  observation?: ReturnType<typeof observationSchema.parse> & { source: 'operator_reported'; recordedAt: string };
};
type Session = {
  id: string; expires: number; expiresMono: number; codeHash: Buffer; codeExpires: number;
  tokenHash?: Buffer; mount?: string; state: 'issued' | 'authorized' | 'armed' | 'stopped';
  connectedOnce: boolean; remoteCount: number; events: Map<string, EventRecord>;
  send?: (event: ProbeEvent) => boolean; close?: () => void; lastActivity: number;
  stopReason?: StopReason; stoppedAt?: string; stoppedMono?: number;
};
type StopReason = 'session_expired' | 'event_expired' | 'event_limit' | 'delivery_ambiguous'
  | 'bridge_failed' | 'negative_observation' | 'operator_stop' | 'widget_stop'
  | 'sse_closed' | 'sse_write_failed' | 'server_shutdown';

export class ProbeState {
  private sessions = new Map<string, Session>();
  constructor(private clock = { wall: () => Date.now(), mono: () => performance.now() }) {}
  issue() {
    this.sweep();
    if (this.sessions.size >= 8) fail('session_limit');
    const code = secret(), id = 'session_' + randomBytes(12).toString('hex');
    const s: Session = { id, expires: this.clock.wall() + SESSION_MS, expiresMono: this.clock.mono() + SESSION_MS,
      codeHash: digest(code), codeExpires: this.clock.mono() + CODE_MS, state: 'issued', connectedOnce: false,
      remoteCount: 0, events: new Map(), lastActivity: this.clock.mono() };
    this.sessions.set(id, s);
    return { sessionId: id, code, expiresAt: new Date(s.expires).toISOString() };
  }
  enroll(code: string, mount: string) {
    const s = [...this.sessions.values()].find(s => s.state === 'issued' && equal(s.codeHash, code));
    if (!s || this.clock.mono() >= s.codeExpires || this.clock.mono() >= s.expiresMono) fail('invalid_or_expired_code', 401);
    const token = secret();
    s!.state = 'authorized'; s!.tokenHash = digest(token); s!.mount = mount;
    const manualEvent = this.newEvent(s!, 'manual');
    return { sessionId: s!.id, token, expiresAt: new Date(s!.expires).toISOString(),
      remainingSessionMs: s!.expiresMono - this.clock.mono(), remainingEventMs: EVENT_MS, manualEvent, promptTemplate };
  }
  private session(id: string) {
    const s = this.sessions.get(id);
    if (!s) return fail('session_not_found', 404);
    if (this.clock.mono() >= s.expiresMono) { this.stop(id, 'session_expired'); return fail('session_expired', 410); }
    return s;
  }
  authenticate(token: string, mount: string): string {
    const s = [...this.sessions.values()].find(s => s.tokenHash && equal(s.tokenHash, token) && s.mount === mount);
    if (!s) return fail('invalid_capability', 401);
    this.session(s.id);
    if (s.state === 'stopped') return fail('session_stopped', 410);
    return s.id;
  }
  readiness(id: string) {
    const s = this.session(id), baseline = [...s.events.values()][0];
    // A read-only gate. The widget cannot assert the observation or use this
    // endpoint to reopen a stopped session or consume the one allowed listener.
    return { baselineVerified: s.state === 'authorized' && !s.connectedOnce
      && baseline?.observation?.outcome === 'model-tool' && baseline.observation.workerId === WORKER };
  }
  connect(id: string, send: Session['send'], close: () => void) {
    const s = this.session(id);
    if (s.connectedOnce || s.state !== 'authorized') fail('listener_already_used');
    if (!this.readiness(id).baselineVerified) fail('manual_baseline_not_verified');
    s.state = 'armed'; s.connectedOnce = true; s.send = send; s.close = close; s.lastActivity = this.clock.mono();
  }
  emit(id: string) {
    const s = this.session(id);
    if (s.state !== 'armed' || !s.send) return fail('not_armed');
    if (s.remoteCount >= MAX_REMOTE) { this.stop(id, 'event_limit'); return fail('event_limit'); }
    const last = [...s.events.values()].at(-1)!;
    if (!last.observation) fail('previous_event_requires_observation');
    if (last.observation?.outcome !== 'model-tool' || last.observation.workerId !== WORKER) fail('previous_event_not_verified');
    // The operator records turn end. These are conservative server-monotonic
    // waits after that report and arm, never inferred from a bridge Promise.
    const quietMs = s.remoteCount === 0 ? 30_000 : 120_000;
    if (this.clock.mono() - s.lastActivity < quietMs) fail(`wait_${quietMs / 1000}_seconds_after_observation_and_arm`);
    const event = this.newEvent(s, 'remote'); s.remoteCount++;
    if (!s.send(event)) { this.stop(id, 'delivery_ambiguous'); fail('delivery_ambiguous'); }
    return event;
  }
  private newEvent(s: Session, mode: EventRecord['mode']): ProbeEvent {
    const now = this.clock.wall();
    const event: ProbeEvent = { eventId: 'probe_' + randomBytes(12).toString('hex'), kind: 'status-probe',
      emittedAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + EVENT_MS, s.expires)).toISOString() };
    s.events.set(event.eventId, { event, mode, emittedMono: this.clock.mono(), receipts: [] });
    return event;
  }
  check(id: string, eventId: string) {
    const s = this.session(id), r = s.events.get(eventId);
    if (!r) return fail('unknown_event');
    const remainingMs = Math.min(EVENT_MS - (this.clock.mono() - r.emittedMono), s.expiresMono - this.clock.mono());
    if (remainingMs <= 0) { this.stop(id, 'event_expired'); return fail('event_expired', 410); }
    if (r.receipts.length) return fail('event_already_received');
    return { remainingMs };
  }
  receipt(id: string, input: unknown) {
    const receipt = receiptSchema.parse(input), s = this.session(id), record = s.events.get(receipt.eventId);
    if (!record) fail('unknown_event');
    if (record!.receipts.some(r => r.stage === receipt.stage)) fail('duplicate_receipt');
    const expected = ['received', 'bridge_requested', 'bridge_resolved'];
    if (expected.includes(receipt.stage) && expected.indexOf(receipt.stage) !== record!.receipts.length) fail('receipt_out_of_order');
    if (record!.receipts.length >= 3) fail('event_already_terminal');
    record!.receipts.push({ ...receipt, serverAt: new Date(this.clock.wall()).toISOString(),
      emissionToReceiptMs: this.clock.mono() - record!.emittedMono });
    s.lastActivity = this.clock.mono();
    if (['bridge_rejected', 'bridge_ambiguous', 'discarded'].includes(receipt.stage) || receipt.result === 'isError') this.stop(id, 'bridge_failed');
  }
  observe(id: string, input: unknown) {
    const observation = observationSchema.parse(input), s = this.session(id), record = s.events.get(observation.eventId);
    if (!record || record.observation) fail('unknown_or_observed_event');
    if (!record!.receipts.some(r => r.stage === 'bridge_requested')) fail('bridge_request_not_observed');
    record!.observation = { ...observation, source: 'operator_reported', recordedAt: new Date(this.clock.wall()).toISOString() };
    s.lastActivity = this.clock.mono();
    if (observation.outcome !== 'model-tool' || observation.workerId !== WORKER) this.stop(id, 'negative_observation');
  }
  stop(id: string, reason: StopReason = 'operator_stop') {
    const s = this.sessions.get(id);
    if (!s || s.state === 'stopped') return;
    // Keep the first terminal cause: SSE close callbacks, sweep or a later
    // operator observation must not rewrite an earlier disconnection as expiry.
    s.stopReason = reason; s.stoppedAt = new Date(this.clock.wall()).toISOString(); s.stoppedMono = this.clock.mono();
    s.state = 'stopped'; s.send = undefined;
    const close = s.close; s.close = undefined; close?.();
  }
  report(id?: string) {
    return [...this.sessions.values()].filter(s => !id || s.id === id).map(s => ({ sessionId: s.id,
      state: s.state, expiresAt: new Date(s.expires).toISOString(), connected: Boolean(s.send),
      remoteCount: s.remoteCount, events: [...s.events.values()].map(({ emittedMono, ...r }) => r),
      stopReason: s.stopReason ?? null, stoppedAt: s.stoppedAt ?? null,
      modelInvocationVerifiedByServer: false, timing: 'server emission→receipt includes round trip; not precise widget ingress or MCP latency',
    }));
  }
  sweep() {
    for (const s of this.sessions.values()) {
      if (this.clock.mono() >= s.expiresMono) this.stop(s.id, 'session_expired');
      const pending = [...s.events.values()].at(-1);
      if (pending && !pending.observation && !pending.receipts.some(r => r.stage === 'bridge_resolved')
        && this.clock.mono() - pending.emittedMono >= EVENT_MS) this.stop(s.id, 'event_expired');
      // Bounded retention: this standalone process is not an audit database.
      if (s.stoppedMono !== undefined && this.clock.mono() - s.stoppedMono >= STOPPED_RETENTION_MS) this.sessions.delete(s.id);
    }
  }
  close() { for (const s of this.sessions.values()) this.stop(s.id, 'server_shutdown'); this.sessions.clear(); }
}
