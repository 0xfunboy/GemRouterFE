import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Full-state backup ("configuratore"): one gemrouter.cfg file holding the complete
 * .env plus every file under data/ (accounts and their keys, registered apps,
 * surfaces, model config, ledgers, scoreboard, interactions/statistics). Importing
 * it on a fresh install restores the router to the exact snapshot state.
 *
 * The file contains every secret the router owns — treat it like a private key.
 */

const BACKUP_FORMAT = 'gemrouter-backup';
const BACKUP_VERSION = 1;
/** Individual files larger than this are skipped (nothing we persist comes close). */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface GemrouterBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  hostname: string;
  env: string | null;
  /** dataDir-relative path → file content (all persisted state is UTF-8 text). */
  files: Record<string, string>;
  skipped: Array<{ path: string; reason: string }>;
}

function walkFiles(baseDir: string, relative = ''): string[] {
  const absolute = path.join(baseDir, relative);
  const entries = readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) return walkFiles(baseDir, childRelative);
    if (entry.isFile()) return [childRelative];
    return [];
  });
}

export function buildBackup(input: { rootDir: string; dataDir: string }): GemrouterBackup {
  const files: Record<string, string> = {};
  const skipped: Array<{ path: string; reason: string }> = [];
  if (existsSync(input.dataDir)) {
    for (const relative of walkFiles(input.dataDir).sort()) {
      const absolute = path.join(input.dataDir, relative);
      try {
        const size = statSync(absolute).size;
        if (size > MAX_FILE_BYTES) {
          skipped.push({ path: relative, reason: `file too large (${size} bytes)` });
          continue;
        }
        files[relative] = readFileSync(absolute, 'utf8');
      } catch (error) {
        skipped.push({ path: relative, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const envPath = path.join(input.rootDir, '.env');
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    env: existsSync(envPath) ? readFileSync(envPath, 'utf8') : null,
    files,
    skipped,
  };
}

/** Counts-only view of what a snapshot would contain — safe to show in the dashboard. */
export function summarizeBackupContents(input: { rootDir: string; dataDir: string }): {
  dataFiles: number;
  totalBytes: number;
  envVars: number;
  envPresent: boolean;
} {
  let dataFiles = 0;
  let totalBytes = 0;
  if (existsSync(input.dataDir)) {
    for (const relative of walkFiles(input.dataDir)) {
      try {
        const size = statSync(path.join(input.dataDir, relative)).size;
        if (size > MAX_FILE_BYTES) continue;
        dataFiles += 1;
        totalBytes += size;
      } catch {
        // unreadable file: excluded from the snapshot too
      }
    }
  }
  const envPath = path.join(input.rootDir, '.env');
  const envPresent = existsSync(envPath);
  const envVars = envPresent
    ? readFileSync(envPath, 'utf8').split('\n').filter((line) => /^[A-Z0-9_]+=/.test(line.trim())).length
    : 0;
  return { dataFiles, totalBytes, envVars, envPresent };
}

function safeRelativePath(candidate: string): string | null {
  const normalized = path.normalize(candidate.trim());
  if (!normalized || normalized === '.' || path.isAbsolute(normalized)) return null;
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) return null;
  return normalized;
}

export function applyBackup(input: {
  rootDir: string;
  dataDir: string;
  payload: unknown;
}): {
  ok: boolean;
  error?: string;
  restoredFiles?: number;
  envRestored?: boolean;
  safetyCopyDir?: string;
  skippedPaths?: string[];
} {
  const backup = input.payload as Partial<GemrouterBackup> | null;
  if (!backup || typeof backup !== 'object' || backup.format !== BACKUP_FORMAT) {
    return { ok: false, error: 'Not a gemrouter backup file (missing format marker).' };
  }
  if (backup.version !== BACKUP_VERSION) {
    return { ok: false, error: `Unsupported backup version ${String(backup.version)}.` };
  }
  const files = backup.files && typeof backup.files === 'object' ? backup.files : {};
  const envText = typeof backup.env === 'string' ? backup.env : null;
  if (Object.keys(files).length === 0 && envText === null) {
    return { ok: false, error: 'Backup contains no env and no data files.' };
  }

  // Safety net: copy the current state aside before overwriting anything, so a bad
  // import can be undone by copying the snapshot back.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyCopyDir = path.join(input.rootDir, 'backups', `pre-import-${stamp}`);
  mkdirSync(safetyCopyDir, { recursive: true });
  if (existsSync(input.dataDir)) {
    cpSync(input.dataDir, path.join(safetyCopyDir, 'data'), { recursive: true });
  }
  const currentEnvPath = path.join(input.rootDir, '.env');
  if (existsSync(currentEnvPath)) {
    cpSync(currentEnvPath, path.join(safetyCopyDir, '.env'));
  }

  const skippedPaths: string[] = [];
  let restoredFiles = 0;
  for (const [rawPath, content] of Object.entries(files)) {
    const relative = safeRelativePath(rawPath);
    if (!relative || typeof content !== 'string') {
      skippedPaths.push(rawPath);
      continue;
    }
    const target = path.join(input.dataDir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    restoredFiles += 1;
  }
  let envRestored = false;
  if (envText !== null) {
    writeFileSync(currentEnvPath, envText);
    envRestored = true;
  }
  return { ok: true, restoredFiles, envRestored, safetyCopyDir, skippedPaths };
}
