import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AppStore } from '../src/store/appStore.js';

const workDirs: string[] = [];

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { filePath: string; store: AppStore } {
  const dir = mkdtempSync(path.join(tmpdir(), 'gemrouter-app-store-'));
  workDirs.push(dir);
  const filePath = path.join(dir, 'apps.json');
  return { filePath, store: new AppStore(filePath) };
}

function createApp(
  store: AppStore,
  name: string,
  modelAccess: 'all' | 'custom',
  allowedModels: string[],
) {
  return store.create({
    name,
    rawKey: `key-${name}`,
    allowedOrigins: ['*'],
    allowedModels,
    modelAccess,
    sessionNamespace: name,
    rateLimitPerMinute: 0,
    maxConcurrency: 0,
  }).record;
}

describe('app store model access', () => {
  it('persists credential hashes in an owner-only file', () => {
    const { filePath, store } = makeStore();
    createApp(store, 'private-store', 'custom', ['model-alpha']);

    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  });

  it('allows an all-model app to use every model in the current universe, but not unknown IDs', () => {
    const { store } = makeStore();
    store.restrictAllowedModels(['model-alpha', 'model-beta']);
    const app = createApp(store, 'all-models', 'all', []);

    assert.equal(app.modelAccess, 'all');
    assert.equal(store.isModelAllowed(app, 'model-alpha'), true);
    assert.equal(store.isModelAllowed(app, 'model-beta'), true);
    assert.equal(store.isModelAllowed(app, 'model-unknown'), false);
  });

  it('makes all-model access follow later changes to the model universe', () => {
    const { store } = makeStore();
    store.restrictAllowedModels(['model-alpha', 'model-beta']);
    const app = createApp(store, 'dynamic-all-models', 'all', []);

    store.restrictAllowedModels(['model-beta', 'model-gamma']);

    assert.equal(store.isModelAllowed(app, 'model-alpha'), false);
    assert.equal(store.isModelAllowed(app, 'model-beta'), true);
    assert.equal(store.isModelAllowed(app, 'model-gamma'), true);
    assert.equal(store.isModelAllowed(app, 'model-unknown'), false);
  });

  it('keeps custom and legacy records explicit while pruning models removed from the universe', () => {
    const { filePath, store } = makeStore();
    store.restrictAllowedModels(['model-alpha', 'model-beta', 'model-retired']);
    const custom = createApp(store, 'custom-models', 'custom', ['model-alpha', 'model-retired']);
    const legacySeed = createApp(store, 'legacy-models', 'custom', ['model-beta', 'model-retired']);

    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      apps: Array<Record<string, unknown>>;
    };
    const legacyState = persisted.apps.find((app) => app.id === legacySeed.id);
    assert.ok(legacyState, 'legacy seed must be present in the persisted store');
    delete legacyState.modelAccess;
    writeFileSync(filePath, JSON.stringify(persisted, null, 2), 'utf8');

    const reloaded = new AppStore(filePath);
    reloaded.restrictAllowedModels(['model-alpha', 'model-beta', 'model-gamma']);
    const reloadedCustom = reloaded.findById(custom.id);
    const legacy = reloaded.findById(legacySeed.id);
    assert.ok(reloadedCustom);
    assert.ok(legacy);

    assert.deepEqual(reloadedCustom.allowedModels, ['model-alpha']);
    assert.equal(reloaded.isModelAllowed(reloadedCustom, 'model-alpha'), true);
    assert.equal(reloaded.isModelAllowed(reloadedCustom, 'model-beta'), false);
    assert.equal(reloaded.isModelAllowed(reloadedCustom, 'model-gamma'), false);

    assert.deepEqual(legacy.allowedModels, ['model-beta']);
    assert.equal(reloaded.isModelAllowed(legacy, 'model-alpha'), false);
    assert.equal(reloaded.isModelAllowed(legacy, 'model-beta'), true);
    assert.equal(reloaded.isModelAllowed(legacy, 'model-gamma'), false);
  });

  it('reactivates only revoked apps with a fresh key and current model permissions', () => {
    const { store } = makeStore();
    store.restrictAllowedModels(['model-alpha', 'model-retired']);
    const app = createApp(store, 'reactivate', 'custom', ['model-alpha', 'model-retired']);

    assert.equal(store.reactivate(app.id), null, 'an active app cannot be reactivated');
    assert.ok(store.revoke(app.id));
    assert.equal(store.verify('key-reactivate'), null, 'revocation invalidates the old key');
    store.restrictAllowedModels(['model-alpha', 'model-new']);

    const activated = store.reactivate(app.id);
    assert.ok(activated);
    assert.notEqual(activated.rawKey, 'key-reactivate');
    assert.equal(activated.record.revokedAt, undefined);
    assert.deepEqual(activated.record.allowedModels, ['model-alpha']);
    assert.equal(store.verify('key-reactivate'), null, 'the revoked key never becomes valid again');
    assert.equal(store.verify(activated.rawKey)?.id, app.id);
  });

  it('removes only revoked apps and keeps the deletion after reload', () => {
    const { filePath, store } = makeStore();
    const app = createApp(store, 'remove-revoked', 'all', []);

    assert.equal(store.removeRevoked(app.id), null, 'an active app cannot be removed');
    assert.ok(store.revoke(app.id));
    assert.equal(store.removeRevoked(app.id)?.id, app.id);
    assert.equal(store.findById(app.id), undefined);

    const reloaded = new AppStore(filePath);
    assert.equal(reloaded.findById(app.id), undefined);
  });
});

