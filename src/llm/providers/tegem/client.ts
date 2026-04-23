import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { LLMClient, LLMMessage, LLMOptions, LLMResponse } from '../../types.js';
import { GeminiProvider } from './provider.js';
import { GeminiSessionManager } from './session.js';
import type { GeminiConfig, GeminiProviderConfig } from './types.js';

export interface TeGemProviderConfig {
  baseUrl: string;
  headless: boolean;
  browserChannel?: string;
  browserExecutablePath?: string;
  baseProfileDir: string;
  profileNamespace: string;
  sessionIdleTimeoutMs: number;
  conversationTtlMs: number;
  maxSessionTabs: number;
  streamPollIntervalMs: number;
  streamStableTicks: number;
  streamFirstChunkTimeoutMs: number;
  streamMaxDurationMs: number;
  legacyProfileImportPath?: string;
}

interface TeGemRuntime {
  sessionManager: GeminiSessionManager;
  provider: GeminiProvider;
}

const runtimes = new Map<string, TeGemRuntime>();

function runtimeKey(config: TeGemProviderConfig): string {
  return JSON.stringify({
    baseUrl: config.baseUrl,
    headless: config.headless,
    browserChannel: config.browserChannel,
    browserExecutablePath: config.browserExecutablePath,
    baseProfileDir: path.resolve(config.baseProfileDir),
    profileNamespace: config.profileNamespace,
  });
}

function sanitizeProfileLocks(profilePath: string): void {
  const candidates = [
    path.join(profilePath, '_shared', 'SingletonLock'),
    path.join(profilePath, '_shared', 'SingletonCookie'),
    path.join(profilePath, '_shared', 'SingletonSocket'),
    path.join(profilePath, '_shared', 'Default', 'LOCK'),
  ];
  for (const file of candidates) {
    try {
      rmSync(file, { force: true });
    } catch {
      // best effort
    }
  }
}

function seedLegacyProfile(config: TeGemProviderConfig): void {
  if (!config.legacyProfileImportPath?.trim()) return;

  const profileRoot = path.resolve(config.baseProfileDir);
  const profilePath = path.join(profileRoot, config.profileNamespace);
  const cookiesPath = path.join(profilePath, '_shared', 'Default', 'Cookies');
  const sessionsPath = path.join(profilePath, 'sessions.json');
  if (existsSync(cookiesPath) || existsSync(sessionsPath)) return;

  const importRoot = path.resolve(config.legacyProfileImportPath);
  const sourcePath = existsSync(path.join(importRoot, config.profileNamespace))
    ? path.join(importRoot, config.profileNamespace)
    : importRoot;
  if (!existsSync(sourcePath)) return;

  mkdirSync(profileRoot, { recursive: true });
  cpSync(sourcePath, profilePath, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  sanitizeProfileLocks(profilePath);
}

function flattenMessages(messages: LLMMessage[]): string {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content.trim()).filter(Boolean);
  const dialog = messages.filter((message) => message.role !== 'system');

  const parts: string[] = [];
  if (system.length > 0) {
    parts.push('SYSTEM INSTRUCTIONS');
    parts.push(system.join('\n\n'));
  }

  if (dialog.length > 0) {
    parts.push('CONVERSATION');
    for (const message of dialog) {
      const label = message.role === 'assistant' ? 'ASSISTANT' : 'USER';
      parts.push(`[${label}] ${message.content.trim()}`);
    }
  }

  parts.push('Respond to the latest user request. Be precise and follow the system instructions.');
  return parts.join('\n\n');
}

function getStreamOverrides(opts?: LLMOptions): { maxDurationMs?: number; firstChunkTimeoutMs?: number } {
  switch (opts?.tier) {
    case 'small':
      return { firstChunkTimeoutMs: 6_000, maxDurationMs: 18_000 };
    case 'medium':
      return { firstChunkTimeoutMs: 8_000, maxDurationMs: 28_000 };
    default:
      return {};
  }
}

