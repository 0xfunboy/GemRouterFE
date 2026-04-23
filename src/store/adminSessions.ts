import { randomBytes } from 'node:crypto';

interface SessionRecord {
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export class AdminSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly ttlMs: number) {}

  create(): string {
    this.pruneExpired();
    const id = `adm_${randomBytes(24).toString('base64url')}`;
    const now = Date.now();
    this.sessions.set(id, {
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastSeenAt: now,
    });
    return id;
  }

  verify(id: string | undefined): boolean {
    if (!id) return false;
    const record = this.sessions.get(id);
    if (!record) return false;
    const now = Date.now();
    if (record.expiresAt <= now) {
      this.sessions.delete(id);
      return false;
    }
    record.lastSeenAt = now;
    record.expiresAt = now + this.ttlMs;
    return true;
  }

  revoke(id: string | undefined): void {
    if (!id) return;
    this.sessions.delete(id);
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.sessions) {
      if (record.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }
}
