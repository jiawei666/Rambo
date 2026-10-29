import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const app = process.env.RAMBO_APP_PATH
  ? resolve(process.env.RAMBO_APP_PATH)
  : join(root, 'dist/mac-arm64/Rambo.app');
test('候选应用内置校验后的 Codex App Server', () => {
  assert.ok(existsSync(app), `候选应用不存在：${app}`);
  const runtime = join(app, 'Contents/Resources/runtime/codex/0.165.0');
  assert.ok(existsSync(join(runtime, 'codex-package.json')), '候选应用缺少内置 App Server manifest');
  assert.ok(existsSync(join(runtime, 'bin/codex-app-server')), '候选应用缺少内置 codex-app-server');
});
