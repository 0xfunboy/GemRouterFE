import type { LLMMessage } from '../../types.js';

export const CHATGPT_GATEWAY_PROTOCOL_VERSION = '1.0' as const;

export type ChatGptGatewayProfile = 'compatibility' | 'strict';
export type ChatGptWorkerState =
  | 'disabled'
  | 'unpaired'
  | 'waiting_for_wake'
  | 'polling'
  | 'processing_claim'
  | 'contact_recent'
  | 'stale'
  | 'draining'
  | 'released'
  | 'degraded';

export interface ChatGptWorkerConfig {
  id: string;
  label: string;
  enabled: boolean;
  publicModelIds: string[];
  allowedAppIds: string[];
  domainLabel?: string;
  declaredModel: string;
  declaredReasoning?: string;
  modelVerified: false;
  contextMode: 'persistent_chat';
  contextEpoch: number;
  instructionVersion: number;
  timeoutMs: number;
  queueTimeoutMs: number;
  maxQueuedRequests: number;
  draining: boolean;
  configVersion: number;
  runGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatGptGatewayConfig {
  enabled: boolean;
  publicBaseUrl?: string;
  dataDir: string;
  profile: ChatGptGatewayProfile;
  timeoutMs: number;
  queueTimeoutMs: number;
  longPollMs: number;
  staleAfterMs: number;
  maxQueuePerWorker: number;
  maxActiveJobs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  idempotencyTtlSeconds: number;
  retentionHours: number;
}

export type ChatGptMessageRole = 'system' | 'developer' | 'user' | 'assistant';

export interface ChatGptGatewayMessage {
  role: ChatGptMessageRole;
  content: string;
}

export interface ChatGptExplicitControls {
  present: string[];
  warnings: string[];
  responseFormat: 'text' | 'json_object';
  stream: boolean;
  includeUsage: boolean;
  profile: ChatGptGatewayProfile;
}

export interface ChatGptSubmitInput {
  appId: string;
  alias: string;
  messages: ChatGptGatewayMessage[];
  surface: 'openai' | 'gemrouter';
  fingerprint: string;
  idempotencyKey?: string;
  controls: ChatGptExplicitControls;
  signal?: AbortSignal;
  deadline?: number;
}

export interface ChatGptJobResult {
  requestId: string;
  alias: string;
  content: string;
  createdAt: string;
  completedAt: string;
  queueWaitMs: number;
  processingWaitMs: number;
  totalLatencyMs: number;
  worker: ChatGptWorkerConfig;
  warnings: string[];
}

export interface GatewayOpenInput {
  protocol_version: string;
  open_id: string;
}

export interface GatewayCompletionInput {
  request_id: string;
  claim_token: string;
  response?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface GatewayExchangeInput {
  run_id: string;
  exchange_id: string;
  maximum_wait_seconds?: number;
  /** Optional protocol 1.0 extension, advertised by gateway_open limits. */
  yield_after_completion?: boolean;
  completion?: GatewayCompletionInput;
}

export interface GatewayRequestPayload {
  request_id: string;
  claim_token: string;
  deadline: string;
  model_alias: string;
  context_mode: 'persistent_chat';
  context_epoch: number;
  instruction_version: number;
  response_format: 'text' | 'json_object';
  messages: ChatGptGatewayMessage[];
}

interface GatewayResultBase {
  protocol_version: typeof CHATGPT_GATEWAY_PROTOCOL_VERSION;
  next_exchange_id: string;
  continue: boolean;
}

export type GatewayExchangeResult =
  | (GatewayResultBase & { state: 'request'; continue: true; request: GatewayRequestPayload })
  | (GatewayResultBase & { state: 'idle'; continue: true; waited_seconds: number })
  | (GatewayResultBase & { state: 'yielded'; continue: true })
  | (GatewayResultBase & {
      state: 'recovery';
      continue: true;
      code: 'request_cancelled' | 'stale_claim' | 'worker_busy' | 'claim_expired' | 'grant_revoked';
      next_action: 'poll' | 'resync' | 'bounded_wait';
      message: string;
      request_id?: string;
    })
  | (GatewayResultBase & { state: 'released'; continue: false; reason: string });

export interface GatewayOpenResult {
  protocol_version: typeof CHATGPT_GATEWAY_PROTOCOL_VERSION;
  worker_id: string;
  run_id: string;
  run_generation: number;
  next_exchange_id: string;
  limits: {
    default_wait_seconds: number;
    maximum_wait_seconds: number;
    maximum_response_bytes: number;
    extensions?: ['yield_after_completion_v1'];
  };
}

export interface ChatGptWorkerStatus {
  workerId: string;
  state: ChatGptWorkerState;
  pendingWorkerPolls: number;
  lastExchangeAt: string | null;
  lastSuccessfulCompletionAt: string | null;
  processingClaim: boolean;
  claimAgeMs: number | null;
  leaseExpiresAt: string | null;
  queueLength: number;
  oldestQueueAgeMs: number;
  nextAction: 'open_chat' | 'wake_chat' | 'wait' | 'inspect_claim' | 'none';
  lastError: { code: string; message: string } | null;
}

export interface AuthenticatedMcpGrant {
  id: string;
  clientId: string;
  principalId: string;
  workerId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
}

export interface ChatGptLlmContext {
  appId: string;
  surface: 'openai' | 'gemrouter';
  fingerprint: string;
  idempotencyKey?: string;
  messages: ChatGptGatewayMessage[];
  controls: ChatGptExplicitControls;
  requestTimeoutMs: number;
}

export function toLlmMessages(messages: ChatGptGatewayMessage[]): LLMMessage[] {
  return messages.map((message) => ({
    role: message.role === 'developer' ? 'system' : message.role,
    content: message.content,
  }));
}
