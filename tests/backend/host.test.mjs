import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { closeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const storeSource = readFileSync(new URL('../../src/main/store.ts', import.meta.url), 'utf8');
const hostSource = readFileSync(new URL('../../src/main/host.ts', import.meta.url), 'utf8');
const chatContentToolsSource = readFileSync(new URL('../../src/main/chat-content-tools.ts', import.meta.url), 'utf8');
const contractsSource = readFileSync(new URL('../../src/shared/contracts.ts', import.meta.url), 'utf8');
const executionConfigSource = readFileSync(new URL('../../src/shared/execution-config.ts', import.meta.url), 'utf8');
const robotAvatarSource = readFileSync(new URL('../../src/shared/robot-avatar.ts', import.meta.url), 'utf8');
const connectorsSource = readFileSync(new URL('../../src/main/connectors.ts', import.meta.url), 'utf8');
const mailToolsSource = readFileSync(new URL('../../src/main/mail-tools.ts', import.meta.url), 'utf8');
const botResourcesSource = readFileSync(new URL('../../src/main/bot-resources.ts', import.meta.url), 'utf8');
const botResourceToolsSource = readFileSync(new URL('../../src/main/bot-resource-tools.ts', import.meta.url), 'utf8');
const botCredentialToolsSource = readFileSync(new URL('../../src/main/bot-credential-tools.ts', import.meta.url), 'utf8');
const botSecretToolsSource = readFileSync(new URL('../../src/main/bot-secret-tools.ts', import.meta.url), 'utf8');
const directMcpSource = readFileSync(new URL('../../src/main/direct-mcp.ts', import.meta.url), 'utf8');
const managedSkillsSource = readFileSync(new URL('../../src/main/managed-skills.ts', import.meta.url), 'utf8');
const wechatAdapterSource = readFileSync(new URL('../../src/main/wechat-adapter.ts', import.meta.url), 'utf8');
const wechatToolsSource = readFileSync(new URL('../../src/main/wechat-tools.ts', import.meta.url), 'utf8');
const scheduleSource = readFileSync(new URL('../../src/main/routine-schedule.ts', import.meta.url), 'utf8');
const schedulerSource = readFileSync(new URL('../../src/main/routine-scheduler.ts', import.meta.url), 'utf8');
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const compiledSchedule = ts.transpileModule(scheduleSource, { compilerOptions }).outputText;
const compiledStore = ts.transpileModule(storeSource, { compilerOptions }).outputText
  .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'")
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
  .replaceAll("from '../shared/robot-avatar'", "from './robot-avatar.mjs'");
const compiledScheduler = ts.transpileModule(schedulerSource, { compilerOptions }).outputText;
const compiledHost = ts.transpileModule(hostSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/execution-config'", "from './execution-config.mjs'")
  .replaceAll("from './store'", "from './store.mjs'")
  .replaceAll("from './bot-resources'", "from './bot-resources.mjs'")
  .replaceAll("from './bot-resource-tools'", "from './bot-resource-tools.mjs'")
  .replaceAll("from './bot-credential-tools'", "from './bot-credential-tools.mjs'")
  .replaceAll("from './bot-secret-tools'", "from './bot-secret-tools.mjs'")
  .replaceAll("from './direct-mcp'", "from './direct-mcp.mjs'")
  .replaceAll("from './managed-skills'", "from './managed-skills.mjs'")
  .replaceAll("from './connectors'", "from './connectors.mjs'")
  .replaceAll("from './mail-tools'", "from './mail-tools.mjs'")
  .replaceAll("from './routine-scheduler'", "from './routine-scheduler.mjs'")
  .replaceAll("from './chat-content-tools'", "from './chat-content-tools.mjs'")
  .replaceAll("from './wechat-tools'", "from './wechat-tools.mjs'")
  .replaceAll("from './wechat-adapter'", "from './wechat-adapter.mjs'");
const compiledConnectors = ts.transpileModule(connectorsSource, { compilerOptions }).outputText
  .replaceAll("from './store'", "from './store.mjs'");
const compiledExecutionConfig = ts.transpileModule(executionConfigSource, { compilerOptions }).outputText
  .replaceAll("from './contracts'", "from './contracts.mjs'");
const compiledMailTools = ts.transpileModule(mailToolsSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'");
const compiledMailRuntimeSource = readFileSync(new URL('../../src/main/mail-runtime.ts', import.meta.url), 'utf8');
const compiledMailRuntime = ts.transpileModule(compiledMailRuntimeSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
  .replaceAll("from './mail-adapter'", "from './mail-adapter.mjs'")
  .replaceAll("from './connector-credentials'", "from './connector-credentials.mjs'");
const compiledChatContentTools = ts.transpileModule(chatContentToolsSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'");
const compiledBotResources = ts.transpileModule(botResourcesSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'");
const compiledBotResourceTools = ts.transpileModule(botResourceToolsSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
  .replaceAll("from './store'", "from './store.mjs'");
const compiledBotCredentialTools = ts.transpileModule(botCredentialToolsSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'");
const compiledBotSecretTools = ts.transpileModule(botSecretToolsSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'");
const compiledDirectMcp = ts.transpileModule(directMcpSource, { compilerOptions }).outputText
  .replaceAll("from './connector-credentials'", "from './connector-credentials.mjs'")
  .replaceAll("from './store'", "from './store.mjs'");
const compiledManagedSkills = ts.transpileModule(managedSkillsSource, { compilerOptions }).outputText;
const compiledCredentialTools = readFileSync(new URL('../../src/main/connector-credentials.ts', import.meta.url), 'utf8');
const compiledWechatAdapter = ts.transpileModule(wechatAdapterSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
  .replaceAll("from './connector-credentials'", "from './connector-credentials.mjs'");
const compiledWechatTools = ts.transpileModule(wechatToolsSource, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
  .replaceAll("from './wechat-adapter'", "from './wechat-adapter.mjs'");
const compiledConnectorCredentials = ts.transpileModule(compiledCredentialTools, { compilerOptions }).outputText;
const compiledMailAdapter = ts.transpileModule(
  readFileSync(new URL('../../src/main/mail-adapter.ts', import.meta.url), 'utf8'),
  { compilerOptions }
).outputText
  .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
  .replaceAll("from './connector-credentials'", "from './connector-credentials.mjs'");

class FakeRuntime extends EventEmitter {
  state = { status: 'ready', version: '0.163.0', error: null };
  requests = [];
  responses = [];
  turnList = [];
  skills = [];
  skillsExtraRoots = null;
  failSkillRootRegistration = false;
  globalMcpServers = {
    localServer: { command: 'must-not-forward' }
  };
  deferSteer = false;
  nextThreadId = 1;

  async start() {}

  respondToServerRequest(id, result) {
    this.responses.push({ id, result });
    this.emit('acceptanceResponse', id, result);
  }

  request(method, params = {}, _timeoutMs, options) {
    const request = { method, params, options };
    this.requests.push(request);
    if (method === 'config/read') {
      return Promise.resolve({
        config: {
          model: params.cwd ? 'workspace-only-model' : 'local-global-model',
          mcp_servers: this.globalMcpServers,
          unrelated: 'must-not-forward'
        }
      });
    }
    if (method === 'skills/extraRoots/set') {
      if (this.failSkillRootRegistration) throw new Error('fixture skill root rejection');
      this.skillsExtraRoots = params.extraRoots;
      return Promise.resolve({});
    }
    if (method === 'skills/list') {
      return Promise.resolve({ data: [{ skills: this.skills, errors: [] }] });
    }
    if (method === 'thread/start') {
      const id = `thread-${this.nextThreadId++}`;
      return Promise.resolve({ thread: { id }, model: 'thread-response-model', modelProvider: 'thread-response-provider' });
    }
    if (method === 'thread/resume') {
      if ('dynamicTools' in params) throw new Error('thread/resume does not accept dynamicTools');
      return Promise.resolve({ model: 'thread-response-model', modelProvider: 'thread-response-provider' });
    }
    if (method === 'turn/start') {
      return new Promise(resolve => { request.resolve = resolve; });
    }
    if (method === 'thread/realtime/start') {
      setImmediate(() => {
        this.emit('notification', 'thread/realtime/started', {
          threadId: params.threadId, realtimeSessionId: 'realtime-test', version: 'v3'
        });
        this.emit('notification', 'thread/realtime/sdp', {
          threadId: params.threadId, sdp: 'v=0\r\n'
        });
      });
      return Promise.resolve({});
    }
    if (method === 'thread/realtime/stop') return Promise.resolve({});
    if (method === 'thread/delete') return Promise.resolve({});
    if (method === 'turn/steer') {
      if (this.deferSteer) return new Promise(resolve => { request.resolve = resolve; });
      return Promise.resolve({ turn: { id: params.expectedTurnId } });
    }
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

function installCodexConnectionFixture(runtime, mode = 'completed') {
  const threadId = 'connection-test-thread';
  const turnId = 'connection-test-turn';
  runtime.request = (method, params = {}) => {
    runtime.requests.push({ method, params });
    if (method === 'account/read') {
      return Promise.resolve({
        account: { type: 'chatgpt', email: 'fixture@example.com' }
      });
    }
    if (method === 'config/read') {
      return Promise.resolve({ config: { model: 'fixture-model' } });
    }
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: threadId } });
    }
    if (method === 'turn/start') {
      setImmediate(() => {
        if (mode === 'timeout') return;
        if (mode === 'mismatch') {
          runtime.emit('notification', 'turn/completed', {
            threadId,
            turn: { id: 'different-turn', status: 'completed', error: null }
          });
          return;
        }
        if (mode === 'failed') {
          runtime.emit('notification', 'turn/completed', {
            threadId,
            turn: {
              id: turnId,
              status: 'failed',
              error: { message: 'fixture connection failure' }
            }
          });
          return;
        }
        runtime.emit('notification', 'item/completed', {
          threadId,
          turnId,
          item: { type: 'agentMessage', id: 'connection-test-message', text: 'OK' }
        });
        runtime.emit('notification', 'turn/completed', {
          threadId,
          turn: { id: turnId, status: 'completed', error: null }
        });
      });
      return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
    }
    if (method === 'turn/interrupt' || method === 'thread/delete') {
      return Promise.resolve({});
    }
    throw new Error(`Unexpected connection test RPC: ${method}`);
  };
  return { threadId, turnId };
}

async function withHost(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-host-test-'));
  writeFileSync(join(directory, 'routine-schedule.mjs'), compiledSchedule, { mode: 0o600 });
  writeFileSync(join(directory, 'routine-scheduler.mjs'), compiledScheduler, { mode: 0o600 });
  writeFileSync(join(directory, 'contracts.mjs'), ts.transpileModule(contractsSource, { compilerOptions }).outputText, { mode: 0o600 });
  writeFileSync(join(directory, 'execution-config.mjs'), compiledExecutionConfig, { mode: 0o600 });
  writeFileSync(join(directory, 'robot-avatar.mjs'), ts.transpileModule(robotAvatarSource, { compilerOptions }).outputText, { mode: 0o600 });
  writeFileSync(join(directory, 'bot-resources.mjs'), compiledBotResources, { mode: 0o600 });
  writeFileSync(join(directory, 'bot-resource-tools.mjs'), compiledBotResourceTools, { mode: 0o600 });
  writeFileSync(join(directory, 'bot-credential-tools.mjs'), compiledBotCredentialTools, { mode: 0o600 });
  writeFileSync(join(directory, 'bot-secret-tools.mjs'), compiledBotSecretTools, { mode: 0o600 });
  writeFileSync(join(directory, 'direct-mcp.mjs'), compiledDirectMcp, { mode: 0o600 });
  writeFileSync(join(directory, 'managed-skills.mjs'), compiledManagedSkills, { mode: 0o600 });
  writeFileSync(join(directory, 'connectors.mjs'), compiledConnectors, { mode: 0o600 });
  writeFileSync(join(directory, 'mail-tools.mjs'), compiledMailTools, { mode: 0o600 });
  writeFileSync(join(directory, 'mail-adapter.mjs'), compiledMailAdapter, { mode: 0o600 });
  writeFileSync(join(directory, 'mail-runtime.mjs'), compiledMailRuntime, { mode: 0o600 });
  writeFileSync(join(directory, 'connector-credentials.mjs'), compiledConnectorCredentials, { mode: 0o600 });
  writeFileSync(join(directory, 'chat-content-tools.mjs'), compiledChatContentTools, { mode: 0o600 });
  writeFileSync(join(directory, 'wechat-adapter.mjs'), compiledWechatAdapter, { mode: 0o600 });
  writeFileSync(join(directory, 'wechat-tools.mjs'), compiledWechatTools, { mode: 0o600 });
  writeFileSync(join(directory, 'store.mjs'), compiledStore, { mode: 0o600 });
  writeFileSync(join(directory, 'host.mjs'), compiledHost, { mode: 0o600 });
  try {
    const [{ Store }, { Host }] = await Promise.all([
      import(`${pathToFileURL(join(directory, 'store.mjs')).href}?${Date.now()}`),
      import(`${pathToFileURL(join(directory, 'host.mjs')).href}?${Date.now()}`)
    ]);
    const store = new Store(directory);
    store.syncBotResources([], []);
    store.setSetting('defaultBotModel', 'test-model');
    store.setSetting('defaultBotPermission', 'fullAccess');
    let storeToClose = store;
    const runtime = new FakeRuntime();
    const events = [];
    const toolHosts = [];
    const createHost = (mailRuntime, credentials) => {
      const created = new Host(store, runtime, event => events.push(event), mailRuntime, credentials);
      toolHosts.push(created);
      return created;
    };
    const host = createHost();
    try {
      await run({
        store,
        runtime,
        host,
        events,
        Store,
        Host,
        replaceStore: next => { storeToClose = next; },
        createHost
      });
    }
    finally {
      for (const created of toolHosts) {
        try { created.dispose(); } catch { /* already disposed by a focused test */ }
      }
      storeToClose.close();
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function withCredentialHost(run) {
  await withHost(async context => {
    const verified = [];
    let adapterFactoryCalls = 0;
    const credentials = {
      records: new Map(),
      next: 0,
      save(connectionId, payload) {
        const reference = `db:${String(++this.next).padStart(8, '0')}-0000-4000-8000-000000000000`;
        this.records.set(reference, structuredClone(payload));
        return reference;
      },
      replace(reference, payload) {
        assert.equal(this.records.has(reference), true);
        this.records.set(reference, structuredClone(payload));
      },
      load(reference) {
        const value = this.records.get(reference);
        if (!value) throw new Error('missing credential');
        return structuredClone(value);
      },
      delete(reference) {
        this.records.delete(reference);
      }
    };
    const mailRuntime = new (await import(
      `${pathToFileURL(join(context.store.directory, 'mail-runtime.mjs')).href}?credential-${Date.now()}`
    )).MailRuntime({
      async adapter(connection) {
        adapterFactoryCalls += 1;
        return { verify: async () => { verified.push(connection.id); } };
      },
      async adapterForCredential(connection, credential) {
        adapterFactoryCalls += 1;
        return {
          verify: async () => {
            assert.equal(credential.kind === 'imap-password'
              ? credential.email
              : credential.email, connection.accountLabel);
            verified.push(connection.id);
          }
        };
      }
    });
    context.host.dispose();
    const credentialHost = context.createHost(mailRuntime, credentials);
    try {
      await run({
        ...context,
        host: credentialHost,
        credentials,
        verified,
        adapterFactoryCalls: () => adapterFactoryCalls
      });
    } finally { /* hosts are disposed by withHost */ }
  });
}

async function withSecretHost(run) {
  await withHost(async context => {
    const credentials = {
      records: new Map(),
      next: 0,
      save(_ownerId, payload) {
        const reference = `db:${String(++this.next).padStart(8, '0')}-0000-4000-8000-000000000000`;
        this.records.set(reference, structuredClone(payload));
        return reference;
      },
      replace(reference, payload) {
        assert.equal(this.records.has(reference), true);
        this.records.set(reference, structuredClone(payload));
      },
      load(reference) {
        const value = this.records.get(reference);
        if (!value) throw new Error('missing credential');
        return structuredClone(value);
      },
      delete(reference) {
        this.records.delete(reference);
      }
    };
    context.host.dispose();
    const secretHost = context.createHost(undefined, credentials);
    await run({ ...context, host: secretHost, credentials, createHost: context.createHost });
  });
}

test('ChatGPT login requires the App Server to return a valid HTTPS URL', async () => {
  await withHost(async ({ runtime, host }) => {
    runtime.request = async method => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgpt',
          loginId: 'login-fixture',
          authUrl: 'https://auth.openai.com/oauth/authorize?state=fixture'
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    };

    assert.deepEqual(await host.login(), {
      authUrl: 'https://auth.openai.com/oauth/authorize?state=fixture',
      loginId: 'login-fixture'
    });

    runtime.request = async method => {
      if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'missing-url' };
      throw new Error(`Unexpected RPC: ${method}`);
    };
    await assert.rejects(
      host.login(),
      /没有返回有效的 ChatGPT 登录地址/
    );
  });
});

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

test('execution defaults readiness distinguishes invalid permission from legacy empty values', async () => {
  await withHost(async ({ store, host }) => {
    store.setSetting('defaultBotModel', 'ready-model');
    store.setSetting('defaultBotPermission', 'invalid-mode');
    assert.deepEqual(host.executionDefaultsReadiness(), {
      ready: false,
      model: 'ready-model',
      permission: null,
      error: '新建 Bot 的全局权限配置无效，请在系统设置中重新选择一个权限。'
    });

    store.setSetting('defaultBotPermission', '');
    assert.deepEqual(host.executionDefaultsReadiness(), {
      ready: true,
      model: 'ready-model',
      permission: 'fullAccess',
      error: null
    });
  });
});

test('global initial-value errors do not block configured Bots; each Bot still requires its own config', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Readiness Bot', 'a');
    const peer = store.createBot('Readiness Peer', 'b');
    const routineBot = store.createBot('Routine readiness Bot', 'c');
    const group = store.createGroup('Readiness Group', [bot.id, peer.bot.id]);
    const routine = store.createRoutine({
      botId: bot.id,
      title: 'Readiness routine',
      instruction: 'must not start',
      schedule: '每天 09:00',
      sourceCallId: 'readiness-routine'
    });
    store.setSetting('defaultBotModel', '');
    store.setSetting('defaultBotPermission', 'invalid-mode');
    store.setSetting('modelInitializationError', '全局模型初值不可用');
    assert.equal(host.executionDefaultsReadiness().ready, false);
    runtime.requests.length = 0;
    const messagesBefore = store.messages(chat.id);
    const groupMessagesBefore = store.groupMessages(group.id);

    await host.send(chat.id, 'existing Bot uses its copied model');
    await host.sendGroup(group.id, '@Readiness Bot reply with its own model');
    runtime.turnList = [{ status: 'completed' }];
    await host.startVoice(peer.chat.id, 'v=0\r\n');
    const previousTurnCount = runtime.requests.filter(request => request.method === 'turn/start').length;
    const routineConversation = host.runRoutineConversation(
      routineBot.chat.id, 'run with the Bot config', 'routine context', false
    );
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length > previousTurnCount);
    const routineTurnStart = runtime.requests.filter(request => request.method === 'turn/start').at(-1);
    routineTurnStart.resolve({ turn: { id: 'routine-configured-turn', status: 'inProgress' } });
    await routineConversation;
    const scheduled = [];
    host.routineScheduler.runNow = async id => {
      scheduled.push(id);
      return { id, status: 'running' };
    };
    await host.runRoutineNow(routine.id);

    assert.deepEqual(scheduled, [routine.id]);
    assert.ok(store.messages(chat.id).length > messagesBefore.length);
    assert.ok(store.groupMessages(group.id).length > groupMessagesBefore.length);
    assert.ok(runtime.requests.some(request => request.method === 'turn/start'));
    assert.ok(runtime.requests
      .filter(request => request.method === 'thread/start')
      .every(request => request.params.model === 'test-model'));

    const afterValidTurn = store.messages(chat.id);
    store.db.prepare("UPDATE bots SET model='' WHERE id=?").run(bot.id);
    await assert.rejects(host.send(chat.id, 'this Bot has no model'), /尚未配置模型/u);
    assert.deepEqual(store.messages(chat.id), afterValidTurn);
  });
});

test('WeChat dynamic Tool results are not retained in local activity history', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('WeChat Activity Bot', 'avatar');
    store.bindThread(chat.id, 'thread-wechat-activity');
    host.threadChats.set('thread-wechat-activity', chat.id);
    runtime.emit('notification', 'item/completed', {
      threadId: 'thread-wechat-activity',
      turnId: 'turn-wechat-activity',
      item: {
        type: 'dynamicToolCall',
        id: 'wechat-result-item',
        namespace: 'rambo_wechat',
        tool: 'wechat_media',
        status: 'completed',
        arguments: { resource_handle: 'a'.repeat(32) },
        contentItems: [
          { type: 'inputText', text: 'private message body must not be retained' },
          { type: 'inputImage', imageUrl: 'data:image/jpeg;base64,PRIVATE_MEDIA_BYTES' },
          { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,PRIVATE_AUDIO_BYTES' }
        ]
      }
    });

    const activity = store.activities(chat.id).find(item => item.itemId === 'wechat-result-item');
    assert.equal(activity?.detail,
      '微信本机查询结果已交付给 Agent；消息正文和媒体不写入 Rambo 活动记录。');
    assert.doesNotMatch(JSON.stringify(activity), /private message body|PRIVATE_MEDIA_BYTES|PRIVATE_AUDIO_BYTES/u);
    assert.equal(events.filter(event => event.type === 'activity')
      .some(event => JSON.stringify(event.activity).includes('PRIVATE_MEDIA_BYTES')), false);
  });
});

test('a ready WeChat connection pre-registers tools while each Bot grant gates access', async () => {
  await withCredentialHost(async ({ store, runtime, host }) => {
    const owner = store.createBot('WeChat owner', 'a');
    const peer = store.createBot('WeChat peer', 'b');
    const connection = store.createConnectorConnection({
      id: 'wechat-thread-start-grant',
      providerId: 'wechat',
      displayName: '本机微信',
      accountLabel: 'WeChat account',
      authKind: 'credentials',
      credentialRef: 'db:wechat-thread-start',
      capabilities: {
        'wechat.sessions': 'ready',
        'wechat.messages': 'ready',
        'wechat.search': 'ready',
        'wechat.moments': 'ready',
        'wechat.media': 'ready'
      }
    });
    store.setConnectorGrant(owner.bot.id, connection.id, true);

    const privateSend = host.send(owner.chat.id, 'Read my authorized WeChat messages');
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/start').length === 1);
    const privateThread = runtime.requests.filter(request => request.method === 'thread/start')[0];
    assert.ok(privateThread.params.dynamicTools.some(tool => tool.name === 'rambo_wechat'));
    const privateTurn = runtime.requests.filter(request => request.method === 'turn/start')[0];
    privateTurn.resolve({ turn: { id: 'wechat-owner-private-turn' } });
    await privateSend;
    runtime.emit('notification', 'turn/completed', {
      threadId: privateTurn.params.threadId,
      turn: { id: 'wechat-owner-private-turn', status: 'completed' }
    });

    const peerSend = host.send(peer.chat.id, 'Try the ungranted WeChat tool');
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/start').length === 2);
    const peerThread = runtime.requests.filter(request => request.method === 'thread/start')[1];
    assert.equal(peerThread.params.dynamicTools.some(tool => tool.name === 'rambo_wechat'), true);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const peerTurn = runtime.requests.filter(request => request.method === 'turn/start')[1];
    const rejected = await host.submitAcceptanceWechatTool({
      method: 'item/tool/call',
      params: {
        threadId: peerTurn.params.threadId,
        callId: 'ungranted-wechat-call',
        namespace: 'rambo_wechat',
        tool: 'wechat_sessions',
        arguments: { connection_id: connection.id }
      }
    });
    assert.equal(rejected.result.success, false);
    assert.match(rejected.result.contentItems[0].text, /没有该微信连接的使用权限/u);
    peerTurn.resolve({ turn: { id: 'wechat-peer-private-turn' } });
    await peerSend;
    runtime.emit('notification', 'turn/completed', {
      threadId: peerTurn.params.threadId,
      turn: { id: 'wechat-peer-private-turn', status: 'completed' }
    });

    const group = store.createGroup('Authorized WeChat group', [owner.bot.id, peer.bot.id]);
    const groupSend = host.sendGroup(group.id, '@WeChat owner read the relevant local messages');
    await groupSend;
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/start').length === 3);
    const groupThread = runtime.requests.filter(request => request.method === 'thread/start')[2];
    assert.ok(groupThread.params.dynamicTools.some(tool => tool.name === 'rambo_wechat'));
    const groupTurn = runtime.requests.filter(request => request.method === 'turn/start')[2];
    groupTurn.resolve({ turn: { id: 'wechat-owner-group-turn' } });
    await waitFor(() => host.snapshot().groupRuntimes[group.id]?.members[0]?.phase === 'working');
    runtime.emit('notification', 'turn/completed', {
      threadId: groupTurn.params.threadId,
      turn: { id: 'wechat-owner-group-turn', status: 'completed' }
    });

    const routine = store.createRoutine({
      botId: owner.bot.id,
      title: 'WeChat routine',
      instruction: 'Query locally available WeChat messages',
      schedule: '每天 09:00',
      sourceCallId: 'wechat-routine-tool-surface'
    });
    const run = store.createRoutineRun({
      routineId: routine.id,
      scheduledFor: '2026-10-25T09:00:00.000Z',
      trigger: 'manual',
      status: 'running'
    });
    const executionChat = store.createRoutineExecutionChat(run.id, owner.bot.id, 'WeChat routine run');
    const routineSend = host.runRoutineConversation(
      executionChat.id,
      'Check this run window in the authorized WeChat account',
      'Routine context',
      false
    );
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/start').length === 4);
    const routineThread = runtime.requests.filter(request => request.method === 'thread/start')[3];
    assert.ok(routineThread.params.dynamicTools.some(tool => tool.name === 'rambo_wechat'));
    const routineTurn = runtime.requests.filter(request => request.method === 'turn/start')[3];
    routineTurn.resolve({ turn: { id: 'wechat-owner-routine-turn' } });
    await routineSend;
  });
});

test('granting an existing WeChat connection after the first turn uses the same registered tool thread', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('WeChat late grant', 'a');
    const connection = store.createConnectorConnection({
      id: 'wechat-late-grant',
      providerId: 'wechat',
      displayName: '本机微信',
      accountLabel: 'Late grant account',
      authKind: 'credentials',
      credentialRef: 'db:wechat-late-grant',
      capabilities: {
        'wechat.sessions': 'ready',
        'wechat.messages': 'ready',
        'wechat.search': 'ready',
        'wechat.media': 'ready'
      }
    });

    const firstSend = host.send(chat.id, 'First turn before WeChat grant');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const firstThreadStart = runtime.requests.find(request => request.method === 'thread/start');
    assert.equal(firstThreadStart.params.dynamicTools.some(tool => tool.name === 'rambo_wechat'), true);
    const firstThreadId = store.chat(chat.id).threadId;
    const firstTurn = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(firstTurn.params.additionalContext['rambo.wechat-connections'], undefined);
    firstTurn.resolve({ turn: { id: 'wechat-before-grant' } });
    await firstSend;
    runtime.emit('notification', 'turn/completed', {
      threadId: firstThreadId,
      turn: { id: 'wechat-before-grant', status: 'completed' }
    });

    store.setConnectorGrant(bot.id, connection.id, true);
    const secondSend = host.send(chat.id, 'Second turn after WeChat grant');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    assert.equal(runtime.requests.filter(request => request.method === 'thread/start').length, 1);
    assert.equal(runtime.requests.filter(request => request.method === 'thread/resume').length, 0);
    assert.equal(store.chat(chat.id).threadId, firstThreadId);
    const secondTurn = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.match(
      secondTurn.params.additionalContext['rambo.wechat-connections'].value,
      /Late grant account/u
    );
    secondTurn.resolve({ turn: { id: 'wechat-after-grant' } });
    await secondSend;
  });
});

test('valid execution defaults clear initialization errors and restore readiness', async () => {
  await withHost(async ({ store, host }) => {
    store.setSetting('defaultBotModel', 'recovered-model');
    store.setSetting('defaultBotPermission', 'invalid-mode');
    store.setSetting('modelInitializationError', 'App Server 模型目录不可用');
    assert.equal(host.executionDefaultsReadiness().ready, false);
    assert.match(host.executionDefaultsReadiness().error, /权限配置无效/u);

    store.setExecutionDefaults({
      model: ' recovered-model ',
      permission: 'workspaceWrite'
    });
    assert.deepEqual(host.executionDefaultsReadiness(), {
      ready: true,
      model: 'recovered-model',
      permission: 'workspaceWrite',
      error: null
    });
  });
});

test('MCP snapshots, resource IPC, and thread config share one redacted metadata cache', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    runtime.globalMcpServers = {
      SecureServer: {
        description: 'Display only',
        command: '/usr/bin/secret-command',
        env: { TOKEN: 'secret-env-token' },
        token: 'secret-auth-token',
        url: 'https://secret.example/mcp'
      }
    };
    store.syncBotResources(['skill:pdf'], ['skill:pdf']);
    store.syncBotResources(['skill:pdf', 'mcp:playwright'], ['skill:pdf']);
    const { bot, chat } = store.createBot('Secure MCP Bot', 'a');

    await host.syncMcpMetadata();
    assert.equal(store.settings().globalResourceIds.includes('mcp:secureserver'), false);
    assert.ok(host.snapshot().botResources.some(resource => resource.id === 'mcp:secureserver'));
    store.syncBotResources(
      [...store.settings().globalResourceIds, 'mcp:secureserver'],
      JSON.parse(store.settings().globalDefaultResourceIds)
    );
    store.setBotResource(bot.id, 'mcp:secureserver', true);
    const snapshot = host.snapshot();
    const ipc = await host.botResources();
    const serializedSnapshot = JSON.stringify(snapshot);
    const serializedIpc = JSON.stringify(ipc);
    assert.match(serializedSnapshot, /Display only/u);
    assert.match(serializedIpc, /Display only/u);
    for (const value of [
      serializedSnapshot,
      serializedIpc
    ]) {
      for (const secret of [
        'secret-command',
        'secret-env-token',
        'secret-auth-token',
        'secret.example'
      ]) assert.equal(value.includes(secret), false, secret);
    }

    const sending = host.send(chat.id, 'start with the cached MCP registry');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    assert.deepEqual({ ...threadStart.params.config.mcp_servers }, {
      SecureServer: { enabled: true }
    });
    const serializedThread = JSON.stringify(threadStart.params.config);
    for (const value of [
      'secret-command',
      'secret-env-token',
      'secret-auth-token',
      'secret.example'
    ]) assert.equal(serializedThread.includes(value), false, value);

    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'secure-mcp-turn' } });
    await sending;

    runtime.globalMcpServers = {
      SecureServer: {
        description: 'Updated metadata',
        env: { TOKEN: 'new-secret-env-token' }
      }
    };
    events.length = 0;
    const refreshed = await host.syncMcpMetadata();
    assert.equal(refreshed.changed, true);
    assert.deepEqual(refreshed.servers, [{
      name: 'SecureServer',
      description: 'Updated metadata'
    }]);
    assert.ok(events.some(event => event.type === 'changed'));
    assert.equal(JSON.stringify(refreshed).includes('new-secret-env-token'), false);
    assert.deepEqual(host.snapshot().botResources
      .filter(resource => resource.id === 'mcp:secureserver')
      .map(resource => resource.description), ['Updated metadata']);
    assert.equal(store.botResourceEnabled(bot.id, 'mcp:secureserver'), true);

    events.length = 0;
    const unchanged = await host.syncMcpMetadata();
    assert.equal(unchanged.changed, false);
    assert.equal(events.some(event => event.type === 'changed'), false);
  });
});

