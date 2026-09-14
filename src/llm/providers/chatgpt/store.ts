/*
 * Reverse-RPC state-machine concepts adapted from PiLink's MIT-licensed
 * llm-gateway-store.ts at aa83d14e826cc7c38c6ac9bcc08da3ad30856f0b.
 * GemRouter uses a new multi-worker SQLite schema, grant/run fencing and does
 * not redeliver an ambiguously expired stateful claim.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { chatGptError } from './errors.js';
import { digestCanonical, safeJsonObjectResponse } from './protocol.js';
import {
  CHATGPT_GATEWAY_PROTOCOL_VERSION,
  type AuthenticatedMcpGrant,
  type ChatGptGatewayConfig,
  type ChatGptSubmitInput,
  type ChatGptWorkerConfig,
  type ChatGptWorkerStatus,
  type GatewayExchangeInput,
  type GatewayExchangeResult,
  type GatewayOpenResult,
} from './types.js';

type SqlRow = Record<string, unknown>;

// Durable caps complement HTTP rate limits and do not evict valid idempotency
// records early. An operator can wait for retention/pruning before retrying.
const MAX_RETAINED_JOBS = 10_000;
const MAX_REPLAY_RECORDS = 16_384;
const MAX_REPLAYS_PER_RUN = 1_024;
const MAX_OAUTH_CLIENTS = 1_024;
const MAX_OAUTH_CLIENTS_PER_WORKER = 16;
const MAX_AUTHORIZATION_REQUESTS = 128;
const MAX_AUTHORIZATION_REQUESTS_PER_CLIENT = 8;
const MAX_WORKERS = 128;
const MAX_RETAINED_RUNS = 16_384;
const MAX_RUNS_PER_WORKER = 1_024;
const MAX_RETAINED_GRANTS = 8_192;
const MAX_GRANTS_PER_WORKER = 128;
const MAX_RETAINED_TOKENS = 32_768;
const MAX_ACCESS_TOKENS_PER_GRANT = 128;

interface StoredJob {
  requestId: string;
  appId: string;
  workerId: string;
  alias: string;
  status: 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled';
  messages: ChatGptSubmitInput['messages'];
  controls: ChatGptSubmitInput['controls'];
  fingerprint: string;
  createdAtMs: number;
  queueDeadlineAtMs: number;
  requestDeadlineAtMs: number;
  claimedAtMs: number | null;
  leaseExpiresAtMs: number | null;
  runGeneration: number | null;
  claimToken: string | null;
  result: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  completedAtMs: number | null;
  completionDigest: string | null;
  configVersion: number;
  contextEpoch: number;
  instructionVersion: number;
  workerSnapshot: ChatGptWorkerConfig | null;
}

interface ExchangeContext {
  grant: AuthenticatedMcpGrant;
  input: GatewayExchangeInput;
  argsDigest: string;
  defaultWaitSeconds: number;
  maximumWaitSeconds: number;
}

export interface WorkerMutationInput {
  id: string;
  label: string;
  enabled?: boolean;
  publicModelIds: string[];
  allowedAppIds?: string[];
  domainLabel?: string | null;
  declaredModel: string;
  declaredReasoning?: string | null;
  contextEpoch?: number;
  instructionVersion?: number;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  maxQueuedRequests?: number;
}

export interface OAuthClientRecord {
  clientId: string;
  workerId: string;
  clientName: string;
  redirectUri: string;
  createdAtMs: number;
  revokedAtMs: number | null;
}

export interface ChatGptStoreAuditEvent {
  type: string;
  workerId?: string;
  appId?: string;
  requestId?: string;
  reasonCode?: string;
}

export interface OAuthAuthorizationRequestRecord {
  id: string;
  clientId: string;
  workerId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  state: string;
  codeChallenge: string;
  csrfHash: string;
  expiresAtMs: number;
}

export class ChatGptGatewayStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly ownerId = randomUUID();
  private readonly changes = new EventEmitter();
  private readonly pendingPolls = new Map<string, number>();
  private closed = false;
  private lastPruneAtMs = 0;
  private transactionAuditEvents: ChatGptStoreAuditEvent[] | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly config: ChatGptGatewayConfig,
    private readonly auditEvent?: (event: ChatGptStoreAuditEvent) => void,
  ) {
    validateStoreConfig(config);
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700);
    this.dbPath = path.join(config.dataDir, 'gateway.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    let ownsRuntime = false;
    try {
      chmodSync(this.dbPath, 0o600);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      // Claim ownership before migrations can change a live owner's schema.
      this.claimRuntimeOwnership();
      ownsRuntime = true;
      this.db.exec('PRAGMA journal_mode=WAL;');
      this.transaction(() => this.migrate());
      this.recoverAfterRestart();
      this.prune();
      this.changes.setMaxListeners(0);
      this.pruneTimer = setInterval(() => {
        if (this.closed) return;
        try { this.prune(); } catch {
          this.recordAudit({ type: 'chatgpt.gateway.prune_failed', reasonCode: 'chatgpt_store_unavailable' });
        }
      }, 60_000);
      this.pruneTimer.unref();
    } catch (error) {
      if (ownsRuntime) {
        try { this.releaseRuntimeOwnership(); } catch { /* Preserve the startup failure. */ }
      }
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    const workerIds = this.listWorkers().map((worker) => worker.id);
    this.closed = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    try {
      this.releaseRuntimeOwnership();
    } finally {
      this.db.close();
      for (const workerId of workerIds) this.emitChange(workerId);
    }
  }

  listWorkers(): ChatGptWorkerConfig[] {
    return (this.db.prepare(`
      SELECT w.*,COALESCE((SELECT json_group_array(alias) FROM worker_aliases a WHERE a.worker_id=w.id),'[]') AS public_model_ids
      FROM workers w ORDER BY created_at_ms,id
    `).all() as SqlRow[]).map(workerFromRow);
  }

  getWorker(id: string): ChatGptWorkerConfig | null {
    const row = this.db.prepare(`
      SELECT w.*,COALESCE((SELECT json_group_array(alias) FROM worker_aliases a WHERE a.worker_id=w.id),'[]') AS public_model_ids
      FROM workers w WHERE w.id=?
    `).get(id) as SqlRow | undefined;
    return row ? workerFromRow(row) : null;
  }

  findWorkerByAlias(alias: string): ChatGptWorkerConfig | null {
    const row = this.db.prepare(`
      SELECT w.*,COALESCE((SELECT json_group_array(alias) FROM worker_aliases x WHERE x.worker_id=w.id),'[]') AS public_model_ids
      FROM worker_aliases a JOIN workers w ON w.id=a.worker_id WHERE a.alias=?
    `).get(alias) as SqlRow | undefined;
    return row ? workerFromRow(row) : null;
  }

  createWorker(input: WorkerMutationInput): ChatGptWorkerConfig {
    const now = Date.now();
    this.transaction(() => {
      if (Number((this.db.prepare('SELECT COUNT(*) AS count FROM workers').get() as SqlRow).count) >= MAX_WORKERS) throw new Error('Worker registry capacity reached.');
      this.db.prepare(`
        INSERT INTO workers (
          id,label,enabled,allowed_app_ids,domain_label,declared_model,declared_reasoning,
          context_epoch,instruction_version,timeout_ms,queue_timeout_ms,max_queued_requests,
          draining,config_version,run_generation,created_at_ms,updated_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,1,0,?,?)
      `).run(
        input.id,
        input.label,
        input.enabled === true ? 1 : 0,
        JSON.stringify(input.allowedAppIds ?? []),
        input.domainLabel ?? null,
        input.declaredModel,
        input.declaredReasoning ?? null,
        input.contextEpoch ?? 1,
        input.instructionVersion ?? 1,
        input.timeoutMs ?? this.config.timeoutMs,
        input.queueTimeoutMs ?? this.config.queueTimeoutMs,
        input.maxQueuedRequests ?? this.config.maxQueuePerWorker,
        now,
        now,
      );
      const insertAlias = this.db.prepare('INSERT INTO worker_aliases(alias,worker_id) VALUES (?,?)');
      for (const alias of input.publicModelIds) insertAlias.run(alias, input.id);
    });
    this.emitChange(input.id);
    return this.requireWorker(input.id);
  }

  updateWorker(id: string, input: Partial<WorkerMutationInput>): ChatGptWorkerConfig {
    const current = this.requireWorker(id);
    const definedInput = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<WorkerMutationInput>;
    const next = {
      ...current,
      ...definedInput,
      id,
      publicModelIds: input.publicModelIds ?? current.publicModelIds,
      allowedAppIds: input.allowedAppIds ?? current.allowedAppIds,
    };
    const removedApps = current.allowedAppIds.filter((appId) => !next.allowedAppIds.includes(appId));
    const disabling = current.enabled && input.enabled === false;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE workers SET label=?,enabled=?,allowed_app_ids=?,domain_label=?,declared_model=?,declared_reasoning=?,
          context_epoch=?,instruction_version=?,timeout_ms=?,queue_timeout_ms=?,max_queued_requests=?,
          config_version=config_version+1,updated_at_ms=? WHERE id=?
      `).run(
        next.label,
        next.enabled ? 1 : 0,
        JSON.stringify(next.allowedAppIds),
        next.domainLabel ?? null,
        next.declaredModel,
        next.declaredReasoning ?? null,
        next.contextEpoch,
        next.instructionVersion,
        next.timeoutMs,
        next.queueTimeoutMs,
        next.maxQueuedRequests,
        Date.now(),
        id,
      );
      if (input.publicModelIds) {
        this.db.prepare('DELETE FROM worker_aliases WHERE worker_id=?').run(id);
        const insert = this.db.prepare('INSERT INTO worker_aliases(alias,worker_id) VALUES (?,?)');
        for (const alias of input.publicModelIds) insert.run(alias, id);
      }
      if (removedApps.length > 0) {
        const placeholders = removedApps.map(() => '?').join(',');
        this.failJobsWhere(
          `worker_id=? AND app_id IN (${placeholders}) AND status IN ('queued','claimed')`,
          [id, ...removedApps],
          'chatgpt_model_not_allowed',
          'Worker access was revoked for the submitting app.',
        );
      }
      if (disabling) this.releaseWorkerInTransaction(id, 'Worker disabled by administrator', 'chatgpt_worker_unavailable');
    });
    this.emitChange(id);
    const updated = this.requireWorker(id);
    if (current.enabled !== updated.enabled) {
      this.recordAudit({ type: updated.enabled ? 'chatgpt.worker.enabled' : 'chatgpt.worker.disabled', workerId: id });
    }
    return updated;
  }

  deleteWorker(id: string): void {
    this.requireWorker(id);
    const active = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs WHERE worker_id=? AND status IN ('queued','claimed')
    `).get(id) as SqlRow).count);
    if (active > 0) throw new Error('worker has active jobs; release it before deletion');
    this.transaction(() => {
      this.releaseWorkerInTransaction(id, 'Worker removed by administrator', 'chatgpt_worker_unavailable');
      this.db.prepare('DELETE FROM workers WHERE id=?').run(id);
    });
    this.emitChange(id);
  }

  async enqueue(input: ChatGptSubmitInput): Promise<{ job: StoredJob; reused: boolean }> {
    this.assertOpen();
    if (input.signal?.aborted) throw chatGptError('chatgpt_request_cancelled');
    this.maybePrune();
    const worker = this.findWorkerByAlias(input.alias);
    if (!worker) throw chatGptError('chatgpt_model_not_found');
    if (!worker.allowedAppIds.includes(input.appId)) throw chatGptError('chatgpt_model_not_allowed');
    const now = Date.now();
    this.expireJobs(worker.id, now);
    const keyDigest = input.idempotencyKey
      ? createHash('sha256').update(`${input.appId}\0${input.surface}\0${input.idempotencyKey}`, 'utf8').digest('hex')
      : null;
    if (keyDigest) {
      const idempotencyCutoff = now - this.config.idempotencyTtlSeconds * 1_000;
      this.db.prepare(`UPDATE jobs SET idempotency_digest=NULL
        WHERE app_id=? AND surface=? AND idempotency_digest=? AND status IN ('completed','failed','cancelled')
        AND COALESCE(completed_at_ms,created_at_ms)<?`).run(input.appId, input.surface, keyDigest, idempotencyCutoff);
      const existing = this.db.prepare(`SELECT * FROM jobs WHERE app_id=? AND surface=? AND idempotency_digest=?
        AND (status IN ('queued','claimed') OR COALESCE(completed_at_ms,created_at_ms)>=?)`).get(
        input.appId,
        input.surface,
        keyDigest,
        idempotencyCutoff,
      ) as SqlRow | undefined;
      if (existing) {
        const job = jobFromRow(existing);
        if (job.fingerprint !== input.fingerprint || job.alias !== input.alias) throw chatGptError('chatgpt_idempotency_conflict');
        return { job, reused: true };
      }
    }
    if (!this.isWorkerAdmitting(worker, now)) throw chatGptError('chatgpt_worker_unavailable');
    let result!: { job: StoredJob; reused: boolean };
    this.transaction(() => {
      const globalActive = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','claimed')`).get() as SqlRow).count);
      const queued = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE worker_id=? AND status='queued'`).get(worker.id) as SqlRow).count);
      const retained = Number((this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as SqlRow).count);
      if (globalActive >= this.config.maxActiveJobs || queued >= worker.maxQueuedRequests || retained >= MAX_RETAINED_JOBS) throw chatGptError('chatgpt_queue_full');
      const requestDeadlineAtMs = Math.min(input.deadline ?? Number.POSITIVE_INFINITY, now + worker.timeoutMs);
      const queueDeadlineAtMs = Math.min(requestDeadlineAtMs, now + worker.queueTimeoutMs);
      const requestId = `req_${randomBytes(24).toString('base64url')}`;
      this.db.prepare(`
        INSERT INTO jobs (
          request_id,app_id,worker_id,alias,surface,status,messages_json,controls_json,fingerprint,
          idempotency_digest,created_at_ms,queue_deadline_at_ms,request_deadline_at_ms,config_version,context_epoch,instruction_version,worker_snapshot_json
        ) VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        requestId,
        input.appId,
        worker.id,
        input.alias,
        input.surface,
        JSON.stringify(input.messages),
        JSON.stringify(input.controls),
        input.fingerprint,
        keyDigest,
        now,
        queueDeadlineAtMs,
        requestDeadlineAtMs,
        worker.configVersion,
        worker.contextEpoch,
        worker.instructionVersion,
        JSON.stringify(worker),
      );
      result = { job: this.requireJob(requestId), reused: false };
    });
    this.emitChange(worker.id);
    this.recordAudit({ type: 'chatgpt.request.enqueued', workerId: worker.id, appId: input.appId, requestId: result.job.requestId });
    return result;
  }

  async waitForJob(requestId: string, signal?: AbortSignal): Promise<StoredJob> {
    this.assertOpen();
    const initial = this.requireJob(requestId);
    const workerId = initial.workerId;
    while (true) {
      this.assertOpen();
      this.expireJobs(workerId, Date.now());
      const job = this.requireJob(requestId);
      if (isTerminal(job.status)) return job;
      if (signal?.aborted) {
        throw chatGptError('chatgpt_request_cancelled');
      }
      const deadline = job.status === 'queued' ? job.queueDeadlineAtMs : job.requestDeadlineAtMs;
      try {
        await this.waitForChange(workerId, Math.max(1, Math.min(1_000, deadline - Date.now())), signal);
      } catch {
        this.assertOpen();
        this.expireJobs(workerId, Date.now());
        const afterWait = this.requireJob(requestId);
        if (isTerminal(afterWait.status)) return afterWait;
        if (signal?.aborted) {
          throw chatGptError('chatgpt_request_cancelled');
        }
        throw chatGptError('chatgpt_store_unavailable', 'The gateway stopped while waiting for the worker.');
      }
    }
  }

  cancelJob(requestId: string, code = 'chatgpt_request_cancelled', message = 'The request was cancelled.'): void {
    // Shutdown has already abandoned synchronous work for restart recovery.
    if (this.closed) return;
    const job = this.requireJob(requestId);
    if (isTerminal(job.status)) return;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE jobs SET status='cancelled',error_code=?,error_message=?,completed_at_ms=?,messages_json=NULL,
          claim_token=NULL,claimed_at_ms=NULL,lease_expires_at_ms=NULL WHERE request_id=? AND status IN ('queued','claimed')
      `).run(code, message, Date.now(), requestId);
      this.redactInvalidRequestReplaysInTransaction();
    });
    this.emitChange(job.workerId);
    this.recordAudit({ type: 'chatgpt.request.cancelled', workerId: job.workerId, appId: job.appId, requestId, reasonCode: code });
  }

  openRun(grant: AuthenticatedMcpGrant, openId: string): GatewayOpenResult {
    this.validateGrant(grant);
    this.maybePrune();
    const worker = this.requireWorker(grant.workerId);
    if (!worker.enabled || worker.draining) throw new Error('worker_disabled');
    const openHash = digestCanonical({ grant: grant.id, openId });
    let output!: GatewayOpenResult;
    this.transaction(() => {
      this.assertGrantActive(grant, worker.id);
      const active = this.db.prepare(`SELECT * FROM runs WHERE worker_id=? AND status IN ('active','draining')`).get(worker.id) as SqlRow | undefined;
      if (active) {
        if (String(active.grant_id) === grant.id && String(active.open_id_hash) === openHash) {
          output = this.openResult(worker, active);
          return;
        }
        throw new Error('worker_busy');
      }
      const retainedRuns = this.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN worker_id=? THEN 1 ELSE 0 END) AS worker FROM runs`).get(worker.id) as SqlRow;
      if (Number(retainedRuns.total) >= MAX_RETAINED_RUNS || Number(retainedRuns.worker) >= MAX_RUNS_PER_WORKER) throw new Error('Worker run retention capacity reached.');
      const generation = worker.runGeneration + 1;
      const runId = `run_${randomBytes(32).toString('base64url')}`;
      const nextExchangeId = newExchangeId();
      const now = Date.now();
      this.db.prepare('UPDATE workers SET run_generation=?,draining=0,updated_at_ms=? WHERE id=?').run(generation, now, worker.id);
      this.db.prepare(`
        INSERT INTO runs(worker_id,run_id,grant_id,generation,open_id_hash,initial_exchange_id,next_exchange_id,opened_at_ms,status)
        VALUES (?,?,?,?,?,?,?,?,'active')
      `).run(worker.id, runId, grant.id, generation, openHash, nextExchangeId, nextExchangeId, now);
      output = {
        protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION,
        worker_id: worker.id,
        run_id: runId,
        run_generation: generation,
        next_exchange_id: nextExchangeId,
        limits: this.protocolLimits(),
      };
    });
    this.emitChange(worker.id);
    this.recordAudit({ type: 'chatgpt.run.opened', workerId: worker.id });
    return output;
  }

  async exchange(context: ExchangeContext, signal?: AbortSignal): Promise<GatewayExchangeResult> {
    this.validateGrant(context.grant);
    if (signal?.aborted) throw new Error('exchange_aborted');
    this.maybePrune();
    const started = Date.now();
    const workerId = context.grant.workerId;
    const waitSeconds = context.input.maximum_wait_seconds ?? context.defaultWaitSeconds;
    const deadline = started + Math.min(waitSeconds, context.maximumWaitSeconds) * 1_000;
    this.pendingPolls.set(workerId, (this.pendingPolls.get(workerId) ?? 0) + 1);
    this.emitChange(workerId);
    try {
      while (true) {
        this.assertOpen();
        if (signal?.aborted) throw new Error('exchange_aborted');
        const result = this.exchangeOnce(context);
        if (result) return result;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return this.finalizeIdleExchange(context, started);
        await this.waitForChange(workerId, Math.min(1_000, remaining), signal);
      }
    } finally {
      const count = Math.max(0, (this.pendingPolls.get(workerId) ?? 1) - 1);
      if (count === 0) this.pendingPolls.delete(workerId);
      else this.pendingPolls.set(workerId, count);
      this.emitChange(workerId);
    }
  }

  workerStatus(workerId: string): ChatGptWorkerStatus {
    const worker = this.requireWorker(workerId);
    this.expireJobs(workerId, Date.now());
    const run = this.db.prepare(`SELECT * FROM runs WHERE worker_id=? ORDER BY generation DESC LIMIT 1`).get(workerId) as SqlRow | undefined;
    const counts = this.db.prepare(`
      SELECT SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
             MIN(CASE WHEN status='queued' THEN created_at_ms END) AS oldest,
             MAX(CASE WHEN status='claimed' THEN claimed_at_ms END) AS claimed_at,
             MAX(CASE WHEN status='claimed' THEN lease_expires_at_ms END) AS lease_expires
      FROM jobs WHERE worker_id=?
    `).get(workerId) as SqlRow;
    const now = Date.now();
    const lastExchange = run?.last_exchange_at_ms == null ? null : Number(run.last_exchange_at_ms);
    const claimAt = counts.claimed_at == null ? null : Number(counts.claimed_at);
    const pending = this.pendingPolls.get(workerId) ?? 0;
    const processing = claimAt !== null;
    const lastError = workerErrorFromRow(this.db.prepare('SELECT last_error_code,last_error_message FROM workers WHERE id=?').get(workerId) as SqlRow);
    let state: ChatGptWorkerStatus['state'];
    if (!worker.enabled) state = 'disabled';
    else if (worker.draining) state = 'draining';
    else if (!run || run.status === 'released') state = run ? 'released' : 'unpaired';
    else if (processing) state = 'processing_claim';
    else if (pending > 0) state = 'polling';
    else if (lastExchange === null) state = 'waiting_for_wake';
    else if (now - lastExchange <= this.config.staleAfterMs) state = 'contact_recent';
    else state = 'stale';
    const queueLength = Number(counts.queued ?? 0);
    return {
      workerId,
      state,
      pendingWorkerPolls: pending,
      lastExchangeAt: lastExchange === null ? null : new Date(lastExchange).toISOString(),
      lastSuccessfulCompletionAt: workerLastCompletion(this.db, workerId),
      processingClaim: processing,
      claimAgeMs: claimAt === null ? null : Math.max(0, now - claimAt),
      leaseExpiresAt: counts.lease_expires == null ? null : new Date(Number(counts.lease_expires)).toISOString(),
      queueLength,
      oldestQueueAgeMs: counts.oldest == null ? 0 : Math.max(0, now - Number(counts.oldest)),
      nextAction: !worker.enabled || state === 'released' || state === 'unpaired'
        ? 'open_chat'
        : state === 'stale' || state === 'waiting_for_wake'
          ? 'wake_chat'
          : processing
            ? 'inspect_claim'
            : pending > 0
              ? 'wait'
              : 'none',
      lastError,
    };
  }

  workerStatusForGrant(grant: AuthenticatedMcpGrant): ChatGptWorkerStatus {
    this.assertGrantActive(grant, grant.workerId);
    return this.workerStatus(grant.workerId);
  }

  validateGrant(grant: AuthenticatedMcpGrant): void {
    this.assertOpen();
    this.assertGrantActive(grant, grant.workerId);
  }

  validateExchangeResult(grant: AuthenticatedMcpGrant, input: GatewayExchangeInput, result: GatewayExchangeResult): GatewayExchangeResult {
    this.validateGrant(grant);
    this.expireJobs(grant.workerId, Date.now());
    const run = this.db.prepare('SELECT * FROM runs WHERE run_id=? AND worker_id=?').get(input.run_id, grant.workerId) as SqlRow | undefined;
    if (!run || String(run.grant_id) !== grant.id || !this.runIsCurrent(run)) {
      return releasedResult('This run is no longer active.');
    }
    return this.fenceRequestResult(result, run);
  }

  drainWorker(workerId: string): void {
    this.requireWorker(workerId);
    this.transaction(() => {
      this.db.prepare('UPDATE workers SET draining=1,config_version=config_version+1,updated_at_ms=? WHERE id=?').run(Date.now(), workerId);
      this.db.prepare(`UPDATE runs SET status='draining' WHERE worker_id=? AND status='active'`).run(workerId);
      this.finishDrainIfEmpty(workerId);
    });
    this.emitChange(workerId);
  }

  releaseWorker(workerId: string, reason = 'Worker released by administrator'): void {
    this.requireWorker(workerId);
    this.transaction(() => this.releaseWorkerInTransaction(workerId, reason, 'chatgpt_request_cancelled'));
    this.emitChange(workerId);
  }

  openPairingWindow(workerId: string, ttlMs = 5 * 60_000): { expiresAt: string } {
    this.requireWorker(workerId);
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare('DELETE FROM pairing_windows WHERE expires_at_ms<=?').run(now);
      this.db.prepare(`INSERT INTO pairing_windows(worker_id,expires_at_ms) VALUES (?,?)
        ON CONFLICT(worker_id) DO UPDATE SET expires_at_ms=excluded.expires_at_ms`).run(workerId, now + ttlMs);
    });
    return { expiresAt: new Date(now + ttlMs).toISOString() };
  }

  activePairingWorker(): string | null {
    const rows = this.db.prepare('SELECT worker_id FROM pairing_windows WHERE expires_at_ms>? ORDER BY expires_at_ms DESC').all(Date.now()) as SqlRow[];
    return rows.length === 1 ? String(rows[0].worker_id) : null;
  }

  createOAuthClient(input: { workerId: string; clientName: string; redirectUri: string }): OAuthClientRecord {
    this.prune();
    const clientId = `grmcp_${randomBytes(16).toString('hex')}`;
    const now = Date.now();
    this.transaction(() => {
      const counts = this.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN worker_id=? THEN 1 ELSE 0 END) AS worker FROM oauth_clients`).get(input.workerId) as SqlRow;
      if (Number(counts.total) >= MAX_OAUTH_CLIENTS || Number(counts.worker) >= MAX_OAUTH_CLIENTS_PER_WORKER) throw new Error('OAuth client registration capacity reached.');
      this.db.prepare(`INSERT INTO oauth_clients(client_id,worker_id,client_name,redirect_uri,created_at_ms) VALUES (?,?,?,?,?)`).run(
        clientId,
        input.workerId,
        input.clientName,
        input.redirectUri,
        now,
      );
    });
    return { clientId, workerId: input.workerId, clientName: input.clientName, redirectUri: input.redirectUri, createdAtMs: now, revokedAtMs: null };
  }

  getOAuthClient(clientId: string): OAuthClientRecord | null {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id=?').get(clientId) as SqlRow | undefined;
    return row ? oauthClientFromRow(row) : null;
  }

  createAuthorizationRequest(input: Omit<OAuthAuthorizationRequestRecord, 'id'>): OAuthAuthorizationRequestRecord {
    const id = `authreq_${randomBytes(18).toString('base64url')}`;
    this.transaction(() => {
      this.db.prepare('DELETE FROM oauth_authorization_requests WHERE expires_at_ms<=?').run(Date.now());
      const counts = this.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN client_id=? THEN 1 ELSE 0 END) AS client FROM oauth_authorization_requests`).get(input.clientId) as SqlRow;
      if (Number(counts.total) >= MAX_AUTHORIZATION_REQUESTS || Number(counts.client) >= MAX_AUTHORIZATION_REQUESTS_PER_CLIENT) throw new Error('Pending OAuth authorization capacity reached.');
      this.db.prepare(`
        INSERT INTO oauth_authorization_requests(
          id,client_id,worker_id,redirect_uri,resource,scope,state,code_challenge,csrf_hash,expires_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(id, input.clientId, input.workerId, input.redirectUri, input.resource, input.scope, input.state, input.codeChallenge, input.csrfHash, input.expiresAtMs);
    });
    return { ...input, id };
  }

  getAuthorizationRequest(id: string): OAuthAuthorizationRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM oauth_authorization_requests WHERE id=? AND expires_at_ms>?').get(id, Date.now()) as SqlRow | undefined;
    return row ? authorizationRequestFromRow(row) : null;
  }

  approveAuthorization(input: { requestId: string; csrfHash: string }): { code: string; request: OAuthAuthorizationRequestRecord } {
    this.prune();
    let result!: { code: string; request: OAuthAuthorizationRequestRecord };
    this.transaction(() => {
      const request = this.getAuthorizationRequest(input.requestId);
      if (!request || !safeEqual(request.csrfHash, input.csrfHash)) throw new Error('invalid_consent');
      const client = this.getOAuthClient(request.clientId);
      if (!client || client.revokedAtMs !== null || client.workerId !== request.workerId) throw new Error('invalid_client');
      const retainedGrants = this.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN worker_id=? THEN 1 ELSE 0 END) AS worker FROM oauth_grants`).get(request.workerId) as SqlRow;
      if (Number(retainedGrants.total) >= MAX_RETAINED_GRANTS || Number(retainedGrants.worker) >= MAX_GRANTS_PER_WORKER) throw new Error('OAuth grant retention capacity reached.');
      const grantId = `grant_${randomBytes(18).toString('base64url')}`;
      const principalId = `principal_${randomBytes(18).toString('base64url')}`;
      const code = randomBytes(32).toString('base64url');
      const codeHash = hashSecret(code);
      const now = Date.now();
      const priorRun = this.db.prepare(`
        SELECT run_id FROM runs WHERE worker_id=? AND status IN ('active','draining')
      `).get(request.workerId) as SqlRow | undefined;
      if (priorRun) {
        this.releaseWorkerInTransaction(
          request.workerId,
          'A new MCP worker pairing was approved; reopen the dedicated conversation.',
          'chatgpt_worker_unavailable',
        );
      }
      // One worker has one approved binding. Re-pairing must not leave the
      // former conversation able to reclaim the newly released worker.
      this.db.prepare('UPDATE oauth_grants SET revoked_at_ms=? WHERE worker_id=? AND revoked_at_ms IS NULL').run(now, request.workerId);
      this.db.prepare(`UPDATE oauth_access_tokens SET revoked_at_ms=? WHERE grant_id IN (SELECT id FROM oauth_grants WHERE worker_id=?) AND revoked_at_ms IS NULL`).run(now, request.workerId);
      this.db.prepare(`UPDATE oauth_refresh_tokens SET revoked_at_ms=? WHERE grant_id IN (SELECT id FROM oauth_grants WHERE worker_id=?) AND revoked_at_ms IS NULL`).run(now, request.workerId);
      this.db.prepare('DELETE FROM oauth_codes WHERE grant_id IN (SELECT id FROM oauth_grants WHERE worker_id=?)').run(request.workerId);
      this.db.prepare(`INSERT INTO oauth_grants(id,client_id,principal_id,worker_id,resource,scopes,created_at_ms) VALUES (?,?,?,?,?,?,?)`).run(
        grantId,
        request.clientId,
        principalId,
        request.workerId,
        request.resource,
        request.scope,
        now,
      );
      this.db.prepare(`INSERT INTO oauth_codes(code_hash,grant_id,redirect_uri,code_challenge,expires_at_ms) VALUES (?,?,?,?,?)`).run(
        codeHash,
        grantId,
        request.redirectUri,
        request.codeChallenge,
        now + 5 * 60_000,
      );
      this.db.prepare('DELETE FROM oauth_authorization_requests WHERE id=?').run(request.id);
      this.db.prepare('DELETE FROM pairing_windows WHERE worker_id=?').run(request.workerId);
      result = { code, request };
    });
    this.emitChange(result.request.workerId);
    return result;
  }

  denyAuthorization(input: { requestId: string; csrfHash: string }): OAuthAuthorizationRequestRecord {
    return this.transaction(() => {
      const request = this.getAuthorizationRequest(input.requestId);
      if (!request || !safeEqual(request.csrfHash, input.csrfHash)) throw new Error('invalid_consent');
      this.db.prepare('DELETE FROM oauth_authorization_requests WHERE id=?').run(request.id);
      return request;
    });
  }

  consumeAuthorizationCode(input: { code: string; clientId: string; redirectUri: string; codeChallenge: string }): AuthenticatedMcpGrant | null {
    let grant: AuthenticatedMcpGrant | null = null;
    this.transaction(() => {
      const codeHash = hashSecret(input.code);
      const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash=?').get(codeHash) as SqlRow | undefined;
      if (!row) return;
      if (Number(row.expires_at_ms) <= Date.now() || String(row.redirect_uri) !== input.redirectUri || String(row.code_challenge) !== input.codeChallenge) return;
      const candidate = this.getGrant(String(row.grant_id));
      if (!candidate || candidate.clientId !== input.clientId) return;
      this.assertGrantActive(candidate, candidate.workerId);
      this.db.prepare('DELETE FROM oauth_codes WHERE code_hash=?').run(codeHash);
      grant = candidate;
    });
    return grant;
  }

  issueTokens(grant: AuthenticatedMcpGrant, rotateFromHash?: string): { accessToken: string; refreshToken?: string; expiresIn: number } {
    this.prune();
    const accessToken = randomBytes(48).toString('base64url');
    const refreshToken = grant.scopes.includes('offline_access') ? randomBytes(48).toString('base64url') : undefined;
    const now = Date.now();
    const accessExpires = now + 60 * 60_000;
    const refreshExpires = now + 30 * 24 * 60 * 60_000;
    this.transaction(() => {
      this.assertGrantActive(grant, grant.workerId);
      const accessCounts = this.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN grant_id=? THEN 1 ELSE 0 END) AS grant_count FROM oauth_access_tokens`).get(grant.id) as SqlRow;
      const refreshCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM oauth_refresh_tokens').get() as SqlRow).count);
      if (Number(accessCounts.total) + refreshCount + 2 > MAX_RETAINED_TOKENS || Number(accessCounts.grant_count) >= MAX_ACCESS_TOKENS_PER_GRANT) throw new Error('OAuth token retention capacity reached.');
      if (rotateFromHash) {
        const rotation = this.db.prepare('UPDATE oauth_refresh_tokens SET consumed_at_ms=? WHERE token_hash=? AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL AND expires_at_ms>?').run(
          now,
          rotateFromHash,
          now,
        );
        if (Number(rotation.changes) !== 1) throw new Error('invalid_refresh_token');
        // Opaque spent tokens have no remaining authority; absence rejects a
        // retry just as a consumed tombstone would, without 30-day accumulation.
        this.db.prepare('DELETE FROM oauth_refresh_tokens WHERE token_hash=?').run(rotateFromHash);
      }
      this.db.prepare(`INSERT INTO oauth_access_tokens(token_hash,grant_id,expires_at_ms) VALUES (?,?,?)`).run(hashSecret(accessToken), grant.id, accessExpires);
      if (refreshToken) this.db.prepare(`INSERT INTO oauth_refresh_tokens(token_hash,grant_id,expires_at_ms) VALUES (?,?,?)`).run(hashSecret(refreshToken), grant.id, refreshExpires);
    });
    return { accessToken, refreshToken, expiresIn: Math.floor((accessExpires - now) / 1000) };
  }

  authenticateAccessToken(token: string, workerId: string, resource: string, requiredScope: string): AuthenticatedMcpGrant | null {
    const row = this.db.prepare(`
      SELECT g.*,t.expires_at_ms AS token_expires_at_ms,t.revoked_at_ms AS token_revoked_at_ms,c.revoked_at_ms AS client_revoked_at_ms
      FROM oauth_access_tokens t
      JOIN oauth_grants g ON g.id=t.grant_id
      JOIN oauth_clients c ON c.client_id=g.client_id
      WHERE t.token_hash=?
    `).get(hashSecret(token)) as SqlRow | undefined;
    if (!row || row.revoked_at_ms != null || row.token_revoked_at_ms != null || row.client_revoked_at_ms != null) return null;
    if (Number(row.token_expires_at_ms) <= Date.now() || String(row.worker_id) !== workerId || String(row.resource) !== resource) return null;
    const scopes = String(row.scopes).split(/\s+/u).filter(Boolean);
    if (!scopes.includes(requiredScope)) return null;
    return grantFromRow(row, Number(row.token_expires_at_ms));
  }

  consumeRefreshToken(token: string): { grant: AuthenticatedMcpGrant; tokenHash: string } | null {
    const tokenHash = hashSecret(token);
    const row = this.db.prepare(`
      SELECT g.*,t.expires_at_ms AS token_expires_at_ms,t.consumed_at_ms,t.revoked_at_ms AS token_revoked_at_ms,
             c.revoked_at_ms AS client_revoked_at_ms
      FROM oauth_refresh_tokens t JOIN oauth_grants g ON g.id=t.grant_id JOIN oauth_clients c ON c.client_id=g.client_id
      WHERE t.token_hash=?
    `).get(tokenHash) as SqlRow | undefined;
    if (!row || row.revoked_at_ms != null || row.token_revoked_at_ms != null || row.client_revoked_at_ms != null || row.consumed_at_ms != null) return null;
    if (Number(row.token_expires_at_ms) <= Date.now()) return null;
    return { grant: grantFromRow(row, Number(row.token_expires_at_ms)), tokenHash };
  }

  revokeToken(token: string): void {
    const hash = hashSecret(token);
    let workerId: string | null = null;
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT grant_id FROM oauth_access_tokens WHERE token_hash=?
        UNION SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash=?
      `).get(hash, hash) as SqlRow | undefined;
      if (!row) return;
      const grant = this.getGrant(String(row.grant_id));
      if (!grant) return;
      workerId = grant.workerId;
      const now = Date.now();
      this.db.prepare('UPDATE oauth_grants SET revoked_at_ms=? WHERE id=? AND revoked_at_ms IS NULL').run(now, grant.id);
      this.db.prepare('UPDATE oauth_access_tokens SET revoked_at_ms=? WHERE grant_id=? AND revoked_at_ms IS NULL').run(now, grant.id);
      this.db.prepare('UPDATE oauth_refresh_tokens SET revoked_at_ms=? WHERE grant_id=? AND revoked_at_ms IS NULL').run(now, grant.id);
      const run = this.db.prepare(`SELECT run_id FROM runs WHERE worker_id=? AND grant_id=? AND status IN ('active','draining')`).get(grant.workerId, grant.id) as SqlRow | undefined;
      if (run) this.releaseWorkerInTransaction(grant.workerId, 'OAuth token family revoked', 'chatgpt_worker_unavailable');
    });
    if (workerId) this.emitChange(workerId);
  }

  listGrants(workerId?: string): Array<Record<string, unknown>> {
    const rows = (workerId
      ? this.db.prepare('SELECT * FROM oauth_grants WHERE worker_id=? ORDER BY created_at_ms DESC').all(workerId)
      : this.db.prepare('SELECT * FROM oauth_grants ORDER BY created_at_ms DESC').all()) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      clientId: String(row.client_id),
      principalId: String(row.principal_id),
      workerId: String(row.worker_id),
      resource: String(row.resource),
      scopes: String(row.scopes).split(/\s+/u).filter(Boolean),
      createdAt: new Date(Number(row.created_at_ms)).toISOString(),
      revokedAt: row.revoked_at_ms == null ? null : new Date(Number(row.revoked_at_ms)).toISOString(),
    }));
  }

  listAuthorizationRequests(): Array<Record<string, unknown>> {
    return (this.db.prepare('SELECT id,client_id,worker_id,redirect_uri,resource,scope,expires_at_ms FROM oauth_authorization_requests WHERE expires_at_ms>? ORDER BY expires_at_ms').all(Date.now()) as SqlRow[])
      .map((row) => ({
        id: String(row.id),
        clientId: String(row.client_id),
        workerId: String(row.worker_id),
        redirectUri: String(row.redirect_uri),
        resource: String(row.resource),
        scope: String(row.scope),
        expiresAt: new Date(Number(row.expires_at_ms)).toISOString(),
      }));
  }

  revokeGrant(grantId: string): void {
    let workerId: string | null = null;
    this.transaction(() => {
      const grant = this.getGrant(grantId);
      if (!grant) return;
      workerId = grant.workerId;
      this.db.prepare('UPDATE oauth_grants SET revoked_at_ms=? WHERE id=? AND revoked_at_ms IS NULL').run(Date.now(), grantId);
      this.db.prepare(`UPDATE oauth_access_tokens SET revoked_at_ms=? WHERE grant_id=? AND revoked_at_ms IS NULL`).run(Date.now(), grantId);
      this.db.prepare(`UPDATE oauth_refresh_tokens SET revoked_at_ms=? WHERE grant_id=? AND revoked_at_ms IS NULL`).run(Date.now(), grantId);
      const run = this.db.prepare(`SELECT run_id FROM runs WHERE worker_id=? AND grant_id=? AND status IN ('active','draining')`).get(grant.workerId, grantId) as SqlRow | undefined;
      if (run) this.releaseWorkerInTransaction(grant.workerId, 'MCP grant revoked', 'chatgpt_worker_unavailable');
    });
    if (workerId) this.emitChange(workerId);
  }

  getGrant(grantId: string): AuthenticatedMcpGrant | null {
    const row = this.db.prepare('SELECT * FROM oauth_grants WHERE id=?').get(grantId) as SqlRow | undefined;
    if (!row || row.revoked_at_ms != null) return null;
    return grantFromRow(row, Date.now() + 60_000);
  }

  prune(): void {
    const now = Date.now();
    this.lastPruneAtMs = now;
    const terminalBefore = now - this.config.retentionHours * 60 * 60_000;
    const idempotencyBefore = now - this.config.idempotencyTtlSeconds * 1_000;
    this.transaction(() => {
      this.db.prepare(`DELETE FROM exchange_replays WHERE expires_at_ms<=?`).run(now);
      this.db.prepare(`UPDATE jobs SET idempotency_digest=NULL WHERE status IN ('completed','failed','cancelled') AND completed_at_ms<?`).run(idempotencyBefore);
      this.db.prepare(`DELETE FROM jobs WHERE status IN ('completed','failed','cancelled') AND completed_at_ms<?`).run(terminalBefore);
      this.db.prepare('DELETE FROM oauth_codes WHERE expires_at_ms<=?').run(now);
      this.db.prepare('DELETE FROM oauth_authorization_requests WHERE expires_at_ms<=?').run(now);
      this.db.prepare('DELETE FROM pairing_windows WHERE expires_at_ms<=?').run(now);
      this.db.prepare('DELETE FROM oauth_access_tokens WHERE expires_at_ms<=? OR revoked_at_ms IS NOT NULL').run(now);
      this.db.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at_ms<=? OR revoked_at_ms IS NOT NULL OR consumed_at_ms IS NOT NULL').run(now);
      this.db.prepare(`DELETE FROM runs WHERE status='released' AND released_at_ms<? AND NOT EXISTS(SELECT 1 FROM exchange_replays r WHERE r.run_id=runs.run_id)`).run(terminalBefore);
      this.db.prepare(`DELETE FROM oauth_grants WHERE revoked_at_ms IS NOT NULL AND revoked_at_ms<?
        AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.grant_id=oauth_grants.id)`).run(terminalBefore);
      // Abandoned registrations cannot fill the store indefinitely. Keep an
      // approved client, any outstanding consent, or a fresh registration.
      this.db.prepare(`DELETE FROM oauth_clients WHERE created_at_ms<?
        AND NOT EXISTS(SELECT 1 FROM oauth_grants g WHERE g.client_id=oauth_clients.client_id)
        AND NOT EXISTS(SELECT 1 FROM oauth_authorization_requests a WHERE a.client_id=oauth_clients.client_id)`).run(now - 10 * 60_000);
    });
  }

  private exchangeOnce(context: ExchangeContext): GatewayExchangeResult | null {
    let output: GatewayExchangeResult | null = null;
    let replayed = false;
    let claimedRequestId: string | null = null;
    const workerId = context.grant.workerId;
    this.expireJobs(workerId, Date.now());
    this.transaction(() => {
      this.assertGrantActive(context.grant, workerId);
      const run = this.db.prepare(`SELECT * FROM runs WHERE run_id=? AND worker_id=?`).get(context.input.run_id, workerId) as SqlRow | undefined;
      if (!run || String(run.grant_id) !== context.grant.id || !this.runIsCurrent(run)) {
        output = releasedResult('This run is no longer active.');
        return;
      }
      this.db.prepare('DELETE FROM exchange_replays WHERE run_id=? AND exchange_id=? AND expires_at_ms<=?').run(
        context.input.run_id,
        context.input.exchange_id,
        Date.now(),
      );
      const replay = this.db.prepare('SELECT * FROM exchange_replays WHERE run_id=? AND exchange_id=?').get(context.input.run_id, context.input.exchange_id) as SqlRow | undefined;
      if (replay) {
        if (String(replay.args_digest) !== context.argsDigest) {
          this.recordAudit({ type: 'chatgpt.exchange.conflict', workerId });
          throw new Error('exchange_conflict');
        }
        if (replay.result_json != null) {
          output = this.fenceRequestResult(JSON.parse(String(replay.result_json)) as GatewayExchangeResult, run);
          replayed = true;
        }
      }
      if (output) return;
      if (String(run.next_exchange_id) !== context.input.exchange_id) throw new Error('exchange_out_of_order');
      const now = Date.now();
      this.db.prepare('UPDATE runs SET last_exchange_at_ms=? WHERE run_id=?').run(now, context.input.run_id);
      let completionAlreadyApplied = replay != null;
      if (context.input.completion && !completionAlreadyApplied) {
        output = this.applyCompletionInTransaction(context, run, now);
        if (output) {
          this.saveReplay(context, output);
          return;
        }
        this.assertReplayCapacity(context);
        this.db.prepare(`INSERT INTO exchange_replays(run_id,exchange_id,args_digest,result_json,expires_at_ms) VALUES (?,?,?,?,?)`).run(
          context.input.run_id,
          context.input.exchange_id,
          context.argsDigest,
          null,
          now + this.config.idempotencyTtlSeconds * 1_000,
        );
        completionAlreadyApplied = true;
      }
      const claimed = this.db.prepare(`SELECT * FROM jobs WHERE worker_id=? AND status='claimed' ORDER BY claimed_at_ms LIMIT 1`).get(workerId) as SqlRow | undefined;
      if (claimed) {
        const job = jobFromRow(claimed);
        if (job.runGeneration !== Number(run.generation)) {
          this.failJobInTransaction(job.requestId, 'chatgpt_request_timeout', 'An obsolete run owned this claim.');
        } else {
          output = requestResult(job);
          this.saveOrUpdateReplay(context, output);
          return;
        }
      }
      const queued = this.db.prepare(`SELECT * FROM jobs WHERE worker_id=? AND status='queued' ORDER BY created_at_ms,request_id LIMIT 1`).get(workerId) as SqlRow | undefined;
      if (queued) {
        const job = jobFromRow(queued);
        const worker = this.requireWorker(workerId);
        if (!worker.enabled || !worker.allowedAppIds.includes(job.appId)) {
          this.failJobInTransaction(job.requestId, 'chatgpt_model_not_allowed', 'The worker no longer authorizes this app.');
        } else {
          const claimToken = `claim_${randomBytes(32).toString('base64url')}`;
          const leaseExpires = Math.min(job.requestDeadlineAtMs, now + Math.max(1_000, worker.timeoutMs));
          const changed = this.db.prepare(`
            UPDATE jobs SET status='claimed',claimed_at_ms=?,lease_expires_at_ms=?,run_generation=?,claim_token=?
            WHERE request_id=? AND status='queued' AND NOT EXISTS(SELECT 1 FROM jobs WHERE worker_id=? AND status='claimed')
          `).run(now, leaseExpires, Number(run.generation), claimToken, job.requestId, workerId);
          if (Number(changed.changes) === 1) {
            output = requestResult(this.requireJob(job.requestId));
            claimedRequestId = job.requestId;
            this.saveOrUpdateReplay(context, output);
            return;
          }
        }
      }
      const worker = this.requireWorker(workerId);
      if (worker.draining) {
        this.finishDrainIfEmpty(workerId);
        const latestRun = this.db.prepare('SELECT status FROM runs WHERE run_id=?').get(context.input.run_id) as SqlRow | undefined;
        if (latestRun?.status === 'released') {
          output = releasedResult('Worker drain completed.');
          this.saveOrUpdateReplay(context, output);
          return;
        }
      }
      if (completionAlreadyApplied) return;
    });
    if (replayed) this.recordAudit({ type: 'chatgpt.exchange.replayed', workerId });
    if (claimedRequestId) this.recordAudit({ type: 'chatgpt.request.claimed', workerId, requestId: claimedRequestId });
    this.emitChange(workerId);
    return output;
  }

  private applyCompletionInTransaction(context: ExchangeContext, run: SqlRow, now: number): GatewayExchangeResult | null {
    const completion = context.input.completion!;
    const row = this.db.prepare('SELECT * FROM jobs WHERE request_id=? AND worker_id=?').get(completion.request_id, context.grant.workerId) as SqlRow | undefined;
    if (!row) throw new Error('stale_claim');
    const job = jobFromRow(row);
    const completionDigest = digestCanonical(completion.response === undefined ? completion.error : { response: completion.response });
    if (isTerminal(job.status)) {
      if (job.status === 'cancelled') return recoveryResult('request_cancelled', 'poll', 'The caller cancelled this request; discard the late completion.', job.requestId);
      if (job.completionDigest === completionDigest) return recoveryResult('stale_claim', 'resync', 'This completion was already accepted; resynchronize without advancing the queue.', job.requestId);
      if (job.status === 'failed') {
        const expired = job.errorCode === 'chatgpt_request_timeout' || job.errorCode === 'chatgpt_queue_timeout';
        return recoveryResult(
          expired ? 'claim_expired' : 'request_cancelled',
          'resync',
          expired ? 'The request deadline passed; discard the late completion.' : 'The request was invalidated; discard the late completion.',
          job.requestId,
        );
      }
      throw new Error('completion_conflict');
    }
    if (job.status !== 'claimed' || job.runGeneration !== Number(run.generation) || !safeEqual(job.claimToken ?? '', completion.claim_token)) {
      return recoveryResult('stale_claim', 'resync', 'The claim is stale or belongs to another run; discard it.', job.requestId);
    }
    if (job.requestDeadlineAtMs <= now || (job.leaseExpiresAtMs ?? 0) <= now) {
      this.failJobInTransaction(job.requestId, 'chatgpt_request_timeout', 'The claim expired before completion.');
      return recoveryResult('claim_expired', 'resync', 'The claim expired; discard the completion and poll again.', job.requestId);
    }
    if (completion.response !== undefined && !completion.response.trim()) {
      this.failJobInTransaction(job.requestId, 'chatgpt_empty_response', 'The worker returned an empty response.');
      this.recordAudit({ type: 'chatgpt.request.failed', workerId: job.workerId, appId: job.appId, requestId: job.requestId, reasonCode: 'chatgpt_empty_response' });
    } else if (completion.response !== undefined && Buffer.byteLength(completion.response, 'utf8') > this.config.maxResponseBytes) {
      this.failJobInTransaction(job.requestId, 'chatgpt_completion_failed', 'The worker response exceeded the configured byte limit.');
      this.recordAudit({ type: 'chatgpt.request.failed', workerId: job.workerId, appId: job.appId, requestId: job.requestId, reasonCode: 'chatgpt_completion_failed' });
    } else if (completion.response !== undefined && job.controls.responseFormat === 'json_object' && !safeJsonObjectResponse(completion.response)) {
      this.failJobInTransaction(job.requestId, 'chatgpt_invalid_json', 'The worker response was not a valid JSON object.');
      this.recordAudit({ type: 'chatgpt.request.failed', workerId: job.workerId, appId: job.appId, requestId: job.requestId, reasonCode: 'chatgpt_invalid_json' });
    } else if (completion.response !== undefined) {
      this.db.prepare(`
        UPDATE jobs SET status='completed',result_text=?,completion_digest=?,completed_at_ms=?,messages_json=NULL,
          claim_token=NULL,lease_expires_at_ms=NULL,error_code=NULL,error_message=NULL WHERE request_id=?
      `).run(completion.response, completionDigest, now, job.requestId);
      this.redactInvalidRequestReplaysInTransaction();
      this.db.prepare('UPDATE workers SET last_successful_completion_at_ms=?,last_error_code=NULL,last_error_message=NULL WHERE id=?').run(now, job.workerId);
      this.recordAudit({ type: 'chatgpt.request.completed', workerId: job.workerId, appId: job.appId, requestId: job.requestId });
    } else {
      // Worker-provided error text is untrusted and may contain the prompt,
      // credentials or claim handles. Persist/publish only our fixed reason.
      this.failJobInTransaction(job.requestId, 'chatgpt_completion_failed', 'The worker reported an error while processing the request.', completionDigest);
      this.recordAudit({ type: 'chatgpt.request.failed', workerId: job.workerId, appId: job.appId, requestId: job.requestId, reasonCode: 'chatgpt_completion_failed' });
    }
    return null;
  }

  private finalizeIdleExchange(context: ExchangeContext, startedAt: number): GatewayExchangeResult {
    let output!: GatewayExchangeResult;
    this.transaction(() => {
      this.assertGrantActive(context.grant, context.grant.workerId);
      const run = this.db.prepare('SELECT * FROM runs WHERE run_id=? AND worker_id=?').get(context.input.run_id, context.grant.workerId) as SqlRow | undefined;
      output = !run || String(run.grant_id) !== context.grant.id || !this.runIsCurrent(run)
        ? releasedResult('This run is no longer active.')
        : {
            protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION,
            state: 'idle',
            continue: true,
            waited_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1_000)),
            next_exchange_id: newExchangeId(),
          };
      this.saveOrUpdateReplay(context, output);
    });
    return output;
  }

  private saveReplay(context: ExchangeContext, result: GatewayExchangeResult): void {
    this.assertReplayCapacity(context);
    this.db.prepare(`INSERT INTO exchange_replays(run_id,exchange_id,args_digest,result_json,expires_at_ms) VALUES (?,?,?,?,?)`).run(
      context.input.run_id,
      context.input.exchange_id,
      context.argsDigest,
      JSON.stringify(result),
      Date.now() + this.config.idempotencyTtlSeconds * 1_000,
    );
    this.db.prepare('UPDATE runs SET next_exchange_id=? WHERE run_id=?').run(result.next_exchange_id, context.input.run_id);
  }

  private saveOrUpdateReplay(context: ExchangeContext, result: GatewayExchangeResult): void {
    this.assertReplayCapacity(context);
    const existing = this.db.prepare('SELECT args_digest FROM exchange_replays WHERE run_id=? AND exchange_id=?').get(context.input.run_id, context.input.exchange_id) as SqlRow | undefined;
    if (existing && String(existing.args_digest) !== context.argsDigest) throw new Error('exchange_conflict');
    this.db.prepare(`
      INSERT INTO exchange_replays(run_id,exchange_id,args_digest,result_json,expires_at_ms) VALUES (?,?,?,?,?)
      ON CONFLICT(run_id,exchange_id) DO UPDATE SET result_json=excluded.result_json,expires_at_ms=excluded.expires_at_ms
    `).run(
      context.input.run_id,
      context.input.exchange_id,
      context.argsDigest,
      JSON.stringify(result),
      Date.now() + this.config.idempotencyTtlSeconds * 1_000,
    );
    this.db.prepare('UPDATE runs SET next_exchange_id=? WHERE run_id=?').run(result.next_exchange_id, context.input.run_id);
  }

  private openResult(worker: ChatGptWorkerConfig, run: SqlRow): GatewayOpenResult {
    return {
      protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION,
      worker_id: worker.id,
      run_id: String(run.run_id),
      run_generation: Number(run.generation),
      next_exchange_id: String(run.next_exchange_id ?? run.initial_exchange_id),
      limits: this.protocolLimits(),
    };
  }

  private protocolLimits(): GatewayOpenResult['limits'] {
    const maximumWaitSeconds = Math.max(1, Math.min(55, Math.round(this.config.longPollMs * 2 / 1_000)));
    return {
      default_wait_seconds: Math.min(maximumWaitSeconds, Math.max(1, Math.round(this.config.longPollMs / 1_000))),
      maximum_wait_seconds: maximumWaitSeconds,
      maximum_response_bytes: this.config.maxResponseBytes,
    };
  }

  private isWorkerAdmitting(worker: ChatGptWorkerConfig, now: number): boolean {
    if (!worker.enabled || worker.draining) return false;
    const run = this.db.prepare(`SELECT * FROM runs WHERE worker_id=? AND status='active'`).get(worker.id) as SqlRow | undefined;
    if (!run) return false;
    if ((this.pendingPolls.get(worker.id) ?? 0) > 0) return true;
    const lastExchange = run.last_exchange_at_ms == null ? 0 : Number(run.last_exchange_at_ms);
    if (lastExchange > 0 && now - lastExchange <= this.config.staleAfterMs) return true;
    const claim = this.db.prepare(`SELECT request_deadline_at_ms FROM jobs WHERE worker_id=? AND status='claimed' LIMIT 1`).get(worker.id) as SqlRow | undefined;
    return Boolean(claim && Number(claim.request_deadline_at_ms) > now);
  }

  private expireJobs(workerId: string, now: number): void {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE worker_id=? AND status IN ('queued','claimed')`).all(workerId) as SqlRow[];
    const expiring = rows.map(jobFromRow).filter((job) =>
      job.requestDeadlineAtMs <= now || (job.status === 'queued' && job.queueDeadlineAtMs <= now) || (job.status === 'claimed' && (job.leaseExpiresAtMs ?? 0) <= now),
    );
    if (expiring.length === 0) return;
    this.transaction(() => {
      for (const job of expiring) {
        const queue = job.status === 'queued' && job.queueDeadlineAtMs <= now && job.requestDeadlineAtMs > now;
        this.failJobInTransaction(
          job.requestId,
          queue ? 'chatgpt_queue_timeout' : 'chatgpt_request_timeout',
          queue ? 'The worker did not claim the request before its queue deadline.' : 'The request or claim reached its deadline.',
        );
        this.recordAudit({
          type: 'chatgpt.request.expired',
          workerId: job.workerId,
          appId: job.appId,
          requestId: job.requestId,
          reasonCode: queue ? 'chatgpt_queue_timeout' : 'chatgpt_request_timeout',
        });
      }
      this.finishDrainIfEmpty(workerId);
    });
    this.emitChange(workerId);
  }

  private failJobsWhere(where: string, args: string[], code: string, message: string): void {
    this.db.prepare(`
      UPDATE jobs SET status='failed',error_code=?,error_message=?,completed_at_ms=?,messages_json=NULL,
        claim_token=NULL,lease_expires_at_ms=NULL WHERE ${where}
    `).run(code, message, Date.now(), ...args);
    this.redactInvalidRequestReplaysInTransaction();
  }

  private failJobInTransaction(requestId: string, code: string, message: string, completionDigest?: string): void {
    this.db.prepare(`
      UPDATE jobs SET status='failed',error_code=?,error_message=?,completion_digest=COALESCE(?,completion_digest),completed_at_ms=?,messages_json=NULL,
        claim_token=NULL,lease_expires_at_ms=NULL WHERE request_id=? AND status IN ('queued','claimed')
    `).run(code, message, completionDigest ?? null, Date.now(), requestId);
    this.redactInvalidRequestReplaysInTransaction();
    const job = this.db.prepare('SELECT worker_id FROM jobs WHERE request_id=?').get(requestId) as SqlRow | undefined;
    if (job) this.db.prepare('UPDATE workers SET last_error_code=?,last_error_message=? WHERE id=?').run(code, message, String(job.worker_id));
  }

  private releaseWorkerInTransaction(workerId: string, reason: string, jobCode: string): void {
    this.failJobsWhere(`worker_id=? AND status IN ('queued','claimed')`, [workerId], jobCode, reason);
    this.db.prepare(`UPDATE runs SET status='released',released_at_ms=? WHERE worker_id=? AND status IN ('active','draining')`).run(Date.now(), workerId);
    this.db.prepare('UPDATE workers SET draining=0,run_generation=run_generation+1,last_error_code=?,last_error_message=?,updated_at_ms=? WHERE id=?').run(
      jobCode,
      reason,
      Date.now(),
      workerId,
    );
  }

  private finishDrainIfEmpty(workerId: string): void {
    const active = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE worker_id=? AND status IN ('queued','claimed')`).get(workerId) as SqlRow).count);
    if (active > 0) return;
    this.db.prepare(`UPDATE runs SET status='released',released_at_ms=? WHERE worker_id=? AND status='draining'`).run(Date.now(), workerId);
    this.db.prepare('UPDATE workers SET draining=0,run_generation=run_generation+1,updated_at_ms=? WHERE id=? AND draining=1').run(Date.now(), workerId);
  }

  private runIsCurrent(run: SqlRow): boolean {
    if (run.status !== 'active' && run.status !== 'draining') return false;
    const worker = this.getWorker(String(run.worker_id));
    return Boolean(worker?.enabled && worker.runGeneration === Number(run.generation));
  }

  private fenceRequestResult(result: GatewayExchangeResult, run: SqlRow): GatewayExchangeResult {
    if (result.state === 'recovery' && result.request_id) {
      // Redacted stale replays resynchronize to the current cursor without
      // advancing it and without returning another request as a fake replay.
      return { ...result, next_exchange_id: String(run.next_exchange_id) };
    }
    if (result.state !== 'request') return result;
    const row = this.db.prepare('SELECT * FROM jobs WHERE request_id=? AND worker_id=?').get(result.request.request_id, String(run.worker_id)) as SqlRow | undefined;
    const job = row ? jobFromRow(row) : null;
    const now = Date.now();
    if (job?.status === 'claimed'
      && job.runGeneration === Number(run.generation)
      && job.requestDeadlineAtMs > now
      && (job.leaseExpiresAtMs ?? 0) > now
      && safeEqual(job.claimToken ?? '', result.request.claim_token)) return result;
    const expired = job?.errorCode === 'chatgpt_request_timeout' || job?.errorCode === 'chatgpt_queue_timeout'
      || (job?.status === 'claimed' && (job.requestDeadlineAtMs <= now || (job.leaseExpiresAtMs ?? 0) <= now));
    const cancelled = job?.status === 'cancelled' || job?.status === 'failed';
    return {
      ...recoveryResult(
        expired ? 'claim_expired' : cancelled ? 'request_cancelled' : 'stale_claim',
        'resync',
        expired ? 'The claim expired; discard its payload and resynchronize.' : 'The former claim is no longer valid; discard its payload and resynchronize.',
        result.request.request_id,
      ),
      next_exchange_id: String(run.next_exchange_id),
    };
  }

  private redactInvalidRequestReplaysInTransaction(): void {
    // Terminal payloads/claim handles are no longer necessary for replay.
    // Keep the digest and a precise recovery result for the advertised TTL.
    const rows = this.db.prepare(`
      SELECT r.run_id,r.exchange_id,r.result_json FROM exchange_replays r
      LEFT JOIN jobs j ON j.request_id=json_extract(r.result_json,'$.request.request_id')
      LEFT JOIN runs n ON n.run_id=r.run_id
      WHERE json_extract(r.result_json,'$.state')='request'
        AND (j.request_id IS NULL OR j.status!='claimed' OR n.run_id IS NULL
          OR n.status NOT IN ('active','draining') OR j.run_generation!=n.generation
          OR j.request_deadline_at_ms<=? OR j.lease_expires_at_ms<=?)
    `).all(Date.now(), Date.now()) as SqlRow[];
    for (const row of rows) {
      const run = this.db.prepare('SELECT * FROM runs WHERE run_id=?').get(String(row.run_id)) as SqlRow | undefined;
      const result = JSON.parse(String(row.result_json)) as GatewayExchangeResult;
      const safeResult = run && this.runIsCurrent(run)
        ? this.fenceRequestResult(result, run)
        : releasedResult('This run is no longer active.');
      this.db.prepare('UPDATE exchange_replays SET result_json=? WHERE run_id=? AND exchange_id=?').run(JSON.stringify(safeResult), String(row.run_id), String(row.exchange_id));
    }
  }

  private assertReplayCapacity(context: ExchangeContext): void {
    if (this.db.prepare('SELECT 1 FROM exchange_replays WHERE run_id=? AND exchange_id=?').get(context.input.run_id, context.input.exchange_id)) return;
    this.db.prepare('DELETE FROM exchange_replays WHERE expires_at_ms<=?').run(Date.now());
    const row = this.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN run_id=? THEN 1 ELSE 0 END) AS run FROM exchange_replays`).get(context.input.run_id) as SqlRow;
    if (Number(row.total) >= MAX_REPLAY_RECORDS || Number(row.run) >= MAX_REPLAYS_PER_RUN) {
      throw chatGptError('chatgpt_queue_full', 'The gateway replay capacity is full; wait for retention before retrying.');
    }
  }

  private assertOpen(): void {
    if (this.closed) throw chatGptError('chatgpt_store_unavailable', 'The gateway stopped while waiting for the worker.');
  }

  private assertGrantActive(grant: AuthenticatedMcpGrant, workerId: string): void {
    this.assertOpen();
    if (grant.expiresAt <= Date.now() || !grant.scopes.includes('mcp:tools')) throw new Error('grant_revoked');
    const row = this.db.prepare(`
      SELECT g.* FROM oauth_grants g JOIN oauth_clients c ON c.client_id=g.client_id
      WHERE g.id=? AND g.worker_id=? AND g.revoked_at_ms IS NULL AND c.revoked_at_ms IS NULL
    `).get(grant.id, workerId) as SqlRow | undefined;
    if (!row
      || String(row.client_id) !== grant.clientId
      || String(row.principal_id) !== grant.principalId
      || String(row.resource) !== grant.resource
      || grant.scopes.some((scope) => !String(row.scopes).split(/\s+/u).includes(scope))
      || !String(row.scopes).split(/\s+/u).includes('mcp:tools')) {
      throw new Error('grant_revoked');
    }
  }

  private requireWorker(id: string): ChatGptWorkerConfig {
    const worker = this.getWorker(id);
    if (!worker) throw new Error('worker_not_found');
    return worker;
  }

  private requireJob(id: string): StoredJob {
    const row = this.db.prepare('SELECT * FROM jobs WHERE request_id=?').get(id) as SqlRow | undefined;
    if (!row) throw new Error('job_not_found');
    return jobFromRow(row);
  }

  private waitForChange(workerId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.closed) return Promise.reject(new Error('wait_aborted'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.changes.off(`change:${workerId}`, onChange);
        signal?.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve();
      };
      const onChange = () => finish();
      const onAbort = () => finish(new Error('wait_aborted'));
      const timer = setTimeout(onChange, Math.max(1, timeoutMs));
      timer.unref();
      this.changes.once(`change:${workerId}`, onChange);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted || this.closed) onAbort();
    });
  }

  private emitChange(workerId: string): void {
    this.changes.emit(`change:${workerId}`);
  }

  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPruneAtMs < 60_000) return;
    this.lastPruneAtMs = now;
    this.prune();
  }

  private recordAudit(event: ChatGptStoreAuditEvent): void {
    if (this.transactionAuditEvents) {
      this.transactionAuditEvents.push(event);
      return;
    }
    try {
      this.auditEvent?.(event);
    } catch {
      // Audit failures cannot alter a committed queue/claim transition.
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const events: ChatGptStoreAuditEvent[] = [];
    this.transactionAuditEvents = events;
    let result: T;
    try {
      result = operation();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionAuditEvents = null;
    }
    for (const event of events) this.recordAudit(event);
    return result;
  }

  private meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as SqlRow | undefined;
    return row ? String(row.value) : null;
  }

  private claimRuntimeOwnership(): void {
    this.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
      const existing = this.meta('runtime_owner');
      if (existing) {
        let value: { pid?: number; ownerId?: string } | null;
        try {
          value = JSON.parse(existing) as { pid?: number; ownerId?: string };
        } catch {
          value = null;
        }
        if (value?.ownerId && value.ownerId !== this.ownerId && value.pid && processIsAlive(value.pid)) {
          throw chatGptError('chatgpt_store_unavailable', 'Another GemRouter process already owns this ChatGPT gateway store.');
        }
      }
      this.db.prepare(`INSERT INTO meta(key,value) VALUES ('runtime_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(
        JSON.stringify({ pid: process.pid, ownerId: this.ownerId, startedAt: new Date().toISOString() }),
      );
    });
  }

  private releaseRuntimeOwnership(): void {
    this.transaction(() => {
      const current = this.meta('runtime_owner');
      if (!current) return;
      const owner = JSON.parse(current) as { ownerId?: string };
      if (owner.ownerId === this.ownerId) this.db.prepare('DELETE FROM meta WHERE key=?').run('runtime_owner');
    });
  }

  private recoverAfterRestart(): void {
    const interrupted = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','claimed')`).get() as SqlRow).count);
    this.transaction(() => {
      this.failJobsWhere(`status IN ('queued','claimed')`, [], 'chatgpt_gateway_restarted', 'The GemRouter process restarted before this synchronous request completed.');
      this.db.prepare(`UPDATE runs SET status='released',released_at_ms=? WHERE status IN ('active','draining')`).run(Date.now());
      this.db.prepare('UPDATE workers SET run_generation=run_generation+1,draining=0').run();
      this.db.prepare('DELETE FROM exchange_replays').run();
    });
    if (interrupted > 0) this.recordAudit({ type: 'chatgpt.gateway.recovered', reasonCode: 'chatgpt_gateway_restarted' });
  }

  private migrate(): void {
    const currentVersion = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
    if (currentVersion > 3) throw new Error(`Unsupported future ChatGPT gateway schema version ${currentVersion}.`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers(
        id TEXT PRIMARY KEY,label TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,allowed_app_ids TEXT NOT NULL DEFAULT '[]',
        domain_label TEXT,declared_model TEXT NOT NULL,declared_reasoning TEXT,context_epoch INTEGER NOT NULL DEFAULT 1,
        instruction_version INTEGER NOT NULL DEFAULT 1,timeout_ms INTEGER NOT NULL,queue_timeout_ms INTEGER NOT NULL,
        max_queued_requests INTEGER NOT NULL,draining INTEGER NOT NULL DEFAULT 0,config_version INTEGER NOT NULL DEFAULT 1,
        run_generation INTEGER NOT NULL DEFAULT 0,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,
        last_successful_completion_at_ms INTEGER,last_error_code TEXT,last_error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS worker_aliases(alias TEXT PRIMARY KEY,worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS oauth_clients(
        client_id TEXT PRIMARY KEY,worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,client_name TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,created_at_ms INTEGER NOT NULL,revoked_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_grants(
        id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,principal_id TEXT NOT NULL,
        worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,resource TEXT NOT NULL,scopes TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,revoked_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_authorization_requests(
        id TEXT PRIMARY KEY,client_id TEXT NOT NULL,worker_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,resource TEXT NOT NULL,
        scope TEXT NOT NULL,state TEXT NOT NULL,code_challenge TEXT NOT NULL,csrf_hash TEXT NOT NULL,expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes(
        code_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_access_tokens(
        token_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,expires_at_ms INTEGER NOT NULL,revoked_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens(
        token_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER,revoked_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS pairing_windows(worker_id TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,expires_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(
        worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,run_id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
        generation INTEGER NOT NULL,open_id_hash TEXT NOT NULL,initial_exchange_id TEXT NOT NULL,next_exchange_id TEXT NOT NULL,opened_at_ms INTEGER NOT NULL,
        last_exchange_at_ms INTEGER,status TEXT NOT NULL,released_at_ms INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_run_per_worker ON runs(worker_id) WHERE status IN ('active','draining');
      CREATE TABLE IF NOT EXISTS jobs(
        request_id TEXT PRIMARY KEY,app_id TEXT NOT NULL,worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,surface TEXT NOT NULL,status TEXT NOT NULL,messages_json TEXT,controls_json TEXT NOT NULL,fingerprint TEXT NOT NULL,
        idempotency_digest TEXT,created_at_ms INTEGER NOT NULL,queue_deadline_at_ms INTEGER NOT NULL,request_deadline_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER,lease_expires_at_ms INTEGER,run_generation INTEGER,claim_token TEXT,result_text TEXT,error_code TEXT,
        error_message TEXT,completed_at_ms INTEGER,completion_digest TEXT,config_version INTEGER NOT NULL,context_epoch INTEGER NOT NULL,
        instruction_version INTEGER NOT NULL
        ,worker_snapshot_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON jobs(app_id,surface,idempotency_digest) WHERE idempotency_digest IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_worker_status ON jobs(worker_id,status,created_at_ms);
      CREATE TABLE IF NOT EXISTS exchange_replays(
        run_id TEXT NOT NULL,exchange_id TEXT NOT NULL,args_digest TEXT NOT NULL,result_json TEXT,expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY(run_id,exchange_id)
      );
    `);
    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all() as SqlRow[];
    if (!runColumns.some((column) => String(column.name) === 'next_exchange_id')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN next_exchange_id TEXT; UPDATE runs SET next_exchange_id=initial_exchange_id WHERE next_exchange_id IS NULL;');
    }
    const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all() as SqlRow[];
    if (!jobColumns.some((column) => String(column.name) === 'worker_snapshot_json')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN worker_snapshot_json TEXT;');
    }
    this.db.exec('PRAGMA user_version=3;');
  }
}

function validateStoreConfig(config: ChatGptGatewayConfig): void {
  const integer = (value: number, min: number, max: number, name: string): void => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ChatGPT gateway ${name}.`);
  };
  integer(config.timeoutMs, 1_000, 30 * 60_000, 'timeoutMs');
  integer(config.queueTimeoutMs, 100, config.timeoutMs, 'queueTimeoutMs');
  integer(config.longPollMs, 100, 55_000, 'longPollMs');
  integer(config.staleAfterMs, 100, 24 * 60 * 60_000, 'staleAfterMs');
  integer(config.maxQueuePerWorker, 1, 64, 'maxQueuePerWorker');
  integer(config.maxActiveJobs, 1, 10_000, 'maxActiveJobs');
  integer(config.maxRequestBytes, 1_024, 64 * 1024 * 1024, 'maxRequestBytes');
  integer(config.maxResponseBytes, 1_024, 64 * 1024 * 1024, 'maxResponseBytes');
  integer(config.idempotencyTtlSeconds, 1, 30 * 24 * 60 * 60, 'idempotencyTtlSeconds');
  if (!Number.isFinite(config.retentionHours) || config.retentionHours <= 0 || config.retentionHours > 24 * 365) {
    throw new Error('Invalid ChatGPT gateway retentionHours.');
  }
  if (config.retentionHours * 60 * 60 < config.idempotencyTtlSeconds) {
    throw new Error('ChatGPT gateway retentionHours must cover idempotencyTtlSeconds.');
  }
}

function workerFromRow(row: SqlRow): ChatGptWorkerConfig {
  return {
    id: String(row.id),
    label: String(row.label),
    enabled: Number(row.enabled) === 1,
    publicModelIds: parseStringList(row.public_model_ids),
    allowedAppIds: parseStringList(row.allowed_app_ids),
    domainLabel: row.domain_label == null ? undefined : String(row.domain_label),
    declaredModel: String(row.declared_model),
    declaredReasoning: row.declared_reasoning == null ? undefined : String(row.declared_reasoning),
    modelVerified: false,
    contextMode: 'persistent_chat',
    contextEpoch: Number(row.context_epoch),
    instructionVersion: Number(row.instruction_version),
    timeoutMs: Number(row.timeout_ms),
    queueTimeoutMs: Number(row.queue_timeout_ms),
    maxQueuedRequests: Number(row.max_queued_requests),
    draining: Number(row.draining) === 1,
    configVersion: Number(row.config_version),
    runGeneration: Number(row.run_generation),
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
  };
}

function jobFromRow(row: SqlRow): StoredJob {
  return {
    requestId: String(row.request_id),
    appId: String(row.app_id),
    workerId: String(row.worker_id),
    alias: String(row.alias),
    status: String(row.status) as StoredJob['status'],
    messages: row.messages_json == null ? [] : JSON.parse(String(row.messages_json)),
    controls: JSON.parse(String(row.controls_json)),
    fingerprint: String(row.fingerprint),
    createdAtMs: Number(row.created_at_ms),
    queueDeadlineAtMs: Number(row.queue_deadline_at_ms),
    requestDeadlineAtMs: Number(row.request_deadline_at_ms),
    claimedAtMs: row.claimed_at_ms == null ? null : Number(row.claimed_at_ms),
    leaseExpiresAtMs: row.lease_expires_at_ms == null ? null : Number(row.lease_expires_at_ms),
    runGeneration: row.run_generation == null ? null : Number(row.run_generation),
    claimToken: row.claim_token == null ? null : String(row.claim_token),
    result: row.result_text == null ? null : String(row.result_text),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    completedAtMs: row.completed_at_ms == null ? null : Number(row.completed_at_ms),
    completionDigest: row.completion_digest == null ? null : String(row.completion_digest),
    configVersion: Number(row.config_version),
    contextEpoch: Number(row.context_epoch),
    instructionVersion: Number(row.instruction_version),
    workerSnapshot: row.worker_snapshot_json == null
      ? null
      : JSON.parse(String(row.worker_snapshot_json)) as ChatGptWorkerConfig,
  };
}

function requestResult(job: StoredJob): GatewayExchangeResult {
  if (!job.claimToken) throw new Error('missing_claim');
  return {
    protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION,
    state: 'request',
    continue: true,
    next_exchange_id: newExchangeId(),
    request: {
      request_id: job.requestId,
      claim_token: job.claimToken,
      deadline: new Date(job.requestDeadlineAtMs).toISOString(),
      model_alias: job.alias,
      context_mode: 'persistent_chat',
      context_epoch: job.contextEpoch,
      instruction_version: job.instructionVersion,
      response_format: job.controls.responseFormat,
      messages: job.messages,
    },
  };
}

function recoveryResult(
  code: Extract<GatewayExchangeResult, { state: 'recovery' }>['code'],
  nextAction: Extract<GatewayExchangeResult, { state: 'recovery' }>['next_action'],
  message: string,
  requestId?: string,
): GatewayExchangeResult {
  return {
    protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION,
    state: 'recovery',
    continue: true,
    code,
    next_action: nextAction,
    message,
    next_exchange_id: newExchangeId(),
    ...(requestId ? { request_id: requestId } : {}),
  };
}

function releasedResult(reason: string): GatewayExchangeResult {
  return {
    protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION,
    state: 'released',
    continue: false,
    reason,
    next_exchange_id: newExchangeId(),
  };
}

function workerLastCompletion(db: DatabaseSync, workerId: string): string | null {
  const row = db.prepare('SELECT last_successful_completion_at_ms FROM workers WHERE id=?').get(workerId) as SqlRow | undefined;
  return row?.last_successful_completion_at_ms == null ? null : new Date(Number(row.last_successful_completion_at_ms)).toISOString();
}

function workerErrorFromRow(row: SqlRow): { code: string; message: string } | null {
  if (row.last_error_code == null) return null;
  const code = String(row.last_error_code);
  return {
    code,
    message: code === 'chatgpt_completion_failed'
      ? chatGptError('chatgpt_completion_failed').message
      : String(row.last_error_message ?? ''),
  };
}

function oauthClientFromRow(row: SqlRow): OAuthClientRecord {
  return {
    clientId: String(row.client_id),
    workerId: String(row.worker_id),
    clientName: String(row.client_name),
    redirectUri: String(row.redirect_uri),
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs: row.revoked_at_ms == null ? null : Number(row.revoked_at_ms),
  };
}

function authorizationRequestFromRow(row: SqlRow): OAuthAuthorizationRequestRecord {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    workerId: String(row.worker_id),
    redirectUri: String(row.redirect_uri),
    resource: String(row.resource),
    scope: String(row.scope),
    state: String(row.state),
    codeChallenge: String(row.code_challenge),
    csrfHash: String(row.csrf_hash),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

function grantFromRow(row: SqlRow, expiresAt: number): AuthenticatedMcpGrant {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    principalId: String(row.principal_id),
    workerId: String(row.worker_id),
    resource: String(row.resource),
    scopes: String(row.scopes).split(/\s+/u).filter(Boolean),
    expiresAt,
  };
}

function parseStringList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isTerminal(status: StoredJob['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function newExchangeId(): string {
  return `ex_${randomBytes(24).toString('base64url')}`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
