import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { registerPrivateBackupDownload } from '../src/lib/privateBackupDownload.js';

const filename = 'gemrouter-private-20261011T102345Z-ab12cd34.tar.gz';
const prefix = '/v1/admin/backup/private-download/';
const headers = { authorization: 'Bearer fixture-admin' };

function fixture(t: TestContext, audit?: (event: { details: { filename: string; size: number } }) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gemrouter-private-download-'));
  const app = Fastify();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  registerPrivateBackupDownload(app, { directory, audit, ensureAdmin: (request, reply) => {
    if (request.headers.authorization === headers.authorization || request.headers.cookie === 'admin_session=fixture-session') return true;
    reply.code(401).send({ error: 'admin_auth_required' }); return false;
  } });
  return { app, directory, file: path.join(directory, filename) };
}

test('private backup downloads authenticate bearer or cookie, stream exact bytes and audit only metadata', async (t) => {
  const events: unknown[] = [], { app, file } = fixture(t, (event) => events.push(event));
  const archive = gzipSync('fixture-private-backup'); writeFileSync(file, archive, { mode: 0o600 });
  for (const credentials of [headers, { cookie: 'admin_session=fixture-session' }]) {
    const response = await app.inject({ url: prefix + filename, headers: credentials });
    assert.equal(response.statusCode, 200); assert.deepEqual(response.rawPayload, archive);
    assert.equal(response.headers['content-type'], 'application/gzip');
    assert.equal(response.headers['content-length'], String(archive.length));
    assert.equal(response.headers['content-disposition'], `attachment; filename="${filename}"`);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['referrer-policy'], 'no-referrer');
  }
  assert.deepEqual(events, Array.from({ length: 2 }, () => ({ type: 'backup_private_download',
    route: prefix + ':filename', details: { filename, size: archive.length } })));
});

test('private archives are never served without normal admin authentication', async (t) => {
  const { app, file } = fixture(t); writeFileSync(file, 'secret', { mode: 0o600 });
  for (const name of [filename, 'invalid']) {
    const response = await app.inject({ url: prefix + name });
    assert.equal(response.statusCode, 401); assert.equal(response.payload.includes('secret'), false);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('missing files, invalid names and traversal receive 404 without exposing paths', async (t) => {
  const { app, directory } = fixture(t);
  for (const name of [filename, '.env', 'gemrouter-private-20261011T102345Z.tar.gz.tmp',
    '..%2F' + filename, '%2F' + filename, 'gemrouter-private-20261011T102345Z-%2e%2e.tar.gz',
    filename + '%00', 'gemrouter-private-20261011T102345Z-NOTHEX.tar.gz']) {
    const response = await app.inject({ url: prefix + name, headers });
    assert.equal(response.statusCode, 404, name); assert.equal(response.payload.includes(directory), false);
  }
});

test('symlinks and group or other readable archives are rejected', async (t) => {
  const { app, directory, file } = fixture(t);
  const target = path.join(directory, 'private-secret'); writeFileSync(target, 'private-secret', { mode: 0o600 });
  symlinkSync(target, file);
  assert.equal((await app.inject({ url: prefix + filename, headers })).statusCode, 404);
  rmSync(file); writeFileSync(file, 'private-secret', { mode: 0o600 });
  for (const mode of [0o640, 0o604, 0o601, 0o620]) {
    chmodSync(file, mode);
    const response = await app.inject({ url: prefix + filename, headers });
    assert.equal(response.statusCode, 404); assert.equal(response.payload.includes('private-secret'), false);
  }
});

test('nonregular files are rejected without blocking', async (t) => {
  const { app, file } = fixture(t); execFileSync('mkfifo', ['-m', '600', file]);
  assert.equal((await app.inject({ url: prefix + filename, headers })).statusCode, 404);
});

test('download streams the verified descriptor even if the pathname is replaced after validation', async (t) => {
  let file = '';
  const archive = gzipSync('verified-original');
  const fixtureResult = fixture(t, () => {
    renameSync(file, file + '.previous'); writeFileSync(file, gzipSync('replacement'), { mode: 0o600 });
  });
  file = fixtureResult.file; writeFileSync(file, archive, { mode: 0o600 });
  const response = await fixtureResult.app.inject({ url: prefix + filename, headers });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.rawPayload, archive);
});