test('Plugin-owned MCP is configured by the plugin switch and stays out of the MCP directory', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const originalHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'rambo-host-plugin-home-'));
    const pluginRoot = join(
      home, '.codex', 'plugins', 'cache', 'vendor', 'fixture-plugin', '1.0.0'
    );
    mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'fixture-plugin',
      description: 'Plugin with its own MCP runtime',
      mcpServers: './.mcp.json'
    }));
    writeFileSync(join(pluginRoot, '.mcp.json'), JSON.stringify({
      mcpServers: {
        fixture_mcp: {
          command: './bin/fixture-server',
          args: ['--fixture'],
          cwd: '.',
          env: { PLUGIN_ONLY_SECRET: 'runtime-only-value' }
        }
      }
    }));
    process.env.HOME = home;
    try {
      runtime.globalMcpServers = {
        fixture_mcp: {
          description: 'Plugin-owned runtime',
          command: 'must-not-be-used-as-an-independent-mcp'
        }
      };
      const directory = await host.botResources(true);
      assert.equal(directory.resources.some(resource =>
        resource.id === 'mcp:fixture_mcp'), false);
      assert.equal(directory.resources.some(resource =>
        resource.id === 'plugin:fixture-plugin'), true);
      assert.equal(JSON.stringify(directory).includes('runtime-only-value'), false);

      store.syncBotResources(
        ['plugin:fixture-plugin'],
        ['plugin:fixture-plugin']
      );
      const enabled = store.createBot('Plugin enabled', 'a');
      const enabledSend = host.send(enabled.chat.id, 'use the plugin');
      await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
      const enabledThread = runtime.requests.find(request => request.method === 'thread/start');
      assert.deepEqual(enabledThread.params.config.features, {
        apps: false,
        plugins: true
      });
      assert.deepEqual({ ...enabledThread.params.config.plugins }, {
        'fixture-plugin@vendor': { enabled: true }
      });
      const pluginMcp = enabledThread.params.config.mcp_servers.fixture_mcp;
      assert.equal(pluginMcp.enabled, true);
      assert.equal(pluginMcp.command, join(pluginRoot, 'bin', 'fixture-server'));
      assert.equal(pluginMcp.cwd, pluginRoot);
      assert.deepEqual(pluginMcp.args, ['--fixture']);
      assert.equal(pluginMcp.env.PLUGIN_ONLY_SECRET, 'runtime-only-value');
      assert.equal(pluginMcp.env.CODEX_HOME, join(store.directory, 'codex-home'));
      assert.equal(pluginMcp.env.CODEX_SQLITE_HOME, join(store.directory, 'codex-home'));
      runtime.requests.find(request => request.method === 'turn/start')
        .resolve({ turn: { id: 'plugin-enabled-turn' } });
      await enabledSend;

      store.syncBotResources(['plugin:fixture-plugin'], []);
      const disabled = store.createBot('Plugin disabled', 'b');
      const disabledSend = host.send(disabled.chat.id, 'do not use the plugin');
      await waitFor(() => runtime.requests.filter(request =>
        request.method === 'turn/start').length === 2);
      const disabledThread = runtime.requests.filter(request =>
        request.method === 'thread/start')[1];
      assert.deepEqual(disabledThread.params.config.features, {
        apps: false,
        plugins: false
      });
      assert.deepEqual({ ...disabledThread.params.config.plugins }, {
        'fixture-plugin@vendor': { enabled: false }
      });
      assert.deepEqual(disabledThread.params.config.mcp_servers.fixture_mcp, {
        enabled: false
      });
      runtime.requests.filter(request => request.method === 'turn/start')[1]
        .resolve({ turn: { id: 'plugin-disabled-turn' } });
      await disabledSend;
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('MCP elicitation waits for an explicit user action and resolves once', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Plugin approval Bot', 'a');
    const sending = host.send(chat.id, 'use Computer Use');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadId = store.chat(chat.id).threadId;

    runtime.emit('serverRequest', {
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'cua_repl',
        threadId,
        turnId: 'plugin-turn',
        mode: 'form',
        message: 'Allow Computer Use to use "Google Chrome"?',
        requestedSchema: {},
        _meta: {
          subtitle: 'Chrome tab access',
          tool_name: 'js'
        }
      }
    });

    assert.equal(runtime.responses.length, 0);
    const prompt = events.find(event => event.type === 'mcpElicitation')?.prompt;
    assert.deepEqual(prompt, {
      requestId: 'elicitation-1',
      serverName: 'cua_repl',
      threadId,
      turnId: 'plugin-turn',
      message: 'Allow Computer Use to use "Google Chrome"?',
      detail: 'Chrome tab access',
      toolName: 'js'
    });

    host.respondMcpElicitation('elicitation-1', 'decline');
    assert.deepEqual(runtime.responses, [{
      id: 'elicitation-1',
      result: { action: 'decline' }
    }]);
    assert.ok(events.some(event =>
      event.type === 'mcpElicitationResolved' &&
      event.requestId === 'elicitation-1'));
    assert.throws(
      () => host.respondMcpElicitation('elicitation-1', 'accept'),
      /已失效/u
    );

    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'plugin-turn' } });
    await sending;
  });
});

test('runtime ready refreshes MCP metadata and App Server restart replaces the safe cache', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    runtime.globalMcpServers = {
      firstServer: {
        description: 'First process',
        command: 'first-command-secret'
      }
    };
    runtime.emit('state', { status: 'ready', version: '0.164.0', error: null });
    await waitFor(() => host.snapshot().botResources
      .some(resource => resource.id === 'mcp:firstserver'));
    assert.deepEqual(JSON.parse(store.settings().globalResourceIds ?? '[]'), []);
    assert.ok(events.some(event => event.type === 'changed'));

    runtime.globalMcpServers = {
      secondServer: {
        description: 'Second process',
        env: { TOKEN: 'second-env-secret' },
        url: 'https://second-url-secret.example/mcp'
      }
    };
    events.length = 0;
    runtime.emit('state', { status: 'ready', version: '0.164.0', error: null });
    await waitFor(() => host.snapshot().botResources
      .some(resource => resource.id === 'mcp:secondserver'));
    const snapshot = JSON.stringify(host.snapshot());
    assert.equal(snapshot.includes('mcp:firstserver'), false);
    assert.deepEqual(JSON.parse(store.settings().globalResourceIds ?? '[]'), []);
    assert.equal(snapshot.includes('first-command-secret'), false);
    assert.equal(snapshot.includes('second-env-secret'), false);
    assert.equal(snapshot.includes('second-url-secret.example'), false);
    assert.ok(events.some(event => event.type === 'changed'));
  });
});

test('an MCP metadata refresh failure is reported without stopping the ready runtime or clearing its safe cache', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    runtime.globalMcpServers = {
      stableServer: {
        description: 'Stable metadata',
        command: 'stable-command-secret'
      }
    };
    await host.syncMcpMetadata();
    const originalRequest = runtime.request.bind(runtime);
    runtime.request = (method, ...args) => method === 'config/read'
      ? Promise.reject(new Error('config/read unavailable'))
      : originalRequest(method, ...args);
    events.length = 0;

    runtime.emit('state', { status: 'ready', version: '0.164.0', error: null });
    await waitFor(() => events.some(event => event.type === 'error'));

    assert.equal(runtime.state.status, 'ready');
    assert.equal(events.some(event => event.type === 'runtime' && event.state.status !== 'ready'), false);
    const snapshot = host.snapshot();
    assert.equal(snapshot.botResources.some(resource =>
      resource.id === 'mcp:stableserver' && resource.description === 'Stable metadata'), true);
    assert.equal(JSON.stringify(snapshot).includes('stable-command-secret'), false);
    assert.deepEqual(JSON.parse(store.settings().globalResourceIds ?? '[]'), []);
  });
});

test('Codex connection test uses one isolated read-only turn and deletes its temporary thread', async () => {
  await withHost(async ({ store, runtime, host }) => {
    mkdirSync(join(store.directory, 'codex-home'), { recursive: true });
    writeFileSync(
      join(store.directory, 'codex-home', 'auth.json'),
      '{"auth_mode":"chatgpt"}',
      { mode: 0o600 }
    );
    const { threadId, turnId } = installCodexConnectionFixture(runtime);

    const result = await host.testCodexConnection('chatgpt');

    assert.ok(result.latencyMs >= 0);
    assert.match(result.message, /Codex 已完成最小只读请求：OK/u);
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    assert.equal(threadStart.params.cwd, join(store.directory, 'connection-test'));
    assert.equal(threadStart.params.model, 'fixture-model');
    assert.equal(threadStart.params.sandbox, 'read-only');
    assert.equal(threadStart.params.approvalPolicy, 'never');
    assert.equal(threadStart.params.ephemeral, true);
    assert.equal(threadStart.params.baseInstructions, 'This is a connectivity probe. Reply with exactly OK.');
    assert.deepEqual(threadStart.params.selectedCapabilityRoots, []);
    assert.deepEqual(threadStart.params.config.mcp_servers, {});
    assert.deepEqual(threadStart.params.config.features, { apps: false, plugins: false });
    assert.deepEqual(threadStart.params.config.skills, {
      bundled: { enabled: false },
      include_instructions: false,
      config: []
    });
    const turnStart = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(turnStart.params.threadId, threadId);
    assert.equal(turnStart.params.model, 'fixture-model');
    assert.equal(turnStart.params.effort, 'low');
    assert.equal(turnStart.params.input[0].text, 'Reply with exactly OK.');
    assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly' });
    assert.ok(runtime.requests.some(request =>
      request.method === 'turn/interrupt' &&
      request.params.threadId === threadId &&
      request.params.turnId === turnId));
    assert.ok(runtime.requests.some(request =>
      request.method === 'thread/delete' && request.params.threadId === threadId));
  });
});

test('Codex connection failures and timeouts always clean up the temporary thread', async () => {
  for (const [mode, pattern] of [
    ['failed', /fixture connection failure/u],
    ['mismatch', /不匹配的 turn/u],
    ['timeout', /连接测试超时/u]
  ]) {
    await withHost(async ({ store, runtime, host }) => {
      mkdirSync(join(store.directory, 'codex-home'), { recursive: true });
      writeFileSync(
        join(store.directory, 'codex-home', 'auth.json'),
        '{"auth_mode":"chatgpt"}',
        { mode: 0o600 }
      );
      const { threadId } = installCodexConnectionFixture(runtime, mode);

      await assert.rejects(
        () => host.testCodexConnection('local', mode === 'timeout' ? 20 : 1_000),
        pattern
      );

      assert.ok(runtime.requests.some(request =>
        request.method === 'thread/delete' && request.params.threadId === threadId));
    });
  }
});

test('selected Playwright always uses Chrome Extension mode instead of Codex Home CDP settings', async () => {
  await withHost(async ({ store, runtime, host }) => {
    runtime.globalMcpServers = {
      playwright: {
        description: 'Codex Home acceptance setup',
        command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.83', '--cdp-endpoint', 'http://127.0.0.1:19222']
      }
    };
    store.syncBotResources(
      ['skill:pdf', 'mcp:playwright'],
      ['skill:pdf', 'mcp:playwright']
    );
    const first = store.createBot('Chrome Browser Bot', 'a');
    const second = store.createBot('Playwright Disabled Bot', 'b');
    store.setBotResource(second.bot.id, 'mcp:playwright', false);

    const firstSend = host.send(first.chat.id, 'use the current browser');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const firstThread = runtime.requests.find(request => request.method === 'thread/start');
    assert.deepEqual(firstThread.params.config.mcp_servers.playwright, {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.83', '--extension'],
      enabled: true
    });
    assert.equal(JSON.stringify(firstThread.params.config).includes('19222'), false);
    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'chrome-extension-turn' } });
    await firstSend;

    const secondSend = host.send(second.chat.id, 'do not expose the browser');
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/start').length === 2);
    const secondThread = runtime.requests.filter(request => request.method === 'thread/start')[1];
    assert.deepEqual(secondThread.params.config.mcp_servers.playwright, { enabled: false });
    runtime.requests.filter(request => request.method === 'turn/start').at(-1)
      .resolve({ turn: { id: 'browser-disabled-turn' } });
    await secondSend;
  });
});

test('message assets open readable assistant files without a workspace path check', async () => {
  await withHost(async ({ store, host }) => {
    const { bot, chat } = store.createBot('Asset Preview', 'a');
    const workspace = join(store.directory, 'bots', bot.id, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'notes.txt'), 'preview text');
    writeFileSync(join(workspace, 'source.go'), 'package source\n');
    writeFileSync(join(workspace, 'unknown.custom'), 'opaque bytes');
    writeFileSync(join(workspace, 'large.wav'), Buffer.alloc(9 * 1024 * 1024));
    writeFileSync(join(store.directory, 'outside.txt'), 'outside');

    const makeMessage = (url, role = 'assistant') => store.addMessage(chat.id, role, 'asset', 'complete', null, null, null, {
      kind: 'media', mediaType: 'file', url, title: url
    });
    const textMessage = makeMessage('notes.txt');
    const textUrl = host.resolveMessageAsset(textMessage.id, 'notes.txt');
    assert.equal(Buffer.from(textUrl.split(',')[1], 'base64').toString('utf8'), 'preview text');
    const unknownMessage = makeMessage('unknown.custom');
    const unknownAsset = host.openMessageAsset(unknownMessage.id, 'unknown.custom');
    assert.equal(unknownAsset.mimeType, 'application/octet-stream');
    closeSync(unknownAsset.descriptor);

    const largeMessage = makeMessage('large.wav');
    assert.equal(host.resolveMessageAsset(largeMessage.id, 'large.wav'), null);
    const streamedAsset = host.openMessageAsset(largeMessage.id, 'large.wav');
    assert.equal(streamedAsset.size, 9 * 1024 * 1024);
    closeSync(streamedAsset.descriptor);
    assert.equal(host.messageAssetPath(largeMessage.id, 'large.wav'), realpathSync(join(workspace, 'large.wav')));

    const outsidePath = realpathSync(join(store.directory, 'outside.txt'));
    const outsideAsset = host.openMessageAsset(textMessage.id, outsidePath);
    assert.equal(outsideAsset.path, outsidePath);
    closeSync(outsideAsset.descriptor);
    assert.equal(Buffer.from(host.resolveMessageAsset(textMessage.id, outsidePath).split(',')[1], 'base64').toString('utf8'), 'outside');
    for (const source of [`${outsidePath}:12`, `${outsidePath}:12:3`]) {
      const locatedAsset = host.openMessageAsset(textMessage.id, source);
      assert.equal(locatedAsset.path, outsidePath);
      closeSync(locatedAsset.descriptor);
    }
    const sourcePath = realpathSync(join(workspace, 'source.go'));
    for (const source of [`${sourcePath}:1417`, `${sourcePath}:1417:3`]) {
      assert.equal(host.messageAssetPath(textMessage.id, source), sourcePath);
    }
    assert.equal(host.openMessageAsset(textMessage.id, '/definitely-missing-rambo-asset.go:1417'), null);
    const userMessage = makeMessage('notes.txt', 'user');
    assert.equal(host.openMessageAsset(userMessage.id, 'notes.txt'), null);
    assert.equal(host.openMessageAsset(userMessage.id, outsidePath), null);
  });
});

test('a completed image-generation item attaches its saved image to the same assistant turn', async () => {
  await withHost(async ({ store, runtime, events, Host }) => {
    const { chat } = store.createBot('Generated Image', 'a');
    const threadId = 'thread-generated-image';
    const turnId = 'turn-generated-image';
    store.bindThread(chat.id, threadId);
    const imagePath = join(store.directory, 'generated_images', threadId, 'cat.png');
    mkdirSync(join(store.directory, 'generated_images', threadId), { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const hostWithThread = new Host(store, runtime, event => events.push(event));

    hostWithThread.acceptNotification('item/completed', {
      threadId,
      turnId,
      item: {
        id: 'image-generation-1', type: 'imageGeneration', status: 'completed',
        revisedPrompt: '窗台上的猫', savedPath: imagePath
      }
    });
    hostWithThread.acceptNotification('item/completed', {
      threadId,
      turnId,
      item: {
        id: 'assistant-image-reply', type: 'agentMessage', phase: 'final_answer',
        text: '给你生成好了：窗台上的猫。'
      }
    });

    const reply = store.messages(chat.id).find(message => message.itemId === 'assistant-image-reply');
    assert.ok(reply);
    assert.deepEqual(reply.content, {
      kind: 'media', mediaType: 'image', url: imagePath, alt: '生成图片', generated: true
    });
    assert.ok(events.some(event => event.type === 'message' && event.message.id === reply.id && event.message.content?.generated));
    assert.match(hostWithThread.resolveMessageAsset(reply.id, imagePath), /^data:image\/png;base64,/u);

    const otherTurn = store.addMessage(chat.id, 'assistant', '另一轮回复', 'complete', null, 'turn-unrelated');
    const otherTurnImage = hostWithThread.openMessageAsset(otherTurn.id, imagePath);
    assert.equal(otherTurnImage.path, realpathSync(imagePath));
    closeSync(otherTurnImage.descriptor);
  });
});

test('host snapshots expose connector catalog and metadata without credential references', async () => {
  await withHost(async ({ store, host }) => {
    const bot = store.createBot('Connector snapshot bot', 'a').bot;
    const connection = store.createConnectorConnection({
      id: 'connection-snapshot',
      providerId: 'qqmail',
      displayName: 'QQ 工作邮箱',
      accountLabel: 'snapshot@qq.com',
      authKind: 'credentials',
      credentialRef: 'pending-keychain:connection-snapshot'
    });
    store.setConnectorGrant(bot.id, connection.id, true);

    const snapshot = host.snapshot();
    assert.equal(snapshot.connectorProviders.some(provider => provider.id === 'gmail'), true);
    assert.equal(snapshot.connectorProviders.find(provider => provider.id === 'gmail').available, true);
    assert.equal(snapshot.connectorProviders.find(provider => provider.id === 'calendar').available, false);
    assert.equal(snapshot.connections[0].accountLabel, 'snapshot@qq.com');
    assert.equal('credentialRef' in snapshot.connections[0], false);
    assert.deepEqual(snapshot.connectorGrants.map(grant => grant.botId), [bot.id]);
  });
});

test('mail tools are present only in private chats while the connection directory and calls follow grants', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const owner = store.createBot('Mail owner', 'a');
    const peer = store.createBot('Mail peer', 'b');
    const connection = store.createConnectorConnection({
      id: '0f1e6a82-7a14-4f56-a1a1-7af19d7d55c8',
      providerId: 'qqmail',
      displayName: '工作 QQ 邮箱',
      accountLabel: 'owner@qq.com',
      authKind: 'credentials',
      credentialRef: 'db:9e2aa59b-977a-4bb8-8ce0-24dd7fe29e9c'
    });
    store.setConnectorGrant(owner.bot.id, connection.id, true);

    const firstSend = host.send(owner.chat.id, '查找今天的邮件');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const ownerThreadStart = runtime.requests.find(request => request.method === 'thread/start');
    assert.equal(ownerThreadStart.params.dynamicTools.some(tool => tool.name === 'rambo_mail'), true);
    const firstTurn = runtime.requests.find(request => request.method === 'turn/start');
    assert.match(
      firstTurn.params.additionalContext['rambo.mail-connections'].value,
      /owner@qq\.com/u
    );
    const ownerThreadId = store.chat(owner.chat.id).threadId;
    firstTurn.resolve({ turn: { id: 'mail-owner-turn' } });
    await firstSend;
    runtime.emit('notification', 'turn/completed', {
      threadId: ownerThreadId, turn: { id: 'mail-owner-turn', status: 'completed' }
    });

    const peerSend = host.send(peer.chat.id, '查找今天的邮件');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const peerThreadStart = runtime.requests.filter(request => request.method === 'thread/start')[1];
    assert.equal(peerThreadStart.params.dynamicTools?.some(tool => tool.name === 'rambo_mail'), true);
    const peerTurn = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.equal('rambo.mail-connections' in peerTurn.params.additionalContext, false);

    const rejected = await host.submitAcceptanceMailTool({
      threadId: store.chat(peer.chat.id).threadId,
      callId: 'mail-peer-call',
      namespace: 'rambo_mail',
      tool: 'mail_search',
      arguments: { connection_id: connection.id, query: 'invoice' }
    });
    assert.equal(rejected.result.success, false);
    assert.match(rejected.result.contentItems[0].text, /邮件|权限/u);

    const missingCredential = await host.submitAcceptanceMailTool({
      threadId: ownerThreadId,
      callId: 'mail-owner-call',
      namespace: 'rambo_mail',
      tool: 'mail_search',
      arguments: { connection_id: connection.id, query: 'invoice' }
    });
    assert.equal(missingCredential.result.success, false);
    assert.match(missingCredential.result.contentItems[0].text, /邮件|权限/u);

    runtime.requests.filter(request => request.method === 'turn/start')[1]
      .resolve({ turn: { id: 'mail-peer-turn' } });
    await peerSend;
  });
});

test('a mail grant change keeps the Bot private thread and re-checks access at call time', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Grant lifecycle', 'a');
    const firstSend = host.send(chat.id, 'first message');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const firstThreadId = store.chat(chat.id).threadId;
    assert.equal(
      runtime.requests.find(request => request.method === 'thread/start').params.dynamicTools
        .some(tool => tool.name === 'rambo_mail'),
      true
    );
    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'before-grant' } });
    await firstSend;
    runtime.emit('notification', 'turn/completed', {
      threadId: firstThreadId, turn: { id: 'before-grant', status: 'completed' }
    });

    const connection = store.createConnectorConnection({
      id: 'c819a8b2-05d7-4e59-b65f-b2c9a668fe5b',
      providerId: 'gmail',
      displayName: 'Mail',
      accountLabel: 'owner@gmail.com',
      authKind: 'oauth-desktop',
      credentialRef: 'db:c743497d-4222-43a2-956f-3d2dd5828ddb'
    });
    store.setConnectorGrant(bot.id, connection.id, true);

    const secondSend = host.send(chat.id, 'second message after grant');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const secondThreadStart = runtime.requests.filter(request => request.method === 'thread/start')[1];
    assert.equal(secondThreadStart, undefined);
    const secondResume = runtime.requests.filter(request => request.method === 'thread/resume')[0];
    assert.equal(secondResume, undefined);
    const firstTurn = runtime.requests.filter(request => request.method === 'turn/start')[0];
    assert.equal(
      firstTurn.params.additionalContext['rambo.mail-connections'],
      undefined
    );
    assert.equal(store.chat(chat.id).threadId, firstThreadId);
    const secondTurn = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.match(
      secondTurn.params.additionalContext['rambo.mail-connections'].value,
      /owner@gmail\.com/u
    );
    secondTurn
      .resolve({ turn: { id: 'after-grant' } });
    await secondSend;
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

test('each turn carries fresh local time context and Routine creation uses the Host timezone', async () => {
  await withHost(async ({ store, runtime, Host, events }) => {
    const clock = [
      new Date('2026-10-25T01:02:03.000Z'),
      new Date('2026-10-25T03:04:05.000Z')
    ];
    let clockIndex = 0;
    const localHost = new Host(
      store, runtime, event => events.push(event), undefined, undefined,
      'America/Los_Angeles', () => clock[Math.min(clockIndex, clock.length - 1)]
    );
    const { chat } = store.createBot('Local clock Bot', 'a');
    store.bindThread(chat.id, 'local-clock-thread', true, true);
    store.updateChat(chat.id, {});
    store.updateBotExecutionConfig(chat.botId, {
      model: 'local-clock-model',
      permission: 'fullAccess'
    });
    localHost.threadChats.set('local-clock-thread', chat.id);
    localHost.loadedThreads.add('local-clock-thread');

    const firstSending = localHost.send(chat.id, '现在几点？');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const firstStart = runtime.requests.filter(request => request.method === 'turn/start')[0];
    assert.match(
      firstStart.params.additionalContext['rambo.current-time'].value,
      /当前时间是 2026-10-24 18:02:03。[\s\S]*时区：America\/Los_Angeles/u
    );
    firstStart.resolve({ turn: { id: 'local-clock-first' } });
    await firstSending;
    runtime.emit('notification', 'turn/completed', {
      threadId: store.chat(chat.id).threadId,
      turn: { id: 'local-clock-first', status: 'completed' }
    });

    clockIndex = 1;
    const secondSending = localHost.send(chat.id, '两分钟后提醒我。');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const secondStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.match(
      secondStart.params.additionalContext['rambo.current-time'].value,
      /当前时间是 2026-10-24 20:04:05。[\s\S]*时区：America\/Los_Angeles/u
    );
    secondStart.resolve({ turn: { id: 'local-clock-second' } });
    await secondSending;
    runtime.emit('notification', 'turn/completed', {
      threadId: store.chat(chat.id).threadId,
      turn: { id: 'local-clock-second', status: 'completed' }
    });

    const threadId = store.chat(chat.id).threadId;
    const response = await localHost.submitAcceptanceRoutineTool({
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'local-clock-second',
        callId: 'local-clock-routine',
        namespace: 'rambo_routines',
        tool: 'create_routine',
        arguments: {
          title: '两分钟后的提醒',
          instruction: '提醒我检查结果',
          schedule: '一次性',
          triggerTime: '20:06',
          runDate: '2026-10-24',
          kind: 'once'
        }
      }
    });
    assert.equal(response.result.success, true);
    const [routine] = store.routines();
    assert.equal(routine.definition.timezone, 'America/Los_Angeles');
    assert.equal(routine.definition.runAt, '2026-10-25T03:06:00.000Z');
  });
});

test('private and group sends resolve after the visible user message without waiting for turn/start', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const owner = store.createBot('Responsive owner', 'a');
    const peer = store.createBot('Responsive peer', 'b');
    const group = store.createGroup('Responsive room', [owner.bot.id, peer.bot.id]);

    const privateSending = host.send(owner.chat.id, 'private message available immediately');
    await privateSending;
    const privateMessage = store.messages(owner.chat.id)
      .find(message => message.text === 'private message available immediately');
    assert.ok(privateMessage);
    assert.equal(privateMessage.role, 'user');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const privateStart = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(Boolean(privateStart.resolve), true);
    assert.equal(host.snapshot().startingTurns[owner.chat.id], true);
    assert.ok(events.some(event => event.type === 'startingTurn' && event.chatId === owner.chat.id && event.starting));

    runtime.requests.filter(request => request.method === 'turn/start')[0]
      .resolve({ turn: { id: 'responsive-private-turn' } });
    await waitFor(() => !host.snapshot().startingTurns[owner.chat.id]);

    const groupSending = host.sendGroup(group.id, '@Responsive peer reply later');
    await groupSending;
    assert.equal(
      store.groupMessages(group.id).some(message =>
        message.role === 'user' && message.text === '@Responsive peer reply later'
      ),
      true
    );
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const groupStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.equal(Boolean(groupStart.resolve), true);
    const groupRuntime = host.snapshot().groupRuntimes[group.id];
    assert.ok(groupRuntime);
    assert.ok(groupRuntime.members.some(member =>
      member.botId === peer.bot.id && member.phase === 'starting'
    ));
    groupStart.resolve({ turn: { id: 'responsive-group-turn' } });
    await waitFor(() => host.snapshot().groupRuntimes[group.id]?.members
      .every(member => member.phase !== 'starting'));
  });
});

