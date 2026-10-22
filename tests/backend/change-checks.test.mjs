import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function plan(...paths) {
  const result = spawnSync(process.execPath, [
    resolve(root, 'scripts/change-checks.mjs'),
    '--paths',
    paths.join(',')
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('change checks select only the relevant backend target for a known host module', () => {
  const result = plan('src/main/store.ts');
  assert.deepEqual(result.plan.map(item => item.check), ['typecheck', 'backend-unit']);
  assert.deepEqual(result.plan[1].targets, ['tests/backend/store.test.mjs']);
  assert.equal(result.plan.some(item => item.check === 'electron-e2e'), false);
});

test('change checks keep renderer-only edits free of Electron E2E by default', () => {
  const result = plan('src/renderer/styles.css');
  assert.deepEqual(result.plan.map(item => item.check), ['typecheck']);
  assert.deepEqual(result.unmatched, []);
});

test('change checks keep test orchestration changes lightweight', () => {
  const result = plan('tests/change-checks.json', 'scripts/change-checks.mjs');
  assert.deepEqual(result.plan.map(item => item.check), ['acceptance-structure', 'acceptance-tests']);
  assert.equal(result.plan.some(item => item.check === 'build'), false);
});

test('change checks use the existing same-name test for an unregistered main module', () => {
  const result = plan('src/main/system-indicators.ts');
  assert.deepEqual(result.plan.map(item => item.check), ['typecheck', 'backend-unit']);
  assert.deepEqual(result.plan[1].targets, ['tests/backend/system-indicators.test.mjs']);
});

test('change checks run only the changed backend test file', () => {
  const result = plan('tests/backend/change-checks.test.mjs');
  assert.deepEqual(result.plan.map(item => item.check), ['backend-unit']);
  assert.deepEqual(result.plan[0].targets, ['tests/backend/change-checks.test.mjs']);
  assert.deepEqual(result.unmatched, []);
});
