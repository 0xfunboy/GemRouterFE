import { spawn } from 'node:child_process';

import { buildGeminiCliEnv, buildGeminiCliHealthSnapshot, checkGeminiCliInstall, resolveGeminiCliWorkdir } from '../../../lib/geminiCli.js';
import { normalizeSemanticOutput } from '../../../lib/semantics.js';
import { LLMProviderError } from '../../errors.js';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../../types.js';
import type { GeminiCliHealthSnapshot, GeminiCliProviderConfig } from './types.js';

interface GeminiCliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

type PromptMode = 'flag' | 'positional' | 'stdin';

function flattenMessages(messages: LLMMessage[]): string {
  const meaningful = messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content);

  if (meaningful.length === 0) return '';
  if (meaningful.length === 1 && meaningful[0]?.role === 'user') return meaningful[0].content;

  const system = meaningful.filter((message) => message.role === 'system').map((message) => message.content);
  const dialog = meaningful.filter((message) => message.role !== 'system');
  const parts: string[] = [];

  if (system.length > 0) {
    parts.push(`System:\n${system.join('\n\n')}`);
  }

  if (dialog.length > 0) {
    parts.push('Conversation so far:');
    for (const message of dialog) {
      const label = message.role === 'assistant' ? 'Assistant' : 'User';
      parts.push(`${label}:\n${message.content}`);
    }
  }

  parts.push('Reply as the assistant.');
  return parts.join('\n\n');
}

function repairJsonContent(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;

  try {
    JSON.parse(text);
    return text;
  } catch {
    // continue
  }

  let repaired = text;
  repaired = repaired.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return text;
  }
}

function parseJsonCandidate(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // continue
  }

  const firstBrace = trimmed.indexOf('{');
  if (firstBrace < 0) return null;
  let depth = 0;
  let inString = false;
  let escaping = false;
  let start = -1;

  for (let index = firstBrace; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = trimmed.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate);
          return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function isCliAuthExpired(message: string): boolean {
  return /(expired|revoked|refresh token|session expired)/i.test(message);
}

function isCliAuthMissing(message: string): boolean {
  return /(sign in|login|required authentication|oauth|browser authentication|waiting for auth|cached credential|run gemini)/i.test(message);
}

function isCliUnsupportedModel(message: string): boolean {
  return /(unsupported model|unknown model|invalid model|model .* not found)/i.test(message);
}

function buildArgs(config: GeminiCliProviderConfig, prompt: string, promptMode: PromptMode, includeOutputFormat: boolean): string[] {
  const args = ['--model', config.model];
  if (includeOutputFormat && config.outputFormat === 'json') {
    args.push('--output-format', 'json');
  }

  if (promptMode === 'flag') {
    args.push('-p', prompt);
  } else if (promptMode === 'positional') {
    args.push(prompt);
  }

  return args;
}

async function runGeminiProcess(
  executable: string,
  args: string[],
  prompt: string,
  config: GeminiCliProviderConfig,
  promptMode: PromptMode,
): Promise<GeminiCliProcessResult> {
  const startedAt = Date.now();
  return await new Promise<GeminiCliProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: resolveGeminiCliWorkdir(config),
      env: buildGeminiCliEnv(config),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, config.timeoutMs);
    killTimer.unref();

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    if (promptMode === 'stdin') {
      child.stdin.write(prompt);
    }
    child.stdin.end();
  });
}

function extractResponseText(parsed: Record<string, unknown>): string {
  const direct = typeof parsed.response === 'string' ? parsed.response : null;
  if (direct?.trim()) return direct.trim();

  const nestedResult = parsed.result;
  if (nestedResult && typeof nestedResult === 'object') {
    const nested = nestedResult as Record<string, unknown>;
    if (typeof nested.response === 'string' && nested.response.trim()) return nested.response.trim();
  }

  return '';
}

