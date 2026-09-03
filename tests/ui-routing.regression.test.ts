import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderAppShell } from '../src/ui.js';

const shell = renderAppShell({
  projectName: 'GemRouter routing test',
  modelIds: ['gemini-3.6-flash', 'gemma-4-31b-it'],
});

describe('routing telemetry labels', () => {
  it('renders hard TPM admission as a local skip, not an upstream account failure', () => {
    assert.match(
      shell,
      /startsWith\('local_'\)\)\s+return 'local'/,
    );
    assert.match(
      shell,
      /case 'local_tpm_request_exceeds_model_limit':\s+return 'prompt exceeds model TPM'/,
    );
  });

  it('only renders an HTTP status when an attempt really has one', () => {
    assert.match(
      shell,
      /if \(attempt\.statusCode\) parts\.push\('\[' \+ String\(attempt\.statusCode\) \+ '\]'\)/,
    );
  });
});

describe('frontend model performance ordering', () => {
  it('ranks Gemini 3.8 ahead of every older Flash generation', () => {
    const orderSource = shell.match(/const MODEL_POWER_ORDER = \[([\s\S]*?)\];/)?.[1] ?? '';
    const order = [...orderSource.matchAll(/'([^']+)'/g)].map((match) => match[1]);

    assert.deepEqual(order.slice(0, 4), [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
    ]);
  });

  it('uses the performance comparator for quota, account and app model lists', () => {
    assert.match(shell, /Array\.from\(byModel\.values\(\)\)\s*\.sort\(byModelPower\)/);
    assert.match(shell, /\(data\.models \|\| \[\]\)\.slice\(\)\.sort\(byModelPower\)/);
    assert.match(shell, /modelsAvailableList = Array\.isArray\(data\.available\) \? data\.available\.slice\(\)\.sort\(byModelPower\)/);
    assert.match(shell, /if \(leftCompatible !== rightCompatible\) return leftCompatible - rightCompatible;\s*return byModelPower\(left, right\)/);
    assert.match(shell, /const options = getModelCatalog\(\)\.filter\([\s\S]*?\}\)\.sort\(byModelPower\)/);
  });

  it('does not move idle RPD rows below stronger active models', () => {
    assert.match(shell, /let out = rows\.map\(function\(entry\)/);
    assert.doesNotMatch(shell, /const consumed = rows\.filter/);
  });
});
