import { EventEmitter } from 'node:events';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { prepareRuntimeHome } from './runtime-home';
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

export type RuntimeLayout = {
  binary: string;
  pathDirectory: string;
  version: string;
  source: 'native' | 'cache';
};

export type RuntimeResolverDeps = {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
  isExecutable?: (path: string) => Promise<boolean>;
  download?: (version: string, destination: string) => Promise<string>;
  now?: () => number;
  nativeCodexHome?: string;
  ownedThreadIds?: () => readonly string[];
  /** Manual proxy supplied by the app; applied only to the Codex child process. */
  proxyUrl?: string | null;
  /** Extra -c overrides for the application-level model source. */
  configOverrides?: () => readonly string[];
  /** Environment entries for the application-level model source. */
  environment?: () => Readonly<Record<string, string>>;
};

const DEFAULT_RUNTIME_VERSION = '0.164.0';
const RUNTIME_ARCHIVE_SHA256 = '7fcd5f0346c9338dd45f1af7c53115a29f651ac61a4264e2dbca49b7aa064ac0';

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => (value.match(/^\d+\.\d+\.\d+/) ?? [value])[0]
    .split('.').map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readManagedRuntime(
  candidate: string,
  deps: RuntimeResolverDeps,
  source: RuntimeLayout['source']
): RuntimeLayout | null {
  const manifestPath = join(candidate, 'codex-package.json');
  if (!(deps.exists ?? existsSync)(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = String(manifest.version ?? '');
    const binaryName = basename(String(manifest.entrypoint ?? 'bin/codex'));
    const binary = join(candidate, String(manifest.entrypoint ?? 'bin/codex'));
    const pathDirectory = join(candidate, String(manifest.pathDir ?? 'codex-path'));
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
    if (binaryName !== 'codex-app-server' && !(source === 'native' && binaryName === 'codex')) return null;
    return { binary, pathDirectory, version, source };
  } catch {
    return null;
  }
}

export async function resolveRuntimeLayout(
  resourceRoot: string,
  storeDirectory: string,
  deps: RuntimeResolverDeps = {}
): Promise<RuntimeLayout> {
  const home = deps.homeDirectory ?? homedir();
  const managedRoot = join(deps.nativeCodexHome ?? (deps.homeDirectory ? join(home, '.codex') : process.env.CODEX_HOME || join(home, '.codex')), 'packages/app-server-daemon/releases');
  const cacheRoot = join(storeDirectory, 'runtime/codex');
  const candidates: Array<{ root: string; source: 'native' | 'cache' }> = [];
  if (deps.exists ? deps.exists(managedRoot) : existsSync(managedRoot)) {
    const entries = await readDirectory(managedRoot);
    for (const entry of entries.sort((a, b) => compareVersions(b, a))) {
      candidates.push({ root: join(managedRoot, entry), source: 'native' });
    }
  }
  if (deps.exists ? deps.exists(cacheRoot) : existsSync(cacheRoot)) {
    const entries = await readDirectory(cacheRoot);
    for (const entry of entries.sort((a, b) => compareVersions(b, a))) {
      candidates.push({ root: join(cacheRoot, entry), source: 'cache' });
    }
  }
  const packaged = join(resourceRoot, 'runtime/codex');
  if (deps.exists ? deps.exists(packaged) : existsSync(packaged)) {
    const entries = await readDirectory(packaged);
    for (const entry of entries.sort((a, b) => compareVersions(b, a))) {
      candidates.push({ root: join(packaged, entry), source: 'cache' });
    }
  }
  for (const candidate of candidates) {
    const layout = readManagedRuntime(candidate.root, deps, candidate.source);
    if (!layout) continue;
    const executable = deps.isExecutable ?? isExecutable;
    if (!(await executable(layout.binary))) continue;
    return layout;
  }
  const version = DEFAULT_RUNTIME_VERSION;
  const destination = join(cacheRoot, version);
  const download = deps.download ?? downloadRuntime;
  await download(version, destination);
  const layout = readManagedRuntime(destination, deps, 'cache');
  if (!layout) throw new Error(`下载的 Codex 运行时布局无效：${destination}`);
  return layout;
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function downloadRuntime(version: string, destination: string): Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`当前没有适用于 ${process.platform}-${process.arch} 的已校验 Codex 运行时`);
  }
  const expectedSha = version === DEFAULT_RUNTIME_VERSION ? RUNTIME_ARCHIVE_SHA256 : null;
  if (!expectedSha) throw new Error(`没有可校验的 Codex 运行时版本：${version}`);
  const temporary = await mkdtemp(join(tmpdir(), 'rambo-runtime-'));
  try {
    const archive = join(temporary, 'runtime.tar.gz');
    const url = `https://github.com/openai/codex/releases/download/rust-v${version}/codex-app-server-package-aarch64-apple-darwin.tar.gz`;
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`下载 Codex 运行时失败：${response.status}`);
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(archive));
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(archive)) digest.update(chunk);
    if (digest.digest('hex') !== expectedSha) throw new Error('Codex 运行时 SHA-256 不匹配');
    const extracted = join(temporary, 'extracted');
    await mkdir(extracted);
    execFileSync('tar', ['-xzf', archive, '-C', extracted]);
    if (!existsSync(join(extracted, 'codex-package.json'))) throw new Error('Codex 运行时归档布局无效');
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(extracted, destination);
    await writeFile(join(destination, 'rambo-runtime.json'), JSON.stringify({
      version,
      sha256: expectedSha,
      source: `openai/codex rust-v${version}`,
      sessionSource: 'app-server'
    }, null, 2));
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function requestError(message: string, outcomeUnknown = false): Error {
  const error = new Error(message) as Error & { outcomeUnknown?: boolean };
  error.outcomeUnknown = outcomeUnknown;
  return error;
}