test('a Bot can create and focus a persisted group from its private chat with itself and active members only', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const owner = store.createBot('Coordinator', 'a');
    const peer = store.createBot('Researcher', 'b');
    const archived = store.createBot('Archived peer', 'c');
    store.setBotArchived(archived.bot.id, true);
    const sending = host.send(owner.chat.id, '请创建一个包含研究员的群聊。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    assert.equal(
      threadStart.params.dynamicTools.some(tool => tool.name === 'rambo_groups'),
      true
    );
    const groupTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_groups').tools[0];
    assert.deepEqual(groupTool.inputSchema.required, ['title', 'purpose', 'botIds']);
    assert.match(groupTool.description, /当前 Bot.*成员/u);
    const threadId = store.chat(owner.chat.id).threadId;

    const create = callId => runtime.emit('serverRequest', {
      id: callId,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'group-create-turn',
        callId: `group-create-${callId}`,
        namespace: 'rambo_groups',
        tool: 'create_group',
        arguments: {
          title: 'Research room',
          purpose: 'Coordinate shared research and produce concise findings.',
          botIds: [owner.bot.id, peer.bot.id]
        }
      }
    });
    create(81);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (runtime.responses.length === 1 || events.some(event => event.type === 'error')) break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(events.some(event => event.type === 'error'), false, JSON.stringify(events));
    assert.equal(runtime.responses[0].result.success, true, JSON.stringify(runtime.responses[0].result));
    assert.equal(runtime.responses[0].result.success, true);
    const group = store.groups().find(item => item.title === 'Research room');
    assert.ok(group);
    assert.deepEqual(group.memberIds, [owner.bot.id, peer.bot.id]);
    assert.equal(group.ownerBotId, owner.bot.id);
    assert.equal(group.purpose, 'Coordinate shared research and produce concise findings.');
    assert.equal(store.groupMessages(group.id).length, 0);
    assert.ok(events.some(event => event.type === 'groupCreated' && event.group.id === group.id));
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const announcementStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    const ownerGroupSession = store.groupSession(group.id, owner.bot.id);
    assert.equal(announcementStart.params.threadId, store.chat(ownerGroupSession.id).threadId);
    assert.notEqual(announcementStart.params.threadId, store.chat(owner.chat.id).threadId);
    assert.match(announcementStart.params.input[0].text, /Coordinate shared research/u);
    assert.match(announcementStart.params.input[0].text, /rambo_group_messages\.send/u);
    assert.deepEqual(store.messages(ownerGroupSession.id), []);
    announcementStart.resolve({ turn: { id: 'group-announcement-turn', status: 'inProgress' } });
    runtime.emit('notification', 'turn/completed', {
      threadId: announcementStart.params.threadId,
      turn: { id: 'group-announcement-turn', status: 'completed' }
    });

    runtime.emit('serverRequest', {
      id: 82,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'group-create-turn',
        callId: 'group-create-archived',
        namespace: 'rambo_groups',
        tool: 'create_group',
        arguments: {
          title: 'Archived room',
          purpose: 'Should not be created with an archived member.',
          botIds: [peer.bot.id, archived.bot.id]
        }
      }
    });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, false);
    assert.match(runtime.responses[1].result.contentItems[0].text, /已归档/u);
    assert.equal(store.groups().some(item => item.title === 'Archived room'), false);

    runtime.emit('serverRequest', {
      id: 83,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'group-create-turn',
        callId: 'group-create-duplicate-other',
        namespace: 'rambo_groups',
        tool: 'create_group',
        arguments: {
          title: 'Duplicate room',
          purpose: 'Should reject duplicate members.',
          botIds: [peer.bot.id, peer.bot.id]
        }
      }
    });
    await waitFor(() => runtime.responses.length === 3);
    assert.equal(runtime.responses[2].result.success, false);
    assert.match(runtime.responses[2].result.contentItems[0].text, /不能重复/u);
    assert.equal(store.groups().some(item => item.title === 'Duplicate room'), false);

    runtime.emit('serverRequest', {
      id: 84,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'group-create-turn',
        callId: 'group-create-missing',
        namespace: 'rambo_groups',
        tool: 'create_group',
        arguments: {
          title: 'Missing room',
          purpose: 'Should reject missing members.',
          botIds: ['missing-bot-id']
        }
      }
    });
    await waitFor(() => runtime.responses.length === 4);
    assert.equal(runtime.responses[3].result.success, false);
    assert.equal(store.groups().some(item => item.title === 'Missing room'), false);

    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'group-create-turn' } });
    await sending;
  });
});

test('group owner tools manage purpose and members while non-owner sessions are read-only', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const owner = store.createBot('Owner', 'a');
    const peer = store.createBot('Peer', 'b');
    const newcomer = store.createBot('Newcomer', 'c');
    const group = store.createGroup(
      'Owned room',
      [owner.bot.id, peer.bot.id],
      'Initial shared purpose',
      owner.bot.id
    );
    const peerSession = store.groupSession(group.id, peer.bot.id);

    await host.sendGroup(group.id, '@Owner coordinate the first pass');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const ownerStart = runtime.requests.filter(request => request.method === 'turn/start')[0];
    const ownerThreadStart = runtime.requests.find(request => request.method === 'thread/start');
    const ownerTools = ownerThreadStart.params.dynamicTools.find(tool => tool.name === 'rambo_groups');
    assert.deepEqual(ownerTools.tools.map(tool => tool.name), [
      'update_purpose', 'add_members', 'remove_members'
    ]);
    ownerStart.resolve({ turn: { id: 'owned-room-owner-turn', status: 'inProgress' } });
    runtime.emit('notification', 'item/completed', {
      threadId: ownerStart.params.threadId,
      item: { id: 'owned-room-owner-reply', type: 'agentMessage', text: 'Owner ready.' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: ownerStart.params.threadId,
      turn: { id: 'owned-room-owner-turn', status: 'completed' }
    });
    await waitFor(() => host.isGroupBusy(group.id) === false &&
      host.snapshot().groupRuntimes[group.id] === undefined);

    const purposeResult = await host.submitAcceptanceGroupManagementTool({
      method: 'item/tool/call',
      params: {
        threadId: ownerStart.params.threadId,
        callId: 'owner-update-purpose',
        namespace: 'rambo_groups',
        tool: 'update_purpose',
        arguments: { purpose: 'Updated shared purpose' }
      }
    });
    assert.equal(purposeResult.result.success, true);
    assert.equal(store.group(group.id).purpose, 'Updated shared purpose');

    const addResult = await host.submitAcceptanceGroupManagementTool({
      method: 'item/tool/call',
      params: {
        threadId: ownerStart.params.threadId,
        callId: 'owner-add-member',
        namespace: 'rambo_groups',
        tool: 'add_members',
        arguments: { botIds: [newcomer.bot.id] }
      }
    });
    assert.equal(addResult.result.success, true);
    assert.deepEqual(store.group(group.id).memberIds, [
      owner.bot.id, peer.bot.id, newcomer.bot.id
    ]);

    await host.sendGroup(group.id, '@Peer inspect the next pass');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const peerStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    const peerThreadStart = runtime.requests.filter(request => request.method === 'thread/start')[1];
    assert.equal(peerThreadStart.params.dynamicTools.some(tool => tool.name === 'rambo_groups'), false);
    peerStart.resolve({ turn: { id: 'owned-room-peer-turn', status: 'inProgress' } });
    const denied = await host.submitAcceptanceGroupManagementTool({
      method: 'item/tool/call',
      params: {
        threadId: peerStart.params.threadId,
        callId: 'peer-update-purpose',
        namespace: 'rambo_groups',
        tool: 'update_purpose',
        arguments: { purpose: 'Peer must not change this' }
      }
    });
    assert.equal(denied.result.success, false);
    assert.match(denied.result.contentItems[0].text, /只有当前群主可以管理群职责和成员/u);
    runtime.emit('notification', 'item/completed', {
      threadId: peerStart.params.threadId,
      item: { id: 'owned-room-peer-reply', type: 'agentMessage', text: 'Peer ready.' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: peerStart.params.threadId,
      turn: { id: 'owned-room-peer-turn', status: 'completed' }
    });
    await waitFor(() => host.isGroupBusy(group.id) === false &&
      host.snapshot().groupRuntimes[group.id] === undefined);

    const removeResult = await host.submitAcceptanceGroupManagementTool({
      method: 'item/tool/call',
      params: {
        threadId: ownerStart.params.threadId,
        callId: 'owner-remove-member',
        namespace: 'rambo_groups',
        tool: 'remove_members',
        arguments: { botIds: [peer.bot.id] }
      }
    });
    assert.equal(removeResult.result.success, true);
    assert.deepEqual(store.group(group.id).memberIds, [owner.bot.id, newcomer.bot.id]);
    assert.throws(() => store.chat(peerSession.id), /聊天不存在/u);
    assert.equal(store.groupSessions().some(session => session.chatId === peerSession.id), false);

    const ownerRemoval = await host.submitAcceptanceGroupManagementTool({
      method: 'item/tool/call',
      params: {
        threadId: ownerStart.params.threadId,
        callId: 'owner-remove-self',
        namespace: 'rambo_groups',
        tool: 'remove_members',
        arguments: { botIds: [owner.bot.id] }
      }
    });
    assert.equal(ownerRemoval.result.success, false);
    assert.match(ownerRemoval.result.contentItems[0].text, /不能直接移除群主/u);
  });
});

test('Bot group message Tool supports directed and everyone delivery with stable deduplication and delegation limits', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const alpha = store.createBot('Alpha', 'a');
    const beta = store.createBot('Beta', 'b');
    const gamma = store.createBot('Gamma', 'c');
    const outsider = store.createBot('Outsider', 'd');
    const group = store.createGroup(
      'Delegation room',
      [alpha.bot.id, beta.bot.id, gamma.bot.id],
      'Coordinate delegated work',
      alpha.bot.id
    );
    const alphaSession = store.groupSession(group.id, alpha.bot.id);

    await host.sendGroup(group.id, '@Alpha start the collaboration');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const alphaStart = runtime.requests.filter(request => request.method === 'turn/start')[0];
    const alphaThreadStart = runtime.requests.find(request => request.method === 'thread/start');
    const messageTools = alphaThreadStart.params.dynamicTools.find(tool => tool.name === 'rambo_group_messages');
    assert.deepEqual(messageTools.tools.map(tool => tool.name), ['send']);

    const directed = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: alphaStart.params.threadId,
        callId: 'alpha-to-beta',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: { text: 'Please research the shared question.', targetBotId: beta.bot.id }
      }
    });
    assert.equal(directed.result.success, true);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const betaStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.match(betaStart.params.input[0].text, /@Beta Please research the shared question\./u);
    assert.match(betaStart.params.input[0].text, /协作链深度 1\/4/u);
    const countAfterDirected = store.groupMessages(group.id).length;

    const duplicate = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: alphaStart.params.threadId,
        callId: 'alpha-to-beta',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: { text: 'This retry must not append twice.', targetBotId: beta.bot.id }
      }
    });
    assert.equal(duplicate.result.success, true);
    assert.match(duplicate.result.contentItems[0].text, /已发送/u);
    assert.equal(store.groupMessages(group.id).length, countAfterDirected);

    const selfTarget = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: alphaStart.params.threadId,
        callId: 'alpha-to-self',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: { text: 'Do not self-trigger.', targetBotId: alpha.bot.id }
      }
    });
    assert.equal(selfTarget.result.success, false);
    assert.match(selfTarget.result.contentItems[0].text, /不能通过群消息 Tool 点名自己/u);

    const outsideTarget = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: alphaStart.params.threadId,
        callId: 'alpha-to-outsider',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: { text: 'Cross-group delivery must fail.', targetBotId: outsider.bot.id }
      }
    });
    assert.equal(outsideTarget.result.success, false);
    assert.match(outsideTarget.result.contentItems[0].text, /不是当前群成员/u);

    host.groupDelegationsByChat.set(alphaSession.id, {
      rootMessageId: 'ancestor-root',
      ancestorBotIds: [beta.bot.id],
      depth: 1
    });
    const ancestorTarget = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: alphaStart.params.threadId,
        callId: 'alpha-to-ancestor',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: { text: 'Ancestor delivery must fail.', targetBotId: beta.bot.id }
      }
    });
    assert.equal(ancestorTarget.result.success, false);
    assert.match(ancestorTarget.result.contentItems[0].text, /不能把群内协作回派给祖先成员/u);

    host.groupDelegationsByChat.set(alphaSession.id, {
      rootMessageId: 'depth-root',
      ancestorBotIds: [alpha.bot.id],
      depth: 4
    });
    const tooDeep = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: alphaStart.params.threadId,
        callId: 'alpha-too-deep',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: { text: 'This is beyond the allowed chain.', targetBotId: gamma.bot.id }
      }
    });
    assert.equal(tooDeep.result.success, false);
    assert.match(tooDeep.result.contentItems[0].text, /最多 4 次/u);
    host.groupDelegationsByChat.delete(alphaSession.id);

    alphaStart.resolve({ turn: { id: 'alpha-collaboration-turn', status: 'inProgress' } });
    betaStart.resolve({ turn: { id: 'beta-collaboration-turn', status: 'inProgress' } });
    runtime.emit('notification', 'item/completed', {
      threadId: betaStart.params.threadId,
      item: { id: 'beta-collaboration-reply', type: 'agentMessage', text: 'Research received.' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: betaStart.params.threadId,
      turn: { id: 'beta-collaboration-turn', status: 'completed' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: alphaStart.params.threadId,
      turn: { id: 'alpha-collaboration-turn', status: 'completed' }
    });
    await waitFor(() => host.snapshot().groupRuntimes[group.id] === undefined);

    const everyone = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: alphaStart.params.threadId,
        callId: 'alpha-to-everyone',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: { text: 'Share any material updates.', everyone: true }
      }
    });
    assert.equal(everyone.result.success, true);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 4);
    const everyoneStarts = runtime.requests.filter(request => request.method === 'turn/start').slice(2);
    assert.equal(everyoneStarts.length, 2);
    assert.ok(everyoneStarts.every(start =>
      start.params.input[0].text.includes('@everyone Share any material updates.')
    ));
    assert.ok(everyoneStarts.every(start =>
      start.params.input[0].text.includes('协作链深度 1/4')
    ));
    everyoneStarts.forEach((start, index) => {
      const turnId = `everyone-delegation-${index}`;
      start.resolve({ turn: { id: turnId, status: 'inProgress' } });
      runtime.emit('notification', 'item/completed', {
        threadId: start.params.threadId,
        item: {
          id: `everyone-delegation-reply-${index}`,
          type: 'agentMessage',
          text: '[[RAMBO_NO_GROUP_REPLY]]'
        }
      });
      runtime.emit('notification', 'turn/completed', {
        threadId: start.params.threadId,
        turn: { id: turnId, status: 'completed' }
      });
    });
    await waitFor(() => host.snapshot().groupRuntimes[group.id] === undefined);

    const messages = store.groupMessages(group.id);
    assert.equal(messages.some(message => message.text === '@Beta Please research the shared question.'), true);
    assert.equal(messages.some(message => message.text === '@everyone Share any material updates.'), true);
    assert.equal(messages.some(message => message.text.includes('This retry must not append twice.')), false);
  });
});

test('Bot group message Tool lets the immediate sender reply for multi-turn dialogue', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const interviewer = store.createBot('Interviewer', 'a');
    const candidate = store.createBot('Candidate', 'b');
    const group = store.createGroup(
      'Interview room',
      [interviewer.bot.id, candidate.bot.id],
      'Run a turn-taking interview',
      interviewer.bot.id
    );

    await host.sendGroup(group.id, '@Interviewer start the interview');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const interviewerStart = runtime.requests.filter(request => request.method === 'turn/start')[0];
    interviewerStart.resolve({ turn: { id: 'interviewer-question-turn', status: 'inProgress' } });

    const question = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: interviewerStart.params.threadId,
        callId: 'interviewer-question',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: {
          text: '@Candidate introduce one Go project.',
          targetBotId: candidate.bot.id
        }
      }
    });
    assert.equal(question.result.success, true);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const candidateStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.match(candidateStart.params.input[0].text, /Interviewer.*明确发给你/u);
    assert.match(candidateStart.params.input[0].text, /本轮要回应的消息如下/u);
    assert.match(candidateStart.params.input[0].text, /introduce one Go project/u);
    assert.match(candidateStart.params.input[0].text, /除当前直接发送者外，不得把任务回派给祖先成员/u);
    assert.match(candidateStart.params.input[0].text, new RegExp(`targetBotId=${interviewer.bot.id}`, 'u'));
    assert.match(
      store.groupMessages(group.id).find(message => message.senderBotId === interviewer.bot.id)?.text ?? '',
      /^@Candidate introduce one Go project\.$/u
    );

    runtime.emit('notification', 'turn/completed', {
      threadId: interviewerStart.params.threadId,
      turn: { id: 'interviewer-question-turn', status: 'completed' }
    });
    candidateStart.resolve({ turn: { id: 'candidate-answer-turn', status: 'inProgress' } });
    await waitFor(() =>
      host.activeTurns.get(store.groupSession(group.id, candidate.bot.id).id) === 'candidate-answer-turn'
    );

    const answer = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: candidateStart.params.threadId,
        callId: 'candidate-answer',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: {
          text: '@Interviewer I built a Go service for order processing.',
          targetBotId: interviewer.bot.id
        }
      }
    });
    assert.equal(answer.result.success, true, JSON.stringify(answer.result));
    runtime.emit('notification', 'item/completed', {
      threadId: candidateStart.params.threadId,
      turnId: 'candidate-answer-turn',
      item: {
        id: 'candidate-tool-only-final',
        type: 'agentMessage',
        phase: 'final_answer',
        text: '[[RAMBO_NO_GROUP_REPLY]]'
      }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: candidateStart.params.threadId,
      turn: { id: 'candidate-answer-turn', status: 'completed' }
    });
    assert.equal(store.groupMessages(group.id).some(message =>
      message.role === 'system' && message.text.includes('内部不回复标记')
    ), false);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 3);
    const nextInterviewerStart = runtime.requests.filter(request => request.method === 'turn/start')[2];
    assert.match(nextInterviewerStart.params.input[0].text, /@Interviewer I built a Go service/u);
    assert.match(nextInterviewerStart.params.input[0].text, /Candidate.*明确发给你/u);
    assert.match(nextInterviewerStart.params.input[0].text, /本轮要回应的消息如下/u);
    assert.equal(
      store.groupMessages(group.id).filter(message =>
        message.senderBotId === candidate.bot.id &&
        message.text.startsWith('@Interviewer')
      ).length,
      1
    );
  });
});

test('new Bot greeting starts one hidden real turn with autonomy and secret Tools', async () => {
  await withSecretHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Greeting Bot', 'a');
    store.updateBot(bot.id, {
      role: '整理研究资料',
      instructions: '回答简洁，并明确标出仍缺失的信息。'
    });

    const greeting = host.greetNewBot(bot.id);
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    const turnStart = runtime.requests.find(request => request.method === 'turn/start');
    assert.match(threadStart.params.developerInstructions, /默认以强自主性和规划能力工作/u);
    assert.match(threadStart.params.developerInstructions, /rambo_secrets\.save_secret/u);
    const secretTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_secrets');
    assert.deepEqual(secretTool.tools.map(tool => tool.name), [
      'save_secret', 'list_secrets', 'rotate_secret', 'delete_secret', 'run_with_secret'
    ]);
    assert.match(turnStart.params.input[0].text, /隐藏问候 seed/u);
    assert.match(turnStart.params.input[0].text, /Greeting Bot/u);
    assert.match(turnStart.params.input[0].text, /整理研究资料/u);
    assert.equal(store.messages(chat.id).length, 0);
    assert.equal(store.turns(chat.id).length, 1);
    assert.equal(store.turns(chat.id)[0].userMessageId, null);

    turnStart.resolve({ turn: { id: 'new-bot-greeting-turn', status: 'inProgress' } });
    await greeting;
    assert.equal(store.messages(chat.id).length, 0);
    assert.equal(store.chat(chat.id).threadId, turnStart.params.threadId);
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
      [
        'rambo_chat_ui', 'rambo_routines', 'rambo_bot', 'rambo_resources', 'rambo_credentials',
        'rambo_memories', 'rambo_secrets', 'rambo_groups', 'rambo_voice', 'rambo_mail'
      ]
    );
    const routineTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_routines');
    const botTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_bot');
    const memoryTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_memories');
    const secretTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_secrets');
    assert.deepEqual(routineTool.tools.map(tool => tool.name), [
      'create_routine', 'update_routine', 'set_routine_status', 'delete_routine'
    ]);
    assert.deepEqual(routineTool.tools[0].inputSchema.required, ['title', 'instruction', 'schedule', 'kind']);
    assert.deepEqual(
      routineTool.tools[0].inputSchema.properties.executionMode.enum,
      ['chat', 'script', 'hybrid']
    );
    assert.match(routineTool.tools[0].description, /先判断任务的性质与执行约束.*自主选择执行方式/u);
    assert.match(routineTool.tools[0].description, /相对时间.*直接创建/);
    assert.match(
      routineTool.tools[0].inputSchema.properties.executionMode.description,
      /先判断任务性质与执行约束.*再选择.*确定性计算.*通常满足 script 的条件/u
    );
    assert.match(routineTool.tools[0].inputSchema.properties.runDate.description, /几分钟后.*换算.*日期/u);
    assert.equal(routineTool.tools[0].inputSchema.properties.triggerTime.pattern, '^(?:[01]\\d|2[0-3]):[0-5]\\d$');
    assert.deepEqual(botTool.tools.map(tool => tool.name), ['update_profile', 'update_config']);
    assert.deepEqual(Object.keys(botTool.tools[1].inputSchema.properties), ['model', 'permission']);
    assert.deepEqual(memoryTool.tools.map(tool => tool.name), ['save_memory', 'delete_memory']);
    assert.deepEqual(secretTool.tools.map(tool => tool.name), [
      'save_secret', 'list_secrets', 'rotate_secret', 'delete_secret', 'run_with_secret'
    ]);
    assert.deepEqual(Object.keys(secretTool.tools[0].inputSchema.properties), ['name', 'description', 'scope']);
    assert.deepEqual(Object.keys(secretTool.tools[2].inputSchema.properties), ['id']);
    assert.match(botTool.tools[0].description, /直接调用/);
    assert.equal(store.chatMemoryToolsEnabled(chat.id), true);
    assert.match(threadStart.params.developerInstructions, /默认以强自主性和规划能力工作/u);
    assert.match(threadStart.params.developerInstructions, /结合当前真正可用的 Tools、任务性质和 Routine 体系自主拆解步骤/u);
    assert.match(threadStart.params.developerInstructions, /不要把所有步骤都交回用户确认/u);
    assert.match(threadStart.params.developerInstructions, /rambo_secrets\.save_secret/u);
    assert.match(threadStart.params.developerInstructions, /rambo_secrets\.run_with_secret/u);
    assert.match(threadStart.params.developerInstructions, /主动整理创建 Routine/);
    assert.match(threadStart.params.developerInstructions, /不要逐项向用户索取已有或可可靠推断的信息/);
    assert.match(threadStart.params.developerInstructions, /安全或不可逆操作中造成实质歧义/);
    assert.match(threadStart.params.developerInstructions, /先判断任务性质与执行约束，再自主选择执行方式/u);
    assert.match(threadStart.params.developerInstructions, /确定性计算.*通常满足 script 的条件/u);
    assert.match(threadStart.params.developerInstructions, /相对时间.*换算成明确日期与 HH:mm/);
    assert.match(threadStart.params.developerInstructions, /不要提前计算或回答未来结果/);
    assert.match(threadStart.params.developerInstructions, /script\/hybrid 要写清可复用模板/);
    assert.match(threadStart.params.developerInstructions, /一次性定义仅在结果成功交回 Bot 私聊后自动清理/);
    assert.match(threadStart.params.developerInstructions, /本机后台服务执行/);
    assert.match(threadStart.params.developerInstructions, /工具成功返回后，以真实结果为准直接告知用户完成状态/);
    assert.match(threadStart.params.developerInstructions, /不要继续声称“正在创建”或“稍等”/);
    assert.match(threadStart.params.developerInstructions, /不需用户逐项批准/);
    const currentTime = runtime.requests.find(request => request.method === 'turn/start')
      ?.params.additionalContext?.['rambo.current-time']?.value ?? '';
    assert.match(currentTime, /绝对时间：\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u);
    assert.match(currentTime, /当前时间是 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    assert.match(currentTime, /时区：Asia\/Shanghai/);
    assert.match(currentTime, /相对时间换算/);

    const threadId = store.chat(chat.id).threadId;
    const params = {
      threadId, turnId: 'turn-1', callId: 'routine-call-1',
      namespace: 'rambo_routines', tool: 'create_routine',
      arguments: {
        title: 'Morning status',
        instruction: '只生成一行固定状态文本，不访问外部工具。',
        schedule: '每个工作日',
        triggerTime: '09:00',
        kind: 'recurring',
        executionMode: 'script',
        executionTemplate: '运行状态生成脚本并核对输出。'
      }
    };
    assert.equal(runtime.emit('serverRequest', { id: 41, method: 'item/tool/call', params }), true);
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].id, 41);
    assert.equal(runtime.responses[0].result.success, true);
    assert.match(runtime.responses[0].result.contentItems[0].text, /本机后台执行/);
    assert.match(
      runtime.responses[0].result.contentItems[0].text,
      /下次触发：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}（Asia\/Shanghai）/
    );
    assert.doesNotMatch(runtime.responses[0].result.contentItems[0].text, /T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    assert.match(runtime.responses[0].result.contentItems[0].text, /不要在本轮提前执行或回答/);

    const [saved] = store.routines();
    assert.equal(saved.botId, bot.id);
    assert.equal(saved.definition.instruction, params.arguments.instruction);
    assert.equal(saved.definition.schedule, params.arguments.schedule);
    assert.deepEqual(saved.definition.times, [params.arguments.triggerTime]);
    assert.equal(saved.definition.kind, 'recurring');
    assert.equal(saved.definition.frequency, 'weekdays');
    assert.equal(saved.definition.time, '09:00');
    assert.deepEqual(saved.definition.execution, {
      mode: 'script',
      template: '运行状态生成脚本并核对输出。'
    });
    assert.deepEqual(host.snapshot().routines, [saved]);
    assert.ok(events.some(event => event.type === 'changed'));
    assert.deepEqual(
      store.messages(chat.id).filter(message => message.role === 'system').map(message => message.text),
      ['已创建周期任务：Morning status']
    );

    runtime.emit('serverRequest', { id: 42, method: 'item/tool/call', params });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, true);
    assert.equal(store.routines().length, 1);
    assert.equal(store.routines()[0].id, saved.id);
    assert.equal(
      store.messages(chat.id).filter(message => message.role === 'system').length,
      1,
      '幂等重试不应重复写系统提示'
    );
    runtime.emit('notification', 'item/completed', {
      threadId, turnId: 'turn-1',
      item: { id: 'routine-created-reply', type: 'agentMessage', phase: 'final_answer', text: '任务已经创建，我会按计划执行。' }
    });
    const afterAgentReply = store.messages(chat.id);
    assert.match(afterAgentReply.find(message => message.itemId === 'routine-created-reply')?.text ?? '', /任务已经创建/);
    assert.equal(afterAgentReply.filter(message => message.role === 'system').length, 1);

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

test('Bot resource management writes a real system notice and cannot alter another Bot', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    store.syncBotResources(['skill:pdf', 'mcp:playwright'], ['skill:pdf']);
    const first = store.createBot('Resource Owner', 'a');
    const second = store.createBot('Untouched Bot', 'b');
    runtime.globalMcpServers = {};
    const sending = host.send(first.chat.id, '把 Skill pdf 开启给当前 Bot，但不要影响另一个 Bot。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadId = store.chat(first.chat.id).threadId;
    assert.equal(typeof threadId, 'string');
    const before = store.botResourceRecords(second.bot.id);

    runtime.emit('serverRequest', {
      id: 701,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'resource-turn',
        callId: 'resource-current-call',
        namespace: 'rambo_resources',
        tool: 'manage_resource',
        arguments: { action: 'set_current_bot', resource_id: 'skill:pdf', enabled: true }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    assert.equal(store.botResourceEnabled(first.bot.id, 'skill:pdf'), true);
    assert.deepEqual(store.botResourceRecords(second.bot.id), before);
    const resourceMessages = () => store.messages(first.chat.id).filter(message =>
      message.role === 'system' && message.text.includes('Skill')
    );
    const notices = resourceMessages();
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /当前 Bot/u);
    assert.ok(events.some(event => event.type === 'message' && event.message.id === notices[0].id));

    runtime.emit('serverRequest', {
      id: 702,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'resource-turn',
        callId: 'resource-cross-bot-call',
        namespace: 'rambo_resources',
        tool: 'manage_resource',
        arguments: { action: 'set_current_bot', bot_id: second.bot.id, resource_id: 'skill:pdf' }
      }
    });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, false);
    assert.match(runtime.responses[1].result.contentItems[0].text, /enabled|其他 Bot/u);
    assert.deepEqual(store.botResourceRecords(second.bot.id), before);
    assert.equal(resourceMessages().length, 1);

    runtime.emit('serverRequest', {
      id: 703,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'resource-turn',
        callId: 'resource-default-outside-global-call',
        namespace: 'rambo_resources',
        tool: 'manage_resource',
        arguments: { action: 'set_global_default', resource_id: 'skill:research', enabled: true }
      }
    });
    await waitFor(() => runtime.responses.length === 3);
    assert.equal(runtime.responses[2].result.success, false);
    assert.match(runtime.responses[2].result.contentItems[0].text, /全局可选目录/u);
    assert.deepEqual(store.botResourceRecords(first.bot.id), [
      { resourceId: 'skill:pdf', enabled: true },
      { resourceId: 'mcp:playwright', enabled: false }
    ]);
    assert.deepEqual(store.botResourceRecords(second.bot.id), before);
    assert.equal(resourceMessages().length, 1);

    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'resource-turn' } });
    await sending;
  });
});

