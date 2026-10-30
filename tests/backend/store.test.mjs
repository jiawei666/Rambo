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
const robotAvatarSourcePath = new URL('../../src/shared/robot-avatar.ts', import.meta.url);
const contractsSourcePath = new URL('../../src/shared/contracts.ts', import.meta.url);
const compiledSchedule = ts.transpileModule(readFileSync(scheduleSourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const compiledRobotAvatar = ts.transpileModule(readFileSync(robotAvatarSourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const compiledContracts = ts.transpileModule(readFileSync(contractsSourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const compiledStore = ts.transpileModule(readFileSync(storeSourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText
  .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'")
  .replaceAll("from '../shared/robot-avatar'", "from './robot-avatar.mjs'")
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'");
const groupActionsSourcePath = new URL('../../src/renderer/group-create-actions.ts', import.meta.url);
const compiledGroupActions = ts.transpileModule(readFileSync(groupActionsSourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

async function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-store-test-'));
  const modulePath = join(directory, 'store.mjs');
  writeFileSync(join(directory, 'routine-schedule.mjs'), compiledSchedule, { mode: 0o600 });
  writeFileSync(join(directory, 'robot-avatar.mjs'), compiledRobotAvatar, { mode: 0o600 });
  writeFileSync(join(directory, 'contracts.mjs'), compiledContracts, { mode: 0o600 });
  writeFileSync(modulePath, compiledStore, { mode: 0o600 });
  try {
    const { Store } = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    const originalStore = Store;
    const initializedStore = class extends originalStore {
      constructor(directory) {
        super(directory);
        if (!this.settings().defaultBotModel) {
          this.setSetting('defaultBotModel', 'test-model');
          this.setSetting('defaultBotPermission', 'fullAccess');
        }
      }
    };
    await run(initializedStore, directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('randomizes legacy Bot eye poses once while preserving robot appearance settings', async () => {
  await withDirectory(async (Store, directory) => {
    const initial = new Store(directory);
    const legacy = initial.createBot('Legacy avatar', 'grok-avatar:v1:cloud:violet').bot;
    const robot = initial.createBot('Existing robot', 'agent-robot:v1:100:orange').bot;
    const alreadyCurrent = initial.createBot('Current avatar', 'agent-robot:v2:0:red:angry').bot;
    initial.db.exec('PRAGMA user_version=17');
    initial.close();

    const migrated = new Store(directory);
    let savedLegacyAvatar;
    try {
      savedLegacyAvatar = migrated.bot(legacy.id).avatar;
      assert.match(savedLegacyAvatar, /^agent-robot:v2:100:violet:(idle|happy|sad|angry|sleepy|sleep|surprise)$/);
      assert.match(migrated.bot(robot.id).avatar, /^agent-robot:v2:100:orange:(idle|happy|sad|angry|sleepy|sleep|surprise)$/);
      assert.equal(migrated.bot(alreadyCurrent.id).avatar, 'agent-robot:v2:100:red:angry');
      assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 27);
    } finally { migrated.close(); }

    const reopened = new Store(directory);
    try { assert.equal(reopened.bot(legacy.id).avatar, savedLegacyAvatar); }
    finally { reopened.close(); }
  });
});

test('every selectable Robot eye pose remains a valid persisted appearance', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      for (const eyeStyle of ['idle', 'happy', 'sad', 'angry', 'sleepy', 'sleep', 'surprise']) {
        const avatar = `agent-robot:v2:100:blue:${eyeStyle}`;
        const created = store.createBot(`Eye ${eyeStyle}`, avatar);
        assert.equal(store.bot(created.bot.id).avatar, avatar);
      }
    } finally { store.close(); }
  });
});

test('replaces a persisted input eye once now that input is not selectable', async () => {
  await withDirectory(async (Store, directory) => {
    const initial = new Store(directory);
    const inputBot = initial.createBot('Input eye', 'agent-robot:v2:100:blue:input').bot;
    const happyBot = initial.createBot('Happy eye', 'agent-robot:v2:100:green:happy').bot;
    initial.db.exec('PRAGMA user_version=20');
    initial.close();

    const migrated = new Store(directory);
    let savedInputAvatar;
    try {
      savedInputAvatar = migrated.bot(inputBot.id).avatar;
      assert.match(savedInputAvatar, /^agent-robot:v2:100:blue:(idle|happy|sad|angry|sleepy|sleep|surprise)$/);
      assert.equal(migrated.bot(happyBot.id).avatar, 'agent-robot:v2:100:green:happy');
      assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 27);
    } finally { migrated.close(); }

    const reopened = new Store(directory);
    try { assert.equal(reopened.bot(inputBot.id).avatar, savedInputAvatar); }
    finally { reopened.close(); }
  });
});

test('persists queued chat messages and Routine recovery decisions across store restart', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    const { bot, chat } = store.createBot('Restart queue Bot', 'a');
    const queued = store.enqueueChatMessage(chat.id, 'dispatch after restart');
    const uncertain = store.enqueueChatMessage(chat.id, 'do not resend blindly');
    store.setQueuedChatMessageStatus(uncertain.id, 'dispatching');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Restart recovery', instruction: 'Check safely.',
      schedule: '每天', time: '09:00', sourceCallId: 'restart-recovery'
    });
    const run = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-25T01:00:00.000Z',
      trigger: 'schedule', status: 'running'
    });
    const claimed = store.claimRoutineRunRecovery(run.id);
    assert.equal(claimed.recoveryCount, 1);
    store.markRoutineRunNeedsUser(run.id, '外部操作结果无法确认。');
    store.close();

    const reopened = new Store(directory);
    try {
      assert.equal(reopened.db.prepare('PRAGMA user_version').get()?.user_version, 27);
      assert.deepEqual(reopened.queuedChatMessages(chat.id).map(message => message.id), [queued.id]);
      assert.equal(reopened.messages(chat.id).find(message => message.id === uncertain.id)?.dispatchStatus, 'needs_user');
      const persistedRun = reopened.routineRun(run.id);
      assert.equal(persistedRun.status, 'needs_user');
      assert.equal(persistedRun.recoveryCount, 1);
      assert.equal(persistedRun.needsUserReason, '外部操作结果无法确认。');
      assert.equal(reopened.routine(routine.id).status, 'paused');
      assert.throws(() => reopened.setRoutineStatus(routine.id, 'active'), /先检查上次运行结果/u);
      const resumed = reopened.resolveRoutineRunAndResume(routine.id);
      assert.equal(resumed.status, 'active');
      assert.equal(reopened.routineRun(run.id).status, 'interrupted');
      assert.equal(reopened.routineRun(run.id).error, '外部操作结果无法确认。');
      assert.match(reopened.routineRun(run.id).process, /用户检查后选择恢复计划/u);
    } finally { reopened.close(); }
  });
});

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
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 27);
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { store.close(); }
  });
});

