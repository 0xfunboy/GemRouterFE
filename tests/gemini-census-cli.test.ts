import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../scripts/gemini-census.ts', import.meta.url));
function run(args: string[], root: string) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script, ...args], {
    cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10_000,
  });
}
test('census cannot apply policy on listing alone, before reading any private configuration', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-census-cli-'));
  try {
    const r = run(['--apply'], dir);
    assert.equal(r.status, 1); assert.match(r.stderr, /--apply requires --probe/); assert.equal(r.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('census probes fail closed before discovery or generation when the live service is unavailable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-census-cli-'));
  try {
    // Port 1 is blocked by fetch; no network listener or live DB is used.
    writeFileSync(path.join(dir, '.env'), `GEMROUTER_ROOT_DIR=${dir}\nPORT=1\nGEMROUTER_ADMIN_TOKEN=fixture-admin\nGEMROUTER_BOOTSTRAP_API_KEY=fixture-client\n`, { mode: 0o600 });
    const r = run(['--probe', '--apply'], dir);
    assert.equal(r.status, 1); assert.match(r.stderr, /live_service_unavailable_or_admin_auth_failed/);
    assert.equal(r.stdout, ''); assert.equal(r.stderr.includes('fixture-admin'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
