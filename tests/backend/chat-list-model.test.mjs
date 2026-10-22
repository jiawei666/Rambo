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
