import { rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import type { GeminiConfig, GeminiProviderConfig } from "./types.js";
import { ConversationStore, type StoredSession } from "./conversationStore.js";

const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
`;

async function sanitizeProfileLocks(profilePath: string): Promise<void> {
  const candidates = [
    path.join(profilePath, "SingletonLock"),
    path.join(profilePath, "SingletonCookie"),
    path.join(profilePath, "SingletonSocket"),
    path.join(profilePath, "Default", "LOCK"),
  ];
  await Promise.all(
    candidates.map(async (file) => {
      try {
        await rm(file, { force: true });
      } catch {
        // best effort
      }
    }),
  );
}

interface SessionLifecycleState {
  createdAt: number;
  lastRequestedAt: number;
  lastRespondedAt: number | null;
  pendingRequests: number;
}

export class GeminiSessionManager {
  private context: BrowserContext | null = null;
  private pendingLaunch: Promise<BrowserContext> | null = null;
  /** One Page per session key. */
  private pages: Map<string, Page> = new Map();
  /** Tracks last activity time per session key for idle eviction. */
  private lastActivity: Map<string, number> = new Map();
  /** Tracks whether a tab already produced a response and whether it is still busy. */
  private lifecycle: Map<string, SessionLifecycleState> = new Map();
  /** Persistent mapping: sessionKey → conversationId / URL. */
  private store: ConversationStore;
  /**
   * Per-session mutex: maps sessionKey → the tail of the promise chain.
   * Guarantees that only one request runs at a time per session, preventing
   * interleaved keyboard/DOM operations on the same page.
   */
  private locks: Map<string, Promise<void>> = new Map();
  /** Eviction interval handle. */
  private evictionTimer: NodeJS.Timeout | null = null;
  /** Idle timeout in ms. 0 = no eviction. */
  private readonly idleTimeoutMs: number;
  /** Max inactivity before a stored conversation mapping is discarded. 0 = no expiry. */
  private readonly conversationTtlMs: number;
  /** Max concurrent tabs. 0 = unlimited. */
  private readonly maxTabs: number;
  /** Responded tabs can be closed sooner than the generic idle timeout. 0 = disabled. */
  private readonly respondedSessionTtlMs: number;
  /** Tabs that never answered can be reaped separately after they go orphan/stale. 0 = disabled. */
  private readonly orphanSessionTtlMs: number;
  private lastLaunchError: string | null = null;
  private lastLaunchAt: string | null = null;
  private lastLaunchOkAt: string | null = null;

  constructor(
    private readonly config: GeminiConfig,
    idleTimeoutMs = 0,
    conversationTtlMs = 0,
    maxTabs = 0,
    respondedSessionTtlMs = 0,
    orphanSessionTtlMs = 0,
  ) {
    const storeDir = path.join(
      config.baseProfileDir,
      config.profileNamespace,
    );
    this.store = new ConversationStore(storeDir);
    this.idleTimeoutMs = idleTimeoutMs;
    this.conversationTtlMs = conversationTtlMs;
    this.maxTabs = maxTabs;
    this.respondedSessionTtlMs = respondedSessionTtlMs;
    this.orphanSessionTtlMs = orphanSessionTtlMs;
    this.pruneExpiredStoredSessions();

    // Start eviction sweep every 60s whenever any cleanup policy is configured.
    if (
      this.idleTimeoutMs > 0 ||
      this.conversationTtlMs > 0 ||
      this.respondedSessionTtlMs > 0 ||
      this.orphanSessionTtlMs > 0
    ) {
      this.evictionTimer = setInterval(() => this.evictIdleSessions(), 60_000);
      this.evictionTimer.unref();
    }
  }

  resolveProfilePath(relativeDir: string): string {
    return path.join(
      this.config.baseProfileDir,
      this.config.profileNamespace,
      relativeDir,
    );
  }

  /** Returns the live page for the session key, or null if closed/missing. */
  getPage(sessionKey: string): Page | null {
    const page = this.pages.get(sessionKey);
    if (!page || page.isClosed()) {
      this.pages.delete(sessionKey);
      return null;
    }
    return page;
  }

  /** Returns true if the browser context is alive. */
  isAlive(): boolean {
    if (!this.context) return false;
    try {
      this.context.pages();
      return true;
    } catch {
      return false;
    }
  }

  /** Number of currently open session pages. */
  sessionCount(): number {
    return this.pages.size;
  }

  storedSessionCount(): number {
    return Object.keys(this.store.all()).length;
  }

  markResponseCaptured(sessionKey: string): void {
    const state = this.ensureLifecycleState(sessionKey);
    const now = Date.now();
    state.lastRespondedAt = now;
    this.lastActivity.set(sessionKey, now);
    this.store.touch(sessionKey);
  }

  getDiagnostics(): Record<string, unknown> {
    const now = Date.now();
    const lifecycle = [...this.pages.keys()].map((sessionKey) => {
      const state = this.lifecycle.get(sessionKey);
      const lastActivity = this.lastActivity.get(sessionKey) ?? null;
      return {
        sessionKey,
        pendingRequests: state?.pendingRequests ?? 0,
        hasResponse: state?.lastRespondedAt !== null && state?.lastRespondedAt !== undefined,
        ageMs: state ? now - state.createdAt : null,
        idleMs: lastActivity ? now - lastActivity : null,
        sinceLastResponseMs:
          state?.lastRespondedAt !== null && state?.lastRespondedAt !== undefined
            ? now - state.lastRespondedAt
            : null,
      };
    });
    return {
      contextAlive: this.isAlive(),
      openPages: this.sessionCount(),
      storedSessions: this.storedSessionCount(),
      activeSessionKeys: [...this.pages.keys()],
      profilePath: this.resolveProfilePath("_shared"),
      idleTimeoutMs: this.idleTimeoutMs,
      conversationTtlMs: this.conversationTtlMs,
      maxTabs: this.maxTabs,
      respondedSessionTtlMs: this.respondedSessionTtlMs,
      orphanSessionTtlMs: this.orphanSessionTtlMs,
      respondedOpenTabs: lifecycle.filter((entry) => entry.hasResponse).length,
      unresolvedOpenTabs: lifecycle.filter((entry) => !entry.hasResponse).length,
      busyOpenTabs: lifecycle.filter((entry) => entry.pendingRequests > 0).length,
      lifecycle,
      lastLaunchAt: this.lastLaunchAt,
      lastLaunchOkAt: this.lastLaunchOkAt,
      lastLaunchError: this.lastLaunchError,
    };
  }

  /**
   * Acquires a per-session lock and runs `fn`. If another call is already
   * running for the same sessionKey, this call waits in a queue.
   * Ensures serial execution per Gemini tab regardless of async concurrency.
   */
  async acquireLock(sessionKey: string): Promise<() => void> {
    const prev = this.locks.get(sessionKey) ?? Promise.resolve();
    let releaseLock!: () => void;
    const next = new Promise<void>((res) => { releaseLock = res; });
    this.locks.set(sessionKey, prev.then(() => next));

    const state = this.ensureLifecycleState(sessionKey);
    state.pendingRequests += 1;
    state.lastRequestedAt = Date.now();

    await prev; // wait for any prior request on this session to finish
    // Touch activity timestamp — this session is actively being used
    this.lastActivity.set(sessionKey, Date.now());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const currentState = this.ensureLifecycleState(sessionKey);
      currentState.pendingRequests = Math.max(0, currentState.pendingRequests - 1);
      this.lastActivity.set(sessionKey, Date.now());
      this.store.touch(sessionKey);
      releaseLock();
      if (this.locks.get(sessionKey) === next) this.locks.delete(sessionKey);
    };
  }

  async withLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock(sessionKey);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Returns the stored conversation info for a session key (if any). */
  getStoredSession(sessionKey: string): StoredSession | undefined {
    return this.store.get(sessionKey);
  }

  /**
   * Returns the live page for the session key if it exists, otherwise creates
   * a new browser tab and navigates it to the right place:
   *   - If a conversation was previously stored → navigate to that URL
   *   - Otherwise → navigate to baseUrl to start a fresh conversation
   *
   * After the first message Gemini changes the URL to include the conversation
   * ID. We track that change and persist it automatically.
   */
  async getOrCreate(provider: GeminiProviderConfig, sessionKey: string, label?: string): Promise<Page> {
    const existing = this.getPage(sessionKey);
    if (existing) {
      this.lastActivity.set(sessionKey, Date.now());
      return existing;
    }

    const context = await this.ensureContext();
    const page = await context.newPage();

    this.pages.set(sessionKey, page);
    this.ensureLifecycleState(sessionKey);
    page.on("close", () => this.dropSessionTracking(sessionKey));

    // Start URL tracking so we capture the conversation ID after first message
    this.trackConversationUrl(page, sessionKey, label ?? sessionKey, provider.baseUrl);

    let stored = this.store.get(sessionKey);
    if (stored && this.isStoredSessionExpired(stored)) {
      console.log(`[Session] Expiring stale conversation for ${sessionKey} (TTL reached).`);
      this.store.delete(sessionKey);
      stored = undefined;
    }
    const duplicateOwner = stored
      ? this.store.findSessionKeyByConversationId(stored.conversationId, sessionKey)
      : undefined;

    if (stored && !duplicateOwner) {
      console.log(`[Session] Restoring ${sessionKey} → ${stored.conversationUrl}`);
      await page.goto(stored.conversationUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } else {
      if (stored && duplicateOwner) {
        console.warn(
          `[Session] Duplicate conversation detected for ${sessionKey} and ${duplicateOwner}; starting a fresh conversation.`,
        );
        this.store.delete(sessionKey);
      }
      console.log(`[Session] New session for ${sessionKey}`);
      await page.goto(provider.baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.ensureFreshConversation(page, provider, sessionKey);
    }

    return page;
  }

  async prewarm(provider: GeminiProviderConfig, sessions: Array<{ sessionKey: string; label?: string }>): Promise<void> {
    const unique = sessions.filter(
      (session, index, arr) =>
        session.sessionKey.trim().length > 0 &&
        arr.findIndex((candidate) => candidate.sessionKey === session.sessionKey) === index,
    );
    if (unique.length === 0) return;

    await Promise.all(
      unique.map(async (session) => {
        try {
          await this.withLock(session.sessionKey, async () => {
            const page = await this.getOrCreate(provider, session.sessionKey, session.label);
            await page.bringToFront().catch(() => undefined);
            this.lastActivity.set(session.sessionKey, Date.now());
          });
        } catch (error) {
          console.warn(`[Session] Prewarm failed for ${session.sessionKey}:`, error);
        }
      }),
    );
  }

  /**
   * Clears a session: navigates its page to a fresh Gemini conversation and
   * removes the stored conversation ID so a new one will be captured.
   */
  async clearSession(provider: GeminiProviderConfig, sessionKey: string): Promise<void> {
    this.store.delete(sessionKey);
    const page = this.getPage(sessionKey);
    if (page) {
      await page.goto(provider.baseUrl, { waitUntil: "domcontentloaded" });
      await this.ensureFreshConversation(page, provider, sessionKey);
    }
  }

  async recreateSession(provider: GeminiProviderConfig, sessionKey: string): Promise<void> {
    this.store.delete(sessionKey);
    const page = this.getPage(sessionKey);
    if (page && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }
    this.dropSessionTracking(sessionKey);

    await this.getOrCreate(provider, sessionKey, sessionKey).catch(() => undefined);
  }

  /** Opens a temporary page for login verification. Caller should close it when done. */
  async openForLogin(provider: GeminiProviderConfig): Promise<Page> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    await page.goto(provider.baseUrl, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    return page;
  }

  /**
   * Evicts idle session tabs. Closes pages that haven't been used for longer
   * than idleTimeoutMs. The conversation mapping in sessions.json is preserved,
   * so the session will be restored seamlessly on the next request.
   * Also enforces maxTabs by evicting least-recently-used sessions.
   */
  private evictIdleSessions(): void {
    const now = Date.now();

    // 1. Recycle tabs that already produced a response and are safe to reopen later.
    if (this.respondedSessionTtlMs > 0) {
      for (const [sessionKey, state] of this.lifecycle) {
        if (state.pendingRequests > 0 || state.lastRespondedAt === null) continue;
        if (now - state.lastRespondedAt > this.respondedSessionTtlMs) {
          this.closeSessionPage(
            sessionKey,
            `responded ${Math.round((now - state.lastRespondedAt) / 1000)}s ago`,
          );
        }
      }
    }

    // 2. Reap stale tabs that never produced a response.
    if (this.orphanSessionTtlMs > 0) {
      for (const [sessionKey, state] of this.lifecycle) {
        if (state.pendingRequests > 0 || state.lastRespondedAt !== null) continue;
        if (now - state.lastRequestedAt > this.orphanSessionTtlMs) {
          this.closeSessionPage(
            sessionKey,
            `orphaned after ${Math.round((now - state.lastRequestedAt) / 1000)}s without a response`,
          );
        }
      }
    }

    // 3. Evict sessions idle beyond timeout
    if (this.idleTimeoutMs > 0) {
      for (const [sessionKey, lastTs] of this.lastActivity) {
        const state = this.lifecycle.get(sessionKey);
        if ((state?.pendingRequests ?? 0) > 0) continue;
        if (now - lastTs > this.idleTimeoutMs) {
          this.closeSessionPage(sessionKey, `idle ${Math.round((now - lastTs) / 1000)}s`);
        }
      }
    }

    // 4. Enforce max tabs by evicting LRU sessions
    if (this.maxTabs > 0 && this.pages.size > this.maxTabs) {
      const sorted = [...this.lastActivity.entries()]
        .filter(([key]) => this.pages.has(key) && (this.lifecycle.get(key)?.pendingRequests ?? 0) === 0)
        .sort((a, b) => a[1] - b[1]); // oldest first

      const toEvict = sorted.slice(0, this.pages.size - this.maxTabs);
      for (const [sessionKey] of toEvict) {
        this.closeSessionPage(sessionKey, `LRU tab (max tabs ${this.maxTabs})`);
      }
    }

    this.pruneExpiredStoredSessions(now);
  }

  async close(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const page of this.pages.values()) {
      await page.close().catch(() => undefined);
    }
    this.pages.clear();
    this.lastActivity.clear();
    this.lifecycle.clear();
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Listens for URL changes on the page. When Gemini navigates from the base
   * URL to a conversation URL (after the first message), we extract the
   * conversation ID and persist it.
   */
  private trackConversationUrl(
    page: Page,
    sessionKey: string,
    label: string,
    baseUrl: string,
  ): void {
    const handler = (frame: import("playwright").Frame): void => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      // Match: https://gemini.google.com/app/{conversationId}
      const match = url.match(/\/app\/([a-f0-9]{8,})/i);
      if (!match) return;
      const conversationId = match[1];
      const duplicateOwner = this.store.findSessionKeyByConversationId(conversationId, sessionKey);
      if (duplicateOwner) {
        console.warn(
          `[Session] Ignoring conversation ${conversationId} for ${sessionKey}; already owned by ${duplicateOwner}.`,
        );
        return;
      }
      const existing = this.store.get(sessionKey);
      if (existing?.conversationId === conversationId) return; // already stored
      const session: StoredSession = {
        conversationId,
        conversationUrl: url,
        label,
        updatedAt: new Date().toISOString(),
      };
      this.store.set(sessionKey, session);
      console.log(`[Session] Stored conversation for ${sessionKey}: ${conversationId}`);
    };

    page.on("framenavigated", handler);
    page.on("close", () => page.off("framenavigated", handler));
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) {
      try {
        this.context.pages();
        return this.context;
      } catch {
        this.context = null;
      }
    }

    if (this.pendingLaunch) return this.pendingLaunch;

    this.pendingLaunch = this.doLaunch();
    try {
      return await this.pendingLaunch;
    } finally {
      this.pendingLaunch = null;
    }
  }

  private async doLaunch(): Promise<BrowserContext> {
    this.lastLaunchAt = new Date().toISOString();
    const profilePath = this.resolveProfilePath("_shared");
    await mkdir(profilePath, { recursive: true });
    await sanitizeProfileLocks(profilePath);
    try {
      const context = await chromium.launchPersistentContext(profilePath, {
        channel: this.config.browserExecutablePath ? undefined : this.config.browserChannel,
        executablePath: this.config.browserExecutablePath,
        headless: this.config.headless,
        viewport: { width: 1440, height: 960 },
        locale: "en-US",
        colorScheme: "dark",
        acceptDownloads: true,
        args: [
          "--window-size=1440,960",
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });

      await context.addInitScript(STEALTH_INIT_SCRIPT);

      context.on("close", () => {
        this.context = null;
        this.pages.clear();
        this.lastActivity.clear();
        this.lifecycle.clear();
      });

      this.lastLaunchError = null;
      this.lastLaunchOkAt = new Date().toISOString();
      this.context = context;
      return context;
    } catch (error) {
      this.lastLaunchError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async ensureFreshConversation(
    page: Page,
    provider: GeminiProviderConfig,
    sessionKey: string,
  ): Promise<void> {
    const currentConversationId = this.extractConversationId(page.url());
    if (!currentConversationId) return;

    const owner = this.store.findSessionKeyByConversationId(currentConversationId, sessionKey);
    console.warn(
      owner
        ? `[Session] ${sessionKey} landed on ${owner}'s conversation ${currentConversationId}; forcing new chat.`
        : `[Session] ${sessionKey} landed on an existing conversation ${currentConversationId}; forcing new chat.`,
    );

    await this.startNewConversation(page, provider);
  }

  private async startNewConversation(page: Page, provider: GeminiProviderConfig): Promise<void> {
    const currentUrl = page.url();
    const controls = [
      page.locator('button[aria-label*="New chat"]').first(),
      page.locator('a[aria-label*="New chat"]').first(),
      page.locator('button[mattooltip*="New chat"]').first(),
      page.locator('button').filter({ hasText: /new chat|new conversation/i }).first(),
      page.locator('[role="button"]').filter({ hasText: /new chat|new conversation/i }).first(),
      page.locator('button:has(mat-icon[fonticon="add"])').first(),
    ];

    for (const control of controls) {
      if (!(await control.isVisible({ timeout: 1_500 }).catch(() => false))) continue;
      await control.click({ force: true }).catch(() => undefined);

      const changed = await page.waitForURL(
        (url: URL) => {
          const value = String(url);
          return value !== currentUrl || !/\/app\/[a-f0-9]{8,}/i.test(value);
        },
        { timeout: 5_000 },
      ).then(() => true).catch(() => false);
      if (changed) return;

      // Some Gemini layouts clear the page without changing the URL immediately.
      const inputReady = await page.locator(provider.inputSelector).first().isVisible({ timeout: 2_000 }).catch(() => false);
      if (inputReady) return;
    }

    throw new Error("Impossibile creare una nuova conversazione Gemini isolata.");
  }

  private extractConversationId(url: string): string | null {
    const match = url.match(/\/app\/([a-f0-9]{8,})/i);
    return match?.[1] ?? null;
  }

  private isStoredSessionExpired(session: StoredSession, now = Date.now()): boolean {
    if (this.conversationTtlMs <= 0) return false;
    const updatedAtMs = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return false;
    return now - updatedAtMs > this.conversationTtlMs;
  }

  private pruneExpiredStoredSessions(now = Date.now()): void {
    if (this.conversationTtlMs <= 0) return;
    for (const [sessionKey, session] of Object.entries(this.store.all())) {
      if (!this.isStoredSessionExpired(session, now)) continue;
      console.log(`[Session] Removing expired stored conversation for ${sessionKey}.`);
      this.store.delete(sessionKey);
    }
  }

  private ensureLifecycleState(sessionKey: string): SessionLifecycleState {
    const existing = this.lifecycle.get(sessionKey);
    if (existing) return existing;

    const now = Date.now();
    const state: SessionLifecycleState = {
      createdAt: now,
      lastRequestedAt: now,
      lastRespondedAt: null,
      pendingRequests: 0,
    };
    this.lifecycle.set(sessionKey, state);
    return state;
  }

  private dropSessionTracking(sessionKey: string): void {
    this.pages.delete(sessionKey);
    this.lastActivity.delete(sessionKey);
    this.lifecycle.delete(sessionKey);
  }

  private closeSessionPage(sessionKey: string, reason: string): void {
    const page = this.pages.get(sessionKey);
    if (page && !page.isClosed()) {
      console.log(`[Session] Closing tab ${sessionKey}: ${reason}`);
      page.close().catch(() => undefined);
    }
    this.dropSessionTracking(sessionKey);
  }
}
