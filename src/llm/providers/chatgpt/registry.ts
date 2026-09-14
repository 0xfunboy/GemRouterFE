import { normalizeChatGptAlias, normalizeWorkerId } from './protocol.js';
import { ChatGptGatewayStore, type WorkerMutationInput } from './store.js';
import type { ChatGptGatewayConfig, ChatGptWorkerConfig } from './types.js';

export class ChatGptWorkerRegistry {
  constructor(
    private readonly store: ChatGptGatewayStore,
    private readonly config: ChatGptGatewayConfig,
    private readonly reservedModelIds: () => ReadonlySet<string>,
    private readonly onAliasesChanged?: (aliases: string[]) => void,
  ) {}

  list(): ChatGptWorkerConfig[] {
    return this.store.listWorkers();
  }

  aliases(): string[] {
    return this.list().flatMap((worker) => worker.publicModelIds);
  }

  get(id: string): ChatGptWorkerConfig | null {
    try { return this.store.getWorker(normalizeWorkerId(id)); } catch { return null; }
  }

  resolveAlias(value: string): ChatGptWorkerConfig | null {
    let alias: string;
    try {
      alias = normalizeChatGptAlias(value).replace(/^chatgpt\//u, '');
    } catch {
      return null;
    }
    return this.store.findWorkerByAlias(alias);
  }

  recognizes(value: string): boolean {
    const normalized = String(value ?? '').trim().toLowerCase().replace(/^models\//u, '');
    return normalized.startsWith('chatgpt/') || this.resolveAlias(normalized) !== null;
  }

  create(value: unknown): ChatGptWorkerConfig {
    const input = this.validate(value, false);
    if (this.store.getWorker(input.id)) throw new Error('worker id already exists');
    const worker = this.store.createWorker(input);
    this.notify();
    return worker;
  }

  update(id: string, value: unknown): ChatGptWorkerConfig {
    validateMutationFields(value);
    const normalizedId = normalizeWorkerId(id);
    const current = this.store.getWorker(normalizedId);
    if (!current) throw new Error('worker not found');
    const input = this.validate({ ...current, ...(isRecord(value) ? value : {}), id: normalizedId }, true);
    const worker = this.store.updateWorker(normalizedId, input);
    this.notify();
    return worker;
  }

  remove(id: string): void {
    this.store.deleteWorker(normalizeWorkerId(id));
    this.notify();
  }

  private validate(value: unknown, updating: boolean): WorkerMutationInput {
    if (!isRecord(value)) throw new Error('worker configuration must be an object');
    if (!updating) validateMutationFields(value);
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled must be boolean');
    const id = normalizeWorkerId(value.id);
    const label = boundedText(value.label, 'label', 120);
    const declaredModel = boundedText(value.declaredModel, 'declaredModel', 160);
    const rawAliases = Array.isArray(value.publicModelIds) ? value.publicModelIds.map(normalizeChatGptAlias) : [];
    const publicModelIds = unique(rawAliases);
    if (publicModelIds.length !== rawAliases.length) throw new Error('publicModelIds must not contain duplicate aliases');
    if (publicModelIds.length < 1 || publicModelIds.length > 16) throw new Error('publicModelIds must contain 1-16 aliases');
    const existing = this.store.listWorkers();
    const reserved = this.reservedModelIds();
    for (const alias of publicModelIds) {
      if (alias.startsWith('chatgpt/')) throw new Error('Store aliases without the reserved chatgpt/ namespace prefix');
      if (reserved.has(alias)) throw new Error(`alias collides with another provider model: ${alias}`);
      const owner = existing.find((worker) => worker.id !== id && worker.publicModelIds.includes(alias));
      if (owner) throw new Error(`alias already belongs to worker ${owner.id}: ${alias}`);
    }
    if (!Array.isArray(value.allowedAppIds) || value.allowedAppIds.length > 128) throw new Error('allowedAppIds must be an array with at most 128 entries');
    const allowedAppIds = unique(value.allowedAppIds.map((item) => boundedId(item, 'allowedAppIds')));
    if (allowedAppIds.length !== value.allowedAppIds.length) throw new Error('allowedAppIds must not contain duplicates');
    const timeoutMs = boundedInteger(value.timeoutMs, this.config.timeoutMs, 1_000, 30 * 60_000, 'timeoutMs');
    const queueTimeoutMs = boundedInteger(value.queueTimeoutMs, this.config.queueTimeoutMs, 100, timeoutMs, 'queueTimeoutMs');
    return {
      id,
      label,
      enabled: updating ? value.enabled === true : false,
      publicModelIds,
      allowedAppIds,
      domainLabel: optionalText(value.domainLabel, 'domainLabel', 120),
      declaredModel,
      declaredReasoning: optionalText(value.declaredReasoning, 'declaredReasoning', 120),
      contextEpoch: boundedInteger(value.contextEpoch, 1, 1, Number.MAX_SAFE_INTEGER, 'contextEpoch'),
      instructionVersion: boundedInteger(value.instructionVersion, 1, 1, Number.MAX_SAFE_INTEGER, 'instructionVersion'),
      timeoutMs,
      queueTimeoutMs,
      maxQueuedRequests: boundedInteger(value.maxQueuedRequests, this.config.maxQueuePerWorker, 1, 64, 'maxQueuedRequests'),
    };
  }

  private notify(): void {
    this.onAliasesChanged?.(this.aliases());
  }
}

function boundedText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value.trim(), 'utf8') > maxBytes) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function optionalText(value: unknown, name: string, maxBytes: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return boundedText(value, name, maxBytes);
}

function boundedId(value: unknown, name: string): string {
  const selected = boundedText(value, name, 128);
  if (!/^[A-Za-z0-9._:-]+$/u.test(selected)) throw new Error(`${name} contains invalid characters`);
  return selected;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value !== undefined && typeof value !== 'number') throw new Error(`${name} must be a number`);
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw new Error(`${name} is out of range`);
  return selected;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateMutationFields(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error('worker configuration must be an object');
  const allowed = new Set(['id', 'label', 'enabled', 'publicModelIds', 'allowedAppIds', 'domainLabel', 'declaredModel',
    'declaredReasoning', 'contextEpoch', 'instructionVersion', 'timeoutMs', 'queueTimeoutMs', 'maxQueuedRequests']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('worker configuration contains unsupported fields');
}
