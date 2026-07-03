import { LLMProviderError } from '../../errors.js';
import type { NvidiaUpstreamErrorSnapshot } from './types.js';

export type NvidiaErrorCode =
  | 'backend_disabled'
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

export class NvidiaProviderError extends LLMProviderError {
  constructor(
    code: NvidiaErrorCode,
    message: string,
    options: ConstructorParameters<typeof LLMProviderError>[3] & {
      lastUpstreamError?: NvidiaUpstreamErrorSnapshot | null;
    } = {},
  ) {
    super(code, 'nvidia', message, options);
  }
}
