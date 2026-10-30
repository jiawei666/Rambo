import { execFile as execFileCallback } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  readSync,
  readdirSync,
  realpathSync
} from 'node:fs';
import { isPathInsideOrEqual } from './platform/paths';
import { openReadOnlyNoFollow } from './platform/fs';
import { join, relative, sep } from 'node:path';
import { opensWechatDatabase, WECHAT_PAGE_SIZE } from './wechat-sqlcipher';
import type {
  ExecOptions,
  ExecResult,
  WechatCapturedAccount,
  WechatCaptureDriverStatus,
  WechatWizardPhase,
  WechatWizardProgress
} from './wechat-platform-types';

export const WECHAT_CAPTURE_SECONDS = 120;
export const WECHAT_CAPTURE_TIMEOUT_MS = 240_000;
const MAX_DATABASES = 2_000;

export interface WechatKeyCandidate {
  key: string;
  salt: string | null;
}

export interface WechatDatabaseMapping {
  keys: WechatCapturedAccount['keys'];
  missingRequiredCount: number;
  databaseCount: number;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

export function runFile(
  file: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(file, args, {
      encoding: 'utf8',
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      windowsHide: true,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, {
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '')
        }));
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    child.on('error', error => reject(Object.assign(error, { stdout: '', stderr: '' })));
  });
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('微信连接已取消');
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  ensureActive(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('微信连接已取消'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function progress(
  callback: (value: WechatWizardProgress) => void,
  phase: WechatWizardPhase,
  message: string,
  canFinishCapture = false,
  canContinueCapture = false
): void {
  try {
    callback({
      phase,
      message,
      ...(canFinishCapture ? { canFinishCapture: true } : {}),
      ...(canContinueCapture ? { canContinueCapture: true } : {})
    });
  } catch {
    // A closing renderer must not prevent process and clone cleanup.
  }
}

export function parseCapturedWechatKeys(output: string): string[] {
  const keys = new Set<string>();
  for (const line of output.split(/\r\n|\r|\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { wxkey?: unknown };
      if (typeof value.wxkey === 'string' && /^[a-f0-9]{64}$/iu.test(value.wxkey)) {
        keys.add(value.wxkey.toLowerCase());
      }
    } catch {
      // Progress and diagnostics are never treated as secrets.
    }
  }
  return [...keys];
}

export function parseWechatCaptureStatuses(content: string): WechatCaptureDriverStatus[] {
  const allowed = new Set<WechatCaptureDriverStatus['phase']>([
    'attaching',
    'attached',
    'hook-ready',
    'key-count',
    'round-complete',
    'round-start',
    'complete',
    'failed',
    'cancelled'
  ]);
  const result: WechatCaptureDriverStatus[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { phase?: unknown; keyCount?: unknown };
      if (typeof value.phase !== 'string' ||
          !allowed.has(value.phase as WechatCaptureDriverStatus['phase'])) continue;
      result.push({
        phase: value.phase as WechatCaptureDriverStatus['phase'],
        keyCount: typeof value.keyCount === 'number' && Number.isSafeInteger(value.keyCount)
          ? Math.max(0, value.keyCount)
          : 0
      });
    } catch {
      // Ignore incomplete or malformed status lines.
    }
  }
  return result;
}

function relevantDatabase(path: string): boolean {
  return /(?:^|\/)db_storage\/(?:contact\/contact|session\/session)\.db$/u.test(path) ||
    /(?:^|\/)db_storage\/message\/(?:biz_)?message_\d+\.db$/u.test(path) ||
    /(?:^|\/)db_storage\/message\/media_\d+\.db$/u.test(path);
}

function listWechatDatabases(accountDirectory: string): string[] {
  const result: string[] = [];
  const root = realpathSync(accountDirectory);
  const storage = join(root, 'db_storage');
  if (!existsSync(storage) || lstatSync(storage).isSymbolicLink()) {
    throw new Error('所选微信账号缺少本机数据库目录');
  }
  const visit = (directory: string, depth: number): void => {
    if (depth > 12 || result.length > MAX_DATABASES) {
      throw new Error('微信数据库目录数量超过安全上限');
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.db')) {
        const relativePath = relative(root, path).split(sep).join('/');
        if (relevantDatabase(relativePath)) result.push(path);
      }
    }
  };
  visit(storage, 0);
  const ordered = result.sort();
  const requiredFamilies = [
    /(?:^|\/)db_storage\/contact\/contact\.db$/u,
    /(?:^|\/)db_storage\/session\/session\.db$/u,
    /(?:^|\/)db_storage\/message\/(?:biz_)?message_\d+\.db$/u,
    /(?:^|\/)db_storage\/message\/media_\d+\.db$/u
  ];
  if (requiredFamilies.some(pattern =>
    !ordered.some(path => pattern.test(relative(root, path).split(sep).join('/')))
  )) {
    throw new Error('所选微信账号缺少聊天或媒体数据库。');
  }
  return ordered;
}

