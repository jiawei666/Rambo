import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface ArchiveCommandOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

export function systemTarCommand(options: ArchiveCommandOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return 'tar';
  const environment = options.environment ?? process.env;
  const systemRoot = environment.SystemRoot?.trim() ||
    environment.WINDIR?.trim() ||
    'C:\\Windows';
  const bundledTar = win32.join(systemRoot, 'System32', 'tar.exe');
  return (options.exists ?? existsSync)(bundledTar) ? bundledTar : 'tar.exe';
}

function archiveFailure(
  action: string,
  archivePath: string,
  error: unknown,
  platform: NodeJS.Platform
): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT') {
    return new Error(
      `系统没有可用的 tar 解压工具，无法${action}：${archivePath}。` +
      'Windows 10/11 应自带 System32\\tar.exe；请先更新系统或修复系统组件。'
    );
  }
  if (platform === 'win32') {
    return new Error(
      `无法${action} ${archivePath}：${detail}。` +
      'Windows 10/11 应自带 System32\\tar.exe；请先更新系统或修复系统组件。'
    );
  }
  return new Error(`无法${action} ${archivePath}：${detail}`);
}

export function listTarGzEntries(
  archivePath: string,
  options: ArchiveCommandOptions = {}
): string[] {
  const command = systemTarCommand(options);
  try {
    return execFileSync(command, ['-tzf', archivePath], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    }).trim().split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    throw archiveFailure(
      '读取 Codex 运行时归档',
      archivePath,
      error,
      options.platform ?? process.platform
    );
  }
}

export function extractTarGz(
  archivePath: string,
  destination: string,
  options: ArchiveCommandOptions = {}
): void {
  const command = systemTarCommand(options);
  try {
    execFileSync(command, ['-xzf', archivePath, '-C', destination], {
      windowsHide: true
    });
  } catch (error) {
    throw archiveFailure(
      '解压 Codex 运行时归档',
      archivePath,
      error,
      options.platform ?? process.platform
    );
  }
}
