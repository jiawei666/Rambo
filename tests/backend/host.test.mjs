import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const storeSource = readFileSync(new URL('../../src/main/store.ts', import.meta.url), 'utf8');
const hostSource = readFileSync(new URL('../../src/main/host.ts', import.meta.url), 'utf8');
const scheduleSource = readFileSync(new URL('../../src/main/routine-schedule.ts', import.meta.url), 'utf8');
const schedulerSource = readFileSync(new URL('../../src/main/routine-scheduler.ts', import.meta.url), 'utf8');
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const compiledSchedule = ts.transpileModule(scheduleSource, { compilerOptions }).outputText;
const compiledStore = ts.transpileModule(storeSource, { compilerOptions }).outputText
  .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'");
const compiledScheduler = ts.transpileModule(schedulerSource, { compilerOptions }).outputText;
const compiledHost = ts.transpileModule(hostSource, { compilerOptions }).outputText
  .replaceAll("from './store'", "from './store.mjs'")
  .replaceAll("from './routine-scheduler'", "from './routine-scheduler.mjs'");

class FakeRuntime extends EventEmitter {
  state = { status: 'ready', version: '0.163.0', error: null };
  requests = [];
  responses = [];
  turnList = [];
  nextThreadId = 1;

  async start() {}

  respondToServerRequest(id, result) {
    this.responses.push({ id, result });
  }

  request(method, params = {}, _timeoutMs, options) {
    const request = { method, params, options };
    this.requests.push(request);
    if (method === 'config/read') {
      return Promise.resolve(params.cwd
        ? { config: { model: 'workspace-only-model', mcp_servers: { localServer: { command: 'must-not-forward' } } } }
        : { config: { model: 'local-global-model', unrelated: 'must-not-forward' } });
    }
    if (method === 'skills/list') return Promise.resolve({ data: [{ skills: [], errors: [] }] });
    if (method === 'thread/start') {
      const id = `thread-${this.nextThreadId++}`;
      return Promise.resolve({ thread: { id }, model: 'thread-response-model', modelProvider: 'thread-response-provider' });
    }
    if (method === 'thread/resume') {
      return Promise.resolve({ model: 'thread-response-model', modelProvider: 'thread-response-provider' });
    }
    if (method === 'turn/start') {
      return new Promise(resolve => { request.resolve = resolve; });
    }
    if (method === 'turn/steer') return Promise.resolve({ turn: { id: params.expectedTurnId } });
    if (method === 'turn/interrupt') return Promise.resolve({});
    if (method === 'thread/turns/list') return Promise.resolve({ data: this.turnList });
    throw new Error(`Unexpected RPC: ${method}`);
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail('RPC was not issued');
}

function emitTurnStarted(runtime, threadId, turnId) {
  runtime.emit('notification', 'turn/started', {
    threadId,
    turn: { id: turnId, status: 'inProgress' }
  });
}

async function withHost(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-host-test-'));
  writeFileSync(join(directory, 'routine-schedule.mjs'), compiledSchedule, { mode: 0o600 });
  writeFileSync(join(directory, 'routine-scheduler.mjs'), compiledScheduler, { mode: 0o600 });
  writeFileSync(join(directory, 'store.mjs'), compiledStore, { mode: 0o600 });
  writeFileSync(join(directory, 'host.mjs'), compiledHost, { mode: 0o600 });
  try {
    const [{ Store }, { Host }] = await Promise.all([
      import(`${pathToFileURL(join(directory, 'store.mjs')).href}?${Date.now()}`),
      import(`${pathToFileURL(join(directory, 'host.mjs')).href}?${Date.now()}`)
    ]);
    const store = new Store(directory);
    let storeToClose = store;
    const runtime = new FakeRuntime();
    const events = [];
    const host = new Host(store, runtime, event => events.push(event));
    try { await run({ store, runtime, host, events, Store, Host, replaceStore: next => { storeToClose = next; } }); }
    finally { storeToClose.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('a version 12 duplicate chat migration keeps only the surviving thread in host mappings', async () => {
  await withHost(async ({ store, runtime, Store, replaceStore }) => {
    const { bot, chat } = store.createBot('Migration Bot', 'a');
    store.bindThread(chat.id, 'thread-kept-v12');
    store.db.prepare('UPDATE chats SET updatedAt=? WHERE id=?').run('2026-10-21T10:00:00.000Z', chat.id);
    store.db.exec('DROP INDEX chats_one_direct_chat_per_bot');
    store.db.prepare(`INSERT INTO chats(id,botId,title,threadId,groupChatId,archived,routineToolsEnabled,memoryToolsEnabled,createdAt,updatedAt)
      VALUES(?,?,?,'thread-hidden-v12',NULL,0,0,0,?,?)`)
      .run('chat-hidden-v12', bot.id, 'Older duplicate', '2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z');
    store.db.exec('PRAGMA user_version=12;');
    const directory = store.directory;
    store.close();

    const migrated = new Store(directory);
    replaceStore(migrated);
    const migratedHost = new (await import(`${pathToFileURL(join(directory, 'host.mjs')).href}?host-v12-${Date.now()}`)).Host(
      migrated, runtime, () => {}
    );
    assert.equal(migratedHost.threadChats.get('thread-kept-v12'), chat.id);
    assert.equal(migratedHost.threadChats.has('thread-hidden-v12'), false);
    assert.deepEqual(migrated.allChats().map(value => value.id), [chat.id]);
  });
});

test('a Bot reuses one private thread across turns and Host restart while group sessions use another thread', async () => {
  await withHost(async ({ store, runtime, Store, Host, replaceStore }) => {
    const privateBot = store.createBot('Private continuity', 'a');
    const groupPeer = store.createBot('Group peer', 'b');
    const group = store.createGroup('Independent context room', [privateBot.bot.id, groupPeer.bot.id]);

    const first = new Host(store, runtime, () => {});
    const firstSend = first.send(privateBot.chat.id, 'first private turn');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const privateThreadId = store.chat(privateBot.chat.id).threadId;
    assert.equal(typeof privateThreadId, 'string');
    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'private-turn-1' } });
    await firstSend;
    runtime.emit('notification', 'turn/completed', {
      threadId: privateThreadId, turn: { id: 'private-turn-1', status: 'completed' }
    });
    const reopened = new Store(store.directory);
    replaceStore(reopened);
    const groupSession = reopened.groupSession(group.id, privateBot.bot.id);
    const second = new Host(reopened, runtime, () => {});
    const secondSending = second.send(privateBot.chat.id, 'second private turn after restart');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const resume = runtime.requests.find(request => request.method === 'thread/resume');
    assert.equal(resume.params.threadId, privateThreadId);
    assert.equal(reopened.chat(privateBot.chat.id).threadId, privateThreadId);
    const secondTurn = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.equal(secondTurn.params.threadId, privateThreadId);
    secondTurn.resolve({ turn: { id: 'private-turn-2' } });
    await secondSending;
    runtime.emit('notification', 'turn/completed', {
      threadId: privateThreadId, turn: { id: 'private-turn-2', status: 'completed' }
    });

    const memberSending = second.send(groupSession.id, 'group member turn');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 3);
    const groupThreadId = reopened.chat(groupSession.id).threadId;
    assert.equal(typeof groupThreadId, 'string');
    assert.notEqual(groupThreadId, privateThreadId);
    assert.equal(reopened.chat(groupSession.id).groupChatId, group.id);
    assert.equal(reopened.chat(privateBot.chat.id).groupChatId, null);
    const memberTurn = runtime.requests.filter(request => request.method === 'turn/start')[2];
    assert.equal(memberTurn.params.threadId, groupThreadId);
    memberTurn.resolve({ turn: { id: 'group-turn-1' } });
    await memberSending;
  });
});

