import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { normalizeSemanticOutput } from '../../../lib/semantics.js';
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
  respondedSessionTtlMs: number;
  orphanSessionTtlMs: number;
  streamPollIntervalMs: number;
  streamStableTicks: number;
  streamFirstChunkTimeoutMs: number;
  streamMaxDurationMs: number;
  legacyProfileImportPath?: string;
  promptPackingStyle: 'minimal' | 'copilotrm';
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
    respondedSessionTtlMs: config.respondedSessionTtlMs,
    orphanSessionTtlMs: config.orphanSessionTtlMs,
    promptPackingStyle: config.promptPackingStyle,
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

function flattenMessagesCopilotrm(messages: LLMMessage[]): string {
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

function flattenMessagesMinimal(messages: LLMMessage[]): string {
  const meaningful = messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content);

  if (meaningful.length === 0) return '';

  if (meaningful.length === 1 && meaningful[0]?.role === 'user') {
    return meaningful[0].content;
  }

  const system = meaningful.filter((message) => message.role === 'system').map((message) => message.content);
  const dialog = meaningful.filter((message) => message.role !== 'system');
  const parts: string[] = [];

  if (system.length > 0) {
    parts.push(`System:\n${system.join('\n\n')}`);
  }

  if (dialog.length === 1 && dialog[0]?.role === 'user' && system.length === 0) {
    parts.push(dialog[0].content);
    return parts.join('\n\n');
  }

  for (const message of dialog) {
    const label = message.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`${label}:\n${message.content}`);
  }

  return parts.join('\n\n');
}

function flattenMessages(messages: LLMMessage[], style: 'minimal' | 'copilotrm'): string {
  return style === 'copilotrm' ? flattenMessagesCopilotrm(messages) : flattenMessagesMinimal(messages);
}

function getStreamOverrides(opts?: LLMOptions): { maxDurationMs?: number; firstChunkTimeoutMs?: number } {
  switch (opts?.tier) {
    case 'small':
      return { firstChunkTimeoutMs: 20_000, maxDurationMs: 60_000 };
    case 'medium':
      return { firstChunkTimeoutMs: 30_000, maxDurationMs: 90_000 };
    default:
      return {};
  }
}

/**
 * Tries to repair common Gemini JSON issues (unquoted keys, trailing commas).
 * Returns the original text if it cannot be repaired into valid JSON.
 */
function repairJsonContent(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;

  // Already valid
  try { JSON.parse(text); return text; } catch { /* fall through */ }

  let repaired = text;
  // Quote unquoted property names: {key: or , key:
  repaired = repaired.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  // Remove trailing commas before } or ]
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  try { JSON.parse(repaired); return repaired; } catch { return text; }
}

function isRecoverableGeminiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return [
    /input gemini non trovato/i,
    /prompt gemini non inviato/i,
    /element was detached/i,
    /element is not stable/i,
    /locator\.click/i,
    /timeout gemini: nessuna risposta entro il timeout iniziale/i,
  ].some((pattern) => pattern.test(message));
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
      config.respondedSessionTtlMs,
      config.orphanSessionTtlMs,
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
      const prompt = flattenMessages(messages, config.promptPackingStyle);

      return runtime.sessionManager.withLock(sessionKey, async () => {
        const maxAttempts = 2;
        let lastError: unknown = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
            let finalContent = '';
            while (true) {
              const next = await stream.next();
              if (next.done) {
                finalContent = normalizeSemanticOutput(
                  repairJsonContent(next.value.text.trim()),
                  opts?.semanticProfile,
                );
                runtime.sessionManager.markResponseCaptured(sessionKey);
                break;
              }
            }

            return {
              content: finalContent,
              provider: 'tegem',
              model: opts?.model ?? 'gemini-web',
            };
          } catch (error) {
            lastError = error;
            if (!isRecoverableGeminiError(error) || attempt === maxAttempts - 1) {
              throw error;
            }
            await runtime.sessionManager.recreateSession(runtime.provider.config, sessionKey).catch(() => undefined);
          }
        }

        throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Gemini request failed.')));
      });
    },

    async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<{ content: string }, LLMResponse, void> {
      const sessionKey = opts?.sessionKey?.trim() || 'shared/default';
      const sessionLabel = opts?.sessionLabel?.trim() || sessionKey;
      const prompt = flattenMessages(messages, config.promptPackingStyle);
      const release = await runtime.sessionManager.acquireLock(sessionKey);
      try {
        const maxAttempts = 2;
        let lastError: unknown = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
                latest = normalizeSemanticOutput(accumulated.trim(), opts?.semanticProfile, { partial: true });
                if (!latest) continue;
                yield { content: latest };
              }
            }

            latest = normalizeSemanticOutput(latest, opts?.semanticProfile);
            runtime.sessionManager.markResponseCaptured(sessionKey);
            return {
              content: latest,
              provider: 'tegem',
              model: opts?.model ?? 'gemini-web',
            } satisfies LLMResponse;
          } catch (error) {
            lastError = error;
            if (!isRecoverableGeminiError(error) || attempt === maxAttempts - 1) {
              throw error;
            }
            await runtime.sessionManager.recreateSession(runtime.provider.config, sessionKey).catch(() => undefined);
          }
        }

        throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Gemini stream failed.')));
      } finally {
        release();
      }
    },
    getDiagnostics(): Record<string, unknown> {
      return {
        provider: 'tegem',
        model: 'gemini-web',
        promptPackingStyle: config.promptPackingStyle,
        ...runtime.sessionManager.getDiagnostics(),
      };
    },
  };
}
