import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const storeSourcePath = new URL('../../src/main/store.ts', import.meta.url);
const scheduleSourcePath = new URL('../../src/main/routine-schedule.ts', import.meta.url);
const compiledSchedule = ts.transpileModule(readFileSync(scheduleSourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const compiledStore = ts.transpileModule(readFileSync(storeSourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText.replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'");
const groupActionsSourcePath = new URL('../../src/renderer/group-create-actions.ts', import.meta.url);
const compiledGroupActions = ts.transpileModule(readFileSync(groupActionsSourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

async function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-store-test-'));
  const modulePath = join(directory, 'store.mjs');
  writeFileSync(join(directory, 'routine-schedule.mjs'), compiledSchedule, { mode: 0o600 });
  writeFileSync(modulePath, compiledStore, { mode: 0o600 });
  try {
    const { Store } = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    await run(Store, directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('migrates legacy chats without changing existing bot/chat data', async () => {
  await withDirectory(async (Store, directory) => {
    // Create the schema used before chat overrides existed.
    const path = join(directory, 'rambo.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '', model TEXT, permission TEXT NOT NULL DEFAULT 'fullAccess',
        archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE chats (
        id TEXT PRIMARY KEY, botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        title TEXT NOT NULL, threadId TEXT, archived INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      INSERT INTO bots(id,name,avatar,createdAt) VALUES('bot-old','Old bot','x','2025-01-01T00:00:00.000Z');
      INSERT INTO chats(id,botId,title,createdAt,updatedAt)
        VALUES('chat-old','bot-old','Existing title','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');`);
    db.close();

    const migrated = new Store(directory);
    try {
      assert.equal(migrated.chat('chat-old').title, 'Existing title');
      assert.equal(migrated.chat('chat-old').model, null);
      assert.equal(migrated.chat('chat-old').permission, null);
      assert.equal(migrated.chatRoutineToolsEnabled('chat-old'), false);
    } finally { migrated.close(); }
  });
});

test('migrates saved groups to allow a retained group with no default Bot', async () => {
  await withDirectory(async (Store, directory) => {
    const db = new DatabaseSync(join(directory, 'rambo.sqlite'));
    db.exec(`CREATE TABLE bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '', model TEXT, permission TEXT NOT NULL DEFAULT 'fullAccess',
        archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE group_chats (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        defaultBotId TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE group_chat_members (
        groupChatId TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
        botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, joinedAt TEXT NOT NULL,
        PRIMARY KEY(groupChatId, botId), UNIQUE(groupChatId, position));
      INSERT INTO bots(id,name,avatar,createdAt) VALUES('bot-old','Old bot','x','2025-01-01T00:00:00.000Z');
      INSERT INTO group_chats(id,title,defaultBotId,createdAt,updatedAt)
        VALUES('group-old','Old group','bot-old','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
      INSERT INTO group_chat_members(groupChatId,botId,position,joinedAt)
        VALUES('group-old','bot-old',0,'2025-01-01T00:00:00.000Z');
      PRAGMA user_version=7;`);
    db.close();

    const store = new Store(directory);
    try {
      assert.deepEqual(store.group('group-old').memberIds, ['bot-old']);
      assert.equal(store.group('group-old').defaultBotId, 'bot-old');
      assert.equal(store.db.prepare('PRAGMA table_info(group_chats)').all().find(row => row.name === 'defaultBotId').notnull, 0);
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 15);
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { store.close(); }
  });
});

test('migrates version 12 duplicate private chats once and hides the non-current thread', async () => {
  await withDirectory(async (Store, directory) => {
    const legacy = new Store(directory);
    let botId, currentChatId;
    try {
      const created = legacy.createBot('Migration Bot', 'a');
      botId = created.bot.id;
      currentChatId = created.chat.id;
      legacy.bindThread(currentChatId, 'thread-current-v12');
      legacy.db.prepare('UPDATE chats SET updatedAt=? WHERE id=?').run('2026-10-21T10:00:00.000Z', currentChatId);
      legacy.db.exec('DROP INDEX chats_one_direct_chat_per_bot');
      legacy.db.prepare(`INSERT INTO chats(id,botId,title,threadId,groupChatId,archived,routineToolsEnabled,memoryToolsEnabled,createdAt,updatedAt)
        VALUES(?,?,?,NULL,NULL,0,0,0,?,?)`)
        .run('chat-newer-empty', botId, 'Newer chat without thread', '2026-10-21T11:00:00.000Z', '2026-10-21T11:00:00.000Z');
      legacy.addMessage(currentChatId, 'user', 'current-thread-search-marker');
      legacy.addMessage('chat-newer-empty', 'user', 'archived-thread-search-marker');
      legacy.db.exec('PRAGMA user_version=12;');
    } finally { legacy.close(); }

    const migrated = new Store(directory);
    try {
      assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 15);
      assert.equal(migrated.chat(currentChatId).threadId, 'thread-current-v12');
      assert.equal(migrated.chat(currentChatId).archived, false);
      assert.equal(migrated.chat('chat-newer-empty').archived, true);
      assert.deepEqual(migrated.chats().map(chat => chat.id), [currentChatId]);
      assert.deepEqual(migrated.allChats().map(chat => chat.id), [currentChatId]);
      assert.deepEqual(migrated.search('current-thread-search-marker').map(result => result.chat.id), [currentChatId]);
      assert.deepEqual(migrated.search('archived-thread-search-marker'), []);
      assert.equal(migrated.db.prepare('SELECT COUNT(*) AS count FROM chats WHERE botId=?').get(botId)?.count, 2);
      const directIndex = migrated.db.prepare('PRAGMA index_list(chats)').all()
        .find(index => index.name === 'chats_one_direct_chat_per_bot');
      assert.equal(directIndex?.unique, 1);
      assert.throws(() => migrated.db.prepare(`INSERT INTO chats(id,botId,title,createdAt,updatedAt)
        VALUES(?,?,'Duplicate',?,?)`).run('duplicate-active', botId, new Date().toISOString(), new Date().toISOString()), /UNIQUE constraint failed/);
      migrated.db.exec(`CREATE TRIGGER prevent_repeated_direct_migration BEFORE UPDATE OF archived ON chats
        BEGIN SELECT RAISE(ABORT,'version 13 migration must not repeat'); END`);
    } finally { migrated.close(); }

    const reopened = new Store(directory);
    try {
      assert.equal(reopened.db.prepare('PRAGMA user_version').get()?.user_version, 15);
      assert.equal(reopened.chat('chat-newer-empty').archived, true);
      assert.deepEqual(reopened.chats().map(chat => chat.id), [currentChatId]);
      assert.deepEqual(reopened.allChats().map(chat => chat.id), [currentChatId]);
      assert.equal(reopened.db.prepare('PRAGMA index_list(chats)').all()
        .find(index => index.name === 'chats_one_direct_chat_per_bot')?.unique, 1);
      reopened.db.exec('DROP TRIGGER prevent_repeated_direct_migration');
    } finally { reopened.close(); }
  });
});

test('one persistent chat per Bot keeps chat overrides and Bot defaults scoped', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
    const first = store.createBot('First', 'a');
    const second = store.createBot('Second', 'b');
    const firstAgain = store.ensureBotChat(first.bot.id);
    const secondAgain = store.ensureBotChat(second.bot.id);
    assert.equal(firstAgain.id, first.chat.id);
    assert.equal(secondAgain.id, second.chat.id);
    assert.equal(store.chats().length, 2);

    store.updateChat(first.chat.id, { model: 'gpt-5.6-luna', permission: 'readOnly' });
    assert.equal(store.chat(first.chat.id).model, 'gpt-5.6-luna');
    assert.equal(store.chat(first.chat.id).permission, 'readOnly');
    store.updateChat(first.chat.id, { model: null, permission: null });
    assert.equal(store.chat(first.chat.id).model, null);
    assert.equal(store.chat(first.chat.id).permission, null);

    store.applyBotPermissionToChats(first.bot.id, 'workspaceWrite');
    assert.equal(store.bot(first.bot.id).permission, 'workspaceWrite');
    assert.equal(store.chat(first.chat.id).permission, 'workspaceWrite');
    assert.equal(store.chat(second.chat.id).permission, null);
    assert.equal(store.ensureBotChat(first.bot.id).permission, 'workspaceWrite');
    assert.equal(store.chats().length, 2);

    // The default and all existing chat overrides change as one transaction.
    store.db.exec(`CREATE TRIGGER fail_chat_permission_update BEFORE UPDATE OF permission ON chats
      WHEN OLD.botId='${first.bot.id}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
    assert.throws(() => store.applyBotPermissionToChats(first.bot.id, 'readOnly'), /test failure/);
    assert.equal(store.bot(first.bot.id).permission, 'workspaceWrite');
    assert.equal(store.chat(first.chat.id).permission, 'workspaceWrite');
    store.db.exec('DROP TRIGGER fail_chat_permission_update');

    assert.throws(() => store.updateChat(first.chat.id, { permission: 'admin' }));
    assert.throws(() => store.updateChat(first.chat.id, { title: 'Renamed chat' }), /不支持的聊天字段/);
    assert.throws(() => store.updateChat(first.chat.id, { unexpected: true }));
    assert.throws(() => store.applyBotPermissionToChats(first.bot.id, 'admin'));
    } finally { store.close(); }
  });
});

test('two Bots keep chats, settings, routines, memories, and global settings isolated while persisting across reopen', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    let alpha, beta, alphaRoutine, betaRoutine, alphaMemory, betaMemory;
    try {
      alpha = store.createBot('Alpha owner', 'a');
      beta = store.createBot('Beta owner', 'b');
      store.updateBot(alpha.bot.id, { role: 'Researcher', instructions: 'Alpha-only instructions' });
      store.updateBot(beta.bot.id, { role: 'Writer', instructions: 'Beta-only instructions' });
      store.updateChat(alpha.chat.id, { model: 'alpha-chat-model', permission: 'readOnly' });
      store.updateChat(beta.chat.id, { model: 'beta-chat-model', permission: 'workspaceWrite' });
      store.addMessage(alpha.chat.id, 'user', 'ALPHA-OWNER-MARKER');
      store.addMessage(beta.chat.id, 'user', 'BETA-OWNER-MARKER');
      alphaRoutine = store.createRoutine({
        botId: alpha.bot.id,
        title: 'Alpha routine',
        instruction: 'Only Alpha should see this routine.',
        schedule: '每天 08:00',
        sourceCallId: 'owner-isolation-alpha'
      });
      betaRoutine = store.createRoutine({
        botId: beta.bot.id,
        title: 'Beta routine',
        instruction: 'Only Beta should see this routine.',
        schedule: '每周一 09:00',
        sourceCallId: 'owner-isolation-beta'
      });
      alphaMemory = store.saveMemory({ botId: alpha.bot.id, text: 'ALPHA-PRIVATE-MEMORY' });
      betaMemory = store.saveMemory({ botId: beta.bot.id, text: 'BETA-PRIVATE-MEMORY' });
      store.setSetting('aboutMe', 'SHARED-SETTING');
    } finally {
      store.close();
    }

    const reopened = new Store(directory);
    try {
      assert.equal(reopened.ensureBotChat(alpha.bot.id).id, alpha.chat.id);
      assert.equal(reopened.ensureBotChat(beta.bot.id).id, beta.chat.id);
      assert.notEqual(alpha.chat.id, beta.chat.id);
      assert.deepEqual(reopened.messages(alpha.chat.id).map(message => message.text), ['ALPHA-OWNER-MARKER']);
      assert.deepEqual(reopened.messages(beta.chat.id).map(message => message.text), ['BETA-OWNER-MARKER']);
      assert.deepEqual(
        { role: reopened.bot(alpha.bot.id).role, instructions: reopened.bot(alpha.bot.id).instructions },
        { role: 'Researcher', instructions: 'Alpha-only instructions' }
      );
      assert.deepEqual(
        { role: reopened.bot(beta.bot.id).role, instructions: reopened.bot(beta.bot.id).instructions },
        { role: 'Writer', instructions: 'Beta-only instructions' }
      );
      assert.deepEqual(
        { model: reopened.chat(alpha.chat.id).model, permission: reopened.chat(alpha.chat.id).permission },
        { model: 'alpha-chat-model', permission: 'readOnly' }
      );
      assert.deepEqual(
        { model: reopened.chat(beta.chat.id).model, permission: reopened.chat(beta.chat.id).permission },
        { model: 'beta-chat-model', permission: 'workspaceWrite' }
      );
      assert.deepEqual(reopened.routines().map(routine => [routine.id, routine.botId]).sort(), [
        [alphaRoutine.id, alpha.bot.id],
        [betaRoutine.id, beta.bot.id]
      ].sort());
      assert.deepEqual(reopened.routines().filter(routine => routine.botId === alpha.bot.id).map(routine => routine.id), [alphaRoutine.id]);
      assert.deepEqual(reopened.routines().filter(routine => routine.botId === beta.bot.id).map(routine => routine.id), [betaRoutine.id]);
      assert.deepEqual(reopened.memories(alpha.bot.id).map(memory => [memory.id, memory.text]), [[alphaMemory.id, 'ALPHA-PRIVATE-MEMORY']]);
      assert.deepEqual(reopened.memories(beta.bot.id).map(memory => [memory.id, memory.text]), [[betaMemory.id, 'BETA-PRIVATE-MEMORY']]);
      assert.equal(reopened.memories(alpha.bot.id).some(memory => memory.text.includes('BETA')), false);
      assert.equal(reopened.memories(beta.bot.id).some(memory => memory.text.includes('ALPHA')), false);
      assert.equal(reopened.settings().aboutMe, 'SHARED-SETTING');
      const alphaSearch = reopened.search('ALPHA-OWNER-MARKER');
      const betaSearch = reopened.search('BETA-OWNER-MARKER');
      assert.deepEqual(alphaSearch.map(hit => hit.bot.id), [alpha.bot.id]);
      assert.deepEqual(betaSearch.map(hit => hit.bot.id), [beta.bot.id]);
    } finally {
      reopened.close();
    }
  });
});

test('new Bots default to full-access permission without any extra tool resources enabled', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const { bot, chat } = store.createBot('Default permissions', 'default-avatar');
      assert.equal(bot.permission, 'fullAccess');
      assert.equal(chat.permission, null);
      assert.equal(store.chatRoutineToolsEnabled(chat.id), false);
      assert.equal(store.chatMemoryToolsEnabled(chat.id), false);
      assert.deepEqual(store.groups(), []);
    } finally {
      store.close();
    }
  });
});

test('group creation can be cancelled without persistence and submitted membership survives reopening outside Bot chats', async () => {
  await withDirectory(async (Store, directory) => {
    const actionsPath = join(directory, 'group-create-actions.mjs');
    writeFileSync(actionsPath, compiledGroupActions, { mode: 0o600 });
    const { runGroupCreateAction } = await import(`${pathToFileURL(actionsPath).href}?${Date.now()}-${Math.random()}`);
    const store = new Store(directory);
    let created;
    let expectedMemberIds;
    let firstChatId;
    try {
      const first = store.createBot('First', 'brand-a');
      const second = store.createBot('Second', 'brand-b');
      const third = store.createBot('Third', 'brand-c');
      store.setBotArchived(third.bot.id, true);
      firstChatId = first.chat.id;

      // Exercise the same cancel dispatch used by the UI, with persistence wired to the real Store.
      let cancelled = false;
      const callbacks = {
        cancel: () => { cancelled = true; },
        create: async (title, botIds) => store.createGroup(title, botIds)
      };
      await runGroupCreateAction({ type: 'cancel' }, callbacks);
      assert.equal(cancelled, true);
      assert.deepEqual(store.groups(), []);
      assert.equal(store.chats().length, 3);

      assert.throws(() => store.createGroup('One member', [first.bot.id]), /至少需要选择两个 Bot/);
      assert.throws(() => store.createGroup('Duplicate', [first.bot.id, first.bot.id]), /不能重复/);
      assert.throws(() => store.createGroup('Archived', [first.bot.id, third.bot.id]), /已归档/);
      assert.deepEqual(store.groups(), []);

      expectedMemberIds = [second.bot.id, first.bot.id];
      created = await runGroupCreateAction({ type: 'create', title: '  Research  ', botIds: expectedMemberIds }, callbacks);
      assert.equal(created.title, 'Research');
      assert.deepEqual(created.memberIds, expectedMemberIds);
      assert.equal(created.defaultBotId, null);
      assert.equal(store.chats().length, 3);
      assert.deepEqual(store.messages(first.chat.id), []);
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      assert.deepEqual(reopened.groups(), [created]);
      assert.deepEqual(reopened.group(created.id).memberIds, expectedMemberIds);
      assert.equal(reopened.group(created.id).defaultBotId, null);
      assert.equal(reopened.chats().length, 3);
      assert.deepEqual(reopened.messages(firstChatId), []);
    } finally { reopened.close(); }
  });
});

test('adding members to an existing group appends membership, rejects invalid members, and creates only member sessions', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    let updated, beforeMessages, groupId;
    try {
      const first = store.createBot('First', 'a');
      const second = store.createBot('Second', 'b');
      const third = store.createBot('Third', 'c');
      const archived = store.createBot('Archived', 'd');
      store.setBotArchived(archived.bot.id, true);
      const group = store.createGroup('Growing room', [first.bot.id, second.bot.id]);
      groupId = group.id;
      beforeMessages = store.addGroupMessage(group.id, 'user', 'history before the third Bot joined');

      assert.throws(() => store.addGroupMembers(group.id, []), /选择要加入/);
      assert.throws(() => store.addGroupMembers(group.id, [first.bot.id]), /已在群聊中/);
      assert.throws(() => store.addGroupMembers(group.id, [third.bot.id, third.bot.id]), /不能重复/);
      assert.throws(() => store.addGroupMembers(group.id, [archived.bot.id]), /已归档/);
      assert.deepEqual(store.group(group.id).memberIds, [first.bot.id, second.bot.id]);

      updated = store.addGroupMembers(group.id, [third.bot.id]);
      assert.deepEqual(updated.memberIds, [first.bot.id, second.bot.id, third.bot.id]);
      const memberSession = store.groupSession(group.id, third.bot.id);
      assert.equal(memberSession.groupChatId, group.id);
      assert.equal(memberSession.botId, third.bot.id);
      assert.deepEqual(store.groupSessions().map(session => session.purpose), ['member']);
      assert.deepEqual(store.groupMessages(group.id).map(message => ({
        id: message.id, groupId: message.groupId, text: message.text, createdAt: message.createdAt
      })), [{
        id: beforeMessages.id, groupId: beforeMessages.groupId,
        text: beforeMessages.text, createdAt: beforeMessages.createdAt
      }]);
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      assert.deepEqual(reopened.group(groupId).memberIds, updated.memberIds);
      assert.deepEqual(reopened.groupMessages(groupId).map(message => message.id), [beforeMessages.id]);
      assert.deepEqual(reopened.groupSessions().map(session => session.purpose), ['member']);
    } finally { reopened.close(); }
  });
});

test('routine list is backed by SQLite and remains empty after reopening without created tasks', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      store.createBot('Routine owner', 'brand');
      assert.deepEqual(store.routines(), []);
      // Simulate a build-6 database, which predates the routines table.
      store.db.exec('DROP TABLE routines; PRAGMA user_version=6;');
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      assert.deepEqual(reopened.routines(), []);
      const table = reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='routines'").get();
      assert.equal(table?.name, 'routines');
      assert.equal(reopened.db.prepare('PRAGMA user_version').get()?.user_version, 15);
    } finally { reopened.close(); }
  });
});