test('new text threads expose the routine tool and persist one queryable definition per call', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { bot, chat } = store.createBot('Assistant', 'a');
    const sending = host.send(chat.id, '请每个工作日 09:00 创建一个只生成固定状态文本的周期任务。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    assert.deepEqual(
      threadStart.params.dynamicTools.map(tool => tool.name),
      ['rambo_routines', 'rambo_bot', 'rambo_memories', 'rambo_voice']
    );
    const routineTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_routines');
    const botTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_bot');
    const memoryTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_memories');
    assert.deepEqual(routineTool.tools.map(tool => tool.name), [
      'create_routine', 'update_routine', 'set_routine_status', 'delete_routine'
    ]);
    assert.deepEqual(routineTool.tools[0].inputSchema.required, ['title', 'instruction', 'schedule', 'triggerTime', 'kind']);
    assert.equal(routineTool.tools[0].inputSchema.properties.triggerTime.pattern, '^(?:[01]\\d|2[0-3]):[0-5]\\d$');
    assert.deepEqual(botTool.tools.map(tool => tool.name), ['update_profile', 'update_config']);
    assert.deepEqual(memoryTool.tools.map(tool => tool.name), ['save_memory', 'delete_memory']);
    assert.match(botTool.tools[0].description, /直接调用/);
    assert.equal(store.chatMemoryToolsEnabled(chat.id), true);
    assert.match(threadStart.params.developerInstructions, /一天内的具体触发时刻都已从对话明确确定/);
    assert.match(threadStart.params.developerInstructions, /不得调用创建工具/);
    assert.match(threadStart.params.developerInstructions, /本机后台服务执行/);
    assert.match(threadStart.params.developerInstructions, /不需用户逐项批准/);

    const threadId = store.chat(chat.id).threadId;
    const params = {
      threadId, turnId: 'turn-1', callId: 'routine-call-1',
      namespace: 'rambo_routines', tool: 'create_routine',
      arguments: {
        title: 'Morning status',
        instruction: '只生成一行固定状态文本，不访问外部工具。',
        schedule: '每个工作日',
        triggerTime: '09:00',
        kind: 'recurring'
      }
    };
    assert.equal(runtime.emit('serverRequest', { id: 41, method: 'item/tool/call', params }), true);
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].id, 41);
    assert.equal(runtime.responses[0].result.success, true);
    assert.match(runtime.responses[0].result.contentItems[0].text, /本机后台执行/);

    const [saved] = store.routines();
    assert.equal(saved.botId, bot.id);
    assert.equal(saved.definition.instruction, params.arguments.instruction);
    assert.equal(saved.definition.schedule, `${params.arguments.schedule} ${params.arguments.triggerTime}`);
    assert.equal(saved.definition.kind, 'recurring');
    assert.equal(saved.definition.frequency, 'weekdays');
    assert.equal(saved.definition.time, '09:00');
    assert.deepEqual(host.snapshot().routines, [saved]);
    assert.ok(events.some(event => event.type === 'changed'));

    runtime.emit('serverRequest', { id: 42, method: 'item/tool/call', params });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, true);
    assert.equal(store.routines().length, 1);
    assert.equal(store.routines()[0].id, saved.id);

    runtime.emit('serverRequest', {
      id: 43, method: 'item/tool/call',
      params: { ...params, arguments: { ...params.arguments, title: 'Conflicting retry' } }
    });
    await waitFor(() => runtime.responses.length === 3);
    assert.equal(runtime.responses[2].result.success, false);
    assert.equal(store.routines().length, 1);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'turn-1' } });
    await sending;
  });
});

test('routine creation rejects a missing or invalid trigger time and asks the Bot to clarify first', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { chat } = store.createBot('Assistant', 'a');
    const sending = host.send(chat.id, '以后每周一给我一条本地提醒。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadId = store.chat(chat.id).threadId;
    const incompleteCalls = [
      { id: 61, callId: 'missing-time', arguments: { title: 'Weekly reminder', instruction: 'Show the reminder', schedule: '每周一', kind: 'recurring' } },
      { id: 62, callId: 'invalid-time', arguments: { title: 'Weekly reminder', instruction: 'Show the reminder', schedule: '每周一', triggerTime: '24:00', kind: 'recurring' } }
    ];

    for (const [index, call] of incompleteCalls.entries()) {
      runtime.emit('serverRequest', {
        id: call.id, method: 'item/tool/call',
        params: {
          threadId, turnId: 'turn-missing-time', callId: call.callId,
          namespace: 'rambo_routines', tool: 'create_routine', arguments: call.arguments
        }
      });
      await waitFor(() => runtime.responses.length === index + 1);
      assert.equal(runtime.responses[index].result.success, false);
      assert.match(runtime.responses[index].result.contentItems[0].text, /先向用户追问具体时间/);
      assert.deepEqual(store.routines(), []);
    }

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'turn-missing-time' } });
    await sending;
  });
});

test('a legacy thread without registered tools cannot call memory or routine tools after resume', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Assistant', 'a');
    store.bindThread(chat.id, 'legacy-thread', false);
    host.threadChats.set('legacy-thread', chat.id);

    const sending = host.send(chat.id, 'continue this existing thread');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const resume = runtime.requests.find(request => request.method === 'thread/resume');
    assert.deepEqual(resume.params.dynamicTools.map(tool => tool.name), ['rambo_voice']);
    assert.equal(resume.params.developerInstructions.includes('rambo_routines.create_routine'), false);
    assert.equal(resume.params.developerInstructions.includes('rambo_memories.save_memory'), false);

    runtime.emit('serverRequest', {
      id: 51, method: 'item/tool/call',
      params: {
        threadId: 'legacy-thread', turnId: 'turn-legacy', callId: 'routine-call-legacy',
        namespace: 'rambo_routines', tool: 'create_routine',
        arguments: { title: 'Must not persist', instruction: 'Do nothing', schedule: 'daily', triggerTime: '09:00', kind: 'recurring' }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, false);
    assert.deepEqual(store.routines(), []);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'turn-legacy' } });
    await sending;
  });
});

test('routine calls are attributed to the Bot that owns the triggering private thread', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('A', 'a');
    const second = store.createBot('B', 'b');
    const sending = host.send(second.chat.id, '请创建一个每月 08:00 整理工作目录的周期任务。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    const botBThread = store.chat(second.chat.id).threadId;
    assert.equal(host.threadChats.get(botBThread), second.chat.id);
    assert.notEqual(host.threadChats.get(botBThread), first.chat.id);

    runtime.emit('serverRequest', {
      id: 52, method: 'item/tool/call',
      params: {
        threadId: botBThread, turnId: 'routine-b', callId: 'routine-b-call',
        namespace: 'rambo_routines', tool: 'create_routine',
        arguments: { title: 'B monthly', instruction: '整理工作目录', schedule: '每月', triggerTime: '08:00', kind: 'recurring' }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    assert.equal(store.routines()[0].botId, second.bot.id);
    assert.equal(store.routines().some(routine => routine.botId === first.bot.id), false);

    start.resolve({ turn: { id: 'routine-b' } });
    await sending;
  });
});

test('memory tool saves without approval, keeps Bot and shared scopes separate, and deduplicates retries', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('A', 'a');
    const second = store.createBot('B', 'b');
    const preference = '用户偏好每小时第 50 分钟开始休息 5 分钟，以便整点前缓一缓。';
    const sending = host.send(first.chat.id, '顺便告诉你，做这轮验收时我更喜欢每小时第 50 分钟开始休息 5 分钟，这样整点前可以缓一缓。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    assert.match(threadStart.params.developerInstructions, /仅用于群聊成员的判断场景.*不适用于 Bot 私聊/u);
    assert.match(threadStart.params.developerInstructions, /私聊必须真实回答用户/u);
    assert.match(threadStart.params.developerInstructions, /不能用 NO_REPLY 代替答复/u);
    const threadId = store.chat(first.chat.id).threadId;
    const memoryTool = threadStart.params.dynamicTools.find(namespace => namespace.name === 'rambo_memories').tools[0];
    assert.match(memoryTool.description, /稳定.*跨 Bot.*aboutMe/u);
    assert.match(memoryTool.description, /只适用于当前 Bot.*scope=bot/u);
    assert.match(memoryTool.description, /success=true.*已保存/u);
    assert.match(memoryTool.inputSchema.properties.scope.description, /默认 bot/u);
    assert.match(threadStart.params.developerInstructions, /跨 Bot 适用.*aboutMe/u);
    assert.match(threadStart.params.developerInstructions, /只适用于当前 Bot.*scope=bot/u);
    assert.match(threadStart.params.developerInstructions, /success=true.*已保存/u);

    const privateMemoryCall = {
      threadId, turnId: 'memory-a', callId: 'memory-private-call',
      namespace: 'rambo_memories', tool: 'save_memory',
      arguments: { text: 'A prefers concise summaries.' }
    };
    runtime.emit('serverRequest', { id: 61, method: 'item/tool/call', params: privateMemoryCall });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    assert.equal(store.memories(first.bot.id).length, 1);
    assert.equal(store.memories(first.bot.id)[0].approved, true);
    assert.equal(store.memories(second.bot.id).length, 0);

    runtime.emit('serverRequest', { id: 62, method: 'item/tool/call', params: privateMemoryCall });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, true);
    assert.equal(store.memories(first.bot.id).length, 1);

    runtime.emit('serverRequest', {
      id: 63, method: 'item/tool/call',
      params: {
        threadId, turnId: 'memory-a', callId: 'memory-shared-call',
        namespace: 'rambo_memories', tool: 'save_memory',
        arguments: { scope: 'aboutMe', text: preference }
      }
    });
    await waitFor(() => runtime.responses.length === 3);
    assert.equal(runtime.responses[2].result.success, true);
    assert.match(runtime.responses[2].result.contentItems[0].text, /已自动保存长期记忆/);
    assert.deepEqual(store.memories(null).map(memory => memory.text), [preference]);
    assert.equal(store.memories(first.bot.id).length, 1);

    runtime.emit('serverRequest', {
      id: 64, method: 'item/tool/call',
      params: {
        threadId, turnId: 'memory-a', callId: 'memory-invalid-scope-call',
        namespace: 'rambo_memories', tool: 'save_memory',
        arguments: { scope: 'allBotsPrivate', text: 'This must not be saved.' }
      }
    });
    await waitFor(() => runtime.responses.length === 4);
    assert.equal(runtime.responses[3].result.success, false);
    assert.match(runtime.responses[3].result.contentItems[0].text, /记忆范围无效/u);
    assert.equal(store.memories(null).length, 1);
    assert.equal(store.memories(first.bot.id).length, 1);

    const privateMemoryId = store.memories(first.bot.id)[0].id;
    runtime.emit('serverRequest', {
      id: 65, method: 'item/tool/call',
      params: {
        threadId, turnId: 'memory-a', callId: 'memory-delete-private-call',
        namespace: 'rambo_memories', tool: 'delete_memory',
        arguments: { id: privateMemoryId }
      }
    });
    await waitFor(() => runtime.responses.length === 5);
    assert.equal(runtime.responses[4].result.success, true);
    assert.deepEqual(store.memories(first.bot.id), []);
    assert.equal(store.memories(null).length, 1);

    runtime.emit('serverRequest', {
      id: 66, method: 'item/tool/call',
      params: {
        threadId, turnId: 'memory-a', callId: 'memory-delete-shared-call',
        namespace: 'rambo_memories', tool: 'delete_memory',
        arguments: { id: store.memories(null)[0].id }
      }
    });
    await waitFor(() => runtime.responses.length === 6);
    assert.equal(runtime.responses[5].result.success, false);
    assert.equal(store.memories(null).length, 1);

    const nextSending = host.send(second.chat.id, 'start B thread');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const secondStart = runtime.requests.filter(request => request.method === 'thread/start')[1];
    const secondTurn = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.match(secondTurn.params.additionalContext['rambo.about-me'].value, /每小时第 50 分钟开始休息 5 分钟/u);
    assert.doesNotMatch(JSON.stringify(secondTurn.params.additionalContext), /A prefers concise summaries\./);
    assert.equal('rambo.bot-memory' in secondTurn.params.additionalContext, false);
    assert.equal(secondStart.params.dynamicTools.some(namespace => namespace.name === 'rambo_memories'), true);

    start.resolve({ turn: { id: 'memory-a' } });
    runtime.requests.filter(request => request.method === 'turn/start')[1].resolve({ turn: { id: 'memory-b' } });
    await Promise.all([sending, nextSending]);
  });
});

