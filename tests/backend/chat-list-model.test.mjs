import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/renderer/chat-list-model.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

test('selected chat is rejected when its bot differs and Bot selection resolves that Bot private chat', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-chat-selection-test-'));
  const modulePath = join(directory, 'chat-list-model.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  try {
    const { privateChatForBot, selectedPrivateChat, shouldShowReturnToChat } = await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    const chats = [
      { id: 'chat-a', botId: 'bot-a', archived: false, updatedAt: '2026-10-21T11:00:00Z' },
      { id: 'chat-b', botId: 'bot-b', archived: false, updatedAt: '2026-10-21T10:00:00Z' },
      { id: 'old-b', botId: 'bot-b', archived: true, updatedAt: '2026-10-21T12:00:00Z' }
    ];

    assert.equal(selectedPrivateChat(chats, 'chat-a', 'bot-b'), null);
    assert.equal(privateChatForBot(chats, 'bot-b').id, 'chat-b');
    assert.equal(selectedPrivateChat(chats, 'chat-b', 'bot-b').id, 'chat-b');
    assert.equal(selectedPrivateChat(chats, 'old-b', 'bot-b'), null);
    assert.equal(shouldShowReturnToChat('chat'), false);
    assert.equal(shouldShowReturnToChat('group-chat'), false);
    assert.equal(shouldShowReturnToChat('bot-settings'), true);
    assert.equal(shouldShowReturnToChat('routines'), true);
    assert.equal(shouldShowReturnToChat('settings'), true);
    assert.equal(shouldShowReturnToChat('group-create'), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sidebar mixes Bots and groups by pin time then creation time', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-chat-list-model-test-'));
  const modulePath = join(directory, 'chat-list-model.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  try {
    const { sidebarConversations } = await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    const bot = (id, createdAt, pinnedAt = null, archived = false) => ({
      id, name: id, avatar: 'a', role: '', instructions: '', model: 'test',
      permission: 'fullAccess', archived, createdAt, pinnedAt, resourceIds: [],
      notificationsEnabled: true
    });
    const group = (id, createdAt, pinnedAt = null, archived = false) => ({
      id, title: id, archived, pinnedAt, memberIds: ['bot-old', 'bot-new'],
      defaultBotId: null, createdAt, updatedAt: createdAt
    });
    const bots = [
      bot('bot-new', '2026-10-04T00:00:00.000Z'),
      bot('bot-pinned-older', '2026-10-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
      bot('bot-old', '2026-10-02T00:00:00.000Z'),
      bot('bot-pinned-newer', '2026-10-03T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
      bot('bot-archived', '2026-10-10T00:00:00.000Z', null, true)
    ];
    const groups = [
      group('group-newest', '2026-10-05T00:00:00.000Z'),
      group('group-older', '2026-10-01T12:00:00.000Z'),
      group('group-archived', '2026-10-11T00:00:00.000Z', null, true)
    ];

    const ids = sidebarConversations(bots, groups).map(item =>
      item.kind === 'bot' ? item.bot.id : item.group.id
    );
    assert.deepEqual(ids, [
      'bot-pinned-newer',
      'bot-pinned-older',
      'group-newest',
      'bot-new',
      'bot-old',
      'group-older'
    ]);

    bots.find(item => item.id === 'bot-pinned-newer').pinnedAt = null;
    bots.find(item => item.id === 'bot-new').pinnedAt = '2026-10-22T00:00:00.000Z';
    assert.deepEqual(sidebarConversations(bots, groups).map(item =>
      item.kind === 'bot' ? item.bot.id : item.group.id
    ), [
      'bot-new',
      'bot-pinned-older',
      'group-newest',
      'bot-pinned-newer',
      'bot-old',
      'group-older'
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
