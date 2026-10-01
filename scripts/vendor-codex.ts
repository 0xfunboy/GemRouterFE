/** Maintainer-only reproducible asset refresh. No auth, account data or npm scripts. */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadOfficialRuntime, fileHash } from '../src/codex/managed-runtime.js';
import { CODEX_RUNTIME_VERSION } from '../src/codex/runtime.js';
const temporary = await mkdtemp(join(tmpdir(), 'gemrouter-vendor-'));
try {
  const asset = await downloadOfficialRuntime(CODEX_RUNTIME_VERSION, join(temporary, 'artifact'));
  const destination = join(process.cwd(), 'vendor/codex/linux-x64');
  await mkdir(destination, { recursive: true });
  const archive = join(temporary, 'codex.gz');
  await pipeline(createReadStream(asset.command), createGzip({ level: 9 }), createWriteStream(archive));
  const file = await open(archive, 'r'); let count = 0;
  try {
    // GitHub rejects blobs over 100 MiB. Numbered 64 MiB chunks keep a normal
    // offline git checkout self-contained, without LFS or binary dependencies.
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024 * 1024), { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      await writeFile(join(destination, `codex.gz.${String(++count).padStart(3, '0')}`), buffer.subarray(0, bytesRead));
    }
  } finally { await file.close(); }
  await writeFile(join(destination, '../manifest.json'), JSON.stringify({ version: asset.version, platform: 'linux-x64',
    sha256: asset.sha256, archiveSha256: await fileHash(archive), archiveParts: count, integrity: asset.integrity, license: 'Apache-2.0' }, null, 2) + '\n');
  console.log(JSON.stringify({ version: asset.version, sha256: asset.sha256, archiveSha256: await fileHash(archive) }));
} finally { await rm(temporary, { recursive: true, force: true }); }