test('Bot imports a local Skill folder into the global catalog and leaves existing Bot switches off', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const first = store.createBot('Skill Importer', 'a');
    const second = store.createBot('Skill Peer', 'b');
    runtime.globalMcpServers = {};
    const source = join(store.directory, 'fixture-skill');
    mkdirSync(join(source, 'scripts'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), [
      '---',
      'name: Fixture Importer',
      'description: Imported through a Bot tool.',
      '---',
      '',
      'Use the bundled script.'
    ].join('\n'));
    writeFileSync(join(source, 'scripts', 'run.sh'), '#!/bin/sh\necho fixture\n');

    const sending = host.send(first.chat.id, '安装我提供的本地 Skill 文件夹。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadId = store.chat(first.chat.id).threadId;
    const imported = await host.submitAcceptanceBotResourceTool({
      params: {
        threadId,
        turnId: 'skill-import-turn',
        callId: 'skill-import-call',
        namespace: 'rambo_resources',
        tool: 'import_local_skill',
        arguments: { directory: source }
      }
    });

    assert.equal(imported.result.success, true, JSON.stringify(imported.result));
    const resourceId = 'skill:fixture-skill';
    assert.equal(JSON.parse(store.settings().globalResourceIds).includes(resourceId), true);
    assert.equal(store.botResourceEnabled(first.bot.id, resourceId), false);
    assert.equal(store.botResourceEnabled(second.bot.id, resourceId), false);
    const resource = host.snapshot().botResources.find(item => item.id === resourceId);
    assert.equal(resource?.name, 'Fixture Importer');
    assert.equal(resource?.description, 'Imported through a Bot tool.');
    assert.equal(resource?.source, 'Rambo Skills');

    const notices = store.messages(first.chat.id).filter(message =>
      message.role === 'system' && message.text.includes('Fixture Importer')
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /全局可选目录/u);
    assert.match(notices[0].text, /已有 Bot 默认关闭/u);
    assert.equal(notices[0].text.includes(store.directory), false);
    assert.ok(events.some(event => event.type === 'message' && event.message.id === notices[0].id));

    await host.threadConfigForBot(host.workspace(first.bot), first.bot.id);
    assert.deepEqual(runtime.skillsExtraRoots, [join(store.directory, 'skill-library')]);
    assert.equal(runtime.requests.filter(request => request.method === 'skills/extraRoots/set').length, 1);

    const skillPath = join(store.directory, 'skill-library', 'fixture-skill', 'SKILL.md');
    runtime.skills = [{
      name: 'Fixture Importer',
      description: 'Imported through a Bot tool.',
      path: skillPath,
      enabled: true
    }];
    store.setBotResource(first.bot.id, resourceId, true);
    const ownerConfig = await host.threadConfigForBot(host.workspace(first.bot), first.bot.id);
    const peerConfig = await host.threadConfigForBot(host.workspace(second.bot), second.bot.id);
    assert.deepEqual(ownerConfig.skills.config, [{ path: skillPath, enabled: true }]);
    assert.deepEqual(peerConfig.skills.config, [{ path: skillPath, enabled: false }]);

    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'skill-import-turn' } });
    await sending;
  });
});

test('Skill root registration failure blocks thread configuration without fabricating success', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot } = store.createBot('Skill Failure Bot', 'a');
    runtime.failSkillRootRegistration = true;

    await assert.rejects(
      host.threadConfigForBot(host.workspace(bot), bot.id),
      /无法注册 Rambo Skills 目录.*fixture skill root rejection/u
    );
    assert.equal(runtime.requests.some(request => request.method === 'skills/list'), false);
  });
});

test('Bot adds a direct MCP definition with secrets, notices without secrets, and scopes the real thread config', async () => {
  await withCredentialHost(async ({ store, runtime, host, credentials }) => {
    const first = store.createBot('MCP Owner', 'a');
    const second = store.createBot('MCP Peer', 'b');
    runtime.globalMcpServers = {};
    const secret = 'MCP-ENV-SECRET-84719';
    const sending = host.send(first.chat.id, '添加这个直连 MCP，并把凭证保存起来。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadId = store.chat(first.chat.id).threadId;

    const added = await host.submitAcceptanceBotResourceTool({
      params: {
        threadId,
        turnId: 'direct-mcp-turn',
        callId: 'direct-mcp-add-call',
        namespace: 'rambo_resources',
        tool: 'add_direct_mcp',
        arguments: {
          name: 'fixture-mcp',
          description: 'Synthetic direct MCP',
          transport: 'stdio',
          command: 'node',
          args: ['fixture-server.mjs'],
          env: { FIXTURE_TOKEN: secret }
        }
      }
    });
    assert.equal(added.result.success, true, JSON.stringify(added.result));
    const server = store.directMcpServers()[0];
    assert.equal(server.name, 'fixture-mcp');
    assert.deepEqual(server.envKeys, ['FIXTURE_TOKEN']);
    assert.equal(JSON.stringify(store.settings()).includes(secret), false);
    assert.equal(JSON.stringify(store.directMcpServers()).includes(secret), false);
    assert.equal(JSON.stringify(store.messages(first.chat.id)).includes(secret), false);
    assert.equal(JSON.stringify(credentials.records.get(server.credentialRef)).includes(secret), true);

    const notices = store.messages(first.chat.id).filter(message =>
      message.role === 'system' && message.text.includes('fixture-mcp')
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /全局可选目录/u);
    assert.equal(notices[0].text.includes(secret), false);
    assert.equal(notices[0].text.includes('fixture-server.mjs'), false);

    const resourceId = 'mcp:fixture-mcp';
    store.setBotResource(first.bot.id, resourceId, true);
    assert.equal(store.botResourceEnabled(first.bot.id, resourceId), true);
    assert.equal(store.botResourceEnabled(second.bot.id, resourceId), false);

    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'direct-mcp-turn' } });
    await sending;

    store.setBotResource(first.bot.id, resourceId, true);
    const secondSend = host.send(second.chat.id, '检查另一个 Bot 的 MCP 范围。');
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/start').length === 2);
    const ownerThread = runtime.requests.filter(request => request.method === 'thread/start')[0];
    const peerThread = runtime.requests.filter(request => request.method === 'thread/start')[1];
    assert.deepEqual(ownerThread.params.config.mcp_servers['fixture-mcp'], undefined);
    assert.equal(peerThread.params.config.mcp_servers['fixture-mcp'], undefined);

    const ownerConfig = await host.threadConfigForBot(host.workspace(first.bot), first.bot.id);
    assert.deepEqual(ownerConfig.mcp_servers['fixture-mcp'], {
      command: 'node',
      args: ['fixture-server.mjs'],
      env: { FIXTURE_TOKEN: secret },
      enabled: true
    });

    const snapshot = host.snapshot();
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.equal(snapshot.directMcpServers[0].envKeys[0], 'FIXTURE_TOKEN');

    runtime.requests.filter(request => request.method === 'turn/start').at(-1)
      .resolve({ turn: { id: 'direct-mcp-peer-turn' } });
    await secondSend;
  });
});

test('Bot credential saving is private-chat-only, verified, persists only references, and writes one redacted notice', async () => {
  await withCredentialHost(async ({ store, runtime, host, events, credentials, verified }) => {
    const first = store.createBot('Credential Bot', 'a');
    const second = store.createBot('Other Bot', 'b');
    const sending = host.send(first.chat.id, '这是 QQ 授权码，请保存。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadId = store.chat(first.chat.id).threadId;
    assert.equal(typeof threadId, 'string');
    assert.equal(store.chatMemoryToolsEnabled(first.chat.id), true, JSON.stringify({
      chat: store.chat(first.chat.id),
      dynamicTools: runtime.requests.find(request => request.method === 'thread/start')?.params?.dynamicTools?.map(item => item.name)
    }));
    assert.equal(host.groupSessionsByChat.has(first.chat.id), false, JSON.stringify({
      group: host.groupSessionsByChat.get(first.chat.id),
      memory: store.chatMemoryToolsEnabled(first.chat.id)
    }));
    assert.equal(host.connectorCredentials, credentials);
    assert.equal(typeof host.mailRuntime?.withCredentialAdapter, 'function');
    host.threadChats.set(threadId, first.chat.id);
    host.loadedThreads.add(threadId);
    const secret = 'qq-secret-AUTH-CODE-92831';

    const saved = await host.submitAcceptanceBotCredentialTool({
      params: {
        threadId,
        turnId: 'credential-turn',
        callId: 'credential-save-call',
        namespace: 'rambo_credentials',
        tool: 'save_credential',
        arguments: {
          provider_id: 'qqmail',
          display_name: '工作 QQ 邮箱',
          email: 'person@qq.com',
          secret
        }
      }
    });
    assert.equal(saved.result.success, true, JSON.stringify(saved.result));
    assert.equal(store.connectorConnections().length, 1);
    const connection = store.connectorConnections()[0];
    assert.equal(connection.providerId, 'qqmail');
    assert.equal(connection.accountLabel, 'person@qq.com');
    assert.deepEqual(verified, [connection.id]);
    assert.equal(store.connectorCredentialRef(connection.id).startsWith('db:'), true);
    assert.equal(JSON.stringify(store.connectorConnections()).includes(secret), false);
    assert.equal(JSON.stringify(store.messages(first.chat.id)).includes(secret), false);
    assert.equal(JSON.stringify(store.messages(second.chat.id)).includes(secret), false);
    assert.deepEqual(store.connectorGrants(), []);
    assert.deepEqual(credentials.load(store.connectorCredentialRef(connection.id)), {
      kind: 'imap-password', email: 'person@qq.com', password: secret
    });
    const notices = store.messages(first.chat.id).filter(message =>
      message.role === 'system' && message.text.includes('QQ 邮箱')
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /已保存.*person@qq\.com.*已验证/u);
    assert.equal(notices[0].text.includes(secret), false);
    assert.ok(events.some(event => event.type === 'message' && event.message.id === notices[0].id));

    const gmailSecret = 'abcd efgh ijkl mnop';
    const gmailSaved = await host.submitAcceptanceBotCredentialTool({
      params: {
        threadId,
        turnId: 'credential-turn',
        callId: 'credential-gmail-save-call',
        namespace: 'rambo_credentials',
        tool: 'save_credential',
        arguments: {
          provider_id: 'gmail',
          display_name: '个人 Gmail',
          email: ' Owner@Gmail.com ',
          secret: gmailSecret
        }
      }
    });
    assert.equal(gmailSaved.result.success, true, JSON.stringify(gmailSaved.result));
    assert.equal(store.connectorConnections().length, 2);
    const gmailConnection = store.connectorConnections().find(item => item.providerId === 'gmail');
    assert.ok(gmailConnection);
    assert.equal(gmailConnection.authKind, 'credentials');
    assert.equal(gmailConnection.accountLabel, 'owner@gmail.com');
    assert.equal(verified.includes(gmailConnection.id), true);
    assert.deepEqual(credentials.load(store.connectorCredentialRef(gmailConnection.id)), {
      kind: 'imap-password', email: 'owner@gmail.com', password: 'abcdefghijklmnop'
    });
    assert.equal(JSON.stringify(store.messages(first.chat.id)).includes(gmailSecret), false);
    assert.equal(JSON.stringify(store.messages(first.chat.id)).includes('abcdefghijklmnop'), false);
    const gmailNotices = store.messages(first.chat.id).filter(message =>
      message.role === 'system' && message.text.includes('Gmail')
    );
    assert.equal(gmailNotices.length, 1);
    assert.match(gmailNotices[0].text, /已保存.*owner@gmail\.com.*已验证/u);
    assert.equal(gmailNotices[0].text.includes(gmailSecret), false);

    const rejected = await host.submitAcceptanceBotCredentialTool({
      params: {
        threadId,
        turnId: 'credential-turn',
        callId: 'credential-unknown-call',
        namespace: 'rambo_credentials',
        tool: 'save_credential',
        arguments: {
          provider_id: 'unsupported',
          display_name: 'Bad',
          email: 'bad@example.com',
          secret: 'must-not-be-written'
        }
      }
    });
    assert.equal(rejected.result.success, false);
    assert.match(rejected.result.contentItems[0].text, /只支持保存/u);
    assert.equal(store.connectorConnections().length, 2);
    assert.equal(store.messages(first.chat.id).filter(message =>
      message.role === 'system' && message.text.includes('QQ 邮箱')
    ).length, 1);

    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'credential-turn' } });
    await sending;
  });
});

test('credential verification failure writes nothing and credential updates preserve the previous secret', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { bot, chat } = store.createBot('Credential Update Bot', 'a');
    let failVerification = true;
    const records = new Map();
    const credentials = {
      save(_connectionId, payload) {
        const reference = 'db:11111111-1111-4111-8111-111111111111';
        records.set(reference, structuredClone(payload));
        return reference;
      },
      replace(reference, payload) {
        assert.equal(records.has(reference), true);
        records.set(reference, structuredClone(payload));
      },
      load(reference) { return structuredClone(records.get(reference)); },
      delete(reference) { records.delete(reference); }
    };
    const mailRuntime = new (await import(
      `${pathToFileURL(join(store.directory, 'mail-runtime.mjs')).href}?credential-failure-${Date.now()}`
    )).MailRuntime({
      async adapter() { throw new Error('unused'); },
      async adapterForCredential() {
        return {
          async verify() {
            if (failVerification) throw new Error('authorization rejected: new-secret-visible');
          }
        };
      }
    });
    const toolHost = new (await import(
      `${pathToFileURL(join(store.directory, 'host.mjs')).href}?credential-failure-${Date.now()}`
    )).Host(store, runtime, event => events.push(event), mailRuntime, credentials);
    host.dispose();
    try {
      store.bindThread(chat.id, 'credential-failure-thread', true, true);
      toolHost.threadChats.set('credential-failure-thread', chat.id);
      const first = await toolHost.submitAcceptanceBotCredentialTool({
        params: {
          threadId: 'credential-failure-thread',
          turnId: 'credential-failure-turn',
          callId: 'credential-failure-save',
          namespace: 'rambo_credentials',
          tool: 'save_credential',
          arguments: {
            provider_id: 'qqmail',
            display_name: 'QQ account',
            email: 'person@qq.com',
            secret: 'new-secret-visible'
          }
        }
      });
      assert.equal(first.result.success, false);
      assert.match(first.result.contentItems[0].text, /authorization rejected/);
      assert.equal(first.result.contentItems[0].text.includes('new-secret-visible'), false);
      assert.equal(store.connectorConnections().length, 0);
      assert.equal(records.size, 0);
      assert.equal(store.messages(chat.id).some(message => message.role === 'system'), false);

      failVerification = false;
      const initial = await toolHost.submitAcceptanceBotCredentialTool({
        params: {
          threadId: 'credential-failure-thread',
          turnId: 'credential-failure-turn',
          callId: 'credential-initial-save',
          namespace: 'rambo_credentials',
          tool: 'save_credential',
          arguments: {
            provider_id: 'qqmail',
            display_name: 'QQ account',
            email: 'person@qq.com',
            secret: 'original-secret'
          }
        }
      });
      assert.equal(initial.result.success, true);
      const connection = store.connectorConnections()[0];
      const reference = store.connectorCredentialRef(connection.id);
      assert.equal(records.get(reference).password, 'original-secret');

      failVerification = true;
      const update = await toolHost.submitAcceptanceBotCredentialTool({
        params: {
          threadId: 'credential-failure-thread',
          turnId: 'credential-failure-turn',
          callId: 'credential-failed-update',
          namespace: 'rambo_credentials',
          tool: 'save_credential',
          arguments: {
            connection_id: connection.id,
            email: 'person@qq.com',
            secret: 'replacement-secret'
          }
        }
      });
      assert.equal(update.result.success, false);
      assert.equal(records.get(reference).password, 'original-secret');
      assert.equal(store.connectorConnection(connection.id).status, 'ready');
      assert.equal(store.messages(chat.id).filter(message =>
        message.role === 'system' && message.text.includes('QQ 邮箱')
      ).length, 1);
    } finally {
      toolHost.dispose();
    }
  });
});

test('credential tools reject group sessions and unknown connection updates without writes', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const first = store.createBot('Credential A', 'a');
    const second = store.createBot('Credential B', 'b');
    store.bindThread(first.chat.id, 'credential-a-thread', true, true);
    const credentials = {
      records: new Map(),
      save() { throw new Error('must not save'); },
      replace() { throw new Error('must not replace'); },
      load() { throw new Error('must not load'); },
      delete() {}
    };
    const mailRuntime = new (await import(
      `${pathToFileURL(join(store.directory, 'mail-runtime.mjs')).href}?credential-scope-${Date.now()}`
    )).MailRuntime({
      async adapter() { throw new Error('unused'); },
      async adapterForCredential() { throw new Error('must not verify'); }
    });
    const toolHost = new (await import(
      `${pathToFileURL(join(store.directory, 'host.mjs')).href}?credential-scope-${Date.now()}`
    )).Host(store, runtime, event => events.push(event), mailRuntime, credentials);
    host.dispose();
    try {
      toolHost.threadChats.set('credential-a-thread', first.chat.id);
      const group = store.createGroup('Credential room', [first.bot.id, second.bot.id]);
      const memberChat = store.groupMemberChats(group.id)
        .find(chat => chat.botId === second.bot.id);
      assert.ok(memberChat);
      toolHost.threadChats.set('credential-group-thread', memberChat.id);
      toolHost.groupSessionsByChat.set(memberChat.id, {
        groupId: group.id, botId: second.bot.id, purpose: 'member'
      });
      const rejected = await toolHost.submitAcceptanceBotCredentialTool({
        params: {
          threadId: 'credential-group-thread',
          turnId: 'credential-group-turn',
          callId: 'credential-group-call',
          namespace: 'rambo_credentials',
          tool: 'save_credential',
          arguments: {
            provider_id: 'qqmail',
            display_name: 'Wrong scope',
            email: 'wrong@qq.com',
            secret: 'wrong-secret'
          }
        }
      });
      assert.equal(rejected.result.success, false);
      assert.match(rejected.result.contentItems[0].text, /唯一私聊/u);
      assert.equal(store.connectorConnections().length, 0);

      const unknownUpdate = await toolHost.submitAcceptanceBotCredentialTool({
        params: {
          threadId: 'credential-a-thread',
          turnId: 'credential-a-turn',
          callId: 'credential-unknown-update',
          namespace: 'rambo_credentials',
          tool: 'save_credential',
          arguments: {
            connection_id: 'missing-connection',
            email: 'person@qq.com',
            secret: 'must-not-be-written'
          }
        }
      });
      assert.equal(unknownUpdate.result.success, false);
      assert.match(unknownUpdate.result.contentItems[0].text, /连接不存在/u);
      assert.equal(store.connectorConnections().length, 0);
      assert.deepEqual(store.connectorGrants(), []);
      assert.equal(store.messages(first.chat.id).some(message => message.role === 'system'), false);
      assert.equal(store.messages(second.chat.id).some(message => message.role === 'system'), false);
    } finally {
      toolHost.dispose();
    }
  });
});

test('Bot secret tools encrypt references, isolate Bot scope, expose metadata, and redact execution output', async () => {
  await withSecretHost(async ({ store, runtime, host, events, credentials }) => {
    const first = store.createBot('Secret A', 'a');
    const second = store.createBot('Secret B', 'b');
    store.bindThread(first.chat.id, 'secret-a-thread', true, true);
    store.bindThread(second.chat.id, 'secret-b-thread', true, true);
    host.threadChats.set('secret-a-thread', first.chat.id);
    host.threadChats.set('secret-b-thread', second.chat.id);
    const call = (threadId, callId, tool, args = {}) =>
      host.submitAcceptanceBotSecretTool({
        params: {
          threadId,
          turnId: 'secret-turn',
          callId,
          namespace: 'rambo_secrets',
          tool,
          arguments: args
        }
      });
    const capturePrompt = async (name) => {
      let prompt;
      await waitFor(() => {
        prompt = events
          .filter(event => event.type === 'secretCapture' && event.prompt.name === name)
          .at(-1)?.prompt;
        return Boolean(prompt);
      });
      return prompt;
    };

    const privateSecret = 'private-secret-A-92831';
    const savingPrivate = call('secret-a-thread', 'secret-save-private', 'save_secret', {
      name: 'Deployment token',
      description: 'Only Secret A deploys this service',
      scope: 'bot'
    });
    const privatePrompt = await capturePrompt('Deployment token');
    assert.equal(privatePrompt.chatId, first.chat.id);
    assert.equal(privatePrompt.botId, first.bot.id);
    assert.equal(privatePrompt.operation, 'save');
    assert.equal(JSON.stringify(privatePrompt).includes(privateSecret), false);
    assert.equal(JSON.stringify(runtime.requests).includes(privateSecret), false);
    host.completeSecretCapture(privatePrompt.requestId, privateSecret);
    const saved = await savingPrivate;
    assert.equal(saved.result.success, true, JSON.stringify(saved.result));
    const savedPayload = JSON.parse(saved.result.contentItems[0].text);
    assert.equal(savedPayload.scope, 'bot');
    assert.equal(savedPayload.notice.includes(privateSecret), false);
    assert.equal(credentials.records.get(store.ownedBotSecrets(first.bot.id)[0].credentialRef).secret, privateSecret);
    assert.equal(JSON.stringify(store.botSecrets(first.bot.id)).includes(privateSecret), false);
    assert.equal(JSON.stringify(store.messages(first.chat.id)).includes(privateSecret), false);
    assert.equal(JSON.stringify(events).includes(privateSecret), false);

    const firstList = await call('secret-a-thread', 'secret-list-a', 'list_secrets');
    const firstListPayload = JSON.parse(firstList.result.contentItems[0].text);
    assert.deepEqual(firstListPayload.secrets, [{
      secret_id: savedPayload.secret_id,
      name: 'Deployment token',
      description: 'Only Secret A deploys this service',
      scope: 'bot'
    }]);
    assert.equal('botId' in firstListPayload.secrets[0], false);
    assert.equal(firstList.result.contentItems[0].text.includes(privateSecret), false);

    const secondList = await call('secret-b-thread', 'secret-list-b', 'list_secrets');
    assert.deepEqual(JSON.parse(secondList.result.contentItems[0].text).secrets, []);
    const crossRun = await call('secret-b-thread', 'secret-cross-run', 'run_with_secret', {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.TOKEN)'],
      secret_env: [{ secret_id: savedPayload.secret_id, env_name: 'TOKEN' }]
    });
    assert.equal(crossRun.result.success, false);
    assert.match(crossRun.result.contentItems[0].text, /无权访问/u);

    const globalSecret = 'global-secret-AB-18372';
    const savingGlobal = call('secret-a-thread', 'secret-save-global', 'save_secret', {
      name: 'Shared calendar token',
      scope: 'global'
    });
    const globalPrompt = await capturePrompt('Shared calendar token');
    host.completeSecretCapture(globalPrompt.requestId, globalSecret);
    const globalSaved = await savingGlobal;
    assert.equal(globalSaved.result.success, true, JSON.stringify(globalSaved.result));
    const secondGlobalList = await call('secret-b-thread', 'secret-global-list-b', 'list_secrets');
    const secondGlobalPayload = JSON.parse(secondGlobalList.result.contentItems[0].text);
    assert.equal(secondGlobalPayload.secrets.some(secret => secret.name === 'Shared calendar token'), true);
    assert.equal(secondGlobalList.result.contentItems[0].text.includes(globalSecret), false);

    const recordsBeforeDuplicate = credentials.records.size;
    const duplicate = await call('secret-a-thread', 'secret-duplicate', 'save_secret', {
      name: 'Deployment token',
      scope: 'bot'
    });
    assert.equal(duplicate.result.success, false);
    assert.match(duplicate.result.contentItems[0].text, /同名私有密钥/u);
    assert.equal(credentials.records.size, recordsBeforeDuplicate);

    const cancelling = call('secret-a-thread', 'secret-cancel', 'save_secret', {
      name: 'Cancelled token',
      scope: 'bot'
    });
    const cancelPrompt = await capturePrompt('Cancelled token');
    host.cancelSecretCapture(cancelPrompt.requestId);
    const cancelled = await cancelling;
    assert.equal(cancelled.result.success, false);
    assert.match(cancelled.result.contentItems[0].text, /取消了密钥保存/u);
    assert.equal(store.botSecrets(first.bot.id).some(secret => secret.name === 'Cancelled token'), false);

    const run = await call('secret-a-thread', 'secret-run', 'run_with_secret', {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(`prefix:${process.env.DEPLOY_TOKEN}:suffix`)'],
      secret_env: [{ secret_id: savedPayload.secret_id, env_name: 'DEPLOY_TOKEN' }],
      timeout_ms: 5_000
    });
    assert.equal(run.result.success, true, JSON.stringify(run.result));
    const runText = run.result.contentItems[0].text;
    assert.equal(runText.includes(privateSecret), false);
    assert.match(runText, /\[已隐藏\]/u);
    assert.match(runText, /"exit_code": 0/u);

    const outsideCwd = await call('secret-a-thread', 'secret-outside-cwd', 'run_with_secret', {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("should not run")'],
      secret_env: [{ secret_id: savedPayload.secret_id, env_name: 'DEPLOY_TOKEN' }],
      cwd: store.directory
    });
    assert.equal(outsideCwd.result.success, false);
    assert.match(outsideCwd.result.contentItems[0].text, /工作区内/u);
    assert.equal(outsideCwd.result.contentItems[0].text.includes(privateSecret), false);

    runtime.emit('notification', 'item/completed', {
      threadId: 'secret-a-thread',
      turnId: 'secret-activity-turn',
      item: {
        type: 'dynamicToolCall',
        id: 'secret-save-activity',
        namespace: 'rambo_secrets',
        tool: 'save_secret',
        status: 'completed',
        arguments: { name: 'leak', scope: 'bot', secret: 'activity-secret-leak' },
        contentItems: [{ type: 'inputText', text: 'saved' }]
      }
    });
    runtime.emit('notification', 'item/completed', {
      threadId: 'secret-a-thread',
      turnId: 'secret-activity-turn',
      item: {
        type: 'dynamicToolCall',
        id: 'credential-save-activity',
        namespace: 'rambo_credentials',
        tool: 'save_credential',
        status: 'completed',
        arguments: { secret: 'credential-activity-leak' },
        contentItems: [{ type: 'inputText', text: 'saved' }]
      }
    });
    const activities = store.activities(first.chat.id);
    assert.equal(activities.find(item => item.itemId === 'secret-save-activity').detail,
      '密钥正文已交给宿主加密处理，不写入 Rambo 活动记录。');
    assert.equal(activities.find(item => item.itemId === 'credential-save-activity').detail,
      '连接凭证已交给宿主加密处理，正文不写入 Rambo 活动记录。');
    assert.equal(JSON.stringify(activities).includes('activity-secret-leak'), false);
    assert.equal(JSON.stringify(activities).includes('credential-activity-leak'), false);

    const replacementSecret = 'rotated-secret-A-50291';
    const rotating = call('secret-a-thread', 'secret-rotate', 'rotate_secret', {
      id: savedPayload.secret_id
    });
    const rotatePrompt = await capturePrompt('Deployment token');
    assert.equal(rotatePrompt.operation, 'rotate');
    host.completeSecretCapture(rotatePrompt.requestId, replacementSecret);
    const rotated = await rotating;
    assert.equal(rotated.result.success, true, JSON.stringify(rotated.result));
    assert.equal(
      credentials.records.get(store.ownedBotSecrets(first.bot.id)[0].credentialRef).secret,
      replacementSecret
    );
    assert.equal(store.messages(first.chat.id).some(message =>
      message.role === 'system' && message.text.includes(replacementSecret)
    ), false);

    store.updateBot(first.bot.id, { permission: 'readOnly' });
    const readOnlyRun = await call('secret-a-thread', 'secret-readonly-run', 'run_with_secret', {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("must not run")'],
      secret_env: [{ secret_id: savedPayload.secret_id, env_name: 'DEPLOY_TOKEN' }]
    });
    assert.equal(readOnlyRun.result.success, false);
    assert.match(readOnlyRun.result.contentItems[0].text, /Full Access/u);

    const deleted = await call('secret-a-thread', 'secret-delete', 'delete_secret', {
      id: savedPayload.secret_id
    });
    assert.equal(deleted.result.success, true, JSON.stringify(deleted.result));
    assert.deepEqual(store.ownedBotSecrets(first.bot.id), []);
    assert.equal(credentials.records.has(store.botSecrets(first.bot.id)[0].credentialRef), true);
  });
});

