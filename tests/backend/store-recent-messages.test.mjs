import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const compiledSchedule = ts.transpileModule(
  readFileSync(new URL('../../src/main/routine-schedule.ts', import.meta.url), 'utf8'),
  { compilerOptions }
).outputText;
const compiledContracts = ts.transpileModule(
  readFileSync(new URL('../../src/shared/contracts.ts', import.meta.url), 'utf8'),
  { compilerOptions }
).outputText;
const compiledRobotAvatar = ts.transpileModule(
  readFileSync(new URL('../../src/shared/robot-avatar.ts', import.meta.url), 'utf8'),
  { compilerOptions }
).outputText;
const compiled = ts.transpileModule(
  readFileSync(new URL('../../src/main/store.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText
  .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'")
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
  .replaceAll("from '../shared/robot-avatar'", "from './robot-avatar.mjs'");

async function loadStore() {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-store-recent-'));
  const path = join(directory, 'store.mjs');
  writeFileSync(join(directory, 'routine-schedule.mjs'), compiledSchedule);
  writeFileSync(join(directory, 'contracts.mjs'), compiledContracts);
  writeFileSync(join(directory, 'robot-avatar.mjs'), compiledRobotAvatar);
  writeFileSync(path, compiled);
  const { Store } = await import(`${pathToFileURL(path).href}?${Date.now()}`);
  return { Store, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('侧栏预览使用每个可见私聊最后一条用户或 Bot 消息', () => {
  const appDirectory = mkdtempSync(join(tmpdir(), 'rambo-recent-app-'));
  let cleanup = () => rmSync(appDirectory, { recursive: true, force: true });
  return loadStore().then(({ Store, cleanup: cleanupModule }) => {
    const store = new Store(appDirectory);
    store.setSetting('defaultBotModel', 'test-model');
    store.setSetting('defaultBotPermission', 'fullAccess');
    try {
      const first = store.createBot('Alpha', 'a');
      const second = store.createBot('Beta', 'b');
      store.addMessage(first.chat.id, 'user', '第一句');
      store.addMessage(first.chat.id, 'assistant', '最后一句话');
      store.addMessage(first.chat.id, 'system', '内部状态不应显示');
      store.addMessage(second.chat.id, 'user', 'Beta 最新消息');
      assert.deepEqual(store.recentMessages(), {
        [first.chat.id]: '最后一句话',
        [second.chat.id]: 'Beta 最新消息'
      });
    } finally {
      store.close();
      cleanupModule();
      cleanup();
    }
  });
});

test('未读数只统计上次已读时间之后可见私聊中的 Bot 消息，并可清零', () => {
  const appDirectory = mkdtempSync(join(tmpdir(), 'rambo-unread-app-'));
  return loadStore().then(({ Store, cleanup: cleanupModule }) => {
    const store = new Store(appDirectory);
    store.setSetting('defaultBotModel', 'test-model');
    store.setSetting('defaultBotPermission', 'fullAccess');
    try {
      const { chat } = store.createBot('Unread Bot', 'u');
      store.addMessage(chat.id, 'assistant', '第一条 Bot 消息');
      assert.equal(store.unreadCounts()[chat.id], 1);

      store.markChatRead(chat.id);
      assert.equal(store.unreadCounts()[chat.id], undefined);

      store.addMessage(chat.id, 'user', '已读后的用户消息');
      assert.equal(store.unreadCounts()[chat.id], undefined);
      store.addMessage(chat.id, 'assistant', '已读后的 Bot 消息');
      assert.equal(store.unreadCounts()[chat.id], 1);
      store.addMessage(chat.id, 'system', '内部状态');
      assert.equal(store.unreadCounts()[chat.id], 1);
    } finally {
      store.close();
      cleanupModule();
      rmSync(appDirectory, { recursive: true, force: true });
    }
  });
});
