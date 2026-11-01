import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/mail-network.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const { mailProxyUrlForHost, mailProxyUrlFromResolution } = await import(
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