test('each turn receives current About Me and only its Bot private memory', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('A', 'a');
    const second = store.createBot('B', 'b');
    store.saveMemory({ botId: first.bot.id, text: 'A private marker PRIVATE-A-41.' });

    const firstSending = host.send(first.chat.id, 'start A before shared profile exists');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const firstStart = runtime.requests.filter(request => request.method === 'turn/start')[0];
    const firstThread = store.chat(first.chat.id).threadId;
    assert.match(firstStart.params.additionalContext['rambo.bot-memory'].value, /PRIVATE-A-41/);
    assert.equal('rambo.about-me' in firstStart.params.additionalContext, false);
    firstStart.resolve({ turn: { id: 'a-before-about-me' } });
    await firstSending;
    runtime.emit('notification', 'turn/completed', {
      threadId: firstThread, turn: { id: 'a-before-about-me', status: 'completed' }
    });

    const secondSending = host.send(second.chat.id, 'start B before shared profile exists');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const secondBeforeShared = runtime.requests.filter(request => request.method === 'turn/start')[1];
    const secondThread = store.chat(second.chat.id).threadId;
    assert.equal('rambo.about-me' in secondBeforeShared.params.additionalContext, false);
    assert.equal('rambo.bot-memory' in secondBeforeShared.params.additionalContext, false);
    assert.doesNotMatch(JSON.stringify(secondBeforeShared.params.additionalContext), /PRIVATE-A-41/);
    secondBeforeShared.resolve({ turn: { id: 'b-before-about-me' } });
    await secondSending;
    runtime.emit('notification', 'turn/completed', {
      threadId: secondThread, turn: { id: 'b-before-about-me', status: 'completed' }
    });

    store.saveMemory({ botId: null, text: 'Shared marker ABOUT-ME-73.' });
    const firstAfterSave = host.send(first.chat.id, 'read the newly saved shared profile');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 3);
    const firstAfterSaveStart = runtime.requests.filter(request => request.method === 'turn/start')[2];
    assert.match(firstAfterSaveStart.params.additionalContext['rambo.about-me'].value, /ABOUT-ME-73/);
    assert.match(firstAfterSaveStart.params.additionalContext['rambo.bot-memory'].value, /PRIVATE-A-41/);
    assert.equal(runtime.requests.filter(request => request.method === 'thread/start').length, 2);
    firstAfterSaveStart.resolve({ turn: { id: 'a-after-about-me' } });
    await firstAfterSave;
    runtime.emit('notification', 'turn/completed', {
      threadId: firstThread, turn: { id: 'a-after-about-me', status: 'completed' }
    });

    const secondAfterSave = host.send(second.chat.id, 'read the newly saved shared profile');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 4);
    const secondAfterSaveStart = runtime.requests.filter(request => request.method === 'turn/start')[3];
    assert.match(secondAfterSaveStart.params.additionalContext['rambo.about-me'].value, /ABOUT-ME-73/);
    assert.doesNotMatch(JSON.stringify(secondAfterSaveStart.params.additionalContext), /PRIVATE-A-41/);
    assert.equal('rambo.bot-memory' in secondAfterSaveStart.params.additionalContext, false);
    secondAfterSaveStart.resolve({ turn: { id: 'b-after-about-me' } });
    await secondAfterSave;
    runtime.emit('notification', 'turn/completed', {
      threadId: secondThread, turn: { id: 'b-after-about-me', status: 'completed' }
    });

    const third = store.createBot('C', 'c');
    const thirdSending = host.send(third.chat.id, 'read About Me as a new Bot');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 5);
    const thirdStart = runtime.requests.filter(request => request.method === 'turn/start')[4];
    assert.match(thirdStart.params.additionalContext['rambo.about-me'].value, /ABOUT-ME-73/);
    assert.doesNotMatch(JSON.stringify(thirdStart.params.additionalContext), /PRIVATE-A-41/);
    assert.equal('rambo.bot-memory' in thirdStart.params.additionalContext, false);
    thirdStart.resolve({ turn: { id: 'c-with-about-me' } });
    await thirdSending;
  });
});

test('self-managed Bot profile changes persist without approval and stay separate from fact memory', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('A', 'a');
    const threadId = 'self-profile-thread';
    store.bindThread(chat.id, threadId, false, true);
    host.threadChats.set(threadId, chat.id);
    const role = '负责整理植物养护建议。';
    const instructions = '回答茶树盆栽养护建议时，最后一行必须严格写“自主标记-CAN-18”。';
    const sending = host.send(chat.id, '把你的短职责和长期指令改成我刚说的版本。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    emitTurnStarted(runtime, threadId, 'self-profile');
    runtime.emit('serverRequest', {
      id: 71, method: 'item/tool/call',
      params: {
        threadId, turnId: 'self-profile', callId: 'self-profile-1',
        namespace: 'rambo_bot', tool: 'update_profile',
        arguments: { name: '植物助手', avatar: 'plant-avatar', role, instructions }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    assert.equal(store.bot(bot.id).name, '植物助手');
    assert.equal(store.bot(bot.id).avatar, 'plant-avatar');
    assert.equal(store.bot(bot.id).role, role);
    assert.equal(store.bot(bot.id).instructions, instructions);
    assert.deepEqual(store.memories(bot.id), []);
    assert.deepEqual(store.memories(null), []);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'self-profile' } });
    await sending;
  });
});

test('a disabled legacy instruction channel cannot update profile or facts', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('A', 'a');
    const threadId = 'legacy-thread-with-memory-tool';
    store.bindThread(chat.id, threadId, false, true);
    host.threadChats.set(threadId, chat.id);
    const proposed = '回答茶树盆栽养护建议时，最后一行必须严格写“旧通道标记-CAN-19”。';
    const sending = host.send(chat.id, '尝试通过旧通道写入。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    emitTurnStarted(runtime, threadId, 'reject-instruction');
    runtime.emit('serverRequest', {
      id: 72, method: 'item/tool/call',
      params: {
        threadId, turnId: 'reject-instruction', callId: 'reject-instruction-1',
        namespace: 'rambo_memories', tool: 'save_memory',
        arguments: { scope: 'bot', text: `Bot 长期行为指令：${proposed}` }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, false);
    assert.match(runtime.responses[0].result.contentItems[0].text, /旧版长期指令写入已停用/u);
    assert.equal(store.bot(bot.id).instructions, '');
    assert.deepEqual(store.memories(bot.id), []);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'reject-instruction' } });
    await sending;
  });
});

