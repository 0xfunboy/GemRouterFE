import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { NvidiaScoreboard } from '../src/llm/providers/nvidia/scoreboard.js';

const workDirs: string[] = [];
after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

function scoreboard(): NvidiaScoreboard {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-nvidia-scoreboard-'));
  workDirs.push(dir);
  return new NvidiaScoreboard(path.join(dir, 'scoreboard.json'));
}

describe('NVIDIA scoreboard isolation and quarantine', () => {
  it('quarantines 404 for a day and 410 persistently', () => {
    const board = scoreboard();
    const started = Date.now();
    board.recordFailure('missing', {
      code: 'nvidia_model_not_found',
      status: 404,
      source: 'traffic',
    });
    board.recordFailure('gone', {
      code: 'nvidia_model_not_found',
      status: 410,
      source: 'traffic',
    });

    const missingUntil = Date.parse(board.snapshot().models.missing.cooldownUntil ?? '');
    const goneUntil = Date.parse(board.snapshot().models.gone.cooldownUntil ?? '');
    assert.ok(missingUntil - started >= 23 * 60 * 60_000, '404 quarantine lasts roughly one day');
    assert.ok(missingUntil - started <= 25 * 60 * 60_000);
    assert.ok(goneUntil > Date.UTC(9000, 0, 1), '410 remains quarantined across restarts');
    assert.equal(board.isCoolingDown('missing'), true);
    assert.equal(board.isCoolingDown('gone'), true);
  });

  it('does not let synthetic probe success outweigh failed real traffic', () => {
    const board = scoreboard();
    for (let index = 0; index < 100; index += 1) {
      board.recordSuccess('probe-star', {
        latencyMs: 1,
        ttfbMs: 1,
        completionTokens: 1,
        source: 'probe',
      });
    }
    board.recordFailure('probe-star', {
      code: 'nvidia_upstream_error',
      status: 500,
      source: 'traffic',
    });
    board.recordSuccess('traffic-winner', {
      latencyMs: 2_000,
      ttfbMs: 2_000,
      completionTokens: 10,
      source: 'traffic',
    });

    assert.ok(
      board.score('traffic-winner') > board.score('probe-star'),
      'foreground reliability is ranked ahead of probe-only optimism',
    );
    const sourceStats = board.snapshot().models['probe-star'].sources;
    assert.equal(sourceStats?.probe?.overall.successes, 100);
    assert.equal(sourceStats?.traffic?.overall.failures, 1);
  });
});