function getRuntime(config: TeGemProviderConfig): TeGemRuntime {
  const key = runtimeKey(config);
  const cached = runtimes.get(key);
  if (cached) return cached;

  seedLegacyProfile(config);

  const geminiConfig: GeminiConfig = {
    headless: config.headless,
    browserChannel: config.browserChannel,
    browserExecutablePath: config.browserExecutablePath,
    baseProfileDir: path.resolve(config.baseProfileDir),
    profileNamespace: config.profileNamespace,
    streamPollIntervalMs: config.streamPollIntervalMs,
    streamStableTicks: config.streamStableTicks,
    streamFirstChunkTimeoutMs: config.streamFirstChunkTimeoutMs,
    streamMaxDurationMs: config.streamMaxDurationMs,
  };

  const providerConfig: GeminiProviderConfig = {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: config.baseUrl,
    readySelectors: [
      "div[contenteditable='true']",
      'textarea',
      "rich-textarea div[contenteditable='true']",
    ],
    inputSelector: "rich-textarea div[contenteditable='true']",
    submitSelector:
      "button[aria-label*='Send'], button[aria-label*='Run'], button[aria-label*='Submit'], button[mattooltip*='Send'], button[type='submit']",
    messageSelectors: ['message-content', '.model-response-text', 'response-container'],
    busySelectors: ["button[aria-label*='Stop']"],
  };

  const runtime: TeGemRuntime = {
    sessionManager: new GeminiSessionManager(
      geminiConfig,
      config.sessionIdleTimeoutMs,
      config.conversationTtlMs,
      config.maxSessionTabs,
    ),
    provider: new GeminiProvider(providerConfig, geminiConfig),
  };
  runtimes.set(key, runtime);
  return runtime;
}

export function createTeGemClient(config: TeGemProviderConfig): LLMClient {
  const runtime = getRuntime(config);

  return {
    provider: 'tegem',
    model: 'gemini-web',

    async prewarmSessions(sessions: LLMOptions[]): Promise<void> {
      const unique = sessions
        .map((session) => ({
          sessionKey: session.sessionKey?.trim() || '',
          label: session.sessionLabel?.trim() || session.sessionKey?.trim() || 'shared/default',
        }))
        .filter((session) => session.sessionKey);
      if (unique.length === 0) return;
      await runtime.sessionManager.prewarm(runtime.provider.config, unique);
    },

    async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
      const sessionKey = opts?.sessionKey?.trim() || 'shared/default';
      const sessionLabel = opts?.sessionLabel?.trim() || sessionKey;
      const prompt = flattenMessages(messages);

      return runtime.sessionManager.withLock(sessionKey, async () => {
        if (opts?.resetSession) {
          await runtime.sessionManager.clearSession(runtime.provider.config, sessionKey).catch(() => undefined);
        }
        const page = await runtime.sessionManager.getOrCreate(runtime.provider.config, sessionKey, sessionLabel);
        await runtime.provider.ensureReady(page);
        await runtime.provider.ensureConversationNotFull(page);

        const baseline = await runtime.provider.snapshotConversation(page);
        await runtime.provider.sendPrompt(page, prompt);

        const stream = runtime.provider.streamResponse(page, baseline, getStreamOverrides(opts));
        let finalContent = '';
        while (true) {
          const next = await stream.next();
          if (next.done) {
            finalContent = next.value.text.trim();
            break;
          }
        }

        return {
          content: finalContent,
          provider: 'tegem',
          model: opts?.model ?? 'gemini-web',
        };
      });
    },

    async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<{ content: string }, LLMResponse, void> {
      const sessionKey = opts?.sessionKey?.trim() || 'shared/default';
      const sessionLabel = opts?.sessionLabel?.trim() || sessionKey;
      const prompt = flattenMessages(messages);
      const release = await runtime.sessionManager.acquireLock(sessionKey);
      try {
        if (opts?.resetSession) {
          await runtime.sessionManager.clearSession(runtime.provider.config, sessionKey).catch(() => undefined);
        }
        const page = await runtime.sessionManager.getOrCreate(runtime.provider.config, sessionKey, sessionLabel);
        await runtime.provider.ensureReady(page);
        await runtime.provider.ensureConversationNotFull(page);

        const baseline = await runtime.provider.snapshotConversation(page);
        await runtime.provider.sendPrompt(page, prompt);

        const stream = runtime.provider.streamResponse(page, baseline, getStreamOverrides(opts));
        let latest = '';
        let accumulated = '';
        while (true) {
          const next: IteratorResult<string, { text: string }> = await stream.next();
          if (next.done) {
            latest = next.value.text.trim() || accumulated.trim();
            break;
          }
          const chunk = next.value.trim();
          if (chunk) {
            accumulated += chunk;
            latest = accumulated.trim();
            if (!latest) continue;
            yield { content: latest };
          }
        }

        return {
          content: latest,
          provider: 'tegem',
          model: opts?.model ?? 'gemini-web',
        } satisfies LLMResponse;
      } finally {
        release();
      }
    },
  };
}
