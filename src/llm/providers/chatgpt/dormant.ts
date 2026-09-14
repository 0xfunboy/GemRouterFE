import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Read persisted aliases without initializing the gateway or mutating its state.
 *
 * A disabled gateway must stay operationally dormant, but a previously registered
 * bare alias still has to remain reserved so that it cannot fall through to another
 * provider after a restart. Opening SQLite read-only preserves both properties.
 */
export function readDormantChatGptAliases(dataDir: string): Set<string> {
  const dbPath = path.join(dataDir, 'gateway.sqlite');
  if (!existsSync(dbPath)) return new Set();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type='table' AND name='worker_aliases'
    `).get();
    if (!table) return new Set();

    const rows = db.prepare('SELECT alias FROM worker_aliases').all() as Array<{ alias?: unknown }>;
    return new Set(rows.flatMap((row) => {
      if (typeof row.alias !== 'string') return [];
      const alias = row.alias.trim().toLowerCase();
      return alias ? [alias] : [];
    }));
  } catch (error) {
    throw new Error(
      `Unable to read dormant ChatGPT aliases from ${dbPath}; refusing unsafe provider fallback.`,
      { cause: error },
    );
  } finally {
    db.close();
  }
}
