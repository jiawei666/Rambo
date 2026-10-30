const { app, BrowserWindow, dialog, ipcMain, utilityProcess } = require('electron');
const { randomUUID } = require('node:crypto');
const { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } = require('node:fs');
const { join, relative, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

const projectRoot = resolve(__dirname, '../../..');
const connectionId = randomUUID();
let mainWindow;
let wizard;
let runInProgress = false;

app.setName('Rambo 微信实时诊断');

function html() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>微信实时诊断</title><style>
*{box-sizing:border-box}body{margin:0;background:#151515;color:#eee;font:15px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{max-width:900px;margin:0 auto;padding:28px}h1{font-size:22px;margin:0 0 8px}p{color:#b8b8b8;margin:6px 0 18px}.notice{padding:14px 16px;background:#242424;border:1px solid #3b3b3b;border-radius:12px;margin:16px 0}
#status{font-weight:600;color:#9fddb1}#log{height:420px;overflow:auto;background:#101010;border:1px solid #333;border-radius:10px;padding:12px 14px;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}
.entry{padding:3px 0;border-bottom:1px solid #202020;white-space:pre-wrap;overflow-wrap:anywhere}.time{color:#858585;margin-right:10px}.error{color:#ff9a9a}.success{color:#9fddb1}.actions{display:flex;gap:10px;margin-top:16px}button{border:0;border-radius:9px;padding:11px 16px;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.4;cursor:default}#start{background:#f3f3f3;color:#111}#stop{background:#c3f1d0;color:#102117}#close{background:#303030;color:#eee}
</style></head><body><main>
<h1>微信实时解密诊断</h1>
<p>独立运行，不创建 Rambo Connection 或 Bot Grant。这里的“监听”指观察微信读取本机数据库时的密钥，不是新消息实时推送。只显示阶段、计数和数据库诊断，不展示密钥、聊天正文、联系人名称或媒体文件名。</p>
<div class="notice"><div id="status">诊断器就绪</div><div>会复用已保存的 Rambo 受管微信副本。点击“开始监听”后，你可以随时操作微信；监听不会自动停止。完成后点击“结束监听并验证”。本窗口会保持打开，支持反复开始和结束。</div></div>
<div id="log" role="log" aria-live="polite"></div>
<div class="actions"><button id="start">开始监听</button><button id="stop" disabled>结束监听并验证</button><button id="close">关闭诊断</button></div>
</main><script>
const log=document.querySelector('#log'),status=document.querySelector('#status'),start=document.querySelector('#start'),stop=document.querySelector('#stop');
window.liveTestUi={
  add(entry){const row=document.createElement('div');row.className='entry '+(entry.kind||'');const time=document.createElement('span');time.className='time';time.textContent=entry.time;const text=document.createElement('span');text.textContent=entry.text;row.append(time,text);log.append(row);log.scrollTop=log.scrollHeight;status.textContent=entry.status||entry.text;},
  gate(ready){start.disabled=!ready;},stop(ready){stop.disabled=!ready;}
};
start.addEventListener('click',()=>window.liveTest.startCapture());
stop.addEventListener('click',()=>window.liveTest.stopCapture());
document.querySelector('#close').addEventListener('click',()=>window.liveTest.close());
</script></body></html>`;
}

function postToUi(entry) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  const safeEntry = {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    kind: entry.kind ?? 'info',
    status: entry.status ?? '',
    text: String(entry.text).replace(/\b[a-f0-9]{64}\b/giu, '<密钥>').replace(/\/Users\/[^/\s]+/gu, '~').slice(0, 1_000)
  };
  void mainWindow.webContents.executeJavaScript(`window.liveTestUi?.add(${JSON.stringify(safeEntry)})`).catch(() => {});
}

function setStartReady(ready) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  void mainWindow.webContents.executeJavaScript(`window.liveTestUi?.gate(${Boolean(ready)})`).catch(() => {});
}

function setStopReady(ready) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  void mainWindow.webContents.executeJavaScript(`window.liveTestUi?.stop(${Boolean(ready)})`).catch(() => {});
}

function summarizeWechatDatabaseKeyCoverage(keys) {
  const paths = Object.keys(keys);
  const matched = path => paths.includes(path);
  const states = [
    ['会话库', matched('db_storage/session/session.db')],
    ['聊天库', paths.some(path => /^db_storage\/message\/message_\d+\.db$/u.test(path))],
    ['媒体库', paths.some(path => /^db_storage\/message\/media_\d+\.db$/u.test(path))]
  ];
  return states.map(([label, isMatched]) => `${label}${isMatched ? '已匹配' : '未匹配'}`).join('；');
}

function compileModule(file, replacements = []) {
  let source = readFileSync(file, 'utf8');
  for (const [specifier, url] of replacements) {
    source = source.replaceAll(`from '${specifier}'`, `from '${url}'`)
      .replaceAll(`from \"${specifier}\"`, `from \"${url}\"`);
  }
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

async function loadDiagnosticModules() {
  const sqlCipherUrl = compileModule(join(projectRoot, 'src/main/wechat-sqlcipher.ts'));
  const xmldomUrl = pathToFileURL(require.resolve('@xmldom/xmldom')).href;
  const commonUrl = compileModule(join(projectRoot, 'src/main/wechat-connector-common.ts'), [
    ['./wechat-sqlcipher', sqlCipherUrl]
  ]);
  const macUrl = compileModule(join(projectRoot, 'src/main/wechat-connector-macos.ts'), [
    ['./wechat-sqlcipher', sqlCipherUrl],
    ['./wechat-connector-common', commonUrl],
    ['@xmldom/xmldom', xmldomUrl]
  ]);
  const windowsUrl = compileModule(join(projectRoot, 'src/main/wechat-connector-windows.ts'), [
    ['./wechat-connector-common', commonUrl]
  ]);
  const wizardUrl = compileModule(join(projectRoot, 'src/main/wechat-connector-wizard.ts'), [
    ['./wechat-connector-macos', macUrl],
    ['./wechat-connector-windows', windowsUrl]
  ]);
  const adapterUrl = compileModule(join(projectRoot, 'src/main/wechat-adapter.ts'));
  const transportUrl = compileModule(join(projectRoot, 'src/main/wechat-worker-transport.ts'));
  return {
    wizard: await import(wizardUrl),
    adapter: await import(adapterUrl),
    transport: await import(transportUrl)
  };
}

async function runDiagnostic() {
  const { wizard: wizardModule, adapter, transport } = await loadDiagnosticModules();
  const ramboUserDataDirectory = join(app.getPath('appData'), 'Rambo');
  const accountSelectionFile = join(ramboUserDataDirectory, 'managed-wechat-live-diagnostic', 'account.json');

  function accountForSelection(defaultDirectory, selectedDirectory) {
    try {
      const root = realpathSync(defaultDirectory);
      const selected = realpathSync(selectedDirectory);
      const relativePath = relative(root, selected);
      const accountId = relativePath.split(sep).filter(Boolean)[0] ?? '';
      if (!/^wxid_[a-zA-Z0-9_-]{3,200}$/u.test(accountId)) return null;
      const accountDirectory = join(root, accountId);
      const info = lstatSync(accountDirectory);
      if (info.isSymbolicLink() || !info.isDirectory() || !existsSync(join(accountDirectory, 'db_storage'))) return null;
      if (selected !== accountDirectory && !selected.startsWith(`${accountDirectory}${sep}`)) return null;
      return { accountId, accountDirectory };
    } catch { return null; }
  }

  function savedAccountDirectory(defaultDirectory) {
    try {
      const saved = JSON.parse(readFileSync(accountSelectionFile, 'utf8'));
      if (typeof saved.accountId !== 'string' || !/^wxid_[a-zA-Z0-9_-]{3,200}$/u.test(saved.accountId)) return null;
      return accountForSelection(defaultDirectory, join(defaultDirectory, saved.accountId))?.accountDirectory ?? null;
    } catch { return null; }
  }

  function rememberAccount(defaultDirectory, selectedDirectory) {
    const account = accountForSelection(defaultDirectory, selectedDirectory);
    if (!account) return;
    try {
      mkdirSync(join(ramboUserDataDirectory, 'managed-wechat-live-diagnostic'), { recursive: true, mode: 0o700 });
      writeFileSync(accountSelectionFile, JSON.stringify({ accountId: account.accountId }), { mode: 0o600 });
    } catch { /* picker fallback remains available when local preference storage fails */ }
  }

  const prompts = {
    confirmCloseWechat: async () => {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '微信实时诊断',
        message: '需要暂时退出主微信，并启动一个独立临时副本。',
        detail: '主微信应用不会被修改；测试结束后副本会清理。请先保存未发送内容。',
        buttons: ['取消', '继续'],
        defaultId: 1,
        cancelId: 0
      });
      return result.response === 1;
    },
    chooseAccountDirectory: async defaultDirectory => {
      const rememberedDirectory = savedAccountDirectory(defaultDirectory);
      if (rememberedDirectory) return rememberedDirectory;

      let pickerDefaultPath = defaultDirectory;
      try {
        const accounts = readdirSync(defaultDirectory, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && /^wxid_[a-zA-Z0-9_-]{3,200}$/u.test(entry.name))
          .map(entry => join(defaultDirectory, entry.name))
          .filter(directory => existsSync(join(directory, 'db_storage')));
        if (accounts.length === 1) {
          rememberAccount(defaultDirectory, accounts[0]);
          return accounts[0];
        }
        if (accounts.length > 1) pickerDefaultPath = accounts[0];
      } catch { /* the native picker remains the fallback when directory access needs user approval */ }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择要验证的微信账号目录',
        message: '选择 xwechat_files 中以 wxid_ 开头的账号目录。',
        defaultPath: pickerDefaultPath,
        properties: ['openDirectory']
      });
      const selectedDirectory = result.canceled ? null : result.filePaths[0] ?? null;
      if (selectedDirectory) rememberAccount(defaultDirectory, selectedDirectory);
      return selectedDirectory;
    }
  };

  wizard = new wizardModule.WechatConnectorWizard(
    ramboUserDataDirectory, prompts, app.getPath('home'), {},
    { captureSeconds: 300, manualStopOnly: true, reuseManagedClone: true }
  );

  let captured = null;
  let reader = null;
  try {
    postToUi({ status: '正在复用 Rambo 受管微信副本。', text: '开始检查微信版本、副本签名与本机 Frida 环境。' });
    captured = await wizard.capture(connectionId, state => {
      const isHookReady = state.message.includes('密钥捕获钩子已就绪');
      if (isHookReady) setStopReady(true);
      postToUi({
        status: state.message,
        text: state.message,
        kind: state.phase === 'complete' ? 'success' : 'info'
      });
    });
    setStopReady(false);
    postToUi({
      status: '密钥匹配结果已生成。',
      text: `候选密钥已匹配到 ${Object.keys(captured.keys).length} 个数据库；${summarizeWechatDatabaseKeyCoverage(captured.keys)}。`
    });
    postToUi({ status: '密钥匹配成功，正在内存中解密数据库。', text: 'Worker 开始在内存中解密并查询数据库。' });

    const workerPath = join(projectRoot, 'out/main/wechat-worker.js');
    const workerTransport = new transport.ElectronWechatWorkerTransport(
      workerPath,
      (modulePath, args, options) => utilityProcess.fork(modulePath, args, options)
    );
    reader = new adapter.SqlCipherWechatReader(workerTransport);
    const connection = { id: connectionId, providerId: 'wechat', status: 'ready' };
    const credential = {
      kind: 'wechat-sqlcipher',
      accountId: captured.accountId,
      keys: captured.keys,
      dataDirectory: captured.dataDirectory,
      wechatVersion: captured.wechatVersion,
      wechatBuild: captured.wechatBuild
    };
    const end = new Date();
    const start = new Date(end.getTime() - 365 * 86_400_000);

    const sessions = await reader.sessions(connection, credential);
    adapter.assertWechatPageDatabasesReadable('会话', sessions);
    postToUi({ status: '会话数据库解密成功。', kind: 'success', text: `会话库已解密：本页 ${sessions.returnedCount} 条${sessions.hasMore ? '，其余可分页读取' : ''}。` });

    let messageCount = 0;
    const mediaHandles = new Map();
    if (sessions.items.length) {
      const messages = await reader.messages(connection, credential, {
        sessionIds: sessions.items.slice(0, 8).map(session => session.sessionId),
        start: start.toISOString(), end: end.toISOString()
      });
      adapter.assertWechatPageDatabasesReadable('聊天或媒体', messages);
      messageCount = messages.returnedCount;
      for (const message of messages.items) {
        for (const media of message.media) {
          if (!media.resourceHandle || !['available', 'thumbnailOnly'].includes(media.status)) continue;
          if (!mediaHandles.has(media.kind)) mediaHandles.set(media.kind, media.resourceHandle);
        }
      }
    }
    postToUi({ status: '聊天消息数据库解密成功。', kind: 'success', text: `消息库已解密：最近 365 天、最多 8 个会话，本页 ${messageCount} 条。` });

    let decryptedMediaCount = 0;
    for (const kind of ['image', 'audio', 'video', 'file', 'sticker']) {
      const handle = mediaHandles.get(kind);
      if (!handle) continue;
      const resource = await reader.readMedia(connection, credential, handle);
      const byteLength = resource.bytes.length;
      resource.bytes.fill(0);
      if (byteLength < 1) throw new Error(`${kind} 媒体解密结果为空`);
      decryptedMediaCount += 1;
      postToUi({ status: `${kind} 媒体解密成功。`, kind: 'success', text: `${kind} 本机媒体样本已在内存解密（${byteLength} 字节，内容已清除）。` });
    }
    if (!decryptedMediaCount) {
      postToUi({ status: '聊天数据库已通过；本页没有可用的媒体句柄。', text: '媒体数据库已参与 SQLCipher 匹配；本次消息页没有可读取的图片、语音或视频样本。' });
    }
    postToUi({
      status: '独立连接诊断通过。',
      kind: 'success',
      text: `通过：${Object.keys(captured.keys).length} 个必要库密钥、会话和消息查询${decryptedMediaCount ? `、${decryptedMediaCount} 种媒体解密` : ''}。未保存账号连接或聊天正文。`
    });
  } catch (error) {
    setStartReady(false);
    setStopReady(false);
    postToUi({
      status: '独立实时诊断失败。',
      kind: 'error',
      text: error instanceof Error ? error.message : String(error)
    });
  } finally {
    setStartReady(false);
    setStopReady(false);
    try { reader?.dispose(); } catch {}
    if (captured?.keys) {
      for (const entry of Object.values(captured.keys)) entry.encKey = '';
    }
    captured = null;
    runInProgress = false;
    setStartReady(true);
    setStopReady(false);
    postToUi({ status: '本轮监听结束；诊断器仍在运行。', text: '本轮捕获文件已清理；受管微信副本保持运行；Worker 已停止。点击“开始监听”可再次捕获。' });
  }
}

