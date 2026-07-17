import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { pacificDayStartMs } from '../gemini-api/quotaLedger.js';

export interface AgnesConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  imageModels: string[];
  videoModels: string[];
  imageTimeoutMs: number;
  videoTimeoutMs: number;
  videoPollMs: number;
  usageStorePath: string;
}

export interface AgnesModelUsage {
  model: string;
  kind: 'image' | 'video';
  used: number;
}

export interface AgnesImageResult {
  url: string;
  revisedPrompt?: string;
}

export interface AgnesVideoResult {
  url: string;
  size?: string;
  seconds?: string;
}

export interface AgnesClient {
  config: AgnesConfig;
  isImageModel(model: string): boolean;
  isVideoModel(model: string): boolean;
  generateImage(model: string, prompt: string, opts?: { size?: string; n?: number }): Promise<AgnesImageResult[]>;
  generateVideo(model: string, prompt: string, opts?: { size?: string }): Promise<AgnesVideoResult>;
  usage(): AgnesModelUsage[];
  health(): Promise<Record<string, unknown>>;
}

function normalize(model: string | undefined): string {
  return String(model ?? '').trim().toLowerCase();
}

const IMAGE_503_RETRIES = 2;

/**
 * Client for the Agnes AI (Sapiens AI) OpenAI-compatible gateway. Images are synchronous
 * (POST /images/generations, occasionally 503 "service busy" so retried); video is a task:
 * POST /videos returns a task id, then GET /videos/{id} is polled until it completes.
 */
export function createAgnesClient(config: AgnesConfig): AgnesClient {
  const base = config.baseUrl.replace(/\/+$/, '');
  const imageSet = new Set(config.imageModels.map(normalize));
  const videoSet = new Set(config.videoModels.map(normalize));

  // Daily usage counters persisted like the local-Ollama ones (Pacific reset).
  const counters = new Map<string, number>();
  let countersDay = pacificDayStartMs();

  function persistCounters(): void {
    try {
      mkdirSync(path.dirname(config.usageStorePath), { recursive: true });
      writeFileSync(config.usageStorePath, `${JSON.stringify({ day: countersDay, counts: Object.fromEntries(counters) }, null, 2)}\n`, 'utf8');
    } catch {
      // counters are telemetry, never worth failing a request over
    }
  }
  function loadCounters(): void {
    if (!existsSync(config.usageStorePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(config.usageStorePath, 'utf8')) as { day?: number; counts?: Record<string, number> };
      if (parsed.day === countersDay && parsed.counts && typeof parsed.counts === 'object') {
        for (const [model, count] of Object.entries(parsed.counts)) {
          if (typeof count === 'number') counters.set(model, count);
        }
      }
    } catch {
      // ignore malformed file
    }
  }
  loadCounters();
  function rolloverIfNeeded(): void {
    const today = pacificDayStartMs();
    if (today !== countersDay) {
      counters.clear();
      countersDay = today;
      persistCounters();
    }
  }
  function bump(model: string): void {
    rolloverIfNeeded();
    counters.set(model, (counters.get(model) ?? 0) + 1);
    persistCounters();
  }

  async function post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; payload: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { status: response.status, payload };
  }

  function errorMessage(payload: Record<string, unknown>, fallback: string): string {
    const err = payload.error as { message?: string } | undefined;
    return err?.message ? String(err.message) : fallback;
  }

  return {
    config,
    isImageModel(model: string): boolean {
      return imageSet.has(normalize(model));
    },
    isVideoModel(model: string): boolean {
      return videoSet.has(normalize(model));
    },

    async generateImage(model: string, prompt: string, opts?: { size?: string; n?: number }): Promise<AgnesImageResult[]> {
      let lastError = 'Agnes image generation failed';
      for (let attempt = 0; attempt <= IMAGE_503_RETRIES; attempt += 1) {
        const { status, payload } = await post('/images/generations', {
          model,
          prompt,
          n: opts?.n ?? 1,
          size: opts?.size ?? '1024x1024',
        }, config.imageTimeoutMs);
        if (status === 200) {
          bump(model);
          const data = Array.isArray(payload.data) ? payload.data as Array<Record<string, unknown>> : [];
          return data
            .map((item) => ({ url: String(item.url ?? ''), revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined }))
            .filter((item) => item.url);
        }
        lastError = errorMessage(payload, `HTTP ${status}`);
        // 503 "service busy" is transient: back off briefly and retry.
        if (status === 503 && attempt < IMAGE_503_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        break;
      }
      throw new Error(lastError);
    },

    async generateVideo(model: string, prompt: string, opts?: { size?: string }): Promise<AgnesVideoResult> {
      const submit = await post('/videos', { model, prompt, ...(opts?.size ? { size: opts.size } : {}) }, 60_000);
      if (submit.status !== 200) {
        throw new Error(errorMessage(submit.payload, `video submit failed (HTTP ${submit.status})`));
      }
      const taskId = String(submit.payload.task_id ?? submit.payload.id ?? submit.payload.video_id ?? '');
      if (!taskId) throw new Error('Agnes video submit returned no task id');

      const deadline = Date.now() + config.videoTimeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, config.videoPollMs));
        const response = await fetch(`${base}/videos/${encodeURIComponent(taskId)}`, {
          headers: { authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(20_000),
        });
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        const statusStr = String(payload.status ?? '').toLowerCase();
        if (statusStr === 'completed' || statusStr === 'succeeded' || statusStr === 'success') {
          const meta = (payload.metadata as Record<string, unknown> | undefined) ?? {};
          const url = String(meta.url ?? payload.video_url ?? payload.url ?? '');
          if (!url) throw new Error('Agnes video completed without a URL');
          bump(model);
          return { url, size: meta.size ? String(meta.size) : undefined, seconds: payload.seconds ? String(payload.seconds) : undefined };
        }
        if (statusStr === 'failed' || statusStr === 'error') {
          throw new Error(errorMessage(payload, 'Agnes video generation failed'));
        }
      }
      throw new Error('Agnes video generation timed out');
    },

    usage(): AgnesModelUsage[] {
      rolloverIfNeeded();
      const rows: AgnesModelUsage[] = [];
      for (const model of config.imageModels) rows.push({ model, kind: 'image', used: counters.get(model) ?? 0 });
      for (const model of config.videoModels) rows.push({ model, kind: 'video', used: counters.get(model) ?? 0 });
      return rows;
    },

    async health(): Promise<Record<string, unknown>> {
      if (!config.enabled) return { enabled: false, available: false };
      try {
        const response = await fetch(`${base}/models`, {
          headers: { authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        return { enabled: true, available: response.ok, baseUrl: base };
      } catch (error) {
        return { enabled: true, available: false, baseUrl: base, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