test('a restarted Host restores secret tool guidance for an already registered thread', async () => {
  await withSecretHost(async ({ store, runtime, host, credentials, createHost }) => {
    const { chat } = store.createBot('Persistent secret tools', 'a');
    const firstSending = host.send(chat.id, 'start the persistent thread');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const firstStart = runtime.requests.find(request => request.method === 'thread/start');
    const secretTool = firstStart.params.dynamicTools.find(tool => tool.name === 'rambo_secrets');
    assert.deepEqual(secretTool.tools.map(tool => tool.name), [
      'save_secret', 'list_secrets', 'rotate_secret', 'delete_secret', 'run_with_secret'
    ]);
    const threadId = store.chat(chat.id).threadId;
    assert.ok(threadId);
    assert.deepEqual(store.secretToolThreadIds(), [threadId]);
    const firstTurn = runtime.requests.find(request => request.method === 'turn/start');
    firstTurn.resolve({ turn: { id: 'turn-secret-persist-1', status: 'inProgress' } });
    await firstSending;
    runtime.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: 'turn-secret-persist-1', status: 'completed' }
    });
    await waitFor(() => !host.activeTurns.has(chat.id));

    host.dispose();
    const resumedHost = createHost(undefined, credentials);
    const startsBeforeResume = runtime.requests.filter(request => request.method === 'thread/start').length;
    const resumedSending = resumedHost.send(chat.id, 'continue after restart');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/resume'));
    const resume = runtime.requests.filter(request => request.method === 'thread/resume').at(-1);
    assert.equal(runtime.requests.filter(request => request.method === 'thread/start').length, startsBeforeResume);
    assert.match(resume.params.developerInstructions, /rambo_secrets\.save_secret/u);
    assert.match(resume.params.developerInstructions, /宿主会弹出本机安全输入框/u);
    assert.equal('dynamicTools' in resume.params, false);
    const resumedTurn = runtime.requests.filter(request => request.method === 'turn/start').at(-1);
    resumedTurn.resolve({ turn: { id: 'turn-secret-persist-2', status: 'inProgress' } });
    await resumedSending;
  });
});

test('Routine and group member sessions inherit Bot secret reads but cannot manage secrets', async () => {
  await withSecretHost(async ({ store, runtime, host, credentials }) => {
    const first = store.createBot('Secret routine A', 'a');
    const second = store.createBot('Secret routine B', 'b');
    const secret = 'routine-readable-private-secret';
    const secretId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const credentialRef = credentials.save(secretId, {
      kind: 'generic-secret',
      name: 'Routine token',
      secret
    });
    store.createBotSecret({
      id: secretId,
      name: 'Routine token',
      description: 'Routine and group use',
      scope: 'bot',
      botId: first.bot.id,
      credentialRef
    });

    const group = store.createGroup('Secret group', [first.bot.id, second.bot.id]);
    await host.sendGroup(group.id, '@Secret routine A 读取可用密钥');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const groupThreadStart = runtime.requests.find(request => request.method === 'thread/start');
    const groupSecretTool = groupThreadStart.params.dynamicTools.find(tool => tool.name === 'rambo_secrets');
    assert.deepEqual(groupSecretTool.tools.map(tool => tool.name), ['list_secrets', 'run_with_secret']);
    assert.match(groupThreadStart.params.developerInstructions, /默认以强自主性和规划能力工作/u);
    const groupTurn = runtime.requests.find(request => request.method === 'turn/start');
    groupTurn.resolve({ turn: { id: 'secret-group-turn' } });
    await waitFor(() => store.groupSession(group.id, first.bot.id).threadId);
    const groupThreadId = store.groupSession(group.id, first.bot.id).threadId;
    const groupList = await host.submitAcceptanceBotSecretTool({
      params: {
        threadId: groupThreadId,
        turnId: 'secret-group-turn',
        callId: 'secret-group-list',
        namespace: 'rambo_secrets',
        tool: 'list_secrets',
        arguments: {}
      }
    });
    assert.equal(groupList.result.success, true);
    assert.equal(groupList.result.contentItems[0].text.includes(secret), false);
    assert.match(groupList.result.contentItems[0].text, /Routine token/u);
    const groupSave = await host.submitAcceptanceBotSecretTool({
      params: {
        threadId: groupThreadId,
        turnId: 'secret-group-turn',
        callId: 'secret-group-save',
        namespace: 'rambo_secrets',
        tool: 'save_secret',
        arguments: { name: 'Blocked', scope: 'bot' }
      }
    });
    assert.equal(groupSave.result.success, false);
    assert.match(groupSave.result.contentItems[0].text, /不能新增、轮换或删除/u);

    const routine = store.createRoutine({
      botId: first.bot.id,
      title: 'Secret routine',
      instruction: 'Use the Routine token',
      schedule: '每天 09:00',
      sourceCallId: 'secret-routine-context'
    });
    const run = store.createRoutineRun({
      routineId: routine.id,
      scheduledFor: '2026-10-28T09:00:00.000Z',
      trigger: 'manual',
      status: 'running'
    });
    const routineChat = store.createRoutineExecutionChat(run.id, first.bot.id, 'Secret routine run');
    const routineSending = host.runRoutineConversation(
      routineChat.id,
      'Use the saved credential',
      'Routine context',
      false
    );
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/start').length === 2);
    const routineThreadStart = runtime.requests.filter(request => request.method === 'thread/start')[1];
    const routineSecretTool = routineThreadStart.params.dynamicTools.find(tool => tool.name === 'rambo_secrets');
    assert.deepEqual(routineSecretTool.tools.map(tool => tool.name), ['list_secrets', 'run_with_secret']);
    assert.match(routineThreadStart.params.developerInstructions, /默认以强自主性和规划能力工作/u);
    const routineTurn = runtime.requests.filter(request => request.method === 'turn/start').at(-1);
    routineTurn.resolve({ turn: { id: 'secret-routine-turn' } });
    await routineSending;
    const routineThreadId = store.chat(routineChat.id).threadId;
    const routineList = await host.submitAcceptanceBotSecretTool({
      params: {
        threadId: routineThreadId,
        turnId: 'secret-routine-turn',
        callId: 'secret-routine-list',
        namespace: 'rambo_secrets',
        tool: 'list_secrets',
        arguments: {}
      }
    });
    assert.equal(routineList.result.success, true);
    assert.match(routineList.result.contentItems[0].text, /Routine token/u);
    const routineDelete = await host.submitAcceptanceBotSecretTool({
      params: {
        threadId: routineThreadId,
        turnId: 'secret-routine-turn',
        callId: 'secret-routine-delete',
        namespace: 'rambo_secrets',
        tool: 'delete_secret',
        arguments: { id: secretId }
      }
    });
    assert.equal(routineDelete.result.success, false);
    assert.match(routineDelete.result.contentItems[0].text, /不能新增、轮换或删除/u);
    assert.equal(store.botSecretForBot(secretId, first.bot.id).scope, 'bot');
  });
});

test('routine creation rejects a missing or invalid trigger time and asks the Bot to clarify first', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
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

test('routine tools accept one recurring definition with arbitrary times and reject unsafe schedules', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { chat } = store.createBot('Multi-time tool Bot', 'a');
    const sending = host.send(chat.id, '每天 0 点、1:30、4:50 检查一次。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadId = store.chat(chat.id).threadId;
    const base = {
      threadId, turnId: 'turn-multi-time', namespace: 'rambo_routines', tool: 'create_routine'
    };

    runtime.emit('serverRequest', {
      id: 63, method: 'item/tool/call',
      params: {
        ...base, callId: 'multi-time-create',
        arguments: {
          title: 'Mail checks', instruction: 'Check the mailbox.',
          schedule: '每天', kind: 'recurring',
          triggerTimes: ['04:50', '00:00', '01:30', '01:30']
        }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    assert.match(
      runtime.responses[0].result.contentItems[0].text,
      /一天内触发时刻：00:00、01:30、04:50/u
    );
    const routines = store.routines();
    assert.equal(routines.length, 1);
    assert.deepEqual(routines[0].definition.times, ['00:00', '01:30', '04:50']);
    assert.equal(routines[0].definition.time, '00:00');

    runtime.emit('serverRequest', {
      id: 64, method: 'item/tool/call',
      params: {
        ...base, callId: 'interval-create',
        arguments: {
          title: 'Unsafe interval', instruction: 'Check every half hour.',
          schedule: '每天每 30 分钟', kind: 'recurring', triggerTime: '09:00'
        }
      }
    });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, false);
    assert.match(runtime.responses[1].result.contentItems[0].text, /不支持.*每 N 分钟.*triggerTimes/u);
    assert.equal(store.routines().length, 1);

    runtime.emit('serverRequest', {
      id: 65, method: 'item/tool/call',
      params: {
        ...base, callId: 'unknown-create',
        arguments: {
          title: 'Unknown schedule', instruction: 'Do the work.',
          schedule: '隔天一次', kind: 'recurring', triggerTimes: ['09:00']
        }
      }
    });
    await waitFor(() => runtime.responses.length === 3);
    assert.equal(runtime.responses[2].result.success, false);
    assert.match(runtime.responses[2].result.contentItems[0].text, /无法识别周期表达/u);
    assert.equal(store.routines().length, 1);

    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'turn-multi-time' } });
    await sending;
  });
});

test('routine update replaces times by list or single trigger without retaining stale values', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Update tool Bot', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Mail checks', instruction: 'Check the mailbox.',
      schedule: '每天', time: '00:00',
      triggerTimes: ['00:00', '01:30', '04:50'],
      sourceCallId: 'update-tool-routine'
    });
    const sending = host.send(chat.id, '把检查时间改成 6:15 和 22:00，再改成 23:45。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const threadId = store.chat(chat.id).threadId;
    const params = {
      threadId, turnId: 'turn-update-time', namespace: 'rambo_routines', tool: 'update_routine'
    };

    runtime.emit('serverRequest', {
      id: 66, method: 'item/tool/call',
      params: {
        ...params, callId: 'update-time-list',
        arguments: { id: routine.id, triggerTimes: ['22:00', '06:15'] }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    assert.match(
      runtime.responses[0].result.contentItems[0].text,
      /一天内触发时刻：06:15、22:00/u
    );
    assert.deepEqual(store.routine(routine.id).definition.times, ['06:15', '22:00']);
    assert.equal(store.routine(routine.id).definition.time, '06:15');

    runtime.emit('serverRequest', {
      id: 67, method: 'item/tool/call',
      params: {
        ...params, callId: 'update-time-single',
        arguments: { id: routine.id, triggerTime: '23:45' }
      }
    });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, true);
    assert.match(
      runtime.responses[1].result.contentItems[0].text,
      /一天内触发时刻：23:45/u
    );
    assert.deepEqual(store.routine(routine.id).definition.times, ['23:45']);
    assert.equal(store.routine(routine.id).definition.time, '23:45');

    runtime.requests.find(request => request.method === 'turn/start')
      .resolve({ turn: { id: 'turn-update-time' } });
    await sending;
  });
});

test('thread resume does not resubmit dynamic tools and a legacy thread still rejects missing tools', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Assistant', 'a');
    store.bindThread(chat.id, 'legacy-thread', false);
    host.threadChats.set('legacy-thread', chat.id);

    const sending = host.send(chat.id, 'continue this existing thread');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const resume = runtime.requests.find(request => request.method === 'thread/resume');
    assert.equal('dynamicTools' in resume.params, false);
    assert.equal(resume.params.developerInstructions.includes('rambo_routines.create_routine'), false);
    assert.equal(resume.params.developerInstructions.includes('rambo_memories.save_memory'), false);
    assert.equal(resume.params.developerInstructions.includes('rambo_secrets.save_secret'), false);
    assert.equal(resume.params.developerInstructions.includes('rambo_secrets.run_with_secret'), false);

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
    const profileTool = threadStart.params.dynamicTools.find(namespace => namespace.name === 'rambo_bot').tools[0];
    assert.match(memoryTool.description, /稳定.*跨 Bot.*aboutMe/u);
    assert.match(memoryTool.description, /只适用于当前 Bot.*scope=bot/u);
    assert.match(memoryTool.description, /放到你的记忆里.*默认 scope=bot/u);
    assert.match(memoryTool.description, /行为规则不得保存到这里.*长期指令/u);
    assert.match(memoryTool.description, /同一信息只保留一个权威位置/u);
    assert.match(memoryTool.description, /success=true.*已保存/u);
    assert.match(memoryTool.inputSchema.properties.scope.description, /默认 bot/u);
    assert.match(memoryTool.inputSchema.properties.scope.description, /行为规则不要存记忆/u);
    assert.match(profileTool.description, /role 只写一句话职责/u);
    assert.match(profileTool.description, /instructions 写当前 Bot 以后应稳定遵循的行为规则/u);
    assert.match(profileTool.description, /不要把事实、身份映射或背景资料塞进长期指令/u);
    assert.match(profileTool.inputSchema.properties.role.description, /只写角色目的/u);
    assert.match(profileTool.inputSchema.properties.instructions.description, /不写事实、身份映射或背景资料/u);
    assert.match(threadStart.params.developerInstructions, /关于我（scope=aboutMe）只写明确跨 Bot 通用/u);
    assert.match(threadStart.params.developerInstructions, /Bot 私有记忆（scope=bot）只写当前 Bot/u);
    assert.match(threadStart.params.developerInstructions, /长期指令（instructions）只写当前 Bot.*行为规则/u);
    assert.match(threadStart.params.developerInstructions, /Bot 私有记忆（scope=bot）只写当前 Bot.*事实/u);
    assert.match(threadStart.params.developerInstructions, /同一信息只保留一个权威位置/u);
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

test('self-managed config changes only the current Bot and not new-Bot defaults', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Config Bot', 'a');
    const second = store.createBot('Other Bot', 'b');
    const originalDefaultModel = store.settings().defaultBotModel;
    const originalDefaultPermission = store.settings().defaultBotPermission;
    store.setSetting('defaultBotModel', 'new-bot-default');
    store.setSetting('defaultBotPermission', 'readOnly');
    const threadId = 'self-config-thread';
    store.bindThread(first.chat.id, threadId, true, true);
    host.threadChats.set(threadId, first.chat.id);

    const sending = host.send(first.chat.id, '把你自己的当前会话设置改掉。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    emitTurnStarted(runtime, threadId, 'self-config');
    runtime.emit('serverRequest', {
      id: 73, method: 'item/tool/call',
      params: {
        threadId, turnId: 'self-config', callId: 'self-config-call',
        namespace: 'rambo_bot', tool: 'update_config',
        arguments: {
          model: 'self-bot-model', permission: 'workspaceWrite'
        }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true, runtime.responses[0].result.contentItems?.[0]?.text);
    assert.equal(store.bot(first.bot.id).model, 'self-bot-model');
    assert.equal(store.bot(first.bot.id).permission, 'workspaceWrite');
    assert.equal(store.chat(first.chat.id).model, null);
    assert.equal(store.chat(first.chat.id).permission, null);
    assert.equal(store.bot(second.bot.id).model, originalDefaultModel);
    assert.equal(store.bot(second.bot.id).permission, originalDefaultPermission);
    assert.equal(store.settings().defaultBotModel, 'new-bot-default');
    assert.equal(store.settings().defaultBotPermission, 'readOnly');
    assert.deepEqual(store.routines(), []);

    runtime.requests.find(request => request.method === 'turn/start').resolve({ turn: { id: 'self-config' } });
    await sending;
  });
});

test('self-managed config rejects legacy and global fields without changing data', async () => {
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
        arguments: { chatModel: 'legacy-session-model' }
      }
    });
    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, false);
    assert.match(runtime.responses[0].result.contentItems[0].text, /不支持修改 Bot 执行配置字段：chatModel/u);

    runtime.emit('serverRequest', {
      id: 75, method: 'item/tool/call',
      params: {
        threadId, turnId: 'strict-self-config', callId: 'strict-self-extra',
        namespace: 'rambo_bot', tool: 'update_config',
        arguments: { model: 'bot-model', globalPermission: 'readOnly' }
      }
    });
    await waitFor(() => runtime.responses.length === 2);
    assert.equal(runtime.responses[1].result.success, false);
    assert.match(runtime.responses[1].result.contentItems[0].text, /不支持修改 Bot 执行配置字段：globalPermission/u);
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
  await withHost(async ({ store, runtime, host, events }) => {
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
      ['update_routine', {
        id: routine.id, title: 'Updated', instruction: 'Changed only future runs', schedule: '每周一 10:30',
        executionMode: 'hybrid', executionTemplate: '先判断优先级，再运行导出脚本。'
      }],
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
        assert.deepEqual(store.routine(routine.id).definition.execution, {
          mode: 'hybrid',
          template: '先判断优先级，再运行导出脚本。'
        });
      }
      if (tool === 'set_routine_status' && index === 1) assert.equal(store.routine(routine.id).status, 'paused');
      if (tool === 'set_routine_status' && index === 2) assert.equal(store.routine(routine.id).status, 'active');
    }
    assert.throws(() => store.routine(routine.id), /定时任务不存在/);
    const notices = store.messages(first.chat.id).filter(message => message.role === 'system');
    assert.deepEqual(notices.map(message => message.text), [
      '已更新定时任务：Updated',
      '已暂停定时任务：Updated',
      '已恢复定时任务：Updated',
      '已删除定时任务：Updated'
    ]);
    assert.equal(events.filter(event => event.type === 'message' && event.message.role === 'system').length, 4);
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
    store.setSetting('defaultBotModel', 'bot-model');
    store.setSetting('defaultBotPermission', 'readOnly');
    runtime.globalMcpServers = {
      localServer: { description: 'Local only' }
    };
    const { chat } = store.createBot('Assistant', 'a');

    const sending = host.send(chat.id, 'first message');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    assert.equal('dynamicTools' in threadStart.params, true);
    assert.equal(start.params.model, 'bot-model');
    assert.equal(start.params.approvalPolicy, 'on-request');
    assert.deepEqual(start.params.sandboxPolicy, { type: 'readOnly' });
    assert.deepEqual({ ...threadStart.params.config.mcp_servers }, {
      localServer: { enabled: false }
    });
    assert.deepEqual(threadStart.params.config.features, { apps: false, plugins: false });
    assert.equal(JSON.stringify(threadStart.params.config).includes('must-not-forward'), false);

    const threadId = store.chat(chat.id).threadId;
    assert.equal(typeof threadId, 'string');
    runtime.emit('notification', 'turn/started', {
      threadId, turn: { id: 'turn-1', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) }
    });
    runtime.emit('notification', 'model/rerouted', {
      threadId, turnId: 'turn-1', fromModel: 'bot-model', toModel: 'rerouted-model', reason: 'highRiskCyberActivity'
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
    assert.equal(turn.requestedModel, 'bot-model');
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
    store.setSetting('defaultBotModel', 'local-global-model');
    const { chat } = store.createBot('Assistant', 'a');
    const sending = host.send(chat.id, 'use global default');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(start.params.model, 'local-global-model');
    assert.equal(runtime.requests.some(request => request.method === 'model/list'), false);
    start.resolve({ turn: { id: 'turn-global', status: 'inProgress' } });
    await sending;

    const [turn] = store.turns(chat.id);
    assert.equal(turn.modelSource, 'bot');
    assert.equal(turn.requestedModel, 'local-global-model');
    assert.equal(turn.threadModelAtRequest, 'thread-response-model');
    assert.equal(turn.serverResolvedModel, null);
    assert.equal(turn.resolutionSource, 'unknown');
  });
});

test('Rambo app global model takes precedence over the local Codex global model', async () => {
  await withHost(async ({ store, runtime, host }) => {
    store.setSetting('defaultBotModel', 'rambo-app-default-model');
    store.setSetting('defaultBotPermission', 'workspaceWrite');
    const { bot, chat } = store.createBot('Assistant', 'a');
    store.setSetting('defaultBotModel', 'rambo-app-next-default-model');
    store.setSetting('defaultBotPermission', 'readOnly');
    const sending = host.send(chat.id, 'use the Bot execution snapshot');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(start.params.model, 'rambo-app-default-model');
    assert.deepEqual(start.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [join(store.directory, 'bots', bot.id, 'workspace')],
      networkAccess: true
    });
    start.resolve({ turn: { id: 'turn-app-global', status: 'inProgress' } });
    await sending;

    const [turn] = store.turns(chat.id);
    assert.equal(turn.modelSource, 'bot');
    assert.equal(turn.requestedModel, 'rambo-app-default-model');
    assert.equal(turn.permissionSnapshot.permission, 'workspaceWrite');
    assert.equal(turn.threadModelAtRequest, 'thread-response-model');
  });
});

test('Bot model and permission remain independent after creation and override legacy chat fields', async () => {
  await withHost(async ({ store, runtime, host }) => {
    store.setSetting('defaultBotModel', 'creation-model');
    store.setSetting('defaultBotPermission', 'workspaceWrite');
    const { bot, chat } = store.createBot('Session override', 'a');
    store.updateBot(bot.id, { model: 'independent-bot-model', permission: 'fullAccess' });
    store.updateChat(chat.id, { model: 'session-model', permission: 'readOnly' });

    const sending = host.send(chat.id, 'use the independent Bot configuration');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(start.params.model, 'independent-bot-model');
    assert.deepEqual(start.params.sandboxPolicy, { type: 'dangerFullAccess' });
    start.resolve({ turn: { id: 'turn-session-override', status: 'inProgress' } });
    await sending;

    const [turn] = store.turns(chat.id);
    assert.equal(turn.modelSource, 'bot');
    assert.equal(turn.requestedModel, 'independent-bot-model');
    assert.equal(turn.permissionSnapshot.permission, 'fullAccess');
  });
});

test('a running turn keeps its model and permission while steering uses the next turn configuration', async () => {
  await withHost(async ({ store, runtime, host }) => {
    store.setSetting('defaultBotModel', 'global-model-old');
    store.setSetting('defaultBotPermission', 'workspaceWrite');
    const { bot } = store.createBot('Configuration snapshot', 'a');
    const chat = store.ensureBotChat(bot.id);
    const sending = host.send(chat.id, 'start with old configuration');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const firstStart = runtime.requests.find(request => request.method === 'turn/start');
    assert.equal(firstStart.params.model, 'global-model-old');
    assert.deepEqual(firstStart.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [join(store.directory, 'bots', bot.id, 'workspace')],
      networkAccess: true
    });
    firstStart.resolve({ turn: { id: 'turn-config-old', status: 'inProgress' } });
    await sending;

    store.updateBotExecutionConfig(bot.id, {
      model: 'bot-model-new',
      permission: 'readOnly'
    });
    const steering = host.send(chat.id, 'change direction while running');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/steer'));
    const steer = runtime.requests.find(request => request.method === 'turn/steer');
    assert.equal('model' in steer.params, false);
    assert.equal('approvalPolicy' in steer.params, false);
    assert.equal('sandboxPolicy' in steer.params, false);
    await steering;
    assert.equal(store.turns(chat.id)[0].requestedModel, 'global-model-old');
    assert.equal(store.turns(chat.id)[0].permissionSnapshot.permission, 'workspaceWrite');

    runtime.emit('notification', 'turn/completed', {
      threadId: store.chat(chat.id).threadId,
      turn: { id: 'turn-config-old', status: 'completed' }
    });
    const next = host.send(chat.id, 'start with new configuration');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const nextStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.equal(nextStart.params.model, 'bot-model-new');
    assert.deepEqual(nextStart.params.sandboxPolicy, { type: 'readOnly' });
    assert.equal(nextStart.params.approvalPolicy, 'on-request');
    nextStart.resolve({ turn: { id: 'turn-config-new', status: 'inProgress' } });
    await next;

    const turns = store.turns(chat.id);
    assert.equal(turns[1].requestedModel, 'bot-model-new');
    assert.equal(turns[1].permissionSnapshot.permission, 'readOnly');
  });
});

test('Routine execution is isolated from the Bot private chat and hands the full result back to the Bot conversation', async () => {
  await withHost(async ({ store, runtime, host }) => {
    store.setSetting('defaultBotModel', 'routine-creation-model');
    store.setSetting('defaultBotPermission', 'workspaceWrite');
    const { bot, chat } = store.createBot('Routine isolation', 'a');
    store.setSetting('defaultBotModel', 'routine-next-default-model');
    store.setSetting('defaultBotPermission', 'readOnly');
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
    assert.equal(turnStart.params.model, 'routine-creation-model');
    assert.deepEqual(turnStart.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [join(store.directory, 'bots', bot.id, 'workspace')],
      networkAccess: true
    });
    assert.equal(turnStart.params.approvalPolicy, 'on-request');
    assert.equal(store.chat(chat.id).threadId, null);
    assert.deepEqual(
      Object.keys(turnStart.params.additionalContext).sort(),
      ['rambo.current-time', 'rambo.profile-rules', 'rambo.routine-context'].sort()
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
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const handoffStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    assert.notEqual(handoffStart.params.threadId, executionChat.threadId);
    assert.equal(handoffStart.params.threadId, store.chat(chat.id).threadId);
    assert.match(
      handoffStart.params.additionalContext?.['rambo.routine-context']?.value ?? '',
      /Routine「Private context isolation」返回给当前 Bot 私聊/u
    );
    assert.equal(store.messages(chat.id).some(message => message.role === 'system'), false);
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

test('script and hybrid Routine execution stay in independent Codex turns with their templates', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot } = store.createBot('Script Routine', 'a');
    const script = store.createRoutine({
      botId: bot.id,
      title: 'Script export',
      instruction: '生成导出文件',
      schedule: '每天 09:00',
      sourceCallId: 'script-execution',
      executionMode: 'script',
      executionTemplate: '运行 export.mjs，并核对输出文件。'
    });
    const hybrid = store.createRoutine({
      botId: bot.id,
      title: 'Hybrid review',
      instruction: '判断后生成总结',
      schedule: '每天 10:00',
      sourceCallId: 'hybrid-execution',
      executionMode: 'hybrid',
      executionTemplate: '先选择输入，再运行 summarize.mjs。'
    });

    const scriptRun = host.routineScheduler.runNow(script.id);
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const scriptStart = runtime.requests.find(request => request.method === 'turn/start');
    const scriptContext = scriptStart.params.additionalContext?.['rambo.routine-context']?.value ?? '';
    assert.match(scriptContext, /本次要求以脚本方式执行/u);
    assert.match(scriptContext, /运行 export\.mjs/u);
    assert.match(scriptContext, /不得绕过当前 Codex 权限/u);
    scriptStart.resolve({ turn: { id: 'script-routine-turn', status: 'inProgress' } });
    await scriptRun;
    const scriptChatId = store.routineRuns(script.id)[0].chatId;
    assert.equal(store.chat(scriptChatId).threadId, scriptStart.params.threadId);

    const hybridRun = host.routineScheduler.runNow(hybrid.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const hybridStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    const hybridContext = hybridStart.params.additionalContext?.['rambo.routine-context']?.value ?? '';
    assert.match(hybridContext, /结合对话判断与脚本执行/u);
    assert.match(hybridContext, /summarize\.mjs/u);
    hybridStart.resolve({ turn: { id: 'hybrid-routine-turn', status: 'inProgress' } });
    await hybridRun;
    const hybridChatId = store.routineRuns(hybrid.id)[0].chatId;
    assert.notEqual(scriptStart.params.threadId, hybridStart.params.threadId);
    assert.equal(store.chat(hybridChatId).threadId, hybridStart.params.threadId);
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
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 3);
    const handoffStart = runtime.requests.filter(request => request.method === 'turn/start')[2];
    assert.equal(handoffStart.params.threadId, store.chat(sourceChat.id).threadId);
    assert.equal(store.messages(sourceChat.id).some(message => message.role === 'system'), false);
    assert.equal(store.messages(sourceChat.id).some(message => message.role === 'user'), false);
    assert.equal(host.activeTurns.get(executionChat.id), 'stop-one-run-turn');
    assert.equal(store.routineRuns(other.id)[0].status, 'running');
    assert.equal(host.activeTurns.get(store.routineRuns(other.id)[0].chatId), 'independent-run-turn');
  });
});

test('stopping a Routine whose turn already ended records interruption without surfacing a stale RPC error', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot } = store.createBot('Already Finished Routine', 'a');
    const routine = store.createRoutine({
      botId: bot.id,
      title: 'A run that finished before stop',
      instruction: '运行结束后用户才点击停止',
      schedule: '每天 09:00',
      sourceCallId: 'already-finished-routine'
    });
    const runPromise = host.routineScheduler.runNow(routine.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'already-finished-turn', status: 'inProgress' } });
    await runPromise;
    const run = store.routineRuns(routine.id)[0];
    assert.equal(run.status, 'running');
    runtime.request = async (method, params = {}, timeoutMs, options) => {
      runtime.requests.push({ method, params, options });
      if (method === 'turn/interrupt') {
        throw new Error("Error invoking remote method 'rambo:stopRoutineRun': Error: no active turn to interrupt");
      }
      return FakeRuntime.prototype.request.call(runtime, method, params, timeoutMs, options);
    };

    const stopped = await host.stopRoutineRun(run.id);
    assert.equal(stopped.status, 'interrupted');
    assert.match(stopped.error ?? '', /用户停止/u);
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

