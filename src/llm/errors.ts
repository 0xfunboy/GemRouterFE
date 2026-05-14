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
  | 'gemini_api_upstream_error'
  | 'gemini_api_timeout'
  | 'gemini_api_stream_error'
  | 'cli_not_installed'
  | 'cli_auth_missing'
  | 'cli_auth_expired'
  | 'cli_validation_required'
  | 'cli_permission_denied'
  | 'cli_rate_limited'
  | 'cli_quota_exhausted'
  | 'cli_timeout'
  | 'cli_bad_output'
  | 'cli_process_error'
  | 'cli_policy_blocked'
  | 'cli_model_unsupported'
  | 'playwright_not_ready'
  | 'playwright_quota'
  | 'playwright_timeout'
  | 'playwright_process_error';

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
