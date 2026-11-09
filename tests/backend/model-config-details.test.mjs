import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/model-config-details.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { runtimeModelConfigurationDetails } = await import(moduleUrl);

test('runtime model details report ChatGPT auth without returning credentials', () => {
  const details = runtimeModelConfigurationDetails({
    model_provider: 'openai',
    model_providers: { openai: { wire_api: 'responses' } }
  }, {
    auth_mode: 'chatgpt',
    tokens: { access_token: 'never-return-this' }
  }, {});

  assert.deepEqual(details, {
    accessMethod: 'chatgptLogin',
    providerId: 'openai',
    serviceName: 'ChatGPT',
    baseUrl: null,
    wireApi: 'responses',
    credentialConfigured: true
  });
  assert.equal(JSON.stringify(details).includes('never-return-this'), false);
});

test('runtime model details sanitize provider URLs and expose credential presence only', () => {
  const details = runtimeModelConfigurationDetails({
    model_provider: 'private-provider',
    model_providers: {
      'private-provider': {
        name: 'Private API',
        base_url: 'https://user:password@api.example.com/v1/?token=secret#secret',
        wire_api: 'responses',
        env_key: 'PROVIDER_API_KEY'
      }
    }
  }, { OPENAI_API_KEY: 'another-secret' }, { PROVIDER_API_KEY: 'provider-secret' });

  assert.deepEqual(details, {
    accessMethod: 'modelProvider',
    providerId: 'private-provider',
    serviceName: 'Private API',
    baseUrl: 'https://api.example.com/v1',
    wireApi: 'responses',
    credentialConfigured: true
  });
  const serialized = JSON.stringify(details);
  for (const secret of ['password', 'token=secret', 'another-secret', 'provider-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('API key auth is shown as a method without claiming a missing key is saved', () => {
  const details = runtimeModelConfigurationDetails({
    model_provider: 'openai',
    model_providers: { openai: {} }
  }, { auth_mode: 'api_key' }, {});

  assert.equal(details.accessMethod, 'apiKey');
  assert.equal(details.credentialConfigured, null);
});

test('command-backed provider auth reports a credential without exposing its command arguments', () => {
  const details = runtimeModelConfigurationDetails({
    model_provider: 'external-provider',
    model_providers: {
      'external-provider': {
        name: 'External API',
        base_url: 'http://127.0.0.1:3425/v1',
        wire_api: 'responses',
        auth: {
          command: '/bin/cat',
          args: ['/Users/example/.config/provider/token']
        }
      }
    }
  }, null, {});

  assert.deepEqual(details, {
    accessMethod: 'modelProvider',
    providerId: 'external-provider',
    serviceName: 'External API',
    baseUrl: 'http://127.0.0.1:3425/v1',
    wireApi: 'responses',
    credentialConfigured: true
  });
  assert.equal(JSON.stringify(details).includes('/token'), false);
});

test('runtime model details tolerate absent and malformed config fields', () => {
  assert.deepEqual(runtimeModelConfigurationDetails(null, null, {}), {
    accessMethod: 'unknown',
    providerId: null,
    serviceName: null,
    baseUrl: null,
    wireApi: null,
    credentialConfigured: null
  });
  const details = runtimeModelConfigurationDetails({
    model_provider: 'broken',
    model_providers: { broken: { base_url: 'file:///secret' } }
  }, null, {});
  assert.equal(details.baseUrl, null);
  assert.equal(details.accessMethod, 'modelProvider');
});
