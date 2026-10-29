import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

function verify(args) {
  return spawnSync(process.execPath, ['scripts/verify.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' }
  });
}

test('candidate gate cannot pass while any catalog gap remains unimplemented', () => {
  const result = verify(['--gate', 'candidate']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /候选版本被未实现案例阻止/);
});

test('release gate reports a concrete uncovered rule before running tests', () => {
  const result = verify(['--gate', 'release', '--sections', 'J1']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /发布验收被缺口阻止/);
  assert.match(result.stderr, /无已实现测试|未实现案例/);
});

test('feature gate rejects a rule that only has a documented gap', () => {
  const result = verify(['--gate', 'feature', '--rules', 'T06']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /尚无已实现测试：T06/);
});

test('verify never turns an empty automated selection into a passing gate', () => {
  const result = verify(['--gate', 'release', '--sections', 'unknown']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未知旅程或发布套件：unknown/);
});

test('Playwright test paths follow a stable grep option and separator', () => {
  const source = readFileSync(resolve(root, 'scripts/verify.mjs'), 'utf8');
  assert.match(
    source,
    /'playwright', 'test', '--workers=1',[\s\S]*?--grep=\(\$\{patterns\.join\('\|'\)\}\)[\s\S]*?'--',[\s\S]*?\.\.\.new Set\(e2eCases\.map\(item => item\.target\)\)/,
    'Playwright 的 --grep 必须使用稳定子串、位于测试文件参数之前，并用 -- 分隔目标'
  );
});

test('shared Electron fixture changes keep every harness E2E target', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/change-checks.mjs', '--paths', 'tests/e2e/fixtures/electron-app.mjs'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  const e2e = plan.plan.find(item => item.check === 'electron-e2e');
  assert.ok(e2e);
  for (const target of [
    'tests/e2e/private-chat.spec.mjs',
    'tests/e2e/group-chat.spec.mjs',
    'tests/e2e/avatar-picker.spec.mjs',
    'tests/e2e/media-preview.spec.mjs',
    'tests/e2e/runtime-startup.spec.mjs'
  ]) {
    assert.ok(e2e.targets.includes(target), `缺少 Electron 目标：${target}`);
  }
});
