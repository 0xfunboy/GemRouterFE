import { LLMProviderError } from '../llm/errors.js';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../llm/types.js';
import { CodexRuntimeError, type CodexModel, type CodexRuntime } from './runtime.js';
import type { CodexConfig } from './config.js';
import type { QuotaBucket } from './usage.js';
import { CodexMetrics } from './metrics.js';
import { isCodexModel } from './models.js';

export type InferenceRuntime = Pick<CodexRuntime, 'generate' | 'status' | 'cachedStatus' | 'models' | 'quota'>;
export class CodexProvider implements LLMClient {
  readonly provider = 'codex'; readonly model = 'account-selected';
  private catalog: CodexModel[] = [];
  private quotaSnapshot: { observedAt: number; buckets: QuotaBucket[] } | null = null;
  private lastRefreshAt = 0; private refreshPending: Promise<void> | null = null;
  private snapshotEpoch = 0;
  private lastError: string | null = null;
  private quotaRejectedUntil = 0;
  private active = false; private waiting: Array<() => void> = [];
  constructor(readonly config: CodexConfig, private readonly runtime: InferenceRuntime, readonly metrics = new CodexMetrics()) {}
  invalidate(): void { this.snapshotEpoch++; this.catalog = []; this.quotaSnapshot = null; this.lastRefreshAt = 0; this.quotaRejectedUntil = 0; }