function responseError(error: any): Error {
  return new Error(error?.message ?? 'Codex 请求失败');
}

function runtimeProxyEnv(proxyUrl: string | null | undefined): Record<string, string> {
  if (!proxyUrl) return {};
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost'
  };
}

export class CodexRuntime extends EventEmitter {
  state: RuntimeState = { status: 'stopped', version: '', error: null };
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private lateResponses = new Map<number, (outcome: RequestOutcome<any>) => void>();
  private nextId = 1;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly resourceRoot: string,
    private readonly workingDirectory: string,
    private readonly spawnProcess: RuntimeProcessSpawner = spawn,
    private readonly resolverDeps: RuntimeResolverDeps = {}
  ) { super(); }

  setProxyUrl(proxyUrl: string | null | undefined): void {
    this.resolverDeps.proxyUrl = proxyUrl?.trim() || null;
  }

  setModelSourceConfig(
    overrides: readonly string[],
    environment: Readonly<Record<string, string>>
  ): void {
    this.resolverDeps.configOverrides = () => overrides;
    this.resolverDeps.environment = () => environment;
  }

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
    let layout: RuntimeLayout;
    try {
      layout = await resolveRuntimeLayout(
        this.resourceRoot,
        this.workingDirectory,
        this.resolverDeps
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState('error', message);
      throw error;
    }
    let codexHome: string;
    try {
      const nativeHome = this.resolverDeps.nativeCodexHome ?? (this.resolverDeps.homeDirectory
        ? join(this.resolverDeps.homeDirectory, '.codex')
        : process.env.CODEX_HOME || join(homedir(), '.codex'));
      codexHome = await prepareRuntimeHome(nativeHome, this.workingDirectory, this.resolverDeps.ownedThreadIds?.());
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.state = { ...this.state, version: layout.version };
    const args = basename(layout.binary) === 'codex'
      ? ['app-server', '--listen', 'stdio://']
      : ['--listen', 'stdio://', '--session-source', 'app-server'];
    args.push(
      '-c', 'cli_auth_credentials_store="file"',
      '-c', `sqlite_home=${JSON.stringify(codexHome)}`,
      ...(this.resolverDeps.configOverrides?.() ?? [])
    );
    const child = this.spawnProcess(layout.binary, args, {
      cwd: this.workingDirectory,
      env: {
        ...process.env,
        ...runtimeProxyEnv(this.resolverDeps.proxyUrl),
        ...(this.resolverDeps.environment?.() ?? {}),
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: codexHome,
        PATH: `${layout.pathDirectory}:${process.env.PATH ?? '/usr/bin:/bin'}`
      },
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
          if ((message.method === 'item/tool/call' ||
               message.method === 'mcpServer/elicitation/request') &&
              this.emit('serverRequest', message)) return;
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
        capabilities: {
          experimentalApi: true,
          extensions: { 'openai/form': {} }
        }
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