test('detects pasted attachment paths referenced by private and group messages', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const first = store.createBot('Attachment reference A', 'a');
      const second = store.createBot('Attachment reference B', 'b');
      const group = store.createGroup('Attachment reference room', [first.bot.id, second.bot.id]);
      const privatePath = '/Users/test/Library/Application Support/Rambo/composer-attachments/pasted-image-1700000000000-11111111.png';
      const groupPath = '/Users/test/Library/Application Support/Rambo/composer-attachments/pasted-image-1700000000001-22222222.png';
      const absentPath = '/Users/test/Library/Application Support/Rambo/composer-attachments/pasted-image-1700000000002-33333333.png';

      store.addMessage(
        first.chat.id,
        'user',
        `请查看这张图片\n${privatePath}`,
        'complete'
      );
      store.addGroupMessage(group.id, 'user', `群聊附件：${groupPath}`);

      assert.equal(store.composerAttachmentReferenced(privatePath), true);
      assert.equal(store.composerAttachmentReferenced(groupPath), true);
      assert.equal(store.composerAttachmentReferenced(absentPath), false);
    } finally {
      store.close();
    }
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
      assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 27);
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
      assert.equal(reopened.db.prepare('PRAGMA user_version').get()?.user_version, 27);
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

    assert.throws(() => store.updateChat(first.chat.id, { permission: 'admin' }));
    assert.throws(() => store.updateChat(first.chat.id, { title: 'Renamed chat' }), /不支持的聊天字段/);
    assert.throws(() => store.updateChat(first.chat.id, { unexpected: true }));
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

test('new Bots copy explicit execution defaults and independent resource switches', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      store.setSetting('defaultBotModel', 'model-a');
      store.setSetting('defaultBotPermission', 'readOnly');
      store.syncBotResources([
        'skill:documents', 'skill:pdf', 'mcp:playwright'
      ], [
        'skill:documents', 'mcp:playwright'
      ]);
      assert.deepEqual(JSON.parse(store.settings().globalDefaultResourceIds), [
        'skill:documents', 'mcp:playwright'
      ]);
      const first = store.createBot('Default permissions', 'default-avatar');
      const { bot, chat } = first;
      assert.equal(bot.model, 'model-a');
      assert.equal(bot.permission, 'readOnly');
      assert.equal(store.botResourceEnabled(bot.id, 'skill:documents'), true);
      assert.equal(store.botResourceEnabled(bot.id, 'skill:pdf'), false);
      assert.equal(store.botResourceEnabled(bot.id, 'mcp:playwright'), true);
      assert.equal(chat.permission, null);
      assert.equal(store.chatRoutineToolsEnabled(chat.id), false);
      assert.equal(store.chatMemoryToolsEnabled(chat.id), false);
      assert.deepEqual(store.groups(), []);
      assert.equal(store.botResourceEnabled(bot.id, 'skill:documents'), true);
      assert.equal(store.botResourceEnabled(bot.id, 'mcp:playwright'), true);

      store.setBotResource(bot.id, 'skill:documents', false);
      store.setSetting('defaultBotModel', 'model-b');
      store.setSetting('defaultBotPermission', 'workspaceWrite');
      const second = store.createBot('Second defaults', 'default-avatar');
      store.db.prepare('UPDATE bots SET createdAt=? WHERE id=?')
        .run('2026-10-01T00:00:00.000Z', bot.id);
      store.db.prepare('UPDATE bots SET createdAt=? WHERE id=?')
        .run('2026-10-02T00:00:00.000Z', second.bot.id);
      assert.deepEqual(store.bots().map(item => item.id), [second.bot.id, bot.id]);
      assert.equal(store.bot(bot.id).model, 'model-a');
      assert.equal(store.bot(bot.id).permission, 'readOnly');
      assert.equal(store.bot(bot.id).notificationsEnabled, true);
      store.updateBot(bot.id, { notificationsEnabled: false });
      assert.equal(store.bot(bot.id).notificationsEnabled, false);
      assert.equal(store.bot(second.bot.id).notificationsEnabled, true);
      assert.equal(store.botResourceEnabled(bot.id, 'skill:documents'), false);
      assert.equal(second.bot.model, 'model-b');
      assert.equal(second.bot.permission, 'workspaceWrite');
      assert.equal(store.botResourceEnabled(second.bot.id, 'skill:documents'), true);

      store.syncBotResources(['skill:pdf', 'mcp:playwright'], ['skill:pdf']);
      assert.equal(store.botResourceRecords(bot.id).some(record => record.resourceId === 'skill:documents'), false);
      store.syncBotResources(['skill:documents', 'skill:pdf', 'mcp:playwright'], ['skill:documents']);
      assert.equal(store.botResourceEnabled(bot.id, 'skill:documents'), false);
      assert.equal(store.botResourceEnabled(second.bot.id, 'skill:documents'), false);
    } finally {
      store.close();
    }
    const reopened = new Store(directory);
    try {
      const bots = reopened.bots();
      assert.deepEqual(bots.map(bot => [bot.model, bot.permission]), [
        ['model-b', 'workspaceWrite'], ['model-a', 'readOnly']
      ]);
      assert.equal(reopened.botResourceEnabled(bots[0].id, 'mcp:playwright'), true);
      assert.equal(reopened.botResourceEnabled(bots[1].id, 'mcp:playwright'), true);
    } finally {
      reopened.close();
    }
  });
});

