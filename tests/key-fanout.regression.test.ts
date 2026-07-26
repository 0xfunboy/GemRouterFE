import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isKeyFanoutCappedCode, shouldStopKeyFanout } from '../src/llm/providers/gemini-api/client.js';

/**
 * Regression cover for the fan-out budget. Without a cap, one failing model walked the
 * whole key pool and the chain repeated that per fallback model, so a single client
 * request could fire models x accounts upstream calls — enough to rate-limit models whose
 * own quota was untouched.
 */
describe('gemini key fan-out budget', () => {
  it('walks a couple of accounts before giving up on a rate-limited model', () => {
    const stop = (cappedAttempts: number) => shouldStopKeyFanout({
      code: 'gemini_api_rate_limited',
      cappedAttempts,
      hasRemainingModels: true,
    });
    assert.equal(stop(1), false, 'a single 429 may be that one account');
    assert.equal(stop(2), false);
    assert.equal(stop(3), true, '429s from three separate accounts mean model-wide pressure');
  });

  // gemini-2.5-flash is advertised by models.list on every account but 404s on projects
  // created after it closed to new users, so an uncapped pool walk burned a 404 per account
  // on every request that reached it.
  it('caps the walk for models the account cannot actually serve', () => {
    assert.equal(isKeyFanoutCappedCode('gemini_api_model_not_found'), true);
    assert.equal(
      shouldStopKeyFanout({ code: 'gemini_api_model_not_found', cappedAttempts: 3, hasRemainingModels: true }),
      true,
    );
  });

  it('never caps key-specific failures that another account can genuinely fix', () => {
    for (const code of ['gemini_api_auth_failed', 'gemini_api_upstream_error', 'gemini_api_timeout']) {
      assert.equal(isKeyFanoutCappedCode(code), false, `${code} is key-specific`);
      assert.equal(
        shouldStopKeyFanout({ code, cappedAttempts: 9, hasRemainingModels: true }),
        false,
        `${code} must keep trying other accounts`,
      );
    }
  });

  // The cap trades this model for the next one; with nothing left to fall back to, the
  // pool is all the request has, so exhaust it rather than failing early.
  it('ignores the cap when no fallback model is left', () => {
    assert.equal(
      shouldStopKeyFanout({ code: 'gemini_api_rate_limited', cappedAttempts: 99, hasRemainingModels: false }),
      false,
    );
  });
});
