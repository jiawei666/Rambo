import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/shared/proxy-settings.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const {
  migrateRuntimeProxyScopes,
  normalizeRuntimeProxyAddress,
  normalizeRuntimeProxyScopes,
  runtimeProxyAddressIsValid,
  runtimeProxyScopesFromInput,
  serializeRuntimeProxyScopes
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('代理地址只接受完整 HTTP(S) 地址并规范化结尾', () => {
  assert.equal(normalizeRuntimeProxyAddress(' http://127.0.0.1:10808 '), 'http://127.0.0.1:10808/');
  assert.equal(normalizeRuntimeProxyAddress('https://proxy.example.com:8443'), 'https://proxy.example.com:8443/');
  assert.equal(runtimeProxyAddressIsValid('http://localhost:7890'), true);
  assert.equal(runtimeProxyAddressIsValid(''), false);
  assert.throws(() => normalizeRuntimeProxyAddress('socks5://127.0.0.1:10808'), /http:\/\/ 或 https:\/\//u);
  assert.throws(() => normalizeRuntimeProxyAddress('http://127.0.0.1:10808/path'), /不能包含路径/u);
  assert.throws(() => normalizeRuntimeProxyAddress('http://127.0.0.1:10808?token=secret'), /不能包含路径/u);
  assert.throws(() => normalizeRuntimeProxyAddress('not a url'), /格式无效/u);
});

test('代理范围可多选、去重并固定顺序', () => {
  assert.deepEqual(runtimeProxyScopesFromInput(['gmail', 'model', 'gmail']), ['model', 'gmail']);
  assert.deepEqual(runtimeProxyScopesFromInput([]), []);
  assert.deepEqual(normalizeRuntimeProxyScopes('gmail,model'), ['model', 'gmail']);
  assert.equal(serializeRuntimeProxyScopes(['gmail', 'model']), 'model,gmail');
  assert.throws(() => runtimeProxyScopesFromInput(['all']), /无效的代理适用范围/u);
  assert.throws(() => runtimeProxyScopesFromInput('model,gmail'), /无效的代理适用范围/u);
});

test('旧代理迁移默认启用两个范围，空地址迁移为空范围', () => {
  assert.deepEqual(migrateRuntimeProxyScopes('http://127.0.0.1:10808', undefined), ['model', 'gmail']);
  assert.deepEqual(migrateRuntimeProxyScopes('socks5://127.0.0.1:10808', undefined), []);
  assert.deepEqual(migrateRuntimeProxyScopes('', undefined), []);
  assert.deepEqual(migrateRuntimeProxyScopes('http://127.0.0.1:10808', 'gmail'), ['gmail']);
  assert.deepEqual(migrateRuntimeProxyScopes('http://127.0.0.1:10808', ''), []);
});