test('copying a Bot preserves profile, execution config, grants, resources, memories, and private secret metadata', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      store.syncBotResources(
        ['skill:documents', 'skill:pdf', 'mcp:playwright'],
        ['skill:documents', 'mcp:playwright']
      );
      const source = store.createBot('Researcher', 'agent-robot:v2:100:orange:idle').bot;
      store.updateBot(source.id, {
        role: '负责研究和整理资料',
        instructions: '先核对来源，再给出结论。',
        notificationsEnabled: false
      });
      store.updateBotExecutionConfig(source.id, {
        model: 'copy-model',
        permission: 'workspaceWrite'
      });
      store.setBotResource(source.id, 'skill:documents', false);
      store.setBotResource(source.id, 'mcp:playwright', true);
      const connection = store.createConnectorConnection({
        id: 'connection-copy',
        providerId: 'qqmail',
        displayName: 'Research mail',
        accountLabel: 'research@example.com',
        authKind: 'credentials',
        credentialRef: 'pending-keychain:connection-copy'
      });
      store.setConnectorGrant(source.id, connection.id, true);
      store.saveMemory({ botId: source.id, text: '私有记忆 A' });
      store.saveMemory({ botId: source.id, text: '私有记忆 B' });
      store.saveMemory({ botId: null, text: '共享记忆' });
      const sourceSecretId = '11111111-1111-4111-8111-111111111111';
      const copiedSecretId = '22222222-2222-4222-8222-222222222222';
      store.createBotSecret({
        id: sourceSecretId,
        name: 'Research token',
        description: 'Only for research',
        scope: 'bot',
        botId: source.id,
        credentialRef: 'db:11111111-1111-4111-8111-111111111112'
      });

      const targetBotId = '33333333-3333-4333-8333-333333333333';
      const copied = store.copyBot(source.id, targetBotId, [{
        sourceSecretId,
        id: copiedSecretId,
        credentialRef: 'db:22222222-2222-4222-8222-222222222223'
      }]);

      assert.equal(copied.bot.id, targetBotId);
      assert.equal(copied.bot.name, 'Researcher 副本');
      assert.notEqual(copied.chat.id, store.ensureBotChat(source.id).id);
      assert.equal(copied.chat.threadId, null);
      assert.equal(copied.bot.avatar, store.bot(source.id).avatar);
      assert.equal(copied.bot.role, '负责研究和整理资料');
      assert.equal(copied.bot.instructions, '先核对来源，再给出结论。');
      assert.equal(copied.bot.model, 'copy-model');
      assert.equal(copied.bot.permission, 'workspaceWrite');
      assert.equal(copied.bot.notificationsEnabled, false);
      assert.equal(copied.bot.archived, false);
      assert.equal(copied.bot.pinnedAt, null);
      assert.deepEqual(
        store.botResourceRecords(copied.bot.id),
        store.botResourceRecords(source.id)
      );
      assert.deepEqual(
        store.connectorGrants().filter(grant => grant.botId === copied.bot.id)
          .map(grant => grant.connectionId),
        [connection.id]
      );
      assert.deepEqual(
        store.memories(copied.bot.id).map(memory => memory.text),
        ['私有记忆 A', '私有记忆 B']
      );
      assert.deepEqual(
        store.memories(null).map(memory => memory.text),
        ['共享记忆']
      );
      assert.deepEqual(
        store.ownedBotSecrets(copied.bot.id).map(secret => ({
          id: secret.id,
          name: secret.name,
          description: secret.description,
          credentialRef: secret.credentialRef
        })),
        [{
          id: copiedSecretId,
          name: 'Research token',
          description: 'Only for research',
          credentialRef: 'db:22222222-2222-4222-8222-222222222223'
        }]
      );
      assert.throws(
        () => store.botSecretForBot(copiedSecretId, source.id),
        /无权访问/
      );
      assert.equal(store.copyNameFor(source.id), 'Researcher 副本 2');
      assert.equal(store.bot(source.id).name, 'Researcher');
    } finally {
      store.close();
    }

    const reopened = new Store(directory);
    try {
      const copied = reopened.bots().find(bot => bot.name === 'Researcher 副本');
      assert.ok(copied);
      assert.equal(reopened.botResourceEnabled(copied.id, 'skill:documents'), false);
      assert.equal(reopened.botResourceEnabled(copied.id, 'mcp:playwright'), true);
      assert.equal(reopened.ownedBotSecrets(copied.id).length, 1);
      assert.deepEqual(
        reopened.memories(copied.id).map(memory => memory.text),
        ['私有记忆 A', '私有记忆 B']
      );
    } finally { reopened.close(); }
  });
});

test('invalid or empty global permission never silently becomes Full Access', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      store.setSetting('defaultBotModel', 'model-a');
      store.setSetting('defaultBotPermission', 'not-a-permission');
      const beforeBots = store.bots().length;
      const beforeChats = store.chats().length;

      assert.throws(
        () => store.createBot('Invalid permission', 'a'),
        /新建 Bot 的全局权限配置无效/u
      );
      assert.equal(store.bots().length, beforeBots);
      assert.equal(store.chats().length, beforeChats);

      store.setSetting('defaultBotPermission', '');
      const created = store.createBot('Legacy default', 'b');
      assert.equal(created.bot.permission, 'fullAccess');
      assert.equal(created.bot.model, 'model-a');
    } finally {
      store.close();
    }
  });
});

test('saving valid execution defaults clears a previous initialization error', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      store.setSetting('modelInitializationError', '模型目录不可用');
      store.setExecutionDefaultModel(' model-after-recovery ');
      assert.equal(store.settings().defaultBotModel, 'model-after-recovery');
      assert.equal(store.settings().modelInitializationError, '');

      store.setSetting('modelInitializationError', '第二次初始化失败');
      store.setExecutionDefaults({
        model: ' model-with-explicit-permission ',
        permission: 'readOnly'
      });
      assert.equal(store.settings().defaultBotModel, 'model-with-explicit-permission');
      assert.equal(store.settings().defaultBotPermission, 'readOnly');
      assert.equal(store.settings().modelInitializationError, '');
    } finally {
      store.close();
    }
  });
});

