import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

import { LLMProviderError } from '../src/llm/errors.js';
import { createNvidiaClient } from '../src/llm/providers/nvidia/client.js';
import type { NvidiaModelConfig, NvidiaProviderConfig } from '../src/llm/providers/nvidia/types.js';
import type { LLMOptions } from '../src/llm/types.js';

const originalFetch = globalThis.fetch;
const workDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
});
after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

function config(models: NvidiaModelConfig[], overrides: Partial<NvidiaProviderConfig> = {}): NvidiaProviderConfig {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-nvidia-client-'));
  workDirs.push(dir);
  return {
    enabled: true,
    apiKey: 'test-key',
    baseUrl: 'https://nvidia.invalid',
    modelsPath: path.join(dir, 'models.json'),
    models,
    defaultTier: 'medium',
    rpmLimit: 100,
    maxConcurrency: 10,
    timeoutMs: 500,
    firstTokenTimeoutMs: 15,
    rateLimitCooldownMs: 60_000,
    scoreboardPath: path.join(dir, 'scoreboard.json'),
    probeEnabled: false,
    probeIntervalMs: 0,
    probeMaxTokens: 4,
    raceEnabled: true,
    raceHedgeDelayMs: 5,
    raceMaxCandidates: 3,
    ...overrides,
  };
}

function sseResponse(
  signal: AbortSignal | undefined,
  chunks: Array<{ afterMs: number; payload: string }>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      let closed = false;
      const cleanup = () => {
        for (const timer of timers) clearTimeout(timer);
      };
      const abort = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.error(signal?.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      for (const [index, chunk] of chunks.entries()) {
        timers.push(setTimeout(() => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${chunk.payload}\n\n`));
          if (index === chunks.length - 1) {
            closed = true;
            controller.close();
          }
        }, chunk.afterMs));
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const mediumModel = (id: string): NvidiaModelConfig => ({
  id,
  tier: 'medium',
  enabled: true,
  probe: false,
});

describe('NVIDIA client resilience', () => {
  it('treats hidden reasoning as first-token activity without returning it', async () => {
    globalThis.fetch = async (_url, init) => sseResponse(init?.signal as AbortSignal | undefined, [
      {
        afterMs: 2,
        payload: JSON.stringify({ choices: [{ delta: { reasoning_content: 'private thought' } }] }),
      },
      {
        // Later than firstTokenTimeoutMs: this succeeds only if hidden reasoning
        // cancelled the watchdog.
        afterMs: 35,
        payload: JSON.stringify({ choices: [{ delta: { content: 'visible answer' }, finish_reason: 'stop' }] }),
      },
      { afterMs: 38, payload: '[DONE]' },
    ]);
    const llm = createNvidiaClient(config([mediumModel('vendor/model-a')], {
      firstTokenTimeoutMs: 10,
      timeoutMs: 100,
    }));

    const result = await llm.chat([{ role: 'user', content: 'test' }], {
      model: 'vendor/model-a',
      thinking: { includeThoughts: false },
    });
    assert.equal(result.content, 'visible answer');
    assert.doesNotMatch(result.content, /private thought/);
  });

  it('does not accept a stream containing only hidden reasoning', async () => {
    globalThis.fetch = async (_url, init) => sseResponse(init?.signal as AbortSignal | undefined, [
      {
        afterMs: 1,
        payload: JSON.stringify({ choices: [{ delta: { reasoning_content: 'private only' } }] }),
      },
      { afterMs: 3, payload: '[DONE]' },
    ]);
    const llm = createNvidiaClient(config([mediumModel('vendor/model-a')]));

    await assert.rejects(
      llm.chat([{ role: 'user', content: 'test' }], {
        model: 'vendor/model-a',
        thinking: { includeThoughts: false },
      }),
      (error: unknown) => error instanceof LLMProviderError && error.code === 'nvidia_empty_response',
    );
  });

  it('does not let reasoning-only output win even when thoughts were requested', async () => {
    globalThis.fetch = async (_url, init) => sseResponse(init?.signal as AbortSignal | undefined, [
      {
        afterMs: 1,
        payload: JSON.stringify({ choices: [{ delta: { reasoning_content: 'requested thought only' } }] }),
      },
      { afterMs: 3, payload: '[DONE]' },
    ]);
    const llm = createNvidiaClient(config([mediumModel('vendor/model-a')]));

    await assert.rejects(
      llm.chat([{ role: 'user', content: 'test' }], {
        model: 'vendor/model-a',
        thinking: { includeThoughts: true },
      }),
      (error: unknown) => error instanceof LLMProviderError && error.code === 'nvidia_empty_response',
    );
  });

  it('spends exactly one model candidate for a cross-backend hedge', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    };
    const llm = createNvidiaClient(config([
      mediumModel('vendor/model-a'),
      mediumModel('vendor/model-b'),
    ]));
    const opts: LLMOptions & { __nvidiaRouterHedge?: true } = {
      model: 'vendor/model-a',
      __nvidiaRouterHedge: true,
    };

    await assert.rejects(llm.chat([{ role: 'user', content: 'test' }], opts));
    assert.equal(calls, 1);
  });

  it('clamps a stalled attempt to the shared absolute deadline', async () => {
    globalThis.fetch = async (_url, init) => sseResponse(init?.signal as AbortSignal | undefined, [
      // Kept beyond the deadline; the abort listener closes the stream first.
      {
        afterMs: 1_000,
        payload: JSON.stringify({ choices: [{ delta: { content: 'too late' } }] }),
      },
    ]);
    const llm = createNvidiaClient(config([mediumModel('vendor/model-a')], {
      firstTokenTimeoutMs: 5_000,
      timeoutMs: 5_000,
    }));
    const started = Date.now();

    await assert.rejects(llm.chat([{ role: 'user', content: 'test' }], {
      model: 'vendor/model-a',
      deadline: Date.now() + 25,
    }));
    assert.ok(Date.now() - started < 250, 'attempt must not inherit the old one-second minimum');
  });

  it('reports a local NVIDIA RPM skip without a synthetic upstream 429', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('fetch must not run');
    };
    const llm = createNvidiaClient(config([mediumModel('vendor/model-a')], {
      rpmLimit: 0,
    }));
    const opts: LLMOptions & { __nvidiaRouterHedge?: true } = {
      model: 'vendor/model-a',
      __nvidiaRouterHedge: true,
    };

    await assert.rejects(
      llm.chat([{ role: 'user', content: 'test' }], opts),
      (error: unknown) => {
        assert.ok(error instanceof LLMProviderError);
        assert.deepEqual(error.options.fallbackAttempts, [{
          model: 'vendor/model-a',
          backend: 'nvidia',
          provider: 'nvidia',
          reason: 'local_nvidia_rpm_unavailable',
          statusCode: null,
        }]);
        return true;
      },
    );
    assert.equal(calls, 0);
  });
});
