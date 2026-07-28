import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LLMProviderError } from '../src/llm/errors.js';
import { createLlmRouter } from '../src/llm/router.js';
import type { LLMClient, LLMOptions, LLMResponse, LLMStreamChunk } from '../src/llm/types.js';

const messages = [{ role: 'user' as const, content: 'hello' }];

function response(provider: string, content: string): LLMResponse {
  return { provider, model: 'gemma-4-31b-it', content };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function client(
  provider: string,
  run: (opts?: LLMOptions) => Promise<LLMResponse>,
): LLMClient {
  return {
    provider,
    model: `${provider}-model`,
    chat: async (_messages, opts) => run(opts),
  };
}

async function consumeStream(
  stream: AsyncGenerator<LLMStreamChunk, LLMResponse, void>,
): Promise<{ content: string; response: LLMResponse }> {
  let content = '';
  while (true) {
    const next = await stream.next();
    if (next.done) return { content, response: next.value };
    content += next.value.content;
  }
}

describe('router: delayed cross-backend NVIDIA hedge', () => {
  it('does not launch NVIDIA when Gemini completes inside its head start', async () => {
    let nvidiaCalls = 0;
    const router = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 30,
      requestDeadlineMs: 200,
    }, {
      geminiApi: client('gemini-api', async (opts) => {
        await abortableDelay(2, opts?.signal);
        return response('gemini-api', 'gemini');
      }),
      nvidia: client('nvidia', async () => {
        nvidiaCalls += 1;
        return response('nvidia', 'nvidia');
      }),
    });

    const result = await router.chat(messages, { model: 'gemma-4-31b-it' });
    assert.equal(result.content, 'gemini');
    assert.equal(result.backend, 'gemini-api');
    assert.equal(result.fallbackAttempts, undefined, 'a cancelled/unlaunched hedge is not a failure');
    assert.equal(nvidiaCalls, 0);
  });

  it('launches one NVIDIA candidate after the delay and aborts a stalled Gemini loser', async () => {
    let geminiAborted = false;
    let nvidiaCalls = 0;
    let hedgeMarker = false;
    let geminiDeadline: number | undefined;
    let nvidiaDeadline: number | undefined;
    const router = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 5,
      requestDeadlineMs: 250,
    }, {
      geminiApi: client('gemini-api', async (opts) => {
        geminiDeadline = opts?.deadline;
        try {
          await abortableDelay(150, opts?.signal);
        } catch (error) {
          geminiAborted = true;
          throw error;
        }
        return response('gemini-api', 'late gemini');
      }),
      nvidia: client('nvidia', async (opts) => {
        nvidiaCalls += 1;
        nvidiaDeadline = opts?.deadline;
        hedgeMarker = (opts as LLMOptions & { __nvidiaRouterHedge?: boolean }).__nvidiaRouterHedge === true;
        await abortableDelay(2, opts?.signal);
        return response('nvidia', 'hedge');
      }),
    });

    const result = await router.chat(messages, { model: 'gemma-4-31b-it' });
    assert.equal(result.content, 'hedge');
    assert.equal(result.backend, 'nvidia');
    assert.equal(result.fallbackFrom, 'gemini-api');
    assert.equal(result.fallbackReason, 'nvidia_hedge_won');
    assert.equal(nvidiaCalls, 1);
    assert.equal(hedgeMarker, true);
    assert.equal(nvidiaDeadline, geminiDeadline, 'both branches share one absolute deadline');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(geminiAborted, true);
  });

  it('rejects an empty NVIDIA result and keeps waiting for Gemini', async () => {
    const router = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 1,
      requestDeadlineMs: 200,
    }, {
      geminiApi: client('gemini-api', async (opts) => {
        await abortableDelay(20, opts?.signal);
        return response('gemini-api', 'usable');
      }),
      nvidia: client('nvidia', async () => response('nvidia', '   ')),
    });

    const result = await router.chat(messages, { model: 'gemma-4-31b-it' });
    assert.equal(result.content, 'usable');
    assert.equal(result.backend, 'gemini-api');
  });

  it('never hedges an incompatible or strict model', async () => {
    let nvidiaCalls = 0;
    const nvidia = client('nvidia', async () => {
      nvidiaCalls += 1;
      return response('nvidia', 'unexpected');
    });
    const incompatible = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 0,
    }, {
      geminiApi: client('gemini-api', async () => response('gemini-api', 'gemini')),
      nvidia,
    });
    const strict = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      strictModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 0,
    }, {
      geminiApi: client('gemini-api', async () => response('gemini-api', 'gemini')),
      nvidia,
    });

    await incompatible.chat(messages, { model: 'gemini-3.5-flash' });
    await strict.chat(messages, { model: 'gemma-4-31b-it' });
    assert.equal(nvidiaCalls, 0);
  });

  it('hedges a non-NVIDIA Gemini model through allowed nvidia-auto without widening policy', async () => {
    let nvidiaCalls = 0;
    let nvidiaModel: string | undefined;
    let nvidiaTier: string | undefined;
    const nvidia = client('nvidia', async (opts) => {
      nvidiaCalls += 1;
      nvidiaModel = opts?.model;
      nvidiaTier = opts?.tier;
      return response('nvidia', 'auto hedge');
    });
    const allowedRouter = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 1,
      requestDeadlineMs: 200,
    }, {
      geminiApi: client('gemini-api', async (opts) => {
        await abortableDelay(100, opts?.signal);
        return response('gemini-api', 'late');
      }),
      nvidia,
    });

    const result = await allowedRouter.chat(messages, {
      model: 'gemini-3.6-flash',
      allowedModelIds: ['gemini-3.6-flash', 'nvidia-auto'],
    });
    assert.equal(result.content, 'auto hedge');
    assert.equal(nvidiaModel, 'nvidia-auto');
    assert.equal(nvidiaTier, 'large');
    assert.equal(nvidiaCalls, 1);

    const customRouter = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 0,
    }, {
      geminiApi: client('gemini-api', async () => response('gemini-api', 'custom gemini')),
      nvidia,
    });
    const customResult = await customRouter.chat(messages, {
      model: 'gemini-3.6-flash',
      allowedModelIds: ['gemini-3.6-flash'],
    });
    assert.equal(customResult.content, 'custom gemini');
    assert.equal(nvidiaCalls, 1, 'custom allowlist without nvidia-auto must not launch it');
  });

  it('attaches a real failed NVIDIA hedge attempt when Gemini later wins', async () => {
    const router = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 1,
      requestDeadlineMs: 200,
    }, {
      geminiApi: client('gemini-api', async (opts) => {
        await abortableDelay(20, opts?.signal);
        return response('gemini-api', 'gemini winner');
      }),
      nvidia: client('nvidia', async () => {
        throw new LLMProviderError('nvidia_upstream_error', 'nvidia', 'upstream failed', {
          statusCode: 503,
          fallbackEligible: true,
          fallbackAttempts: [{
            model: 'vendor/actual',
            backend: 'nvidia',
            provider: 'nvidia',
            reason: 'nvidia_upstream_error',
            statusCode: 503,
          }],
        });
      }),
    });

    const result = await router.chat(messages, {
      model: 'gemini-3.6-flash',
      allowedModelIds: ['gemini-3.6-flash', 'nvidia-auto'],
    });
    assert.equal(result.content, 'gemini winner');
    assert.deepEqual(result.fallbackAttempts, [{
      model: 'vendor/actual',
      backend: 'nvidia',
      provider: 'nvidia',
      reason: 'nvidia_upstream_error',
      statusCode: 503,
    }]);
  });

  it('preserves a local NVIDIA hedge skip without inventing HTTP 429 evidence', async () => {
    const router = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaHedgeDelayMs: 1,
      requestDeadlineMs: 200,
    }, {
      geminiApi: client('gemini-api', async (opts) => {
        await abortableDelay(20, opts?.signal);
        return response('gemini-api', 'gemini winner');
      }),
      nvidia: client('nvidia', async () => {
        throw new LLMProviderError('nvidia_rate_limited', 'nvidia', 'local RPM full', {
          statusCode: 429,
          fallbackEligible: true,
          fallbackAttempts: [{
            model: 'vendor/local',
            backend: 'nvidia',
            provider: 'nvidia',
            reason: 'local_nvidia_rpm_unavailable',
            statusCode: null,
          }],
        });
      }),
    });

    const result = await router.chat(messages, {
      model: 'gemini-3.6-flash',
      allowedModelIds: ['gemini-3.6-flash', 'nvidia-auto'],
    });
    assert.deepEqual(result.fallbackAttempts, [{
      model: 'vendor/local',
      backend: 'nvidia',
      provider: 'nvidia',
      reason: 'local_nvidia_rpm_unavailable',
      statusCode: null,
    }]);
  });

  it('keeps explicit NVIDIA requests on the normal NVIDIA path', async () => {
    let hedgeMarker = false;
    const router = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 0,
    }, {
      geminiApi: client('gemini-api', async () => {
        throw new LLMProviderError('backend_unavailable', 'gemini-api', 'must not run');
      }),
      nvidia: client('nvidia', async (opts) => {
        hedgeMarker = (opts as LLMOptions & { __nvidiaRouterHedge?: boolean }).__nvidiaRouterHedge === true;
        return response('nvidia', 'direct');
      }),
    });

    const result = await router.chat(messages, {
      model: 'gemma-4-31b-it',
      backendPreference: 'nvidia',
    });
    assert.equal(result.content, 'direct');
    assert.equal(hedgeMarker, false);
  });

  it('uses the same one-candidate hedge before a Gemini stream emits visible output', async () => {
    let geminiAborted = false;
    let hedgeMarker = false;
    const geminiApi: LLMClient = {
      provider: 'gemini-api',
      model: 'gemma-4-31b-it',
      chat: async () => response('gemini-api', 'unused'),
      async *streamChat(_messages, opts) {
        try {
          await abortableDelay(150, opts?.signal);
        } catch (error) {
          geminiAborted = true;
          throw error;
        }
        yield { content: 'late' };
        return response('gemini-api', 'late');
      },
    };
    const router = createLlmRouter({
      backendOrder: ['gemini-api', 'nvidia'],
      nvidiaServableModelIds: ['gemma-4-31b-it'],
      nvidiaHedgeDelayMs: 5,
      requestDeadlineMs: 250,
    }, {
      geminiApi,
      nvidia: client('nvidia', async (opts) => {
        hedgeMarker = (opts as LLMOptions & { __nvidiaRouterHedge?: boolean }).__nvidiaRouterHedge === true;
        await abortableDelay(2, opts?.signal);
        return response('nvidia', 'stream hedge');
      }),
    });

    const result = await consumeStream(router.streamChat!(messages, { model: 'gemma-4-31b-it' }));
    assert.equal(result.content, 'stream hedge');
    assert.equal(result.response.backend, 'nvidia');
    assert.equal(hedgeMarker, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(geminiAborted, true);
  });
});