test('migrates a version 13 routines table that predates scheduling columns', async () => {
  await withDirectory(async (Store, directory) => {
    const db = new DatabaseSync(join(directory, 'rambo.sqlite'));
    db.exec(`CREATE TABLE bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '', model TEXT, permission TEXT NOT NULL DEFAULT 'fullAccess',
        archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE routines (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        definitionJson TEXT NOT NULL, status TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, sourceCallId TEXT);
      CREATE INDEX routines_updated ON routines(updatedAt DESC, createdAt DESC);
      PRAGMA user_version=13;`);
    db.close();

    const store = new Store(directory);
    try {
      const columns = store.db.prepare('PRAGMA table_info(routines)').all().map(row => row.name);
      assert.equal(columns.includes('nextRunAt'), true);
      assert.equal(columns.includes('lastScheduledFor'), true);
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 15);
    } finally { store.close(); }
  });
});

test('routine list maps persisted summary fields and orders the newest update first', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const { bot } = store.createBot('Routine owner', 'brand');
      const insert = store.db.prepare(`INSERT INTO routines(id,title,botId,definitionJson,status,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?)`);
      insert.run('routine-active', 'Daily review', bot.id, '{}', 'active', '2026-10-01T08:00:00.000Z', '2026-10-02T08:00:00.000Z');
      insert.run('routine-paused', 'Weekly summary', bot.id, '{}', 'paused', '2026-09-01T08:00:00.000Z', '2026-10-03T08:00:00.000Z');
      const expectSourceChatId = store.ensureBotChat(bot.id).id;

      assert.deepEqual(store.routines(), [
        {
          id: 'routine-paused', title: 'Weekly summary', botId: bot.id, status: 'paused',
          sourceChatId: expectSourceChatId,
          definition: {
            instruction: '', schedule: '', kind: 'recurring', timezone: 'Asia/Shanghai',
            frequency: 'daily', weekday: null, dayOfMonth: null, time: '09:00', runAt: null,
            catchUp: true, rememberLastResult: false, successNotification: false
          },
          nextRunAt: null,
          lastRun: null,
          createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-10-03T08:00:00.000Z'
        },
        {
          id: 'routine-active', title: 'Daily review', botId: bot.id, status: 'active',
          sourceChatId: expectSourceChatId,
          definition: {
            instruction: '', schedule: '', kind: 'recurring', timezone: 'Asia/Shanghai',
            frequency: 'daily', weekday: null, dayOfMonth: null, time: '09:00', runAt: null,
            catchUp: true, rememberLastResult: false, successNotification: false
          },
          nextRunAt: null,
          lastRun: null,
          createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T08:00:00.000Z'
        }
      ]);
    } finally { store.close(); }
  });
});