ipcMain.handle('wechat-live:start-capture', () => {
  if (runInProgress) return false;
  runInProgress = true;
  setStartReady(false);
  setStopReady(false);
  postToUi({ status: '正在启动密钥监听。', text: '准备复用受管副本并附加 Frida。' });
  void runDiagnostic().catch(error => {
    runInProgress = false;
    setStartReady(true);
    setStopReady(false);
    postToUi({ status: '独立诊断启动失败。', kind: 'error', text: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

ipcMain.handle('wechat-live:stop-capture', () => {
  const stopped = wizard?.requestCaptureStop(connectionId) ?? false;
  if (stopped) {
    setStopReady(false);
    postToUi({ status: '已请求结束密钥捕获，马上验证数据库。', text: '捕获停止信号已发送。' });
  }
  return stopped;
});

ipcMain.handle('wechat-live:close', () => {
  if (runInProgress) wizard?.cancel(connectionId);
  app.quit();
  return true;
});

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    title: 'Rambo 微信实时诊断',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs')
    }
  });
  mainWindow.on('close', () => {
    if (runInProgress) wizard?.cancel(connectionId);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    postToUi({ status: '诊断器就绪。', text: '点击“开始监听”后开始捕获；点击“结束监听并验证”后完成这一轮。诊断器和受管微信副本会保持运行。' });
    setStartReady(true);
  });
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`);
});

app.on('window-all-closed', () => {
  if (runInProgress) wizard?.cancel(connectionId);
  app.quit();
});
