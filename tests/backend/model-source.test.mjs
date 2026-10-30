import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/model-source.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const module = await import(moduleUrl);

test('manual model source validates URLs and only creates a Responses provider', () => {
  const config = module.validateManualApiConfig({
    serviceName: ' 测试服务 ',
    baseUrl: 'https://api.example.com/v1/?token=not-allowed#fragment',
    model: ' model-id '
  });
  assert.deepEqual(config, {
    serviceName: '测试服务',
    baseUrl: 'https://api.example.com/v1',
    model: 'model-id'
  });
  const provider = module.manualProviderConfig(config);
  assert.equal(provider.providerId, 'rambo_manual');
  assert.equal(provider.baseUrl, 'https://api.example.com/v1');
  assert.deepEqual(module.manualProviderToml(config), {
    name: '测试服务',
    base_url: 'https://api.example.com/v1',
    wire_api: 'responses',
    env_key: 'RAMBO_MANUAL_API_KEY',
    requires_openai_auth: false
  });
  assert.deepEqual(module.runtimeConfigOverrides('manualApi', config), [
    '-c', 'model_provider="rambo_manual"',
    '-c', `model_providers.rambo_manual=${JSON.stringify(module.manualProviderToml(config))}`
  ]);
  assert.deepEqual(module.runtimeConfigOverrides('local', config), []);
  assert.throws(() => module.validateManualApiConfig({
    serviceName: '', baseUrl: 'http://user:secret@example.com/v1', model: 'model'
  }), /不能包含用户名或密码/u);
  assert.throws(() => module.validateManualApiConfig({
    serviceName: '', baseUrl: 'file:///tmp/api', model: 'model'
  }), /http:\/\/ 或 https:\/\//u);
});

test('manual connection test sends a real minimal Responses request and reports latency', async () => {
  let observed = null;
  let clock = 100;
  const result = await module.testManualModelApi({
    serviceName: 'Local gateway',
    baseUrl: 'https://api.example.com/v1',
    model: 'model-a'
  }, 'sk-test-secret', {
    now: () => clock,
    fetchImpl: async (url, init) => {
      observed = { url, init };
      clock = 187;
      return new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  assert.equal(observed.url, 'https://api.example.com/v1/responses');
  assert.equal(observed.init.method, 'POST');
  assert.equal(observed.init.headers.authorization, 'Bearer sk-test-secret');
  assert.equal(JSON.parse(observed.init.body).model, 'model-a');
  assert.equal(JSON.parse(observed.init.body).input, 'Reply with OK.');
  assert.equal(result.latencyMs, 87);
  assert.match(result.message, /Responses 响应/u);
});

test('manual model catalog uses the configured API key and normalizes model records', async () => {
  let observed = null;
  const models = await module.listManualApiModels({
    serviceName: 'Local gateway',
    baseUrl: 'https://api.example.com/v1/',
    model: ''
  }, 'sk-model-list', {
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({
        data: [
          { id: 'model-b', display_name: 'Model B' },
          { id: 'model-a', name: 'Model A', is_default: true },
          { id: 'model-a', display_name: 'Duplicate A' },
          { id: '', name: 'Missing id' }
        ]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  assert.equal(observed.url, 'https://api.example.com/v1/models');
  assert.equal(observed.init.method, 'GET');
  assert.equal(observed.init.headers.authorization, 'Bearer sk-model-list');
  assert.deepEqual(models, [
    { id: 'model-b', label: 'Model B', isDefault: false },
    { id: 'model-a', label: 'Model A', isDefault: true }
  ]);
});

test('manual model catalog fails visibly for an invalid response', async () => {
  await assert.rejects(() => module.listManualApiModels({
    serviceName: '', baseUrl: 'https://api.example.com/v1', model: ''
  }, 'sk-test', {
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  }), /模型列表为空/u);

  await assert.rejects(() => module.listManualApiModels({
    serviceName: '', baseUrl: 'https://api.example.com/v1', model: ''
  }, 'sk-test', {
    fetchImpl: async () => new Response('forbidden', { status: 403 })
  }), /获取模型列表失败：HTTP 403：forbidden/u);
});

test('manual model catalog requires an explicitly selected default model', () => {
  assert.deepEqual(module.validateManualApiModelCatalog([
    { id: 'model-a', label: 'Model A' },
    { id: 'model-b', label: 'Model B' },
    { id: 'model-a', label: 'Duplicate A' }
  ], 'model-b'), [
    { id: 'model-a', label: 'Model A', isDefault: false },
    { id: 'model-b', label: 'Model B', isDefault: true }
  ]);
  assert.throws(
    () => module.validateManualApiModelCatalog([], 'model-a'),
    /至少勾选一个模型/u
  );
  assert.throws(
    () => module.validateManualApiModelCatalog([{ id: 'model-a', label: 'Model A' }], 'model-b'),
    /默认模型必须来自/u
  );
});

test('manual source state exposes the saved model pool and requires its default', () => {
  const state = module.modelSourceStateFrom({
    modelSource: 'manualApi',
    manualModelServiceName: 'Fixture API',
    manualModelBaseUrl: 'https://api.example.com/v1',
    manualModelId: 'model-b',
    defaultBotModels: JSON.stringify([
      { id: 'model-a', label: 'Model A', isDefault: false },
      { id: 'model-b', label: 'Model B', isDefault: false }
    ])
  }, true);
  assert.deepEqual(state.models, [
    { id: 'model-a', label: 'Model A', isDefault: false },
    { id: 'model-b', label: 'Model B', isDefault: true }
  ]);
  assert.equal(module.manualModelSourceAvailable(state), true);
  assert.equal(module.manualModelSourceAvailable({ ...state, models: [] }), false);

  const localState = module.modelSourceStateFrom({
    modelSource: 'local',
    manualModelServiceName: 'Fixture API',
    manualModelBaseUrl: 'https://api.example.com/v1',
    manualModelId: 'model-b',
    manualModelCatalog: JSON.stringify([
      { id: 'model-a', label: 'Model A' },
      { id: 'model-b', label: 'Model B' }
    ]),
    defaultBotModels: JSON.stringify([
      { id: 'local-model', label: 'Local Model' }
    ])
  }, true);
  assert.equal(localState.kind, 'local');
  assert.deepEqual(localState.models, [
    { id: 'model-a', label: 'Model A', isDefault: false },
    { id: 'model-b', label: 'Model B', isDefault: true }
  ]);

  const missingPool = module.modelSourceStateFrom({
    modelSource: 'local',
    manualModelServiceName: 'Incomplete API',
    manualModelBaseUrl: 'https://api.example.com/v1',
    manualModelId: 'legacy-model'
  }, true);
  assert.deepEqual(missingPool.models, []);
  assert.equal(module.manualModelSourceAvailable(missingPool), false);

  const emptyCatalogFallback = module.modelSourceStateFrom({
    modelSource: 'manualApi',
    manualModelServiceName: 'Legacy API',
    manualModelBaseUrl: 'https://api.example.com/v1',
    manualModelId: 'model-b',
    manualModelCatalog: '',
    defaultBotModels: JSON.stringify([
      { id: 'model-b', label: 'Model B' }
    ])
  }, true);
  assert.deepEqual(emptyCatalogFallback.models, [
    { id: 'model-b', label: 'Model B', isDefault: true }
  ]);
  assert.equal(module.manualModelSourceAvailable(emptyCatalogFallback), true);
});

test('manual connection test fails visibly for HTTP errors and timeouts', async () => {
  await assert.rejects(() => module.testManualModelApi({
    serviceName: '', baseUrl: 'https://api.example.com/v1', model: 'model'
  }, 'sk-test', {
    fetchImpl: async () => new Response('bad key', { status: 401 })
  }), /HTTP 401：bad key/u);

  await assert.rejects(() => module.testManualModelApi({
    serviceName: '', baseUrl: 'https://api.example.com/v1', model: 'model'
  }, 'sk-test', {
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })
  }), /连接测试超时/u);
});

test('initial setup opens only when both runtime and selected model source are unusable', () => {
  const state = (overrides = {}) => ({
    kind: 'local',
    manual: { serviceName: '', baseUrl: '', model: '' },
    hasApiKey: false,
    runtimeReady: false,
    executionDefaultsReady: false,
    ...overrides
  });

  assert.equal(module.needsInitialSetup(state()), true);
  assert.equal(module.needsInitialSetup(state({ runtimeReady: true })), true);
  assert.equal(module.needsInitialSetup(state({
    runtimeReady: true,
    executionDefaultsReady: true
  })), false);
  assert.equal(module.needsInitialSetup(state({
    runtimeReady: true,
    executionDefaultsReady: true,
    accountReady: false
  })), true);
  assert.equal(module.needsInitialSetup(state({
    kind: 'chatgpt',
    runtimeReady: true,
    executionDefaultsReady: true,
    accountReady: false
  })), true);
  assert.equal(module.needsInitialSetup(state({
    kind: 'chatgpt',
    runtimeReady: true,
    executionDefaultsReady: true,
    accountReady: true
  })), false);
  assert.equal(module.needsInitialSetup(state({ kind: 'manualApi' })), true);
  assert.equal(module.needsInitialSetup(state({
    kind: 'manualApi',
    manual: { serviceName: '网关', baseUrl: 'https://api.example.com/v1', model: 'model-a' },
    hasApiKey: true,
    runtimeReady: true
  })), false);
});
