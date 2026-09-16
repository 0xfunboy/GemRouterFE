import { createHash } from 'node:crypto';

import { chatGptError } from './errors.js';
import {
  CHATGPT_GATEWAY_PROTOCOL_VERSION,
  type ChatGptExplicitControls,
  type ChatGptGatewayMessage,
  type ChatGptGatewayProfile,
  type GatewayExchangeInput,
  type GatewayOpenInput,
} from './types.js';

const WORKER_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const ALIAS = /^[a-z0-9](?:[a-z0-9._:/-]{0,126}[a-z0-9])?$/u;
const OPEN_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const RUN_ID = /^run_[A-Za-z0-9_-]{32,128}$/u;
const EXCHANGE_ID = /^ex_[A-Za-z0-9_-]{24,128}$/u;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{24,128}$/u;
const CLAIM_TOKEN = /^claim_[A-Za-z0-9_-]{32,160}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/u;
const ERROR_CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;

const ALLOWED_REQUEST_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'n',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'seed',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'logprobs',
  'top_logprobs',
  'store',
  'service_tier',
  'prompt_cache_key',
  'prompt_cache_retention',
  'user',
  'response_format',
]);

const UNAVAILABLE_CONTROLS = new Set([
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'seed',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'logprobs',
  'top_logprobs',
  'store',
  'service_tier',
  'prompt_cache_key',
  'prompt_cache_retention',
  'user',
]);

export interface ParsedChatGptRequest {
  model: string;
  messages: ChatGptGatewayMessage[];
  controls: ChatGptExplicitControls;
  fingerprint: string;
  idempotencyKey?: string;
}

export function normalizeWorkerId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('worker id must be a string');
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!WORKER_ID.test(normalized)) throw new Error('worker id must be 1-64 lowercase letters, digits, _ or -');
  return normalized;
}

export function normalizeChatGptAlias(value: unknown): string {
  if (typeof value !== 'string') throw new Error('model alias must be a string');
  const normalized = String(value ?? '').trim().toLowerCase().replace(/^models\//u, '');
  if (!ALIAS.test(normalized) || Buffer.byteLength(normalized, 'utf8') > 128) {
    throw new Error('model alias is invalid');
  }
  return normalized;
}

export function normalizeNamespacedAlias(value: unknown): string {
  const normalized = normalizeChatGptAlias(value);
  return normalized.startsWith('chatgpt/') ? normalizeChatGptAlias(normalized.slice('chatgpt/'.length)) : normalized;
}

export function validateIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw chatGptError('chatgpt_unsupported_parameter', 'Idempotency-Key must contain 1-128 safe ASCII characters.');
  }
  return value;
}

export function parseChatGptCompletionRequest(input: {
  body: unknown;
  profile: ChatGptGatewayProfile;
  profileHeader?: unknown;
  idempotencyKey?: unknown;
  maxRequestBytes: number;
}): ParsedChatGptRequest {
  if (!isRecord(input.body)) throw chatGptError('chatgpt_unsupported_parameter', 'Request body must be a JSON object.');
  const requestBody = input.body;
  const rawBytes = Buffer.byteLength(JSON.stringify(input.body), 'utf8');
  if (rawBytes > input.maxRequestBytes) throw chatGptError('chatgpt_payload_too_large');
  for (const key of Object.keys(input.body)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      throw chatGptError('chatgpt_unsupported_parameter', `Unsupported ChatGPT gateway field: ${key}.`);
    }
  }

  let model: string;
  try {
    model = normalizeNamespacedAlias(input.body.model);
  } catch {
    throw chatGptError('chatgpt_unsupported_parameter', 'model must be a valid ChatGPT worker alias.');
  }
  const messages = parseMessages(input.body.messages, input.maxRequestBytes);
  const profile = resolveProfile(input.profile, input.profileHeader);

  if (input.body.n !== undefined && (!Number.isSafeInteger(input.body.n) || input.body.n !== 1)) {
    throw chatGptError('chatgpt_unsupported_parameter', 'The ChatGPT gateway supports only n=1.');
  }
  if (input.body.stream !== undefined && typeof input.body.stream !== 'boolean') {
    throw chatGptError('chatgpt_unsupported_parameter', 'stream must be boolean.');
  }
  const stream = input.body.stream === true;
  const includeUsage = parseStreamOptions(input.body.stream_options, stream);
  validateAbsentTools(input.body);
  const responseFormat = parseResponseFormat(input.body.response_format);
  const present = Object.keys(input.body).filter((key) => UNAVAILABLE_CONTROLS.has(key)).sort();
  if (profile === 'strict' && (present.length > 0 || includeUsage)) {
    const rejected = [...present, ...(includeUsage ? ['stream_options.include_usage'] : [])];
    throw chatGptError(
      'chatgpt_unsupported_parameter',
      `Strict gateway profile rejects unavailable controls: ${rejected.join(', ')}.`,
    );
  }
  validateControlTypes(input.body, present);

  const warnings = profile === 'compatibility'
    ? [
        ...present.map(controlWarning),
        ...(includeUsage ? ['usage_unavailable'] : []),
      ]
    : [];
  const controls: ChatGptExplicitControls = {
    present,
    warnings: [...new Set(warnings)],
    responseFormat,
    stream,
    includeUsage,
    profile,
  };
  const fingerprint = digestCanonical({
    model, messages,
    controls: { present, responseFormat, stream, includeUsage, profile },
    // Ignored controls are not forwarded or stored, but changing their supplied
    // value still changes the request payload for idempotency conflict detection.
    suppliedControls: Object.fromEntries(present.map((key) => [key, requestBody[key]])),
  });
  return {
    model,
    messages,
    controls,
    fingerprint,
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
  };
}

