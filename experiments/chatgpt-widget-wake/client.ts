import { eventSchema, type ProbeEvent, type Receipt } from './protocol.js';

export type Method = Receipt['method'];
type Dependencies = {
  now(): number; visibility(): 'visible' | 'hidden';
  bridge(prompt: string): Promise<unknown>;
  receipt(receipt: Receipt): Promise<void>;
  stop(): void; show(message: string): void;
};

// This class never calls MCP tools, samples a model or touches the parent DOM.
// Resolving the bridge promise only records a transport outcome, never a wake.
export class ProbeClient {
  private seen = new Set<string>();
  private busy = false;
  private stopped = false;
  private manualUsed = false;
  private armed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private receiptQueue = Promise.resolve();
  constructor(private deps: Dependencies, private template: string, readonly method: Method) {}
  arm() { if (this.stopped || !this.manualUsed || this.busy || this.armed) return false; this.armed = true; return true; }
  disarm() {
    if (this.stopped) return;
    this.stopped = true; this.armed = false; clearTimeout(this.timer); this.deps.stop();
  }
  invoke(input: unknown, mode: 'manual' | 'remote', deadline: number, ingress = this.deps.now()) {
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) { this.deps.show('Evento non valido: ascolto fermato.'); this.disarm(); return false; }
    const event = parsed.data;
    if (this.stopped) return false;
    if (this.seen.has(event.eventId)) { this.deps.show('Duplicato scartato: nessun nuovo messaggio.'); this.disarm(); return false; }
    if (this.busy || (mode === 'remote' && !this.armed) || (mode === 'manual' && this.manualUsed)) {
      this.deps.show('Invio concorrente o fase non valida: fermato.'); this.disarm(); return false;
    }
    if (this.deps.now() >= deadline) { this.deps.show('Evento scaduto: nessun messaggio.'); this.disarm(); return false; }
    this.seen.add(event.eventId); this.busy = true;
    if (mode === 'manual') this.manualUsed = true;
    const record = (stage: Receipt['stage'], result: Receipt['result'], rpcCode?: number) => {
      const receipt: Receipt = { eventId: event.eventId, stage, method: this.method, result,
        elapsedMs: Math.max(0, Math.min(120_000, this.deps.now() - ingress)), visibility: this.deps.visibility(),
        ...(rpcCode === undefined ? {} : { rpcCode }) };
      this.receiptQueue = this.receiptQueue.then(() => this.deps.receipt(receipt)).catch(() => {
        this.deps.show('Ricevuta non consegnata: esito ambiguo, nessun retry.'); this.disarm();
      });
    };
    record('received', 'none'); record('bridge_requested', 'none');
    this.deps.show(`${event.eventId}: richiesta ${this.method}. Attendere e osservare la chat.`);
    let settled = false;
    const finish = (stage: Receipt['stage'], result: Receipt['result'], rpcCode?: number) => {
      if (settled || this.stopped) return;
      settled = true; this.busy = false; clearTimeout(this.timer);
      record(stage, result, rpcCode);
      this.deps.show(`${event.eventId}: bridge ${result}. Turno e gateway_status NON verificati dal widget.`);
      if (stage !== 'bridge_resolved' || result === 'isError') {
        // Flush terminal evidence before closing the capability. Never retry the message.
        this.stopped = true; this.armed = false;
        void this.receiptQueue.finally(() => this.deps.stop());
      }
    };
    this.timer = setTimeout(() => finish('bridge_ambiguous', 'timeout'), 15_000);
    try {
      // Deliberately synchronous invocation on the manual click's call stack:
      // no network/receipt await that could destroy a genuine user gesture.
      const result = this.deps.bridge(this.template.replaceAll('EVENT_ID', event.eventId));
      void Promise.resolve(result).then(value => {
        finish('bridge_resolved', (value as { isError?: boolean } | null)?.isError ? 'isError' : 'accepted');
      }, error => finish('bridge_rejected', 'exception', typeof error?.code === 'number' && Number.isInteger(error.code) ? error.code : undefined));
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      finish('bridge_rejected', 'exception', typeof code === 'number' && Number.isInteger(code) ? code : undefined);
    }
    return true;
  }
  async flush() { await this.receiptQueue; }
}