test('manual model catalog persists as the global pool and keeps one default', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      store.setExecutionModelCatalog([
        { id: 'model-a', label: 'Model A', isDefault: false },
        { id: 'model-b', label: 'Model B', isDefault: false }
      ], 'model-a');
      assert.equal(store.settings().defaultBotModel, 'model-a');
      assert.deepEqual(JSON.parse(store.settings().defaultBotModels), [
        { id: 'model-a', label: 'Model A', isDefault: true },
        { id: 'model-b', label: 'Model B', isDefault: false }
      ]);

      store.setExecutionDefaultModel('model-b');
      assert.equal(store.settings().defaultBotModel, 'model-b');
      assert.deepEqual(JSON.parse(store.settings().defaultBotModels), [
        { id: 'model-a', label: 'Model A', isDefault: false },
        { id: 'model-b', label: 'Model B', isDefault: true }
      ]);
      assert.throws(
        () => store.setExecutionModelCatalog([{ id: 'model-a', label: 'Model A' }], 'model-b'),
        /默认模型必须来自/u
      );
      assert.throws(
        () => store.setExecutionModelCatalog([], 'model-a'),
        /至少勾选一个模型/u
      );
    } finally {
      store.close();
    }
  });
});

test('new manual model catalog refreshes only Bots whose saved model disappeared', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      store.setExecutionModelCatalog([
        { id: 'model-a', label: 'Model A', isDefault: true }
      ], 'model-a');
      const stale = store.createBot('Legacy researcher', 'brand-a');
      store.updateBotExecutionConfig(stale.bot.id, {
        model: 'retired-model',
        permission: 'workspaceWrite'
      });
      const valid = store.createBot('Current writer', 'brand-b');
      const archived = store.createBot('Archived operator', 'brand-c');
      store.updateBotExecutionConfig(archived.bot.id, {
        model: 'archived-retired-model',
        permission: 'readOnly'
      });
      store.setBotArchived(archived.bot.id, true);

      const refreshed = store.refreshBotModelsForCatalog([
        { id: 'model-b', label: 'Model B', isDefault: true },
        { id: 'model-a', label: 'Model A', isDefault: false }
      ], 'model-b');

      assert.deepEqual(
        refreshed.map(bot => ({
          id: bot.id,
          name: bot.name,
          previousModel: bot.previousModel,
          model: bot.model
        })).sort((left, right) => left.name.localeCompare(right.name)),
        [
          {
            id: archived.bot.id,
            name: 'Archived operator',
            previousModel: 'archived-retired-model',
            model: 'model-b'
          },
          {
            id: stale.bot.id,
            name: 'Legacy researcher',
            previousModel: 'retired-model',
            model: 'model-b'
          }
        ]
      );
      assert.equal(store.bot(stale.bot.id).model, 'model-b');
      assert.equal(store.bot(stale.bot.id).permission, 'workspaceWrite');
      assert.equal(store.bot(valid.bot.id).model, 'model-a');
      assert.equal(store.bot(archived.bot.id).model, 'model-b');
      assert.equal(store.bot(archived.bot.id).permission, 'readOnly');
      assert.throws(
        () => store.refreshBotModelsForCatalog([
          { id: 'model-a', label: 'Model A', isDefault: true }
        ], 'model-b'),
        /默认模型必须来自新的全局模型池/u
      );
    } finally {
      store.close();
    }
  });
});