test('Routine data is consistent by Bot and as an all-Bot overview with status and definition fields', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const alpha = store.createBot('Routine owner alpha', 'a');
      const beta = store.createBot('Routine owner beta', 'b');
      const alphaRoutine = store.createRoutine({
        botId: alpha.bot.id,
        title: 'Alpha daily plan',
        instruction: 'Prepare the alpha work plan.',
        schedule: 'every weekday at 09:00',
        sourceCallId: 'overview-alpha'
      });
      const betaRoutine = store.createRoutine({
        botId: beta.bot.id,
        title: 'Beta weekly summary',
        instruction: 'Summarize beta project progress.',
        schedule: 'every Friday at 18:00',
        sourceCallId: 'overview-beta'
      });
      store.setRoutineStatus(betaRoutine.id, 'paused');

      const ownAlpha = store.routines().filter(routine => routine.botId === alpha.bot.id);
      const ownBeta = store.routines().filter(routine => routine.botId === beta.bot.id);
      assert.deepEqual(ownAlpha.map(routine => routine.id), [alphaRoutine.id]);
      assert.deepEqual(ownBeta.map(routine => routine.id), [betaRoutine.id]);
      assert.equal(ownAlpha[0].definition.instruction, 'Prepare the alpha work plan.');
      assert.equal(ownAlpha[0].definition.schedule, 'every weekday at 09:00');
      assert.equal(ownAlpha[0].status, 'active');
      assert.equal(ownBeta[0].status, 'paused');
      assert.deepEqual(
        new Set(store.routines().map(routine => routine.botId)),
        new Set([alpha.bot.id, beta.bot.id])
      );
    } finally { store.close(); }
  });
});

