import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  deferred,
  delay,
  ensureActive,
  mapWechatKeysToDatabases,
  progress,
  redactWechatDiagnostics,
  runFile,
  summarizeWechatDatabaseCoverage,
  validateWechatAccountDirectory,
  WECHAT_CAPTURE_SECONDS,
  WECHAT_CAPTURE_TIMEOUT_MS,
  type Deferred,
  type WechatDatabaseMapping
} from './wechat-connector-common';
import type {
  ExecOptions,
  ExecResult,
  WechatCapturedAccount,
  WechatCaptureDriverStatus,
  WechatConnectorRuntime,
  WechatConnectorWizardOptions,
  WechatWizardPrompts,
  WechatWizardProgress
} from './wechat-platform-types';
import { findVerifiedWechatImageKey } from './wechat-image-key';

const RUNTIME_PREPARE_TIMEOUT_MS = 10 * 60_000;
const WECHAT_BUNDLE_ID = 'com.tencent.xinWeChat';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function nextElementSibling(node: Node | null): Element | null {
  let sibling = node?.nextSibling ?? null;
  while (sibling && sibling.nodeType !== 1) sibling = sibling.nextSibling;
  return sibling as Element | null;
}

export function parsePlistString(xml: string, key: string): string {
  let invalid = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: () => { invalid = true; },
      fatalError: () => { invalid = true; }
    }
  }).parseFromString(xml, 'application/xml');
  if (invalid) throw new Error('微信应用信息格式无效');
  const keys = Array.from(document.getElementsByTagName('key'));
  const item = keys.find(node => node.textContent === key);
  const value = nextElementSibling(item ?? null);
  if (!value || value.tagName !== 'string' || !value.textContent?.trim()) {
    throw new Error('微信应用信息缺少必要字段');
  }
  return value.textContent.trim();
}

export function withGetTaskAllow(entitlementsXml: string): string {
  const source = entitlementsXml.trim() ||
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>';
  let invalid = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: () => { invalid = true; },
      fatalError: () => { invalid = true; }
    }
  }).parseFromString(source, 'application/xml');
  if (invalid) throw new Error('微信应用权限信息无效，无法安全保留原权限');
  const dict = document.getElementsByTagName('dict')[0];
  if (!dict) throw new Error('微信应用权限信息无效，无法安全保留原权限');
  const children = Array.from(dict.childNodes).filter(node => node.nodeType === 1);
  let valueNode: Element | null = null;
  for (let index = 0; index < children.length; index++) {
    const node = children[index] as Element;
    if (node.tagName === 'key' && node.textContent === 'com.apple.security.get-task-allow') {
      valueNode = children[index + 1] as Element | undefined ?? null;
      break;
    }
  }
  const enabled = document.createElement('true');
  if (valueNode) dict.replaceChild(enabled, valueNode);
  else {
    const key = document.createElement('key');
    key.appendChild(document.createTextNode('com.apple.security.get-task-allow'));
    dict.appendChild(key);
    dict.appendChild(enabled);
  }
  return new XMLSerializer().serializeToString(document);
}

export function hasGetTaskAllow(xml: string): boolean {
  let invalid = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: () => { invalid = true; },
      fatalError: () => { invalid = true; }
    }
  }).parseFromString(xml, 'application/xml');
  if (invalid) return false;
  const keys = Array.from(document.getElementsByTagName('key'));
  const item = keys.find(node => node.textContent === 'com.apple.security.get-task-allow');
  return nextElementSibling(item ?? null)?.tagName === 'true';
}

interface ActiveWechatCapture {
  socket: Socket | null;
  token: string;
  authenticated: boolean;
  captureReady: boolean;
  continueReady: boolean;
  stopRequested: boolean;
  completed: boolean;
  failed: boolean;
  phase: WechatCaptureDriverStatus['phase'] | null;
  keyCount: number;
  roundNumber: number;
  candidates: Set<string>;
  imageCodes: Set<number>;
  round: Deferred<WechatDatabaseMapping>;
  resume: Deferred<void> | null;
  ready: Deferred<void>;
  driverDone: Deferred<void>;
  onProgress: (value: WechatWizardProgress) => void;
  send(message: Record<string, unknown>): boolean;
  fail(error: Error): void;
}

function findWechatApp(homeDirectory: string): string | null {
  const candidates = [
    '/Applications/WeChat.app',
    '/Applications/Weixin.app',
    join(homeDirectory, 'Applications/WeChat.app'),
    join(homeDirectory, 'Applications/Weixin.app')
  ];
  return candidates.find(path => existsSync(join(path, 'Contents/Info.plist'))) ?? null;
}

async function processIds(): Promise<number[]> {
  try {
    const { stdout } = await runFile('/usr/bin/pgrep', ['-x', 'WeChat']);
    return stdout.trim().split(/\s+/u).map(Number).filter(Number.isInteger);
  } catch { return []; }
}

