import { createHash } from 'node:crypto';

import type { LLMMessage } from '../llm/types.js';
import { normalizeModelId, type UsageSummary } from './openai.js';

export interface OllamaChatRequest {
  model?: string;
  messages?: unknown;
  stream?: boolean;
  format?: unknown;
  options?: Record<string, unknown>;
  keep_alive?: unknown;
  tools?: unknown[];
}

export interface OllamaGenerateRequest {
  model?: string;
  prompt?: unknown;
  system?: unknown;
  stream?: boolean;
  format?: unknown;
  options?: Record<string, unknown>;
  keep_alive?: unknown;
}

export interface ParsedOllamaRequest {
  model: string;
  messages: LLMMessage[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  stateful: boolean;
  outputMode: 'text' | 'json';
  jsonSchema?: unknown;
}

function parseTextContent(content: unknown, role: string): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        if (typeof part === 'string') return [part];
        if (!part || typeof part !== 'object') return [];
        const typedPart = part as Record<string, unknown>;
        if (
          typedPart.type === 'text' ||
          typedPart.type === 'input_text' ||
          typedPart.type === 'output_text'
        ) {
          const text = typedPart.text;
          return typeof text === 'string' ? [text] : [];
        }
        throw new Error(`Unsupported content part for role "${role}": ${String(typedPart.type ?? 'unknown')}`);
      })
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return String((content as { text: string }).text);
  }
  return '';
}

function normalizeRole(rawRole: unknown): LLMMessage['role'] {
  const role = String(rawRole ?? '')
    .trim()
    .toLowerCase();
  if (role === 'developer') return 'system';
  if (role === 'system' || role === 'user' || role === 'assistant') return role;
  throw new Error(`Unsupported Ollama message role: ${role || 'unknown'}`);
}

function buildJsonInstruction(format: unknown): string | null {
  if (!format) return null;
  if (typeof format === 'string' && format.trim().toLowerCase() === 'json') {
    return 'Return only a valid JSON object. Do not wrap the JSON in markdown fences.';
  }
  if (typeof format === 'object') {
    return [
      'Return only valid JSON matching this schema as closely as possible.',
      'Do not add markdown fences or explanation.',
      JSON.stringify(format),
    ].join('\n');
  }
  return null;
}

function prependInstruction(messages: LLMMessage[], instruction: string | null): LLMMessage[] {
  if (!instruction) return messages;
  return [{ role: 'system', content: instruction }, ...messages];
}

function readNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function isStatefulKeepAlive(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const normalized = String(value)
    .trim()
    .toLowerCase();
  return !['', '0', '0s', '0m', 'false', 'off', 'no'].includes(normalized);
}

function parseMessageArray(messages: unknown): LLMMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  return messages.map((message) => {
    if (!message || typeof message !== 'object') throw new Error('Invalid message item');
    const typed = message as Record<string, unknown>;
    return {
      role: normalizeRole(typed.role),
      content: parseTextContent(typed.content, String(typed.role ?? 'unknown')),
    } satisfies LLMMessage;
  });
}

export function parseOllamaChatRequest(body: OllamaChatRequest): ParsedOllamaRequest {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw new Error('Tool calling is not supported on gemini-web');
  }

  const options = body.options ?? {};
  const messages = parseMessageArray(body.messages);

  const outputMode = body.format ? 'json' : 'text';
  const jsonSchema = typeof body.format === 'object' ? body.format : undefined;

  return {
    model: normalizeModelId(body.model),
    messages: prependInstruction(messages, buildJsonInstruction(body.format)),
    stream: body.stream !== false,
    maxTokens: readNumber(options.num_predict),
    temperature: readNumber(options.temperature),
    stateful: isStatefulKeepAlive(body.keep_alive),
    outputMode,
    jsonSchema,
  };
}

