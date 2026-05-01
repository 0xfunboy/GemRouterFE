import type { LLMBackendId } from './types.js';

export type LLMProviderErrorCode =
  | 'backend_disabled'
  | 'backend_unavailable'
  | 'cli_not_installed'
  | 'cli_auth_missing'
  | 'cli_auth_expired'
  | 'cli_timeout'
  | 'cli_bad_output'
  | 'cli_process_error'
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
