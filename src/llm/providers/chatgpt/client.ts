import type { LLMClient, LLMMessage, LLMOptions, LLMResponse, LLMStreamChunk } from '../../types.js';
import { chatGptError } from './errors.js';
import { ChatGptGateway } from './gateway.js';

export function createChatGptClient(gateway: ChatGptGateway): LLMClient {
  async function chat(_messages: LLMMessage[], opts?: LLMOptions): Promise<LLMResponse> {
    const context = opts?.chatgpt;
    const alias = String(opts?.model ?? '').trim().toLowerCase();
    if (!context || !alias) throw chatGptError('chatgpt_protocol_error', 'Trusted ChatGPT routing context is missing.');
    const result = await gateway.submit({
      appId: context.appId,
      alias,
      messages: context.messages,
      surface: context.surface,
      fingerprint: context.fingerprint,
      idempotencyKey: context.idempotencyKey,
      controls: context.controls,
      signal: opts?.signal,
      deadline: opts?.deadline,
    });
    return {
      content: result.content,
      finishReason: 'stop',
      provider: 'chatgpt-mcp',
      model: alias,
      backend: 'chatgpt',
      backendModel: alias,
      modelVerification: 'operator_declared',
      declaredModel: result.worker.declaredModel,
      declaredReasoning: result.worker.declaredReasoning,
      usageSource: 'unavailable',
      contextMode: 'persistent_chat',
      contextEpoch: result.worker.contextEpoch,
      instructionVersion: result.worker.instructionVersion,
      streamingMode: 'buffered',
      queueWaitMs: result.queueWaitMs,
      processingWaitMs: result.processingWaitMs,
      latencyMs: result.totalLatencyMs,
      gatewayWarnings: result.warnings,
      gatewayProfile: context.controls.profile,
    };
  }

  return {
    provider: 'chatgpt-mcp',
    model: 'operator-configured-alias',
    chat,
    async *streamChat(messages: LLMMessage[], opts?: LLMOptions): AsyncGenerator<LLMStreamChunk, LLMResponse, void> {
      const response = await chat(messages, opts);
      if (response.content) yield { content: response.content };
      return response;
    },
    getDiagnostics: () => ({
      provider: 'chatgpt-mcp',
      enabled: true,
      aliases: gateway.registry.aliases(),
      workers: gateway.registry.list().map((worker) => gateway.store.workerStatus(worker.id)),
    }),
  };
}
