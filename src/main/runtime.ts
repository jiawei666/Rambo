import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeState } from '../shared/contracts';

interface RequestOutcome<T> { result?: T; error?: Error }
interface RequestOptions<T> {
  onTimeout?: () => void;
  onLateResponse?: (outcome: RequestOutcome<T>) => void;
}
interface Pending {
  method: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  options?: RequestOptions<any>;
}

export type RuntimeProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

function requestError(message: string, outcomeUnknown = false): Error {
  const error = new Error(message) as Error & { outcomeUnknown?: boolean };
  error.outcomeUnknown = outcomeUnknown;
  return error;
}

function responseError(error: any): Error {
  return new Error(error?.message ?? 'Codex 请求失败');
}

export class CodexRuntime extends EventEmitter {
  state: RuntimeState = { status: 'stopped', version: '0.163.0', error: null };
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private lateResponses = new Map<number, (outcome: RequestOutcome<any>) => void>();
  private nextId = 1;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly resourceRoot: string,
    private readonly workingDirectory: string,
    private readonly spawnProcess: RuntimeProcessSpawner = spawn
  ) { super(); }

  private setState(status: RuntimeState['status'], error: string | null = null): void {
    this.state = { ...this.state, status, error };
    this.emit('state', this.state);
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if ((this.state.status as RuntimeState['status']) === 'ready') return;
    if (this.starting) return this.starting;
    // A failed child can still be shutting down. Reap it before spawning a replacement.
    if (this.process) await this.stop();
    if (this.stopping) await this.stopping;
    if ((this.state.status as RuntimeState['status']) === 'ready') return;
    if (this.starting) return this.starting;
    let resolveStart!: () => void;
    let rejectStart!: (error: unknown) => void;
    const starting = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    this.starting = starting;
    void this.startProcess().then(resolveStart, rejectStart);
    try { await starting; } finally { if (this.starting === starting) this.starting = null; }
  }

  private async startProcess(): Promise<void> {
    const root = join(this.resourceRoot, 'runtime/codex', this.state.version);
    const binary = join(root, 'bin/codex-app-server');
    if (!existsSync(binary)) {
      const error = '缺少随包 Codex 运行时，请先执行 npm run runtime:prepare';
      this.setState('error', error);
      throw new Error(error);
    }
    const child = this.spawnProcess(binary, ['--listen', 'stdio://', '--session-source', 'app-server'], {
      cwd: this.workingDirectory,
      env: { ...process.env, PATH: `${join(root, 'codex-path')}:${process.env.PATH ?? '/usr/bin:/bin'}` },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.process = child;
    // stderr 可能带用户内容或令牌，首批不整包持久化。
    child.stderr.resume();
    child.on('error', error => this.fail(child, error));
    child.on('exit', (code, signal) => {
      this.fail(child, requestError(`Codex 进程已退出（${signal ?? code ?? 'unknown'}）`, true));
      if (this.process === child) this.process = null;
    });
    child.on('close', () => { if (this.process === child) this.process = null; });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && !message.method) {
          const p = this.pending.get(message.id);
          if (p) {
            clearTimeout(p.timeout);
            this.pending.delete(message.id);
            if (message.error) p.reject(responseError(message.error));
            else p.resolve(message.result);
            return;
          }
          const late = this.lateResponses.get(message.id);
          if (late) {
            this.lateResponses.delete(message.id);
            try {
              late(message.error
                ? { error: responseError(message.error) }
                : { result: message.result });
            } catch {
              // A consumer callback must not terminate the JSON-RPC reader.
            }
          }
        } else if (message.method && message.id !== undefined) {
          if (message.method === 'item/tool/call' && this.emit('serverRequest', message)) return;
          // 未接入的宿主工具/审批必须明确返回错误，不能静默卡住或谎称成功。
          this.write({ id: message.id, error: { code: -32601, message: `Rambo 尚未接入此宿主请求：${message.method}` } });
          this.emit('unsupportedRequest', message.method);
        } else if (message.method) this.emit('notification', message.method, message.params ?? {});
      } catch {
        this.fail(child, new Error('Codex 返回了无法解析的协议数据'));
        child.kill('SIGTERM');
      }
    });

    this.setState('starting');
    try {
      await this.request('initialize', {
        clientInfo: { name: 'rambo', title: 'Rambo', version: '0.1.0' },
        capabilities: { experimentalApi: true }
      });
      this.write({ method: 'initialized', params: {} });
      if (this.process !== child) throw new Error('Codex 初始化已中断');
      this.setState('ready');
    } catch (error) {
      this.fail(child, error instanceof Error ? error : new Error(String(error)));
      await this.terminate(child);
      throw error;
    }
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(requestError(error.message, true));
    }
    this.pending.clear();
    this.lateResponses.clear();
    this.setState('error', error.message);
  }

  private write(value: unknown): void {
    if (!this.process || this.process.stdin.destroyed) throw new Error('Codex 尚未连接');
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  respondToServerRequest(id: string | number, result: unknown): void {
    if (typeof id !== 'string' && !Number.isSafeInteger(id)) throw new Error('无效的 Codex 宿主请求标识');
    this.emit('acceptanceResponse', id, result);
    this.write({ id, result });
  }

  request<T = any>(method: string, params: unknown = {}, timeoutMs = 60_000, options?: RequestOptions<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (p.options?.onLateResponse) this.lateResponses.set(id, p.options.onLateResponse);
        try { p.options?.onTimeout?.(); } catch { /* callback errors must not affect request lifecycle */ }
        reject(requestError(`Codex 请求超时：${method}`, true));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout, options });
      try { this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    try { child.stdin.end(); } catch { /* already closed */ }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      let force: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (force) clearTimeout(force);
        child.off('exit', finish);
        child.off('close', finish);
        resolve();
      };
      child.once('exit', finish);
      child.once('close', finish);
      force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        // Keep this promise referenced; stop() must not return before the child exits.
      }, 3_000);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.process;
    this.process = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(requestError('Codex 连接已关闭', true));
    }
    this.pending.clear();
    this.lateResponses.clear();
    this.stopping = Promise.resolve().then(async () => {
      if (child) await this.terminate(child);
      this.setState('stopped');
    });
    try { await this.stopping; } finally { this.stopping = null; }
  }
}
