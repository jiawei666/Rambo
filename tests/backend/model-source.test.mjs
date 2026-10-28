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
  assert.equal(module.needsInitialSetup(state({ runtimeReady: true })), false);
  assert.equal(module.needsInitialSetup(state({ executionDefaultsReady: true })), false);
  assert.equal(module.needsInitialSetup(state({ kind: 'chatgpt' })), false);
  assert.equal(module.needsInitialSetup(state({ kind: 'manualApi' })), true);
  assert.equal(module.needsInitialSetup(state({
    kind: 'manualApi',
    manual: { serviceName: '网关', baseUrl: 'https://api.example.com/v1', model: 'model-a' },
    hasApiKey: true
  })), false);
});
