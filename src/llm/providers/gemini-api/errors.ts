import { LLMProviderError } from '../../errors.js';
import type { GeminiApiUpstreamErrorSnapshot } from './types.js';

export type GeminiApiErrorCode =
  | 'backend_disabled'
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
  | 'gemini_api_stream_error';

export class GeminiApiProviderError extends LLMProviderError {
  constructor(
    code: GeminiApiErrorCode,
    message: string,
    options: ConstructorParameters<typeof LLMProviderError>[3] & {
      lastUpstreamError?: GeminiApiUpstreamErrorSnapshot | null;
    } = {},
  ) {
    super(code, 'gemini-api', message, options);
  }
}
