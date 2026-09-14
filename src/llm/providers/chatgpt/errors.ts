import { LLMProviderError, type LLMProviderErrorCode } from '../../errors.js';

export type ChatGptGatewayErrorCode =
  | 'chatgpt_feature_disabled'
  | 'chatgpt_model_not_found'
  | 'chatgpt_model_not_allowed'
  | 'chatgpt_backend_mismatch'
  | 'chatgpt_unsupported_surface'
  | 'chatgpt_unsupported_parameter'
  | 'chatgpt_context_reset_unsupported'
  | 'chatgpt_payload_too_large'
  | 'chatgpt_idempotency_conflict'
  | 'chatgpt_queue_full'
  | 'chatgpt_worker_unavailable'
  | 'chatgpt_queue_timeout'
  | 'chatgpt_request_timeout'
  | 'chatgpt_completion_failed'
  | 'chatgpt_invalid_json'
  | 'chatgpt_empty_response'
  | 'chatgpt_gateway_restarted'
  | 'chatgpt_request_cancelled'
  | 'chatgpt_store_unavailable'
  | 'chatgpt_protocol_error';

export class ChatGptGatewayError extends LLMProviderError {
  declare readonly code: ChatGptGatewayErrorCode;

  constructor(code: ChatGptGatewayErrorCode, message: string, statusCode: number, cause?: unknown) {
    super(code as LLMProviderErrorCode, 'chatgpt', message, {
      statusCode,
      fallbackEligible: false,
      cause,
    });
    this.name = 'ChatGptGatewayError';
  }
}

export function chatGptError(code: ChatGptGatewayErrorCode, message?: string): ChatGptGatewayError {
  const defaults: Record<ChatGptGatewayErrorCode, [number, string]> = {
    chatgpt_feature_disabled: [503, 'The ChatGPT MCP gateway is disabled.'],
    chatgpt_model_not_found: [404, 'The requested ChatGPT alias is not configured.'],
    chatgpt_model_not_allowed: [403, 'This app is not authorized for the requested ChatGPT worker.'],
    chatgpt_backend_mismatch: [400, 'The requested model belongs to the ChatGPT backend.'],
    chatgpt_unsupported_surface: [400, 'The ChatGPT backend is not supported on this API surface.'],
    chatgpt_unsupported_parameter: [400, 'The request contains a parameter the ChatGPT gateway cannot honor.'],
    chatgpt_context_reset_unsupported: [400, 'This backend cannot guarantee a context reset or stateless conversation.'],
    chatgpt_payload_too_large: [413, 'The ChatGPT gateway request exceeds its configured byte limit.'],
    chatgpt_idempotency_conflict: [409, 'The idempotency key was already used with a different request.'],
    chatgpt_queue_full: [429, 'The selected ChatGPT worker queue is full.'],
    chatgpt_worker_unavailable: [503, 'The selected ChatGPT worker is not actively polling; wake its dedicated chat.'],
    chatgpt_queue_timeout: [504, 'The request expired before the ChatGPT worker claimed it.'],
    chatgpt_request_timeout: [504, 'The ChatGPT worker did not complete the request before its deadline.'],
    chatgpt_completion_failed: [502, 'The ChatGPT worker reported a completion failure.'],
    chatgpt_invalid_json: [502, 'The ChatGPT worker response is not a valid JSON object.'],
    chatgpt_empty_response: [502, 'The ChatGPT worker returned an empty response.'],
    chatgpt_gateway_restarted: [503, 'The request was interrupted because the ChatGPT gateway restarted.'],
    chatgpt_request_cancelled: [499, 'The ChatGPT gateway request was cancelled.'],
    chatgpt_store_unavailable: [503, 'The ChatGPT gateway store is unavailable.'],
    chatgpt_protocol_error: [400, 'The ChatGPT gateway protocol request is invalid.'],
  };
  const [status, fallback] = defaults[code];
  return new ChatGptGatewayError(code, message ?? fallback, status);
}
