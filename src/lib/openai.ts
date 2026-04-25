import { createHash, randomUUID } from 'node:crypto';

import type { LLMMessage } from '../llm/types.js';
import type { SemanticActionPolicy } from './semantics.js';

export interface ChatCompletionsRequest {
  model?: string;
  messages?: unknown;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  temperature?: number;
  user?: string;
  response_format?: Record<string, unknown>;
  n?: number;
  tools?: unknown[];
}

export interface ResponsesRequest {
  model?: string;
  input?: unknown;
  instructions?: string;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  user?: string;
  text?: {
    format?: Record<string, unknown>;
  };
  tools?: unknown[];
}

export interface UsageSummary {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

function prefersJsonMarkdownBlock(messages: LLMMessage[]): boolean {
  const combined = messages.map((message) => message.content).join('\n');
  return (
    /Response format should be formatted in a valid JSON block like this:/i.test(combined) &&
    /```json/i.test(combined)
  );
}

function extractPromptSection(source: string, marker: string, terminators: string[]): string {
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex < 0) return '';
  const start = markerIndex + marker.length;
  let end = source.length;
  for (const terminator of terminators) {
    const nextIndex = source.indexOf(terminator, start);
    if (nextIndex >= 0 && nextIndex < end) {
      end = nextIndex;
    }
  }
  return source.slice(start, end).trim();
}

function detectJsonActionPolicy(messages: LLMMessage[]): SemanticActionPolicy {
  const combined = messages.map((message) => message.content).join('\n');
  const noActionHint = /no action tools;\s*provide insights/i;

  const currentPost = extractPromptSection(combined, 'Current Post:', [
    '\nThread of Tweets You Are Replying To:',
    '\n# INSTRUCTIONS:',
    '\nOBLIGATORY STYLE RULES:',
  ]);
  if (noActionHint.test(currentPost)) return 'none_only';

  const userRequest = extractPromptSection(combined, 'USER REQUEST:', ['\nTASK:', '\nDATA:']);
  if (noActionHint.test(userRequest)) return 'none_only';

  const userRawText = extractPromptSection(combined, 'USER RAW TEXT:', ['\nREWRITING RULES:']);
  if (noActionHint.test(userRawText)) return 'none_only';

  if (/<hidden>\s*no action tools;\s*provide insights\s*<\/hidden>/i.test(combined)) {
    return 'none_only';
  }

  if (noActionHint.test(combined)) {
    return 'none_only';
  }

  return 'default';
}

function parseTextContent(content: unknown, role: string): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = content.flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (!part || typeof part !== 'object') return [];
      const typedPart = part as Record<string, unknown>;
      if (typedPart.type === 'text' || typedPart.type === 'input_text' || typedPart.type === 'output_text') {
        const text = typedPart.text;
        return typeof text === 'string' ? [text] : [];
      }
      throw new Error(`Unsupported content part for role "${role}": ${String(typedPart.type ?? 'unknown')}`);
    });
    return textParts.join('\n').trim();
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return String((content as { text: string }).text);
  }
  return '';
}

function normalizeRole(rawRole: unknown): LLMMessage['role'] {
  const role = String(rawRole ?? '').trim().toLowerCase();
  if (role === 'developer') return 'system';
  if (role === 'system' || role === 'user' || role === 'assistant') return role;
  throw new Error(`Unsupported message role: ${role || 'unknown'}`);
}

function buildResponseFormatInstruction(responseFormat?: Record<string, unknown>): string | null {
  if (!responseFormat) return null;
  const type = String(responseFormat.type ?? '').trim();
  if (type === 'json_object') {
    return 'Return only a valid JSON object. Do not wrap the JSON in markdown fences.';
  }
  if (type === 'json_schema') {
    const schema =
      responseFormat.schema ??
      (responseFormat.json_schema && typeof responseFormat.json_schema === 'object'
        ? (responseFormat.json_schema as Record<string, unknown>).schema
        : undefined);
    if (!schema) {
      return 'Return only valid JSON matching the schema requested by the client.';
    }
    return [
      'Return only valid JSON matching this schema as closely as possible.',
      'Do not add markdown fences or explanation.',
      JSON.stringify(schema),
    ].join('\n');
  }
  return null;
}

function prependSystemInstruction(messages: LLMMessage[], instruction: string | null): LLMMessage[] {
  if (!instruction) return messages;
  return [{ role: 'system', content: instruction }, ...messages];
}

export function normalizeModelId(input: string | undefined): string {
  const value = (input ?? 'gemini-web').trim().toLowerCase();
  if (value === 'gemini-web' || value === 'google/gemini-web') return value;
  throw new Error(`Unsupported model: ${value}`);
}

export function parseChatCompletionsRequest(body: ChatCompletionsRequest): {
  model: string;
  messages: LLMMessage[];
  stream: boolean;
  includeUsageChunk: boolean;
  user?: string;
  maxTokens?: number;
  temperature?: number;
  outputMode: 'text' | 'json';
  jsonSchema?: unknown;
  jsonPresentation: 'bare' | 'markdown_block';
  actionPolicy: SemanticActionPolicy;
} {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  if (body.n !== undefined && body.n !== 1) {
    throw new Error('Only n=1 is supported');
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw new Error('Tool calling is not supported on gemini-web');
  }

  const messages = body.messages.map((message) => {
    if (!message || typeof message !== 'object') throw new Error('Invalid message item');
    const typed = message as Record<string, unknown>;
    return {
      role: normalizeRole(typed.role),
      content: parseTextContent(typed.content, String(typed.role ?? 'unknown')),
    } satisfies LLMMessage;
  });

  const responseFormat = body.response_format;
  const responseFormatType = String(responseFormat?.type ?? '').trim().toLowerCase();
  const jsonSchema =
    responseFormatType === 'json_schema'
      ? responseFormat?.schema ??
        (responseFormat?.json_schema && typeof responseFormat.json_schema === 'object'
          ? (responseFormat.json_schema as Record<string, unknown>).schema
          : undefined)
      : undefined;

  return {
    model: normalizeModelId(body.model),
    messages: prependSystemInstruction(messages, buildResponseFormatInstruction(body.response_format)),
    stream: body.stream === true,
    includeUsageChunk: body.stream_options?.include_usage === true,
    user: typeof body.user === 'string' ? body.user.trim() : undefined,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    outputMode: responseFormatType.startsWith('json') ? 'json' : 'text',
    jsonSchema,
    jsonPresentation:
      responseFormatType.startsWith('json') ? 'bare' : prefersJsonMarkdownBlock(messages) ? 'markdown_block' : 'bare',
    actionPolicy: detectJsonActionPolicy(messages),
  };
}

export function parseResponsesRequest(body: ResponsesRequest): {
  model: string;
  messages: LLMMessage[];
  stream: boolean;
  user?: string;
  maxTokens?: number;
  temperature?: number;
  outputMode: 'text' | 'json';
  jsonSchema?: unknown;
  jsonPresentation: 'bare' | 'markdown_block';
  actionPolicy: SemanticActionPolicy;
} {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw new Error('Tool calling is not supported on gemini-web');
  }

  const messages: LLMMessage[] = [];
  if (body.instructions?.trim()) {
    messages.push({ role: 'system', content: body.instructions.trim() });
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') throw new Error('Invalid input item');
      const typed = item as Record<string, unknown>;
      messages.push({
        role: normalizeRole(typed.role ?? 'user'),
        content: parseTextContent(typed.content ?? typed.input, String(typed.role ?? 'user')),
      });
    }
  } else if (body.input && typeof body.input === 'object') {
    const typed = body.input as Record<string, unknown>;
    messages.push({
      role: normalizeRole(typed.role ?? 'user'),
      content: parseTextContent(typed.content ?? typed.input, String(typed.role ?? 'user')),
    });
  }

  if (messages.length === 0) {
    throw new Error('input must contain at least one message');
  }

  const responseFormat = body.text?.format;
  const responseFormatType = String(responseFormat?.type ?? '').trim().toLowerCase();
  const jsonSchema =
    responseFormatType === 'json_schema'
      ? responseFormat?.schema ??
        (responseFormat?.json_schema && typeof responseFormat.json_schema === 'object'
          ? (responseFormat.json_schema as Record<string, unknown>).schema
          : undefined)
      : undefined;

  return {
    model: normalizeModelId(body.model),
    messages: prependSystemInstruction(messages, buildResponseFormatInstruction(body.text?.format)),
    stream: body.stream === true,
    user: typeof body.user === 'string' ? body.user.trim() : undefined,
    maxTokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    outputMode: responseFormatType.startsWith('json') ? 'json' : 'text',
    jsonSchema,
    jsonPresentation:
      responseFormatType.startsWith('json') ? 'bare' : prefersJsonMarkdownBlock(messages) ? 'markdown_block' : 'bare',
    actionPolicy: detectJsonActionPolicy(messages),
  };
}

export function estimateUsage(messages: LLMMessage[], outputText: string): UsageSummary {
  const promptText = messages.map((message) => message.content).join('\n');
  const promptTokens = Math.max(1, Math.ceil(promptText.length / 4));
  const completionTokens = Math.max(1, Math.ceil(outputText.length / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

export function buildChatCompletionResponse(input: {
  id?: string;
  model: string;
  text: string;
  usage: UsageSummary;
  created?: number;
}): Record<string, unknown> {
  return {
    id: input.id ?? `chatcmpl_${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: input.created ?? Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: input.text,
        },
        finish_reason: 'stop',
      },
    ],
    usage: input.usage,
  };
}