test('routine creation persists its definition, is idempotent for one tool call, and remains queryable after reopen', async () => {
  await withDirectory(async (Store, directory) => {
    let store = new Store(directory);
    let createdDefinition;
    const { bot } = store.createBot('Routine owner', 'brand');
    const input = {
      botId: bot.id,
      title: 'Morning status',
      instruction: '只生成一行固定状态文本，不访问外部工具。',
      schedule: '每个工作日 09:00（Asia/Shanghai）',
      sourceCallId: 'thread-test:call-1'
    };
    try {
      const created = store.createRoutine(input);
      createdDefinition = created.definition;
      assert.equal(created.status, 'active');
      assert.deepEqual(created.definition, {
        instruction: input.instruction, schedule: input.schedule,
        kind: 'recurring', timezone: 'Asia/Shanghai', frequency: 'weekdays',
        weekday: null, dayOfMonth: null, time: '09:00', runAt: null,
        catchUp: true, rememberLastResult: false, successNotification: false
      });
      assert.deepEqual(store.routine(created.id), created);
      assert.deepEqual(store.routines(), [created]);
      assert.equal(store.createRoutine(input).id, created.id);
      assert.equal(store.routines().length, 1);
      assert.throws(() => store.createRoutine({ ...input, title: 'Different task' }), /请求标识冲突/);
      assert.equal(store.routines().length, 1);
      assert.throws(() => store.createRoutine({ ...input, sourceCallId: 'thread-test:call-2', schedule: ' ' }), /周期表达/);
    } finally { store.close(); }

    store = new Store(directory);
    try {
      const [saved] = store.routines();
      assert.equal(saved.title, input.title);
      assert.equal(saved.botId, bot.id);
      assert.deepEqual(saved.definition, createdDefinition);
      assert.deepEqual(store.routine(saved.id), saved);
    } finally { store.close(); }
  });
});

