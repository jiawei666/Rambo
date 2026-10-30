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
    syncMode: 'follow',
    sourceDetected: true,
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

test('no native Codex falls back to independent and keeps follow visible but disabled', () => {
  const state = derive({
    sourceDetected: false,
    account: null
  });
  assert.equal(state.effectiveMode, 'independent');
  assert.equal(state.followAvailable, false);
  assert.equal(state.followUnavailableReason, '未检测到本机 Codex');
  assert.equal(state.activeSource, null);
  assert.equal(state.showConfigurationEntry, true);
});

test('follow mode exposes the local copy as the only active source', () => {
  const state = derive();
  assert.equal(state.effectiveMode, 'follow');
  assert.equal(state.activeSource, 'local');
  assert.equal(state.activeSourceStatus, 'ready');
  assert.equal(state.showAccountStatus, true);
  assert.equal(state.showConfigurationEntry, false);
});

test('an unavailable followed local login does not auto-switch to independent', () => {
  const state = derive({ account: unavailableAccount });
  assert.equal(state.effectiveMode, 'follow');
  assert.equal(state.activeSource, 'local');
  assert.equal(state.activeSourceStatus, 'unavailable');
  assert.equal(state.showConfigurationEntry, false);
});

test('ChatGPT account identity is shown only when ChatGPT is the active source', () => {
  const chatgpt = derive({
    syncMode: 'independent',
    modelSource: { ...manual, kind: 'chatgpt' }
  });
  assert.equal(chatgpt.activeSource, 'chatgpt');
  assert.equal(chatgpt.activeSourceStatus, 'ready');
  assert.equal(chatgpt.showAccountStatus, true);

  const manualApi = derive({
    syncMode: 'independent',
    modelSource: manual
  });
  assert.equal(manualApi.activeSource, 'manualApi');
  assert.equal(manualApi.activeSourceStatus, 'ready');
  assert.equal(manualApi.showAccountStatus, false);
});

test('manual API is ready only when the selected default model is in its saved model pool', () => {
  const ready = derive({
    syncMode: 'independent',
    modelSource: manual
  });
  assert.equal(ready.manualApiStatus, 'ready');

  for (const models of [[], [{ id: 'other-model', label: 'Other Model', isDefault: false }]]) {
    const stale = derive({
      syncMode: 'independent',
      modelSource: { ...manual, models }
    });
    assert.equal(stale.manualApiStatus, 'unavailable');
  }
});

test('independent mode only shows the direct entry when every source is unusable', () => {
  const unavailableLocal = derive({
    syncMode: 'independent',
    account: unavailableAccount
  });
  assert.equal(unavailableLocal.showConfigurationEntry, true);

  const anotherSourceReady = derive({
    syncMode: 'independent',
    account: unavailableAccount,
    modelSource: manual
  });
  assert.equal(anotherSourceReady.anySourceReady, true);
  assert.equal(anotherSourceReady.showConfigurationEntry, false);
});
