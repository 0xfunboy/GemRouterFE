import { chatGptError, type ChatGptGatewayErrorCode } from './errors.js';
import { digestCanonical } from './protocol.js';
import { ChatGptWorkerRegistry } from './registry.js';
import { ChatGptGatewayStore } from './store.js';
import type {
  AuthenticatedMcpGrant,
  ChatGptJobResult,
  ChatGptSubmitInput,
  GatewayExchangeInput,
  GatewayExchangeResult,
  GatewayOpenInput,
  GatewayOpenResult,
} from './types.js';

interface InflightExchange {
  digest: string;
  promise: Promise<GatewayExchangeResult>;
  controller: AbortController;
  consumers: number;
}

export class ChatGptGateway {
  readonly registry: ChatGptWorkerRegistry;
  private readonly inflightExchanges = new Map<string, InflightExchange>();
  private readonly jobConsumers = new Map<string, number>();

  constructor(
    readonly store: ChatGptGatewayStore,
    registry: ChatGptWorkerRegistry,
  ) {
    this.registry = registry;
  }

  async submit(input: ChatGptSubmitInput): Promise<ChatGptJobResult> {
    if (input.signal?.aborted) throw chatGptError('chatgpt_request_cancelled');
    const { job } = await this.store.enqueue(input);
    this.jobConsumers.set(job.requestId, (this.jobConsumers.get(job.requestId) ?? 0) + 1);
    try {
      const terminal = await this.store.waitForJob(job.requestId, input.signal);
      if (terminal.status !== 'completed' || terminal.result === null || terminal.completedAtMs === null) {
        throw terminalError(terminal.errorCode, terminal.errorMessage);
      }
      const worker = terminal.workerSnapshot ?? this.store.getWorker(terminal.workerId);
      if (!worker) throw chatGptError('chatgpt_worker_unavailable');
      const claimedAt = terminal.claimedAtMs ?? terminal.createdAtMs;
      return {
        requestId: terminal.requestId,
        alias: terminal.alias,
        content: terminal.result,
        createdAt: new Date(terminal.createdAtMs).toISOString(),
        completedAt: new Date(terminal.completedAtMs).toISOString(),
        queueWaitMs: Math.max(0, claimedAt - terminal.createdAtMs),
        processingWaitMs: Math.max(0, terminal.completedAtMs - claimedAt),
        totalLatencyMs: Math.max(0, terminal.completedAtMs - terminal.createdAtMs),
        worker,
        warnings: terminal.controls.warnings,
      };
    } finally {
      const remaining = Math.max(0, (this.jobConsumers.get(job.requestId) ?? 1) - 1);
      if (remaining === 0) this.jobConsumers.delete(job.requestId);
      else this.jobConsumers.set(job.requestId, remaining);
      // One disconnected retry must not cancel a shared idempotent job. The final
      // disconnected synchronous consumer does cancel it, including an active claim.
      if (input.signal?.aborted && remaining === 0) {
        this.store.cancelJob(job.requestId, 'chatgpt_request_cancelled', 'The last inference client disconnected.');
      }
    }
  }

  open(grant: AuthenticatedMcpGrant, input: GatewayOpenInput): GatewayOpenResult {
    return this.store.openRun(grant, input.open_id);
  }

  async exchange(grant: AuthenticatedMcpGrant, input: GatewayExchangeInput, signal?: AbortSignal): Promise<GatewayExchangeResult> {
    if (signal?.aborted) throw new Error('exchange_aborted');
    // Validate every caller before consulting a shared operation. A transport
    // session/run handle is not authorization to join another principal's poll.
    this.store.validateGrant(grant);
    const key = `${grant.id}\0${input.run_id}\0${input.exchange_id}`;
    const digest = digestCanonical(input);
    const existing = this.inflightExchanges.get(key);
    if (existing) {
      if (existing.digest !== digest) return Promise.reject(new Error('exchange_conflict'));
      return this.consumeExchange(existing, grant, input, signal);
    }
    const defaultWaitSeconds = Math.max(1, Math.round(this.store.config.longPollMs / 1_000));
    const maximumWaitSeconds = Math.max(1, Math.min(55, Math.round(this.store.config.longPollMs * 2 / 1_000)));
    const controller = new AbortController();
    const promise = this.store.exchange({ grant, input, argsDigest: digest, defaultWaitSeconds, maximumWaitSeconds }, controller.signal);
    const inflight = { digest, promise, controller, consumers: 0 };
    this.inflightExchanges.set(key, inflight);
    void promise.finally(() => {
      if (this.inflightExchanges.get(key)?.promise === promise) this.inflightExchanges.delete(key);
    }).catch(() => undefined);
    return this.consumeExchange(inflight, grant, input, signal);
  }

  close(): void {
    for (const inflight of this.inflightExchanges.values()) inflight.controller.abort();
    this.inflightExchanges.clear();
    this.store.close();
  }

  private consumeExchange(inflight: InflightExchange, grant: AuthenticatedMcpGrant, input: GatewayExchangeInput, signal?: AbortSignal): Promise<GatewayExchangeResult> {
    if (signal?.aborted) return Promise.reject(new Error('exchange_aborted'));
    inflight.consumers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (aborted: boolean, operation: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        inflight.consumers = Math.max(0, inflight.consumers - 1);
        if (aborted && inflight.consumers === 0) inflight.controller.abort();
        operation();
      };
      const onAbort = (): void => finish(true, () => reject(new Error('exchange_aborted')));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      void inflight.promise.then(
        (result) => finish(false, () => {
          try {
            // A grant can expire/revoke, or an administrator can release a run,
            // between committing the shared result and delivering this consumer.
            resolve(this.store.validateExchangeResult(grant, input, result));
          } catch (error) {
            reject(error);
          }
        }),
        (error: unknown) => finish(false, () => reject(error)),
      );
    });
  }
}

function terminalError(code: string | null, message: string | null): Error {
  const known = new Set<ChatGptGatewayErrorCode>([
    'chatgpt_feature_disabled', 'chatgpt_model_not_found', 'chatgpt_model_not_allowed', 'chatgpt_backend_mismatch',
    'chatgpt_unsupported_surface', 'chatgpt_unsupported_parameter', 'chatgpt_context_reset_unsupported',
    'chatgpt_payload_too_large', 'chatgpt_idempotency_conflict', 'chatgpt_queue_full', 'chatgpt_worker_unavailable',
    'chatgpt_queue_timeout', 'chatgpt_request_timeout', 'chatgpt_completion_failed', 'chatgpt_invalid_json',
    'chatgpt_empty_response', 'chatgpt_gateway_restarted', 'chatgpt_request_cancelled', 'chatgpt_store_unavailable',
    'chatgpt_protocol_error',
    'chatgpt_control_unavailable', 'chatgpt_control_binding_changed', 'chatgpt_control_stopped', 'chatgpt_wake_failed', 'chatgpt_wake_timeout',
  ]);
  const selected = known.has(code as ChatGptGatewayErrorCode) ? code as ChatGptGatewayErrorCode : 'chatgpt_completion_failed';
  // Also protect idempotent outcomes created by older versions that retained
  // worker-controlled error text before the privacy boundary was tightened.
  return chatGptError(selected, selected === 'chatgpt_completion_failed' ? undefined : message ?? undefined);
}
