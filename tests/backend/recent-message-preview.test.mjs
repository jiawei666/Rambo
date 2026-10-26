import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
const notificationsSource = readFileSync(new URL('../../src/shared/notifications.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');

test('侧栏预览按到达顺序更新，迟到事件不会回退', async () => {
  const start = source.indexOf('export function mergeRecentMessage(');
  assert.notEqual(start, -1, '找不到 mergeRecentMessage');
  const end = source.indexOf('\n}\n', start) + 3;
  const directory = mkdtempSync(join(tmpdir(), 'rambo-preview-model-'));
  const path = join(directory, 'preview.mjs');
  writeFileSync(path, ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText);
  try {
    const { mergeRecentMessage } = await import(`${pathToFileURL(path).href}?${Date.now()}`);
    const message = (id, text, createdAt) => ({
      id, chatId: 'chat-1', role: 'assistant', text, status: 'complete',
      itemId: id, createdAt, turnId: 'turn-1', phase: null
    });
    let preview = mergeRecentMessage({}, message('user', '用户消息', '2026-10-22T10:00:00.000Z'));
    preview = mergeRecentMessage(preview, message('commentary', '阶段回复', '2026-10-22T10:00:01.000Z'));
    preview = mergeRecentMessage(preview, message('commentary', '阶段回复更新', '2026-10-22T10:00:01.000Z'));
    assert.equal(preview['chat-1'], '阶段回复更新');
    preview = mergeRecentMessage(preview, message('final-same-time', '同一时间的最终回复', '2026-10-22T10:00:01.000Z'));
    assert.equal(preview['chat-1'], '同一时间的最终回复');
    preview = mergeRecentMessage(preview, message('final', '最新回复', '2026-10-22T10:00:02.000Z'));
    assert.equal(preview['chat-1'], '最新回复');
    preview = mergeRecentMessage(preview, message('stale-final', '迟到的旧最终回复', '2026-10-22T10:00:01.500Z'));
    assert.equal(preview['chat-1'], '最新回复');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('未读数只累加其他私聊的 Bot 消息，用户消息与当前可见私聊不累加', async () => {
  const start = source.indexOf('export function mergeUnreadCount(');
  assert.notEqual(start, -1, '找不到 mergeUnreadCount');
  const end = source.indexOf('\n}\n', start) + 3;
  const directory = mkdtempSync(join(tmpdir(), 'rambo-unread-model-'));
  const path = join(directory, 'unread.mjs');
  writeFileSync(path, ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText);
  try {
    const { mergeUnreadCount } = await import(`${pathToFileURL(path).href}?${Date.now()}`);
    const message = (chatId, role, itemId = `${chatId}-${role}`) => ({
      id: `${chatId}-${role}`, chatId, role, text: '测试', status: 'complete',
      itemId, createdAt: '2026-10-22T10:00:00.000Z', turnId: null, phase: null
    });
    const seenItems = new Set();
    let counts = mergeUnreadCount({}, message('chat-a', 'assistant', 'assistant-1'), false, seenItems);
    counts = mergeUnreadCount(counts, message('chat-a', 'assistant', 'assistant-1'), false, seenItems);
    counts = mergeUnreadCount(counts, message('chat-a', 'assistant', 'assistant-2'), false, seenItems);
    counts = mergeUnreadCount(counts, message('chat-a', 'user'), false, seenItems);
    counts = mergeUnreadCount(counts, message('chat-b', 'assistant'), true, seenItems);
    assert.deepEqual(counts, { 'chat-a': 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('当前前台私聊的快照刷新不把刚看到的 Bot 回复重新显示为未读', async () => {
  const start = source.indexOf('export function keepVisibleChatUnreadClear<');
  assert.notEqual(start, -1, '找不到 keepVisibleChatUnreadClear');
  const end = source.indexOf('\n}\n', start) + 3;
  const directory = mkdtempSync(join(tmpdir(), 'rambo-visible-unread-'));
  const path = join(directory, 'visible-unread.mjs');
  writeFileSync(path, ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText);
  try {
    const { keepVisibleChatUnreadClear } = await import(`${pathToFileURL(path).href}?${Date.now()}`);
    const snapshot = {
      unreadCounts: { 'chat-a': 1, 'chat-b': 2 }
    };
    assert.deepEqual(
      keepVisibleChatUnreadClear(snapshot, 'chat-a', true),
      { unreadCounts: { 'chat-a': 0, 'chat-b': 2 } }
    );
    assert.equal(keepVisibleChatUnreadClear(snapshot, 'chat-a', false), snapshot);
    assert.equal(keepVisibleChatUnreadClear(snapshot, null, true), snapshot);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('普通 turn 终态提醒覆盖完成、失败和中断，与未读共用当前会话和焦点语义', async () => {
  const start = notificationsSource.indexOf('export function decideBotTurnFinishedNotification(');
  assert.notEqual(start, -1, '找不到 decideBotTurnFinishedNotification');
  const end = notificationsSource.indexOf('\n}\n', start) + 3;
  const directory = mkdtempSync(join(tmpdir(), 'rambo-reply-notification-'));
  const path = join(directory, 'reply-notification.mjs');
  writeFileSync(path, ts.transpileModule(notificationsSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText);
  try {
    const { decideBotTurnFinishedNotification } = await import(`${pathToFileURL(path).href}?${Date.now()}`);
    const base = {
      status: 'completed', text: '已完成',
      enabled: true, archived: false, visibleAndFocused: false
    };
    assert.deepEqual(decideBotTurnFinishedNotification(base),
      { notify: true, reason: 'enabled' });
    assert.deepEqual(decideBotTurnFinishedNotification({ ...base, visibleAndFocused: true }),
      { notify: false, reason: 'visible' });
    assert.deepEqual(decideBotTurnFinishedNotification({ ...base, enabled: false }),
      { notify: false, reason: 'disabled' });
    assert.equal(decideBotTurnFinishedNotification({ ...base, archived: true }).notify, false);
    assert.equal(decideBotTurnFinishedNotification({ ...base, text: '   ' }).notify, false);
    assert.equal(decideBotTurnFinishedNotification({ ...base, status: 'running' }).notify, false);
    assert.equal(decideBotTurnFinishedNotification({ ...base, status: 'unknown' }).notify, false);
    assert.equal(decideBotTurnFinishedNotification({ ...base, status: 'failed' }).notify, true);
    assert.equal(decideBotTurnFinishedNotification({ ...base, status: 'failed', text: '' }).notify, true);
    assert.equal(decideBotTurnFinishedNotification({ ...base, status: 'interrupted' }).notify, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('新消息提醒的准入矩阵与未读红点共用可忽略范围', async () => {
  const unreadStart = source.indexOf('export function mergeUnreadCount(');
  assert.notEqual(unreadStart, -1, '找不到 mergeUnreadCount');
  const unreadEnd = source.indexOf('\n}\n', unreadStart) + 3;
  const start = notificationsSource.indexOf('export function decideBotTurnFinishedNotification(');
  assert.notEqual(start, -1, '找不到 decideBotTurnFinishedNotification');
  const end = notificationsSource.indexOf('\n}\n', start) + 3;
  const directory = mkdtempSync(join(tmpdir(), 'rambo-reply-notification-matrix-'));
  const path = join(directory, 'reply-notification-matrix.mjs');
  writeFileSync(path, ts.transpileModule(source.slice(unreadStart, unreadEnd)
    + '\n' + notificationsSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText);
  try {
    const { decideBotTurnFinishedNotification, mergeUnreadCount } =
      await import(`${pathToFileURL(path).href}?${Date.now()}`);
    const base = {
      status: 'completed', text: '需要提醒的 Bot 回复',
      enabled: true, archived: false, visibleAndFocused: false
    };
    const cases = [
      [{}, { notify: true, reason: 'enabled' }],
      [{ visibleAndFocused: true }, { notify: false, reason: 'visible' }],
      [{ enabled: false }, { notify: false, reason: 'disabled' }],
      [{ archived: true }, { notify: false, reason: 'ineligible' }],
      [{ text: '   ' }, { notify: false, reason: 'ineligible' }],
      [{ status: 'running' }, { notify: false, reason: 'ineligible' }],
      [{ status: 'unknown' }, { notify: false, reason: 'ineligible' }],
      [{ status: 'failed', text: '' }, { notify: true, reason: 'enabled' }],
      [{ status: 'interrupted' }, { notify: true, reason: 'enabled' }]
    ];
    for (const [patch, expected] of cases) {
      assert.deepEqual(decideBotTurnFinishedNotification({ ...base, ...patch }),
        expected, JSON.stringify(patch));
    }
    const seen = new Set();
    let unread = mergeUnreadCount({}, {
      id: 'matrix-assistant', chatId: 'matrix-chat', role: 'assistant',
      text: '需要提醒的 Bot 回复', status: 'complete', itemId: 'matrix-item',
      createdAt: '2026-10-26T04:00:00.000Z', turnId: 'matrix-turn', phase: 'final_answer'
    }, false, seen);
    assert.deepEqual(unread, { 'matrix-chat': 1 });
    unread = mergeUnreadCount(unread, {
      id: 'matrix-assistant', chatId: 'matrix-chat', role: 'assistant',
      text: '需要提醒的 Bot 回复', status: 'complete', itemId: 'matrix-item',
      createdAt: '2026-10-26T04:00:00.000Z', turnId: 'matrix-turn', phase: 'final_answer'
    }, false, seen);
    assert.deepEqual(unread, { 'matrix-chat': 1 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('新消息系统通知以 Bot 名称作为标题，正文显示回复预览', () => {
  const functionStart = mainSource.indexOf(
    'function showBotReplyNotification('
  );
  assert.notEqual(functionStart, -1, '找不到 showBotReplyNotification');
  const functionEnd = mainSource.indexOf('\n}\n', functionStart) + 3;
  const source = mainSource.slice(functionStart, functionEnd);
  assert.match(source, /\btitle:\s*event\.botId\s*\?\s*store\.bot\(event\.botId\)\.name\s*:\s*'Rambo'/);
  assert.doesNotMatch(source, /\bsubtitle\s*:/);
  assert.match(source, /\bbody\s*:/);
});

test('Routine 成功默认静默，开启后提醒，失败和待处理提醒', async () => {
  const start = notificationsSource.indexOf('export function decideRoutineFinishedNotification(');
  assert.notEqual(start, -1, '找不到 decideRoutineFinishedNotification');
  const end = notificationsSource.indexOf('\n}\n', start) + 3;
  const directory = mkdtempSync(join(tmpdir(), 'rambo-routine-notification-'));
  const path = join(directory, 'routine-notification.mjs');
  writeFileSync(path, ts.transpileModule(notificationsSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText);
  try {
    const { decideRoutineFinishedNotification } = await import(`${pathToFileURL(path).href}?${Date.now()}`);
    const base = {
      status: 'succeeded', successNotification: false, enabled: true,
      archived: false, visibleAndFocused: false
    };
    assert.equal(decideRoutineFinishedNotification(base).notify, false);
    assert.equal(decideRoutineFinishedNotification({ ...base, successNotification: true }).notify, true);
    assert.equal(decideRoutineFinishedNotification({ ...base, status: 'failed' }).notify, true);
    assert.equal(decideRoutineFinishedNotification({ ...base, status: 'interrupted' }).notify, true);
    assert.equal(decideRoutineFinishedNotification({ ...base, status: 'needs_user' }).notify, true);
    assert.equal(decideRoutineFinishedNotification({ ...base, status: 'failed', enabled: false }).notify, false);
    assert.equal(decideRoutineFinishedNotification({ ...base, status: 'failed', visibleAndFocused: true }).notify, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
