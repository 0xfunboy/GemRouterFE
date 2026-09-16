/** Private control-plane records. Never include inference payloads or worker handles. */
export const CHATGPT_PERSONAL_SURFACE = 'personal_chatgpt_web' as const;
export const PERSONAL_CHAT_TOOLS = ['gateway_open', 'gateway_exchange', 'gateway_status'] as const;

export type ChatGptControlMode = 'browser' | 'native' | 'manual';
export type ChatGptControlFailureCode =
  | 'controller_not_authenticated' | 'browser_not_authenticated' | 'controller_unavailable'
  | 'target_mismatch' | 'account_mismatch' | 'connector_mismatch' | 'tools_missing'
  | 'approval_required' | 'delivery_ambiguous' | 'wake_timeout' | 'binding_changed'
  | 'operator_stopped' | 'grant_revoked' | 'no_pending_jobs' | 'wake_attempts_exhausted';

export interface ChatGptControlBindingInput {
  chatgptConversationUrl: string;
  expectedConnectorLabel: string;
  expectedMcpResource: string;
  expectedAccountLabel: string;
  expectedAccountId?: string;
  controllerRuntimeRef: string;
  browserOrHostRef?: string;
  controlMode: ChatGptControlMode;
  /** Explicit administrator declaration, not a browser observation. */
  operatorResourceConfirmed: boolean;
}

export interface ChatGptControlBinding extends ChatGptControlBindingInput {
  workerId: string;
  chatgptConversationId: string;
  surface: typeof CHATGPT_PERSONAL_SURFACE;
  bindingVersion: number;
  wakeEnabled: boolean;
  operatorStopped: boolean;
  operatorStopGeneration: number;
  activationGeneration: number;
  targetVerified: boolean;
  toolSetVerified: boolean;
  gatewayStatusVerified: boolean;
  writeApprovalVerified: boolean;
  connectorIdentityObserved: string | null;
  lastTargetVerifiedAt: string | null;
  lastToolSetVerifiedAt: string | null;
  lastStatusObservedAt: string | null;
  statusProbeSequence: number;
  lastPollingObservedAt: string | null;
  lastWakeAttemptAt: string | null;
  lastWakeOutcome: ChatGptControlWakeState | null;
  lastWakeReason: ChatGptControlFailureCode | null;
  /** Server-derived MCP identity; omit from ordinary admin/UI views. */
  boundGrantId: string | null;
  statusObservedGrantId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatGptControlVerificationEvidence {
  observedConversationUrl: string;
  observedAccountLabel: string;
  observedAccountId?: string;
  observedConnectorLabel: string;
  connectorIdentityObserved?: string;
  observedTools: string[];
  writeApprovalObserved: boolean;
  /** Counter captured before a bounded gateway_status diagnostic. */
  statusProbeSequenceBefore: number;
  /** Counter observed after that diagnostic, checked against the store. */
  statusProbeSequenceAfter: number;
  observedWorkerId: string;
}

export type ChatGptControlWakeState =
  | 'wake_requested' | 'controller_accepted' | 'target_verified' | 'wake_delivery_attempted'
  | 'wake_delivered_observed' | 'mcp_poll_observed' | 'wake_failed' | 'wake_expired'
  | 'operator_action_required' | 'cancelled';

export interface ChatGptControlWakeOperation {
  id: string;
  workerId: string;
  bindingVersion: number;
  activationGeneration: number;
  operatorStopGeneration: number;
  marker: string;
  state: ChatGptControlWakeState;
  attempts: number;
  maxAttempts: number;
  createdAtMs: number;
  deadlineAtMs: number;
  nextAttemptAtMs: number;
  lastReason: ChatGptControlFailureCode | null;
  deliveryAttemptedAtMs?: number | null;
  deliveredObservedAtMs?: number | null;
  pollingObservedAtMs?: number | null;
  /** Private immutable target snapshot; never a job snapshot. */
  binding: ChatGptControlBinding;
}

export interface ChatGptControlStoreConfig {
  enabled: boolean;
  maxConcurrentWakes?: number;
  maxAttempts?: number;
  backoffMs?: number;
  wakeTimeoutMs?: number;
}

export function canonicalPersonalChatUrl(value: unknown): { url: string; id: string } {
  if (typeof value !== 'string' || value.length > 512 || value !== value.trim()) throw new Error('Invalid personal ChatGPT conversation URL.');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Invalid personal ChatGPT conversation URL.'); }
  // Reject an explicit port (including :443), credentials, noncanonical hosts,
  // query parameters and percent-encoded path tricks before normalization.
  const match = /^https:\/\/chatgpt\.com\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:#[^\r\n]*)?$/iu.exec(value);
  if (!match || parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com'
    || parsed.username || parsed.password || parsed.port || parsed.search) throw new Error('Use an exact https://chatgpt.com/c/<conversation-id> personal chat URL.');
  const id = match[1]!.toLowerCase();
  return { url: `https://chatgpt.com/c/${id}`, id };
}

export function publicControlBinding(binding: ChatGptControlBinding) {
  const { boundGrantId: _bound, statusObservedGrantId: _observed, ...publicBinding } = binding;
  return publicBinding;
}