test('source model catalog and stale Bot refresh commit atomically', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      store.setExecutionModelCatalog([
        { id: 'api-model', label: 'API Model', isDefault: true }
      ], 'api-model');
      const stale = store.createBot('API user', 'brand-a');
      store.updateBotExecutionConfig(stale.bot.id, {
        model: 'api-model',
        permission: 'workspaceWrite'
      });
      const valid = store.createBot('Local user', 'brand-b');
      store.updateBotExecutionConfig(valid.bot.id, {
        model: 'local-model',
        permission: 'readOnly'
      });

      const result = store.applyExecutionModelCatalogAndRefreshBots([
        { id: 'local-model', label: 'Local Model', isDefault: false },
        { id: 'local-model-alt', label: 'Local Model Alt', isDefault: true }
      ], 'local-model-alt');

      assert.equal(result.defaultModel, 'local-model-alt');
      assert.deepEqual(result.models, [
        { id: 'local-model', label: 'Local Model', isDefault: false },
        { id: 'local-model-alt', label: 'Local Model Alt', isDefault: true }
      ]);
      assert.deepEqual(result.refreshedBots.map(bot => ({
        name: bot.name,
        previousModel: bot.previousModel,
        model: bot.model
      })), [{
        name: 'API user',
        previousModel: 'api-model',
        model: 'local-model-alt'
      }]);
      assert.equal(store.settings().defaultBotModel, 'local-model-alt');
      assert.deepEqual(JSON.parse(store.settings().defaultBotModels), result.models);
      assert.equal(store.bot(stale.bot.id).model, 'local-model-alt');
      assert.equal(store.bot(stale.bot.id).permission, 'workspaceWrite');
      assert.equal(store.bot(valid.bot.id).model, 'local-model');
      assert.equal(store.bot(valid.bot.id).permission, 'readOnly');

      assert.throws(
        () => store.applyExecutionModelCatalogAndRefreshBots([
          { id: 'local-model', label: 'Local Model', isDefault: true }
        ], 'missing-model'),
        /默认模型必须来自/u
      );
      assert.equal(store.settings().defaultBotModel, 'local-model-alt');
      assert.equal(store.bot(stale.bot.id).model, 'local-model-alt');
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
    let expectedOwnerId;
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
        create: async (title, purpose, botIds) => store.createGroup(title, botIds, purpose)
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
      expectedOwnerId = second.bot.id;
      created = await runGroupCreateAction({
        type: 'create',
        title: '  Research  ',
        purpose: '  Research shared projects  ',
        botIds: expectedMemberIds
      }, callbacks);
      assert.equal(created.title, 'Research');
      assert.deepEqual(created.memberIds, expectedMemberIds);
      assert.equal(created.ownerBotId, expectedOwnerId);
      assert.equal(created.purpose, 'Research shared projects');
      assert.equal(created.defaultBotId, null);
      assert.equal(store.chats().length, 3);
      assert.deepEqual(store.messages(first.chat.id), []);
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      assert.deepEqual(reopened.groups(), [created]);
      assert.deepEqual(reopened.group(created.id).memberIds, expectedMemberIds);
      assert.equal(reopened.group(created.id).ownerBotId, expectedOwnerId);
      assert.equal(reopened.group(created.id).purpose, 'Research shared projects');
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

test('a group owner can update purpose and remove non-owner members while rejecting owner removal', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    let group, removedChatId, ownerBotId, retainedBotId;
    try {
      const owner = store.createBot('Owner', 'a');
      const peer = store.createBot('Peer', 'b');
      const retained = store.createBot('Retained', 'c');
      ownerBotId = owner.bot.id;
      retainedBotId = retained.bot.id;
      group = store.createGroup(
        'Owned room',
        [owner.bot.id, peer.bot.id, retained.bot.id],
        'Initial shared purpose',
        owner.bot.id
      );
      removedChatId = store.groupSession(group.id, peer.bot.id).id;

      const updated = store.updateGroupPurpose(group.id, '  Updated shared purpose  ');
      assert.equal(updated.purpose, 'Updated shared purpose');
      assert.throws(() => store.updateGroupPurpose(group.id, '   '), /1–4000/u);
      assert.throws(() => store.removeGroupMembers(group.id, [owner.bot.id]), /不能直接移除群主/u);
      assert.throws(() => store.removeGroupMembers(group.id, [retained.bot.id, 'not-a-member']), /不是当前群成员/u);

      const afterRemoval = store.removeGroupMembers(group.id, [peer.bot.id]);
      assert.deepEqual(afterRemoval.memberIds, [owner.bot.id, retained.bot.id]);
      assert.equal(afterRemoval.ownerBotId, owner.bot.id);
      assert.equal(afterRemoval.purpose, 'Updated shared purpose');
      assert.equal(store.groupSessions().some(session => session.chatId === removedChatId), false);
      assert.throws(() => store.chat(removedChatId), /聊天不存在/u);
      assert.equal(store.groupSession(group.id, retained.bot.id).groupChatId, group.id);
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      const persisted = reopened.group(group.id);
      assert.equal(persisted.purpose, 'Updated shared purpose');
      assert.deepEqual(persisted.memberIds, [ownerBotId, retainedBotId]);
      assert.equal(persisted.memberIds.includes(persisted.ownerBotId), true);
      assert.equal(reopened.groupSessions().some(session => session.chatId === removedChatId), false);
      assert.equal(reopened.db.prepare(
        'SELECT COUNT(*) AS count FROM group_chat_members WHERE groupChatId=?'
      ).get(group.id)?.count, 2);
      assert.deepEqual(
        reopened.db.prepare(
          'SELECT position FROM group_chat_members WHERE groupChatId=? ORDER BY position'
        ).all(group.id).map(row => row.position),
        [0, 1]
      );
    } finally { reopened.close(); }
  });
});

test('group archive is reversible and permanent deletion cascades group history and member sessions', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    let groupId, sessionIds;
    try {
      const first = store.createBot('First', 'a');
      const second = store.createBot('Second', 'b');
      const group = store.createGroup('Lifecycle room', [first.bot.id, second.bot.id]);
      groupId = group.id;
      store.addGroupMessage(group.id, 'user', 'group history');
      sessionIds = [store.groupSession(group.id, first.bot.id).id, store.groupSession(group.id, second.bot.id).id];

      const archived = store.setGroupArchived(group.id, true);
      assert.equal(archived.archived, true);
      assert.deepEqual(store.groups(), []);
      assert.deepEqual(store.archivedGroups().map(item => item.id), [group.id]);
      assert.equal(store.groupMessages(group.id).length, 1);

      const restored = store.setGroupArchived(group.id, false);
      assert.equal(restored.archived, false);
      assert.deepEqual(store.groups().map(item => item.id), [group.id]);
      assert.deepEqual(store.archivedGroups(), []);

      store.deleteGroup(group.id);
      assert.deepEqual(store.groups(), []);
      assert.deepEqual(store.groupSessions(), []);
      for (const chatId of sessionIds) assert.throws(() => store.chat(chatId), /聊天不存在/);
      assert.throws(() => store.group(groupId), /群聊不存在/);
    } finally { store.close(); }
  });
});

