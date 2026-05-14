import type { LLMBackendId } from './types.js';

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
  | 'gemini_api_timeout'
  | 'gemini_api_stream_error';

export class LLMProviderError extends Error {
  constructor(
    public readonly code: LLMProviderErrorCode,
    public readonly backend: LLMBackendId,
    message: string,
    public readonly options: {
      statusCode?: number;
      fallbackEligible?: boolean;
      fallbackFrom?: LLMBackendId;
      fallbackReason?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}
