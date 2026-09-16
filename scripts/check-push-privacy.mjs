/** Scan every new commit/tree in an explicit push set; never print matched values. */
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 });
const fullHistory = process.argv.includes('--all-history');
const args = process.argv.slice(2).filter((arg) => arg !== '--all-history');
const refs = args.length ? args : ['HEAD'];
for (const ref of refs) if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-')) throw Error('Invalid ref');
const commits = git('rev-list', ...refs, ...(fullHistory ? [] : ['--not', '--remotes'])).trim().split('\n').filter(Boolean);
const findings = [], scanned = new Set();
const deny = (process.env.GEMROUTER_PRIVACY_DENY || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const patterns = [
  ['private-key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['jwt', /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/],
  ['service-token', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['personal-chat', /https?:\/\/(?:chatgpt|chat\.openai)\.com\/c\/(?!00000000-0000-0000-0000-)[a-f0-9-]{36}/i],
  ['literal-secret', /(?:api_key|apiKey|access_token|refresh_token|password|client_secret)\s*[:=]\s*['"][A-Za-z0-9_+/=-]{40,}['"]/i],
];
const fixtureEmail = (email) => /@(?:[a-z0-9.-]+\.)?(?:example\.(?:com|org|net|test|invalid)|[a-z0-9-]+\.(?:test|invalid)|localhost)$/i.test(email)
  || /@(?:[a-z0-9-]+\.)?noreply\.github\.com$/i.test(email);
const hasPrivateEmail = (data) => [...data.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].some((match) => !fixtureEmail(match[0]));
for (const commit of commits) {
  const meta = git('show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', commit);
  if (/^[^\n]+@(?!(?:users\.)?noreply\.github\.com$)[^\n]+$/m.test(meta)) findings.push({ commit: commit.slice(0, 12), kind: 'non-anonymous-commit-email' });
  if (deny.some((word) => meta.toLowerCase().includes(word))) findings.push({ commit: commit.slice(0, 12), kind: 'denied-identity-in-metadata' });
  if (hasPrivateEmail(meta)) findings.push({ commit: commit.slice(0, 12), kind: 'private-email-in-metadata' });
  for (const row of git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean)) {
    const [info, file] = row.split('\t'); const [, type, id] = info.split(' ');
    if (type !== 'blob') continue;
    if (/(?:^|\/)(?:\.env|auth\.json|operator\.json|[^/]+\.sqlite(?:-[^/]+)?|[^/]+\.code)$/.test(file)
      || /(?:^|\/)(?:node_modules|dist|data|profiles|backups)\//.test(file)) findings.push({ file, kind: 'private-or-generated-path' });
    if (scanned.has(id)) continue;
    scanned.add(id);
    const data = git('cat-file', 'blob', id); if (data.includes('\0')) continue;
    if (hasPrivateEmail(data)) findings.push({ file, kind: 'private-email' });
    for (const [kind, pattern] of patterns) if (pattern.test(data)) findings.push({ file, kind });
    if (deny.some((word) => data.toLowerCase().includes(word))) findings.push({ file, kind: 'denied-identity-or-url' });
    for (const match of data.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
      try {
        const url = new URL(match[0]);
        const fixture = /(?:example|localhost|\.invalid|\.test)$/.test(url.hostname)
          || /(?:^|\.)example\.(?:com|org|net)$/.test(url.hostname)
          || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
        if (!fixture && (url.username || url.password || [...url.searchParams.keys()].some((key) => /^(?:access_token|refresh_token|client_secret|api_key|token)$/i.test(key)))) findings.push({ file, kind: 'credential-bearing-url' });
      } catch { /* Code fragments/placeholders are not URLs. */ }
    }
  }
}
console.log(JSON.stringify({ scope: fullHistory ? 'full-history' : 'outgoing', scannedCommits: commits.length, scannedBlobs: scanned.size, findings }, null, 2));
if (findings.length) process.exitCode = 1;