test('a Routine result waits for the source chat to become idle before handing back', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { bot, chat } = store.createBot('Busy routine Bot', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Wait for idle', instruction: '生成等待结果',
      schedule: '每天', time: '09:30', sourceCallId: 'wait-for-idle'
    });

    const sourceSending = host.send(chat.id, '先处理当前问题');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const sourceStart = runtime.requests.find(request => request.method === 'turn/start');
    sourceStart.resolve({ turn: { id: 'source-active-turn', status: 'inProgress' } });
    await sourceSending;
    const sourceThreadId = store.chat(chat.id).threadId;

    const running = host.routineScheduler.runNow(routine.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const routineStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    const routineThreadId = routineStart.params.threadId;
    routineStart.resolve({ turn: { id: 'routine-wait-turn', status: 'inProgress' } });
    await running;

    runtime.emit('notification', 'item/completed', {
      threadId: routineThreadId,
      turnId: 'routine-wait-turn',
      item: { id: 'routine-wait-result', type: 'agentMessage', text: '等待后的完整结果' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: routineThreadId,
      turn: { id: 'routine-wait-turn', status: 'completed', error: null }
    });
    await waitFor(() => store.routineRuns(routine.id)[0].status === 'succeeded');
    assert.equal(events.some(event => event.type === 'routineResultDeliveryStarted'), false);
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(runtime.requests.filter(request => request.method === 'turn/start').length, 2);
    assert.equal(runtime.requests.some(request => request.method === 'turn/steer'), false);

    runtime.emit('notification', 'turn/completed', {
      threadId: sourceThreadId,
      turn: { id: 'source-active-turn', status: 'completed', error: null }
    });
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 3);
    await waitFor(() => events.some(event => event.type === 'routineResultDeliveryStarted'));
    assert.equal(
      events.find(event => event.type === 'routineResultDeliveryStarted').chatId,
      chat.id
    );
    assert.equal(events.some(event => event.type === 'routineResultDeliveryFinished'), false);
    assert.equal(
      runtime.requests.filter(request => request.method === 'turn/start')[2].params.threadId,
      sourceThreadId
    );
    assert.equal(store.messages(chat.id).some(message => message.role === 'system'), false);
  });
});

test('a completed Routine handoff stores only the Bot natural-language reply in the source chat', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { bot, chat } = store.createBot('Natural routine Bot', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Natural reply', instruction: '整理完整结果',
      schedule: '每天', time: '09:30', sourceCallId: 'natural-reply'
    });
    const detailed = `详细结果：${'内容'.repeat(900)}`;

    const running = host.routineScheduler.runNow(routine.id);
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const routineStart = runtime.requests.find(request => request.method === 'turn/start');
    const routineThreadId = routineStart.params.threadId;
    routineStart.resolve({ turn: { id: 'natural-routine-turn', status: 'inProgress' } });
    await running;

    runtime.emit('notification', 'item/completed', {
      threadId: routineThreadId,
      turnId: 'natural-routine-turn',
      item: { id: 'natural-routine-result', type: 'agentMessage', text: detailed }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: routineThreadId,
      turn: { id: 'natural-routine-turn', status: 'completed', error: null }
    });
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const handoff = runtime.requests.filter(request => request.method === 'turn/start')[1];
    handoff.resolve({ turn: { id: 'natural-handoff-turn', status: 'inProgress' } });
    const sourceThreadId = handoff.params.threadId;

    runtime.emit('notification', 'item/completed', {
      threadId: sourceThreadId,
      turnId: 'natural-handoff-turn',
      item: { id: 'natural-handoff-reply', type: 'agentMessage', text: '任务已经完成，我整理了完整结果。' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: sourceThreadId,
      turn: { id: 'natural-handoff-turn', status: 'completed', error: null }
    });
    await waitFor(() => events.some(event => event.type === 'routineResultDeliveryFinished'));

    const messages = store.messages(chat.id);
    assert.deepEqual(messages.map(message => [message.role, message.text]), [
      ['assistant', '任务已经完成，我整理了完整结果。']
    ]);
    assert.equal(store.routineRuns(routine.id)[0]?.summary, detailed);
    const handoffSource = handoff.params.additionalContext?.['rambo.routine-context']?.value ?? '';
    assert.match(handoffSource, /返回给当前 Bot 私聊/u);
    const finished = events.find(event => event.type === 'routineResultDeliveryFinished');
    assert.equal(store.routineRun(finished.runId).status, 'succeeded');
    assert.equal(
      events.find(event => event.type === 'routineResultDeliveryStarted').runId,
      finished.runId
    );
  });
});

test('two Routine results for the same source chat are handed back one after another', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot, chat } = store.createBot('Queued delivery Bot', 'a');
    const first = store.createRoutine({
      botId: bot.id, title: 'First delivery', instruction: '第一个结果',
      schedule: '每天', time: '09:00', sourceCallId: 'first-delivery'
    });
    const second = store.createRoutine({
      botId: bot.id, title: 'Second delivery', instruction: '第二个结果',
      schedule: '每天', time: '10:00', sourceCallId: 'second-delivery'
    });

    const firstRunning = host.routineScheduler.runNow(first.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const firstStart = runtime.requests.filter(request => request.method === 'turn/start')[0];
    const firstThreadId = firstStart.params.threadId;
    firstStart.resolve({ turn: { id: 'first-delivery-turn', status: 'inProgress' } });
    await firstRunning;

    const secondRunning = host.routineScheduler.runNow(second.id);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const secondStart = runtime.requests.filter(request => request.method === 'turn/start')[1];
    const secondThreadId = secondStart.params.threadId;
    secondStart.resolve({ turn: { id: 'second-delivery-turn', status: 'inProgress' } });
    await secondRunning;

    for (const [threadId, turnId, text] of [
      [firstThreadId, 'first-delivery-turn', '第一条完整结果'],
      [secondThreadId, 'second-delivery-turn', '第二条完整结果']
    ]) {
      runtime.emit('notification', 'item/completed', {
        threadId,
        turnId,
        item: { id: `${turnId}-item`, type: 'agentMessage', text }
      });
      runtime.emit('notification', 'turn/completed', {
        threadId,
        turn: { id: turnId, status: 'completed', error: null }
      });
    }
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 3);
    const firstHandoff = runtime.requests.filter(request => request.method === 'turn/start')[2];
    const firstHandoffTurn = (await store.turns(chat.id)).find(turn => turn.turnId === null);
    assert.ok(firstHandoffTurn);
    firstHandoff.resolve({ turn: { id: 'first-handoff-turn', status: 'inProgress' } });
    await waitFor(() => store.turns(chat.id).some(turn => turn.turnId === 'first-handoff-turn'));
    assert.equal(firstHandoff.params.threadId, store.chat(chat.id).threadId);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.requests.filter(request => request.method === 'turn/start').length, 3);

    runtime.emit('notification', 'item/completed', {
      threadId: firstHandoff.params.threadId,
      turnId: 'first-handoff-turn',
      item: { id: 'first-handoff-reply', type: 'agentMessage', text: '第一条已经处理完。' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: firstHandoff.params.threadId,
      turn: { id: 'first-handoff-turn', status: 'completed', error: null }
    });
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 4);
    const secondHandoff = runtime.requests.filter(request => request.method === 'turn/start')[3];
    if (secondHandoff) {
      assert.equal(secondHandoff.params.threadId, firstHandoff.params.threadId);
      assert.match(
        secondHandoff.params.additionalContext?.['rambo.routine-context']?.value ?? '',
        /Routine「Second delivery」返回给当前 Bot 私聊/u
      );
    } else {
      assert.equal(runtime.requests.some(request => request.method === 'turn/steer'), false);
    }
    assert.equal(store.messages(chat.id).some(message => message.role === 'system'), false);
    assert.equal(store.messages(chat.id).some(message => message.role === 'user'), false);
  });
});

test('assistant phases replace one visible bubble while reasoning and tool activity stay internal', async () => {
  await withHost(async ({ store, runtime, host, events, Store }) => {
    const { chat } = store.createBot('Activity Bot', 'a');
    const sending = host.send(chat.id, 'inspect the project');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'activity-turn', status: 'inProgress' } });
    await sending;
    const threadId = store.chat(chat.id).threadId;

    runtime.emit('notification', 'item/started', {
      threadId,
      turnId: 'activity-turn',
      item: { id: 'reasoning-1', type: 'reasoning', summary: [], content: [] }
    });
    runtime.emit('notification', 'item/reasoning/summaryTextDelta', {
      threadId,
      turnId: 'activity-turn',
      itemId: 'reasoning-1',
      summaryIndex: 0,
      delta: 'Check the relevant source first.'
    });
    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId: 'activity-turn',
      item: {
        id: 'reasoning-1',
        type: 'reasoning',
        summary: ['Check the relevant source first.'],
        content: []
      }
    });
    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId: 'activity-turn',
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'rg --files src',
        commandActions: [],
        cwd: '/tmp/activity',
        status: 'completed',
        aggregatedOutput: 'src/App.tsx\n',
        exitCode: 0
      }
    });
    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId: 'activity-turn',
      item: { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: '我先检查项目结构。' }
    });
    const commentary = store.messages(chat.id).filter(message => message.role === 'assistant');
    assert.equal(commentary.length, 1);
    assert.equal(commentary[0].text, '我先检查项目结构。');
    assert.equal(commentary[0].phase, 'commentary');
    const bubbleId = commentary[0].id;
    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId: 'activity-turn',
      item: { id: 'partial-1', type: 'agentMessage', phase: 'partial_answer', text: '我已经找到相关入口。' }
    });
    const partial = store.messages(chat.id).filter(message => message.role === 'assistant');
    assert.equal(partial.length, 1);
    assert.equal(partial[0].id, bubbleId);
    assert.equal(partial[0].text, '我已经找到相关入口。');
    assert.equal(partial[0].phase, 'partial_answer');
    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId: 'activity-turn',
      item: { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: '检查已经完成。' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: 'activity-turn', status: 'completed' }
    });

    const messages = store.messages(chat.id);
    const assistantMessages = messages.filter(message => message.role === 'assistant');
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0].id, bubbleId);
    assert.equal(assistantMessages[0].itemId, 'final-1');
    assert.equal(assistantMessages[0].phase, 'final_answer');
    assert.equal(assistantMessages[0].turnId, 'activity-turn');
    assert.equal(assistantMessages[0].text, '检查已经完成。');
    assert.ok(events.some(event =>
      event.type === 'message' && event.message.id === bubbleId
    ));
    const activities = store.activities(chat.id);
    assert.deepEqual(activities.map(activity => activity.kind), ['reasoning', 'command']);
    assert.equal(activities[0].detail, 'Check the relevant source first.');
    assert.match(activities[1].detail, /src\/App\.tsx/);
    assert.ok(activities.every(activity => activity.turnId === 'activity-turn'));
    assert.ok(events.some(event => event.type === 'activity' && event.activity.kind === 'reasoning'));
    assert.ok(events.some(event => event.type === 'activity' && event.activity.kind === 'command'));

    const reopened = new Store(store.directory);
    try {
      assert.equal(reopened.messages(chat.id).filter(message => message.role === 'assistant').length, 1);
      assert.equal(reopened.messages(chat.id).find(message => message.role === 'assistant').text, '检查已经完成。');
      assert.deepEqual(reopened.activities(chat.id).map(activity => activity.kind), ['reasoning', 'command']);
    } finally {
      reopened.close();
    }
  });
});

test('stage and final answer deltas replace the same bubble within one turn', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Final stream Bot', 'a');
    const sending = host.send(chat.id, 'stream the final answer');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'final-stream-turn', status: 'inProgress' } });
    await sending;
    const threadId = store.chat(chat.id).threadId;

    runtime.emit('notification', 'item/agentMessage/delta', {
      threadId,
      turnId: 'final-stream-turn',
      itemId: 'final-stream-stage',
      phase: 'commentary',
      delta: '正在检查'
    });
    const commentary = store.messages(chat.id).filter(message => message.role === 'assistant');
    assert.equal(commentary.length, 1);
    assert.equal(commentary[0].text, '正在检查');
    assert.equal(commentary[0].status, 'streaming');
    const bubbleId = commentary[0].id;
    runtime.emit('notification', 'item/agentMessage/delta', {
      threadId,
      turnId: 'final-stream-turn',
      itemId: 'final-stream-stage-next',
      phase: 'partial_answer',
      delta: '下一步'
    });
    const partial = store.messages(chat.id).filter(message => message.role === 'assistant');
    assert.equal(partial.length, 1);
    assert.equal(partial[0].id, bubbleId);
    assert.equal(partial[0].text, '下一步');
    assert.equal(partial[0].status, 'streaming');

    runtime.emit('notification', 'item/agentMessage/delta', {
      threadId,
      turnId: 'final-stream-turn',
      itemId: 'final-stream-answer',
      phase: 'final_answer',
      delta: '最终'
    });
    runtime.emit('notification', 'item/agentMessage/delta', {
      threadId,
      turnId: 'final-stream-turn',
      itemId: 'final-stream-answer',
      phase: 'final_answer',
      delta: '结果'
    });
    const streaming = store.messages(chat.id).filter(message =>
      message.role === 'assistant' && message.itemId === 'final-stream-answer'
    );
    assert.equal(streaming.length, 1);
    assert.equal(streaming[0].text, '最终结果');
    assert.equal(streaming[0].status, 'streaming');
    assert.equal(streaming[0].phase, 'final_answer');
    assert.equal(streaming[0].id, bubbleId);
  });
});

test('runtime disconnect keeps a completed stage bubble at its original position without rewriting it', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Disconnect stage Bot', 'a');
    const sending = host.send(chat.id, 'disconnect while working');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'disconnect-stage-turn', status: 'inProgress' } });
    await sending;
    const threadId = store.chat(chat.id).threadId;

    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId: 'disconnect-stage-turn',
      item: {
        id: 'disconnect-stage-message',
        type: 'agentMessage',
        phase: 'commentary',
        text: '断开前的阶段内容'
      }
    });
    const stage = store.messages(chat.id).find(message => message.role === 'assistant');
    assert.equal(stage?.text, '断开前的阶段内容');

    runtime.emit('state', { status: 'error', version: 'test', error: 'connection lost' });
    const afterDisconnect = store.messages(chat.id).find(message => message.role === 'assistant');
    assert.equal(afterDisconnect?.id, stage?.id);
    assert.equal(afterDisconnect?.status, 'complete');
    assert.equal(afterDisconnect?.text, '断开前的阶段内容');
  });
});

test('a steered follow-up moves the next stage to the latest user message and keeps one bubble', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Routing stage Bot', 'a');
    const firstSending = host.send(chat.id, '第一轮');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const firstStart = runtime.requests.find(request => request.method === 'turn/start');
    firstStart.resolve({ turn: { id: 'routing-stage-first', status: 'inProgress' } });
    await firstSending;
    const threadId = store.chat(chat.id).threadId;
    const firstUser = store.messages(chat.id).find(message =>
      message.role === 'user' && message.text === '第一轮'
    );
    assert.ok(firstUser);

    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId: 'routing-stage-first',
      item: { id: 'routing-commentary', type: 'agentMessage', phase: 'commentary', text: '第一轮阶段内容' }
    });
    const firstBubble = store.messages(chat.id).find(message => message.role === 'assistant');
    assert.equal(firstBubble?.text, '第一轮阶段内容');

    const secondSending = host.send(chat.id, '第二轮');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/steer'));
    await secondSending;
    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId: 'routing-stage-first',
      item: { id: 'routing-partial-second', type: 'agentMessage', phase: 'partial_answer', text: '第二轮阶段内容' }
    });
    let assistant = store.messages(chat.id).filter(message => message.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.notEqual(assistant[0].id, firstBubble?.id);
    assert.equal(assistant[0].text, '第二轮阶段内容');
    assert.ok(events.some(event =>
      event.type === 'messageRemoved' && event.messageId === firstBubble?.id
    ));
    const secondBubbleId = assistant[0].id;
    runtime.emit('notification', 'turn/completed', {
      threadId,
      turn: { id: 'routing-stage-first', status: 'completed' }
    });

    const visible = store.messages(chat.id);
    assert.deepEqual(
      visible.filter(message => message.role === 'user').map(message => message.text),
      ['第一轮', '第二轮']
    );
    assert.deepEqual(
      visible.filter(message => message.role === 'assistant').map(message => message.text),
      ['第二轮阶段内容']
    );
    assert.equal(visible.some(message => message.text === '第一轮阶段内容'), false);
    assert.equal(visible.find(message => message.role === 'assistant')?.id, secondBubbleId);
    assert.equal(visible.find(message => message.role === 'assistant')?.status, 'complete');
  });
});

test('a new Live private thread receives secret management tools and autonomy instructions', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { chat } = store.createBot('Live secret Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];

    const voiceStart = host.startVoice(chat.id, 'v=0\r\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    const secretTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_secrets');
    assert.deepEqual(secretTool.tools.map(tool => tool.name), [
      'save_secret', 'list_secrets', 'rotate_secret', 'delete_secret', 'run_with_secret'
    ]);
    assert.match(threadStart.params.developerInstructions, /默认以强自主性和规划能力工作/u);
    assert.match(threadStart.params.developerInstructions, /rambo_secrets\.run_with_secret/u);
    const realtimeStart = runtime.requests.find(request => request.method === 'thread/realtime/start');
    assert.equal(realtimeStart.params.threadId, store.chat(chat.id).threadId);
    await voiceStart;
  });
});

test('voice transcript items persist on delta, deduplicate completion, and are replaced by the formal reply', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice transcript Bot', 'a');

    const sending = host.send(chat.id, '帮我创建一个两分钟后的取快递提醒。');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'voice-user-turn', status: 'inProgress' } });
    runtime.emit('notification', 'turn/completed', {
      threadId: start.params.threadId, turn: { id: 'voice-user-turn', status: 'completed', error: null }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    await sending;
    const threadId = store.chat(chat.id).threadId;

    // A completed turn prevents startVoice() from first synthesizing an empty
    // turn to initialize an empty thread, which would block on FakeRuntime's
    // intentionally unresolved turn/start request.
    runtime.turnList = [{ status: 'completed' }];
    const voiceStart = host.startVoice(chat.id, 'v=0\r\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    const realtimeStart = runtime.requests.find(request => request.method === 'thread/realtime/start');
    assert.equal(realtimeStart.params.threadId, threadId);
    assert.match(realtimeStart.params.realtimeStartInstructions, /当前时间上下文/u);
    assert.match(realtimeStart.params.realtimeStartInstructions, /本地日期：\d{4}-\d{2}-\d{2}/u);
    assert.match(realtimeStart.params.realtimeStartInstructions, /时区：/u);
    assert.match(realtimeStart.params.realtimeStartInstructions, /rambo_voice\.end_current_voice_session/u);
    assert.match(realtimeStart.params.realtimeStartInstructions, /退下吧/u);
    assert.match(realtimeStart.params.realtimeStartInstructions, /不必说.*“调用工具”/u);
    assert.match(realtimeStart.params.prompt, /rambo_voice\.end_current_voice_session/u);
    assert.match(realtimeStart.params.prompt, /退下吧/u);
    assert.match(realtimeStart.params.prompt, /无需.*说“调用工具”/u);
    assert.equal(realtimeStart.params.version, 'v3');
    assert.equal('tools' in realtimeStart.params, false);
    assert.equal('dynamicTools' in realtimeStart.params, false);
    assert.equal(await voiceStart.then(value => value.threadId), threadId);

    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: 'rt-user-1', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'user', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'rt-user-1', delta: '嗯，你两分钟后'
    });
    const midDelta = store.messages(chat.id).find(message => message.itemId === 'rt-user-1');
    assert.equal(midDelta?.text, '嗯，你两分钟后');
    assert.equal(midDelta?.source, 'voice');
    assert.ok(events.some(event => event.type === 'message' && event.message.itemId === 'rt-user-1'));

    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'rt-user-1', delta: '提醒我去取快递'
    });
    runtime.emit('notification', 'thread/realtime/item/completed', {
      threadId,
      item: {
        id: 'rt-user-1', realtimeSessionId: 'realtime-test', type: 'transcriptSegment',
        role: 'user', text: '嗯，你两分钟后提醒我去取快递'
      }
    });
    const userRows = store.messages(chat.id).filter(message => message.itemId === 'rt-user-1');
    assert.equal(userRows.length, 1);
    assert.equal(userRows[0].text, '嗯，你两分钟后提醒我去取快递');

    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: 'rt-assistant-1', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'rt-assistant-1', delta: '好，我在建两分钟后的提醒，稍等一下。'
    });
    assert.equal(
      store.messages(chat.id).find(message => message.itemId === 'rt-assistant-1')?.text,
      '好，我在建两分钟后的提醒，稍等一下。'
    );

    runtime.emit('notification', 'item/completed', {
      threadId,
      turnId: 'voice-formal-turn',
      item: {
        id: 'voice-formal-reply', type: 'agentMessage', phase: 'final_answer',
        text: '好的，已经创建任务，23:36 提醒你去取快递。'
      }
    });
    const afterFormal = store.messages(chat.id);
    assert.equal(afterFormal.some(message => message.itemId === 'rt-assistant-1'), false);
    assert.equal(
      afterFormal.find(message => message.itemId === 'voice-formal-reply')?.text,
      '好的，已经创建任务，23:36 提醒你去取快递。'
    );
    assert.ok(events.some(event => event.type === 'messageRemoved'));
    assert.ok(afterFormal.find(message => message.itemId === 'rt-user-1')?.source === 'voice');

    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: 'rt-assistant-late', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'rt-assistant-late', delta: '好，我在建两分钟后的提醒，稍等一下。'
    });
    runtime.emit('notification', 'thread/realtime/item/completed', {
      threadId,
      item: {
        id: 'rt-assistant-late', realtimeSessionId: 'realtime-test', type: 'transcriptSegment',
        role: 'assistant', text: '好，我在建两分钟后的提醒，稍等一下。'
      }
    });
    assert.equal(
      store.messages(chat.id).some(message => message.itemId === 'rt-assistant-late'),
      false,
      '正式回复先到达时，迟到的 Realtime 助手转写不能重新插入旧的“正在创建”回复'
    );

    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: 'rt-user-2', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'user', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: 'rt-assistant-2', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'rt-assistant-2', delta: '我已收到你新的问题。'
    });
    assert.equal(
      store.messages(chat.id).find(message => message.itemId === 'rt-assistant-2')?.text,
      '我已收到你新的问题。',
      '新的用户语音轮次应重新允许助手实时转写'
    );

    await host.stopVoice(chat.id, '测试结束');
  });
});

test('a Live transcript item exposes its streaming status before text arrives and removes an empty placeholder on completion', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice loading state Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const starting = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await starting;
    const threadId = store.chat(chat.id).threadId;
    const itemId = 'voice-placeholder';

    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: itemId, realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    const pending = store.messages(chat.id).find(message => message.itemId === itemId);
    assert.equal(pending?.text, '');
    assert.equal(pending?.status, 'streaming');
    assert.ok(events.some(event => event.type === 'message' && event.message.id === pending?.id));

    runtime.emit('notification', 'thread/realtime/item/completed', {
      threadId,
      item: { id: itemId, realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    assert.equal(store.messages(chat.id).some(message => message.itemId === itemId), false);
    assert.ok(events.some(event => event.type === 'messageRemoved' && event.messageId === pending?.id));

    const fallbackItemId = 'voice-final-text-fallback';
    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: fallbackItemId, realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: fallbackItemId, delta: '最后一段转写'
    });
    runtime.emit('notification', 'thread/realtime/item/completed', {
      threadId,
      item: { id: fallbackItemId, realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    const completed = store.messages(chat.id).find(message => message.itemId === fallbackItemId);
    assert.equal(completed?.text, '最后一段转写');
    assert.equal(completed?.status, 'complete');
    await host.stopVoice(chat.id, '测试结束');
  });
});

test('a Realtime disconnect removes empty loading bubbles and retains partial transcript text as interrupted', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice disconnect transcript Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const starting = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await starting;
    const threadId = store.chat(chat.id).threadId;

    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: 'voice-empty-on-close', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: 'voice-partial-on-close', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'voice-partial-on-close', delta: '保留已经识别的内容'
    });
    const emptyOnClose = store.messages(chat.id).find(message => message.itemId === 'voice-empty-on-close');
    assert.ok(emptyOnClose);

    runtime.emit('notification', 'thread/realtime/closed', { threadId, reason: 'connection_lost' });
    const rows = store.messages(chat.id).filter(message => message.role === 'assistant' && message.source === 'voice');
    assert.equal(rows.some(message => message.itemId === 'voice-empty-on-close'), false);
    const partial = rows.find(message => message.itemId === 'voice-partial-on-close');
    assert.equal(partial?.text, '保留已经识别的内容');
    assert.equal(partial?.status, 'interrupted');
    assert.ok(events.some(event => event.type === 'messageRemoved' && event.messageId === emptyOnClose.id));

    const priorStartCount = runtime.requests.filter(request => request.method === 'thread/realtime/start').length;
    const restarted = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/realtime/start').length > priorStartCount);
    await restarted;
    const activeThreadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId: activeThreadId,
      item: { id: 'voice-empty-on-stop', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId: activeThreadId,
      item: { id: 'voice-partial-on-stop', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId: activeThreadId, itemId: 'voice-partial-on-stop', delta: '结束前已经识别的内容'
    });
    await host.stopVoice(chat.id, '测试结束');
    const stoppedRows = store.messages(chat.id).filter(message => message.role === 'assistant' && message.source === 'voice');
    assert.equal(stoppedRows.some(message => message.itemId === 'voice-empty-on-stop'), false);
    const stoppedPartial = stoppedRows.find(message => message.itemId === 'voice-partial-on-stop');
    assert.equal(stoppedPartial?.text, '结束前已经识别的内容');
    assert.equal(stoppedPartial?.status, 'complete');
  });
});

test('legacy Live transcript gives each completed utterance its own message instead of rewriting history', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { chat } = store.createBot('Legacy voice transcript Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const starting = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await starting;
    const threadId = store.chat(chat.id).threadId;

    runtime.emit('notification', 'thread/realtime/transcript/delta', {
      threadId, role: 'assistant', delta: '先前那句语音。'
    });
    runtime.emit('notification', 'thread/realtime/transcript/done', {
      threadId, role: 'assistant', text: '先前那句语音。'
    });
    const first = store.messages(chat.id).find(message => message.role === 'assistant' && message.source === 'voice');
    assert.ok(first);

    runtime.emit('notification', 'thread/realtime/transcript/delta', {
      threadId, role: 'assistant', delta: '最新这句语音。'
    });
    runtime.emit('notification', 'thread/realtime/transcript/done', {
      threadId, role: 'assistant', text: '最新这句语音。'
    });

    const rows = store.messages(chat.id).filter(message => message.role === 'assistant' && message.source === 'voice');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, first.id);
    assert.equal(rows[0].text, '先前那句语音。');
    assert.equal(rows[1].text, '最新这句语音。');
    await host.stopVoice(chat.id, '测试结束');
  });
});

test('item-scoped and legacy Live transcript notifications for one utterance create only one bubble', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Duplicate voice transcript Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const starting = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await starting;
    const threadId = store.chat(chat.id).threadId;
    const text = '好，我现在就结束。';

    runtime.emit('notification', 'thread/realtime/transcript/delta', {
      threadId, role: 'assistant', delta: text
    });
    runtime.emit('notification', 'thread/realtime/transcript/done', {
      threadId, role: 'assistant', text
    });
    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: 'same-utterance', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'same-utterance', delta: text
    });
    runtime.emit('notification', 'thread/realtime/item/completed', {
      threadId,
      item: { id: 'same-utterance', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text }
    });
    runtime.emit('notification', 'thread/realtime/transcript/delta', {
      threadId, role: 'assistant', delta: text
    });
    runtime.emit('notification', 'thread/realtime/transcript/done', {
      threadId, role: 'assistant', text
    });

    const rows = store.messages(chat.id).filter(message => message.role === 'assistant' && message.source === 'voice');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, text);
    assert.ok(events.some(event => event.type === 'messageRemoved'), 'item protocol election removes the earlier legacy duplicate');
    await host.stopVoice(chat.id, '测试结束');
  });
});

test('Live transcript deltas do not publish unused voice state updates alongside message updates', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice render updates Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const starting = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await starting;
    const threadId = store.chat(chat.id).threadId;

    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: { id: 'voice-render-item', realtimeSessionId: 'realtime-test', type: 'transcriptSegment', role: 'assistant', text: '' }
    });
    const beforeDelta = events.length;
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'voice-render-item', delta: '正在说话'
    });
    const deltaEvents = events.slice(beforeDelta);

    assert.equal(deltaEvents.filter(event => event.type === 'message').length, 1);
    assert.equal(deltaEvents.some(event => event.type === 'voiceTranscript'), false);
    await host.stopVoice(chat.id, '测试结束');
  });
});

test('assistant-initiated Live stop publishes a terminal event when the runtime omits realtime/closed', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice stop Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;

    runtime.emit('serverRequest', {
      id: 301,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'voice-stop-turn',
        callId: 'voice-stop-call',
        namespace: 'rambo_voice',
        tool: 'end_current_voice_session',
        arguments: {}
      }
    });
    await waitFor(() => runtime.responses.length === 1);

    assert.equal(runtime.responses[0].result.success, true);
    assert.ok(events.some(event => event.type === 'voiceState' && event.session.state === 'stopping'));
    assert.ok(events.some(event => event.type === 'voiceStopFinished' &&
      event.chatId === chat.id && event.error === null));
    assert.equal(events.at(-1)?.type, 'voiceStopFinished');

    const secondStart = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/realtime/start').length === 2);
    await secondStart;
    await host.stopVoice(chat.id, '手动结束测试');
    assert.deepEqual(events.at(-1), { type: 'voiceStopFinished', chatId: chat.id, error: null });
  });
});

test('assistant-initiated Live stop acknowledges the tool before a slow realtime RPC resolves', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice stop ordering Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    let resolveStop;
    const stopPending = new Promise(resolve => { resolveStop = resolve; });
    const request = runtime.request.bind(runtime);
    runtime.request = (method, ...args) => method === 'thread/realtime/stop'
      ? (runtime.requests.push({ method, params: args[0], options: args[3] }), stopPending)
      : request(method, ...args);

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(item => item.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('serverRequest', {
      id: 303,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'voice-stop-ordering-turn',
        callId: 'voice-stop-ordering-call',
        namespace: 'rambo_voice',
        tool: 'end_current_voice_session',
        arguments: {}
      }
    });

    await waitFor(() => runtime.responses.length === 1);
    assert.equal(runtime.responses[0].result.success, true);
    assert.equal(events.some(event => event.type === 'voiceStopFinished'), false);

    resolveStop({});
    await waitFor(() => events.some(event => event.type === 'voiceStopFinished'));
    assert.equal(events.filter(event => event.type === 'voiceStopFinished').length, 1);
  });
});

