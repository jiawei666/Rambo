import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const proxySettingsSource = readFileSync(
  new URL('../../src/shared/proxy-settings.ts', import.meta.url),
  'utf8'
);
const proxySettingsCompiled = ts.transpileModule(proxySettingsSource, { compilerOptions }).outputText;
const proxySettingsUrl = `data:text/javascript;base64,${Buffer.from(proxySettingsCompiled).toString('base64')}`;
const source = readFileSync(new URL('../../src/main/scoped-proxy-fetch.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions }).outputText
  .replace("from '../shared/proxy-settings'", `from '${proxySettingsUrl}'`);
const { ScopedProxyFetch } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

function harness(initialSettings) {
  let current = initialSettings;
  const defaultRequests = [];
  const proxyCalls = [];
  const sessions = new Map();
  const manager = new ScopedProxyFetch(
    {
      fetch: async input => {
        defaultRequests.push(String(input));
        return new Response('default');
      }
    },
    scope => {
      const state = { scope, proxy: null, requests: [] };
      const session = {
        setProxy: async config => {
          state.proxy = config;
          proxyCalls.push({ scope, config });
        },
        fetch: async input => {
          state.requests.push(String(input));
          return new Response('proxied');
        }
      };
      sessions.set(scope, state);
      return session;
    },
    () => current
  );
  return {
    manager,
    defaultRequests,
    proxyCalls,
    sessions,
    setSettings(settings) { current = settings; }
  };
}

test('未启用范围时使用默认会话并保留系统代理语义', async () => {
  const run = harness({ proxy: 'http://127.0.0.1:10808/', scopes: [] });
  const response = await run.manager.fetchFor('model')('https://example.com/models');

  assert.equal(await response.text(), 'default');
  assert.deepEqual(run.defaultRequests, ['https://example.com/models']);
  assert.deepEqual(run.proxyCalls, []);
});

test('启用范围后按范围创建固定代理会话并绕过本机回环', async () => {
  const run = harness({ proxy: 'http://127.0.0.1:10808', scopes: ['model', 'gmail'] });
  const modelFetch = run.manager.fetchFor('model');
  const gmailFetch = run.manager.fetchFor('gmail');

  assert.equal(await (await modelFetch('https://example.com/models')).text(), 'proxied');
  assert.equal(await (await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me')).text(), 'proxied');
  assert.deepEqual(run.proxyCalls, [
    {
      scope: 'model',
      config: {
        mode: 'fixed_servers',
        proxyRules: 'http://127.0.0.1:10808/',
        proxyBypassRules: '127.0.0.1,localhost,::1'
      }
    },
    {
      scope: 'gmail',
      config: {
        mode: 'fixed_servers',
        proxyRules: 'http://127.0.0.1:10808/',
        proxyBypassRules: '127.0.0.1,localhost,::1'
      }
    }
  ]);
});

test('每次请求动态读取范围与地址，地址变化后重配同一范围会话', async () => {
  const run = harness({ proxy: 'http://127.0.0.1:10808', scopes: ['model'] });
  const modelFetch = run.manager.fetchFor('model');

  await modelFetch('https://example.com/first');
  await modelFetch('https://example.com/second');
  assert.equal(run.proxyCalls.length, 1);

  run.setSettings({ proxy: 'https://127.0.0.1:10810', scopes: ['model'] });
  await modelFetch('https://example.com/third');
  assert.equal(run.proxyCalls.length, 2);
  assert.equal(run.proxyCalls[1].config.proxyRules, 'https://127.0.0.1:10810/');

  run.setSettings({ proxy: 'https://127.0.0.1:10810', scopes: [] });
  await modelFetch('https://example.com/fourth');
  assert.equal(run.defaultRequests.at(-1), 'https://example.com/fourth');
});

test('启用范围但地址为空或无效时明确失败，不回退直连', async () => {
  const run = harness({ proxy: '', scopes: ['gmail'] });
  await assert.rejects(
    run.manager.fetchFor('gmail')('https://gmail.googleapis.com'),
    /Gmail已启用应用代理，但代理地址为空/u
  );

  run.setSettings({ proxy: 'socks5://127.0.0.1:10808', scopes: ['gmail'] });
  await assert.rejects(
    run.manager.fetchFor('gmail')('https://gmail.googleapis.com'),
    /Gmail代理地址无效/u
  );
  assert.deepEqual(run.defaultRequests, []);
});