test('self-managed config changes only its own defaults and private chat and does not masquerade as Routine execution', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Config Bot', 'a');
    const second = store.createBot('Other Bot', 'b');
    const threadId = 'self-config-thread';
    store.bindThread(first.chat.id, threadId, true, true);
    host.threadChats.set(threadId, first.chat.id);

    const sending = host.send(first.chat.id, '把你自己的默认设置和当前聊天设置改掉。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    emitTurnStarted(runtime, threadId, 'self-config');
    runtime.emit('serverRequest', {
      id: 73, method: 'item/tool/call',
      params: {
        threadId, turnId: 'self-config', callId: 'self-config-call',
        namespace: 'rambo_bot', tool: 'update_config',
        arguments: {
          model: 'self-model', permission: 'readOnly',
          chatModel: 'self-chat-model', chatPermission: 'workspaceWrite'
        }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true, runtime.responses[0].result.contentItems?.[0]?.text);
    assert.equal(store.bot(first.bot.id).model, 'self-model');
    assert.equal(store.bot(first.bot.id).permission, 'readOnly');
    assert.equal(store.chat(first.chat.id).model, 'self-chat-model');
    assert.equal(store.chat(first.chat.id).permission, 'workspaceWrite');
    assert.equal(store.bot(second.bot.id).model, null);
    assert.equal(store.bot(second.bot.id).permission, 'fullAccess');
    assert.deepEqual(store.routines(), []);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'self-config' } });
    await sending;
  });
});

test('self-managed config rejects a null Bot permission and unknown config fields without changing data', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Strict Config Bot', 'a');
    const threadId = 'strict-self-config-thread';
    store.bindThread(chat.id, threadId, true, true);
    host.threadChats.set(threadId, chat.id);

    const before = {
      bot: store.bot(bot.id),
      chat: store.chat(chat.id)
    };
    const sending = host.send(chat.id, '测试无效配置。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    emitTurnStarted(runtime, threadId, 'strict-self-config');
    runtime.emit('serverRequest', {
      id: 74, method: 'item/tool/call',
      params: {
        threadId, turnId: 'strict-self-config', callId: 'strict-self-null',
        namespace: 'rambo_bot', tool: 'update_config',
        arguments: { permission: null }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, false);
    assert.match(runtime.responses[0].result.contentItems[0].text, /默认权限不能为空/u);

    runtime.emit('serverRequest', {
      id: 75, method: 'item/tool/call',
      params: {
        threadId, turnId: 'strict-self-config', callId: 'strict-self-extra',
        namespace: 'rambo_bot', tool: 'update_config',
        arguments: { model: 'unexpected-model', globalPermission: 'readOnly' }
      }
    });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, false);
    assert.match(runtime.responses[1].result.contentItems[0].text, /不支持修改 Bot 运行配置字段：globalPermission/u);
    assert.deepEqual(store.bot(bot.id), before.bot);
    const afterChat = store.chat(chat.id);
    assert.equal(afterChat.model, before.chat.model);
    assert.equal(afterChat.permission, before.chat.permission);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'strict-self-config' } });
    await sending;
  });
});

test('self-management rejects cross-Bot, destructive and unregistered operations', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Scoped Bot', 'a');
    const second = store.createBot('Other Bot', 'b');
    const otherRoutine = store.createRoutine({
      botId: second.bot.id, title: 'Other', instruction: 'Do not touch',
      schedule: '每天 09:00', sourceCallId: 'fixture-other-routine'
    });
    const firstPrivate = store.saveMemory({ botId: first.bot.id, text: 'A private memory.' });
    const secondPrivate = store.saveMemory({ botId: second.bot.id, text: 'B private memory.' });
    const shared = store.saveMemory({ botId: null, text: 'Shared memory.' });
    const threadId = 'self-boundary-thread';
    store.bindThread(first.chat.id, threadId, true, true);
    host.threadChats.set(threadId, first.chat.id);

    const sending = host.send(first.chat.id, '测试自管理的范围边界。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    emitTurnStarted(runtime, threadId, 'self-boundary');
    const calls = [
      ['cross-routine', 'rambo_routines', 'set_routine_status', { id: otherRoutine.id, status: 'paused' }],
      ['cross-memory', 'rambo_memories', 'delete_memory', { id: secondPrivate.id }],
      ['shared-memory', 'rambo_memories', 'delete_memory', { id: shared.id }],
      ['unregistered', 'rambo_bot', 'archive_self', {}],
      ['profile-extra', 'rambo_bot', 'update_profile', { name: 'Changed', archived: true }]
    ];
    for (const [index, [callId, namespace, tool, args]] of calls.entries()) {
      runtime.emit('serverRequest', {
        id: 90 + index, method: 'item/tool/call',
        params: { threadId, turnId: 'self-boundary', callId, namespace, tool, arguments: args }
      });
      await waitFor(() => runtime.responses.length === index + 1);
      assert.equal(runtime.responses[index].result.success, false, `${tool} 必须拒绝`);
    }

    runtime.emit('serverRequest', {
      id: 99, method: 'item/tool/call',
      params: {
        threadId, turnId: 'self-boundary', callId: 'own-memory-delete',
        namespace: 'rambo_memories', tool: 'delete_memory', arguments: { id: firstPrivate.id }
      }
    });
    await waitFor(() => runtime.responses.length === 6);
    assert.equal(runtime.responses[5].result.success, true);
    assert.deepEqual(store.memories(first.bot.id), []);
    assert.equal(store.memories(second.bot.id)[0].id, secondPrivate.id);
    assert.equal(store.memories(null)[0].id, shared.id);
    assert.equal(store.routine(otherRoutine.id).status, 'active');
    assert.equal(store.bot(first.bot.id).name, 'Scoped Bot');
    assert.equal(store.bot(first.bot.id).archived, false);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'self-boundary' } });
    await sending;
  });
});

test('Bot Routine tools update, pause, resume and delete only its own definitions without scheduling', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Routine Bot', 'a');
    const second = store.createBot('Other Bot', 'b');
    const routine = store.createRoutine({
      botId: first.bot.id, title: 'Daily', instruction: 'Initial',
      schedule: '每天 09:00', sourceCallId: 'fixture-self-routine'
    });
    const threadId = 'self-routine-thread';
    store.bindThread(first.chat.id, threadId, true, true);
    host.threadChats.set(threadId, first.chat.id);

    const sending = host.send(first.chat.id, '管理自己的 Routine。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    emitTurnStarted(runtime, threadId, 'self-routine');
    const calls = [
      ['update_routine', { id: routine.id, title: 'Updated', instruction: 'Changed only future runs', schedule: '每周一 10:30' }],
      ['set_routine_status', { id: routine.id, status: 'paused' }],
      ['set_routine_status', { id: routine.id, status: 'active' }],
      ['delete_routine', { id: routine.id }]
    ];
    for (const [index, [tool, args]] of calls.entries()) {
      runtime.emit('serverRequest', {
        id: 110 + index, method: 'item/tool/call',
        params: {
          threadId, turnId: 'self-routine', callId: `self-routine-${index}`,
          namespace: 'rambo_routines', tool, arguments: args
        }
      });
      await waitFor(() => runtime.responses.length === index + 1);
      assert.equal(runtime.responses[index].result.success, true, runtime.responses[index].result.contentItems?.[0]?.text);
      if (tool === 'update_routine') {
        assert.equal(store.routine(routine.id).title, 'Updated');
        assert.equal(store.routine(routine.id).definition.instruction, 'Changed only future runs');
        assert.equal(store.routine(routine.id).definition.schedule, '每周一 10:30');
      }
      if (tool === 'set_routine_status' && index === 1) assert.equal(store.routine(routine.id).status, 'paused');
      if (tool === 'set_routine_status' && index === 2) assert.equal(store.routine(routine.id).status, 'active');
    }
    assert.throws(() => store.routine(routine.id), /定时任务不存在/);
    assert.equal(store.bot(first.bot.id).id, first.bot.id);
    assert.equal(store.bot(second.bot.id).id, second.bot.id);
    assert.equal(runtime.requests.some(request => request.method.includes('schedule')), false);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'self-routine' } });
    await sending;
  });
});

