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
