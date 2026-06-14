import { LLMProviderError } from '../../errors.js';
import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../../types.js';

export interface DeepSeekApiConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  timeoutMs: number;
}

interface DeepSeekApiDeps {
  fetch?: typeof fetch;
}

function parseOpenAiContent(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return '';
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message;
  if (message && typeof message === 'object' && typeof (message as Record<string, unknown>).content === 'string') {
    return String((message as Record<string, unknown>).content);
  }
  if (typeof first?.text === 'string') return first.text;
  return '';
}

function parseUsage(body: unknown): LLMResponse['usage'] {
  if (!body || typeof body !== 'object') return undefined;
  const usage = (body as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const typed = usage as Record<string, unknown>;
  return {
    promptTokens: typeof typed.prompt_tokens === 'number' ? typed.prompt_tokens : undefined,
    completionTokens: typeof typed.completion_tokens === 'number' ? typed.completion_tokens : undefined,
    totalTokens: typeof typed.total_tokens === 'number' ? typed.total_tokens : undefined,
  };
}

function mapStatus(status: number): LLMProviderError['code'] {
  if (status === 401 || status === 403) return 'deepseek_api_auth_failed';
  if (status === 404) return 'deepseek_api_model_not_found';
  if (status === 400) return 'deepseek_api_invalid_request';
  if (status === 429) return 'deepseek_api_rate_limited';
  return 'deepseek_api_upstream_error';
}

export function createDeepSeekApiClient(
  config: DeepSeekApiConfig,
  deps: DeepSeekApiDeps = {},
): LLMClient & { health(): Record<string, unknown> } {
  const outboundFetch = deps.fetch ?? fetch;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastModel: string | null = null;
  let lastError: string | null = null;

  async function requestChat(messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    if (!config.enabled) {
      throw new LLMProviderError('backend_disabled', 'deepseek-api', 'DeepSeek API backend is disabled.', { statusCode: 503, fallbackEligible: true });
    }
    if (!config.apiKey) {
      throw new LLMProviderError('deepseek_api_missing_key', 'deepseek-api', 'DeepSeek API key is not configured.', { statusCode: 503, fallbackEligible: true });
    }

    const model = opts?.model && config.models.includes(opts.model) ? opts.model : config.defaultModel;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const startedAt = Date.now();
    lastModel = model;

    try {
      const response = await outboundFetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: opts?.maxTokens,
          temperature: opts?.temperature,
          stream: false,
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) as unknown : {};
      if (!response.ok) {
        throw new LLMProviderError(mapStatus(response.status), 'deepseek-api', `DeepSeek API returned HTTP ${response.status}.`, {
          statusCode: response.status,
          fallbackEligible: response.status >= 500 || response.status === 429 || response.status === 404,
          lastUpstreamError: body,
        });
      }
      const content = parseOpenAiContent(body);
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      return {
        content,
        provider: 'deepseek-api',
        model,
        backend: 'deepseek-api',
        backendModel: model,
        usage: parseUsage(body),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastFailureAt = new Date().toISOString();
      if (error instanceof LLMProviderError) {
        lastError = error.message;
        throw error;
      }
      const isAbort = error instanceof Error && error.name === 'AbortError';
      lastError = isAbort ? 'DeepSeek API request timed out.' : String(error instanceof Error ? error.message : error);
      throw new LLMProviderError(isAbort ? 'deepseek_api_timeout' : 'deepseek_api_upstream_error', 'deepseek-api', lastError, {
        statusCode: isAbort ? 504 : 502,
        fallbackEligible: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    provider: 'deepseek-api',
    model: config.defaultModel,
    chat: requestChat,
    async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
      const response = await requestChat(messages, opts);
      if (response.content) yield { content: response.content };
      return response;
    },
    health(): Record<string, unknown> {
      return {
        enabled: config.enabled,
        available: config.enabled && Boolean(config.apiKey),
        provider: 'deepseek-api',
        models: config.models.map((model) => ({
          id: model,
          name: model,
          provider: 'deepseek-api',
          family: 'deepseek',
          capabilities: { chat: true },
        })),
        defaultModel: config.defaultModel,
        lastModel,
        lastSuccessAt,
        lastFailureAt,
        lastError,
      };
    },
  };
}