test('memory save is immediately active, editable, scoped, and directly deletable', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const first = store.createBot('First', 'a');
      const second = store.createBot('Second', 'b');
      const privateMemory = store.saveMemory({ botId: first.bot.id, text: '  First-only fact  ', approved: false });
      const sharedMemory = store.saveMemory({ botId: null, text: 'Shared preference' });

      assert.equal(privateMemory.approved, true);
      assert.equal(privateMemory.text, 'First-only fact');
      assert.deepEqual(store.memories(first.bot.id).map(memory => memory.id), [privateMemory.id]);
      assert.deepEqual(store.memories(second.bot.id), []);
      assert.deepEqual(store.memories(null).map(memory => memory.id), [sharedMemory.id]);

      const updated = store.saveMemory({ id: privateMemory.id, botId: first.bot.id, text: 'Updated fact' });
      assert.equal(updated.text, 'Updated fact');
      assert.throws(() => store.saveMemory({ id: privateMemory.id, botId: second.bot.id, text: 'Wrong owner' }), /不能修改其他 Bot/);
      store.deleteMemory(privateMemory.id);
      assert.deepEqual(store.memories(first.bot.id), []);
      assert.deepEqual(store.memories(null), [sharedMemory]);
    } finally { store.close(); }
  });
});

test('archiving a Bot pauses active routines and retains conversations and memories across reopen', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    const { bot, chat } = store.createBot('Archive owner', 'brand');
    store.saveMemory({ botId: bot.id, text: 'keep this memory', approved: true });
    const insert = store.db.prepare(`INSERT INTO routines(id,title,botId,definitionJson,status,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?)`);
    insert.run('active-routine', 'Active', bot.id, '{}', 'active', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    insert.run('paused-routine', 'Paused', bot.id, '{}', 'paused', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

    const archived = store.setBotArchived(bot.id, true);
    assert.equal(archived.archived, true);
    assert.equal(store.chat(chat.id).id, chat.id);
    assert.deepEqual(store.memories(bot.id).map(memory => memory.text), ['keep this memory']);
    assert.deepEqual(store.routines().map(routine => routine.status), ['paused', 'paused']);
    store.close();

    const reopened = new Store(directory);
    try {
      assert.equal(reopened.bot(bot.id).archived, true);
      assert.equal(reopened.chat(chat.id).id, chat.id);
      assert.deepEqual(reopened.memories(bot.id).map(memory => memory.text), ['keep this memory']);
      reopened.setBotArchived(bot.id, false);
      assert.equal(reopened.bot(bot.id).archived, false);
      assert.deepEqual(reopened.routines().map(routine => routine.status), ['paused', 'paused']);
    } finally { reopened.close(); }
  });
});

test('reopening a Bot resolves the same private chat and preserves settings, messages, memories and routines', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    let bot;
    let chat;
    try {
      ({ bot, chat } = store.createBot('Chat owner', 'brand'));
      store.addMessage(chat.id, 'user', 'remove this message');
      store.saveMemory({ botId: bot.id, text: 'shared Bot memory', approved: true });
      store.setSetting('theme', 'light');
      store.setSetting('wakeEnabled', 'true');
      store.createRoutine({
        botId: bot.id, title: 'Persisted routine', instruction: 'Check the local status list.',
        schedule: '每天 08:30', sourceCallId: 'persisted-routine-call'
      });
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      const resolved = reopened.ensureBotChat(bot.id);
      assert.equal(resolved.id, chat.id);
      assert.equal(reopened.messages(chat.id)[0].text, 'remove this message');
      assert.deepEqual(reopened.memories(bot.id).map(memory => memory.text), ['shared Bot memory']);
      assert.deepEqual(reopened.settings(), { theme: 'light', wakeEnabled: 'true' });
      assert.equal(reopened.routines()[0].title, 'Persisted routine');
      assert.equal(reopened.routines()[0].botId, bot.id);
    } finally { reopened.close(); }
  });
});

