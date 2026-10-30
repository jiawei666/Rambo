import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync
} from 'node:fs';
import { rename } from 'node:fs/promises';
import { win32 } from 'node:path';

const WINDOWS_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'EPERM']);

export function openReadOnlyNoFollow(
  path: string,
  platform: NodeJS.Platform = process.platform
): number {
  const noFollow = platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  return openSync(path, constants.O_RDONLY | noFollow);
}

export function protectPrivateDirectorySync(
  path: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') {
    chmodSync(path, 0o700);
    return;
  }
  applyWindowsAcl(path, true);
}

export function protectPrivateFileSync(
  path: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (!existsSync(path)) return;
  if (platform !== 'win32') {
    chmodSync(path, 0o600);
    return;
  }
  applyWindowsAcl(path, false);
}

export function windowsAclArguments(path: string, directory: boolean, identity: string): string[] {
  return [
    path,
    '/inheritance:r',
    '/grant:r',
    `${identity}:${directory ? '(OI)(CI)F' : 'F'}`
  ];
}

function applyWindowsAcl(path: string, directory: boolean): void {
  const systemRoot = process.env.SystemRoot?.trim() ||
    process.env.WINDIR?.trim() ||
    'C:\\Windows';
  const whoami = win32.join(systemRoot, 'System32', 'whoami.exe');
  const icacls = win32.join(systemRoot, 'System32', 'icacls.exe');
  const identity = execFileSync(whoami, [], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  if (!identity) throw new Error(`无法确定当前 Windows 用户，不能保护私有路径：${path}`);
  execFileSync(icacls, windowsAclArguments(path, directory, identity), {
    windowsHide: true,
    stdio: 'ignore'
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Windows antivirus/indexers can briefly lock a destination during replace.
 * Retry the atomic rename instead of deleting user data or giving up on the
 * first sharing violation.
 */
export async function renameWithRetry(
  source: string,
  destination: string,
  options: {
    platform?: NodeJS.Platform;
    attempts?: number;
    initialDelayMs?: number;
  } = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const attempts = platform === 'win32' ? Math.max(1, options.attempts ?? 8) : 1;
  const initialDelayMs = options.initialDelayMs ?? 25;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt + 1 >= attempts || !WINDOWS_RETRY_CODES.has(code)) throw error;
      await delay(initialDelayMs * (attempt + 1));
    }
  }
}

export function ensurePrivateDirectorySync(
  path: string,
  platform: NodeJS.Platform = process.platform
): void {
  mkdirSync(path, { recursive: true, mode: platform === 'win32' ? undefined : 0o700 });
  protectPrivateDirectorySync(path, platform);
}

export function closeQuietly(descriptor: number | null): void {
  if (descriptor === null) return;
  try { closeSync(descriptor); } catch { /* already closed */ }
}
