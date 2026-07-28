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
