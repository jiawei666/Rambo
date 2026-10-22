import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { join, resolve } from 'node:path';
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store } from './store';
import { CodexRuntime } from './runtime';
import { Host } from './host';
import { removeManagedBotDirectory } from './bot-data';
import {
  createElectronLoginItemAdapter,
  LoginItemController
} from './login-item';
import type { AppEvent } from '../shared/contracts';

app.setName('Rambo');
// 验收模式只接受台账创建的目录；出错就拒绝启动，不能回退到日常数据。
let acceptanceRunId: string | null = null;
if (process.env.RAMBO_ACCEPTANCE_RUN) {
  const requested = resolve(process.env.RAMBO_ACCEPTANCE_RUN);
  const root = realpathSync(requested);
  if (root !== requested) throw new Error('验收目录不能包含符号链接');
  const markerPath = join(root, 'run.json');
  if (lstatSync(markerPath).isSymbolicLink()) throw new Error('验收标记不能是符号链接');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (marker.schema !== 'rambo.acceptance.run.v1' || typeof marker.runId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(marker.runId) || typeof marker.project !== 'string' ||
      join(realpathSync(marker.project), 'acceptance-runs', marker.runId) !== root) {
    throw new Error('验收目录标记无效');
  }
  for (const directory of ['profile', 'chromium']) {
    const path = join(root, directory);
    mkdirSync(path, { recursive: true });
    if (realpathSync(path) !== path) throw new Error('验收数据目录不能包含符号链接');
    app.setPath(directory === 'profile' ? 'userData' : 'sessionData', path);
  }
  acceptanceRunId = marker.runId;
}
if (process.env.RAMBO_ACCEPTANCE_CDP_PORT !== undefined) {
  if (!acceptanceRunId) throw new Error('CDP 仅允许在独立验收实例中启用');
  const port = Number(process.env.RAMBO_ACCEPTANCE_CDP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('验收 CDP 端口无效');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
}
let window: BrowserWindow | null = null;
let quitting = false;
let store: Store;
let host: Host;
let runtime: CodexRuntime;
let loginItem: LoginItemController;
const text = (value: unknown, max = 200_000): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('无效的文字参数');
  return value;
};
const id = (value: unknown) => text(value, 100);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的参数');
  return value as Record<string, unknown>;
};
const emit = (event: AppEvent) => { if (window && !window.isDestroyed()) window.webContents.send('rambo:event', event); };
const rendererFile = join(__dirname, '../renderer/index.html');
const devURL = process.env.ELECTRON_RENDERER_URL;

