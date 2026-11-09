import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const proxySettingsSource = readFileSync(
  new URL('../../src/shared/proxy-settings.ts', import.meta.url),
  'utf8'
);
const proxySettingsCompiled = ts.transpileModule(proxySettingsSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const proxySettingsUrl = `data:text/javascript;base64,${Buffer.from(proxySettingsCompiled).toString('base64')}`;
const source = readFileSync(new URL('../../src/main/mail-network.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText.replace("from '../shared/proxy-settings'", `from '${proxySettingsUrl}'`);
const { mailProxyUrlForHost, mailProxyUrlFromResolution, mailProxyUrlFromSetting } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('mail proxy resolution preserves Chromium preference order', () => {
  assert.equal(
    mailProxyUrlFromResolution('PROXY 127.0.0.1:10808; SOCKS5 127.0.0.1:10809; DIRECT'),
    'http://127.0.0.1:10808/'
  );
  assert.equal(
    mailProxyUrlFromResolution('SOCKS5 127.0.0.1:10808; DIRECT'),
    'socks5://127.0.0.1:10808'
  );
  assert.equal(mailProxyUrlFromResolution('DIRECT'), null);
});

test('mail proxy resolution converts proxy rules and targets the mail host', async () => {
  const targets = [];
  const proxy = await mailProxyUrlForHost('smtp.gmail.com', 465, async target => {
    targets.push(target);
    return 'SOCKS 127.0.0.1:10808';
  });

  assert.deepEqual(targets, ['https://smtp.gmail.com:465']);
  assert.equal(proxy, 'socks5://127.0.0.1:10808');
  assert.equal(mailProxyUrlFromResolution('PROXY malformed'), null);
});

test('Gmail 启用应用代理时强制使用应用代理，不再优先系统代理', async () => {
  let systemReads = 0;
  const proxy = await mailProxyUrlForHost(
    'imap.gmail.com',
    993,
    async () => {
      systemReads += 1;
      return 'SOCKS5 127.0.0.1:10809';
    },
    { enabled: true, value: 'http://127.0.0.1:10808', label: 'Gmail' }
  );

  assert.equal(proxy, 'http://127.0.0.1:10808/');
  assert.equal(systemReads, 0);
});

test('Gmail 未启用应用代理时只遵循系统代理', async () => {
  let systemReads = 0;
  const direct = await mailProxyUrlForHost(
    'imap.gmail.com',
    993,
    async () => {
      systemReads += 1;
      return 'DIRECT';
    },
    { enabled: false, value: 'http://127.0.0.1:10808', label: 'Gmail' }
  );
  assert.equal(direct, null);
  assert.equal(systemReads, 1);

  const systemProxy = await mailProxyUrlForHost(
    'smtp.gmail.com',
    465,
    async () => 'PROXY 127.0.0.1:7890',
    { enabled: false, value: 'http://127.0.0.1:10808', label: 'Gmail' }
  );
  assert.equal(systemProxy, 'http://127.0.0.1:7890/');
});

test('Gmail 启用应用代理但地址为空或无效时明确失败', async () => {
  await assert.rejects(
    mailProxyUrlForHost('imap.gmail.com', 993, async () => 'DIRECT', {
      enabled: true,
      value: '',
      label: 'Gmail'
    }),
    /Gmail已启用应用代理，但代理地址为空或格式无效/u
  );
  await assert.rejects(
    mailProxyUrlForHost('imap.gmail.com', 993, async () => 'DIRECT', {
      enabled: true,
      value: 'socks5://127.0.0.1:10808',
      label: 'Gmail'
    }),
    /Gmail已启用应用代理，但代理地址为空或格式无效/u
  );
});

test('mail proxy settings accept only complete HTTP(S) proxy URLs', () => {
  assert.equal(mailProxyUrlFromSetting(' http://127.0.0.1:10808 '), 'http://127.0.0.1:10808/');
  assert.equal(mailProxyUrlFromSetting('socks5://127.0.0.1:10808'), null);
  assert.equal(mailProxyUrlFromSetting('not a url'), null);
  assert.equal(mailProxyUrlFromSetting('http://127.0.0.1:10808/path'), null);
  assert.equal(mailProxyUrlFromSetting(''), null);
});