test('Routine tools cancel pending runs while keeping running work and cross-Bot scope intact', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Pending Tool Bot', 'a');
    const second = store.createBot('Other Routine Bot', 'b');
    const routine = store.createRoutine({
      botId: first.bot.id, title: 'Pending tool boundary', instruction: '检查排队边界',
      schedule: '每天 09:00', sourceCallId: 'pending-tool-boundary'
    });
    const otherRoutine = store.createRoutine({
      botId: second.bot.id, title: 'Other pending boundary', instruction: '不应被修改',
      schedule: '每天 10:00', sourceCallId: 'other-pending-boundary'
    });
    const pending = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-22T01:00:00.000Z',
      trigger: 'schedule', status: 'pending'
    });
    const running = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-22T00:00:00.000Z',
      trigger: 'schedule', status: 'running'
    });
    const otherPending = store.createRoutineRun({
      routineId: otherRoutine.id, scheduledFor: '2026-10-22T01:00:00.000Z',
      trigger: 'schedule', status: 'pending'
    });
    const threadId = 'pending-tool-thread';
    store.bindThread(first.chat.id, threadId, true, true);
    host.threadChats.set(threadId, first.chat.id);

    const sending = host.send(first.chat.id, '暂停并删除自己的 Routine。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    emitTurnStarted(runtime, threadId, 'pending-tool-turn');
    const calls = [
      ['set_routine_status', { id: routine.id, status: 'paused' }, pending.id],
      ['delete_routine', { id: routine.id }, pending.id],
      ['set_routine_status', { id: otherRoutine.id, status: 'paused' }, otherPending.id]
    ];
    for (const [index, [tool, args, expectedPendingId]] of calls.entries()) {
      runtime.emit('serverRequest', {
        id: 130 + index, method: 'item/tool/call',
        params: {
          threadId, turnId: 'pending-tool-turn', callId: `pending-tool-${index}`,
          namespace: 'rambo_routines', tool, arguments: args
        }
      });
      await waitFor(() => runtime.responses.length === index + 1);
      if (index < 2) {
        assert.equal(runtime.responses[index].result.success, true);
        assert.equal(store.routineRun(expectedPendingId).status, 'interrupted');
        assert.equal(store.routineRun(running.id).status, 'running');
      } else {
        assert.equal(runtime.responses[index].result.success, false);
        assert.equal(store.routineRun(otherPending.id).status, 'pending');
        assert.equal(store.routine(otherRoutine.id).status, 'active');
      }
    }
    assert.throws(() => store.routine(routine.id), /定时任务不存在/);
    assert.equal(store.routineRun(running.id).status, 'running');
    assert.equal(store.routineRun(running.id).completedAt, null);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'pending-tool-turn' } });
    await sending;
  });
});

test('turn notifications can complete before turn/start response without reviving the turn', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { bot } = store.createBot('Assistant', 'a');
    store.updateBot(bot.id, { model: 'bot-model', permission: 'workspaceWrite' });
    const chat = store.ensureBotChat(bot.id);
    store.updateChat(chat.id, { model: 'chat-model', permission: 'readOnly' });

    const sending = host.send(chat.id, 'first message');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    assert.equal('dynamicTools' in threadStart.params, true);
    assert.equal(start.params.model, 'chat-model');
    assert.equal(start.params.approvalPolicy, 'on-request');
    assert.deepEqual(start.params.sandboxPolicy, { type: 'readOnly' });
    assert.deepEqual({ ...threadStart.params.config.mcp_servers }, { localServer: { enabled: false } });
    assert.deepEqual(threadStart.params.config.features, { apps: false, plugins: false });
    assert.equal(JSON.stringify(threadStart.params.config).includes('must-not-forward'), false);

    const threadId = store.chat(chat.id).threadId;
    assert.equal(typeof threadId, 'string');
    runtime.emit('notification', 'turn/started', {
      threadId, turn: { id: 'turn-1', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) }
    });
    runtime.emit('notification', 'model/rerouted', {
      threadId, turnId: 'turn-1', fromModel: 'chat-model', toModel: 'rerouted-model', reason: 'highRiskCyberActivity'
    });
    runtime.emit('notification', 'turn/completed', {
      threadId, turn: { id: 'turn-1', status: 'completed' }
    });
    runtime.emit('notification', 'turn/started', {
      threadId, turn: { id: 'turn-1', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) }
    });
    start.resolve({ turn: { id: 'turn-1', status: 'inProgress' } });
    await sending;

    const [turn] = store.turns(chat.id);
    assert.equal(turn.status, 'completed');
    assert.equal(turn.requestedModel, 'chat-model');
    assert.equal(turn.serverResolvedModel, 'rerouted-model');
    assert.equal(turn.serverResolvedProvider, null);
    assert.equal(turn.resolutionSource, 'modelRerouted');
    assert.equal(turn.threadModelAtRequest, 'thread-response-model');
    assert.equal(turn.threadModelProviderAtRequest, 'thread-response-provider');
    assert.equal(host.activeTurns.has(chat.id), false);
    assert.ok(events.some(event => event.type === 'turnMetadata' && event.chatId === chat.id));
  });
});

test('global config model is the requested model, while thread response stays separate evidence', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { chat } = store.createBot('Assistant', 'a');
    const sending = host.send(chat.id, 'use global default');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(start.params.model, 'local-global-model');
    assert.equal(runtime.requests.some(request => request.method === 'model/list'), false);
    start.resolve({ turn: { id: 'turn-global', status: 'inProgress' } });
    await sending;

    const [turn] = store.turns(chat.id);
    assert.equal(turn.modelSource, 'global');
    assert.equal(turn.requestedModel, 'local-global-model');
    assert.equal(turn.threadModelAtRequest, 'thread-response-model');
    assert.equal(turn.serverResolvedModel, null);
    assert.equal(turn.resolutionSource, 'unknown');
  });
});

test('a running turn keeps its model and permission while steering uses the next turn configuration', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot } = store.createBot('Configuration snapshot', 'a');
    store.updateBot(bot.id, { model: 'bot-default-old', permission: 'workspaceWrite' });
    const chat = store.ensureBotChat(bot.id);
    const sending = host.send(chat.id, 'start with old configuration');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const firstStart = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(firstStart.params.model, 'bot-default-old');
    assert.deepEqual(firstStart.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [join(store.directory, 'bots', bot.id, 'workspace')],
      networkAccess: true
    });
    firstStart.resolve({ turn: { id: 'turn-config-old', status: 'inProgress' } });
    await sending;

    store.updateBot(bot.id, { model: 'bot-default-new', permission: 'readOnly' });
    store.updateChat(chat.id, { model: 'chat-new', permission: 'fullAccess' });
    const steering = host.send(chat.id, 'change direction while running');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/steer'));
    const steer = runtime.requests.find(request => request.method === 'turn/steer');
    assert.equal('model' in steer.params, false);
    assert.equal('approvalPolicy' in steer.params, false);
    assert.equal('sandboxPolicy' in steer.params, false);
    await steering;
    assert.equal(store.turns(chat.id)[0].requestedModel, 'bot-default-old');
    assert.equal(store.turns(chat.id)[0].permissionSnapshot.permission, 'workspaceWrite');

    runtime.emit('notification', 'turn/completed', {
      threadId: store.chat(chat.id).threadId,
      turn: { id: 'turn-config-old', status: 'completed' }
    });
    const next = host.send(chat.id, 'start with new configuration');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const nextStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.equal(nextStart.params.model, 'chat-new');
    assert.deepEqual(nextStart.params.sandboxPolicy, { type: 'dangerFullAccess' });
    assert.equal(nextStart.params.approvalPolicy, 'never');
    nextStart.resolve({ turn: { id: 'turn-config-new', status: 'inProgress' } });
    await next;

    const turns = store.turns(chat.id);
    assert.equal(turns[1].requestedModel, 'chat-new');
    assert.equal(turns[1].permissionSnapshot.permission, 'fullAccess');
  });
});

test('Routine execution is isolated from the Bot private chat and only writes a source-chat brief', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Routine isolation', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Private context isolation', instruction: '生成隔离报告',
      schedule: '每天 09:00', sourceCallId: 'routine-isolation'
    });
    const runNow = host.routineScheduler.runNow(routine.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const running = store.routineRuns(routine.id)[0];

    const executionChat = store.chats().find(item => item.botId === bot.id && item.id !== chat.id) ??
      store.botChats(bot.id).find(item => item.routineRunId === running.id);
    assert.ok(executionChat);
    assert.notEqual(running.chatId ?? executionChat.id, chat.id);
    assert.equal(running.sourceChatId, chat.id);
    assert.equal(executionChat.routineRunId, running.id);
    assert.equal(executionChat.botId, bot.id);
    assert.equal(store.chats().some(item => item.id === executionChat.id), false);
    store.addMessage(executionChat.id, 'assistant', '内部完整过程：隔离报告');
    assert.equal(store.search('隔离报告', bot.id).some(result => result.chat.id === executionChat.id), false);

    const turnStart = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(turnStart.params.threadId, executionChat.threadId);
    assert.equal(store.chat(chat.id).threadId, null);
    assert.deepEqual(
      Object.keys(turnStart.params.additionalContext).sort(),
      ['rambo.profile-rules', 'rambo.routine-context'].sort()
    );
    turnStart.resolve({ turn: { id: 'routine-isolated-turn', status: 'inProgress' } });
    await runNow;

    emitTurnStarted(runtime, executionChat.threadId, 'routine-isolated-turn');
    runtime.emit('notification', 'item/completed', {
      threadId: executionChat.threadId,
      turnId: 'routine-isolated-turn',
      item: { id: 'routine-isolated-result', type: 'agentMessage', text: '隔离报告已完成。' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: executionChat.threadId,
      turn: { id: 'routine-isolated-turn', status: 'completed', error: null }
    });

    await waitFor(() => store.routineRun(running.id).status === 'succeeded');
    assert.equal(store.messages(chat.id).filter(message => message.role === 'system').length, 1);
    assert.match(store.messages(chat.id).find(message => message.role === 'system').text, /隔离报告已完成/u);
    assert.equal(store.messages(chat.id).some(message => message.text === '生成隔离报告'), false);
  });
});

