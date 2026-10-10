import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderAppShell } from '../src/ui.js';

const shell = renderAppShell({ projectName: 'Token volume test', modelIds: [] });
const formatter = shell.slice(shell.indexOf('function fmtNumber(value)'), shell.indexOf('function escapeHtml(value)'));
const start = shell.indexOf('function renderPublicStats(summary)');
const renderer = shell.slice(start, shell.indexOf('// Strongest -> weakest.', start));

function tokenCard(stats: Record<string, unknown>) {
  const publicStats = { innerHTML: '' };
  runInNewContext(formatter + renderer + '\nrenderPublicStats(summary);', {
    summary: { stats }, publicStats, activityLabel: null,
    root: { style: { setProperty() {} } },
    escapeHtml: (value: unknown) => String(value ?? ''), formatTimestamp: () => 'test time',
  });
  const match = publicStats.innerHTML.match(/Token Volume<\/div><div class="metric">([^<]+)<\/div><div class="metric-sub">([^<]+)<\/div>/);
  assert(match, 'Token Volume card must be rendered');
  return { value: match[1], detail: match[2] };
}

test('Guest Overview keeps measured volume visible when some requests have unknown usage', () => {
  const card = tokenCard({ totalTokens: null, knownTotalTokens: 1565118, usageUnavailableRequests: 3 });
  assert.equal(card.value, new Intl.NumberFormat().format(1565118));
  assert.match(card.detail, /Partial total.*3 requests/);
});

test('Guest Overview shows exact token volume when usage is complete', () => {
  const card = tokenCard({ totalTokens: 245, knownTotalTokens: 245, usageUnavailableRequests: 0 });
  assert.equal(card.value, new Intl.NumberFormat().format(245));
  assert.equal(card.detail, 'Prompt and completion tokens');
});

test('Guest Overview does not report zero consumption when every token count is unknown', () => {
  const card = tokenCard({ totalTokens: null, knownTotalTokens: 0, usageUnavailableRequests: 2 });
  assert.equal(card.value, '—');
  assert.match(card.detail, /2 requests without token usage/);
});

test('Guest Overview retains zero for an empty usage window', () => {
  assert.equal(tokenCard({ totalTokens: 0, knownTotalTokens: 0, usageUnavailableRequests: 0 }).value, '0');
});