export function validateGatewayOpenInput(value: unknown): GatewayOpenInput {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'protocol_version' && key !== 'open_id')) {
    throw new Error('gateway_open input is invalid');
  }
  if (value.protocol_version !== CHATGPT_GATEWAY_PROTOCOL_VERSION) {
    throw new Error(`protocol_version must be ${CHATGPT_GATEWAY_PROTOCOL_VERSION}`);
  }
  if (typeof value.open_id !== 'string' || !OPEN_ID.test(value.open_id)) throw new Error('open_id is invalid');
  return { protocol_version: CHATGPT_GATEWAY_PROTOCOL_VERSION, open_id: value.open_id };
}

export function validateGatewayExchangeInput(value: unknown, maximumWaitSeconds: number): GatewayExchangeInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['run_id', 'exchange_id', 'maximum_wait_seconds', 'completion', 'yield_after_completion'].includes(key))) {
    throw new Error('gateway_exchange input is invalid');
  }
  if (typeof value.run_id !== 'string' || !RUN_ID.test(value.run_id)) throw new Error('run_id is invalid');
  if (typeof value.exchange_id !== 'string' || !EXCHANGE_ID.test(value.exchange_id)) throw new Error('exchange_id is invalid');
  const wait = value.maximum_wait_seconds;
  if (wait !== undefined && (!Number.isSafeInteger(wait) || Number(wait) < 1 || Number(wait) > maximumWaitSeconds)) {
    throw new Error(`maximum_wait_seconds must be an integer from 1 through ${maximumWaitSeconds}`);
  }
  const completion = value.completion === undefined ? undefined : validateCompletion(value.completion);
  if (value.yield_after_completion !== undefined && typeof value.yield_after_completion !== 'boolean') {
    throw new Error('yield_after_completion must be boolean');
  }
  if (value.yield_after_completion === true && !completion) throw new Error('yield_after_completion requires completion');
  return {
    run_id: value.run_id,
    exchange_id: value.exchange_id,
    ...(wait === undefined ? {} : { maximum_wait_seconds: Number(wait) }),
    ...(completion === undefined ? {} : { completion }),
    ...(value.yield_after_completion === undefined ? {} : { yield_after_completion: value.yield_after_completion }),
  };
}

export function digestCanonical(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function safeJsonObjectResponse(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed);
  } catch {
    return false;
  }
}

function parseMessages(value: unknown, maxBytes: number): ChatGptGatewayMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw chatGptError('chatgpt_unsupported_parameter', 'messages must contain 1-256 entries.');
  }
  let total = 0;
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw chatGptError('chatgpt_unsupported_parameter', `messages[${index}] must be an object.`);
    for (const key of Object.keys(candidate)) {
      if (key !== 'role' && key !== 'content') {
        throw chatGptError('chatgpt_unsupported_parameter', `Unsupported messages[${index}] field: ${key}.`);
      }
    }
    const role = String(candidate.role ?? '').trim().toLowerCase();
    if (role === 'tool') throw chatGptError('chatgpt_unsupported_parameter', 'role:tool is not supported by the ChatGPT gateway.');
    if (role !== 'system' && role !== 'developer' && role !== 'user' && role !== 'assistant') {
      throw chatGptError('chatgpt_unsupported_parameter', `Unsupported message role: ${role || 'missing'}.`);
    }
    const content = parseTextContent(candidate.content, index);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > maxBytes) throw chatGptError('chatgpt_payload_too_large', `messages[${index}] exceeds the byte limit.`);
    total += bytes;
    if (total > maxBytes) throw chatGptError('chatgpt_payload_too_large');
    return { role, content };
  });
}

function parseTextContent(value: unknown, messageIndex: number): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    throw chatGptError('chatgpt_unsupported_parameter', `messages[${messageIndex}].content must be text.`);
  }
  const parts = value.map((part, partIndex) => {
    if (typeof part === 'string') return part;
    if (!isRecord(part)) {
      throw chatGptError('chatgpt_unsupported_parameter', `messages[${messageIndex}].content[${partIndex}] is invalid.`);
    }
    if (Object.keys(part).some((key) => key !== 'type' && key !== 'text')
      || !['text', 'input_text', 'output_text'].includes(String(part.type ?? '')) || typeof part.text !== 'string') {
      throw chatGptError(
        'chatgpt_unsupported_parameter',
        `Only textual multipart content is supported (messages[${messageIndex}].content[${partIndex}]).`,
      );
    }
    return part.text;
  });
  return parts.join('\n');
}

