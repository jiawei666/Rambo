import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { findNpx, npxInvocation, terminateProcessTree } from './platform/process';

const PLAYWRIGHT_PACKAGE = '@playwright/mcp@0.0.83';
const MAX_LINE_CHARS = 5_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export type PlaywrightVerificationPhase = 'starting' | 'waiting-tab' | 'checking-page' | 'verified';
export interface PlaywrightVerificationProgress {
  phase: PlaywrightVerificationPhase;
  message: string;
}
export interface PlaywrightVerificationResult { verifiedAt: string }

export interface PlaywrightExtensionVerifierDeps {
  spawnProcess?: typeof spawn;
  resolveNpx?: () => string | null;
  now?: () => Date;
  timeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class StdioJsonRpcClient {
  private nextId = 0;
  private buffered = '';
  private closed = false;
  private killed = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', chunk => this.read(chunk.toString('utf8')));
    child.stderr.on('data', () => {});
    child.once('error', () => this.failAll(new Error('Playwright MCP 进程启动失败。')));
    child.once('close', () => this.failAll(new Error('Playwright MCP 进程已退出。')));
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (this.closed || this.child.stdin.destroyed) return Promise.reject(new Error('Playwright MCP 未运行。'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Playwright MCP 请求超时。'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('无法向 Playwright MCP 发送请求。'));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed) throw new Error('Playwright MCP 未运行。');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    if (this.killed) return;
    this.killed = true;
    this.closed = true;
    this.failAll(new Error('Playwright MCP 已关闭。'));
    terminateProcessTree(this.child, {
      platform: process.platform,
      processGroup: process.platform !== 'win32',
      graceMs: 1_000
    });
  }

  private read(chunk: string): void {
    if (this.closed) return;
    this.buffered += chunk;
    if (this.buffered.length > MAX_LINE_CHARS && !this.buffered.includes('\n')) {
      this.failAll(new Error('Playwright MCP 响应超出允许大小。'));
      return;
    }
    let newline = this.buffered.indexOf('\n');
    while (newline >= 0) {
      const rawLine = this.buffered.slice(0, newline);
      if (rawLine.length > MAX_LINE_CHARS) {
        this.failAll(new Error('Playwright MCP 响应超出允许大小。'));
        return;
      }
      const line = rawLine.trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (line) this.accept(line);
      if (this.closed) return;
      newline = this.buffered.indexOf('\n');
    }
    if (this.buffered.length > MAX_LINE_CHARS) {
      this.failAll(new Error('Playwright MCP 响应超出允许大小。'));
    }
  }

  private accept(line: string): void {
    let message: any;
    try { message = JSON.parse(line); }
    catch {
      this.failAll(new Error('Playwright MCP 返回了无效协议数据。'));
      return;
    }
    if (!Number.isSafeInteger(message?.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error('Playwright MCP 请求失败。'));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (this.closed) return;
    this.closed = true;
  }
}

function textContent(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) return '';
  return record.content
    .filter((item): item is { type: 'text'; text: string } =>
      !!item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string'
    )
    .map(item => item.text)
    .join('\n');
}

function hasSelectedTab(listing: string): boolean {
  if (/chrome-extension:\/\//iu.test(listing) ||
      /select (?:a |the )?tab|choose (?:a |the )?tab|approve (?:the )?connection/iu.test(listing)) return false;
  return /(?:^|\n)\s*(?:[-*]\s*)?\d+\s*:/u.test(listing);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('验证已取消。'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('验证已取消。'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class PlaywrightExtensionVerifier {
  private active: AbortController | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly deps: PlaywrightExtensionVerifierDeps = {}) {}

  cancel(): void {
    this.active?.abort();
    if (this.child && this.child.exitCode === null) {
      terminateProcessTree(this.child, {
        platform: process.platform,
        processGroup: process.platform !== 'win32',
        graceMs: 1_000
      });
    }
  }

  async verify(onProgress: (progress: PlaywrightVerificationProgress) => void = () => {}): Promise<PlaywrightVerificationResult> {
    if (this.active) throw new Error('Chrome 连接验证已在运行。');
    const controller = new AbortController();
    const { signal } = controller;
    this.active = controller;
    let client: StdioJsonRpcClient | null = null;
    try {
      const npx = (this.deps.resolveNpx ?? findNpx)();
      if (!npx) throw new Error('没有找到 Node.js 的 npx。请安装 Node.js 后重试 Chrome 连接验证。');
      onProgress({ phase: 'starting', message: '正在启动 Playwright MCP 并连接 Chrome 扩展…' });
      const invocation = npxInvocation(npx, ['-y', PLAYWRIGHT_PACKAGE, '--extension'], {
        platform: process.platform,
        environment: process.env
      });
      const child = (this.deps.spawnProcess ?? spawn)(invocation.command, invocation.args, {
        stdio: 'pipe',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        detached: process.platform !== 'win32'
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      client = new StdioJsonRpcClient(child);
      const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'rambo-browser-setup', version: '0.1.0' }
      }, Math.min(timeoutMs, 15_000));
      client.notify('notifications/initialized', {});
      const tools = await client.request('tools/list', {}, Math.min(timeoutMs, 15_000));
      const names = new Set(Array.isArray(tools?.tools)
        ? tools.tools.map((tool: any) => tool?.name).filter((name: unknown): name is string => typeof name === 'string')
        : []);
      if (!names.has('browser_tabs') || !names.has('browser_snapshot')) {
        throw new Error('Playwright MCP 没有提供浏览器标签列表和只读快照工具。');
      }

      onProgress({
        phase: 'waiting-tab',
        message: '请在 Chrome 的 Playwright Extension 连接页选择一个标签页；Rambo 正在等待并检查连接。'
      });
      const deadline = Date.now() + timeoutMs;
      let selected = false;
      while (!signal.aborted && Date.now() < deadline) {
        try {
          const listing = await client.request('tools/call', {
            name: 'browser_tabs', arguments: { action: 'list' }
          }, Math.min(timeoutMs, 12_000));
          if (listing?.isError !== true && hasSelectedTab(textContent(listing))) {
            selected = true;
            break;
          }
        } catch (error) {
          if (signal.aborted) throw error;
        }
        await delay(750, signal);
      }
      if (signal.aborted) throw new Error('Chrome 连接验证已取消。');
      if (!selected) {
        throw new Error('尚未确认 Chrome 标签页。请在 Playwright Extension 连接页选择标签后重试。');
      }

      onProgress({ phase: 'checking-page', message: '标签页已连接，正在执行一次只读快照验证…' });
      const snapshot = await client.request('tools/call', {
        name: 'browser_snapshot', arguments: {}
      }, Math.min(timeoutMs, 15_000));
      if (snapshot?.isError === true || !textContent(snapshot).trim()) {
        throw new Error('Chrome 标签页只读检查失败，请检查扩展连接后重试。');
      }
      const verifiedAt = (this.deps.now ?? (() => new Date()))().toISOString();
      onProgress({ phase: 'verified', message: 'Chrome 标签页连接与只读检查已完成。' });
      return { verifiedAt };
    } catch (error) {
      if (signal.aborted) throw new Error('Chrome 连接验证已取消。');
      if (error instanceof Error && /npx|没有提供浏览器标签列表|尚未确认 Chrome 标签页|只读检查失败|响应超出允许大小|验证已在运行/u.test(error.message)) {
        throw error;
      }
      throw new Error('Chrome 连接验证失败。请确认 Chrome 已开启 Playwright Extension，并在连接页选择一个标签后重试。');
    } finally {
      client?.close();
      this.child = null;
      this.active = null;
    }
  }
}