test('a Live handoff with explicit end intent stops through an isolated classifier before Codex delegates', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice intent stop Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    let classifierThreadId = null;
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        const result = originalRequest(method, params, ...args);
        classifierThreadId = `intent-thread-${runtime.nextThreadId - 1}`;
        return Promise.resolve({ thread: { id: classifierThreadId }, model: params.model, modelProvider: 'test' });
      }
      if (method === 'turn/start' && params.threadId === classifierThreadId) {
        const turnId = 'intent-turn-1';
        originalRequest(method, params, ...args);
        setImmediate(() => {
          runtime.emit('notification', 'turn/started', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/completed', {
            threadId: classifierThreadId,
            turnId,
            item: {
              type: 'agentMessage', id: 'intent-message-1', phase: 'final_answer',
              text: JSON.stringify({
                decision: 'end_current_voice', confidence: 'high', reason: '用户明确要求当前挂断'
              })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        });
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-explicit-end',
        item_id: 'item-explicit-end',
        input_transcript: '结束，挂断吧',
        active_transcript: [
          { role: 'user', text: '结束，挂断吧' },
          { role: 'assistant', text: '好的。' }
        ]
      }
    });

    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/stop'));
    await waitFor(() => events.some(event => event.type === 'voiceStopFinished'));
    const classifierStart = runtime.requests.find(request =>
      request.method === 'thread/start' && request.params.ephemeral === true
    );
    assert.match(classifierStart.params.baseInstructions, /语音会话控制意图判定器/u);
    assert.match(classifierStart.params.baseInstructions, /退下吧/u);
    assert.match(classifierStart.params.baseInstructions, /不要求.*说“调用工具”/u);
    assert.match(classifierStart.params.baseInstructions, /不能按单个关键词触发/u);
    assert.equal(classifierStart.params.developerInstructions, undefined);
    assert.equal(classifierStart.params.dynamicTools, undefined);
    assert.equal(classifierStart.params.selectedCapabilityRoots.length, 0);
    assert.equal(classifierStart.params.sandbox, 'read-only');
    assert.equal(classifierStart.params.approvalPolicy, 'never');
    assert.deepEqual(classifierStart.params.config.skills, {
      bundled: { enabled: false },
      include_instructions: false,
      config: []
    });
    const classifierTurn = runtime.requests.find(request =>
      request.method === 'turn/start' && request.params.threadId === classifierThreadId
    );
    assert.ok(classifierTurn, JSON.stringify({
      classifierThreadId,
      requests: runtime.requests.map(request => ({
        method: request.method,
        threadId: request.params?.threadId,
        ephemeral: request.params?.ephemeral
      }))
    }));
    assert.equal(classifierTurn.params.effort, 'low');
    assert.equal(classifierTurn.params.outputSchema.additionalProperties, false);
    assert.match(classifierTurn.params.input[0].text, /结束，挂断吧/u);
    assert.ok(events.some(event =>
      event.type === 'voiceState' && event.session.state === 'stopping'
    ));
    assert.deepEqual(
      events.filter(event => event.type === 'voiceStopFinished').at(-1),
      { type: 'voiceStopFinished', chatId: chat.id, error: null }
    );
  });
});

test('a completed Live user transcript stops without waiting for a handoff request', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice transcript intent Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    let classifierThreadId = null;
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        originalRequest(method, params, ...args);
        classifierThreadId = `intent-transcript-${runtime.nextThreadId - 1}`;
        return Promise.resolve({ thread: { id: classifierThreadId }, model: params.model, modelProvider: 'test' });
      }
      if (method === 'turn/start' && params.threadId === classifierThreadId) {
        const turnId = 'intent-transcript-turn';
        originalRequest(method, params, ...args);
        setImmediate(() => {
          runtime.emit('notification', 'turn/started', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/completed', {
            threadId: classifierThreadId,
            turnId,
            item: {
              type: 'agentMessage', id: 'intent-transcript-message', phase: 'final_answer',
              text: JSON.stringify({
                decision: 'end_current_voice', confidence: 'high', reason: '用户明确说可以结束'
              })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        });
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: {
        id: 'rt-user-explicit-end', realtimeSessionId: 'realtime-test',
        type: 'transcriptSegment', role: 'user', text: ''
      }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'rt-user-explicit-end', delta: '好，你可以结束了'
    });
    runtime.emit('notification', 'thread/realtime/item/completed', {
      threadId,
      item: {
        id: 'rt-user-explicit-end', realtimeSessionId: 'realtime-test',
        type: 'transcriptSegment', role: 'user', text: '好，你可以结束了'
      }
    });

    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/stop'));
    await waitFor(() => events.some(event => event.type === 'voiceStopFinished'));
    assert.equal(runtime.requests.some(request => request.method === 'thread/realtime/itemAdded'), false);
    const classifierTurn = runtime.requests.find(request =>
      request.method === 'turn/start' && request.params.threadId === classifierThreadId
    );
    assert.match(classifierTurn.params.input[0].text, /好，你可以结束了/u);
    assert.deepEqual(
      events.filter(event => event.type === 'voiceStopFinished'),
      [{ type: 'voiceStopFinished', chatId: chat.id, error: null }]
    );
  });
});

test('a Live transcript and its handoff request classify the same utterance once', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice transcript handoff dedupe Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    let classifierThreadId = null;
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        originalRequest(method, params, ...args);
        classifierThreadId = `intent-dedupe-${runtime.nextThreadId - 1}`;
        return Promise.resolve({ thread: { id: classifierThreadId }, model: params.model, modelProvider: 'test' });
      }
      if (method === 'turn/start' && params.threadId === classifierThreadId) {
        const turnId = 'intent-dedupe-turn';
        originalRequest(method, params, ...args);
        setImmediate(() => {
          runtime.emit('notification', 'turn/started', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/completed', {
            threadId: classifierThreadId,
            turnId,
            item: {
              type: 'agentMessage', id: 'intent-dedupe-message', phase: 'final_answer',
              text: JSON.stringify({
                decision: 'end_current_voice', confidence: 'high', reason: '用户明确结束'
              })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        });
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: {
        id: 'rt-user-dedupe', realtimeSessionId: 'realtime-test',
        type: 'transcriptSegment', role: 'user', text: ''
      }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'rt-user-dedupe', delta: '结束语音'
    });
    runtime.emit('notification', 'thread/realtime/item/completed', {
      threadId,
      item: {
        id: 'rt-user-dedupe', realtimeSessionId: 'realtime-test',
        type: 'transcriptSegment', role: 'user', text: '结束语音'
      }
    });
    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-dedupe',
        item_id: 'rt-user-dedupe',
        input_transcript: '结束语音',
        active_transcript: [{ role: 'user', text: '结束语音' }]
      }
    });

    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/stop'));
    await waitFor(() => events.some(event => event.type === 'voiceStopFinished'));
    assert.equal(
      runtime.requests.filter(request =>
        request.method === 'thread/start' && request.params.ephemeral === true
      ).length,
      1
    );
    assert.equal(runtime.requests.filter(request => request.method === 'thread/realtime/stop').length, 1);
  });
});

test('a handoff with a new transcript item is not suppressed by the previous utterance', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice transcript handoff ordering Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    const classifierThreads = [];
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        originalRequest(method, params, ...args);
        classifierThreads.push(`intent-order-${runtime.nextThreadId - 1}`);
        return Promise.resolve({
          thread: { id: classifierThreads.at(-1) }, model: params.model, modelProvider: 'test'
        });
      }
      if (method === 'turn/start' && classifierThreads.includes(params.threadId)) {
        const index = classifierThreads.indexOf(params.threadId);
        const turnId = `intent-order-turn-${index}`;
        originalRequest(method, params, ...args);
        setImmediate(() => {
          runtime.emit('notification', 'turn/started', {
            threadId: params.threadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/completed', {
            threadId: params.threadId,
            turnId,
            item: {
              type: 'agentMessage', id: `intent-order-message-${index}`, phase: 'final_answer',
              text: JSON.stringify(index === 0
                ? { decision: 'continue_voice', confidence: 'high', reason: '第一条继续聊天' }
                : { decision: 'end_current_voice', confidence: 'high', reason: '最新一句明确结束' })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: params.threadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        });
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/item/started', {
      threadId,
      item: {
        id: 'rt-user-referenced-earlier', realtimeSessionId: 'realtime-test',
        type: 'transcriptSegment', role: 'user', text: ''
      }
    });
    runtime.emit('notification', 'thread/realtime/item/transcript/delta', {
      threadId, itemId: 'rt-user-referenced-earlier', delta: '帮我看看刚才的提醒'
    });
    runtime.emit('notification', 'thread/realtime/item/completed', {
      threadId,
      item: {
        id: 'rt-user-referenced-earlier', realtimeSessionId: 'realtime-test',
        type: 'transcriptSegment', role: 'user', text: '帮我看看刚才的提醒'
      }
    });
    await waitFor(() => classifierThreads.length === 1);

    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-new-end',
        item_id: 'rt-user-explicit-end',
        input_transcript: '现在结束语音',
        active_transcript: [
          { role: 'user', text: '帮我看看刚才的提醒' },
          { role: 'assistant', text: '提醒还在。' },
          { role: 'user', text: '现在结束语音' }
        ]
      }
    });

    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/stop'));
    await waitFor(() => events.some(event => event.type === 'voiceStopFinished'));
    assert.equal(classifierThreads.length, 2);
    assert.match(runtime.requests.find(request =>
      request.method === 'turn/start' && request.params.threadId === classifierThreads[1]
    ).params.input[0].text, /现在结束语音/u);
  });
});

test('a Live handoff discussing how to end Voice does not stop the active call', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice intent continue Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    let classifierThreadId = null;
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        const result = originalRequest(method, params, ...args);
        classifierThreadId = `intent-continue-${runtime.nextThreadId - 1}`;
        return Promise.resolve({ thread: { id: classifierThreadId }, model: params.model, modelProvider: 'test' });
      }
      if (method === 'turn/start' && params.threadId === classifierThreadId) {
        const turnId = 'intent-continue-turn';
        originalRequest(method, params, ...args);
        setImmediate(() => {
          runtime.emit('notification', 'turn/started', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/completed', {
            threadId: classifierThreadId,
            turnId,
            item: {
              type: 'agentMessage', id: 'intent-continue-message', phase: 'final_answer',
              text: JSON.stringify({
                decision: 'continue_voice', confidence: 'high', reason: '用户只是询问如何结束'
              })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        });
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-how-to-end',
        item_id: 'item-how-to-end',
        input_transcript: '这个语音功能要怎么结束？',
        active_transcript: [{ role: 'user', text: '这个语音功能要怎么结束？' }]
      }
    });

    await waitFor(() => runtime.requests.some(request =>
      request.method === 'thread/delete' && request.params.threadId === classifierThreadId
    ));
    assert.equal(runtime.requests.some(request => request.method === 'thread/realtime/stop'), false);
    assert.equal(events.some(event =>
      event.type === 'voiceState' && event.session.state === 'stopping'
    ), false);
  });
});

test('a low-confidence Live end classification leaves the active call running', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice low confidence Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    let classifierThreadId = null;
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        const result = originalRequest(method, params, ...args);
        classifierThreadId = `intent-low-confidence-${runtime.nextThreadId - 1}`;
        return Promise.resolve({ thread: { id: classifierThreadId }, model: params.model, modelProvider: 'test' });
      }
      if (method === 'turn/start' && params.threadId === classifierThreadId) {
        const turnId = 'intent-low-confidence-turn';
        originalRequest(method, params, ...args);
        setImmediate(() => {
          runtime.emit('notification', 'turn/started', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/completed', {
            threadId: classifierThreadId,
            turnId,
            item: {
              type: 'agentMessage', id: 'intent-low-confidence-message', phase: 'final_answer',
              text: JSON.stringify({
                decision: 'end_current_voice', confidence: 'low', reason: '可能是结束，也可能是讨论'
              })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        });
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-low-confidence',
        item_id: 'item-low-confidence',
        input_transcript: '也许可以结束？',
        active_transcript: [{ role: 'user', text: '也许可以结束？' }]
      }
    });

    await waitFor(() => runtime.requests.some(request =>
      request.method === 'thread/delete' && request.params.threadId === classifierThreadId
    ));
    assert.equal(runtime.requests.some(request => request.method === 'thread/realtime/stop'), false);
    assert.equal(events.some(event =>
      event.type === 'voiceState' && event.session.state === 'stopping'
    ), false);
  });
});

test('the latest queued Live handoff wins when an earlier classification says continue', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice queued intent Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    const classifierThreads = [];
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        const result = originalRequest(method, params, ...args);
        const threadId = `intent-queued-${runtime.nextThreadId - 1}`;
        classifierThreads.push(threadId);
        return Promise.resolve({ thread: { id: threadId }, model: params.model, modelProvider: 'test' });
      }
      if (method === 'turn/start' && classifierThreads.includes(params.threadId)) {
        const turnId = `intent-queued-turn-${classifierThreads.indexOf(params.threadId)}`;
        originalRequest(method, params, ...args);
        const index = classifierThreads.indexOf(params.threadId);
        const complete = () => {
          runtime.emit('notification', 'turn/started', {
            threadId: params.threadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/completed', {
            threadId: params.threadId,
            turnId,
            item: {
              type: 'agentMessage', id: `intent-queued-message-${index}`, phase: 'final_answer',
              text: JSON.stringify(index === 0
                ? { decision: 'continue_voice', confidence: 'high', reason: '先说继续' }
                : { decision: 'end_current_voice', confidence: 'high', reason: '最新一句明确结束' })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: params.threadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        };
        if (index === 0) setTimeout(complete, 20);
        else complete();
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-keep-talking',
        item_id: 'item-keep-talking',
        input_transcript: '先继续聊',
        active_transcript: [{ role: 'user', text: '先继续聊' }]
      }
    });
    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-end-now',
        item_id: 'item-end-now',
        input_transcript: '现在结束语音',
        active_transcript: [{ role: 'user', text: '现在结束语音' }]
      }
    });

    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/stop'));
    await waitFor(() => events.some(event => event.type === 'voiceStopFinished'));
    assert.equal(runtime.requests.filter(request => request.method === 'thread/realtime/stop').length, 1);
    assert.equal(classifierThreads.length, 2);
    assert.match(runtime.requests.find(request =>
      request.method === 'turn/start' && request.params.threadId === classifierThreads[1]
    ).params.input[0].text, /现在结束语音/u);
  });
});

test('a classifier timeout and failure do not stop Live and the next handoff is still checked', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice classifier recovery Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    const classifierThreads = [];
    let failFirst = true;
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        const result = originalRequest(method, params, ...args);
        const threadId = `intent-recovery-${runtime.nextThreadId - 1}`;
        classifierThreads.push(threadId);
        return Promise.resolve({ thread: { id: threadId }, model: params.model, modelProvider: 'test' });
      }
      if (method === 'turn/start' && classifierThreads.includes(params.threadId)) {
        const index = classifierThreads.indexOf(params.threadId);
        const turnId = `intent-recovery-turn-${index}`;
        originalRequest(method, params, ...args);
        if (index === 0 && failFirst) {
          failFirst = false;
          return Promise.reject(new Error('classifier unavailable'));
        }
        setImmediate(() => {
          runtime.emit('notification', 'turn/started', {
            threadId: params.threadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/completed', {
            threadId: params.threadId,
            turnId,
            item: {
              type: 'agentMessage', id: `intent-recovery-message-${index}`, phase: 'final_answer',
              text: JSON.stringify({
                decision: 'end_current_voice', confidence: 'high', reason: '第二次判定明确结束'
              })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: params.threadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        });
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-classifier-failure',
        item_id: 'item-classifier-failure',
        input_transcript: '结束吧',
        active_transcript: [{ role: 'user', text: '结束吧' }]
      }
    });
    await waitFor(() => classifierThreads.length === 1 &&
      runtime.requests.some(request => request.method === 'thread/delete' &&
        request.params.threadId === classifierThreads[0]));
    assert.equal(runtime.requests.some(request => request.method === 'thread/realtime/stop'), false);

    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-classifier-recovered',
        item_id: 'item-classifier-recovered',
        input_transcript: '现在结束语音',
        active_transcript: [{ role: 'user', text: '现在结束语音' }]
      }
    });
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/stop'));
    await waitFor(() => events.some(event => event.type === 'voiceStopFinished'));
    assert.equal(classifierThreads.length, 2);
  });
});

test('Live intent classification notifications never enter the visible chat', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice classifier isolation Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    let classifierThreadId = null;
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        const result = originalRequest(method, params, ...args);
        classifierThreadId = `intent-isolation-${runtime.nextThreadId - 1}`;
        return Promise.resolve({ thread: { id: classifierThreadId }, model: params.model, modelProvider: 'test' });
      }
      if (method === 'turn/start' && params.threadId === classifierThreadId) {
        const turnId = 'intent-isolation-turn';
        originalRequest(method, params, ...args);
        setImmediate(() => {
          runtime.emit('notification', 'turn/started', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/agentMessage/delta', {
            threadId: classifierThreadId,
            turnId,
            itemId: 'intent-isolation-message',
            delta: '{"decision":"continue_voice"'
          });
          runtime.emit('notification', 'item/agentMessage/delta', {
            threadId: classifierThreadId,
            turnId,
            itemId: 'intent-isolation-message',
            delta: ',"confidence":"high","reason":"仅内部判定"}'
          });
          runtime.emit('notification', 'item/completed', {
            threadId: classifierThreadId,
            turnId,
            item: {
              type: 'agentMessage', id: 'intent-isolation-message', phase: 'final_answer',
              text: JSON.stringify({
                decision: 'continue_voice', confidence: 'high', reason: '仅内部判定'
              })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        });
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-isolation',
        item_id: 'item-isolation',
        input_transcript: '继续聊天',
        active_transcript: [{ role: 'user', text: '继续聊天' }]
      }
    });

    await waitFor(() => runtime.requests.some(request =>
      request.method === 'thread/delete' && request.params.threadId === classifierThreadId
    ));
    assert.equal(store.messages(chat.id).some(message =>
      message.text.includes('仅内部判定') ||
      message.text.includes('continue_voice')
    ), false);
    assert.equal(events.some(event =>
      event.type === 'message' &&
      (event.message.text.includes('仅内部判定') || event.message.text.includes('continue_voice'))
    ), false);
  });
});

test('manual Live stop and a later classifier result share one stop and one terminal event', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice stop race Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const originalRequest = runtime.request.bind(runtime);
    let classifierThreadId = null;
    let completeClassifier = null;
    runtime.request = (method, params = {}, ...args) => {
      if (method === 'thread/start' && params.ephemeral === true) {
        const result = originalRequest(method, params, ...args);
        classifierThreadId = `intent-stop-race-${runtime.nextThreadId - 1}`;
        return Promise.resolve({ thread: { id: classifierThreadId }, model: params.model, modelProvider: 'test' });
      }
      if (method === 'turn/start' && params.threadId === classifierThreadId) {
        const turnId = 'intent-stop-race-turn';
        originalRequest(method, params, ...args);
        completeClassifier = () => {
          runtime.emit('notification', 'turn/started', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'inProgress' }
          });
          runtime.emit('notification', 'item/completed', {
            threadId: classifierThreadId,
            turnId,
            item: {
              type: 'agentMessage', id: 'intent-stop-race-message', phase: 'final_answer',
              text: JSON.stringify({
                decision: 'end_current_voice', confidence: 'high', reason: '用户后来明确结束'
              })
            }
          });
          runtime.emit('notification', 'turn/completed', {
            threadId: classifierThreadId,
            turn: { id: turnId, status: 'completed', error: null }
          });
        };
        return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
      }
      return originalRequest(method, params, ...args);
    };

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('notification', 'thread/realtime/itemAdded', {
      threadId,
      item: {
        type: 'handoff_request',
        handoff_id: 'handoff-stop-race',
        item_id: 'item-stop-race',
        input_transcript: '结束吧',
        active_transcript: [{ role: 'user', text: '结束吧' }]
      }
    });
    await waitFor(() => typeof completeClassifier === 'function');

    await host.stopVoice(chat.id, '用户点击了结束语音');
    completeClassifier();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.requests.filter(request => request.method === 'thread/realtime/stop').length, 1);
    assert.equal(events.filter(event => event.type === 'voiceStopFinished').length, 1);
  });
});

test('a normal realtime close during stopping finishes once without a false connection error', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice expected close Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    let resolveStop;
    const stopPending = new Promise(resolve => { resolveStop = resolve; });
    const request = runtime.request.bind(runtime);
    runtime.request = (method, ...args) => method === 'thread/realtime/stop'
      ? (runtime.requests.push({ method, params: args[0], options: args[3] }), stopPending)
      : request(method, ...args);

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(item => item.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('serverRequest', {
      id: 304,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'voice-close-turn',
        callId: 'voice-close-call',
        namespace: 'rambo_voice',
        tool: 'end_current_voice_session',
        arguments: {}
      }
    });
    await waitFor(() => runtime.responses.length === 1);

    runtime.emit('notification', 'thread/realtime/closed', { threadId, reason: 'transport_closed' });
    assert.equal(events.some(event =>
      event.type === 'voiceState' &&
      event.session.state === 'error' &&
      event.session.chatId === chat.id
    ), false);
    assert.equal(events.filter(event => event.type === 'voiceStopFinished').length, 1);
    assert.equal(events.find(event => event.type === 'voiceStopFinished')?.error, null);

    resolveStop({});
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.filter(event => event.type === 'voiceStopFinished').length, 1);
  });
});

test('assistant-initiated Live stop reports a terminal error when realtime/stop rejects', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice stop failure Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const request = runtime.request.bind(runtime);
    runtime.request = (method, ...args) => method === 'thread/realtime/stop'
      ? Promise.reject(new Error('stop rejected'))
      : request(method, ...args);

    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(item => item.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;
    runtime.emit('serverRequest', {
      id: 302,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'voice-stop-failure-turn',
        callId: 'voice-stop-failure-call',
        namespace: 'rambo_voice',
        tool: 'end_current_voice_session',
        arguments: {}
      }
    });
    await waitFor(() => runtime.responses.length === 1);

    assert.equal(runtime.responses[0].result.success, true);
    await waitFor(() => events.some(event => event.type === 'voiceStopFinished' &&
      event.chatId === chat.id && event.error === '语音服务停止失败：stop rejected'));
    await assert.rejects(host.stopVoice(chat.id, '手动重试'), /stop rejected/u);
    assert.deepEqual(events.at(-1), {
      type: 'voiceStopFinished', chatId: chat.id, error: '语音服务停止失败：stop rejected'
    });
  });
});

test('Realtime and runtime disconnects leave the UI on terminal error instead of overwriting it with stopping', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const { chat } = store.createBot('Voice disconnect Bot', 'a');
    runtime.turnList = [{ status: 'completed' }];
    const started = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.some(request => request.method === 'thread/realtime/start'));
    await started;
    const threadId = store.chat(chat.id).threadId;

    runtime.emit('notification', 'thread/realtime/error', {
      threadId,
      error: { message: 'connection lost' }
    });

    const terminalEvents = events.filter(event =>
      event.type === 'voiceEndRequested' ||
      (event.type === 'voiceState' && event.session.chatId === chat.id)
    );
    assert.deepEqual(terminalEvents.slice(-2).map(event => event.type), ['voiceEndRequested', 'voiceState']);
    assert.equal(terminalEvents.at(-1).session.state, 'error');

    const restarted = host.startVoice(chat.id, 'v=0\\r\\n');
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/realtime/start').length === 2);
    await restarted;
    runtime.emit('state', { status: 'stopped', version: 'test', error: 'runtime stopped' });
    const runtimeTerminalEvents = events.filter(event =>
      event.type === 'voiceEndRequested' ||
      (event.type === 'voiceState' && event.session.chatId === chat.id)
    );
    assert.deepEqual(runtimeTerminalEvents.slice(-2).map(event => event.type), ['voiceEndRequested', 'voiceState']);
    assert.equal(runtimeTerminalEvents.at(-1).session.state, 'error');
    assert.equal(runtimeTerminalEvents.at(-1).session.error, 'runtime stopped');
  });
});

test('a later text turn preserves completed assistant voice history after Live has ended', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { chat } = store.createBot('Voice history Bot', 'a');
    store.voiceItem(chat.id, 'prior-live-answer', 'assistant', '上一次语音答复', false, 'complete');

    await host.send(chat.id, '下一条文字消息');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    assert.equal(
      store.messages(chat.id).find(message => message.itemId === 'prior-live-answer')?.text,
      '上一次语音答复'
    );

    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'after-live-text-turn', status: 'inProgress' } });
    runtime.emit('notification', 'turn/completed', {
      threadId: start.params.threadId,
      turn: { id: 'after-live-text-turn', status: 'completed', error: null }
    });
  });
});

test('a Routine handoff does not imply that a live voice session is active', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot } = store.createBot('Routine voice boundary Bot', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Voice boundary', instruction: '生成结果',
      schedule: '每天', time: '09:30', sourceCallId: 'voice-boundary'
    });
    const running = host.routineScheduler.runNow(routine.id);
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const routineStart = runtime.requests.find(request => request.method === 'turn/start');
    const routineThreadId = routineStart.params.threadId;
    routineStart.resolve({ turn: { id: 'routine-voice-turn', status: 'inProgress' } });
    await running;
    runtime.emit('notification', 'item/completed', {
      threadId: routineThreadId,
      turnId: 'routine-voice-turn',
      item: { id: 'routine-voice-result', type: 'agentMessage', text: '到点提醒你取快递。' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: routineThreadId,
      turn: { id: 'routine-voice-turn', status: 'completed', error: null }
    });
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const handoff = runtime.requests.filter(request => request.method === 'turn/start')[1];
    const handoffContext = handoff.params.additionalContext?.['rambo.routine-context']?.value ?? '';
    assert.match(handoffContext, /不是用户正在使用的 Live 语音会话/u);
    assert.match(handoffContext, /不得调用 rambo_voice\.end_current_voice_session/u);
    handoff.resolve({ turn: { id: 'routine-voice-handoff', status: 'inProgress' } });
    runtime.emit('notification', 'turn/completed', {
      threadId: handoff.params.threadId,
      turn: { id: 'routine-voice-handoff', status: 'completed', error: null }
    });
  });
});

test('runtime disconnect persists an unknown turn and blocks send until history confirms it', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const { bot } = store.createBot('Assistant', 'a');
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

test('queued chat messages survive restart and dispatch after the prior turn is interrupted', async () => {
  await withHost(async ({ store, runtime, host, Store, Host, events, replaceStore }) => {
    const { chat } = store.createBot('Recovery queue Bot', 'a');
    const firstSend = host.send(chat.id, 'start the current task');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const firstStart = runtime.requests.find(request => request.method === 'turn/start');
    firstStart.resolve({ turn: { id: 'recovery-active-turn', status: 'inProgress' } });
    await firstSend;

    runtime.deferSteer = true;
    const steerSend = host.send(chat.id, 'adjust the current task');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/steer'));
    await steerSend;
    await host.send(chat.id, 'send this after restart');
    assert.equal(store.messages(chat.id).find(message => message.text === 'send this after restart')?.dispatchStatus, 'queued');

    const directory = store.directory;
    const threadId = store.chat(chat.id).threadId;
    host.dispose();
    store.close();

    const reopened = new Store(directory);
    replaceStore(reopened);
    const restoredRuntime = new FakeRuntime();
    restoredRuntime.turnList = [{
      id: 'recovery-active-turn', status: 'inProgress', startedAt: Math.floor(Date.now() / 1000)
    }];
    const restoredHost = new Host(reopened, restoredRuntime, event => events.push(event));
    try {
      restoredRuntime.emit('state', restoredRuntime.state);
      await waitFor(() => restoredRuntime.requests.some(request => request.method === 'turn/interrupt'));
      await waitFor(() => restoredRuntime.requests.some(request => request.method === 'turn/start'));
      const queuedStart = restoredRuntime.requests.find(request => request.method === 'turn/start');
      assert.equal(queuedStart.params.input[0].text, 'send this after restart');
      queuedStart.resolve({ turn: { id: 'recovered-queued-turn', status: 'inProgress' } });
      await waitFor(() => reopened.messages(chat.id).find(message => message.text === 'send this after restart')?.dispatchStatus === 'dispatched');

      assert.equal(reopened.turnByServerId(threadId, 'recovery-active-turn').status, 'interrupted');
      assert.equal(reopened.messages(chat.id).find(message => message.text === 'adjust the current task')?.dispatchStatus, 'needs_user');
      assert.equal(reopened.messages(chat.id).find(message => message.text === 'send this after restart')?.dispatchStatus, 'dispatched');
      assert.equal(restoredRuntime.requests.filter(request => request.method === 'turn/start').length, 1);
    } finally {
      restoredHost.dispose();
    }
  });
});

test('Routine recovery parks an interrupted run when its external result cannot be proven', async () => {
  await withHost(async ({ store, Store, Host, runtime: _runtime, events, replaceStore }) => {
    const { bot } = store.createBot('Routine recovery Bot', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Resume safely', instruction: 'Check and update the record.',
      schedule: '每天', time: '09:00', sourceCallId: 'routine-resume-safe'
    });
    const run = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-25T01:00:00.000Z',
      trigger: 'schedule', status: 'running'
    });
    const executionChat = store.createRoutineExecutionChat(run.id, bot.id, `定时任务：${routine.title}`);
    const threadId = 'routine-recovery-thread';
    store.bindThread(executionChat.id, threadId, false, false);
    const begun = store.beginTurn(executionChat.id, run.instruction, {
      threadId,
      requestedModel: 'test-model',
      modelSource: 'bot',
      permissionSnapshot: {
        permission: 'fullAccess', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }
      }
    });
    store.attachTurnId(begun.turn.id, threadId, 'routine-recovery-turn', 'running');
    store.setTurnDispatchStatus(begun.turn.id, 'dispatched');
    store.updateRoutineRun(run.id, {
      chatId: executionChat.id, turnId: 'routine-recovery-turn', startedAt: begun.turn.startedAt
    });

    const directory = store.directory;
    store.close();
    const reopened = new Store(directory);
    replaceStore(reopened);
    const restoredRuntime = new FakeRuntime();
    restoredRuntime.turnList = [{
      id: 'routine-recovery-turn', status: 'interrupted', startedAt: Math.floor(Date.now() / 1000)
    }];
    const restoredHost = new Host(reopened, restoredRuntime, event => events.push(event));
    try {
      restoredRuntime.emit('state', restoredRuntime.state);
      await waitFor(() => reopened.routineRun(run.id).status === 'needs_user');
      assert.equal(reopened.routineRun(run.id).recoveryCount, 0);
      assert.match(reopened.routineRun(run.id).needsUserReason, /无法确认外部操作/u);
      assert.equal(reopened.routine(routine.id).status, 'paused');
      assert.throws(() => reopened.setRoutineStatus(routine.id, 'active'), /先检查上次运行结果/u);
      assert.equal(restoredRuntime.requests.some(request => request.method === 'turn/start'), false);
    } finally {
      restoredHost.dispose();
    }
  });
});

