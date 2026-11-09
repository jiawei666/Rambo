import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = ts.transpileModule(
  await readFile(new URL('../../src/shared/account-settings.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    }
  }
).outputText;
const module = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

const account = {
  type: 'chatgpt',
  email: 'fixture@example.com',
  requiresLogin: false,
  localLoginDetected: true
};
const unavailableAccount = {
  type: null,
  email: null,
  requiresLogin: true,
  localLoginDetected: false
};
const manual = {
  kind: 'manualApi',
  manual: {
    serviceName: 'Fixture API',
    baseUrl: 'http://127.0.0.1:19226/v1',
    model: 'gpt-5'
  },
  models: [{ id: 'gpt-5', label: 'GPT-5', isDefault: true }],
  hasApiKey: true
};

function derive(overrides = {}) {
  return module.deriveAccountSettingsState({
    localCopyAvailable: true,
    modelSource: {
      kind: 'local',
      manual: { serviceName: '', baseUrl: '', model: '' },
      models: [],
      hasApiKey: false
    },
    account,
    accountLoading: false,
    accountError: null,
    ...overrides
  });
}

test('first-run source selection does not expose a local-follow mode', () => {
  const state = derive({
    localCopyAvailable: false,
    account: null
  });
  assert.equal(state.showConfigurationEntry, true);
  assert.equal('followAvailable' in state, false);
});

test('a one-time local copy remains an available source without synchronization mode state', () => {
  const state = derive({ modelSource: { ...manual, kind: 'local' } });
  assert.equal(state.localCopyStatus, 'ready');
  assert.equal(state.anySourceReady, true);
  assert.equal(state.showConfigurationEntry, false);
});

test('an unavailable imported local login does not create a second configuration flow', () => {
  const state = derive({ account: unavailableAccount });
  assert.equal(state.localCopyStatus, 'unavailable');
  assert.equal(state.anySourceReady, false);
});

test('a configured standard provider does not depend on the ChatGPT account state', () => {
  const state = derive({
    account: unavailableAccount,
    modelSource: {
      kind: 'local',
      manual: { serviceName: '', baseUrl: '', model: '' },
      models: [],
      hasApiKey: false,
      standardProviderConfigured: true
    }
  });
  assert.equal(state.localCopyStatus, 'ready');
  assert.equal(state.activeSourceStatus, 'ready');
  assert.equal(state.anySourceReady, true);
  assert.equal(state.showConfigurationEntry, false);
});

test('ChatGPT account identity is shown only when ChatGPT is the active source', () => {
  const chatgpt = derive({
    modelSource: { ...manual, kind: 'chatgpt' }
  });
  assert.equal(chatgpt.activeSourceStatus, 'ready');

  const manualApi = derive({
    modelSource: manual
  });
  assert.equal(manualApi.activeSourceStatus, 'ready');
});

test('manual API is ready only when the selected default model is in its saved model pool', () => {
  const ready = derive({
    modelSource: manual
  });
  assert.equal(ready.manualApiStatus, 'ready');

  for (const models of [[], [{ id: 'other-model', label: 'Other Model', isDefault: false }]]) {
    const stale = derive({
      modelSource: { ...manual, models }
    });
    assert.equal(stale.manualApiStatus, 'unavailable');
  }
});

test('direct configuration entry only shows when no source is usable', () => {
  const unavailableLocal = derive({
    localCopyAvailable: false,
    account: unavailableAccount
  });
  assert.equal(unavailableLocal.showConfigurationEntry, true);

  const anotherSourceReady = derive({
    localCopyAvailable: false,
    account: unavailableAccount,
    modelSource: manual
  });
  assert.equal(anotherSourceReady.anySourceReady, true);
  assert.equal(anotherSourceReady.showConfigurationEntry, false);
});