export function parseOllamaGenerateRequest(body: OllamaGenerateRequest): ParsedOllamaRequest {
  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) {
    throw new Error('prompt is required');
  }

  const options = body.options ?? {};
  const messages: LLMMessage[] = [];
  const systemPrompt = String(body.system ?? '').trim();
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const outputMode = body.format ? 'json' : 'text';
  const jsonSchema = typeof body.format === 'object' ? body.format : undefined;

  return {
    model: normalizeModelId(body.model),
    messages: prependInstruction(messages, buildJsonInstruction(body.format)),
    stream: body.stream !== false,
    maxTokens: readNumber(options.num_predict),
    temperature: readNumber(options.temperature),
    stateful: isStatefulKeepAlive(body.keep_alive),
    outputMode,
    jsonSchema,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function durationNanos(): number {
  return 0;
}

function buildDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function buildOllamaError(message: string): {
  error: { message: string; type: string; code: string; param: null };
} {
  return {
    error: {
      message,
      type: 'invalid_request_error',
      code: 'ollama_error',
      param: null,
    },
  };
}

export function buildOllamaTagsResponse(models: string[]): {
  models: Array<Record<string, unknown>>;
} {
  const uniqueModels = [...new Set(models)];
  return {
    models: uniqueModels.map((model) => ({
      name: model,
      model,
      modified_at: nowIso(),
      size: 0,
      digest: buildDigest(model),
      details: {
        format: 'gemrouter',
        family: 'gemini-web',
        families: ['gemini-web'],
        parameter_size: 'remote',
        quantization_level: 'remote',
      },
    })),
  };
}

export function buildOllamaShowResponse(model: string): Record<string, unknown> {
  return {
    license: 'GemRouterFE remote surface',
    modelfile: `FROM ${model}`,
    parameters: 'temperature 0.7',
    template: '{{ .Prompt }}',
    details: {
      format: 'gemrouter',
      family: 'gemini-web',
      families: ['gemini-web'],
      parameter_size: 'remote',
      quantization_level: 'remote',
    },
    model_info: {},
    capabilities: ['completion', 'chat'],
    modified_at: nowIso(),
  };
}

export function buildOllamaChatResponse(input: {
  model: string;
  text: string;
  usage: UsageSummary;
}): Record<string, unknown> {
  return {
    model: input.model,
    created_at: nowIso(),
    message: {
      role: 'assistant',
      content: input.text,
    },
    done: true,
    done_reason: 'stop',
    total_duration: durationNanos(),
    load_duration: durationNanos(),
    prompt_eval_count: input.usage.prompt_tokens,
    prompt_eval_duration: durationNanos(),
    eval_count: input.usage.completion_tokens,
    eval_duration: durationNanos(),
  };
}

export function buildOllamaChatChunk(input: {
  model: string;
  text: string;
}): Record<string, unknown> {
  return {
    model: input.model,
    created_at: nowIso(),
    message: {
      role: 'assistant',
      content: input.text,
    },
    done: false,
  };
}

export function buildOllamaChatDone(input: {
  model: string;
  usage: UsageSummary;
}): Record<string, unknown> {
  return {
    model: input.model,
    created_at: nowIso(),
    done: true,
    done_reason: 'stop',
    total_duration: durationNanos(),
    load_duration: durationNanos(),
    prompt_eval_count: input.usage.prompt_tokens,
    prompt_eval_duration: durationNanos(),
    eval_count: input.usage.completion_tokens,
    eval_duration: durationNanos(),
  };
}

export function buildOllamaGenerateResponse(input: {
  model: string;
  text: string;
  usage: UsageSummary;
}): Record<string, unknown> {
  return {
    model: input.model,
    created_at: nowIso(),
    response: input.text,
    done: true,
    done_reason: 'stop',
    context: [],
    total_duration: durationNanos(),
    load_duration: durationNanos(),
    prompt_eval_count: input.usage.prompt_tokens,
    prompt_eval_duration: durationNanos(),
    eval_count: input.usage.completion_tokens,
    eval_duration: durationNanos(),
  };
}

export function buildOllamaGenerateChunk(input: {
  model: string;
  text: string;
}): Record<string, unknown> {
  return {
    model: input.model,
    created_at: nowIso(),
    response: input.text,
    done: false,
  };
}

export function buildOllamaGenerateDone(input: {
  model: string;
  usage: UsageSummary;
}): Record<string, unknown> {
  return {
    model: input.model,
    created_at: nowIso(),
    response: '',
    done: true,
    done_reason: 'stop',
    context: [],
    total_duration: durationNanos(),
    load_duration: durationNanos(),
    prompt_eval_count: input.usage.prompt_tokens,
    prompt_eval_duration: durationNanos(),
    eval_count: input.usage.completion_tokens,
    eval_duration: durationNanos(),
  };
}