describe('app store Codex account policy', () => {
  const appInput = {
    name: 'trading',
    allowedOrigins: [],
    allowedModels: ['gpt-6.1-sol'],
    modelAccess: 'custom' as const,
    codexEnabled: true,
    sessionNamespace: 'trading',
    rateLimitPerMinute: 30,
    maxConcurrency: 2,
  };

  it('keeps account selection and fallback isolated per app through unrelated updates and reloads', () => {
    const { filePath, store } = makeStore();
    const trading = store.create({ ...appInput, codexAccountId: 'account-2', codexAccountFallbackEnabled: true }).record;
    const primaryOnly = store.create({ ...appInput, name: 'primary-only', codexAccountId: 'account-1', codexAccountFallbackEnabled: false }).record;
    const inherited = store.create({ ...appInput, name: 'global-policy' }).record;

    store.update(trading.id, { name: 'trading-renamed', rateLimitPerMinute: 10, codexAccountId: undefined, codexAccountFallbackEnabled: undefined });
    store.update(primaryOnly.id, { codexReasoningEffort: 'low', allowedModels: ['gpt-6-sol'] });

    const reloaded = new AppStore(filePath);
    assert.equal(reloaded.findById(trading.id)?.codexAccountId, 'account-2');
    assert.equal(reloaded.findById(trading.id)?.codexAccountFallbackEnabled, true);
    assert.equal(reloaded.findById(primaryOnly.id)?.codexAccountId, 'account-1');
    assert.equal(reloaded.findById(primaryOnly.id)?.codexAccountFallbackEnabled, false);
    assert.equal(reloaded.findById(inherited.id)?.codexAccountId, undefined);
    assert.equal(reloaded.findById(inherited.id)?.codexAccountFallbackEnabled, undefined);
  });

  it('clears explicit policy only on null and retains global inheritance in persisted records', () => {
    const { filePath, store } = makeStore();
    const app = store.create({ ...appInput, codexAccountId: 'account-2', codexAccountFallbackEnabled: false }).record;
    const inherited = store.create({ ...appInput, codexAccountId: null, codexAccountFallbackEnabled: null }).record;

    store.update(app.id, { codexAccountId: null });
    assert.equal(app.codexAccountId, undefined);
    assert.equal(app.codexAccountFallbackEnabled, false, 'clearing account selection preserves a separate fallback override');
    store.update(app.id, { codexAccountFallbackEnabled: null });

    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as { apps: Array<Record<string, unknown>> };
    for (const record of persisted.apps) {
      assert.equal(Object.hasOwn(record, 'codexAccountId'), false);
      assert.equal(Object.hasOwn(record, 'codexAccountFallbackEnabled'), false);
    }
    const reloaded = new AppStore(filePath);
    for (const id of [app.id, inherited.id]) {
      assert.equal(reloaded.findById(id)?.codexAccountId, undefined);
      assert.equal(reloaded.findById(id)?.codexAccountFallbackEnabled, undefined);
    }
  });

  it('rejects invalid create policies without adding an app', () => {
    const { store } = makeStore();
    type Input = Parameters<AppStore['create']>[0];
    for (const invalid of ['account-3', 'ACCOUNT-2', '', false]) {
      assert.throws(() => store.create({ ...appInput, codexAccountId: invalid as Input['codexAccountId'] }), /Invalid Codex account/);
    }
    for (const invalid of ['false', 0, {}]) {
      assert.throws(() => store.create({ ...appInput, codexAccountFallbackEnabled: invalid as Input['codexAccountFallbackEnabled'] }), /Invalid Codex account fallback policy/);
    }
    assert.deepEqual(store.list(), []);
  });

  it('disables Codex for malformed persisted account pins while retaining valid and inherited app access', () => {
    const { filePath, store } = makeStore();
    const malformed = store.create({ ...appInput, codexAccountId: 'account-2', codexAccountFallbackEnabled: true }).record;
    const valid = store.create({ ...appInput, name: 'valid', codexAccountId: 'account-1' }).record;
    const inherited = store.create({ ...appInput, name: 'inherited' }).record;
    const nullInherited = store.create({ ...appInput, name: 'null-inherited' }).record;
    const baseline = readFileSync(filePath, 'utf8');

    for (const invalid of ['account-3', '', false, 0, {}, []]) {
      const persisted = JSON.parse(baseline) as { apps: Array<Record<string, unknown>> };
      persisted.apps.find((app) => app.id === malformed.id)!.codexAccountId = invalid;
      persisted.apps.find((app) => app.id === nullInherited.id)!.codexAccountId = null;
      writeFileSync(filePath, JSON.stringify(persisted), 'utf8');

      const reloaded = new AppStore(filePath);
      assert.equal(reloaded.findById(malformed.id)?.codexEnabled, false, 'invalid pins must not inherit the globally selected account');
      assert.equal(reloaded.findById(malformed.id)?.codexAccountId, undefined);
      assert.equal(reloaded.findById(valid.id)?.codexEnabled, true);
      assert.equal(reloaded.findById(valid.id)?.codexAccountId, 'account-1');
      for (const id of [inherited.id, nullInherited.id]) {
        assert.equal(reloaded.findById(id)?.codexEnabled, true, 'absent and null pins explicitly allow inheritance');
        assert.equal(reloaded.findById(id)?.codexAccountId, undefined);
      }
    }
  });

  it('rejects invalid updates atomically without changing other fields, apps, or persisted data', () => {
    const { filePath, store } = makeStore();
    const app = store.create({ ...appInput, codexAccountId: 'account-2', codexAccountFallbackEnabled: true }).record;
    store.create({ ...appInput, name: 'other', codexAccountId: 'account-1', codexAccountFallbackEnabled: false });
    const before = readFileSync(filePath, 'utf8');
    const records = structuredClone(store.list());
    type Input = Parameters<AppStore['update']>[1];

    for (const invalid of ['account-3', 'ACCOUNT-2', '', false]) {
      assert.throws(() => store.update(app.id, {
        name: 'must-not-change', codexAccountId: invalid as Input['codexAccountId'],
      }), /Invalid Codex account/);
    }
    for (const invalid of ['true', 1, {}]) {
      assert.throws(() => store.update(app.id, {
        name: 'must-not-change', codexAccountFallbackEnabled: invalid as Input['codexAccountFallbackEnabled'],
      }), /Invalid Codex account fallback policy/);
    }
    assert.deepEqual(store.list(), records);
    assert.equal(readFileSync(filePath, 'utf8'), before);
  });
});
