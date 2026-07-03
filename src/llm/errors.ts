import type { LLMBackendId, LLMFallbackAttempt } from './types.js';

export type LLMProviderErrorCode =
  | 'backend_disabled'
  | 'backend_unavailable'
  | 'gemini_api_missing_key'
  | 'gemini_api_no_key_for_model'
  | 'gemini_api_rate_limited'
  | 'gemini_api_quota_unavailable'
  | 'gemini_api_auth_failed'
  | 'gemini_api_invalid_request'
  | 'gemini_api_model_not_found'
  | 'gemini_api_high_demand'
  | 'gemini_api_upstream_error'
  | 'gemini_api_empty_response'
  | 'gemini_api_timeout'
  | 'gemini_api_stream_error'
  | 'ollama_model_not_found'
  | 'ollama_missing_endpoint'
  | 'ollama_upstream_error'
  | 'ollama_timeout'
  | 'nvidia_missing_key'
  | 'nvidia_no_model_available'
  | 'nvidia_rate_limited'
  | 'nvidia_auth_failed'
  | 'nvidia_invalid_request'
  | 'nvidia_model_not_found'
  | 'nvidia_upstream_error'
  | 'nvidia_empty_response'
  | 'nvidia_timeout'
  | 'nvidia_stream_error';

export interface LLMProviderErrorOptions {
  statusCode?: number;
  fallbackEligible?: boolean;
  fallbackFrom?: LLMBackendId;
  fallbackReason?: string;
  fallbackAttempts?: LLMFallbackAttempt[];
  upstreamModel?: string | null;
  upstreamApiKeyId?: string | null;
  upstreamQuotaGroup?: string | null;
  lastUpstreamError?: unknown;
  cause?: unknown;
}

export class LLMProviderError extends Error {
  constructor(
    public readonly code: LLMProviderErrorCode,
    public readonly backend: LLMBackendId,
    message: string,
    public readonly options: LLMProviderErrorOptions = {},
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}