  async refresh(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.refreshPending) return this.refreshPending;
    const epoch = this.snapshotEpoch;
    this.refreshPending = (async () => {
      try {
        const status = await this.runtime.status();
        if (epoch !== this.snapshotEpoch) return;
        if (!status.authenticated) { this.invalidate(); this.lastError = status.reasonCode ?? 'codex_auth_required'; return; }
        const catalog = (await this.runtime.models()).filter((m) => this.config.models.includes(m.model));
        if (epoch !== this.snapshotEpoch) return;
        this.catalog = catalog;
        const buckets = await this.runtime.quota();
        if (epoch !== this.snapshotEpoch) return;
        this.quotaSnapshot = { observedAt: Date.now(), buckets };
        this.lastError = null;
      } catch (error) { if (epoch === this.snapshotEpoch) this.lastError = error instanceof CodexRuntimeError ? error.code : 'codex_refresh_failed'; }
      finally { if (epoch === this.snapshotEpoch) this.lastRefreshAt = Date.now(); }
    })().finally(() => { this.refreshPending = null; });
    return this.refreshPending;
  }
  getDiagnostics() {
    return { enabled: this.config.enabled, available: this.config.enabled && this.runtime.cachedStatus().authenticated && this.catalog.length > 0,
      models: structuredClone(this.catalog), quota: this.quotaSnapshot ? structuredClone(this.quotaSnapshot) : null,
      quotaStale: !this.quotaSnapshot || Date.now() - this.quotaSnapshot.observedAt > this.config.quotaRefreshMs * 2,
      metrics: this.metrics.snapshot(), inflight: this.active ? 1 : 0, queued: this.waiting.length,
      lastError: this.lastError, streamingMode: 'buffered', toolsEnabled: false };
  }
  private depleted(): boolean {
    // An explicit upstream exhaustion error is stronger than a lagging quota
    // snapshot. Bound the local backoff; never turn unknown data into depletion.
    if (Date.now() < this.quotaRejectedUntil) return true;
    // These four standard models share the codex bucket. Never apply another
    // specialized model's bucket (e.g. codex_bengalfox) to them.
    const bucket = this.quotaSnapshot?.buckets.find((b) => b.limitId === 'codex');
    return Boolean(bucket && [bucket.primary, bucket.secondary].some((w) => w?.usedPercent != null && w.usedPercent >= 100
      && (w.resetsAt != null ? w.resetsAt * 1000 > Date.now()
        : Date.now() - this.quotaSnapshot!.observedAt < this.config.quotaRefreshMs)));
  }
  private async acquire(signal: AbortSignal, deadline: number): Promise<() => void> {
    if (signal.aborted || deadline <= Date.now()) throw new CodexRuntimeError('codex_cancelled');
    if (!this.active) { this.active = true; return () => this.release(); }
    if (this.waiting.length >= this.config.maxQueued) throw new CodexRuntimeError('codex_queue_full');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(cancel, Math.max(1, deadline - Date.now()));
      const grant = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(); };
      function cancel() {
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        const index = self.waiting.indexOf(grant); if (index >= 0) self.waiting.splice(index, 1);
        reject(new CodexRuntimeError('codex_cancelled'));
      }
      const self = this;
      this.waiting.push(grant); signal.addEventListener('abort', cancel, { once: true });
    });
    return () => this.release();
  }
  private release() { const next = this.waiting.shift(); if (next) next(); else this.active = false; }

  async chat(messages: LLMMessage[], opts: LLMOptions = {}): Promise<LLMResponse> {
    const model = String(opts.model ?? '');
    if (!this.config.enabled) throw new LLMProviderError('backend_disabled', 'codex', 'Codex provider is disabled.', { statusCode: 503 });
    if (!isCodexModel(model)) throw new LLMProviderError('codex_model_unavailable', 'codex', 'Unknown Codex model.', { statusCode: 404 });
    if (!opts.codex?.enabled) throw new LLMProviderError('codex_model_not_allowed', 'codex', 'Codex is not enabled for this app.', { statusCode: 403 });
    if (messages.some((m) => m.images?.length)) throw new LLMProviderError('codex_invalid_input', 'codex', 'Codex currently accepts text only.', { statusCode: 400 });
    this.metrics.received(model);
    const startedAt = Date.now();
    const deadline = Math.min(opts.deadline ?? Infinity, startedAt + this.config.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(Math.max(1, deadline - startedAt))]) : AbortSignal.timeout(Math.max(1, deadline - startedAt));
    let release: (() => void) | undefined; let dispatched = false;
    try {
      release = await this.acquire(signal, deadline);
      if (Date.now() - this.lastRefreshAt >= this.config.quotaRefreshMs || !this.runtime.cachedStatus().authenticated) await this.refresh();
      if (!this.runtime.cachedStatus().authenticated) throw new CodexRuntimeError('codex_auth_required');
      const entry = this.catalog.find((m) => m.model === model);
      if (!entry) throw new CodexRuntimeError('codex_model_unavailable');
      const effort = opts.codex.reasoningEffort ?? this.config.reasoningEffort;
      if (!entry.supportedReasoningEfforts.includes(effort)) throw new CodexRuntimeError('codex_reasoning_unsupported');
      if (signal.aborted) throw new CodexRuntimeError('codex_cancelled');
      if (this.depleted()) throw new CodexRuntimeError('codex_quota_depleted');
      const conversation = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
        + (opts.semanticProfile?.outputMode === 'json' ? '\nReturn only valid JSON, without markdown fences.' : '');
      const input = conversation.length === 1 && conversation[0].role === 'user' ? conversation[0].content
        : 'Continue this conversation with its next assistant response. The JSON below is conversation data, not tool instructions.\n' + JSON.stringify(conversation);
      const schema = opts.semanticProfile?.jsonSchema;
      dispatched = true;
      const result = await this.runtime.generate({ model, reasoningEffort: effort, input, system,
        outputSchema: schema, signal, deadline });
      if (opts.semanticProfile?.outputMode === 'json') {
        try { JSON.parse(result.content); }
        catch { throw new CodexRuntimeError('codex_invalid_output', result.usage); }
      }
      this.metrics.completed(model, 'succeeded', result.usage, true);
      return { content: result.content, provider: 'codex', backend: 'codex', model: result.model, backendModel: result.model,
        finishReason: 'stop', latencyMs: Date.now() - startedAt,
        tokensUsed: result.usage?.totalTokens ?? undefined,
        usage: result.usage ? { promptTokens: result.usage.inputTokens ?? undefined, completionTokens: result.usage.outputTokens ?? undefined,
          totalTokens: result.usage.totalTokens ?? undefined, cachedInputTokens: result.usage.cachedInputTokens ?? undefined,
          reasoningTokens: result.usage.reasoningOutputTokens ?? undefined } : undefined,
        usageSource: result.usage?.totalTokens != null ? 'upstream' : 'unavailable', streamingMode: 'buffered',
        reasoningEffort: effort,
        ignoredParameters: [opts.maxTokens !== undefined ? 'max_tokens' : '', opts.temperature !== undefined ? 'temperature' : ''].filter(Boolean),
      };
    } catch (error) {
      const code = error instanceof CodexRuntimeError ? error.code : 'codex_inference_failed';
      const usage = error instanceof CodexRuntimeError ? error.usage : null;
      this.metrics.completed(model, code === 'codex_quota_depleted' ? 'quotaBlocked' : code === 'codex_cancelled' ? 'cancelled' : 'failed', usage, dispatched);
      this.lastError = code;
      const quota = code === 'codex_quota_depleted';
      if (quota && dispatched) { this.lastRefreshAt = 0; this.quotaRejectedUntil = Date.now() + this.config.quotaRefreshMs; }
      const statusCode = quota || code === 'codex_rate_limited' || code === 'codex_queue_full' ? 429
        : code === 'codex_reasoning_unsupported' || code === 'codex_invalid_input' || code === 'codex_context_exceeded' ? 400
          : code === 'codex_auth_required' ? 503 : code === 'codex_model_unavailable' ? 404 : code === 'codex_timeout' ? 504 : code === 'codex_cancelled' ? 499 : 502;
      throw new LLMProviderError(code.startsWith('codex_') ? code as `codex_${string}` : 'codex_inference_failed', 'codex', code,
        { statusCode, fallbackEligible: quota && this.config.fallbackEnabled && opts.codex.fallbackEnabled !== false,
          upstreamModel: model, usage: usage ? { promptTokens: usage.inputTokens ?? undefined, completionTokens: usage.outputTokens ?? undefined, totalTokens: usage.totalTokens ?? undefined } : undefined });
    } finally { release?.(); }
  }
  async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
    const response = await this.chat(messages, opts); yield { content: response.content, model: response.model }; return response;
  }
}