function validateAbsentTools(body: Record<string, unknown>): void {
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) {
    throw chatGptError('chatgpt_unsupported_parameter', 'Caller tool execution is not supported; tools must be omitted or empty.');
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'none') {
    throw chatGptError('chatgpt_unsupported_parameter', 'tool_choice must be omitted or "none".');
  }
}

function parseStreamOptions(value: unknown, stream: boolean): boolean {
  if (value === undefined) return false;
  if (!stream || !isRecord(value) || Object.keys(value).some((key) => key !== 'include_usage')) {
    throw chatGptError('chatgpt_unsupported_parameter', 'stream_options is valid only with stream=true and include_usage.');
  }
  if (value.include_usage !== undefined && typeof value.include_usage !== 'boolean') {
    throw chatGptError('chatgpt_unsupported_parameter', 'stream_options.include_usage must be boolean.');
  }
  return value.include_usage === true;
}

function parseResponseFormat(value: unknown): 'text' | 'json_object' {
  if (value === undefined) return 'text';
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'type')) {
    throw chatGptError('chatgpt_unsupported_parameter', 'response_format must be {"type":"text"} or {"type":"json_object"}.');
  }
  if (value.type === 'text') return 'text';
  if (value.type === 'json_object') return 'json_object';
  throw chatGptError('chatgpt_unsupported_parameter', 'json_schema and native structured output are not supported.');
}

function resolveProfile(configured: ChatGptGatewayProfile, value: unknown): ChatGptGatewayProfile {
  if (value === undefined || value === '') return configured;
  if (value !== 'strict' && value !== 'compatibility') {
    throw chatGptError('chatgpt_unsupported_parameter', 'X-GemRouter-Gateway-Profile must be strict or compatibility.');
  }
  return configured === 'strict' || value === 'strict' ? 'strict' : 'compatibility';
}

function validateControlTypes(body: Record<string, unknown>, present: string[]): void {
  for (const key of present) {
    const value = body[key];
    if (value === null) continue;
    if (['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'].includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw chatGptError('chatgpt_unsupported_parameter', `${key} must be numeric.`);
    }
    if (['max_tokens', 'max_completion_tokens', 'top_logprobs'].includes(key) && (!Number.isSafeInteger(value) || Number(value) < 0)) {
      throw chatGptError('chatgpt_unsupported_parameter', `${key} must be a non-negative integer.`);
    }
    if (key === 'seed' && !Number.isSafeInteger(value)) throw chatGptError('chatgpt_unsupported_parameter', 'seed must be an integer.');
    if (['logprobs', 'store'].includes(key) && typeof value !== 'boolean') {
      throw chatGptError('chatgpt_unsupported_parameter', `${key} must be boolean.`);
    }
    if (key === 'stop' && !(typeof value === 'string' || Array.isArray(value) && value.length <= 4 && value.every((item) => typeof item === 'string'))) {
      throw chatGptError('chatgpt_unsupported_parameter', 'stop must be a string or an array of at most four strings.');
    }
    if (['reasoning_effort', 'service_tier', 'prompt_cache_key', 'prompt_cache_retention', 'user'].includes(key)
      && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 || /\0/u.test(value))) {
      throw chatGptError('chatgpt_unsupported_parameter', `${key} must be a bounded string.`);
    }
  }
}

function controlWarning(key: string): string {
  if (key === 'temperature') return 'ignored_temperature';
  if (key === 'max_tokens' || key === 'max_completion_tokens') return 'ignored_max_completion_tokens';
  if (key === 'reasoning_effort') return 'reasoning_control_unavailable';
  return `ignored_${key}`;
}

function validateCompletion(value: unknown): NonNullable<GatewayExchangeInput['completion']> {
  if (!isRecord(value) || Object.keys(value).some((key) => !['request_id', 'claim_token', 'response', 'error'].includes(key))) {
    throw new Error('completion is invalid');
  }
  if (typeof value.request_id !== 'string' || !REQUEST_ID.test(value.request_id)) throw new Error('completion.request_id is invalid');
  if (typeof value.claim_token !== 'string' || !CLAIM_TOKEN.test(value.claim_token)) throw new Error('completion.claim_token is invalid');
  const hasResponse = value.response !== undefined;
  const hasError = value.error !== undefined;
  if (hasResponse === hasError) throw new Error('completion requires exactly one of response or error');
  if (hasResponse && typeof value.response !== 'string') {
    throw new Error('completion.response must be text');
  }
  if (hasError) {
    if (!isRecord(value.error) || Object.keys(value.error).some((key) => key !== 'code' && key !== 'message')) {
      throw new Error('completion.error is invalid');
    }
    if (typeof value.error.code !== 'string' || !ERROR_CODE.test(value.error.code)) throw new Error('completion.error.code is invalid');
    if (typeof value.error.message !== 'string' || !value.error.message.trim() || Buffer.byteLength(value.error.message, 'utf8') > 4096) {
      throw new Error('completion.error.message is invalid');
    }
  }
  return {
    request_id: value.request_id,
    claim_token: value.claim_token,
    ...(hasResponse ? { response: value.response as string } : {}),
    ...(hasError ? { error: value.error as { code: string; message: string } } : {}),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