test('Routine context includes only the bounded last brief when the discipline enables it', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Routine context', 'a');
    const disabled = store.createRoutine({
      botId: bot.id, title: 'Without previous brief', instruction: '生成当前结果',
      schedule: '每天 08:00', sourceCallId: 'routine-context-disabled'
    });
    const previous = store.createRoutineRun({
      routineId: disabled.id, scheduledFor: '2026-10-21T00:00:00.000Z',
      trigger: 'schedule', status: 'succeeded'
    });
    store.updateRoutineRun(previous.id, {
      summary: '上一轮报告'.repeat(600), completedAt: '2026-10-21T00:01:00.000Z'
    });
    store.updateRoutine(disabled.id, { rememberLastResult: false });

    const disabledRunPromise = host.routineScheduler.runNow(disabled.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const disabledStart = runtime.requests.filter(request => request.method === 'turn/start')[0];
    assert.equal(
      disabledStart.params.additionalContext?.['rambo.routine-context']?.value.includes('上一次运行的简短结果：') ?? false,
      false
    );
    disabledStart.resolve({ turn: { id: 'routine-context-disabled-turn', status: 'inProgress' } });
    await disabledRunPromise;

    const enabled = store.createRoutine({
      botId: bot.id, title: 'With previous brief', instruction: '生成下一次结果',
      schedule: '每天 09:00', sourceCallId: 'routine-context-enabled',
      rememberLastResult: true
    });
    const previousForEnabled = store.createRoutineRun({
      routineId: enabled.id, scheduledFor: '2026-10-21T01:00:00.000Z',
      trigger: 'schedule', status: 'succeeded'
    });
    const oversized = '上一轮简报'.repeat(1_000);
    store.updateRoutineRun(previousForEnabled.id, {
      summary: oversized, completedAt: '2026-10-21T01:01:00.000Z'
    });

    const enabledRunPromise = host.routineScheduler.runNow(enabled.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const enabledStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    const contextValue = enabledStart.params.additionalContext?.['rambo.routine-context']?.value;
    assert.equal(typeof contextValue, 'string');
    assert.match(contextValue, /上一次运行的简短结果：/u);
    const brief = contextValue.split('上一次运行的简短结果：')[1]?.split('\n\n')[0] ?? '';
    assert.equal(brief.length, 2_000);
    assert.equal(brief, oversized.slice(0, 2_000));
    assert.equal(store.messages(chat.id).some(message => message.text === oversized), false);
    enabledStart.resolve({ turn: { id: 'routine-context-enabled-turn', status: 'inProgress' } });
    await enabledRunPromise;
  });
});

test('stop is a separate host action from steering a running turn', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { chat } = store.createBot('Steering and stop', 'a');
    const sending = host.send(chat.id, 'start a long turn');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'turn-long', status: 'inProgress' } });
    await sending;

    const steering = host.send(chat.id, 'refine the current request');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/steer'));
    const steer = runtime.requests.find(request => request.method === 'turn/steer');
    assert.equal(steer.params.expectedTurnId, 'turn-long');
    assert.equal(runtime.requests.some(request => request.method === 'turn/interrupt'), false);
    await steering;

    const threadId = store.chat(chat.id).threadId;
    await host.interrupt(chat.id);
    const interrupt = runtime.requests.find(request => request.method === 'turn/interrupt');
    assert.deepEqual(interrupt.params, { threadId, turnId: 'turn-long' });
    assert.equal(host.activeTurns.get(chat.id), 'turn-long');

    runtime.emit('notification', 'turn/completed', {
      threadId, turn: { id: 'turn-long', status: 'interrupted' }
    });
    assert.equal(host.activeTurns.has(chat.id), false);
    assert.equal(store.turns(chat.id)[0].status, 'interrupted');
  });
});

test('stopping one Routine run interrupts only its execution chat and records an honest terminal state', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot } = store.createBot('Stoppable Routine', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Stop one run', instruction: '运行到用户停止',
      schedule: '每天 09:00', sourceCallId: 'stop-one-run'
    });
    const other = store.createRoutine({
      botId: bot.id, title: 'Independent run', instruction: '不受停止影响',
      schedule: '每天 10:00', sourceCallId: 'independent-run'
    });
    const firstRunPromise = host.routineScheduler.runNow(routine.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const firstStart = runtime.requests.filter(request => request.method === 'turn/start')[0];
    firstStart.resolve({ turn: { id: 'stop-one-run-turn', status: 'inProgress' } });
    await firstRunPromise;
    const run = store.routineRuns(routine.id).find(item => item.trigger === 'manual');
    assert.equal(run.status, 'running');
    assert.equal(typeof run.chatId, 'string');
    const executionChat = store.chat(run.chatId);
    const sourceChat = store.chat(routine.sourceChatId);
    assert.notEqual(executionChat.id, sourceChat.id);

    const secondRunPromise = host.routineScheduler.runNow(other.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const secondStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    secondStart.resolve({ turn: { id: 'independent-run-turn', status: 'inProgress' } });
    await secondRunPromise;

    const stopped = await host.stopRoutineRun(run.id);
    assert.equal(stopped.status, 'interrupted');
    assert.match(stopped.error ?? '', /用户停止/u);
    assert.deepEqual(
      runtime.requests.filter(request => request.method === 'turn/interrupt').map(request => request.params),
      [{ threadId: executionChat.threadId, turnId: 'stop-one-run-turn' }]
    );
    assert.equal(
      store.messages(sourceChat.id).some(message => message.role === 'system' && /已中断/u.test(message.text)),
      true
    );
    assert.equal(host.activeTurns.get(executionChat.id), 'stop-one-run-turn');
    assert.equal(store.routineRuns(other.id)[0].status, 'running');
    assert.equal(host.activeTurns.get(store.routineRuns(other.id)[0].chatId), 'independent-run-turn');
  });
});

test('Routine ownership is queryable by Bot and scoped in the snapshot', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('A', 'a');
    const second = store.createBot('B', 'b');
    const sending = host.send(second.chat.id, '每个工作日 09:00 整理一次工作清单。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    const threadId = store.chat(second.chat.id).threadId;
    runtime.emit('serverRequest', {
      id: 91,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'routine-owner',
        callId: 'routine-owner-call',
        namespace: 'rambo_routines',
        tool: 'create_routine',
        arguments: {
          title: 'B checklist',
          instruction: '整理工作清单',
          schedule: '每个工作日',
          triggerTime: '09:00', kind: 'recurring'
        }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    start.resolve({ turn: { id: 'routine-owner' } });
    await sending;

    const [routine] = store.routines();
    assert.equal(routine.botId, second.bot.id);
    assert.equal(store.routines().filter(item => item.botId === first.bot.id).length, 0);
    assert.equal(host.snapshot().routines.filter(item => item.botId === second.bot.id).length, 1);
  });
});

test('Routine results are associated with the exact completed turn, not an older assistant message', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Result Bot', 'a');
    const now = new Date('2026-10-22T01:00:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Exact result', instruction: '生成精确结果',
      schedule: '每天', time: '09:30', sourceCallId: 'exact-result', now
    });
    const running = host.routineScheduler.runNow(routine.id);
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    const threadId = start.params.threadId;
    const turnId = 'exact-result-turn';
    start.resolve({ turn: { id: turnId, status: 'inProgress' } });
    await running;

    store.assistantItem(chat.id, 'old-assistant', '旧轮次的助手消息', false, 'complete');
    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId,
      item: { id: 'current-assistant', type: 'agentMessage', text: '当前 Routine 的精确结果' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed', error: null }
    });

    const [run] = store.routineRuns(routine.id);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.summary, '当前 Routine 的精确结果');
    assert.notEqual(run.summary, '旧轮次的助手消息');
  });
});

