import { randomBytes } from 'node:crypto';

interface SessionRecord {
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  username?: string;
}

export class AdminSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly ttlMs: number) {}

  create(input?: { username?: string }): string {
    this.pruneExpired();
    const id = `adm_${randomBytes(24).toString('base64url')}`;
    const now = Date.now();
    this.sessions.set(id, {
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastSeenAt: now,
      username: input?.username?.trim() || undefined,
    });
    return id;
  }

  read(id: string | undefined): SessionRecord | null {
    if (!id) return null;
    const record = this.sessions.get(id);
    if (!record) return null;
    const now = Date.now();
    if (record.expiresAt <= now) {
      this.sessions.delete(id);
      return null;
    }
    record.lastSeenAt = now;
    record.expiresAt = now + this.ttlMs;
    return record;
  }

  verify(id: string | undefined): boolean {
    return this.read(id) !== null;
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
