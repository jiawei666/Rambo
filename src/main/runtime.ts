import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { RuntimeHomeManager } from './runtime-home';
import { RealtimeAudioBridge } from './realtime-audio-bridge';
import { extractTarGz, listTarGzEntries } from './platform/archive';
import { renameWithRetry } from './platform/fs';
import {
  findNpx,
  pathDelimiter,
  terminateProcessTree,
  terminateProcessTreeAsync
} from './platform/process';
import {
  isSafeArchiveEntry,
  runtimeEntryPath,
  runtimeManifestMatches,
  runtimeTargetFor,
  type RuntimeTarget
} from './platform/runtime-target';
import type {
  CodexHomeSyncMode,
  CodexHomeSyncState,
  RuntimeProgress,
  RuntimeSource,
  RuntimeState,
  RuntimeUpdateResult
} from '../shared/contracts';

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
  source: RuntimeSource;
};

export type RuntimeRelease = {
  version: string;
  archiveUrl: string;
  sha256: string;
  publishedAt: string | null;
};

export type RuntimeResolverDeps = {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
  isExecutable?: (path: string) => Promise<boolean>;
  downloadRuntime?: (
    version: string,
    destination: string,
    onProgress?: (progress: RuntimeProgress) => void
  ) => Promise<string>;
  latestRuntimeRelease?: () => Promise<RuntimeRelease>;
  nativeCodexHome?: string;
  ownedThreadIds?: () => readonly string[];
  /** Manual proxy supplied by the app; applied only to the Codex child process. */
  proxyUrl?: string | null;
  /** Extra -c overrides for the application-level model source. */
  configOverrides?: () => readonly string[];
  /** Environment entries for the application-level model source. */
  environment?: () => Readonly<Record<string, string>>;
};

const RUNTIME_RELEASE_API = 'https://api.github.com/repos/openai/codex/releases/latest';

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

async function isExecutable(path: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (platform === 'win32') {
      return (await stat(path)).isFile() && /\.exe$/iu.test(path);
    }
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
  let target: RuntimeTarget;
  try {
    target = runtimeTargetFor(deps.platform, deps.arch);
  } catch {
    return null;
  }
  const manifestPath = join(candidate, 'codex-package.json');
  if (!(deps.exists ?? existsSync)(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = String(manifest.version ?? '');
    const binary = runtimeEntryPath(candidate, String(manifest.entrypoint ?? ''));
    const pathDirectory = runtimeEntryPath(candidate, String(manifest.pathDir ?? ''));
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
    if (!runtimeManifestMatches(manifest, version, target)) return null;
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
  const cacheRoot = join(storeDirectory, 'runtime/codex');
  const packaged = join(resourceRoot, 'runtime/codex');
  const candidates: Array<{
    root: string;
    source: RuntimeSource;
    version: string;
    manuallyUpdated: boolean;
  }> = [];
  for (const [root, source] of [[cacheRoot, 'cache'], [packaged, 'packaged']] as const) {
    if (!(deps.exists ? deps.exists(root) : existsSync(root))) continue;
    for (const version of await readDirectory(root)) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
      const runtimeRoot = join(root, version);
      let manuallyUpdated = false;
      const metadataPath = join(runtimeRoot, 'rambo-runtime.json');
      if (source === 'cache' && (deps.exists ? deps.exists(metadataPath) : existsSync(metadataPath))) {
        try {
          manuallyUpdated = JSON.parse(readFileSync(metadataPath, 'utf8')).updateChannel === 'manual';
        } catch {
          manuallyUpdated = false;
        }
      }
      candidates.push({ root: runtimeRoot, source, version, manuallyUpdated });
    }
  }
  candidates.sort((left, right) => compareVersions(right.version, left.version));
  const available: Array<{ layout: RuntimeLayout; manuallyUpdated: boolean }> = [];
  const executable = deps.isExecutable ??
    ((path: string) => isExecutable(path, deps.platform ?? process.platform));
  for (const candidate of candidates) {
    const layout = readManagedRuntime(candidate.root, deps, candidate.source);
    if (!layout) continue;
    if (!(await executable(layout.binary))) continue;
    available.push({ layout, manuallyUpdated: candidate.manuallyUpdated });
  }
  const manual = available.filter(item =>
    item.layout.source === 'cache' && item.manuallyUpdated
  )[0];
  if (manual) return manual.layout;
  const packagedLayout = available.find(item => item.layout.source === 'packaged')?.layout;
  const cachedLayout = available.find(item => item.layout.source === 'cache')?.layout;
  if (cachedLayout && (!packagedLayout ||
      compareVersions(cachedLayout.version, packagedLayout.version) > 0)) {
    return cachedLayout;
  }
  if (packagedLayout) return packagedLayout;
  if (cachedLayout) return cachedLayout;
  throw new Error('未找到可用的 Codex App Server，请重新安装 Rambo 或点击“更新 App Server”');
}

async function readDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export async function fetchLatestRuntimeRelease(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): Promise<RuntimeRelease> {
  const target = runtimeTargetFor(platform, arch);
  const response = await fetch(RUNTIME_RELEASE_API, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'Rambo-Codex-Runtime-Updater'
    }
  });
  if (!response.ok) throw new Error(`检查 App Server 更新失败：${response.status}`);
  const release: any = await response.json();
  const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
  const match = tag.match(/^rust-v(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`Codex 最新发布标签无效：${tag || '未知'}`);
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate: any) => candidate?.name === target.asset)
    : null;
  if (!asset || typeof asset.browser_download_url !== 'string') {
    throw new Error(`Codex ${match[1]} 没有 ${target.target} App Server 包`);
  }
  const digest = typeof asset.digest === 'string' ? asset.digest : '';
  const sha256 = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : '';
  if (!/^[a-f\d]{64}$/i.test(sha256)) {
    throw new Error(`Codex ${match[1]} 的 App Server SHA-256 缺失或无效`);
  }
  return {
    version: match[1],
    archiveUrl: asset.browser_download_url,
    sha256,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null
  };
}