async function processCommand(pid: number): Promise<string> {
  try {
    return (await runFile('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout.trim();
  } catch { return ''; }
}

const FRIDA_AES_KEY_HOOK = String.raw`const seen = {};
function findExport(name) {
  try { if (typeof Module.findExportByName === 'function') return Module.findExportByName(null, name); } catch (e) {}
  try { if (typeof Module.getGlobalExportByName === 'function') return Module.getGlobalExportByName(name); } catch (e) {}
  return null;
}
function collectImageCodes() {
  const codes = {};
  try {
    const manager = ObjC.classes.NSFileManager.defaultManager();
    const home = manager.homeDirectoryForCurrentUser().path().toString();
    const directories = [
      home + '/Documents/app_data/net/kvcomm',
      home + '/Documents/app_data/ilink/kvcomm',
      home + '/Documents/app_data/roam/ilink/kvcomm',
      home + '/Documents/xwechat/net/kvcomm',
      home + '/Library/Application Support/com.tencent.xinWeChat/xwechat/net/kvcomm',
      home + '/Library/Application Support/com.tencent.xinWeChat/net/kvcomm'
    ];
    for (const directory of directories) {
      let entries = null;
      try { entries = manager.contentsOfDirectoryAtPath_error_(directory, NULL); } catch (e) {}
      if (entries === null) continue;
      for (let index = 0; index < entries.count(); index++) {
        const name = entries.objectAtIndex_(index).toString();
        const match = /^key_(\d+)_/.exec(name);
        if (!match) continue;
        const code = Number(match[1]);
        if (Number.isSafeInteger(code) && code >= 0 && code <= 0xffffffff) codes[String(code)] = 1;
      }
    }
  } catch (e) {}
  return Object.keys(codes).map(Number);
}
['CCCrypt', 'CCCryptorCreate', 'CCCryptorCreateWithMode'].forEach(function (name) {
  const fn = findExport(name);
  if (!fn) return;
  const withMode = name === 'CCCryptorCreateWithMode';
  const keyIdx = withMode ? 5 : 3;
  const lenIdx = withMode ? 6 : 4;
  const algIdx = withMode ? 2 : 1;
  Interceptor.attach(fn, {
    onEnter: function (args) {
      try {
        if (args[algIdx].toInt32() !== 0 || args[lenIdx].toInt32() !== 32) return;
        const bytes = new Uint8Array(args[keyIdx].readByteArray(32));
        let hex = '';
        for (let i = 0; i < 32; i++) hex += bytes[i].toString(16).padStart(2, '0');
        if (!seen[hex]) { seen[hex] = 1; send({ wxkey: hex }); }
      } catch (e) {}
    }
  });
});
send({ imageCodes: collectImageCodes() });
send({ ready: true });`;

const FRIDA_DRIVER = String.raw`import frida
import json
import socket
import sys
import threading

hook_path, pid_text, port_text, token = sys.argv[1:5]
keys = set()
image_codes = set()
session = None
connection = socket.create_connection(('127.0.0.1', int(port_text)), timeout=30)
connection.settimeout(0.25)
send_lock = threading.Lock()
round_lock = threading.Lock()
commands = []
command_buffer = [b'']
round_active = [False]
script_ready = threading.Event()

def send(message):
    payload = (json.dumps(message, separators=(',', ':')) + '\n').encode('utf-8')
    with send_lock:
        connection.sendall(payload)

def report(phase, **extra):
    send({'type': 'status', 'phase': phase, 'keyCount': len(keys), **extra})

def on_message(message, data):
    if message.get('type') != 'send':
        return
    payload = message.get('payload') or {}
    if payload.get('ready'):
        script_ready.set()
        return
    codes = payload.get('imageCodes')
    if isinstance(codes, list):
        for code in codes:
            if isinstance(code, int) and 0 <= code <= 0xffffffff:
                image_codes.add(code)
        return
    key = payload.get('wxkey')
    with round_lock:
        if not round_active[0] or not key or key in keys:
            return
        keys.add(key)
        send({'type': 'key', 'value': key, 'keyCount': len(keys)})
        report('key-count')

def next_command():
    while not commands:
        try:
            chunk = connection.recv(4096)
        except socket.timeout:
            return None
        if not chunk:
            raise RuntimeError('控制连接已关闭')
        command_buffer[0] += chunk
        while b'\n' in command_buffer[0]:
            line, command_buffer[0] = command_buffer[0].split(b'\n', 1)
            if line:
                commands.append(json.loads(line.decode('utf-8')))
    return commands.pop(0)

def wait_for_command():
    while True:
        command = next_command()
        if command is not None:
            return command

round_number = 1
cancelled = False
finished = False
try:
    send({'type': 'hello', 'token': token})
    report('attaching')
    session = frida.attach(int(pid_text))
    report('attached')
    script = session.create_script(open(hook_path, encoding='utf-8').read())
    script.on('message', on_message)
    script.load()
    if not script_ready.wait(20):
        raise RuntimeError('Frida hook timeout')
    round_active[0] = True
    report('hook-ready')
    while not finished and not cancelled:
        command = wait_for_command()
        action = command.get('type')
        if action == 'finish':
            with round_lock:
                round_active[0] = False
            send({'type': 'image-codes', 'values': sorted(image_codes)})
            report('round-complete', round=round_number)
            while True:
                command = wait_for_command()
                action = command.get('type')
                if action == 'continue':
                    round_number += 1
                    with round_lock:
                        round_active[0] = True
                    report('round-start', round=round_number)
                    break
                if action == 'complete':
                    finished = True
                    break
                if action == 'cancel':
                    cancelled = True
                    break
        elif action == 'cancel':
            cancelled = True
    if cancelled:
        report('cancelled')
except Exception as error:
    try:
        report('failed', error=type(error).__name__)
    except Exception:
        pass
    raise
finally:
    round_active[0] = False
    if session is not None:
        try: session.detach()
        except Exception: pass
    try:
        report('complete')
    except Exception:
        pass
    try:
        connection.close()
    except Exception:
        pass
`;

export class MacWechatConnector {
  readonly backend = 'managed-clone' as const;
  private readonly active = new Map<string, AbortController>();
  private readonly captureSessions = new Map<string, ActiveWechatCapture>();

  constructor(
    private readonly userDataDirectory: string,
    private readonly prompts: WechatWizardPrompts,
    private readonly homeDirectory: string = homedir(),
    private readonly runtime: WechatConnectorRuntime = {},
    private readonly options: WechatConnectorWizardOptions = {}
  ) {}

  private execute(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return (this.runtime.runFile ?? runFile)(file, args, options);
  }

  private processIds(): Promise<number[]> {
    return (this.runtime.processIds ?? processIds)();
  }

  private processCommand(pid: number): Promise<string> {
    return (this.runtime.processCommand ?? processCommand)(pid);
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return (this.runtime.delay ?? delay)(ms, signal);
  }

  cancel(connectionId: string): void {
    const session = this.captureSessions.get(connectionId);
    if (session?.socket && !session.completed) {
      session.send({ type: 'cancel' });
      session.fail(new Error('微信连接已取消'));
      return;
    }
    this.active.get(connectionId)?.abort();
  }

  requestCaptureStop(connectionId: string): boolean {
    const session = this.captureSessions.get(connectionId);
    if (!session?.socket || session.socket.destroyed || !session.socket.writable) return false;
    if (session.stopRequested) return true;
    if (!session.captureReady) return false;
    const requested = session.send({ type: 'finish' });
    if (requested) {
      session.stopRequested = true;
      session.captureReady = false;
    }
    return requested;
  }

  requestCaptureContinue(connectionId: string): boolean {
    const session = this.captureSessions.get(connectionId);
    if (!session?.continueReady || !session.socket) return false;
    if (!session.send({ type: 'continue' })) return false;
    session.continueReady = false;
    progress(
      session.onProgress,
      'resuming-capture',
      '正在继续本轮密钥捕获；微信副本和管理员授权保持运行。'
    );
    return true;
  }

  async cancelAll(): Promise<void> {
    for (const connectionId of this.active.keys()) this.cancel(connectionId);
    while (this.active.size) await new Promise(resolve => setTimeout(resolve, 25));
  }

  async capture(
    connectionId: string,
    onProgress: (value: WechatWizardProgress) => void
  ): Promise<WechatCapturedAccount> {
    if ((this.runtime.platform ?? process.platform) !== 'darwin') {
      throw new Error('macOS 微信连接器只能在 macOS 上运行。');
    }
    if (this.active.size) throw new Error('已有微信连接向导正在运行，请先完成或取消。');
    const captureSeconds = this.options.captureSeconds ?? WECHAT_CAPTURE_SECONDS;
    if (!Number.isInteger(captureSeconds) || captureSeconds < 10 || captureSeconds > 600) {
      throw new Error('微信密钥捕获时长必须为 10 秒到 10 分钟。');
    }
    const captureTimeoutMs = this.options.manualStopOnly
      ? undefined
      : Math.max(WECHAT_CAPTURE_TIMEOUT_MS, (captureSeconds + 30) * 1_000);
    const reuseManagedClone = this.options.reuseManagedClone === true;
    const controller = new AbortController();
    const { signal } = controller;
    this.active.set(connectionId, controller);
    const sourceApp = findWechatApp(this.homeDirectory);
    let captureRoot: string | null = null;
    let cloneApp: string | null = null;
    let clonePid: number | null = null;
    let originalWasRunning = false;
    let failedStep = '检查微信版本和签名';
    try {
      progress(onProgress, 'checking', '正在检查微信 4.1.x/4.2.x 版本和腾讯官方签名。');
      if (!sourceApp) throw new Error('没有找到已安装的微信 Mac 客户端，请先安装微信 4.1.x 或 4.2.x。');
      const sourceInfo = await this.readAndVerifySource(sourceApp);
      ensureActive(signal);

      const uvPath = findUv(this.homeDirectory);
      if (!uvPath) throw new Error('没有找到 uv；请安装 uv 后重新连接微信。');
      failedStep = '准备密钥捕获组件';
      progress(onProgress, 'checking', '正在准备本机密钥捕获组件；首次使用可能需要下载 Frida，主微信尚未关闭。');
      const runtimeCache = join(this.userDataDirectory, 'managed-wechat-runtime', 'uv-cache');
      mkdirSync(runtimeCache, { recursive: true, mode: 0o700 });
      const runtimeResult = await this.execute(uvPath, [
        'run', '--no-project', '--with', 'frida<17', 'python', '-c',
        'import frida,json,sys; print(json.dumps({"python":sys.executable,"version":frida.__version__}))'
      ], { signal, timeout: RUNTIME_PREPARE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { UV_CACHE_DIR: runtimeCache } });
      const runtimeLine = runtimeResult.stdout.split(/\r?\n/u).reverse().find(line => line.trim().startsWith('{'));
      let runtimeInfo: { python?: unknown; version?: unknown } = {};
      try { runtimeInfo = JSON.parse(runtimeLine ?? '') as typeof runtimeInfo; }
      catch { throw new Error('Frida 捕获组件初始化完成后没有返回可用的 Python 运行环境。'); }
      if (typeof runtimeInfo.python !== 'string' || !isAbsolute(runtimeInfo.python) || !existsSync(runtimeInfo.python)) {
        throw new Error('Frida 捕获组件没有提供可执行的 Python 运行环境。');
      }
      if (typeof runtimeInfo.version !== 'string' || !/^\d+\./u.test(runtimeInfo.version) || Number(runtimeInfo.version.split('.')[0]) >= 17) {
        throw new Error('Frida 捕获组件版本不兼容；需要 Frida 17 以下版本。');
      }
      const capturePython = runtimeInfo.python;
      ensureActive(signal);

      const reusableClonePath = reuseManagedClone
        ? join(this.userDataDirectory, 'managed-wechat', 'WeChat.app')
        : null;
      const runningIds = await this.processIds();
      if (reusableClonePath) {
        const matchingCloneIds: number[] = [];
        const otherWechatIds: number[] = [];
        for (const pid of runningIds) {
          const command = await this.processCommand(pid);
          if (command.includes(reusableClonePath)) matchingCloneIds.push(pid);
          else otherWechatIds.push(pid);
        }
        if (matchingCloneIds.length > 1) throw new Error('受管微信副本运行了多个实例；请关闭重复窗口后重试。');
        if (otherWechatIds.length) {
          throw new Error('检测到主微信或其他微信副本正在运行；请先退出它们，再保留 Rambo 受管副本重试。');
        }
        clonePid = matchingCloneIds[0] ?? null;
      } else {
        originalWasRunning = runningIds.length > 0;
        if (originalWasRunning) {
          progress(onProgress, 'closing', '请保存微信中的未发送内容；接下来会暂时退出主微信。');
          if (!(await this.prompts.confirmCloseWechat())) throw new Error('微信连接已取消');
          failedStep = '退出主微信';
          await this.execute('/usr/bin/osascript', ['-e', 'tell application id "com.tencent.xinWeChat" to quit'], { signal, timeout: 20_000 });
          const deadline = Date.now() + 20_000;
          while ((await this.processIds()).length && Date.now() < deadline) await this.wait(250, signal);
          if ((await this.processIds()).length) throw new Error('主微信没有正常退出，请关闭微信后重试。');
        }
      }

      progress(onProgress, 'selecting-account', '请选择微信账号目录；账号路径只保存在本机，不会显示给 Agent。');
      const dataRoot = join(this.homeDirectory, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files');
      const selectedDirectory = await this.prompts.chooseAccountDirectory(dataRoot);
      if (!selectedDirectory) throw new Error('微信连接已取消');
      const account = validateWechatAccountDirectory(dataRoot, selectedDirectory, 'macOS');
      ensureActive(signal);

      captureRoot = join(this.userDataDirectory, 'managed-wechat-capture', randomUUID());
      mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
      if (reusableClonePath) {
        progress(onProgress, 'verifying', '正在验证已保存的 Rambo 受管微信副本；本轮会复用它，不重新复制或重签。');
        failedStep = '验证受管微信副本';
        cloneApp = await this.verifyManagedClone(reusableClonePath, sourceInfo, signal);
        ensureActive(signal);
      } else {
        cloneApp = join(captureRoot, basename(sourceApp));
        progress(onProgress, 'copying', '正在创建 Rambo 管理的临时微信副本；主微信应用不会被修改。');
        failedStep = '创建临时微信副本';
        await this.execute('/bin/cp', ['-c', '-R', sourceApp, cloneApp], { signal, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
        ensureActive(signal);

        progress(onProgress, 'signing', '正在为临时副本保留原权限并开启调试附加权限。');
        failedStep = '重签临时微信副本';
        await this.resignClone(cloneApp, captureRoot, signal);
        ensureActive(signal);
      }

      progress(onProgress, 'launching', reusableClonePath
        ? '正在复用 Rambo 受管微信副本；如窗口已打开，将直接附加。'
        : '正在启动临时微信副本；如需登录，请在副本中登录同一个微信账号。');
      const executable = join(cloneApp, 'Contents/MacOS', sourceInfo.executable);
      if (!clonePid) {
        failedStep = '启动微信副本';
        const appProcess: ChildProcess = (this.runtime.spawn ?? spawn)(executable, [], {
          cwd: dirname(executable),
          detached: true,
          stdio: 'ignore'
        });
        clonePid = appProcess.pid ?? null;
        appProcess.unref();
        if (!clonePid) throw new Error('无法启动微信副本。');
        await this.wait(3_000, signal);
      }
      const command = await this.processCommand(clonePid);
      const expectedProcessPath = reusableClonePath ?? captureRoot;
      if (!command || !command.includes(expectedProcessPath)) throw new Error('微信副本没有正常启动。');
      if (!clonePid) throw new Error('没有可用的微信进程；请重新打开微信后重试。');

      const hookPath = join(captureRoot, 'capture-hook.js');
      const driverPath = join(captureRoot, 'capture-driver.py');
      writeFileSync(hookPath, FRIDA_AES_KEY_HOOK, { mode: 0o600, flag: 'wx' });
      writeFileSync(driverPath, FRIDA_DRIVER, { mode: 0o600, flag: 'wx' });

      if (this.options.beforeCapture) {
        progress(
          onProgress,
          'capturing',
          reusableClonePath
            ? '已打开受管微信副本；确认界面可用后点击“已登录，开始捕获”。'
            : '临时微信副本已启动；请先完成登录，确认进入微信后再开始密钥捕获。'
        );
        await this.options.beforeCapture(signal);
        ensureActive(signal);
      }

      failedStep = '捕获数据库密钥';
      const captureServer = createServer();
      const session: ActiveWechatCapture = {
        socket: null,
        token: randomUUID(),
        authenticated: false,
        captureReady: false,
        continueReady: false,
        stopRequested: false,
        completed: false,
        failed: false,
        phase: null,
        keyCount: 0,
        roundNumber: 1,
        candidates: new Set<string>(),
        imageCodes: new Set<number>(),
        round: deferred<WechatDatabaseMapping>(),
        resume: null,
        ready: deferred<void>(),
        driverDone: deferred<void>(),
        onProgress,
        send(message) {
          if (!this.socket || this.socket.destroyed || !this.socket.writable || this.completed) return false;
          try {
            this.socket.write(JSON.stringify(message) + '\n');
            return true;
          } catch { return false; }
        },
        fail(error) {
          if (this.failed || this.completed) return;
          this.failed = true;
          this.captureReady = false;
          this.continueReady = false;
          this.ready.reject(error);
          this.round.reject(error);
          this.resume?.reject(error);
          this.driverDone.reject(error);
        }
      };
      this.captureSessions.set(connectionId, session);
      let serverListening = false;
      let socketBuffer = '';
      const acceptedPhases = new Set<WechatCaptureDriverStatus['phase']>([
        'attaching', 'attached', 'hook-ready', 'key-count', 'round-complete',
        'round-start', 'complete', 'failed', 'cancelled'
      ]);
      const handleMessage = (message: Record<string, unknown>) => {
        if (!session.authenticated) {
          if (message.type !== 'hello' || message.token !== session.token) {
            session.fail(new Error('微信密钥捕获进程验证失败。'));
            session.socket?.destroy();
            return;
          }
          session.authenticated = true;
          return;
        }
        if (message.type === 'key') {
          const key = message.value;
          if (typeof key === 'string' &&
              /^[a-f0-9]{64}$/iu.test(key)) {
            session.candidates.add(key.toLowerCase());
            session.keyCount = session.candidates.size;
            progress(
              onProgress,
              'capturing',
              '已捕获 ' + session.keyCount + ' 个候选密钥；内容只在本机内存中处理。',
              session.captureReady && !session.stopRequested
            );
          }
          return;
        }
        if (message.type === 'image-codes') {
          if (Array.isArray(message.values)) {
            for (const value of message.values) {
              if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
                session.imageCodes.add(value);
              }
            }
          }
          return;
        }
        if (message.type !== 'status' || typeof message.phase !== 'string') return;
        const phase = message.phase as WechatCaptureDriverStatus['phase'];
        if (!acceptedPhases.has(phase)) return;
        session.phase = phase;
        session.keyCount = session.candidates.size;
        if (typeof message.round === 'number' && Number.isSafeInteger(message.round)) {
          session.roundNumber = Math.max(1, message.round);
        }
        if (phase === 'failed') {
          session.fail(new Error(
            message.error === 'PermissionDeniedError'
              ? 'macOS 拒绝附加 Rambo 受管微信副本；请检查副本的调试 entitlement。'
              : 'Frida 密钥捕获进程异常退出。'
          ));
          return;
        }
        if (phase === 'cancelled') {
          session.fail(new Error('微信连接已取消'));
          return;
        }
        if (phase === 'complete') {
          session.completed = true;
          session.captureReady = false;
          session.continueReady = false;
          session.driverDone.resolve();
          return;
        }
        if (phase === 'hook-ready' || phase === 'key-count') {
          session.captureReady = true;
          session.stopRequested = false;
          session.ready.resolve();
          progress(
            onProgress,
            'capturing',
            phase === 'hook-ready'
              ? '密钥捕获钩子已就绪。请在微信副本中打开聊天、图片或语音；完成一轮后点下方按钮验证。'
              : '已捕获 ' + session.keyCount + ' 个候选密钥；可继续操作，或先验证本轮结果。',
            true
          );
          return;
        }
        if (phase === 'round-start') {
          session.captureReady = true;
          session.stopRequested = false;
          session.continueReady = false;
          session.resume?.resolve();
          session.resume = null;
          progress(
            onProgress,
            'capturing',
            '第 ' + session.roundNumber + ' 轮捕获已开始。继续在同一个微信副本中打开聊天、图片或语音。',
            true
          );
          return;
        }
        if (phase === 'round-complete') {
          session.captureReady = false;
          session.stopRequested = false;
          progress(
            onProgress,
            'verifying',
            '正在校验第 ' + session.roundNumber + ' 轮捕获的 ' + session.keyCount +
              ' 个候选密钥；微信副本和授权进程保持运行。'
          );
          try {
            const mapping = mapWechatKeysToDatabases(account.dataDirectory, [...session.candidates]);
            const verifiedCount = mapping.databaseCount - mapping.missingRequiredCount;
            const coverage = summarizeWechatDatabaseCoverage(mapping.keys);
            if (mapping.databaseCount > 0 && mapping.missingRequiredCount === 0) {
              progress(
                onProgress,
                'verifying',
                'SQLCipher 校验通过：' + verifiedCount + '/' + mapping.databaseCount +
                  ' 个聊天数据库匹配；' + coverage + '。正在检查聊天读取。'
              );
              session.round.resolve(mapping);
              return;
            }
            const completedRound = session.round;
            session.round = deferred<WechatDatabaseMapping>();
            session.resume = deferred<void>();
            session.continueReady = true;
            progress(
              onProgress,
              'awaiting-recapture',
              '第 ' + session.roundNumber + ' 轮已校验：' + verifiedCount + '/' + mapping.databaseCount +
                ' 个数据库匹配，' + coverage + '；还缺 ' + mapping.missingRequiredCount +
                  ' 个数据库的密钥。先点“继续补抓密钥”，再回到同一微信副本打开未覆盖的聊天或媒体；操作完成后再次点验证。',
              false,
              true
            );
            completedRound.resolve(mapping);
          } catch (error) {
            session.fail(error instanceof Error ? error : new Error('数据库密钥校验失败'));
          }
          return;
        }
        const phaseMessage = phase === 'attaching'
          ? '管理员授权已通过，Frida 正在附加到微信副本。'
          : 'Frida 已附加到微信副本，正在准备密钥捕获。';
        progress(onProgress, 'capturing', phaseMessage);
      };

      let serverPort = 0;
      await new Promise<void>((resolve, reject) => {
        captureServer.once('error', reject);
        captureServer.listen(0, '127.0.0.1', () => {
          const address = captureServer.address();
          if (!address || typeof address === 'string') {
            reject(new Error('无法建立本机密钥捕获控制通道。'));
            return;
          }
          serverPort = address.port;
          serverListening = true;
          resolve();
        });
      });
      captureServer.on('connection', socket => {
        if (session.socket) {
          socket.destroy();
          return;
        }
        session.socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
          socketBuffer += String(chunk);
          if (socketBuffer.length > 64 * 1024) {
            session.fail(new Error('微信捕获状态消息超过安全限制。'));
            socket.destroy();
            return;
          }
          while (socketBuffer.includes('\n')) {
            const separator = socketBuffer.indexOf('\n');
            const line = socketBuffer.slice(0, separator);
            socketBuffer = socketBuffer.slice(separator + 1);
            if (!line) continue;
            try {
              handleMessage(JSON.parse(line) as Record<string, unknown>);
            } catch {
              session.fail(new Error('微信密钥捕获状态消息格式无效。'));
              socket.destroy();
              return;
            }
          }
        });
        socket.on('error', () => {
          if (!session.completed && !session.failed) {
            session.fail(new Error('微信密钥捕获控制通道中断。'));
          }
        });
        socket.on('close', () => {
          if (!session.completed && !session.failed) {
            session.fail(new Error('微信密钥捕获进程已断开。'));
          }
        });
      });

      const captureInstruction = this.options.manualStopOnly
        ? '捕获会一直运行，直到你结束本轮；如果数据库密钥不全，可继续补抓，不用重启或重新登录。'
        : '采集最长 ' + captureSeconds + ' 秒，可提前结束本轮。';
      progress(
        onProgress,
        'capturing',
        '正在请求一次 macOS 管理员授权。授权后会保持同一个微信副本和捕获进程；请在副本中打开聊天、图片或语音。' +
          captureInstruction
      );
      const script = 'do shell script ' + appleScriptString([
        'PYTHONDONTWRITEBYTECODE=1',
        shellQuote(capturePython),
        '-B',
        shellQuote(driverPath),
        shellQuote(hookPath),
        String(clonePid),
        String(serverPort),
        shellQuote(session.token)
      ].join(' ')) +
        ' with administrator privileges with prompt ' +
        appleScriptString('Rambo 需要管理员权限，在临时微信副本运行期间捕获数据库解密密钥。密钥只在本机内存中处理。');
      const captureStartedAt = Date.now();
      let lastHeartbeatBucket = 0;
      const heartbeat = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - captureStartedAt) / 1_000);
        const bucket = Math.floor(elapsedSeconds / 10) * 10;
        if (bucket <= lastHeartbeatBucket || bucket === 0 || session.continueReady) return;
        lastHeartbeatBucket = bucket;
        const elapsed = bucket + ' 秒';
        const message = session.phase === null
          ? '仍在等待 macOS 管理员授权或捕获进程启动（已等待 ' + elapsed + '）。'
          : session.phase === 'attaching'
            ? 'Frida 正在附加微信副本（已等待 ' + elapsed + '）。'
            : 'Frida 正在等待微信读取数据库（已等待 ' + elapsed + '，已捕获 ' + session.keyCount + ' 个候选密钥）。';
        progress(
          onProgress,
          'capturing',
          message,
          session.captureReady && !session.stopRequested
        );
      }, 1_000);
      heartbeat.unref?.();

      let captureCommand: Promise<ExecResult> | null = null;
      try {
        ensureActive(signal);
        const execution = this.execute('/usr/bin/osascript', ['-e', script], {
          signal,
          timeout: captureTimeoutMs,
          maxBuffer: 8 * 1024 * 1024
        });
        captureCommand = execution.then(result => {
          if (!session.completed && !session.failed) {
            session.fail(new Error('密钥捕获进程意外结束。'));
          }
          return result;
        }, error => {
          session.fail(error instanceof Error ? error : new Error('密钥捕获进程启动失败。'));
          throw error;
        });
        void captureCommand.catch(() => {});
        await session.ready.promise;
        let mapping = await session.round.promise;
        while (mapping.databaseCount === 0 || mapping.missingRequiredCount > 0) {
          const resume = session.resume;
          if (!resume) throw new Error('数据库密钥未覆盖完整，无法继续补抓。');
          await resume.promise;
          mapping = await session.round.promise;
        }
        ensureActive(signal);
        const imageKey = findVerifiedWechatImageKey(
          account.dataDirectory,
          account.accountId,
          session.imageCodes
        );
        progress(
          onProgress,
          'verifying',
          imageKey
            ? '图片媒体密钥已在本机 V2 缓存上验证通过；正在结束捕获。'
            : '未找到可验证的本机 V2 图片缓存；图片媒体将保持不可用，其他只读能力继续。'
        );
        if (!session.send({ type: 'complete' })) throw new Error('无法结束微信密钥捕获进程。');
        await session.driverDone.promise;
        await captureCommand;
        const coverage = summarizeWechatDatabaseCoverage(mapping.keys);
        progress(
          onProgress,
          'verifying',
          reusableClonePath
            ? '密钥校验通过，正在清理本轮捕获文件；受管微信副本保持运行。' + coverage
            : '密钥校验通过，正在清理临时副本并恢复微信。' + coverage
        );
        return {
          accountId: account.accountId,
          dataDirectory: account.dataDirectory,
          wechatVersion: sourceInfo.version,
          wechatBuild: sourceInfo.build,
          keys: mapping.keys,
          ...(imageKey ? { imageKey } : {})
        };
      } finally {
        clearInterval(heartbeat);
        if (!session.completed) session.send({ type: 'cancel' });
        try { await captureCommand; } catch { /* preserve the original failure */ }
        session.socket?.destroy();
        this.captureSessions.delete(connectionId);
        if (serverListening) {
          await new Promise<void>(resolve => captureServer.close(() => resolve()));
        }
      }
    } catch (error) {
      if (signal.aborted) throw new Error('微信连接已取消');
      if (error instanceof Error && !('stdout' in error) && !('stderr' in error)) throw error;
      const details = error && typeof error === 'object' ? error as { code?: unknown; signal?: unknown; stderr?: unknown } : {};
      const code = typeof details.code === 'string' || typeof details.code === 'number' ? `（系统错误 ${details.code}）` : '';
      const signalDetail = typeof details.signal === 'string' ? `，信号 ${details.signal}` : '';
      const stderr = typeof details.stderr === 'string'
        ? redactWechatDiagnostics(details.stderr.trim(), captureRoot)
        : '';
      const reason = stderr ? `：${stderr}` : '';
      throw new Error(`微信连接在“${failedStep}”阶段失败${code}${signalDetail}${reason}`);
    } finally {
      if (clonePid && captureRoot && !reuseManagedClone) {
        await (this.runtime.stopClone ?? stopClone)(clonePid, captureRoot);
      }
      if (captureRoot) {
        try { rmSync(captureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
        catch { /* cleanup is restricted to this generated, Rambo-owned directory */ }
      }
      if (originalWasRunning && sourceApp) {
        try {
          const running = (await this.processIds()).length > 0;
          if (!running) {
            const reopened = (this.runtime.spawn ?? spawn)('/usr/bin/open', ['-a', sourceApp], { detached: true, stdio: 'ignore' });
            reopened.unref();
          }
        } catch { /* never mask the connection result with restore errors */ }
      }
      this.active.delete(connectionId);
      this.captureSessions.delete(connectionId);
    }
  }

  private async readAndVerifySource(sourceApp: string): Promise<{
    version: string; build: string; executable: string;
  }> {
    const infoPath = join(sourceApp, 'Contents/Info.plist');
    const { stdout: plist } = await this.execute('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', infoPath]);
    const bundleId = parsePlistString(plist, 'CFBundleIdentifier');
    const version = parsePlistString(plist, 'CFBundleShortVersionString');
    const build = parsePlistString(plist, 'CFBundleVersion');
    const executable = parsePlistString(plist, 'CFBundleExecutable');
    if (bundleId !== WECHAT_BUNDLE_ID) throw new Error('所选应用不是微信官方客户端。');
    if (!/^4\.[12]\.\d+(?:\.\d+)?$/u.test(version)) throw new Error('仅支持微信 4.1.x 或 4.2.x。');
    const signature = await this.execute('/usr/bin/codesign', ['-d', '--verbose=4', sourceApp]);
    const details = `${signature.stdout}\n${signature.stderr}`;
    if (!/Authority=Developer ID Application: Tencent\b/u.test(details) ||
        !/TeamIdentifier=[A-Z0-9]+/u.test(details)) {
      throw new Error('微信应用签名不是可验证的腾讯官方签名。');
    }
    await this.execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', sourceApp]);
    return { version, build, executable };
  }

  private async verifyManagedClone(
    managedClonePath: string,
    sourceInfo: { version: string; build: string; executable: string },
    signal: AbortSignal
  ): Promise<string> {
    const managedDirectory = dirname(managedClonePath);
    let directoryInfo;
    let cloneInfo;
    try {
      directoryInfo = lstatSync(managedDirectory);
      cloneInfo = lstatSync(managedClonePath);
    } catch {
      throw new Error('没有找到已保存的 Rambo 受管微信副本；请先创建该副本。');
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
        !cloneInfo.isDirectory() || cloneInfo.isSymbolicLink()) {
      throw new Error('Rambo 受管微信副本路径不安全；请重新创建副本。');
    }

    let canonicalPath: string;
    try {
      const canonicalDirectory = realpathSync(managedDirectory);
      canonicalPath = realpathSync(managedClonePath);
      if (canonicalPath !== join(canonicalDirectory, 'WeChat.app')) {
        throw new Error('Rambo 受管微信副本路径不匹配；请重新创建副本。');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('路径不匹配')) throw error;
      throw new Error('无法读取 Rambo 受管微信副本；请重新创建副本。');
    }

    const infoPath = join(canonicalPath, 'Contents/Info.plist');
    if (!existsSync(join(canonicalPath, 'Contents/MacOS', sourceInfo.executable))) {
      throw new Error('Rambo 受管微信副本缺少主程序；请重新创建副本。');
    }
    const { stdout: plist } = await this.execute('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', infoPath], { signal });
    const bundleId = parsePlistString(plist, 'CFBundleIdentifier');
    const version = parsePlistString(plist, 'CFBundleShortVersionString');
    const build = parsePlistString(plist, 'CFBundleVersion');
    const executable = parsePlistString(plist, 'CFBundleExecutable');
    if (bundleId !== WECHAT_BUNDLE_ID || version !== sourceInfo.version || build !== sourceInfo.build ||
        executable !== sourceInfo.executable) {
      throw new Error('Rambo 受管微信副本与已安装微信版本不一致；请重新创建副本。');
    }
    await this.execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', canonicalPath], { signal });
    const signature = await this.execute('/usr/bin/codesign', [
      '-d', '--entitlements', '-', '--xml', canonicalPath
    ], { signal });
    if (!hasGetTaskAllow(`${signature.stdout}\n${signature.stderr}`)) {
      throw new Error('Rambo 受管微信副本缺少调试附加权限；请重新创建副本。');
    }
    return canonicalPath;
  }

  private async resignClone(cloneApp: string, captureRoot: string, signal: AbortSignal): Promise<void> {
    const { stdout: entitlements } = await this.execute('/usr/bin/codesign', [
      '-d', '--entitlements', '-', '--xml', cloneApp
    ], { signal });
    const entitlementPath = join(captureRoot, 'capture-entitlements.plist');
    writeFileSync(entitlementPath, withGetTaskAllow(entitlements), { mode: 0o600, flag: 'wx' });
    await this.execute('/usr/bin/codesign', [
      '--force', '--deep', '--sign', '-', '--entitlements', entitlementPath, '--timestamp=none', cloneApp
    ], { signal, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    await this.execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', cloneApp], { signal });
    const result = await this.execute('/usr/bin/codesign', [
      '-d', '--entitlements', '-', '--xml', cloneApp
    ], { signal });
    if (!hasGetTaskAllow(result.stdout)) throw new Error('临时微信副本签名验证失败。');
  }
}

function findUv(homeDirectory: string): string | null {
  const candidates = [
    join(homeDirectory, '.local/bin/uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv'
  ];
  return candidates.find(path => existsSync(path)) ?? null;
}

async function stopClone(pid: number, captureRoot: string): Promise<void> {
  const command = await processCommand(pid);
  if (!command || !command.includes(captureRoot)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const current = await processCommand(pid);
    if (!current || !current.includes(captureRoot)) return;
  }
  const current = await processCommand(pid);
  if (current && current.includes(captureRoot)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ }
  }
}