function firstPage(path: string): Buffer | null {
  let descriptor: number | null = null;
  try {
    descriptor = openReadOnlyNoFollow(path);
    const page = Buffer.alloc(WECHAT_PAGE_SIZE);
    let offset = 0;
    while (offset < page.length) {
      const count = readSync(descriptor, page, offset, page.length - offset, offset);
      if (!count) return null;
      offset += count;
    }
    return page;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function mapWechatKeyCandidatesToDatabases(
  accountDirectory: string,
  candidateValues: WechatKeyCandidate[]
): WechatDatabaseMapping {
  const root = realpathSync(accountDirectory);
  const keys: WechatCapturedAccount['keys'] = {};
  const databases = listWechatDatabases(root);
  const candidates: WechatKeyCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidateValues) {
    if (!/^[a-f0-9]{64}$/iu.test(candidate.key)) continue;
    const key = candidate.key.toLowerCase();
    const salt = candidate.salt && /^[a-f0-9]{32}$/iu.test(candidate.salt)
      ? candidate.salt.toLowerCase()
      : null;
    const identity = `${key}:${salt ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push({ key, salt });
  }

  for (const databasePath of databases) {
    const page = firstPage(databasePath);
    if (!page) continue;
    const salt = page.subarray(0, 16).toString('hex');
    const matchingSalt = candidates.filter(candidate => candidate.salt === salt);
    const rest = candidates.filter(candidate => candidate.salt !== salt);
    const matched = [...matchingSalt, ...rest].find(candidate => {
      try {
        return opensWechatDatabase(candidate.key, page);
      } catch {
        return false;
      }
    });
    if (!matched) continue;
    const relativePath = relative(root, databasePath).split(sep).join('/');
    keys[relativePath] = { encKey: matched.key, salt };
  }
  return {
    keys,
    missingRequiredCount: databases.filter(path =>
      !keys[relative(root, path).split(sep).join('/')]
    ).length,
    databaseCount: databases.length
  };
}

export function mapWechatKeysToDatabases(
  accountDirectory: string,
  candidateKeys: string[]
): WechatDatabaseMapping {
  return mapWechatKeyCandidatesToDatabases(
    accountDirectory,
    candidateKeys.map(key => ({ key, salt: null }))
  );
}

export function summarizeWechatDatabaseCoverage(keys: WechatCapturedAccount['keys']): string {
  const paths = Object.keys(keys);
  const has = (path: string) => paths.includes(path);
  const messages = paths.some(path => /^db_storage\/message\/(?:biz_)?message_\d+\.db$/u.test(path));
  const media = paths.some(path => /^db_storage\/message\/media_\d+\.db$/u.test(path));
  return [
    `会话库${has('db_storage/session/session.db') ? '已匹配' : '未匹配'}`,
    `消息库${messages ? '已匹配' : '未匹配'}`,
    `媒体库${media ? '已匹配' : '未匹配'}`
  ].join('；');
}

export function validateWechatAccountDirectory(
  root: string,
  selected: string,
  platformLabel: string
): { accountId: string; dataDirectory: string } {
  let rootInfo;
  try {
    rootInfo = lstatSync(root);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN';
    throw new Error(`无法访问微信数据目录（${code}）；请检查 ${platformLabel} 文件访问授权。`);
  }
  if (rootInfo.isSymbolicLink()) {
    throw new Error('微信数据目录本身是符号链接，当前连接流程不接受该目录。');
  }

  let selectedInfo;
  try {
    selectedInfo = lstatSync(selected);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN';
    throw new Error(`无法读取所选目录（${code}）；请在文件选择器中直接选择 wxid_ 账号目录。`);
  }
  if (selectedInfo.isSymbolicLink()) {
    throw new Error('所选账号目录是符号链接，当前连接流程不接受该目录。');
  }
  if (!selectedInfo.isDirectory()) {
    throw new Error('所选项目不是目录；请直接选择 wxid_ 账号目录。');
  }

  let realRoot: string;
  let dataDirectory: string;
  try {
    realRoot = realpathSync(root);
    dataDirectory = realpathSync(selected);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN';
    throw new Error(`无法解析所选账号目录（${code}）；请检查 ${platformLabel} 文件访问授权。`);
  }
  const relativePath = relative(realRoot, dataDirectory);
  const pathParts = relativePath.split(sep).filter(Boolean);
  const accountId = pathParts[0] ?? '';
  if (!/^wxid_[a-zA-Z0-9_-]{3,200}$/u.test(accountId)) {
    throw new Error('当前选中的是上级目录或备份目录；请直接选择以 wxid_ 开头的账号目录。');
  }
  const accountDirectory = join(realRoot, accountId);
  if (!isPathInsideOrEqual(accountDirectory, dataDirectory)) {
    throw new Error('所选目录没有位于微信账号目录中；请重新选择 wxid_ 账号目录。');
  }

  const dbStorage = join(accountDirectory, 'db_storage');
  try {
    const dbStorageInfo = lstatSync(dbStorage);
    if (dbStorageInfo.isSymbolicLink() || !dbStorageInfo.isDirectory()) {
      throw new Error('微信账号目录中的 db_storage 不是普通目录；请确认选择了当前账号目录。');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('微信账号目录中的')) throw error;
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'UNKNOWN';
    throw new Error(`所选 wxid_ 目录无法读取 db_storage（${code}）；请检查文件访问授权。`);
  }
  return { accountId, dataDirectory: accountDirectory };
}

export function redactWechatDiagnostics(value: string, temporaryRoot?: string | null): string {
  return value
    .replaceAll(temporaryRoot ?? '\0', '<临时目录>')
    .replace(/\b[a-f0-9]{64}\b/giu, '<密钥>')
    .replace(
      /([A-Za-z]:[\\/]Users[\\/])([^\\/\s"'<>|]+)/giu,
      (_match, prefix: string) => `${prefix}<用户目录>`
    )
    .replace(/(?<![A-Za-z]:)\/Users\/[^/\s"'<>]+/gu, '~')
    .slice(0, 300);
}
