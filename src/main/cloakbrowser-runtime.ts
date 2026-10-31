import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  commandEnvironment,
  findNode,
  findNpx,
  npxInvocation,
  terminateProcessTreeAsync
} from './platform/process';
import { ensurePrivateDirectorySync } from './platform/fs';

export const CLOAKBROWSER_MCP_VERSION = '1.15.1';
const CLOAKBROWSER_MCP_PACKAGE = `cloakbrowser-mcp@${CLOAKBROWSER_MCP_VERSION}`;
const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024;
const INITIALIZE_TIMEOUT_MS = 30 * 60_000;
const NODE_VERSION_PROBE_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_MS = 5 * 60_000;
const PASS_THROUGH_ENVIRONMENT = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'PLAYWRIGHT_DOWNLOAD_HOST',
  'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST'
] as const;

export type CloakBrowserProgressPhase =
  | 'checking-prerequisites'
  | 'installing'
  | 'downloading'
  | 'verifying-download'
  | 'starting'
  | 'verifying'
  | 'ready';

export interface CloakBrowserProgress {
  phase: CloakBrowserProgressPhase;
  message: string;
}

export interface CloakBrowserRuntimeInfo {
  mcpVersion: string;
  browserVersion: string | null;
  executablePath: string | null;
  cacheDirectory: string | null;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface CloakBrowserRuntimeDeps {
  spawnProcess?: typeof spawn;
  resolveNpx?: () => string | null;
  resolveNode?: () => string | null;
  probeNodeVersion?: (
    nodePath: string,
    environment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform
  ) => Promise<string>;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  initializeTimeoutMs?: number;
  toolTimeoutMs?: number;
}

function parseNodeVersion(version: string): { major: number; minor: number } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function isSupportedCloakBrowserNodeVersion(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  return parsed.major >= 24 || (parsed.major === 22 && parsed.minor >= 13);
}

function probeNodeVersion(
  nodePath: string,
  environment: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      nodePath,
      ['--version'],
      {
        env: environment,
        timeout: NODE_VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`无法读取 Node.js 版本：${detail.slice(0, 300)}`));
          return;
        }
        const version = stdout.trim();
        if (!version) {
          reject(new Error('Node.js 版本检查没有返回结果。'));
          return;
        }
        resolve(version);
      }
    );
  });
}

function protocolError(error: unknown): string {
  if (!error || typeof error !== 'object') return '未知错误';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.trim()
    ? message.trim().slice(0, 500)
    : '未知错误';
}