test('conversation ordering uses pins and creation time instead of recent updates', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const older = store.createBot('Older Bot', 'a');
      const newer = store.createBot('Newer Bot', 'b');
      const peer = store.createBot('Peer Bot', 'c');
      store.db.prepare('UPDATE bots SET createdAt=? WHERE id=?')
        .run('2026-10-01T00:00:00.000Z', older.bot.id);
      store.db.prepare('UPDATE bots SET createdAt=? WHERE id=?')
        .run('2026-10-02T00:00:00.000Z', newer.bot.id);
      store.db.prepare('UPDATE bots SET createdAt=? WHERE id=?')
        .run('2026-09-30T00:00:00.000Z', peer.bot.id);
      assert.deepEqual(store.bots().filter(item => !item.archived).map(item => item.id),
        [newer.bot.id, older.bot.id, peer.bot.id]);

      store.updateBot(older.bot.id, { role: 'updated recently' });
      assert.deepEqual(store.bots().filter(item => !item.archived).map(item => item.id),
        [newer.bot.id, older.bot.id, peer.bot.id]);

      const olderGroup = store.createGroup('Older group', [older.bot.id, peer.bot.id]);
      const newerGroup = store.createGroup('Newer group', [newer.bot.id, peer.bot.id]);
      store.db.prepare('UPDATE group_chats SET createdAt=? WHERE id=?')
        .run('2026-10-03T00:00:00.000Z', olderGroup.id);
      store.db.prepare('UPDATE group_chats SET createdAt=? WHERE id=?')
        .run('2026-10-04T00:00:00.000Z', newerGroup.id);
      assert.deepEqual(store.groups().map(item => item.id), [newerGroup.id, olderGroup.id]);
      store.addGroupMessage(olderGroup.id, 'user', 'recent group update');
      assert.deepEqual(store.groups().map(item => item.id), [newerGroup.id, olderGroup.id]);

      store.db.prepare('UPDATE bots SET pinnedAt=? WHERE id=?')
        .run('2026-10-20T00:00:00.000Z', older.bot.id);
      store.db.prepare('UPDATE group_chats SET pinnedAt=? WHERE id=?')
        .run('2026-10-21T00:00:00.000Z', olderGroup.id);
      assert.deepEqual(store.bots().filter(item => !item.archived).map(item => item.id),
        [older.bot.id, newer.bot.id, peer.bot.id]);
      assert.deepEqual(store.groups().map(item => item.id), [olderGroup.id, newerGroup.id]);

      const unpinned = store.setBotPinned(older.bot.id, false);
      assert.equal(unpinned.pinnedAt, null);
      assert.deepEqual(store.bots().filter(item => !item.archived).map(item => item.id),
        [newer.bot.id, older.bot.id, peer.bot.id]);
      assert.throws(() => store.setBotPinned(older.bot.id, 'yes'), /置顶状态/u);
      assert.throws(() => store.setGroupPinned(olderGroup.id, 1), /置顶状态/u);

      const pinnedGroup = store.setGroupPinned(olderGroup.id, false);
      assert.equal(pinnedGroup.pinnedAt, null);
      store.setBotArchived(older.bot.id, true);
      assert.equal(store.bot(older.bot.id).pinnedAt, null);
      store.setGroupArchived(olderGroup.id, true);
      assert.equal(store.group(olderGroup.id).pinnedAt, null);
    } finally { store.close(); }
  });
});

test('legacy group schemas retain newly pinned state during the no-default-Bot rebuild and migration', async () => {
  await withDirectory(async (Store, directory) => {
    const db = new DatabaseSync(join(directory, 'rambo.sqlite'));
    db.exec(`CREATE TABLE bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '', model TEXT, permission TEXT NOT NULL DEFAULT 'fullAccess',
        archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE group_chats (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        defaultBotId TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
        archived INTEGER NOT NULL DEFAULT 0,
        pinnedAt TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE group_chat_members (
        groupChatId TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
        botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, joinedAt TEXT NOT NULL,
        PRIMARY KEY(groupChatId, botId), UNIQUE(groupChatId, position));
      INSERT INTO bots(id,name,avatar,createdAt) VALUES('bot-a','A','a','2026-10-01T00:00:00.000Z');
      INSERT INTO bots(id,name,avatar,createdAt) VALUES('bot-b','B','b','2026-10-02T00:00:00.000Z');
      INSERT INTO group_chats(id,title,defaultBotId,archived,pinnedAt,createdAt,updatedAt)
        VALUES('group-pinned','Pinned','bot-a',0,'2026-10-20T00:00:00.000Z',
          '2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z');
      INSERT INTO group_chat_members(groupChatId,botId,position,joinedAt)
        VALUES('group-pinned','bot-a',0,'2026-10-03T00:00:00.000Z');
      INSERT INTO group_chat_members(groupChatId,botId,position,joinedAt)
        VALUES('group-pinned','bot-b',1,'2026-10-03T00:00:00.000Z');
      PRAGMA user_version=7;`);
    db.close();

    const migrated = new Store(directory);
    try {
      assert.equal(migrated.group('group-pinned').pinnedAt, '2026-10-20T00:00:00.000Z');
      assert.deepEqual(migrated.groups().map(item => item.id), ['group-pinned']);
      const groupColumns = migrated.db.prepare('PRAGMA table_info(group_chats)').all().map(row => row.name);
      const botColumns = migrated.db.prepare('PRAGMA table_info(bots)').all().map(row => row.name);
      assert.equal(groupColumns.includes('pinnedAt'), true);
      assert.equal(botColumns.includes('pinnedAt'), true);
      assert.equal(migrated.group('group-pinned').ownerBotId, 'bot-a');
      assert.equal(migrated.group('group-pinned').purpose, '');
      assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 27);
    } finally { migrated.close(); }
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
      assert.equal(reopened.db.prepare('PRAGMA user_version').get()?.user_version, 27);
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
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 27);
    } finally { store.close(); }
  });
});