test('legacy duplicate threads keep the current thread identity and hide old thread history', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    let botId, currentChatId;
    try {
      const created = store.createBot('History owner', 'a');
      botId = created.bot.id;
      currentChatId = created.chat.id;
      store.bindThread(currentChatId, 'thread-legacy');
      store.addMessage(currentChatId, 'user', 'current thread marker');
      store.db.exec('DROP INDEX chats_one_direct_chat_per_bot');
      store.db.prepare(`INSERT INTO chats(id,botId,title,threadId,groupChatId,archived,routineToolsEnabled,memoryToolsEnabled,createdAt,updatedAt)
        VALUES(?,?,?,NULL,NULL,0,0,0,?,?)`)
        .run('newer-empty-private-chat', botId, 'Newer empty private chat', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
      store.addMessage('newer-empty-private-chat', 'user', 'legacy thread marker');
      store.db.exec('PRAGMA user_version=12');
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      assert.equal(reopened.ensureBotChat(botId).id, currentChatId);
      assert.deepEqual(reopened.chats().map(chat => chat.id), [currentChatId]);
      assert.deepEqual(reopened.allChats().map(chat => chat.id), [currentChatId]);
      assert.equal(reopened.chat('newer-empty-private-chat').archived, true);
      assert.equal(reopened.chat('newer-empty-private-chat').threadId, null);
      assert.deepEqual(reopened.search('current thread marker').map(hit => hit.chat.id), [currentChatId]);
      assert.deepEqual(reopened.search('legacy thread marker'), []);
    } finally { reopened.close(); }
  });
});

test('Bot rename changes its identity everywhere without creating another private chat', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const first = store.createBot('Old identity', 'a');
      const second = store.createBot('Group peer', 'b');
      const group = store.createGroup('Identity room', [first.bot.id, second.bot.id]);
      store.bindThread(first.chat.id, 'identity-thread');
      store.addMessage(first.chat.id, 'user', 'searchable before rename');
      const membershipBefore = store.group(group.id).memberIds;

      const updated = store.updateBot(first.bot.id, { name: 'New identity', avatar: 'new-avatar' });
      assert.equal(updated.name, 'New identity');
      assert.equal(updated.avatar, 'new-avatar');
      assert.equal(store.chat(first.chat.id).id, first.chat.id);
      assert.equal(store.ensureBotChat(first.bot.id).id, first.chat.id);
      assert.equal(store.chat(first.chat.id).threadId, 'identity-thread');
      assert.deepEqual(store.group(group.id).memberIds, membershipBefore);
      assert.deepEqual(store.search('searchable before rename').map(hit => hit.bot.name), ['New identity']);
      assert.equal(store.chats().filter(chat => chat.botId === first.bot.id).length, 1);
    } finally { store.close(); }
  });
});

test('permanent Bot deletion removes only its managed records and keeps group rows with honest remaining membership', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const first = store.createBot('First', 'a');
      const second = store.createBot('Second', 'b');
      const outsider = store.createBot('Outsider', 'c');
      store.addMessage(first.chat.id, 'user', 'first private message');
      store.saveMemory({ botId: first.bot.id, text: 'first memory', approved: true });
      store.saveMemory({ botId: second.bot.id, text: 'second memory', approved: true });
      store.saveMemory({ botId: null, text: 'global memory', approved: true });
      const insert = store.db.prepare(`INSERT INTO routines(id,title,botId,definitionJson,status,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?)`);
      for (const [id, bot] of [['first-routine', first.bot], ['second-routine', second.bot], ['outside-routine', outsider.bot]]) {
        insert.run(id, id, bot.id, '{}', 'paused', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      }
      const group = store.createGroup('Shared group', [first.bot.id, second.bot.id]);

      store.deleteBot(first.bot.id);
      assert.throws(() => store.bot(first.bot.id), /机器人不存在/);
      assert.throws(() => store.chat(first.chat.id), /聊天不存在/);
      assert.deepEqual(store.memories(second.bot.id).map(memory => memory.text), ['second memory']);
      assert.deepEqual(store.memories(null).map(memory => memory.text), ['global memory']);
      assert.equal(store.routines().some(routine => routine.id === 'first-routine'), false);
      assert.equal(store.bot(second.bot.id).id, second.bot.id);
      assert.equal(store.bot(outsider.bot.id).id, outsider.bot.id);
      assert.deepEqual(store.group(group.id).memberIds, [second.bot.id]);
      assert.equal(store.group(group.id).defaultBotId, null);

      store.deleteBot(second.bot.id);
      assert.deepEqual(store.group(group.id).memberIds, []);
      assert.equal(store.group(group.id).defaultBotId, null);
      assert.deepEqual(store.groups().map(item => item.id), [group.id]);
      assert.equal(store.bot(outsider.bot.id).id, outsider.bot.id);
      assert.equal(store.routines().some(routine => routine.id === 'outside-routine'), true);
    } finally { store.close(); }
  });
});

test('search can be scoped to one active Bot without returning another Bot or an archived Bot', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const first = store.createBot('First', 'a');
      const second = store.createBot('Second', 'b');
      const archived = store.createBot('Archived', 'c');
      store.addMessage(first.chat.id, 'user', 'shared needle one');
      store.addMessage(second.chat.id, 'user', 'shared needle three');
      store.addMessage(archived.chat.id, 'user', 'shared needle four');
      store.setBotArchived(archived.bot.id, true);

      assert.deepEqual(store.search('shared needle', first.bot.id).map(item => item.bot.id), [first.bot.id]);
      assert.deepEqual(new Set(store.search('shared needle').map(item => item.bot.id)), new Set([first.bot.id, second.bot.id]));
      assert.deepEqual(store.search('shared needle', second.bot.id).map(item => item.bot.id), [second.bot.id]);
      assert.throws(() => store.search('shared needle', 'missing-bot'), /机器人不存在/);
    } finally { store.close(); }
  });
});