test('runtime disconnect persists an unknown turn and blocks send until history confirms it', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot } = store.createBot('Assistant', 'a');
    store.updateBot(bot.id, { model: 'chat-model' });
    const chat = store.chats()[0];
    const sending = host.send(chat.id, 'start a turn');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'turn-active', status: 'inProgress' } });
    await sending;

    runtime.state = { status: 'error', version: '0.163.0', error: 'connection lost' };
    runtime.emit('state', runtime.state);
    assert.equal(store.turns(chat.id)[0].status, 'unknown');
    assert.equal(store.unknownTurnOperations().length, 1);

    runtime.state = { status: 'ready', version: '0.163.0', error: null };
    runtime.turnList = [];
    const before = runtime.requests.length;
    await assert.rejects(host.send(chat.id, 'must wait'), /无法在 Codex 历史中核对上一轮/);
    assert.equal(runtime.requests.slice(before).some(request => request.method === 'turn/start' || request.method === 'turn/steer'), false);

    runtime.turnList = [{ id: 'turn-active', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) }];
    await host.send(chat.id, 'continue after reconciliation');
    const steer = runtime.requests.filter(request => request.method === 'turn/steer').at(-1);
    assert.equal(steer.params.expectedTurnId, 'turn-active');
    assert.equal('model' in steer.params, false);
    assert.equal('approvalPolicy' in steer.params, false);
    assert.equal('sandboxPolicy' in steer.params, false);
    assert.equal(store.unknownTurnOperations().length, 0);
  });
});

test('explicit group mention sends through that Bot group thread and streams its reply to the shared timeline', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('Project room', [first.bot.id, second.bot.id]);
    store.addMessage(second.chat.id, 'user', 'private-only marker');
    store.addGroupMessage(group.id, 'assistant', 'shared group context marker', { senderBot: first.bot });
    const memberChat = store.groupMemberChats(group.id).find(chat => chat.botId === second.bot.id);
    assert.ok(memberChat);
    store.updateChat(memberChat.id, { model: 'writer-group-model', permission: 'readOnly' });
    const sending = host.sendGroup(group.id, '@Writer draft a short summary');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    const memberSession = store.groupSessions().find(session => session.groupId === group.id && session.botId === second.bot.id && session.purpose === 'member');
    assert.ok(memberSession);
    assert.deepEqual(
      threadStart.params.dynamicTools.map(tool => tool.name),
      ['rambo_group_history']
    );
    assert.equal(start.params.threadId, store.chat(memberSession.chatId).threadId);
    assert.equal(start.params.model, 'writer-group-model');
    assert.equal(start.params.sandboxPolicy.type, 'readOnly');
    assert.equal(start.params.approvalPolicy, 'on-request');
    assert.equal(store.bot(second.bot.id).model, null);
    assert.equal(store.bot(second.bot.id).permission, 'fullAccess');
    assert.match(start.params.input[0].text, /shared group context marker/);
    assert.equal(start.params.input[0].text.includes('private-only marker'), false);
    assert.equal(store.groupSessions().some(session => session.groupId === group.id && session.purpose === 'router'), false);
    assert.equal(store.chat(second.chat.id).threadId, null);
    assert.equal(store.chats().length, 2);

    start.resolve({ turn: { id: 'group-turn-direct', status: 'inProgress' } });
    await sending;
    const threadId = start.params.threadId;
    runtime.emit('notification', 'item/completed', {
      threadId, item: { id: 'group-answer-1', type: 'agentMessage', text: 'A concise summary.' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId, turn: { id: 'group-turn-direct', status: 'completed' }
    });

    const messages = store.groupMessages(group.id);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].text, 'shared group context marker');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].text, '@Writer draft a short summary');
    assert.equal(messages[2].role, 'assistant');
    assert.equal(messages[2].senderBotId, second.bot.id);
    assert.equal(messages[2].senderName, 'Writer');
    assert.equal(messages[2].text, 'A concise summary.');
    assert.ok(events.some(event => event.type === 'groupMessage' && event.message.senderBotId === second.bot.id));
  });
});

test('ordinary group messages let every active Bot judge independently without a router or default fallback', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    store.updateBot(first.bot.id, { role: 'researches source material' });
    store.updateBot(second.bot.id, { role: 'writes concise summaries' });
    store.saveMemory({ botId: first.bot.id, text: 'Private Bot memory must not enter group context.' });
    const group = store.createGroup('Project room', [first.bot.id, second.bot.id]);
    // Even a legacy default Bot value must not choose a responder for ordinary messages.
    store.db.prepare('UPDATE group_chats SET defaultBotId=? WHERE id=?').run(first.bot.id, group.id);
    store.addMessage(first.chat.id, 'user', 'private-only content');
    const sending = host.sendGroup(group.id, 'Please prepare a technical summary.');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    const sessions = store.groupSessions().filter(session => session.groupId === group.id);
    assert.equal(starts.length, 2);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map(session => session.purpose), ['member', 'member']);
    assert.deepEqual(new Set(sessions.map(session => session.botId)), new Set([first.bot.id, second.bot.id]));
    assert.equal(sessions.some(session => session.purpose === 'router'), false);
    assert.equal(store.group(group.id).defaultBotId, first.bot.id);
    assert.equal(store.chats().some(chat => chat.groupChatId === group.id), false);
    assert.ok(starts.every(start => !('rambo.bot-memory' in start.params.additionalContext)));
    assert.ok(starts.every(start => !JSON.stringify(start.params.additionalContext).includes('Private Bot memory')));
    const threadIds = starts.map(start => start.params.threadId);
    assert.equal(new Set(threadIds).size, 2);
    const prompts = starts.map(start => start.params.input[0].text);
    const botProfiles = starts.map(start => start.params.additionalContext['rambo.bot-profile'].value);
    assert.ok(botProfiles.some(prompt => prompt.includes('Researcher') && prompt.includes('researches source material')), JSON.stringify(botProfiles));
    assert.ok(botProfiles.some(prompt => prompt.includes('Writer') && prompt.includes('writes concise summaries')), JSON.stringify(botProfiles));
    assert.ok(prompts.every(prompt => prompt.includes('independently') || prompt.includes('独立判断')));
    assert.ok(prompts.every(prompt => !prompt.includes('private-only content')));
    const threadStarts = runtime.requests.filter(request => request.method === 'thread/start');
    assert.ok(threadStarts.every(start => start.params.developerInstructions.includes('[[RAMBO_NO_GROUP_REPLY]]')));
    assert.ok(threadStarts.every(start => start.params.developerInstructions.includes('成员独立判断')));
    starts.forEach((start, index) => start.resolve({ turn: { id: `independent-${index}`, status: 'inProgress' } }));
    await sending;

    for (const [index, start] of starts.entries()) {
      runtime.emit('notification', 'item/completed', {
        threadId: start.params.threadId,
        item: { id: `independent-answer-${index}`, type: 'agentMessage', text: index === 0 ? '[[RAMBO_NO_GROUP_REPLY]]' : 'I can prepare the technical summary.' }
      });
      runtime.emit('notification', 'turn/completed', {
        threadId: start.params.threadId, turn: { id: `independent-${index}`, status: 'completed' }
      });
    }
    assert.deepEqual(store.groupMessages(group.id).map(message => message.text), [
      'Please prepare a technical summary.', 'I can prepare the technical summary.'
    ]);
    assert.equal(store.groupMessages(group.id).some(message => message.text.includes('RAMBO_NO_GROUP_REPLY')), false);
  });
});

test('each ordinary group Bot receives bounded recent group context and the latest user message', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('Project room', [first.bot.id, second.bot.id]);
    store.addGroupMessage(group.id, 'user', 'outside-count-window marker');
    store.addGroupMessage(group.id, 'assistant', `outside-character-window marker ${'x'.repeat(13_000)}`, { senderBot: first.bot });
    store.addGroupMessage(group.id, 'assistant', 'recent-context-marker', { senderBot: first.bot });
    for (let index = 0; index < 37; index++) {
      store.addGroupMessage(group.id, 'assistant', `recent filler ${index}`, { senderBot: first.bot });
    }

    const latestUserMessage = 'latest-user-message-must-remain';
    const sending = host.sendGroup(group.id, latestUserMessage);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    const prompts = starts.map(start => start.params.input[0].text);
    for (const prompt of prompts) {
      const context = prompt.slice(prompt.indexOf('\n\n') + 2);
      assert.ok(context.length <= 12_000);
      assert.equal(prompt.includes('outside-count-window marker'), false);
      assert.equal(prompt.includes('outside-character-window marker'), false);
      assert.ok(prompt.includes('recent-context-marker'));
      assert.ok(prompt.includes(latestUserMessage));
    }
    starts.forEach((start, index) => start.resolve({ turn: { id: `bounded-member-${index}`, status: 'inProgress' } }));
    await sending;
  });
});