async function installRuntimeRelease(
  release: RuntimeRelease,
  version: string,
  destination: string,
  onProgress?: (progress: RuntimeProgress) => void,
  target: RuntimeTarget = runtimeTargetFor()
): Promise<string> {
  if (!/^[a-f\d]{64}$/i.test(release.sha256)) throw new Error('Codex 运行时 SHA-256 格式无效');
  const temporary = await mkdtemp(join(tmpdir(), 'rambo-runtime-'));
  try {
    const archive = join(temporary, 'runtime.tar.gz');
    const url = release.archiveUrl;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('Codex 运行时下载地址无效');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Codex 运行时下载地址必须使用 http:// 或 https://');
    }
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`下载 Codex 运行时失败：${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    const totalBytes = Number.isSafeInteger(contentLength) && contentLength > 0
      ? contentLength
      : null;
    let downloadedBytes = 0;
    let lastProgressAt = 0;
    const reportProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressAt < 100) return;
      lastProgressAt = now;
      onProgress?.({ phase: 'downloading', downloadedBytes, totalBytes });
    };
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedBytes += chunk.length;
        reportProgress(downloadedBytes === totalBytes);
        callback(null, chunk);
      }
    });
    reportProgress(true);
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      progress,
      createWriteStream(archive)
    );
    reportProgress(true);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(archive)) digest.update(chunk);
    if (digest.digest('hex') !== release.sha256) throw new Error('Codex 运行时 SHA-256 不匹配');
    const extracted = join(temporary, 'extracted');
    await mkdir(extracted);
    const listing = listTarGzEntries(archive, { platform: target.platform });
    if (listing.some(entry => !isSafeArchiveEntry(entry))) {
      throw new Error('Codex 运行时归档路径不安全');
    }
    extractTarGz(archive, extracted, { platform: target.platform });
    const manifestPath = join(extracted, 'codex-package.json');
    if (!existsSync(manifestPath)) throw new Error('Codex 运行时归档布局无效');
    let manifest: any;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error('Codex 运行时 manifest 无法解析');
    }
    if (
      !runtimeManifestMatches(manifest, version, target)
    ) {
      throw new Error(`Codex 运行时 manifest 与 ${version} 不匹配`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await renameWithRetry(extracted, destination);
    await writeFile(join(destination, 'rambo-runtime.json'), JSON.stringify({
      version,
      sha256: release.sha256,
      source: `openai/codex rust-v${version}`,
      updateChannel: 'manual',
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

function codexChildPath(
  pathDirectory: string,
  platform: NodeJS.Platform,
  homeDirectory: string | undefined
): string {
  const inheritedPath = process.env.PATH ?? process.env.Path ?? (platform === 'win32'
    ? 'C:\\Windows\\System32;C:\\Windows'
    : '/usr/bin:/bin');
  const npx = findNpx({
    platform,
    environment: process.env,
    home: homeDirectory
  });
  const entries = [
    pathDirectory,
    npx ? dirname(npx) : null,
    ...inheritedPath.split(pathDelimiter(platform))
  ].filter((entry): entry is string => Boolean(entry));
  return [...new Set(entries)].join(pathDelimiter(platform));
}

export class CodexRuntime extends EventEmitter {
  state: RuntimeState = {
    status: 'stopped',
    version: '',
    source: null,
    error: null,
    progress: null
  };
  private readonly homeManager: RuntimeHomeManager;
  private readonly realtimeAudioBridge: RealtimeAudioBridge;
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private lateResponses = new Map<number, (outcome: RequestOutcome<any>) => void>();
  private nextId = 1;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private updating = false;

  constructor(
    private readonly resourceRoot: string,
    private readonly workingDirectory: string,
    private readonly spawnProcess: RuntimeProcessSpawner = spawn,
    private readonly resolverDeps: RuntimeResolverDeps = {}
  ) {
    super();
    const nativeHome = resolverDeps.nativeCodexHome ?? (resolverDeps.homeDirectory
      ? join(resolverDeps.homeDirectory, '.codex')
      : process.env.CODEX_HOME || join(homedir(), '.codex'));
    this.homeManager = new RuntimeHomeManager(
      nativeHome,
      workingDirectory,
      () => resolverDeps.ownedThreadIds?.() ?? [],
      {
        onState: state => this.emit('homeSync', state)
      }
    );
    this.realtimeAudioBridge = new RealtimeAudioBridge({
      proxyUrl: resolverDeps.proxyUrl
    });
  }

  get homeSyncState(): CodexHomeSyncState {
    return this.homeManager.snapshot();
  }

  async setHomeSyncMode(
    mode: CodexHomeSyncMode,
    restart = true
  ): Promise<CodexHomeSyncState> {
    const state = await this.homeManager.setMode(mode);
    if (restart && mode === 'follow' && this.state.status === 'ready') {
      await this.stop();
      await this.start();
    }
    return state;
  }

  async applyPendingHomeSync(): Promise<CodexHomeSyncState> {
    const before = this.homeManager.snapshot();
    if (before.mode !== 'follow' || !before.pending) return before;
    await this.homeManager.applyPending();
    if (this.state.status === 'ready') {
      await this.stop();
      await this.start();
    }
    return this.homeManager.snapshot();
  }

  dispose(): void {
    this.homeManager.dispose();
    void this.realtimeAudioBridge.close();
  }

  setProxyUrl(proxyUrl: string | null | undefined): void {
    this.resolverDeps.proxyUrl = proxyUrl?.trim() || null;
    this.realtimeAudioBridge.setProxyUrl(this.resolverDeps.proxyUrl);
  }

  setModelSourceConfig(
    overrides: readonly string[],
    environment: Readonly<Record<string, string>>
  ): void {
    this.resolverDeps.configOverrides = () => overrides;
    this.resolverDeps.environment = () => environment;
  }

  private setState(
    status: RuntimeState['status'],
    error: string | null = null,
    progress: RuntimeProgress | null = null
  ): void {
    this.state = { ...this.state, status, error, progress };
    this.emit('state', this.state);
  }

  private setProgress(progress: RuntimeProgress | null): void {
    this.state = { ...this.state, progress };
    this.emit('state', this.state);
  }

  async updateRuntime(beforeRestart?: () => void): Promise<RuntimeUpdateResult> {
    if (this.updating) throw new Error('App Server 正在更新，请等待当前更新完成');
    this.updating = true;
    try {
      const target = runtimeTargetFor(
        this.resolverDeps.platform ?? process.platform,
        this.resolverDeps.arch ?? process.arch
      );
      const release = await (this.resolverDeps.latestRuntimeRelease ??
        (() => fetchLatestRuntimeRelease(target.platform, target.arch)))();
      if (!/^\d+\.\d+\.\d+$/.test(release.version)) {
        throw new Error(`Codex App Server 版本无效：${release.version || '未知'}`);
      }
      let current = this.state.status === 'ready' && this.state.version
        ? { version: this.state.version, source: this.state.source ?? null }
        : null;
      if (!current) {
        const layout = await resolveRuntimeLayout(
          this.resourceRoot,
          this.workingDirectory,
          this.resolverDeps
        ).catch(() => null);
        if (layout) current = { version: layout.version, source: layout.source };
      }
      const previousVersion = current?.version ?? '';
      if (current && compareVersions(release.version, current.version) <= 0) {
        return {
          status: 'up-to-date',
          previousVersion,
          version: current.version,
          source: current.source ?? 'packaged'
        };
      }

      const destination = join(this.workingDirectory, 'runtime/codex', release.version);
      const existing = readManagedRuntime(destination, this.resolverDeps, 'cache');
      const executable = this.resolverDeps.isExecutable ??
        ((path: string) => isExecutable(path, target.platform));
      const alreadyInstalled = Boolean(
        existing &&
        existing.version === release.version &&
        await executable(existing.binary)
      );
      if (!alreadyInstalled) {
        this.setProgress({ phase: 'downloading', downloadedBytes: 0, totalBytes: null });
        const download = this.resolverDeps.downloadRuntime ?? ((
          version: string,
          destinationPath: string,
          onProgress?: (progress: RuntimeProgress) => void
        ) => installRuntimeRelease(release, version, destinationPath, onProgress, target));
        await download(release.version, destination, this.setProgress.bind(this));
        const installed = readManagedRuntime(destination, this.resolverDeps, 'cache');
        if (!installed || !(await executable(installed.binary))) {
          throw new Error(`下载的 Codex App Server 布局无效：${destination}`);
        }
      }
      this.setProgress(null);
      const installed = readManagedRuntime(destination, this.resolverDeps, 'cache');
      if (!installed || installed.version !== release.version || !(await executable(installed.binary))) {
        throw new Error(`下载的 Codex App Server 布局无效：${destination}`);
      }
      // A custom downloader may only install the extracted package. Mark the
      // directory here so later Rambo updates keep honoring the manual choice.
      await writeFile(join(destination, 'rambo-runtime.json'), JSON.stringify({
        version: release.version,
        sha256: release.sha256,
        source: `openai/codex rust-v${release.version}`,
        updateChannel: 'manual',
        sessionSource: 'app-server'
      }, null, 2));

      beforeRestart?.();
      const wasReady = this.state.status === 'ready';
      if (this.process || this.state.status === 'ready' || this.state.status === 'starting') {
        await this.stop();
      }
      try {
        await this.start();
      } catch (error) {
        await rm(destination, { recursive: true, force: true }).catch(() => {});
        if (wasReady) {
          await this.start().catch(() => {});
        }
        if (!wasReady) {
          const fallback = await resolveRuntimeLayout(
            this.resourceRoot,
            this.workingDirectory,
            this.resolverDeps
          ).catch(() => null);
          this.state = {
            ...this.state,
            version: fallback?.version ?? '',
            source: fallback?.source ?? null,
            progress: null
          };
          this.emit('state', this.state);
        }
        throw new Error(`App Server 更新启动失败，已恢复原运行时：${
          error instanceof Error ? error.message : String(error)
        }`);
      }
      return {
        status: 'updated',
        previousVersion,
        version: this.state.version || release.version,
        source: this.state.source ?? 'cache'
      };
    } finally {
      this.updating = false;
      if (this.state.progress) this.setProgress(null);
    }
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
    const platform = this.resolverDeps.platform ?? process.platform;
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
      codexHome = await this.homeManager.prepare();
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.state = { ...this.state, version: layout.version, source: layout.source };
    let realtimeWsBaseUrl: string;
    try {
      realtimeWsBaseUrl = await this.realtimeAudioBridge.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState('error', message);
      throw error;
    }
    const args = ['--listen', 'stdio://', '--session-source', 'app-server'];
    args.push(
      '-c', 'cli_auth_credentials_store="file"',
      '-c', `sqlite_home=${JSON.stringify(codexHome)}`,
      ...(this.resolverDeps.configOverrides?.() ?? []),
      '-c', `experimental_realtime_ws_base_url=${JSON.stringify(realtimeWsBaseUrl)}`
    );
    const child = this.spawnProcess(layout.binary, args, {
      cwd: this.workingDirectory,
      env: {
        ...process.env,
        ...runtimeProxyEnv(this.resolverDeps.proxyUrl),
        ...(this.resolverDeps.environment?.() ?? {}),
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: codexHome,
        PATH: codexChildPath(
          layout.pathDirectory,
          platform,
          this.resolverDeps.homeDirectory
        )
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: platform !== 'win32'
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
        terminateProcessTree(child, {
          platform,
          processGroup: platform !== 'win32'
        });
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
      await this.realtimeAudioBridge.close();
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
    const platform = this.resolverDeps.platform ?? process.platform;
    await terminateProcessTreeAsync(child, {
      platform,
      processGroup: platform !== 'win32',
      graceMs: 3_000
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
      await this.realtimeAudioBridge.close();
      this.setState('stopped');
    });
    try { await this.stopping; } finally { this.stopping = null; }
  }
}
