import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { coerceCompatibilityState, type ApiSurface } from '../lib/compatibility.js';

export interface CompatibilitySettingsRecord {
  defaultSurface: ApiSurface;
  enabledSurfaces: ApiSurface[];
  updatedAt: string;
}

interface UpdateCompatibilityInput {
  defaultSurface?: unknown;
  enabledSurfaces?: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeRecord(
  input: UpdateCompatibilityInput,
  fallback: CompatibilitySettingsRecord,
): CompatibilitySettingsRecord {
  const normalized = coerceCompatibilityState({
    defaultSurface: input.defaultSurface ?? fallback.defaultSurface,
    enabledSurfaces: input.enabledSurfaces ?? fallback.enabledSurfaces,
  });
  return {
    ...normalized,
    updatedAt: nowIso(),
  };
}

export class CompatibilityStore {
  private state: CompatibilitySettingsRecord;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    defaults: { defaultSurface: ApiSurface; enabledSurfaces: ApiSurface[] },
  ) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.state = sanitizeRecord(defaults, {
      defaultSurface: defaults.defaultSurface,
      enabledSurfaces: [...defaults.enabledSurfaces],
      updatedAt: nowIso(),
    });
    this.load();
  }

  get(): CompatibilitySettingsRecord {
    return {
      defaultSurface: this.state.defaultSurface,
      enabledSurfaces: [...this.state.enabledSurfaces],
      updatedAt: this.state.updatedAt,
    };
  }

  update(input: UpdateCompatibilityInput): CompatibilitySettingsRecord {
    this.state = sanitizeRecord(input, this.state);
    this.save();
    return this.get();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as UpdateCompatibilityInput;
      this.state = sanitizeRecord(parsed, this.state);
    } catch {
      this.save();
    }
  }

  private save(): void {
    const payload = JSON.stringify(this.state, null, 2);
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await writeFile(this.filePath, `${payload}\n`, 'utf8');
      });
  }
}