export function buildResponsesApiResponse(input: {
  id?: string;
  model: string;
  text: string;
  usage: UsageSummary;
  createdAt?: number;
}): Record<string, unknown> {
  const responseId = input.id ?? `resp_${randomUUID().replace(/-/g, '')}`;
  const messageId = `msg_${randomUUID().replace(/-/g, '')}`;
  return {
    id: responseId,
    object: 'response',
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: input.model,
    output: [
      {
        id: messageId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: input.text,
            annotations: [],
          },
        ],
      },
    ],
    parallel_tool_calls: false,
    tools: [],
    usage: {
      input_tokens: input.usage.prompt_tokens,
      output_tokens: input.usage.completion_tokens,
      total_tokens: input.usage.total_tokens,
    },
  };
}

export function createRequestFingerprint(messages: LLMMessage[]): string {
  const payload = JSON.stringify(messages);
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

export function sanitizeSessionHint(value: string | undefined, fallback: string): string {
  const candidate = (value ?? fallback).trim().toLowerCase();
  return candidate.replace(/[^a-z0-9:_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || fallback;
}

export function buildOpenAIError(input: {
  message: string;
  type: string;
  code: string;
  param?: string | null;
}): { error: { message: string; type: string; code: string; param: string | null } } {
  return {
    error: {
      message: input.message,
      type: input.type,
      code: input.code,
      param: input.param ?? null,
    },
  };
}