function registerIPC(): void {
  const methods: Record<string, (...args: any[]) => unknown> = {
    snapshot: () => host.snapshot(),
    createBot: value => {
      const input = object(value), name = text(input.name, 255).trim(), avatar = text(input.avatar, 200);
      if (!name) throw new Error('请填写机器人名称');
      const result = store.createBot(name, avatar); host.changed(); return result;
    },
    updateBot: (botId, input) => {
      const patch = object(input);
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'archived') throw new Error('请使用专用的 Bot 归档操作');
        else if (key === 'model' && value === null) continue;
        else text(value, key === 'instructions' ? 50_000 : 500);
      }
      if ('name' in patch && !String(patch.name).trim()) throw new Error('名称不能为空');
      if ('permission' in patch && !['fullAccess', 'workspaceWrite', 'readOnly'].includes(String(patch.permission))) throw new Error('无效的权限模式');
      const bot = store.updateBot(id(botId), patch); host.changed(); return bot;
    },
    setBotArchived: (botId, archived) => {
      if (typeof archived !== 'boolean') throw new Error('无效的归档状态');
      const bot = store.setBotArchived(id(botId), archived);
      host.changed();
      return bot;
    },
    deleteBot: async botId => {
      const bot = store.bot(id(botId));
      const chats = store.botChats(bot.id);
      if (chats.some(chat => host.activeTurns.has(chat.id))) throw new Error('请先停止该 Bot 的任务，再永久删除');
      const threadIds = [...new Set(chats.flatMap(chat => chat.threadId ? [chat.threadId] : []))];
      if (threadIds.length) {
        await runtime.start();
        for (const threadId of threadIds) await runtime.request('thread/delete', { threadId });
      }
      store.deleteBot(bot.id);
      try {
        removeManagedBotDirectory(store.directory, bot.id);
      } catch (error) {
        host.changed();
        throw new Error(`Bot 已从 Rambo 移除，但专属工作区清理失败：${error instanceof Error ? error.message : String(error)}`);
      }
      host.changed();
    },
    ensureBotChat: botId => { const chat = store.ensureBotChat(id(botId)); host.changed(); return chat; },
    createGroup: value => {
      const input = object(value);
      const title = text(input.title, 120).trim();
      if (!title) throw new Error('请填写群聊名称');
      if (!Array.isArray(input.botIds)) throw new Error('无效的群聊成员');
      const botIds = input.botIds.map(id);
      const group = store.createGroup(title, botIds);
      host.changed();
      return group;
    },
    addGroupMembers: (groupId, botIds) => {
      if (!Array.isArray(botIds)) throw new Error('无效的群聊成员');
      const group = store.addGroupMembers(id(groupId), botIds.map(id));
      host.changed();
      return group;
    },
    groupMemberChats: groupId => store.groupMemberChats(id(groupId)),
    groupMessages: groupId => store.groupMessages(id(groupId)),
    sendGroup: (groupId, content) => host.sendGroup(id(groupId), text(content)),
    updateChat: (chatId, input) => {
      const patch = object(input);
      const allowed = new Set(['model', 'permission']);
      for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error('不支持的聊天字段');
      if (patch.model !== undefined && patch.model !== null) {
        const model = text(patch.model, 200).trim();
        if (!model) throw new Error('聊天模型不能为空');
        patch.model = model;
      }
      if (patch.permission !== undefined && patch.permission !== null &&
          !['fullAccess', 'workspaceWrite', 'readOnly'].includes(String(patch.permission))) throw new Error('无效的权限模式');
      store.updateChat(id(chatId), patch); host.changed();
    },
    applyBotPermissionToChats: (botId, permission) => {
      if (!['fullAccess', 'workspaceWrite', 'readOnly'].includes(String(permission))) throw new Error('无效的权限模式');
      store.applyBotPermissionToChats(id(botId), permission as 'fullAccess' | 'workspaceWrite' | 'readOnly');
      host.changed();
    },
    setRoutineStatus: (routineId, status) => {
      if (status !== 'active' && status !== 'paused') throw new Error('无效的定时任务状态');
      const routine = store.setRoutineStatus(id(routineId), status);
      if (status === 'paused') host.routineScheduler.stopPending(routine.id, '用户暂停了定时计划');
      host.changed();
      return routine;
    },
    advanceRoutineScheduleForAcceptance: routineId => {
      if (!acceptanceRunId) throw new Error('仅验收实例允许推进定时任务时钟');
      const routine = store.routine(id(routineId));
      store.setRoutineNextRunForAcceptance(
        routine.id,
        routine.definition.kind === 'once'
          ? new Date(Date.now() - 2 * 60_000).toISOString()
          : new Date().toISOString()
      );
      host.changed();
    },
    runRoutineNow: routineId => host.routineScheduler.runNow(id(routineId)),
    stopRoutineRun: routineId => host.stopRoutineRun(id(routineId)),
    messages: chatId => store.messages(id(chatId)),
    activities: chatId => store.activities(id(chatId)),
    turns: chatId => store.turns(id(chatId)),
    send: (chatId, content) => host.send(id(chatId), text(content)),
    interrupt: chatId => host.interrupt(id(chatId)),
    search: (query, botId) => store.search(text(query, 500), botId === undefined || botId === null ? null : id(botId)),
    memories: botId => store.memories(botId === null ? null : id(botId)),
    saveMemory: value => {
      const input = object(value);
      const memory = store.saveMemory({ id: input.id === undefined ? undefined : id(input.id), botId: input.botId === null ? null : id(input.botId), text: text(input.text, 20_000) });
      host.changed();
      return memory;
    },
    deleteMemory: memoryId => { store.deleteMemory(id(memoryId)); host.changed(); },
    setSetting: (key, value) => { store.setSetting(text(key, 100), text(value, 20_000)); host.changed(); },
    setLaunchAtLogin: enabled => {
      if (typeof enabled !== 'boolean') throw new Error('无效的登录启动状态');
      loginItem.setEnabled(enabled);
      host.changed();
    },
    loginItemSystemChangesAllowed: () => !acceptanceRunId,
    injectAcceptanceEvent: event => {
      if (!acceptanceRunId) throw new Error('仅验收实例允许注入测试事件');
      const value = object(event);
      if (value.type === 'turn') {
        const chatId = id(value.chatId);
        if (!store.chat(chatId)) throw new Error('验收事件引用了不存在的聊天');
        const turnId = value.turnId === null ? null : id(value.turnId);
        emit({ type: 'turn', chatId, turnId });
        return;
      }
      if (value.type === 'message') {
        const message = object(value.message);
        const chatId = id(message.chatId);
        if (!store.chat(chatId)) throw new Error('验收事件引用了不存在的聊天');
        if (!['user', 'assistant', 'system'].includes(String(message.role))) {
          throw new Error('验收消息角色无效');
        }
        if (message.status !== undefined &&
            !['streaming', 'complete', 'failed', 'interrupted'].includes(String(message.status))) {
          throw new Error('验收消息状态无效');
        }
        emit({
          type: 'message',
          message: {
            id: id(message.id),
            chatId,
            role: message.role,
            text: text(message.text),
            status: message.status,
            itemId: message.itemId === undefined || message.itemId === null ? null : id(message.itemId),
            createdAt: text(message.createdAt, 100),
            turnId: message.turnId === undefined || message.turnId === null ? null : id(message.turnId),
            phase: message.phase === undefined ? null : message.phase
          } as any
        });
        return;
      }
      if (value.type === 'activity') {
        const activity = object(value.activity);
        const chatId = id(activity.chatId);
        if (!store.chat(chatId)) throw new Error('验收事件引用了不存在的聊天');
        emit({ type: 'activity', activity: activity as any });
        return;
      }
      if (value.type === 'routineTool') {
        const request = object(value);
        delete request.type;
        if (object(request.params).namespace !== 'rambo_routines') {
          throw new Error('验收事件只能提交 Routine 工具请求');
        }
        return host.submitAcceptanceRoutineTool(request);
      }
      if (value.type === 'acceptanceTool') {
        const request = object(value);
        delete request.type;
        const namespace = object(request.params).namespace;
        if (namespace === 'rambo_routines') return host.submitAcceptanceRoutineTool(request);
        if (namespace === 'rambo_bot') return host.submitAcceptanceBotTool(request);
        if (namespace === 'rambo_memories') return host.submitAcceptanceMemoryTool(request);
        if (namespace === 'rambo_group_history') return host.submitAcceptanceGroupHistoryTool(request);
        throw new Error('验收事件提交了不支持的工具命名空间');
      }
      if (value.type === 'acceptanceNotification') {
        return host.acceptNotification(
          text(value.method, 100),
          value.params
        );
      }
      if (value.type === 'acceptanceRoutineTick') return host.acceptRoutineTick();
      throw new Error('不支持的验收事件');
    },
    account: () => host.account(),
    login: async () => { const url = await host.login(); if (url) { if (!url.startsWith('https://')) throw new Error('登录地址协议无效'); await shell.openExternal(url); } },
    models: () => host.models(),
    startVoice: (chatId, offerSdp) => host.startVoice(id(chatId), text(offerSdp, 128_000)),
    stopVoice: (chatId, reason) => host.stopVoice(
      id(chatId),
      reason === undefined ? undefined : text(reason, 2_000)
    ),
    restartRuntime: async () => {
      if (host.activeTurns.size) throw new Error('有任务执行中，请先停止任务');
      await runtime.stop(); await runtime.start();
    }
  };
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`rambo:${name}`, (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝未知界面请求');
    return method(...args);
  });
}