test('legacy routine runs gain a readable plan snapshot while retaining their original instruction', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    let botId, routineId;
    try {
      const { bot } = store.createBot('Legacy Run Owner', 'a');
      botId = bot.id;
      const routine = store.createRoutine({
        botId,
        title: 'Legacy daily',
        instruction: 'Original persisted instruction.',
        schedule: '每天',
        time: '09:30',
        sourceCallId: 'legacy-run-snapshot'
      });
      routineId = routine.id;
      store.db.prepare(`INSERT INTO routine_runs(
        id,routineId,botId,routineTitle,instruction,scheduledFor,status,trigger,createdAt)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        'legacy-run', routineId, botId, routine.title, routine.definition.instruction,
        '2026-10-22T01:30:00.000Z', 'succeeded', 'schedule', '2026-10-22T01:30:00.000Z'
      );
      store.db.exec('DROP INDEX IF EXISTS routine_runs_routine');
      store.db.exec(`ALTER TABLE routine_runs DROP COLUMN definitionJson`);
      store.db.exec(`ALTER TABLE routine_runs DROP COLUMN definitionVersion`);
    } finally { store.close(); }

    const migrated = new Store(directory);
    try {
      const run = migrated.routineRun('legacy-run');
      assert.equal(run.routineId, routineId);
      assert.equal(run.botId, botId);
      assert.equal(run.instruction, 'Original persisted instruction.');
      assert.equal(run.definition.instruction, run.instruction);
      assert.equal(run.definition.schedule, '');
      assert.match(run.definitionVersion, /^[a-f\d]{64}$/u);
    } finally { migrated.close(); }
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
            instruction: '', execution: { mode: 'chat' }, schedule: '', kind: 'recurring', timezone: 'Asia/Shanghai',
            frequency: 'daily', weekday: null, dayOfMonth: null, times: ['09:00'], time: '09:00', runAt: null,
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
            instruction: '', execution: { mode: 'chat' }, schedule: '', kind: 'recurring', timezone: 'Asia/Shanghai',
            frequency: 'daily', weekday: null, dayOfMonth: null, times: ['09:00'], time: '09:00', runAt: null,
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
        instruction: input.instruction, execution: { mode: 'chat' }, schedule: input.schedule,
        kind: 'recurring', timezone: 'Asia/Shanghai', frequency: 'weekdays',
        weekday: null, dayOfMonth: null, times: ['09:00'], time: '09:00', runAt: null,
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

test('Routine execution modes persist with backward-compatible chat defaults', async () => {
  await withDirectory(async (Store, directory) => {
    let store = new Store(directory);
    const { bot } = store.createBot('Routine execution owner', 'brand');
    try {
      const legacy = store.createRoutine({
        botId: bot.id,
        title: 'Legacy chat mode',
        instruction: 'Summarize the result in conversation.',
        schedule: '每天 09:00',
        sourceCallId: 'execution-legacy'
      });
      assert.deepEqual(legacy.definition.execution, { mode: 'chat' });

      const script = store.createRoutine({
        botId: bot.id,
        title: 'Script-backed report',
        instruction: 'Generate and inspect a report.',
        schedule: '每天 10:00',
        sourceCallId: 'execution-script',
        executionMode: 'script',
        executionTemplate: 'Run the report generator and verify its output file.'
      });
      assert.deepEqual(script.definition.execution, {
        mode: 'script',
        template: 'Run the report generator and verify its output file.'
      });
      const hybrid = store.createRoutine({
        botId: bot.id,
        title: 'Hybrid report',
        instruction: 'Judge the input, then run the deterministic export.',
        schedule: '每天 11:00',
        sourceCallId: 'execution-hybrid',
        executionMode: 'hybrid',
        executionTemplate: 'Choose input fields, then run the exporter.'
      });
      assert.equal(hybrid.definition.execution.mode, 'hybrid');
      assert.throws(() => store.createRoutine({
        botId: bot.id,
        title: 'Missing template',
        instruction: 'Run a script.',
        schedule: '每天 12:00',
        sourceCallId: 'execution-missing-template',
        executionMode: 'script'
      }), /需要提供执行模板/u);

      const updated = store.updateRoutine(script.id, {
        executionMode: 'chat',
        executionTemplate: null
      });
      assert.deepEqual(updated.definition.execution, { mode: 'chat' });

      const raw = store.db.prepare('SELECT definitionJson FROM routines WHERE id=?').get(legacy.id);
      const definition = JSON.parse(String(raw.definitionJson));
      delete definition.execution;
      store.db.prepare('UPDATE routines SET definitionJson=? WHERE id=?')
        .run(JSON.stringify(definition), legacy.id);
    } finally { store.close(); }

    store = new Store(directory);
    try {
      const legacy = store.routines().find(item => item.title === 'Legacy chat mode');
      const script = store.routines().find(item => item.title === 'Script-backed report');
      const hybrid = store.routines().find(item => item.title === 'Hybrid report');
      assert.deepEqual(legacy.definition.execution, { mode: 'chat' });
      assert.deepEqual(script.definition.execution, { mode: 'chat' });
      assert.deepEqual(hybrid.definition.execution, {
        mode: 'hybrid',
        template: 'Choose input fields, then run the exporter.'
      });
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
      assert.deepEqual(reopened.settings(), {
        globalPermission: 'fullAccess', theme: 'light', wakeEnabled: 'true',
        defaultBotModel: 'test-model', defaultBotPermission: 'fullAccess'
      });
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
      threadId: 'thread-1', requestedModel: 'gpt-5.6-luna', modelSource: 'chat',
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

test('a hidden turn prompt records turn metadata without inserting a visible user message', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const { chat } = store.createBot('Hidden prompt', 'a');
      const permissionSnapshot = {
        permission: 'readOnly', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }
      };
      const begun = store.beginTurn(chat.id, 'internal handoff', {
        threadId: 'thread-hidden', requestedModel: 'gpt-5.6-luna', modelSource: 'bot',
        permissionSnapshot, promptVisible: false
      });

      assert.deepEqual(store.messages(chat.id), []);
      assert.equal(store.turn(begun.turn.id)?.threadId, 'thread-hidden');
      assert.equal(store.turns(chat.id).length, 1);
    } finally {
      store.close();
    }
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
      const partial = store.groupAssistantItem(
        group.id, first.bot.id, 'commentary-1', 'I will check the shared notes.', true, 'streaming', 'turn-1', 'commentary'
      ).message;
      const nextPhase = store.groupAssistantItem(
        group.id, first.bot.id, 'partial-1', 'I found the main points.', true, 'streaming', 'turn-1', 'partial_answer'
      ).message;
      const completed = store.groupAssistantItem(
        group.id, first.bot.id, 'final-1', 'Here are the notes.', false, 'complete', 'turn-1', 'final_answer'
      ).message;
      assert.equal(partial.id, completed.id);
      assert.equal(nextPhase.id, completed.id);
      assert.equal(completed.senderBotId, first.bot.id);
      assert.equal(completed.senderName, 'Researcher');
      assert.equal(completed.text, 'Here are the notes.');
      assert.equal(completed.itemId, 'final-1');
      assert.equal(completed.phase, 'final_answer');
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
      assert.equal(store.bot(first.bot.id).model, 'test-model');
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

test('connector connections persist by provider and grants remain isolated per Bot', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    let first, second, connection;
    try {
      first = store.createBot('Connector A', 'a').bot;
      second = store.createBot('Connector B', 'b').bot;
      connection = store.createConnectorConnection({
        id: 'connection-qq-1',
        providerId: 'qqmail',
        displayName: '工作邮箱',
        accountLabel: 'owner@qq.com',
        authKind: 'credentials',
        credentialRef: 'pending-keychain:connection-qq-1'
      });

      assert.equal(connection.status, 'ready');
      assert.equal(store.connectorCredentialRef(connection.id), 'pending-keychain:connection-qq-1');
      assert.deepEqual(store.connectorConnections().map(item => item.id), [connection.id]);
      assert.equal('credentialRef' in connection, false);

      assert.deepEqual(
        store.setConnectorGrant(first.id, connection.id, true).map(grant => grant.botId),
        [first.id]
      );
      assert.deepEqual(store.setConnectorGrant(second.id, connection.id, true).map(grant => grant.botId), [second.id]);
      assert.deepEqual(store.setConnectorGrant(first.id, connection.id, false), []);
      assert.deepEqual(store.connectorGrants().map(grant => grant.botId), [second.id]);
      assert.equal(store.connectorConnection(connection.id).status, 'ready');
      assert.equal(store.connectorConnection(connection.id).accountLabel, 'owner@qq.com');
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      assert.deepEqual(reopened.connectorGrants().map(grant => grant.botId), [second.id]);
      assert.equal(reopened.connectorConnection(connection.id).displayName, '工作邮箱');
    } finally { reopened.close(); }
  });
});

test('removing a connector connection cascades its Bot grants', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const bot = store.createBot('Cascade bot', 'a').bot;
      const connection = store.createConnectorConnection({
        id: 'connection-cascade',
        providerId: 'qqmail',
        displayName: 'QQ',
        accountLabel: 'cascade@qq.com',
        authKind: 'credentials',
        credentialRef: 'pending-keychain:connection-cascade'
      });
      store.setConnectorGrant(bot.id, connection.id, true);
      store.deleteConnectorConnection(connection.id);
      assert.deepEqual(store.connectorGrants(), []);
      assert.deepEqual(store.connectorConnections(), []);
    } finally { store.close(); }
  });
});

test('global and Bot-private secret metadata persists with scope isolation and Bot cascade cleanup', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    const { bot: first, chat: firstChat } = store.createBot('Secret owner', 'a');
    const { bot: second, chat: secondChat } = store.createBot('Secret peer', 'b');
    const globalId = '11111111-1111-4111-8111-111111111111';
    const firstId = '22222222-2222-4222-8222-222222222222';
    const secondId = '33333333-3333-4333-8333-333333333333';
    try {
      store.createBotSecret({
        id: globalId,
        name: 'Shared token',
        description: 'All Bots',
        scope: 'global',
        botId: null,
        credentialRef: 'db:11111111-1111-4111-8111-111111111112'
      });
      store.createBotSecret({
        id: firstId,
        name: 'Private token',
        description: 'Owner only',
        scope: 'bot',
        botId: first.id,
        credentialRef: 'db:22222222-2222-4222-8222-222222222223'
      });
      store.createBotSecret({
        id: secondId,
        name: 'Private token',
        description: 'Peer only',
        scope: 'bot',
        botId: second.id,
        credentialRef: 'db:33333333-3333-4333-8333-333333333334'
      });
      store.bindThread(firstChat.id, 'secret-enabled-thread', true, true, true);
      store.bindThread(secondChat.id, 'secret-legacy-thread', true, true);

      assert.deepEqual(store.botSecrets(first.id).map(secret => [secret.name, secret.scope]), [
        ['Shared token', 'global'],
        ['Private token', 'bot']
      ]);
      assert.deepEqual(store.botSecrets(second.id).map(secret => secret.id), [globalId, secondId]);
      assert.equal(store.botSecretForBot(globalId, first.id).scope, 'global');
      assert.equal(store.botSecretForBot(firstId, first.id).botId, first.id);
      assert.throws(() => store.botSecretForBot(firstId, second.id), /无权访问/u);
      assert.throws(() => store.createBotSecret({
        id: '44444444-4444-4444-8444-444444444444',
        name: 'private token',
        description: '',
        scope: 'bot',
        botId: first.id,
        credentialRef: 'db:44444444-4444-4444-8444-444444444445'
      }), /同名私有密钥/u);
    } finally { store.close(); }

    const reopened = new Store(directory);
    try {
      assert.equal(reopened.botSecrets(first.id).length, 2);
      assert.equal(reopened.botSecrets(second.id).length, 2);
      assert.deepEqual(reopened.secretToolThreadIds(), ['secret-enabled-thread']);
      reopened.deleteBot(first.id);
      assert.throws(() => reopened.ownedBotSecrets(first.id), /机器人不存在/u);
      assert.deepEqual(reopened.secretToolThreadIds(), []);
      assert.deepEqual(
        reopened.db.prepare('SELECT id FROM bot_secrets WHERE botId=?').all(first.id),
        []
      );
      assert.deepEqual(reopened.botSecrets(second.id).map(secret => secret.id), [globalId, secondId]);
      assert.equal(reopened.botSecret(globalId).scope, 'global');
    } finally { reopened.close(); }
  });
});


test('owned Codex thread inventory includes archived chats and excludes unrelated native sessions', async () => {
  await withDirectory(async (Store, directory) => {
    const store = new Store(directory);
    try {
      const { bot, chat } = store.createBot('Migration owner', 'grok-avatar:v1:cloud:violet');
      store.bindThread(chat.id, '00000000-0000-0000-0000-000000000001');
      store.setBotArchived(bot.id, true);
      assert.deepEqual(store.ownedCodexThreadIds(), ['00000000-0000-0000-0000-000000000001']);
    } finally { store.close(); }
  });
});