test('explicit group mention sends through that Bot group thread and streams its reply to the shared timeline', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    store.setSetting('defaultBotModel', 'global-group-model');
    store.setSetting('defaultBotPermission', 'workspaceWrite');
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('Project room', [first.bot.id, second.bot.id]);
    store.addMessage(second.chat.id, 'user', 'private-only marker');
    store.addGroupMessage(group.id, 'assistant', 'shared group context marker', { senderBot: first.bot });
    const memberChat = store.groupMemberChats(group.id).find(chat => chat.botId === second.bot.id);
    assert.ok(memberChat);
    const sending = host.sendGroup(group.id, '@Writer draft a short summary');
    await waitFor(() => runtime.requests.some(request => request.method === 'turn/start'));
    const start = runtime.requests.find(request => request.method === 'turn/start');
    const threadStart = runtime.requests.find(request => request.method === 'thread/start');
    const memberSession = store.groupSessions().find(session => session.groupId === group.id && session.botId === second.bot.id && session.purpose === 'member');
    assert.ok(memberSession);
    assert.deepEqual(
      threadStart.params.dynamicTools.map(tool => tool.name),
      ['rambo_chat_ui', 'rambo_secrets', 'rambo_group_history', 'rambo_group_messages']
    );
    const groupSecretTool = threadStart.params.dynamicTools.find(tool => tool.name === 'rambo_secrets');
    assert.deepEqual(groupSecretTool.tools.map(tool => tool.name), ['list_secrets', 'run_with_secret']);
    assert.match(threadStart.params.developerInstructions, /当前 Routine 或群成员执行会话继承所属 Bot 的密钥范围/u);
    assert.equal(start.params.threadId, store.chat(memberSession.chatId).threadId);
    assert.equal(start.params.model, 'global-group-model');
    assert.deepEqual(start.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [join(store.directory, 'bots', second.bot.id, 'workspace')],
      networkAccess: true
    });
    assert.equal(start.params.sandboxPolicy.type, 'workspaceWrite');
    assert.equal(start.params.approvalPolicy, 'on-request');
    assert.equal(store.bot(second.bot.id).model, 'global-group-model');
    assert.equal(store.bot(second.bot.id).permission, 'workspaceWrite');
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

test('empty group agent messages do not persist or surface as blank Bot bubbles', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const first = store.createBot('Interviewer', 'a');
    const second = store.createBot('Candidate', 'b');
    const group = store.createGroup('Interview room', [first.bot.id, second.bot.id]);
    const legacyBlank = store.addGroupMessage(group.id, 'assistant', '', {
      senderBot: first.bot,
      phase: 'final_answer'
    });
    assert.equal(store.groupMessages(group.id).some(message => message.id === legacyBlank.id), false);

    const sending = host.sendGroup(group.id, '@everyone announce the interview');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    starts.forEach((start, index) => start.resolve({
      turn: { id: `empty-group-turn-${index}`, status: 'inProgress' }
    }));
    await sending;

    runtime.emit('notification', 'item/completed', {
      threadId: starts[0].params.threadId,
      turnId: 'empty-group-turn-0',
      item: { id: 'empty-group-final', type: 'agentMessage', phase: 'final_answer', text: '' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: starts[0].params.threadId,
      turn: { id: 'empty-group-turn-0', status: 'completed' }
    });

    assert.equal(store.groupMessages(group.id).some(message =>
      message.role === 'assistant' && message.senderBotId === first.bot.id
    ), false);
    assert.equal(events.some(event =>
      event.type === 'groupMessage' &&
      event.message.role === 'assistant' &&
      event.message.text.trim() === '' &&
      !event.message.content
    ), false);
  });
});

test('queued directed group delivery does not reclassify an active judgment no-reply', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const interviewer = store.createBot('Interviewer', 'a');
    const candidate = store.createBot('Candidate', 'b');
    const group = store.createGroup(
      'Interview room',
      [interviewer.bot.id, candidate.bot.id],
      'Run a turn-taking interview',
      interviewer.bot.id
    );

    const sending = host.sendGroup(group.id, '@everyone start the interview');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    const candidateChatId = store.groupSession(group.id, candidate.bot.id).id;
    const interviewerChatId = store.groupSession(group.id, interviewer.bot.id).id;
    const candidateThreadId = store.chat(candidateChatId).threadId;
    const interviewerThreadId = store.chat(interviewerChatId).threadId;
    const candidateStart = starts.find(start => start.params.threadId === candidateThreadId);
    const interviewerStart = starts.find(start => start.params.threadId === interviewerThreadId);
    assert.ok(candidateStart);
    assert.ok(interviewerStart);
    candidateStart.resolve({ turn: { id: 'candidate-judgment-turn', status: 'inProgress' } });
    interviewerStart.resolve({ turn: { id: 'interviewer-judgment-turn', status: 'inProgress' } });
    await sending;

    const delivery = await host.submitAcceptanceGroupMessageTool({
      method: 'item/tool/call',
      params: {
        threadId: interviewerThreadId,
        callId: 'question-for-candidate',
        namespace: 'rambo_group_messages',
        tool: 'send',
        arguments: {
          text: '@Candidate introduce one Go project.',
          targetBotId: candidate.bot.id
        }
      }
    });
    assert.equal(delivery.result.success, true, JSON.stringify(delivery.result));

    runtime.emit('notification', 'item/completed', {
      threadId: candidateThreadId,
      turnId: 'candidate-judgment-turn',
      item: {
        id: 'candidate-judgment-final',
        type: 'agentMessage',
        phase: 'final_answer',
        text: '[[RAMBO_NO_GROUP_REPLY]]'
      }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: candidateThreadId,
      turn: { id: 'candidate-judgment-turn', status: 'completed' }
    });

    assert.equal(store.groupMessages(group.id).some(message =>
      message.role === 'system' && message.text.includes('内部不回复标记')
    ), false);

    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 3);
    const directedStart = runtime.requests.filter(request => request.method === 'turn/start')[2];
    directedStart.resolve({ turn: { id: 'candidate-directed-turn', status: 'inProgress' } });
    runtime.emit('notification', 'turn/started', {
      threadId: candidateThreadId,
      turn: { id: 'candidate-directed-turn', status: 'inProgress' }
    });
    assert.equal(runtime.requests.some(request =>
      request.method === 'turn/interrupt' &&
      request.params.threadId === candidateThreadId &&
      request.params.turnId === 'candidate-directed-turn'
    ), false);
    runtime.emit('notification', 'item/completed', {
      threadId: candidateThreadId,
      turnId: 'candidate-directed-turn',
      item: {
        id: 'candidate-directed-final',
        type: 'agentMessage',
        phase: 'final_answer',
        text: 'I worked on an order processing service.'
      }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: candidateThreadId,
      turn: { id: 'candidate-directed-turn', status: 'completed' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: interviewerThreadId,
      turn: { id: 'interviewer-judgment-turn', status: 'completed' }
    });
  });
});

test('group runtime tracks participant judgment, latest activity, and hides after every member finishes', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('Runtime room', [first.bot.id, second.bot.id]);
    const sending = host.sendGroup(group.id, 'Please review the runtime behavior.');

    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const initial = host.snapshot().groupRuntimes[group.id];
    assert.ok(initial);
    assert.deepEqual(initial.members.map(member => member.botId), [first.bot.id, second.bot.id]);
    assert.deepEqual(initial.members.map(member => member.phase), ['starting', 'starting']);
    assert.ok(events.some(event => event.type === 'groupRuntime' && event.groupId === group.id));

    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    const turnIdByThread = new Map();
    starts.forEach((start, index) => {
      const turnId = `runtime-turn-${index}`;
      turnIdByThread.set(start.params.threadId, turnId);
      start.resolve({ turn: { id: turnId, status: 'inProgress' } });
    });
    await sending;
    await waitFor(() => host.snapshot().groupRuntimes[group.id]?.members
      .every(member => member.phase === 'judging'));

    const firstMember = initial.members.find(member => member.botId === first.bot.id);
    const secondMember = initial.members.find(member => member.botId === second.bot.id);
    const firstStart = starts.find(start => start.params.threadId === store.chat(firstMember.chatId).threadId);
    const secondStart = starts.find(start => start.params.threadId === store.chat(secondMember.chatId).threadId);
    assert.ok(firstStart);
    assert.ok(secondStart);
    runtime.emit('notification', 'item/started', {
      threadId: firstStart.params.threadId,
      turnId: turnIdByThread.get(firstStart.params.threadId),
      item: { id: 'runtime-web', type: 'webSearch', query: 'runtime marker' }
    });
    let current = host.snapshot().groupRuntimes[group.id];
    assert.deepEqual(current.members.map(member => member.phase), ['working', 'judging']);
    const activityChanged = current.members.find(member => member.botId === first.bot.id);
    assert.equal(activityChanged.activityKind, 'web');
    assert.ok(activityChanged.activityUpdatedAt);

    runtime.emit('notification', 'turn/completed', {
      threadId: firstStart.params.threadId,
      turn: { id: turnIdByThread.get(firstStart.params.threadId), status: 'completed' }
    });
    current = host.snapshot().groupRuntimes[group.id];
    assert.deepEqual(current.members.map(member => member.botId), [second.bot.id]);

    runtime.emit('notification', 'turn/completed', {
      threadId: secondStart.params.threadId,
      turn: { id: turnIdByThread.get(secondStart.params.threadId), status: 'completed' }
    });
    assert.equal(host.snapshot().groupRuntimes[group.id], undefined);
    assert.ok(events.some(event => event.type === 'groupRuntime' && event.groupId === group.id && event.runtime === null));
  });
});

test('group commentary creates a member bubble while later tool activity remains in runtime state', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Stage Activity Researcher', 'a');
    const second = store.createBot('Stage Activity Writer', 'b');
    const group = store.createGroup('Stage activity room', [first.bot.id, second.bot.id]);
    const sending = host.sendGroup(group.id, '@everyone inspect the issue');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    starts.forEach((start, index) => start.resolve({
      turn: { id: `stage-activity-turn-${index}`, status: 'inProgress' }
    }));
    await sending;

    const runtimeState = host.snapshot().groupRuntimes[group.id];
    assert.ok(runtimeState);
    const member = runtimeState.members.find(item => item.botId === first.bot.id);
    assert.ok(member);
    const start = starts.find(candidate =>
      candidate.params.threadId === store.chat(member.chatId).threadId
    );
    assert.ok(start);
    const turnId = `stage-activity-turn-${starts.indexOf(start)}`;

    runtime.emit('notification', 'item/completed', {
      threadId: start.params.threadId,
      turnId,
      item: { id: 'stage-activity-commentary', type: 'agentMessage', phase: 'commentary', text: '先检查入口' }
    });
    const commentary = store.groupMessages(group.id).filter(message => message.role === 'assistant');
    assert.equal(commentary.length, 1);
    assert.equal(commentary[0].senderBotId, first.bot.id);
    assert.equal(commentary[0].text, '先检查入口');
    let current = host.snapshot().groupRuntimes[group.id];
    let currentMember = current?.members.find(item => item.botId === first.bot.id);
    assert.equal(currentMember?.phase, 'working');
    assert.equal(currentMember?.activityKind, null);

    runtime.emit('notification', 'item/started', {
      threadId: start.params.threadId,
      turnId,
      item: { id: 'stage-activity-web', type: 'webSearch', query: 'ordered runtime activity' }
    });
    current = host.snapshot().groupRuntimes[group.id];
    currentMember = current?.members.find(item => item.botId === first.bot.id);
    assert.equal(currentMember?.activityKind, 'web');
    assert.ok(currentMember?.activityUpdatedAt);
  });
});

test('group stages reuse one member bubble while other members remain isolated', async () => {
  await withHost(async ({ store, runtime, host, events }) => {
    const first = store.createBot('Stage Researcher', 'a');
    const second = store.createBot('Stage Writer', 'b');
    const group = store.createGroup('Stage room', [first.bot.id, second.bot.id]);
    const sending = host.sendGroup(group.id, '@everyone compare the documents');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    starts.forEach((start, index) => start.resolve({
      turn: { id: `stage-group-turn-${index}`, status: 'inProgress' }
    }));
    await sending;

    const runtimeState = host.snapshot().groupRuntimes[group.id];
    assert.ok(runtimeState);
    const firstMember = runtimeState.members.find(member => member.botId === first.bot.id);
    const secondMember = runtimeState.members.find(member => member.botId === second.bot.id);
    assert.ok(firstMember);
    assert.ok(secondMember);
    const firstStart = starts.find(start =>
      start.params.threadId === store.chat(firstMember.chatId).threadId
    );
    const secondStart = starts.find(start =>
      start.params.threadId === store.chat(secondMember.chatId).threadId
    );
    assert.ok(firstStart);
    assert.ok(secondStart);

    runtime.emit('notification', 'item/completed', {
      threadId: firstStart.params.threadId,
      turnId: 'stage-group-turn-0',
      item: {
        id: 'stage-group-commentary',
        type: 'agentMessage',
        phase: 'commentary',
        text: '正在核对文档差异'
      }
    });
    let firstStage = store.groupMessages(group.id)
      .find(message => message.role === 'assistant' && message.senderBotId === first.bot.id);
    assert.equal(firstStage?.text, '正在核对文档差异');
    const firstStageId = firstStage?.id;
    runtime.emit('notification', 'item/completed', {
      threadId: firstStart.params.threadId,
      turnId: 'stage-group-turn-0',
      item: {
        id: 'stage-group-partial',
        type: 'agentMessage',
        phase: 'partial_answer',
        text: '差异集中在开头'
      }
    });
    firstStage = store.groupMessages(group.id)
      .find(message => message.role === 'assistant' && message.senderBotId === first.bot.id);
    assert.equal(firstStage?.id, firstStageId);
    assert.equal(firstStage?.text, '差异集中在开头');

    runtime.emit('notification', 'item/completed', {
      threadId: secondStart.params.threadId,
      turnId: 'stage-group-turn-1',
      item: {
        id: 'stage-group-final',
        type: 'agentMessage',
        phase: 'final_answer',
        text: '核对完成，两处措辞不同。'
      }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: secondStart.params.threadId,
      turn: { id: 'stage-group-turn-1', status: 'completed' }
    });
    const assistantMessages = store.groupMessages(group.id)
      .filter(message => message.role === 'assistant');
    assert.equal(assistantMessages.length, 2);
    const firstReply = assistantMessages.find(message => message.senderBotId === first.bot.id);
    const secondReply = assistantMessages.find(message => message.senderBotId === second.bot.id);
    assert.equal(firstReply?.id, firstStageId);
    assert.equal(firstReply?.text, '差异集中在开头');
    assert.equal(secondReply?.text, '核对完成，两处措辞不同。');
    assert.equal(secondReply?.phase, 'final_answer');
    assert.ok(events.some(event =>
      event.type === 'groupMessage' && event.message.senderBotId === first.bot.id
    ));
  });
});

test('group stop interrupts only members with an active turn and tolerates naturally finished races', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('Stoppable room', [first.bot.id, second.bot.id]);
    const sending = host.sendGroup(group.id, '@everyone answer this group question');

    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    starts[0].resolve({ turn: { id: 'group-stop-turn-1', status: 'inProgress' } });
    starts[1].resolve({ turn: { id: 'group-stop-turn-2', status: 'inProgress' } });
    await sending;
    await waitFor(() => host.snapshot().groupRuntimes[group.id]?.members
      .every(member => member.phase === 'judging'));
    const firstMemberChat = host.snapshot().groupRuntimes[group.id]?.members
      .find(member => member.botId === first.bot.id)?.chatId;
    assert.ok(firstMemberChat);
    const secondMemberChat = host.snapshot().groupRuntimes[group.id]?.members
      .find(member => member.botId === second.bot.id)?.chatId;
    assert.ok(secondMemberChat);
    const firstThreadId = store.chat(firstMemberChat).threadId;
    const groupMessageCount = store.groupMessages(group.id).length;
    const secondStart = starts.find(start => start.params.threadId === store.chat(secondMemberChat).threadId);
    const firstStart = starts.find(start => start.params.threadId === firstThreadId);
    assert.ok(firstStart);
    assert.ok(secondStart);
    const firstTurnId = host.activeTurns.get(firstMemberChat);
    const secondTurnId = host.activeTurns.get(secondMemberChat);
    assert.ok(firstTurnId);
    assert.ok(secondTurnId);

    runtime.emit('notification', 'turn/completed', {
      threadId: secondStart.params.threadId,
      turn: { id: secondTurnId, status: 'completed' }
    });
    await host.interruptGroup(group.id);

    const interrupts = runtime.requests.filter(request =>
      request.method === 'turn/interrupt' &&
      request.params.threadId === firstStart.params.threadId
    );
    assert.equal(interrupts.length, 1);
    assert.deepEqual(interrupts[0].params, {
      threadId: firstStart.params.threadId,
      turnId: firstTurnId
    });
    assert.equal(host.snapshot().groupRuntimes[group.id], undefined);
    assert.equal(host.activeTurns.has(firstMemberChat), false);
    assert.equal(store.turns(firstMemberChat)[0].status, 'interrupted');
    assert.equal(store.chat(firstMemberChat).threadId, null);
    assert.equal(store.chat(secondMemberChat).threadId, secondStart.params.threadId);
    assert.equal(store.groupMessages(group.id).length, groupMessageCount);

    runtime.emit('notification', 'turn/completed', {
      threadId: firstStart.params.threadId,
      turn: { id: firstTurnId, status: 'interrupted' }
    });
    assert.equal(host.snapshot().groupRuntimes[group.id], undefined);
    assert.equal(host.activeTurns.has(firstMemberChat), false);
    assert.equal(store.turns(firstMemberChat)[0].status, 'interrupted');

    const resumed = host.sendGroup(group.id, '@Researcher continue after stop');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 3);
    assert.equal(runtime.requests.some(request => request.method === 'turn/steer'), false);
    const nextStart = runtime.requests.filter(request => request.method === 'turn/start')[2];
    assert.notEqual(nextStart.params.threadId, firstThreadId);
    assert.equal(store.chat(firstMemberChat).threadId, nextStart.params.threadId);
    nextStart.resolve({ turn: { id: 'group-stop-turn-3', status: 'inProgress' } });
    await resumed;
    runtime.emit('notification', 'turn/completed', {
      threadId: nextStart.params.threadId,
      turn: { id: 'group-stop-turn-3', status: 'completed' }
    });
    assert.equal(host.activeTurns.has(firstMemberChat), false);
  });
});

test('group stop releases the group lock before a member turn/start response arrives', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Late starter', 'a');
    const second = store.createBot('Quick peer', 'b');
    const group = store.createGroup('Stopping room', [first.bot.id, second.bot.id]);
    const sending = host.sendGroup(group.id, '@everyone reply after stop');

    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 2);
    const starts = runtime.requests.filter(request => request.method === 'turn/start');
    const firstMemberChat = store.groupSession(group.id, first.bot.id).id;
    const secondMemberChat = store.groupSession(group.id, second.bot.id).id;
    const firstThreadId = store.chat(firstMemberChat).threadId;
    const secondThreadId = store.chat(secondMemberChat).threadId;
    const firstStart = starts.find(start => start.params.threadId === firstThreadId);
    const secondStart = starts.find(start => start.params.threadId === secondThreadId);
    assert.ok(firstStart);
    assert.ok(secondStart);
    secondStart.resolve({ turn: { id: 'quick-peer-turn', status: 'inProgress' } });
    await waitFor(() => host.activeTurns.has(secondMemberChat));

    await host.interruptGroup(group.id);
    assert.equal(host.isGroupBusy(group.id), false);
    assert.equal(store.chat(secondMemberChat).threadId, null);
    assert.equal(host.activeTurns.has(secondMemberChat), false);
    assert.equal(store.turns(firstMemberChat)[0].status, 'interrupted');
    assert.equal(store.chat(firstMemberChat).threadId, null);
    firstStart.resolve({ turn: { id: 'late-old-turn', status: 'inProgress' } });
    await sending;
    await waitFor(() => store.turns(firstMemberChat)[0].turnId === 'late-old-turn');
    assert.equal(store.turns(firstMemberChat)[0].status, 'interrupted');

    const resent = host.sendGroup(group.id, '@Late starter continue now');
    await waitFor(() => runtime.requests.filter(request => request.method === 'thread/start').length >= 2);
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 3);
    const newStart = runtime.requests.filter(request => request.method === 'turn/start')[2];
    assert.notEqual(newStart.params.threadId, firstThreadId);
    newStart.resolve({ turn: { id: 'new-after-stop-turn', status: 'inProgress' } });
    await resent;
    assert.equal(host.activeTurns.has(firstMemberChat), true);
    runtime.emit('notification', 'turn/completed', {
      threadId: newStart.params.threadId,
      turn: { id: 'new-after-stop-turn', status: 'completed' }
    });
  });
});

test('a late group turn/started notification cannot reactivate a stopped member', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Late notifier', 'a');
    const second = store.createBot('Quiet peer', 'b');
    const group = store.createGroup('Late notification room', [first.bot.id, second.bot.id]);
    const sending = host.sendGroup(group.id, '@Late notifier reply before the late notification');

    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'late-notification-turn', status: 'inProgress' } });
    await sending;

    const memberChat = store.groupSession(group.id, first.bot.id).id;
    const threadId = store.chat(memberChat).threadId;
    assert.ok(threadId);
    assert.equal(host.activeTurns.get(memberChat), 'late-notification-turn');

    // Simulate the stopped runtime being gone before a delayed notification arrives.
    host.groupRuntimes.delete(group.id);
    host.activeTurns.delete(memberChat);
    runtime.emit('notification', 'turn/started', {
      threadId,
      turn: { id: 'late-notification-turn', status: 'inProgress' }
    });

    await waitFor(() => runtime.requests.some(request =>
      request.method === 'turn/interrupt' &&
      request.params.threadId === threadId &&
      request.params.turnId === 'late-notification-turn'
    ));
    assert.equal(host.activeTurns.has(memberChat), false);
    assert.equal(store.turns(memberChat)[0].status, 'interrupted');
    assert.equal(store.chat(memberChat).threadId, null);
  });
});

test('an explicit group mention creates a one-member runtime and clears it without a default responder', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('Directed runtime room', [first.bot.id, second.bot.id]);
    const sending = host.sendGroup(group.id, '@Writer give a short runtime status');
    await waitFor(() => runtime.requests.filter(request => request.method === 'turn/start').length === 1);
    const runtimeState = host.snapshot().groupRuntimes[group.id];
    assert.ok(runtimeState);
    assert.deepEqual(runtimeState.members.map(member => member.botId), [second.bot.id]);
    assert.equal(runtimeState.members[0].phase, 'starting');
    const start = runtime.requests.find(request => request.method === 'turn/start');
    start.resolve({ turn: { id: 'directed-runtime-turn', status: 'inProgress' } });
    await sending;
    await waitFor(() => host.snapshot().groupRuntimes[group.id]?.members[0]?.phase === 'working');
    runtime.emit('notification', 'turn/completed', {
      threadId: start.params.threadId,
      turn: { id: 'directed-runtime-turn', status: 'completed' }
    });
    assert.equal(host.snapshot().groupRuntimes[group.id], undefined);
    assert.equal(store.groupSessions().some(session => session.groupId === group.id && session.botId === first.bot.id), false);
    assert.deepEqual(store.groupSessions().map(session => session.botId), [second.bot.id]);
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
    assert.ok(starts.every(start => start.params.input[0].text.includes('成员独立判断')));
    assert.ok(starts.every(start => start.params.input[0].text.includes('[[RAMBO_NO_GROUP_REPLY]]')));
    assert.ok(starts.every(start => !start.params.input[0].text.includes('必须以自己的 Bot 身份回复')));
    const turnIdByThread = new Map();
    starts.forEach((start, index) => {
      const turnId = `everyone-${index}`;
      turnIdByThread.set(start.params.threadId, turnId);
      start.resolve({ turn: { id: turnId, status: 'inProgress' } });
    });
    await sending;

    const noReplySession = store.groupSessions().find(session =>
      session.groupId === group.id &&
      session.purpose === 'member' &&
      store.chat(session.chatId).threadId === starts[0].params.threadId
    );
    assert.ok(noReplySession);
    const noReplyBot = store.bot(noReplySession.botId);
    const replyingBot = [first.bot, second.bot].find(bot => bot.id !== noReplyBot.id);
    assert.ok(replyingBot);
    runtime.emit('notification', 'item/completed', {
      threadId: starts[0].params.threadId,
      item: { id: 'everyone-no-reply', type: 'agentMessage', text: '[[RAMBO_NO_GROUP_REPLY]]' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: starts[0].params.threadId,
      turn: { id: turnIdByThread.get(starts[0].params.threadId), status: 'completed' }
    });
    runtime.emit('notification', 'item/completed', {
      threadId: starts[1].params.threadId,
      item: { id: 'everyone-reply', type: 'agentMessage', text: 'EVERYONE-MEMBER-REPLY-7C9M' }
    });
    runtime.emit('notification', 'turn/completed', {
      threadId: starts[1].params.threadId,
      turn: { id: turnIdByThread.get(starts[1].params.threadId), status: 'completed' }
    });

    const messages = store.groupMessages(group.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].senderBotId, replyingBot.id);
    assert.equal(messages[1].text, 'EVERYONE-MEMBER-REPLY-7C9M');
    assert.equal(messages.some(message => message.role === 'system' && message.text.includes(noReplyBot.name)), false);
  });
});

test('@name dispatches only to the named member', async () => {
  await withHost(async ({ store, runtime, host }) => {
    const first = store.createBot('Researcher', 'a');
    const second = store.createBot('Writer', 'b');
    const group = store.createGroup('Project room', [first.bot.id, second.bot.id]);
    store.addGroupMessage(group.id, 'system', '「Writer」未能生成正式回复（返回了内部不回复标记）。', {
      status: 'failed'
    });
    store.addGroupMessage(group.id, 'system', '「Writer」未能开始回复：上一条消息正在发送，请稍后', {
      status: 'failed'
    });
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
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, '@Writer draft a summary');
    const issue = store.activities(store.groupSessions()[0].chatId).find(activity =>
      activity.title === '群聊回复未生成'
    );
    assert.ok(issue);
    assert.equal(issue.status, 'failed');
    assert.match(issue.detail, /Writer/);
    assert.match(issue.detail, /内部不回复标记/);
    assert.equal(issue.detail.includes('RAMBO_NO_GROUP_REPLY'), false);
  });
});

test('transient group response failures stay out of the system timeline', async () => {
  await withHost(async ({ store, host }) => {
    const writer = store.createBot('Writer', 'b');
    const reviewer = store.createBot('Reviewer', 'a');
    const group = store.createGroup(
      'Project room', [writer.bot.id, reviewer.bot.id], 'Draft summaries', writer.bot.id
    );
    const session = store.groupSession(group.id, writer.bot.id);
    host.sendConversation = async () => {
      throw new Error('上一条消息正在发送，请稍后');
    };

    await host.sendGroup(group.id, '@Writer draft a summary');
    await waitFor(() => store.activities(session.id).some(activity =>
      activity.title === '群聊回复未开始'
    ));

    const messages = store.groupMessages(group.id);
    assert.deepEqual(messages.map(message => message.role), ['user']);
    const issue = store.activities(session.id).find(activity => activity.title === '群聊回复未开始');
    assert.ok(issue);
    assert.equal(issue.status, 'failed');
    assert.match(issue.detail, /上一条消息正在发送，请稍后/);
  });
});

test('an @everyone member setup failure stays out of the system timeline', async t => {
  await withHost(async ({ store, runtime, host }) => {
    const warning = t.mock.method(console, 'warn', () => {});
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

    assert.equal(store.groupMessages(group.id).some(message => message.role === 'system'), false);
    assert.equal(warning.mock.callCount(), 1);
  });
});
