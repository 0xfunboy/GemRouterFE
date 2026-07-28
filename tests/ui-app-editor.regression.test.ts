import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderAppShell } from '../src/ui.js';

const shell = renderAppShell({
  projectName: 'GemRouter test',
  modelIds: ['gemini-test'],
});

function scriptSection(startMarker: string, endMarker: string): string {
  const start = shell.indexOf(startMarker);
  assert.notEqual(start, -1, `missing script marker: ${startMarker}`);
  const end = shell.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing script marker: ${endMarker}`);
  return shell.slice(start, end);
}

function assertContains(source: string, pattern: RegExp, message: string): void {
  assert.ok(pattern.test(source), message);
}

describe('admin app editor regressions', () => {
  it('guards an app form against an admin-summary response captured for another app', () => {
    assertContains(
      shell,
      /\bappFormRevision\s*:\s*0\b/,
      'the form needs a monotonic revision in addition to the dirty flag',
    );

    const loadSummary = scriptSection(
      'async function loadAdminSummary()',
      'async function loadProjectQuota(',
    );
    const requestAt = loadSummary.indexOf("await request('/admin/summary')");
    assert.notEqual(requestAt, -1, 'loadAdminSummary must still fetch the admin snapshot');

    const beforeRequest = loadSummary.slice(0, requestAt);
    const afterRequest = loadSummary.slice(requestAt);
    const capturedRevision = beforeRequest.match(
      /const\s+([A-Za-z_$][\w$]*)\s*=\s*state\.appFormRevision\b/,
    );
    assert.ok(
      capturedRevision,
      'capture the form revision alongside editingAppId before awaiting the summary',
    );
    const currentAppId = afterRequest.match(
      /const\s+([A-Za-z_$][\w$]*)\s*=\s*String\(appForm\.elements\.id\.value/,
    );
    assert.ok(
      currentAppId,
      'read the live app id after the request resolves instead of trusting the captured id',
    );

    const revisionName = capturedRevision[1];
    const currentAppIdName = currentAppId[1];
    const revisionComparison =
      String.raw`(?:state\.appFormRevision\s*===\s*${revisionName}|${revisionName}\s*===\s*state\.appFormRevision)`;
    const idComparison =
      String.raw`(?:${currentAppIdName}\s*===\s*editingAppId|editingAppId\s*===\s*${currentAppIdName})`;
    const sameSnapshotGuard = new RegExp(
      String.raw`(?:${revisionComparison}\s*&&\s*${idComparison}|${idComparison}\s*&&\s*${revisionComparison})`,
    );
    assertContains(
      afterRequest,
      sameSnapshotGuard,
      'revision and current app id must be checked together before stale form state is applied',
    );

    const guardAt = afterRequest.search(sameSnapshotGuard);
    const repopulateAt = afterRequest.indexOf('populateAppForm(editingApp)');
    assert.notEqual(repopulateAt, -1, 'the regression test expects the existing form refresh path');
    assert.ok(
      guardAt >= 0 && guardAt < repopulateAt,
      'the stale-response guard must run before populateAppForm',
    );
  });

  it('submits the explicit model access policy and confirms the updated app identity', () => {
    const submit = scriptSection(
      "appForm.addEventListener('submit'",
      "appReset.addEventListener('click'",
    );

    assertContains(
      submit,
      /\bmodelAccess\s*:/,
      'the app payload must distinguish all-model access from a custom model snapshot',
    );
    assertContains(
      submit,
      /response\.app(?:\?\.|\.)id\s*!==\s*id/,
      'a successful PUT must still be rejected if the server confirms a different app id',
    );

    const identityCheckAt = submit.search(/response\.app(?:\?\.|\.)id\s*!==\s*id/);
    const successMessageAt = submit.indexOf("'App updated");
    assert.ok(identityCheckAt >= 0, 'missing response identity check');
    assert.ok(
      successMessageAt === -1 || identityCheckAt < successMessageAt,
      'the response app id must be checked before showing update success',
    );
  });
});
