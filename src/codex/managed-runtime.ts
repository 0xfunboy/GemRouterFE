import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CodexRuntime, CodexRuntimeError } from './runtime.js';

const exec = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
export function newerRuntime(candidate: string, installed: string) {
  if (!versionPattern.test(candidate) || !versionPattern.test(installed)) return false;
  const numbers = (v: string) => v.split('-')[0].split('.').map(Number);
  const a = numbers(candidate), b = numbers(installed);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  // Updates track official stable/latest, not arbitrary prerelease ordering.
  return !candidate.includes('-') && installed.includes('-');
}
const manifestSchema = z.object({ version: z.string().regex(versionPattern), platform: z.literal('linux-x64'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/=]+$/), archiveParts: z.number().int().min(1).max(8), license: z.literal('Apache-2.0') }).strict();
export type RuntimeManifest = z.infer<typeof manifestSchema>;
export async function fileHash(file: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
function officialUrl(value: unknown): string {
  if (typeof value !== 'string') throw new CodexRuntimeError('codex_update_source_invalid');
  const url = new URL(value);
  if (url.origin !== 'https://registry.npmjs.org' || !url.pathname.startsWith('/@openai/codex/') || url.username || url.password || url.search || url.hash)
    throw new CodexRuntimeError('codex_update_source_invalid');
  return url.href;
}
async function boundedFetch(url: string, limit: number, timeout = 15_000): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length')) > limit || !response.body) throw new CodexRuntimeError('codex_update_download_failed');
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) { await reader.cancel(); throw new CodexRuntimeError('codex_update_download_too_large'); } chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
/** Only official, version-pinned platform tarballs. No npm scripts or arbitrary URLs. */
export async function downloadOfficialRuntime(version: string, directory: string) {
  if (!versionPattern.test(version)) throw new CodexRuntimeError('codex_update_version_invalid');
  const metadata = JSON.parse((await boundedFetch(`https://registry.npmjs.org/@openai%2Fcodex/${version}-linux-x64`, 2 * 1024 * 1024)).toString());
  if (metadata.name !== '@openai/codex' || metadata.version !== `${version}-linux-x64` || !/^sha512-[A-Za-z0-9+/=]+$/.test(metadata.dist?.integrity ?? '')) throw new CodexRuntimeError('codex_update_metadata_invalid');
  const archive = await boundedFetch(officialUrl(metadata.dist.tarball), 200 * 1024 * 1024, 120_000);
  if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== metadata.dist.integrity) throw new CodexRuntimeError('codex_update_integrity_failed');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tar = join(directory, 'package.tgz'), command = join(directory, 'codex');
  await writeFile(tar, archive, { mode: 0o600, flag: 'wx' });
  // Extract one exact regular-file member to stdout; never unpack archive paths.
  const members = (await exec('tar', ['-tzf', tar], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim().split('\n');
  const allowed = ['package/vendor/x86_64-unknown-linux-musl/bin/codex', 'package/vendor/x86_64-unknown-linux-musl/codex/codex'];
  const member = allowed.find((m) => members.includes(m));
  if (!member) throw new CodexRuntimeError('codex_update_archive_invalid');
  const result = await exec('tar', ['-xOzf', tar, member], { encoding: 'buffer', timeout: 60_000, maxBuffer: 512 * 1024 * 1024 });
  if (!result.stdout.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new CodexRuntimeError('codex_update_executable_invalid');
  await writeFile(command, result.stdout, { mode: 0o700, flag: 'wx' }); await rm(tar);
  return { command, version, sha256: await fileHash(command), integrity: metadata.dist.integrity as string };
}
export class ManagedCodexRuntime {
  private active: RuntimeManifest | null = null;
  private checking: Promise<void> | null = null;
  private updating: Promise<void> | null = null;
  private latest: string | null = null;
  private checkedAt: string | null = null;
  private error: string | null = null;
  private phase = 'idle';
  private changes: unknown = null;
  readonly directory: string;
  constructor(readonly root: string, readonly enabled: boolean) { this.directory = join(root, '.runtime', 'codex'); }
  snapshot() { return { managed: this.enabled, version: this.active?.version ?? null, latestVersion: this.latest,
    updateAvailable: Boolean(this.latest && this.active && newerRuntime(this.latest, this.active.version)), checkedAt: this.checkedAt,
    phase: this.phase, error: this.error, changes: this.changes }; }
  private command(manifest: RuntimeManifest) { return join(this.directory, 'versions', manifest.version, 'codex'); }
  async prepare(): Promise<{ command: string; version: string } | null> {
    if (!this.enabled) return null;
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new CodexRuntimeError('codex_runtime_platform_unsupported');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Recover only verified private pointers. Corruption is visible, never executed.
    let manifest: RuntimeManifest;
    try {
      const pointer = join(this.directory, 'current.json'), stat = await lstat(pointer);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > 4096) throw Error();
      manifest = manifestSchema.parse(JSON.parse(await readFile(pointer, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new CodexRuntimeError('codex_runtime_pointer_invalid');
      manifest = manifestSchema.parse(JSON.parse(await readFile(join(this.root, 'vendor/codex/manifest.json'), 'utf8')));
      const parts = Array.from({ length: manifest.archiveParts }, (_, i) => join(this.root, 'vendor/codex/linux-x64', `codex.gz.${String(i + 1).padStart(3, '0')}`));
      async function* chunks() { for (const part of parts) yield* createReadStream(part); }
      const hash = createHash('sha256'); for await (const chunk of chunks()) hash.update(chunk);
      if (hash.digest('hex') !== manifest.archiveSha256) throw new CodexRuntimeError('codex_runtime_integrity_failed');
      await mkdir(join(this.directory, 'versions'), { recursive: true, mode: 0o700 });
      const staged = await mkdtemp(join(this.directory, 'versions', '.extract-'));
      try {
        await pipeline(Readable.from(chunks()), createGunzip(), createWriteStream(join(staged, 'codex'), { mode: 0o700, flags: 'wx' }));
        if (await fileHash(join(staged, 'codex')) !== manifest.sha256) throw new CodexRuntimeError('codex_runtime_integrity_failed');
        await rename(staged, join(this.directory, 'versions', manifest.version)).catch(async (e) => {
          if (e.code !== 'EEXIST' && e.code !== 'ENOTEMPTY') throw e;
          await rm(staged, { recursive: true });
        });
      } catch (e) { await rm(staged, { recursive: true, force: true }); throw e; }
      await this.persist(manifest);
    }
    const command = this.command(manifest), stat = await lstat(command);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || await fileHash(command) !== manifest.sha256)
      throw new CodexRuntimeError('codex_runtime_integrity_failed');
    this.active = manifest; return { command, version: manifest.version };
  }
  async check() {
    if (!this.enabled) return;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        const meta = JSON.parse((await boundedFetch('https://registry.npmjs.org/@openai%2Fcodex/latest', 2 * 1024 * 1024)).toString());
        if (meta.name !== '@openai/codex' || !versionPattern.test(meta.version)) throw new CodexRuntimeError('codex_update_metadata_invalid');
        this.latest = meta.version; this.checkedAt = new Date().toISOString(); this.error = null;
      } catch { this.error = 'codex_update_check_failed'; }
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  private async persist(manifest: RuntimeManifest) {
    const temp = join(this.directory, `pointer-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' }); await rename(temp, join(this.directory, 'current.json'));
  }
  /** Return immediately to HTTP. Account activation callback rolls back on failure. */
  update(activate: (command: string, version: string, commit: () => Promise<void>) => Promise<unknown>, onFailure: (code: string) => void = () => {}) {
    if (!this.enabled || !this.active) throw new CodexRuntimeError('codex_managed_runtime_required');
    if (this.updating) throw new CodexRuntimeError('codex_update_busy');
    if (!this.latest || !newerRuntime(this.latest, this.active.version)) throw new CodexRuntimeError('codex_no_update_available');
    const version = this.latest;
    this.phase = 'downloading'; this.error = null;
    this.updating = (async () => {
      let staged: string | null = null;
      try {
        await mkdir(join(this.directory, 'versions'), { recursive: true, mode: 0o700 });
        staged = await mkdtemp(join(this.directory, 'versions', '.download-'));
        const downloaded = await downloadOfficialRuntime(version, staged);
        this.phase = 'checking_compatibility';
        // No credentials, no thread or inference. Same production restrictions must pass.
        const profile = await mkdtemp(join(this.directory, '.preflight-'));
        const probe = new CodexRuntime({ enabled: true, command: downloaded.command, expectedRuntimeVersion: version,
          profileDirectory: profile, requestedModel: '', excludedDirectories: [] });
        try {
          const status = await probe.status();
          if (!status.running || (status.reasonCode && status.reasonCode !== 'codex_auth_required')) throw new CodexRuntimeError('codex_update_incompatible');
        } finally { await probe.close(); await rm(profile, { recursive: true, force: true }); }
        const next: RuntimeManifest = { version, platform: 'linux-x64', sha256: downloaded.sha256,
          archiveSha256: '0'.repeat(64), archiveParts: 1, integrity: downloaded.integrity, license: 'Apache-2.0' };
        const target = join(this.directory, 'versions', version);
        await rename(staged, target).catch(async (e) => {
          if (e.code !== 'EEXIST' && e.code !== 'ENOTEMPTY') throw e;
          if (await fileHash(join(target, 'codex')) !== next.sha256) throw new CodexRuntimeError('codex_runtime_integrity_failed');
          await rm(staged!, { recursive: true });
        }); staged = null;
        this.phase = 'activating';
        this.changes = await activate(join(target, 'codex'), version, () => this.persist(next));
        this.active = next; this.phase = 'completed';
      } catch (e) {
        this.error = e instanceof CodexRuntimeError ? e.code : 'codex_update_failed'; this.phase = 'failed'; onFailure(this.error);
      } finally { if (staged) await rm(staged, { recursive: true, force: true }); }
    })().finally(() => { this.updating = null; });
    return this.snapshot();
  }
  async close() { await this.updating; await this.checking; }
}