test('a group member can read older current-group history on demand without private chats', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('History room', [first.bot.id, second.bot.id]);
    store.addMessage(first.chat.id, 'user', 'PRIVATE-MUST-NOT-LEAK');
    const earlier = store.addGroupMessage(
      group.id,
      'user',
      'OLDER-GROUP-MARKER before this Bot joined the conversation'
    );
    const otherGroup = store.createGroup('Other room', [first.bot.id, second.bot.id]);
    store.addGroupMessage(otherGroup.id, 'user', 'OTHER-GROUP-MUST-NOT-LEAK');
    for (let index = 0; index < 45; index++) {
      store.addGroupMessage(group.id, 'user', `recent history filler ${index}`);
    }

    const sending = host.sendGroup(group.id, '@Writer recall the older project decision');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    const historyTool = threadStart.params.dynamicTools.find(
      tool => tool.name === 'rambo_group_history'
    );
    assert.ok(historyTool);
    assert.deepEqual(historyTool.tools.map(tool => tool.name), ['read_history']);
    assert.equal(start.params.input[0].text.includes('OLDER-GROUP-MARKER'), false);

    runtime.emit('serverRequest', {
      id: 90,
      method: 'item/tool/call',
      params: {
        threadId: start.params.threadId,
        turnId: 'group-history',
        callId: 'group-history-call',
        namespace: 'rambo_group_history',
        tool: 'read_history',
        arguments: { query: 'OLDER-GROUP-MARKER', limit: 5 }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    const response = runtime.responses[0].result.contentItems[0].text;
    assert.match(response, /OLDER-GROUP-MARKER/);
    assert.match(response, new RegExp(earlier.id));
    assert.equal(response.includes('PRIVATE-MUST-NOT-LEAK'), false);
    assert.equal(response.includes('OTHER-GROUP-MUST-NOT-LEAK'), false);

    runtime.emit('serverRequest', {
      id: 91,
      method: 'item/tool/call',
      params: {
        threadId: start.params.threadId,
        turnId: 'group-history',
        callId: 'group-history-invalid-boundary',
        namespace: 'rambo_group_history',
        tool: 'read_history',
        arguments: { before: 'message-from-another-group' }
      }
    });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, false);
    assert.match(runtime.responses[1].result.contentItems[0].text, /不属于当前群/);

    start.resolve({ turn: { id: 'group-history', status: 'inProgress' } });
    await sending;
  });
});

test('a Bot added after a conversation can retrieve shared older history without private chat leakage', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const newcomer = store.createBot('Newcomer', 'c');
    const group = store.createGroup('Growing room', [first.bot.id, second.bot.id]);
    store.addMessage(newcomer.chat.id, 'user', 'NEWCOMER-PRIVATE-MUST-NOT-LEAK');
    const original = store.addGroupMessage(
      group.id,
      'user',
      'JOIN-BEFORE-MARKER choose PostgreSQL for the shared local project'
    );
    for (let index = 0; index < 45; index++) {
      store.addGroupMessage(group.id, 'user', `newer shared filler ${index}`);
    }
    const expanded = store.addGroupMembers(group.id, [newcomer.bot.id]);
    assert.deepEqual(expanded.memberIds, [first.bot.id, second.bot.id, newcomer.bot.id]);

    const sending = host.sendGroup(group.id, '@Newcomer what database was chosen before you joined?');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const memberSession = store.groupSession(group.id, newcomer.bot.id);
    const start = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(start.params.threadId, memberSession.threadId);
    assert.notEqual(start.params.threadId, store.chat(newcomer.chat.id).threadId);
    assert.equal(start.params.input[0].text.includes('JOIN-BEFORE-MARKER'), false);
    assert.equal(start.params.input[0].text.includes('NEWCOMER-PRIVATE-MUST-NOT-LEAK'), false);

    runtime.emit('serverRequest', {
      id: 92,
      method: 'item/tool/call',
      params: {
        threadId: start.params.threadId,
        turnId: 'newcomer-history',
        callId: 'newcomer-history-call',
        namespace: 'rambo_group_history',
        tool: 'read_history',
        arguments: { query: 'JOIN-BEFORE-MARKER', limit: 5 }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    const response = runtime.responses[0].result.contentItems[0].text;
    assert.match(response, /JOIN-BEFORE-MARKER/);
    assert.match(response, new RegExp(original.id));
    assert.equal(response.includes('NEWCOMER-PRIVATE-MUST-NOT-LEAK'), false);

    const memberThreadStart = runtime.requests
      .filter(request => request.method === 'thread/start')
      .find(request => request.params.dynamicTools?.some(tool => tool.name === 'rambo_group_history'));
    const historyTool = memberThreadStart?.params.dynamicTools
      ?.find(tool => tool.name === 'rambo_group_history');
    assert.ok(historyTool);
    assert.deepEqual(historyTool.tools.map(tool => tool.name), ['read_history']);

    start.resolve({ turn: { id: 'newcomer-history' } });
    await sending;
  });
});

test('@everyone dispatches to every active group member without invoking the router', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    store.updateBot(first.bot.id, { role: 'handles local plant care only' });
    const archived = store.createBot('Archived', 'c');
    const group = store.createGroup('Project room', [first.bot.id, second.bot.id, archived.bot.id]);
    store.setBotArchived(archived.bot.id, true);
    const sending = host.sendGroup(group.id, '@everyone please each provide a short view with marker EVERYONE-MEMBER-REPLY-7C9M');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    assert.equal(store.groupSessions().filter(session => session.groupId === group.id && session.purpose === 'member').length, 2);
    assert.equal(store.groupSessions().some(session => session.groupId === group.id && session.botId === archived.bot.id), false);
    assert.equal(store.groupSessions().some(session => session.groupId === group.id && session.purpose === 'router'), false);
    assert.ok(starts.every(start => start.params.input[0].text.includes('本轮是 @everyone 全员响应模式')));
    assert.ok(starts.every(start => start.params.input[0].text.includes('必须以自己的 Bot 身份回复')));
    assert.ok(starts.every(start => start.params.input[0].text.includes('不得输出内部不回复标记')));
    assert.ok(starts.every(start => !start.params.input[0].text.includes('[[RAMBO_NO_GROUP_REPLY]]')));
    starts.forEach((start, index) => start.resolve({ turn: { id: `everyone-${index}`, status: 'inProgress' } }));
    await sending;

    runtime.emit('notification', 'item/completed', {
      threadId: starts[0].params.threadId,
      item: { id: 'everyone-no-reply', type: 'agentMessage', text: '[[RAMBO_NO_GROUP_REPLY]]' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: starts[0].params.threadId, turn: { id: 'everyone-0', status: 'completed' }
    });
    runtime.emit('notification', 'item/completed', {
      threadId: starts[1].params.threadId,
      item: { id: 'everyone-reply', type: 'agentMessage', text: 'EVERYONE-MEMBER-REPLY-7C9M' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: starts[1].params.threadId, turn: { id: 'everyone-1', status: 'completed' }
    });

    const messages = store.groupMessages(group.id);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'system');
    assert.equal(messages[1].status, 'failed');
    assert.match(messages[1].text, /Researcher/);
    assert.match(messages[1].text, /未能生成正式回复/);
    assert.equal(messages[1].text.includes('RAMBO_NO_GROUP_REPLY'), false);
    assert.equal(messages[2].role, 'assistant');
    assert.equal(messages[2].senderBotId, second.bot.id);
    assert.equal(messages[2].text, 'EVERYONE-MEMBER-REPLY-7C9M');
  });
});

test('@name dispatches only to the named member', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('Project room', [first.bot.id, second.bot.id]);
    const sending = host.sendGroup(group.id, '@Writer draft a summary');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const start = runtime.requests.filter(request => request.method === 'turn/start')[0];
    assert.equal(store.groupSessions().length, 1);
    assert.equal(store.groupSessions()[0].botId, second.bot.id);
    assert.equal(store.groupSessions()[0].purpose, 'member');
    assert.match(start.params.input[0].text, /Writer/);
    start.resolve({ turn: { id: 'named-only', status: 'inProgress' } });
    await sending;

    runtime.emit('notification', 'item/completed', {
      threadId: start.params.threadId,
      item: { id: 'named-no-reply', type: 'agentMessage', text: '[[RAMBO_NO_GROUP_REPLY]]' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: start.params.threadId, turn: { id: 'named-only', status: 'completed' }
    });
    const messages = store.groupMessages(group.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].text, '@Writer draft a summary');
    assert.equal(messages[1].role, 'system');
    assert.equal(messages[1].status, 'failed');
    assert.match(messages[1].text, /Writer/);
    assert.match(messages[1].text, /未能生成正式回复/);
    assert.equal(messages[1].text.includes('RAMBO_NO_GROUP_REPLY'), false);
  });
});

test('an @everyone member setup failure is published instead of swallowed by allSettled', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('Project room', [first.bot.id, second.bot.id]);
    const originalGroupSession = store.groupSession.bind(store);
    store.groupSession = (groupId, botId) => {
      if (botId === first.bot.id) throw new Error('member session unavailable');
      return originalGroupSession(groupId, botId);
    };

    const sending = host.sendGroup(group.id, '@everyone please answer independently');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'everyone-surviving-member', status: 'inProgress' } });
    await sending;

    const failure = store.groupMessages(group.id).find(message => message.role === 'system');
    assert.ok(failure);
    assert.equal(failure.status, 'failed');
    assert.match(failure.text, /Researcher/);
    assert.match(failure.text, /member session unavailable/);
  });
});
