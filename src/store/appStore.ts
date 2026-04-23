import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ApiAppRecord {
  id: string;
  name: string;
  apiKeyHash: string;
  keyPreview: string;
  allowedOrigins: string[];
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
  allowedModels: string[];
  sessionNamespace: string;
  rateLimitPerMinute: number;
  maxConcurrency: number;
}

interface UpdateAppInput {
  name?: string;
  allowedOrigins?: string[];
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
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly rateWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  list(): ApiAppRecord[] {
    return [...this.state.apps];
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
      existing.allowedModels = uniqueStrings(input.allowedModels);
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
      allowedModels: uniqueStrings(input.allowedModels),
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
    return app.allowedModels.includes(modelId);
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

  acquireConcurrency(app: ApiAppRecord): (() => void) | null {
    if (app.maxConcurrency <= 0) return () => undefined;
    const current = this.inFlight.get(app.id) ?? 0;
    if (current >= app.maxConcurrency) return null;
    this.inFlight.set(app.id, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Math.max(0, (this.inFlight.get(app.id) ?? 1) - 1);
      if (next === 0) {
        this.inFlight.delete(app.id);
      } else {
        this.inFlight.set(app.id, next);
      }
    };
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
    if (Array.isArray(input.allowedModels)) {
      current.allowedModels = uniqueStrings(input.allowedModels);
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

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      this.state = { apps: Array.isArray(parsed.apps) ? parsed.apps : [] };
    } catch {
      this.state = { apps: [] };
    }
  }

  private save(): void {
    const payload = JSON.stringify(this.state, null, 2);
    this.saveQueue = this.saveQueue
      .then(() => writeFile(this.filePath, payload, 'utf8'))
      .catch((error) => {
        console.error('[app-store] save failed:', error);
      });
  }
}