function extractTokenUsage(parsed: Record<string, unknown>): number | undefined {
  const stats = parsed.stats;
  if (!stats || typeof stats !== 'object') return undefined;
  const typedStats = stats as Record<string, unknown>;
  const candidates = [
    typedStats.totalTokens,
    typedStats.total_tokens,
    typedStats.tokenCount,
    typedStats.totalTokenCount,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

async function executeGeminiCli(
  config: GeminiCliProviderConfig,
  prompt: string,
): Promise<GeminiCliProcessResult & { parsed: Record<string, unknown> | null }> {
  const install = checkGeminiCliInstall(config);
  if (!install.installed || !install.resolvedBin) {
    throw new LLMProviderError('cli_not_installed', 'gemini-cli', 'Gemini CLI is not installed or not reachable.', {
      statusCode: 503,
      fallbackEligible: true,
    });
  }

  const promptModes: PromptMode[] = config.useStdin ? ['stdin'] : ['flag', 'positional'];
  let lastResult: GeminiCliProcessResult | null = null;

  for (const promptMode of promptModes) {
    let includeOutputFormat = config.outputFormat === 'json';
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runGeminiProcess(
        install.resolvedBin,
        buildArgs(config, prompt, promptMode, includeOutputFormat),
        prompt,
        config,
        promptMode,
      );
      lastResult = result;
      const combined = `${result.stdout}\n${result.stderr}`.trim();

      if (
        includeOutputFormat &&
        result.exitCode !== 0 &&
        /unknown arguments?:.*output-format/i.test(combined)
      ) {
        includeOutputFormat = false;
        continue;
      }

      const parsed = includeOutputFormat ? parseJsonCandidate(result.stdout) ?? parseJsonCandidate(combined) : null;
      return { ...result, parsed };
    }
  }

  return { ...(lastResult ?? {
    stdout: '',
    stderr: 'Gemini CLI did not produce output.',
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
  }), parsed: null };
}

export function createGeminiCliClient(config: GeminiCliProviderConfig): LLMClient & {
  health(): GeminiCliHealthSnapshot;
} {
  const runtimeState: {
    lastError: string | null;
    lastSuccessAt: string | null;
    lastLatencyMs: number | null;
  } = {
    lastError: null,
    lastSuccessAt: null,
    lastLatencyMs: null,
  };

  async function complete(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    if (!config.enabled) {
      throw new LLMProviderError('backend_disabled', 'gemini-cli', 'Gemini CLI backend is disabled.', {
        statusCode: 503,
        fallbackEligible: true,
      });
    }

    const prompt = flattenMessages(messages);
    const result = await executeGeminiCli(config, prompt);
    runtimeState.lastLatencyMs = result.durationMs;

    if (result.timedOut) {
      runtimeState.lastError = 'Gemini CLI request timed out.';
      throw new LLMProviderError('cli_timeout', 'gemini-cli', 'Gemini CLI request timed out.', {
        statusCode: 504,
        fallbackEligible: true,
      });
    }

    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const parsed = result.parsed;
    const parsedError = parsed?.error && typeof parsed.error === 'object'
      ? JSON.stringify(parsed.error)
      : typeof parsed?.error === 'string'
        ? parsed.error
        : null;

    if (result.exitCode !== 0 || parsedError) {
      const errorText = [parsedError, combined].filter(Boolean).join('\n').trim() || 'Gemini CLI failed.';
      runtimeState.lastError = errorText;

      if (isCliUnsupportedModel(errorText)) {
        throw new LLMProviderError('cli_model_unsupported', 'gemini-cli', errorText, {
          statusCode: 502,
          fallbackEligible: false,
        });
      }
      if (isCliAuthExpired(errorText)) {
        throw new LLMProviderError('cli_auth_expired', 'gemini-cli', errorText, {
          statusCode: 503,
          fallbackEligible: true,
        });
      }
      if (isCliAuthMissing(errorText)) {
        throw new LLMProviderError('cli_auth_missing', 'gemini-cli', errorText, {
          statusCode: 503,
          fallbackEligible: true,
        });
      }

      throw new LLMProviderError('cli_process_error', 'gemini-cli', errorText, {
        statusCode: 502,
        fallbackEligible: true,
      });
    }

    const text = extractResponseText(parsed ?? {}) || result.stdout.trim();
    if (!text) {
      runtimeState.lastError = combined || 'Gemini CLI returned an empty response.';
      throw new LLMProviderError('cli_bad_output', 'gemini-cli', 'Gemini CLI returned an empty or unparsable response.', {
        statusCode: 502,
        fallbackEligible: true,
      });
    }

    runtimeState.lastError = null;
    runtimeState.lastSuccessAt = new Date().toISOString();

    return {
      content: normalizeSemanticOutput(repairJsonContent(text), opts?.semanticProfile),
      provider: 'gemini-cli',
      model: opts?.model ?? 'gemini-web',
      backend: 'gemini-cli',
      backendModel: config.model,
      latencyMs: result.durationMs,
      tokensUsed: extractTokenUsage(parsed ?? {}),
    };
  }

  return {
    provider: 'gemini-cli',
    model: config.model,

    health(): GeminiCliHealthSnapshot {
      return buildGeminiCliHealthSnapshot(config, runtimeState);
    },

    async chat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
      return await complete(messages, opts);
    },

    async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
      const response = await complete(messages, opts);
      if (response.content) {
        yield { content: response.content };
      }
      return response;
    },

    getDiagnostics(): Record<string, unknown> {
      return this.health() as unknown as Record<string, unknown>;
    },
  };
}
