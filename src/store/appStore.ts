import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type AppModelAccess = 'all' | 'custom';

export interface ApiAppRecord {
  id: string;
  name: string;
  apiKeyHash: string;
  keyPreview: string;
  allowedOrigins: string[];
  modelAccess: AppModelAccess;
  allowedModels: string[];
  sessionNamespace: string;
  rateLimitPerMinute: number;
  maxConcurrency: number;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

interface CreateAppInput {
  name: string;
  rawKey?: string;
  allowedOrigins: string[];
  modelAccess?: AppModelAccess;
  allowedModels: string[];
  sessionNamespace: string;
  rateLimitPerMinute: number;
  maxConcurrency: number;
}

interface UpdateAppInput {
  name?: string;
  allowedOrigins?: string[];
  modelAccess?: AppModelAccess;
  allowedModels?: string[];
  sessionNamespace?: string;
  rateLimitPerMinute?: number;
  maxConcurrency?: number;
}

interface PersistedState {
  apps: ApiAppRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedModelIds(values: string[]): string[] {
  return uniqueStrings(values.map((value) => value.toLowerCase()));
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function sanitizeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'app';
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function originMatches(pattern: string, origin: string): boolean {
  if (pattern === '*') return true;
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i');
  return regex.test(origin);
}

function maskKey(rawKey: string): string {
  if (rawKey.length <= 10) return rawKey;
  return `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`;
}

function stableCompare(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class AppStore {
  private state: PersistedState = { apps: [] };
  private modelUniverse = new Set<string>();
  private readonly rateWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly concurrency = new Map<string, {
    inFlight: number;
    waiting: Array<{
      priority: number;
      queuedAt: number;
      resolve: (release: (() => void) | null) => void;
      timer?: ReturnType<typeof setTimeout>;
    }>;
  }>();

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  list(): ApiAppRecord[] {
    return [...this.state.apps];
  }

  restrictAllowedModels(allowedModels: string[]): number {
    const normalizedAllowedModels = normalizedModelIds(allowedModels);
    const allowed = new Set(normalizedAllowedModels);
    this.modelUniverse = allowed;
    let changed = 0;
    for (const app of this.state.apps) {
      if (app.revokedAt) continue;
      const next = app.modelAccess === 'all'
        ? normalizedAllowedModels
        : normalizedModelIds(app.allowedModels).filter((model) => allowed.has(model));
      if (sameStrings(next, app.allowedModels)) continue;
      app.allowedModels = next;
      app.updatedAt = nowIso();
      changed += 1;
    }
    if (changed > 0) this.save();
    return changed;
  }

  findById(id: string): ApiAppRecord | undefined {
    return this.state.apps.find((app) => app.id === id);
  }

  ensureBootstrapApp(input: CreateAppInput): ApiAppRecord {
    const apiKeyHash = hashApiKey(input.rawKey ?? '');
    const existing = this.state.apps.find((app) => stableCompare(app.apiKeyHash, apiKeyHash));
    if (existing) {
      existing.name = input.name;
      existing.allowedOrigins = uniqueStrings(input.allowedOrigins);
      existing.modelAccess = input.modelAccess === 'all' ? 'all' : 'custom';
      existing.allowedModels = normalizedModelIds(input.allowedModels);
      existing.sessionNamespace = sanitizeSegment(input.sessionNamespace);
      existing.rateLimitPerMinute = Math.max(0, input.rateLimitPerMinute);
      existing.maxConcurrency = Math.max(0, input.maxConcurrency);
      existing.updatedAt = nowIso();
      this.save();
      return existing;
    }
    return this.create(input).record;
  }

  create(input: CreateAppInput): { record: ApiAppRecord; rawKey: string } {
    const rawKey = input.rawKey?.trim() || `barb_${randomBytes(24).toString('base64url')}`;
    const timestamp = nowIso();
    const record: ApiAppRecord = {
      id: `app_${randomBytes(8).toString('hex')}`,
      name: input.name.trim() || 'unnamed-app',
      apiKeyHash: hashApiKey(rawKey),
      keyPreview: maskKey(rawKey),
      allowedOrigins: uniqueStrings(input.allowedOrigins),
      modelAccess: input.modelAccess === 'all' ? 'all' : 'custom',
      allowedModels: normalizedModelIds(input.allowedModels),
      sessionNamespace: sanitizeSegment(input.sessionNamespace),
      rateLimitPerMinute: Math.max(0, input.rateLimitPerMinute),
      maxConcurrency: Math.max(0, input.maxConcurrency),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.apps.push(record);
    this.save();
    return { record, rawKey };
  }

  rotate(id: string): { record: ApiAppRecord; rawKey: string } | null {
    const current = this.findById(id);
    if (!current || current.revokedAt) return null;
    const rawKey = `barb_${randomBytes(24).toString('base64url')}`;
    current.apiKeyHash = hashApiKey(rawKey);
    current.keyPreview = maskKey(rawKey);
    current.updatedAt = nowIso();
    this.save();
    return { record: current, rawKey };
  }

  revoke(id: string): ApiAppRecord | null {
    const current = this.findById(id);
    if (!current || current.revokedAt) return null;
    current.revokedAt = nowIso();
    current.updatedAt = current.revokedAt;
    this.save();
    this.clearRuntimeState(current.id);
    return current;
  }

  reactivate(id: string): { record: ApiAppRecord; rawKey: string } | null {
    const current = this.findById(id);
    if (!current?.revokedAt) return null;
    const rawKey = `barb_${randomBytes(24).toString('base64url')}`;
    current.apiKeyHash = hashApiKey(rawKey);
    current.keyPreview = maskKey(rawKey);
    current.allowedModels = current.modelAccess === 'all'
      ? [...this.modelUniverse]
      : normalizedModelIds(current.allowedModels).filter((model) => this.modelUniverse.has(model));
    delete current.revokedAt;
    current.updatedAt = nowIso();
    this.save();
    this.clearRuntimeState(current.id);
    return { record: current, rawKey };
  }

  removeRevoked(id: string): ApiAppRecord | null {
    const index = this.state.apps.findIndex((app) => app.id === id);
    const current = index >= 0 ? this.state.apps[index] : undefined;
    if (!current?.revokedAt) return null;
    this.state.apps.splice(index, 1);
    this.save();
    this.clearRuntimeState(current.id);
    return current;
  }

  verify(rawKey: string): ApiAppRecord | null {
    if (!rawKey.trim()) return null;
    const hashed = hashApiKey(rawKey.trim());
    for (const app of this.state.apps) {
      if (app.revokedAt) continue;
      if (stableCompare(app.apiKeyHash, hashed)) return app;
    }
    return null;
  }

  isOriginAllowedForApp(app: ApiAppRecord, origin?: string | null): boolean {
    if (!origin) return true;
    if (app.allowedOrigins.length === 0) return false;
    return app.allowedOrigins.some((pattern) => originMatches(pattern, origin));
  }

  isOriginAllowedGlobally(origin?: string | null): boolean {
    if (!origin) return true;
    return this.state.apps
      .filter((app) => !app.revokedAt)
      .some((app) => app.allowedOrigins.some((pattern) => originMatches(pattern, origin)));
  }

  isModelAllowed(app: ApiAppRecord, modelId: string): boolean {
    const normalized = modelId.trim().toLowerCase();
    if (!normalized) return false;
    if (app.modelAccess === 'all') return this.modelUniverse.has(normalized);
    return app.allowedModels.includes(normalized);
  }

  consumeRateLimit(app: ApiAppRecord): boolean {
    if (app.rateLimitPerMinute <= 0) return true;
    const now = Date.now();
    const current = this.rateWindows.get(app.id);
    if (!current || now - current.startedAt >= 60_000) {
      this.rateWindows.set(app.id, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= app.rateLimitPerMinute) return false;
    current.count += 1;
    return true;
  }

  async acquireConcurrency(
    app: ApiAppRecord,
    priority: number,
    waitMs: number,
  ): Promise<(() => void) | null> {
    if (app.maxConcurrency <= 0) return () => undefined;
    const state = this.concurrencyState(app.id);
    if (state.waiting.length === 0 && state.inFlight < app.maxConcurrency) {
      return this.grantConcurrency(app);
    }
    if (waitMs <= 0) return null;
    return new Promise((resolve) => {
      const entry: typeof state.waiting[number] = {
        priority,
        queuedAt: Date.now(),
        resolve,
      };
      entry.timer = setTimeout(() => {
        const index = state.waiting.indexOf(entry);
        if (index < 0) return;
        state.waiting.splice(index, 1);
        entry.resolve(null);
      }, waitMs);
      state.waiting.push(entry);
      this.dispatchConcurrency(app);
    });
  }

  private concurrencyState(appId: string): { inFlight: number; waiting: Array<{
    priority: number;
    queuedAt: number;
    resolve: (release: (() => void) | null) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> } {
    const current = this.concurrency.get(appId);
    if (current) return current;
    const created = { inFlight: 0, waiting: [] as Array<{
      priority: number;
      queuedAt: number;
      resolve: (release: (() => void) | null) => void;
      timer?: ReturnType<typeof setTimeout>;
    }> };
    this.concurrency.set(appId, created);
    return created;
  }

  private grantConcurrency(app: ApiAppRecord): () => void {
    const state = this.concurrencyState(app.id);
    state.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
      this.dispatchConcurrency(app);
    };
  }

  private dispatchConcurrency(app: ApiAppRecord): void {
    const state = this.concurrencyState(app.id);
    while (state.inFlight < app.maxConcurrency && state.waiting.length > 0) {
      state.waiting.sort((left, right) => right.priority - left.priority || left.queuedAt - right.queuedAt);
      const next = state.waiting.shift();
      if (!next) return;
      if (next.timer) clearTimeout(next.timer);
      next.resolve(this.grantConcurrency(app));
    }
  }

  update(id: string, input: UpdateAppInput): ApiAppRecord | null {
    const current = this.findById(id);
    if (!current || current.revokedAt) return null;
    if (typeof input.name === 'string' && input.name.trim()) {
      current.name = input.name.trim();
    }
    if (Array.isArray(input.allowedOrigins)) {
      current.allowedOrigins = uniqueStrings(input.allowedOrigins);
    }
    if (input.modelAccess === 'all' || input.modelAccess === 'custom') {
      current.modelAccess = input.modelAccess;
    }
    if (Array.isArray(input.allowedModels)) {
      current.allowedModels = normalizedModelIds(input.allowedModels);
    }
    if (typeof input.sessionNamespace === 'string' && input.sessionNamespace.trim()) {
      current.sessionNamespace = sanitizeSegment(input.sessionNamespace);
    }
    if (typeof input.rateLimitPerMinute === 'number' && Number.isFinite(input.rateLimitPerMinute)) {
      current.rateLimitPerMinute = Math.max(0, input.rateLimitPerMinute);
    }
    if (typeof input.maxConcurrency === 'number' && Number.isFinite(input.maxConcurrency)) {
      current.maxConcurrency = Math.max(0, input.maxConcurrency);
    }
    current.updatedAt = nowIso();
    this.save();
    return current;
  }

  private clearRuntimeState(appId: string): void {
    this.rateWindows.delete(appId);
    const concurrency = this.concurrency.get(appId);
    if (!concurrency) return;
    this.concurrency.delete(appId);
    for (const waiting of concurrency.waiting.splice(0)) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.resolve(null);
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      this.state = {
        apps: Array.isArray(parsed.apps)
          ? parsed.apps.map((app) => ({
            ...app,
            modelAccess: app.modelAccess === 'all' ? 'all' : 'custom',
            allowedOrigins: uniqueStrings(Array.isArray(app.allowedOrigins) ? app.allowedOrigins : []),
            allowedModels: normalizedModelIds(Array.isArray(app.allowedModels) ? app.allowedModels : []),
          }))
          : [],
      };
    } catch {
      this.state = { apps: [] };
    }
  }

  private save(): void {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created.
      }
      throw error;
    }
  }
}
