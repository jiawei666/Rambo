import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/renderer/group-composer-settings.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }
}).outputText;

async function withComponent(run) {
  const directory = mkdtempSync(join(process.cwd(), '.rambo-group-composer-test-'));
  const modulePath = join(directory, 'group-composer-settings.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  try {
    const component = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    await run(component);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('group composer renders private-chat style model and permission controls for each member session', async () => {
  await withComponent(async ({ GroupComposerSettings }) => {
    const bots = [
      { id: 'bot-a', name: 'A', model: 'model-a', permission: 'fullAccess', archived: false },
      { id: 'bot-b', name: 'B', model: null, permission: 'readOnly', archived: false }
    ];
    const chats = [
      { id: 'group-a', botId: 'bot-a', groupChatId: 'group-1', model: 'model-b', permission: 'readOnly' },
      { id: 'group-b', botId: 'bot-b', groupChatId: 'group-1', model: null, permission: null }
    ];
    const html = renderToStaticMarkup(createElement(GroupComposerSettings, {
      groupId: 'group-1', bots, chats,
      models: [
        { id: 'model-a', label: 'Model A', isDefault: false },
        { id: 'model-b', label: 'Model B', isDefault: true }
      ],
      onUpdateChat: async () => {}, onError: () => {}
    }));

    assert.equal((html.match(/class="composer-setting(?: model-setting)?"/g) ?? []).length, 2);
    assert.match(html, /aria-label="群聊成员权限覆盖"/);
    assert.match(html, /aria-label="群聊成员模型覆盖"/);
    assert.match(html, /optgroup label="A"/);
    assert.match(html, /optgroup label="B"/);
    assert.match(html, /只读 · 当前/);
    assert.match(html, /Model B · 产品默认 · 当前/);
    assert.match(html, /仅作用于对应 Bot 在本群的会话/);
    assert.doesNotMatch(html, /群聊默认设置/);
  });
});

test('group composer applies changes to the selected member chat only, including inherit actions', async () => {
  await withComponent(async ({ applyModelAction, applyPermissionAction, modelAction, permissionAction }) => {
    const updates = [];
    const onUpdateChat = async (chatId, patch) => { updates.push({ chatId, patch }); };
    assert.equal(await applyPermissionAction(permissionAction('group-chat-a', 'readOnly'), onUpdateChat), true);
    assert.equal(await applyPermissionAction(permissionAction('group-chat-b', null), onUpdateChat), true);
    assert.equal(await applyModelAction(modelAction('group-chat-b', 'model-b'), onUpdateChat), true);
    assert.equal(await applyModelAction(modelAction('group-chat-a', null), onUpdateChat), true);
    assert.equal(await applyModelAction('invalid-action', onUpdateChat), false);
    assert.deepEqual(updates, [
      { chatId: 'group-chat-a', patch: { permission: 'readOnly' } },
      { chatId: 'group-chat-b', patch: { permission: null } },
      { chatId: 'group-chat-b', patch: { model: 'model-b' } },
      { chatId: 'group-chat-a', patch: { model: null } }
    ]);
  });
});
