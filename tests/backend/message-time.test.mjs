import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/renderer/message-time.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

test('message time dividers mark the first message, a new day, and a 15 minute gap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-message-time-test-'));
  const modulePath = join(directory, 'message-time.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  try {
    const { shouldShowMessageDivider, shouldShowMessageTimeDivider } =
      await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    assert.equal(shouldShowMessageDivider(undefined, '2026-10-23T08:00:00+08:00'), true);
    assert.equal(shouldShowMessageDivider('2026-10-23T08:00:00+08:00', '2026-10-23T08:14:59+08:00'), false);
    assert.equal(shouldShowMessageDivider('2026-10-23T08:00:00+08:00', '2026-10-23T08:15:00+08:00'), true);
    assert.equal(shouldShowMessageDivider('2026-10-23T23:59:00+08:00', '2026-10-24T00:01:00+08:00'), true);
    assert.equal(shouldShowMessageDivider('not-a-date', '2026-10-23T08:00:00+08:00'), true);
    assert.equal(shouldShowMessageDivider('2026-10-23T08:00:00+08:00', 'not-a-date'), false);

    const messages = [
      { role: 'user', createdAt: '2026-10-23T08:00:00+08:00' },
      { role: 'system', createdAt: '2026-10-23T08:10:00+08:00' },
      { role: 'user', createdAt: '2026-10-23T08:14:59+08:00' },
      { role: 'user', createdAt: '2026-10-23T08:30:00+08:00' },
      { role: 'system', createdAt: '2026-10-23T09:00:00+08:00' }
    ];
    assert.equal(shouldShowMessageTimeDivider(messages, 0), true);
    assert.equal(shouldShowMessageTimeDivider(messages, 1), false);
    assert.equal(shouldShowMessageTimeDivider(messages, 2), false);
    assert.equal(shouldShowMessageTimeDivider(messages, 3), true);
    assert.equal(shouldShowMessageTimeDivider(messages, 4), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('message time labels render localized date, weekday and minute precision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-message-time-test-'));
  const modulePath = join(directory, 'message-time.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  try {
    const { formatMessageDivider, formatMessageHoverTime } = await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    assert.match(formatMessageDivider('2026-10-23T08:06:00+08:00'), /^10月23日周[一二三四五六日] 08:06$/u);
    assert.match(formatMessageHoverTime('2026-10-23T08:06:00+08:00'), /^10月23日 周[一二三四五六日] 08:06$/u);
    assert.equal(formatMessageDivider('not-a-date'), 'not-a-date');
    assert.equal(formatMessageHoverTime('not-a-date'), 'not-a-date');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
