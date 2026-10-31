import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, sep, win32 } from 'node:path';
import {
  ensureActive,
  mapWechatKeyCandidatesToDatabases,
  progress,
  redactWechatDiagnostics,
  runFile,
  summarizeWechatDatabaseCoverage,
  validateWechatAccountDirectory,
  type WechatKeyCandidate
} from './wechat-connector-common';
import type {
  ExecOptions,
  ExecResult,
  WechatCapturedAccount,
  WechatConnectorAdapter,
  WechatConnectorRuntime,
  WechatConnectorWizardOptions,
  WechatWizardPrompts,
  WechatWizardProgress
} from './wechat-platform-types';

const SCANNER_TIMEOUT_MS = 75_000;
const MAX_SCANNER_CANDIDATES = 4_096;
const SCANNER_EXECUTABLE = 'rambo-wechat-key-scanner.exe';

interface WindowsWechatAccount {
  accountId: string;
  dataDirectory: string;
  xwechatRoot: string;
}

interface WindowsScannerOutput {
  candidates: WechatKeyCandidate[];
  reportedCount: number;
  timedOut: boolean;
  regionsScanned: number;
  plaintextCount: number;
  maskedCount: number;
}

function normalizeWindowsPath(value: string): string {
  const trimmed = value.replace(/^\uFEFF/u, '').trim().replace(/^"(.*)"$/u, '$1');
  return trimmed.replace(/[\\/]+$/u, '');
}

export function parseWindowsWechatDataRoot(
  content: string,
  documentsDirectory: string
): string | null {
  for (const rawLine of content.split(/\r?\n/u)) {
    const value = normalizeWindowsPath(rawLine);
    if (!value) continue;
    if (/^MyDocument:$/iu.test(value)) return documentsDirectory;
    if (isAbsolute(value) || win32.isAbsolute(value)) return value;
  }
  return null;
}

function findXwechatRoots(
  appDataDirectory: string,
  documentsDirectory: string
): string[] {
  const roots = new Set<string>();
  const configDirectory = join(appDataDirectory, 'Tencent', 'xwechat', 'config');
  if (existsSync(configDirectory)) {
    for (const entry of readdirSync(configDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ini')) continue;
      try {
        const dataRoot = parseWindowsWechatDataRoot(
          readFileSync(join(configDirectory, entry.name), 'utf8'),
          documentsDirectory
        );
        if (!dataRoot) continue;
        roots.add(
          basename(dataRoot).toLowerCase() === 'xwechat_files'
            ? dataRoot
            : join(dataRoot, 'xwechat_files')
        );
      } catch {
        // A broken account config must not prevent trying the remaining configs.
      }
    }
  }
  roots.add(join(documentsDirectory, 'xwechat_files'));
  return [...roots].filter(root => existsSync(root));
}

function discoverWindowsWechatAccounts(
  appDataDirectory: string,
  documentsDirectory: string
): { roots: string[]; accounts: WindowsWechatAccount[] } {
  const roots = findXwechatRoots(appDataDirectory, documentsDirectory);
  const accounts: WindowsWechatAccount[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^wxid_[a-zA-Z0-9_-]{3,200}$/u.test(entry.name)) continue;
      const dataDirectory = join(root, entry.name);
      try {
        const info = lstatSync(dataDirectory);
        const storage = lstatSync(join(dataDirectory, 'db_storage'));
        if (info.isSymbolicLink() || storage.isSymbolicLink() || !storage.isDirectory()) continue;
        const canonical = realpathSync(dataDirectory);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        accounts.push({
          accountId: entry.name,
          dataDirectory: canonical,
          xwechatRoot: root
        });
      } catch {
        // Ignore incomplete or inaccessible account directories.
      }
    }
  }
  return { roots, accounts };
}

