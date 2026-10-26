import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const app = process.env.RAMBO_APP_PATH
  ? resolve(process.env.RAMBO_APP_PATH)
  : join(root, 'dist/mac-arm64/Rambo.app');
test('候选应用不包含 Codex 运行时，改由本机或缓存解析', () => {
  assert.ok(existsSync(app), `候选应用不存在：${app}`);
  assert.equal(
    existsSync(join(app, 'Contents/Resources/runtime/codex')),
    false,
    '候选应用不应再携带大型 Codex 运行时'
  );
});