test('search escapes wildcard characters and only returns direct-chat messages from active Bots', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const first = store.createBot('Literal search', 'a');
      const second = store.createBot('Other Bot', 'b');
      const archived = store.createBot('Archived search', 'c');
      const group = store.createGroup('Search group', [first.bot.id, second.bot.id]);
      const groupChat = store.groupSession(group.id, first.bot.id);

      store.addMessage(first.chat.id, 'user', 'literal 100% Complete_marker');
      store.addMessage(first.chat.id, 'user', 'literal 100 ordinary');
      store.addMessage(second.chat.id, 'user', '100% Complete_marker');
      store.addMessage(archived.chat.id, 'user', '100% Complete_marker');
      store.addMessage(groupChat.id, 'user', '100% Complete_marker');
      store.setBotArchived(archived.bot.id, true);

      assert.deepEqual(new Set(store.search('100% Complete_marker').map(item => item.chat.id)), new Set([first.chat.id, second.chat.id]));
      assert.deepEqual(store.search('100% Complete_marker', first.bot.id).map(item => item.chat.id), [first.chat.id]);
      assert.deepEqual(new Set(store.search('100% Complete_marker').map(item => item.bot.name)), new Set(['Literal search', 'Other Bot']));
      assert.equal(store.search('_').some(item => item.message.text === 'literal 100 ordinary'), false);
      assert.equal(store.search('%').some(item => item.message.text === 'literal 100 ordinary'), false);
      assert.deepEqual(
        store.search('_').map(item => item.message.text).sort(),
        ['100% Complete_marker', 'literal 100% Complete_marker']
      );
      assert.deepEqual(
        store.search('%').map(item => item.message.text).sort(),
        ['100% Complete_marker', 'literal 100% Complete_marker']
      );
      assert.deepEqual(store.search('   '), []);

      const privateChatId = first.chat.id;
      const titleBefore = store.chat(privateChatId).title;
      store.updateBot(first.bot.id, { name: 'Renamed Bot' });
      assert.equal(store.chat(privateChatId).title, titleBefore);
      assert.equal(store.ensureBotChat(first.bot.id).id, privateChatId);
      assert.throws(() => store.setBotArchived(first.bot.id, 'yes'), /无效的归档状态/);
    } finally {
      store.close();
    }
  });
});

test('search stays in private chats, never returns group member chats, and excludes archived Bots', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const alpha = store.createBot('Alpha search', 'a');
      const beta = store.createBot('Beta search', 'b');
      const archived = store.createBot('Archived search', 'c');
      const group = store.createGroup('Search room', [alpha.bot.id, beta.bot.id]);
      store.groupSession(group.id, alpha.bot.id);
      store.groupSession(group.id, beta.bot.id);

      store.addMessage(alpha.chat.id, 'user', 'global alpha needle');
      store.addMessage(beta.chat.id, 'user', 'global beta needle');
      store.addMessage(archived.chat.id, 'user', 'global archived needle');
      store.addGroupMessage(group.id, 'user', 'group-only needle');
      store.groupAssistantItem(group.id, beta.bot.id, 'group-summary', 'group-only beta summary needle', false, 'complete');
      store.setBotArchived(archived.bot.id, true);

      const globalHits = store.search('needle');
      assert.deepEqual(
        new Set(globalHits.map(hit => hit.bot.id)),
        new Set([alpha.bot.id, beta.bot.id])
      );
      assert.equal(globalHits.some(hit => hit.bot.id === archived.bot.id), false);
      assert.equal(globalHits.some(hit => hit.message.text.includes('group-only')), false);
      assert.deepEqual(store.search('needle', alpha.bot.id).map(hit => hit.bot.name), ['Alpha search']);
      assert.deepEqual(store.search('needle', beta.bot.id).map(hit => hit.bot.name), ['Beta search']);
    } finally { store.close(); }
  });
});

test('unfiltered search spans active Bot private chats but excludes groups, archived Bots and hidden legacy threads', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const alpha = store.createBot('Alpha global search', 'a');
      const beta = store.createBot('Beta global search', 'b');
      const archived = store.createBot('Archived global search', 'c');
      const group = store.createGroup('Global search room', [alpha.bot.id, beta.bot.id]);

      store.addMessage(alpha.chat.id, 'user', 'global marker alpha');
      store.addMessage(beta.chat.id, 'user', 'global marker beta');
      store.addMessage(archived.chat.id, 'user', 'global marker archived');
      store.addGroupMessage(group.id, 'user', 'global marker group');
      store.setBotArchived(archived.bot.id, true);

      const globalHits = store.search('global marker');
      assert.deepEqual(
        new Set(globalHits.map(hit => hit.bot.name)),
        new Set(['Alpha global search', 'Beta global search'])
      );
      assert.equal(globalHits.some(hit => hit.message.text.includes('archived')), false);
      assert.equal(globalHits.some(hit => hit.message.text.includes('group')), false);

      const alphaHits = store.search('global marker', alpha.bot.id);
      assert.deepEqual(alphaHits.map(hit => hit.message.text), ['global marker alpha']);
    } finally { store.close(); }
  });
});

test('missing Bot deletes do not begin a transaction or disturb existing data', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const first = store.createBot('Retained', 'a');
      store.addMessage(first.chat.id, 'user', 'retained marker');
      assert.throws(() => store.deleteBot('missing-bot'), /机器人不存在/);
      assert.equal(store.bot(first.bot.id).id, first.bot.id);
      assert.deepEqual(store.messages(first.chat.id).map(message => message.text), ['retained marker']);
      assert.throws(() => store.setBotArchived('missing-bot', true), /机器人不存在/);
    } finally {
      store.close();
    }
  });
});