function rootForSelection(roots: string[], selected: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(selected);
  } catch {
    canonical = selected;
  }
  const matching = roots.find(root => {
    try {
      const canonicalRoot = realpathSync(root);
      return canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}${sep}`);
    } catch {
      return false;
    }
  });
  if (matching) return matching;

  // The native folder picker may return the account directory, db_storage,
  // or a deeper directory. Recover the xwechat_files root without guessing
  // from the current login account.
  let current = canonical;
  while (true) {
    if (basename(current).toLowerCase() === 'xwechat_files') return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirname(canonical);
}

export function parseWindowsScannerOutput(output: string): WindowsScannerOutput {
  const candidates: WechatKeyCandidate[] = [];
  const seen = new Set<string>();
  let reportedCount = 0;
  let regionsScanned = 0;
  let plaintextCount = 0;
  let maskedCount = 0;
  let timedOut = false;
  const counter = (value: unknown): number =>
    typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(0, value) : 0;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (value.type === 'status') {
      if (value.phase === 'timeout') timedOut = true;
      reportedCount = Math.max(reportedCount, counter(value.candidateCount));
      regionsScanned = Math.max(regionsScanned, counter(value.regionsScanned));
      plaintextCount = Math.max(plaintextCount, counter(value.plaintextCount));
      maskedCount = Math.max(maskedCount, counter(value.maskedCount));
      continue;
    }
    if (value.type !== 'candidate' ||
        typeof value.key !== 'string' ||
        !/^[a-f0-9]{64}$/iu.test(value.key)) continue;
    const key = value.key.toLowerCase();
    const salt = typeof value.salt === 'string' && /^[a-f0-9]{32}$/iu.test(value.salt)
      ? value.salt.toLowerCase()
      : null;
    const identity = `${key}:${salt ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (candidates.length >= MAX_SCANNER_CANDIDATES) {
      throw new Error('微信进程内存中的候选密钥数量超过安全上限。');
    }
    candidates.push({ key, salt });
  }
  return {
    candidates,
    reportedCount: Math.max(reportedCount, candidates.length),
    timedOut,
    regionsScanned,
    plaintextCount,
    maskedCount
  };
}

function scannerPath(runtime: WechatConnectorRuntime): string {
  if (runtime.windowsScannerPath) return runtime.windowsScannerPath;
  if (!runtime.resourcesDirectory) {
    throw new Error('Windows 微信密钥扫描组件路径尚未配置。');
  }
  return join(runtime.resourcesDirectory, 'media-tools', SCANNER_EXECUTABLE);
}

function normalizeVersionInfo(stdout: string): { version: string; build: string } | null {
  try {
    const value = JSON.parse(stdout.trim()) as {
      FileVersion?: unknown;
      ProductVersion?: unknown;
    };
    const build = typeof value.FileVersion === 'string' && value.FileVersion.trim()
      ? value.FileVersion.trim()
      : typeof value.ProductVersion === 'string' && value.ProductVersion.trim()
        ? value.ProductVersion.trim()
        : '';
    if (!build) return null;
    const match = /^(\d+\.\d+\.\d+)/u.exec(build);
    return { version: match?.[1] ?? '4.x', build };
  } catch {
    return null;
  }
}

async function readWechatVersionInfo(
  runtime: WechatConnectorRuntime,
  execute: (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>,
  signal: AbortSignal
): Promise<{ version: string; build: string }> {
  if (runtime.windowsWechatVersionInfo) return runtime.windowsWechatVersionInfo;
  try {
    const { stdout } = await execute('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$p = Get-Process -Name Weixin -ErrorAction Stop | Select-Object -First 1; $v = $p.MainModule.FileVersionInfo; [pscustomobject]@{ FileVersion = $v.FileVersion; ProductVersion = $v.ProductVersion } | ConvertTo-Json -Compress"
    ], { signal, timeout: 10_000, maxBuffer: 64 * 1024 });
    return normalizeVersionInfo(stdout) ?? { version: '4.x', build: 'unknown' };
  } catch {
    return { version: '4.x', build: 'unknown' };
  }
}

export class WindowsMemoryWechatConnector implements WechatConnectorAdapter {
  readonly backend = 'windows-memory' as const;
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly prompts: WechatWizardPrompts,
    private readonly runtime: WechatConnectorRuntime = {},
    private readonly options: WechatConnectorWizardOptions = {}
  ) {}

  private execute(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return (this.runtime.runFile ?? runFile)(file, args, options);
  }

  cancel(connectionId: string): void {
    this.active.get(connectionId)?.abort();
  }

  requestCaptureStop(): boolean {
    return false;
  }

  requestCaptureContinue(): boolean {
    return false;
  }

  async cancelAll(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    while (this.active.size) await new Promise(resolve => setTimeout(resolve, 25));
  }

  async capture(
    connectionId: string,
    onProgress: (value: WechatWizardProgress) => void
  ): Promise<WechatCapturedAccount> {
    if ((this.runtime.platform ?? process.platform) !== 'win32') {
      throw new Error('Windows 微信连接器只能在 Windows 上运行。');
    }
    if (this.active.size) throw new Error('已有微信连接向导正在运行，请先完成或取消。');
    const controller = new AbortController();
    const { signal } = controller;
    this.active.set(connectionId, controller);
    let scannerStdout = '';
    try {
      progress(onProgress, 'checking', '正在查找已登录的 Windows 微信和本机数据库。');
      const environment = this.runtime.environment ?? process.env;
      const appDataDirectory = this.runtime.windowsAppDataDirectory ??
        environment.APPDATA ??
        environment.AppData;
      if (!appDataDirectory || !isAbsolute(appDataDirectory) && !win32.isAbsolute(appDataDirectory)) {
        throw new Error('无法确定 Windows APPDATA 目录；请重新启动微信后重试。');
      }
      const documentsDirectory = this.runtime.windowsDocumentsDirectory ??
        (environment.USERPROFILE ? join(environment.USERPROFILE, 'Documents') : environment.HOME);
      if (!documentsDirectory) {
        throw new Error('无法确定 Windows 用户文档目录；请重新启动 Rambo 后重试。');
      }

      const discovery = discoverWindowsWechatAccounts(appDataDirectory, documentsDirectory);
      let selectedDirectory: string | null;
      if (discovery.accounts.length === 1) {
        selectedDirectory = discovery.accounts[0].dataDirectory;
      } else {
        const defaultDirectory = discovery.accounts[0]?.dataDirectory ??
          discovery.roots[0] ??
          join(documentsDirectory, 'xwechat_files');
        selectedDirectory = await this.prompts.chooseAccountDirectory(defaultDirectory);
      }
      if (!selectedDirectory) throw new Error('微信连接已取消');
      ensureActive(signal);

      const xwechatRoot = discovery.accounts.find(account =>
        account.dataDirectory === realpathOrSelf(selectedDirectory)
      )?.xwechatRoot ?? rootForSelection(discovery.roots, selectedDirectory);
      const account = validateWechatAccountDirectory(
        xwechatRoot,
        selectedDirectory,
        'Windows'
      );

      const executable = scannerPath(this.runtime);
      if (!existsSync(executable)) {
        throw new Error('Windows 微信密钥扫描组件尚未构建或未随应用打包。');
      }
      progress(
        onProgress,
        'capturing',
        '正在扫描 Weixin.exe 的可读写内存并校验数据库密钥；不会复制、重签或修改微信。'
      );
      let scannerResult: ExecResult;
      try {
        scannerResult = await this.execute(executable, [
          '--timeout-ms', String(SCANNER_TIMEOUT_MS),
          '--max-candidates', String(MAX_SCANNER_CANDIDATES)
        ], {
          signal,
          timeout: SCANNER_TIMEOUT_MS + 15_000,
          maxBuffer: 8 * 1024 * 1024
        });
      } catch (error) {
        const details = error && typeof error === 'object'
          ? error as { stderr?: unknown; stdout?: unknown; code?: unknown }
          : {};
        const stderr = typeof details.stderr === 'string'
          ? redactWechatDiagnostics(details.stderr.trim())
          : '';
        const reason = stderr ? `：${stderr}` : '';
        const hint = /OpenProcess|Access is denied|拒绝访问/iu.test(stderr)
          ? '请以管理员身份运行 Rambo 后重试。'
          : '请确认微信已登录并保持运行。';
        throw new Error(`Windows 微信内存扫描失败${reason}。${hint}`);
      }
      scannerStdout = scannerResult.stdout;
      const parsed = parseWindowsScannerOutput(scannerStdout);
      scannerStdout = '';
      if (!parsed.candidates.length) {
        if (parsed.timedOut) {
          throw new Error('Windows 微信内存扫描超时；请保持微信运行并重试，或缩小当前扫描负载。');
        }
        throw new Error(
          `没有从微信进程内存中找到数据库密钥（已扫描 ${parsed.regionsScanned} 个内存区域；` +
          `明文候选 ${parsed.plaintextCount} 个、混淆候选 ${parsed.maskedCount} 个）；` +
          '请确认微信已登录并打开最近聊天后重试。'
        );
      }

      progress(
        onProgress,
        'verifying',
        `已读取 ${parsed.reportedCount} 个候选密钥，正在用每个数据库首页 HMAC 验证。`
      );
      const mapping = mapWechatKeyCandidatesToDatabases(account.dataDirectory, parsed.candidates);
      if (mapping.databaseCount === 0 || mapping.missingRequiredCount > 0) {
        const coverage = summarizeWechatDatabaseCoverage(mapping.keys);
        throw new Error(
          `SQLCipher 校验未覆盖全部数据库：${mapping.databaseCount - mapping.missingRequiredCount}/` +
          `${mapping.databaseCount} 个匹配；${coverage}` +
          `${parsed.timedOut ? '；扫描在完成前超时' : ''}。请在微信中打开缺失的聊天或媒体后重试。`
        );
      }
      const version = await readWechatVersionInfo(this.runtime, this.execute.bind(this), signal);
      ensureActive(signal);
      progress(onProgress, 'complete', `SQLCipher 校验通过：${mapping.databaseCount} 个数据库已匹配。`);
      return {
        accountId: account.accountId,
        dataDirectory: account.dataDirectory,
        wechatVersion: version.version,
        wechatBuild: version.build,
        keys: mapping.keys
      };
    } catch (error) {
      if (signal.aborted) throw new Error('微信连接已取消');
      if (error instanceof Error && !('stdout' in error) && !('stderr' in error)) throw error;
      const details = error && typeof error === 'object'
        ? error as { code?: unknown; stderr?: unknown }
        : {};
      const code = typeof details.code === 'string' || typeof details.code === 'number'
        ? `（系统错误 ${details.code}）`
        : '';
      const stderr = typeof details.stderr === 'string'
        ? redactWechatDiagnostics(details.stderr.trim())
        : '';
      throw new Error(`Windows 微信连接失败${code}${stderr ? `：${stderr}` : ''}`);
    } finally {
      scannerStdout = '';
      this.active.delete(connectionId);
    }
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
