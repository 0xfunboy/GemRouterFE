import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AuditEvent {
  ts: string;
  type: string;
  requestId?: string;
  appId?: string;
  route?: string;
  model?: string;
  statusCode?: number;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export class AuditLogger {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  write(event: Omit<AuditEvent, 'ts'>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    this.queue = this.queue
      .then(async () => {
        await writeFile(this.filePath, line, { encoding: 'utf8', flag: 'a' });
      })
      .catch((error) => {
        console.error('[audit] write failed:', error);
      });
  }
}