class CloakBrowserStdioClient {
  private nextId = 0;
  private buffered = '';
  private closed = false;
  private closing = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    onStderr: (line: string) => void,
    private readonly platform: NodeJS.Platform,
    private readonly onFatal: (error: Error) => void
  ) {
    child.stdout.on('data', chunk => this.read(chunk.toString('utf8')));
    child.stderr.on('data', chunk => {
      for (const line of chunk.toString('utf8').split(/\r?\n/u)) {
        if (line.trim()) onStderr(line.trim().slice(0, 2_000));
      }
    });
    child.once('error', () => this.fail(new Error('CloakBrowser MCP 进程启动失败。')));
    child.once('close', () => this.failAll(new Error('CloakBrowser MCP 进程已退出。')));
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new Error('CloakBrowser MCP 未运行。'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CloakBrowser MCP 请求超时。'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('无法向 CloakBrowser MCP 发送请求。'));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed) throw new Error('CloakBrowser MCP 未运行。');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.closed = true;
    this.failAll(new Error('CloakBrowser MCP 已关闭。'));
    await terminateProcessTreeAsync(this.child, {
      platform: this.platform,
      processGroup: this.platform !== 'win32',
      graceMs: 1_000
    });
  }

  private read(chunk: string): void {
    if (this.closed) return;
    this.buffered += chunk;
    if (this.buffered.length > MAX_PROTOCOL_LINE_BYTES && !this.buffered.includes('\n')) {
      this.fail(new Error('CloakBrowser MCP 响应超出允许大小。'));
      return;
    }
    let newline = this.buffered.indexOf('\n');
    while (newline >= 0) {
      const rawLine = this.buffered.slice(0, newline);
      if (rawLine.length > MAX_PROTOCOL_LINE_BYTES) {
        this.fail(new Error('CloakBrowser MCP 响应超出允许大小。'));
        return;
      }
      this.buffered = this.buffered.slice(newline + 1);
      if (rawLine.trim()) this.accept(rawLine);
      if (this.closed) return;
      newline = this.buffered.indexOf('\n');
    }
    if (this.buffered.length > MAX_PROTOCOL_LINE_BYTES) {
      this.fail(new Error('CloakBrowser MCP 响应超出允许大小。'));
    }
  }

  private accept(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error('CloakBrowser MCP 返回了无效协议数据。'));
      return;
    }
    if (!Number.isSafeInteger(message?.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`CloakBrowser MCP 请求失败：${protocolError(message.error)}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.closed = true;
  }

  private fail(error: Error): void {
    this.failAll(error);
    this.onFatal(error);
  }
}

function textContent(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type: 'text'; text: string } =>
      Boolean(item) && typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string'
    )
    .map(item => item.text)
    .join('\n');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function binaryInfoFromTool(result: unknown): {
  browserVersion: string | null;
  executablePath: string | null;
  cacheDirectory: string | null;
} {
  const structured = record((result as { structuredContent?: unknown })?.structuredContent);
  const binary = record(structured.binary);
  const parsedText = (() => {
    const text = textContent(result);
    if (!text) return {};
    try { return record(JSON.parse(text)); }
    catch { return {}; }
  })();
  const parsedBinary = record(parsedText.binary);
  return {
    browserVersion: optionalString(binary.version) ?? optionalString(parsedBinary.version),
    executablePath: optionalString(structured.executablePath) ??
      optionalString(binary.binaryPath) ??
      optionalString(parsedText.executablePath) ??
      optionalString(parsedBinary.binaryPath),
    cacheDirectory: optionalString(binary.cacheDir) ?? optionalString(parsedBinary.cacheDir)
  };
}

function bridgeEngine(result: unknown): string | null {
  const structured = record((result as { structuredContent?: unknown })?.structuredContent);
  if (optionalString(structured.browserEngine)) return optionalString(structured.browserEngine);
  const text = textContent(result);
  if (!text) return null;
  try {
    return optionalString(record(JSON.parse(text)).browserEngine);
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /取消|关闭|已退出|未运行/u.test(error.message);
}

export class CloakBrowserRuntime {
  private readonly userDataDirectory: string;
  private readonly deps: CloakBrowserRuntimeDeps;
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: CloakBrowserStdioClient | null = null;
  private info: CloakBrowserRuntimeInfo | null = null;
  private tools: Array<Record<string, unknown>> = [];
  private startPromise: Promise<CloakBrowserRuntimeInfo> | null = null;
  private queueTail: Promise<void> = Promise.resolve();
  private readonly botTokens = new Map<string, string>();

  readonly profileDirectory: string;
  readonly cacheDirectory: string;
  readonly outputDirectory: string;

  constructor(userDataDirectory: string, deps: CloakBrowserRuntimeDeps = {}) {
    this.userDataDirectory = userDataDirectory;
    this.deps = deps;
    this.profileDirectory = join(userDataDirectory, 'browser-profiles', 'cloakbrowser', 'shared');
    this.cacheDirectory = join(userDataDirectory, 'browser-cache', 'cloakbrowser');
    this.outputDirectory = join(userDataDirectory, 'browser-artifacts');
  }

  get running(): boolean {
    return this.info !== null && this.client !== null;
  }

  async ensureStarted(
    onProgress: (progress: CloakBrowserProgress) => void = () => {},
    signal?: AbortSignal
  ): Promise<CloakBrowserRuntimeInfo> {
    if (this.info) return this.info;
    if (this.startPromise) return this.startPromise;
    const pending = this.startInternal(onProgress, signal);
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  listTools(): Array<Record<string, unknown>> {
    return this.tools.map(tool => ({ ...tool }));
  }

  issueToken(botId: string): string {
    const existing = this.botTokens.get(botId);
    if (existing) return existing;
    const token = randomBytes(32).toString('hex');
    this.botTokens.set(botId, token);
    return token;
  }

  botForToken(token: string): string | null {
    if (!/^[a-f0-9]{64}$/u.test(token)) return null;
    const provided = Buffer.from(token, 'hex');
    for (const [botId, candidate] of this.botTokens) {
      const expected = Buffer.from(candidate, 'hex');
      if (expected.length === provided.length && timingSafeEqual(expected, provided)) return botId;
    }
    return null;
  }

  revokeBot(botId: string): void {
    this.botTokens.delete(botId);
  }

  clearTokens(): void {
    this.botTokens.clear();
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    authorize: () => boolean = () => true
  ): Promise<any> {
    const client = this.client;
    if (!client || !this.info) return Promise.reject(new Error('CloakBrowser 尚未启动。'));
    const operation = this.queueTail.then(() => {
      if (this.client !== client || !this.info) throw new Error('CloakBrowser 已停止。');
      if (!authorize()) throw new Error('CloakBrowser 访问已撤销或无效。');
      return client.request('tools/call', {
        name,
        arguments: args
      }, this.deps.toolTimeoutMs ?? TOOL_TIMEOUT_MS);
    });
    this.queueTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.child = null;
    this.info = null;
    this.tools = [];
    this.botTokens.clear();
    await client?.close();
  }

  private async startInternal(
    onProgress: (progress: CloakBrowserProgress) => void,
    signal?: AbortSignal
  ): Promise<CloakBrowserRuntimeInfo> {
    if (signal?.aborted) throw new Error('CloakBrowser 安装已取消。');
    onProgress({
      phase: 'checking-prerequisites',
      message: '正在检查 Node.js、npm 缓存和浏览器安装目录。'
    });
    const npx = (this.deps.resolveNpx ?? findNpx)();
    if (!npx) {
      throw new Error('没有找到 Node.js 的 npx。请安装 Node.js 22.13+ 或 24+ 后重试。');
    }
    const platform = this.deps.platform ?? process.platform;
    const node = (this.deps.resolveNode ?? findNode)();
    if (!node) {
      throw new Error('找到了 npx，但没有找到对应的 Node.js。请重新安装 Node.js 22.13+ 或 24+ 后重试。');
    }
    const nodeEnvironment = commandEnvironment({}, {
      platform,
      environment: this.deps.environment ?? process.env
    });
    const nodeVersion = await (
      this.deps.probeNodeVersion ??
      ((nodePath, environment) => probeNodeVersion(nodePath, environment))
    )(node, nodeEnvironment, platform);
    if (!isSupportedCloakBrowserNodeVersion(nodeVersion)) {
      throw new Error(
        `CloakBrowser MCP 要求 Node.js 22.13+（22.x）或 24+；当前为 ${nodeVersion}。请切换 Node.js 版本后重试。`
      );
    }
    ensurePrivateDirectorySync(this.profileDirectory, platform);
    ensurePrivateDirectorySync(this.cacheDirectory, platform);
    ensurePrivateDirectorySync(this.outputDirectory, platform);

    const npmCache = join(this.userDataDirectory, 'browser-cache', 'npm');
    ensurePrivateDirectorySync(npmCache, platform);
    const environment = this.deps.environment ?? process.env;
    const selectedEnvironment = Object.fromEntries(
      PASS_THROUGH_ENVIRONMENT
        .filter(name => typeof environment[name] === 'string')
        .map(name => [name, environment[name]!])
    );
    const hasProxy = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy'
    ].some(name => Boolean(selectedEnvironment[name]));
    const noProxy = [
      selectedEnvironment.NO_PROXY,
      selectedEnvironment.no_proxy,
      '127.0.0.1',
      'localhost',
      '::1'
    ].filter((value): value is string => Boolean(value)).join(',');
    const nodeMajor = parseNodeVersion(nodeVersion)?.major ?? 0;
    const childEnvironment = commandEnvironment({
      ...selectedEnvironment,
      PATH: [
        dirname(npx),
        environment.PATH ?? environment.Path ?? ''
      ].filter(Boolean).join(platform === 'win32' ? ';' : ':'),
      npm_config_cache: npmCache,
      NPM_CONFIG_CACHE: npmCache,
      npm_config_update_notifier: 'false',
      npm_config_progress: 'false',
      npm_config_loglevel: 'error',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      PLAYWRIGHT_MCP_BROWSER_ENGINE: 'cloak',
      PLAYWRIGHT_MCP_HEADLESS: 'false',
      PLAYWRIGHT_MCP_USER_DATA_DIR: this.profileDirectory,
      PLAYWRIGHT_MCP_OUTPUT_DIR: this.outputDirectory,
      CLOAKBROWSER_CACHE_DIR: this.cacheDirectory,
      CLOAKBROWSER_AUTO_UPDATE: 'false',
      CLOAK_PLAYWRIGHT_MCP_NO_SANDBOX: 'false',
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      ...(nodeMajor >= 24 && hasProxy ? { NODE_OPTIONS: '--use-env-proxy' } : {})
    }, { platform, environment });
    const invocation = npxInvocation(
      npx,
      ['--yes', CLOAKBROWSER_MCP_PACKAGE],
      {
        platform,
        environment: childEnvironment
      }
    );
    onProgress({
      phase: 'installing',
      message: `正在安装 CloakBrowser MCP ${CLOAKBROWSER_MCP_VERSION}，并准备共享浏览器内核；首次运行可能需要下载约 200 MB。`
    });
    const child = (this.deps.spawnProcess ?? spawn)(invocation.command, invocation.args, {
      stdio: 'pipe',
      env: childEnvironment,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: platform !== 'win32'
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.once('close', () => {
      if (this.child !== child) return;
      this.child = null;
      this.client = null;
      this.info = null;
      this.tools = [];
      this.botTokens.clear();
    });
    let downloadReported = false;
    let verifyReported = false;
    const client = new CloakBrowserStdioClient(
      child,
      line => {
        if (/download/i.test(line) && !downloadReported) {
          downloadReported = true;
          onProgress({
            phase: 'downloading',
            message: '正在下载 CloakBrowser Chromium；当前只显示真实阶段和等待时长，不伪造百分比。'
          });
        } else if (/checksum|verify|signature/i.test(line) && !verifyReported) {
          verifyReported = true;
          onProgress({
            phase: 'verifying-download',
            message: 'Chromium 下载完成，正在校验签名与文件完整性。'
          });
        }
      },
      platform,
      () => {
        if (this.client !== client) return;
        this.client = null;
        this.child = null;
        this.info = null;
        this.tools = [];
        this.botTokens.clear();
        void client.close();
      }
    );
    this.client = client;
    const abort = () => { void client.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'rambo-cloakbrowser', version: '0.1.0' }
      }, this.deps.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
      if (signal?.aborted) throw new Error('CloakBrowser 安装已取消。');
      client.notify('notifications/initialized', {});
      onProgress({
        phase: 'starting',
        message: 'CloakBrowser 套件已就绪，正在启动唯一共享浏览器服务。'
      });
      const listed = await client.request('tools/list', {}, 60_000);
      const tools = Array.isArray(listed?.tools)
        ? listed.tools.filter((tool: unknown): tool is Record<string, unknown> =>
            Boolean(tool) && typeof tool === 'object' && !Array.isArray(tool)
          )
        : [];
      const names = new Set(tools
        .map((tool: Record<string, unknown>) => optionalString(tool.name))
        .filter((name: string | null): name is string => Boolean(name)));
      for (const required of [
        'browser_navigate',
        'browser_snapshot',
        'cloakbrowser_binary_info',
        'cloakbrowser_bridge_info'
      ]) {
        if (!names.has(required)) {
          throw new Error(`CloakBrowser MCP 缺少必要工具：${required}`);
        }
      }
      onProgress({
        phase: 'verifying',
        message: '正在核对 CloakBrowser 二进制、浏览器引擎与 MCP 桥接信息。'
      });
      const binaryResult = await client.request('tools/call', {
        name: 'cloakbrowser_binary_info',
        arguments: {}
      }, 60_000);
      const binary = binaryInfoFromTool(binaryResult);
      const bridgeResult = await client.request('tools/call', {
        name: 'cloakbrowser_bridge_info',
        arguments: {}
      }, 60_000);
      if (bridgeEngine(bridgeResult) !== 'cloak') {
        throw new Error('CloakBrowser MCP 未运行在 cloak 浏览器引擎。');
      }
      const info: CloakBrowserRuntimeInfo = {
        mcpVersion: CLOAKBROWSER_MCP_VERSION,
        browserVersion: binary.browserVersion,
        executablePath: binary.executablePath,
        cacheDirectory: binary.cacheDirectory ?? this.cacheDirectory
      };
      this.info = info;
      this.tools = tools;
      onProgress({
        phase: 'ready',
        message: info.browserVersion
          ? `CloakBrowser ${info.browserVersion} 已安装，共享 profile 服务已启动。`
          : 'CloakBrowser 已安装，共享 profile 服务已启动。'
      });
      return info;
    } catch (error) {
      await client.close();
      if (this.client === client) this.client = null;
      if (this.child === child) this.child = null;
      this.info = null;
      this.tools = [];
      if (signal?.aborted || isAbortError(error)) throw new Error('CloakBrowser 安装已取消。');
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}
