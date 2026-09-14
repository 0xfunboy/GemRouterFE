import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';

import { ChatGptGatewayError } from '../src/llm/providers/chatgpt/errors.js';
import { createLlmRouter } from '../src/llm/router.js';
import type { LLMClient } from '../src/llm/types.js';

function client(provider: string, chat: LLMClient['chat']): LLMClient {
  return { provider, model: `${provider}-model`, chat };
}

describe('router ChatGPT isolation', () => {
  it('removes upstream abort listeners when requests finish', async () => {
    const upstream = new AbortController();
    const router = createLlmRouter({ backendOrder: ['gemini-api'] }, {
      geminiApi: client('gemini-api', async () => ({ content: 'done', provider: 'gemini-api', model: 'gemini-test' })),
    });
    for (let i = 0; i < 12; i += 1) {
      await router.chat([{ role: 'user', content: 'hello' }], { model: 'gemini-test', signal: upstream.signal });
    }
    assert.equal(getEventListeners(upstream.signal, 'abort').length, 0);
  });

  it('excludes ChatGPT from automatic dispatch even if injected into backend order', async () => {
    let workerCalls = 0;
    const router = createLlmRouter({ backendOrder: ['chatgpt', 'gemini-api'] }, {
      geminiApi: client('gemini-api', async () => ({ content: 'ordinary', provider: 'gemini-api', model: 'gemini-test' })),
      chatgpt: client('chatgpt-mcp', async () => {
        workerCalls += 1;
        return { content: 'unexpected', provider: 'chatgpt-mcp', model: 'private-alias' };
      }),
    });
    assert.equal((await router.chat([{ role: 'user', content: 'hello' }], { model: 'gemini-test' })).content, 'ordinary');
    assert.equal(workerCalls, 0);
  });

  it('never falls back from an explicit ChatGPT failure', async () => {
    let geminiCalls = 0;
    const router = createLlmRouter({ backendOrder: ['gemini-api'], requestDeadlineMs: 75 }, {
      geminiApi: client('gemini-api', async () => {
        geminiCalls += 1;
        return { content: 'wrong backend', provider: 'gemini-api', model: 'gemini-test' };
      }),
      chatgpt: client('chatgpt-mcp', async () => {
        throw new ChatGptGatewayError('chatgpt_worker_unavailable', 'offline', 503);
      }),
    });
    await assert.rejects(router.chat([{ role: 'user', content: 'x' }], {
      model: 'private-alias',
      backendPreference: 'chatgpt',
    }), (error: unknown) => error instanceof ChatGptGatewayError && error.code === 'chatgpt_worker_unavailable');
    assert.equal(geminiCalls, 0);
  });

  it('uses the trusted per-worker deadline without changing the other-provider default', async () => {
    const router = createLlmRouter({ backendOrder: ['gemini-api'], requestDeadlineMs: 20 }, {
      geminiApi: client('gemini-api', async () => ({ content: 'gemini', provider: 'gemini-api', model: 'gemini-test' })),
      chatgpt: client('chatgpt-mcp', async (_messages, options) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 45);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(options.signal?.reason);
          }, { once: true });
        });
        return { content: 'worker result', provider: 'chatgpt-mcp', model: 'private-alias' };
      }),
    });
    const response = await router.chat([{ role: 'user', content: 'x' }], {
      model: 'private-alias',
      backendPreference: 'chatgpt',
      requestDeadlineMs: 100,
    });
    assert.equal(response.content, 'worker result');
    assert.equal(response.backend, 'chatgpt');
  });
});
