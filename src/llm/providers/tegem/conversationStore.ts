import { readFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredSession {
  conversationId: string;
  conversationUrl: string;
  label: string;
  updatedAt: string;
}

/**
 * Persistent store that maps session keys (e.g. "user_123", "group_-100456")
 * to their Gemini conversation IDs, so conversations survive bot restarts.
 *
 * Stored as a JSON file on disk next to the browser profile.
 * Load is sync (only at startup), save is async (non-blocking).
 */
export class ConversationStore {
  private data: Record<string, StoredSession> = {};
  private filePath: string;
  /** Serializes save operations so writes don't interleave. */
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, "sessions.json");
    mkdirSync(baseDir, { recursive: true });
    this.load();
  }

  get(sessionKey: string): StoredSession | undefined {
    return this.data[sessionKey];
  }

  findSessionKeyByConversationId(conversationId: string, excludeSessionKey?: string): string | undefined {
    for (const [sessionKey, session] of Object.entries(this.data)) {
      if (sessionKey === excludeSessionKey) continue;
      if (session.conversationId === conversationId) return sessionKey;
    }
    return undefined;
  }

  set(sessionKey: string, session: StoredSession): void {
    this.data[sessionKey] = session;
    this.save();
  }

  touch(sessionKey: string, updatedAt = new Date().toISOString()): void {
    const session = this.data[sessionKey];
    if (!session) return;
    session.updatedAt = updatedAt;
    this.save();
  }

  delete(sessionKey: string): void {
    delete this.data[sessionKey];
    this.save();
  }

  all(): Record<string, StoredSession> {
    return { ...this.data };
  }

  /** Sync load — only called once at startup. */
  private load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      this.data = JSON.parse(raw) as Record<string, StoredSession>;
    } catch {
      this.data = {};
    }
  }

  /** Async save — queued to prevent interleaved writes. */
  private save(): void {
    const json = JSON.stringify(this.data, null, 2);
    this.saveQueue = this.saveQueue
      .then(() => writeFile(this.filePath, json, "utf8"))
      .catch((err) => console.error("[ConversationStore] Failed to save sessions:", err));
  }
}