test('turn metadata is atomic, immutable across default changes, and honest about model evidence after reopen', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    const { bot, chat } = store.createBot('Assistant', 'a');
    const observation = store.saveThreadModelObservation(chat.id, 'thread-1', 'gpt-5.6-luna', 'openai', 'threadStartResponse');
    const permissionSnapshot = {
      permission: 'readOnly', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }
    };
    const begun = store.beginTurn(chat.id, 'hello', {
      threadId: 'thread-1', requestedModel: 'gpt-5.6-luna', modelSource: 'bot',
      permissionSnapshot, threadModelObservation: observation
    });

    // Later edits affect future turns, not the snapshot sent with this request.
    store.updateBot(bot.id, { model: 'gpt-6-luna', permission: 'fullAccess' });
    store.updateChat(chat.id, { model: 'gpt-6-luna', permission: 'fullAccess' });
    assert.deepEqual(store.turn(begun.turn.id).permissionSnapshot, permissionSnapshot);
    assert.equal(store.turn(begun.turn.id).requestedModel, 'gpt-5.6-luna');
    assert.equal(store.turn(begun.turn.id).serverResolvedModel, null);
    assert.equal(store.turn(begun.turn.id).threadModelAtRequest, 'gpt-5.6-luna');
    assert.equal(store.turn(begun.turn.id).threadModelSource, 'threadStartResponse');

    // A failed serialization rolls both the user message and turn row back together.
    const circular = { ...permissionSnapshot };
    circular.loop = circular;
    assert.throws(() => store.beginTurn(chat.id, 'atomic-failure', {
      threadId: 'thread-1', requestedModel: 'gpt-6-luna', modelSource: 'chat', permissionSnapshot: circular
    }));
    assert.equal(store.messages(chat.id).length, 1);
    assert.equal(store.turns(chat.id).length, 1);

    store.attachTurnId(begun.turn.id, 'thread-1', 'turn-1', 'running');
    store.addTurnReroute(begun.turn.id, {
      fromModel: 'gpt-5.6-luna', toModel: 'gpt-6-luna', reason: 'highRiskCyberActivity', receivedAt: '2025-01-01T00:00:01.000Z'
    });
    store.attachTurnId(begun.turn.id, 'thread-1', 'turn-1', 'completed');
    const unfinished = store.beginTurn(chat.id, 'next turn', {
      threadId: 'thread-1', requestedModel: 'gpt-6-luna', modelSource: 'chat',
      permissionSnapshot: { permission: 'fullAccess', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
    });
    store.close();

    const reopened = new Store(directory);
    try {
      const rows = reopened.turns(chat.id);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].turnId, 'turn-1');
      assert.equal(rows[0].status, 'completed');
      assert.equal(rows[0].requestedModel, 'gpt-5.6-luna');
      assert.equal(rows[0].serverResolvedModel, 'gpt-6-luna');
      assert.equal(rows[0].resolutionSource, 'modelRerouted');
      assert.equal(rows[0].reroutes[0].reason, 'highRiskCyberActivity');
      assert.equal(rows[0].threadModelAtRequest, 'gpt-5.6-luna');
      assert.equal(rows[0].threadModelProviderAtRequest, 'openai');
      assert.equal(rows[0].threadModelSource, 'threadStartResponse');
      assert.deepEqual(rows[0].permissionSnapshot, permissionSnapshot);
      assert.equal(rows[0].completedAt !== null, true);
      assert.equal(reopened.messages(chat.id).length, 2);
      assert.equal(rows[1].id, unfinished.turn.id);
      assert.equal(rows[1].status, 'unknown');
      assert.equal(rows[1].serverResolvedModel, null);
      assert.equal(rows[1].resolutionSource, 'unknown');
    } finally { reopened.close(); }
  });
});

test('group messages persist in one shared timeline with one hidden member thread per Bot', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    let group, first, second, firstSession;
    try {
      first = store.createBot('Researcher', 'a');
      second = store.createBot('Writer', 'b');
      group = store.createGroup('Shared room', [first.bot.id, second.bot.id]);
      firstSession = store.groupSession(group.id, first.bot.id);
      const secondSession = store.groupSession(group.id, second.bot.id);

      assert.notEqual(firstSession.id, secondSession.id);
      assert.equal(store.groupSessions().length, 2);
      assert.equal(store.groupSessions().some(session => session.purpose === 'router'), false);
      assert.equal(store.chats().length, 2);
      assert.equal(store.allChats().length, 4);

      store.addMessage(first.chat.id, 'user', 'private trace phrase');
      assert.deepEqual(store.groupMessages(group.id), []);
      const user = store.addGroupMessage(group.id, 'user', 'Please summarize the shared notes.');
      const partial = store.groupAssistantItem(group.id, first.bot.id, 'item-1', 'Here are', true, 'streaming');
      const completed = store.groupAssistantItem(group.id, first.bot.id, 'item-1', 'Here are the notes.', false, 'complete');
      assert.equal(partial.id, completed.id);
      assert.equal(completed.senderBotId, first.bot.id);
      assert.equal(completed.senderName, 'Researcher');
      assert.equal(completed.text, 'Here are the notes.');
      assert.deepEqual(store.groupMessages(group.id).map(message => message.id), [user.id, completed.id]);
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      assert.deepEqual(reopened.groupMessages(group.id).map(message => message.senderName), [null, 'Researcher']);
      assert.equal(reopened.groupSession(group.id, first.bot.id).id, firstSession.id);
      assert.equal(reopened.groupSessions().length, 2);
      assert.equal(reopened.chats().length, 2);
      assert.deepEqual(reopened.search('private trace phrase').map(item => item.chat.id), [first.chat.id]);
    } finally { reopened.close(); }
  });
});

test('group member setting chats keep model and permission overrides isolated per group', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const first = store.createBot('First', 'a');
      const second = store.createBot('Second', 'b');
      const third = store.createBot('Third', 'c');
      const firstGroup = store.createGroup('First room', [first.bot.id, second.bot.id]);
      const secondGroup = store.createGroup('Second room', [first.bot.id, third.bot.id]);
      const firstGroupChats = store.groupMemberChats(firstGroup.id);
      const firstGroupChat = firstGroupChats.find(chat => chat.botId === first.bot.id);
      assert.ok(firstGroupChat);
      assert.equal(firstGroupChat.groupChatId, firstGroup.id);
      store.updateChat(firstGroupChat.id, { model: 'group-only-model', permission: 'readOnly' });

      assert.equal(store.chat(first.chat.id).model, null);
      assert.equal(store.chat(first.chat.id).permission, null);
      assert.equal(store.bot(first.bot.id).model, null);
      assert.equal(store.bot(first.bot.id).permission, 'fullAccess');
      const secondGroupChat = store.groupMemberChats(secondGroup.id).find(chat => chat.botId === first.bot.id);
      assert.ok(secondGroupChat);
      assert.notEqual(secondGroupChat.id, firstGroupChat.id);
      assert.equal(secondGroupChat.model, null);
      assert.equal(secondGroupChat.permission, null);
      assert.deepEqual(store.groupMemberChats(firstGroup.id).map(chat => chat.botId), [first.bot.id, second.bot.id]);
    } finally { store.close(); }
  });
});