function showWindow(): void {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    title: acceptanceRunId ? `Rambo · 验收 ${acceptanceRunId}` : 'Rambo', width: 1100, height: 760, minWidth: 760, minHeight: 560,
    backgroundColor: '#ffffff', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (acceptanceRunId) window.on('page-title-updated', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = devURL ? url.startsWith(new URL(devURL).origin + '/') : url === pathToFileURL(rendererFile).href;
    if (!allowed) event.preventDefault();
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  window.on('closed', () => { window = null; });
  if (devURL) void window.loadURL(devURL); else void window.loadFile(rendererFile);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = permission === 'media' && window?.webContents === webContents;
      callback(allowed);
    });
    // The packaged ICNS is already declared as the app icon in its bundle.
    // Electron's dock image loader cannot decode that ICNS path; use the source PNG only in dev.
    if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'assets/branding/app-logo-source.png'));
    store = new Store(app.getPath('userData'));
    const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
    runtime = new CodexRuntime(root, store.directory);
    host = new Host(store, runtime, emit);
    loginItem = new LoginItemController(store, createElectronLoginItemAdapter({
      isPackaged: app.isPackaged,
      platform: process.platform,
      getLoginItemSettings: () => app.getLoginItemSettings(),
      setLoginItemSettings: settings => app.setLoginItemSettings(settings)
    }, {
      // Automated acceptance uses an isolated profile, but macOS Login Items
      // are still a machine-global user setting. Never mutate them from a run.
      allowSystemChanges: !acceptanceRunId
    }));
    loginItem.applyStoredPreference();
    registerIPC();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Rambo', submenu: [{ role: 'about' }, { label: '显示 Rambo', click: showWindow }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
    ]));
    showWindow();
    void runtime.start().catch(() => {});
  }).catch(error => {
    console.error('[Rambo] startup failed', error);
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('Rambo 启动失败', message);
    app.quit();
  });
  app.on('activate', () => { if (app.isReady() && store) showWindow(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; event.preventDefault();
    void (async () => {
      host?.routineScheduler.stop();
      await runtime?.stop();
      store?.close();
      app.quit();
    })();
  });
}
