import { join } from 'node:path';
import runtimeTargetConfig from '../../../config/runtime-targets.json' with { type: 'json' };

export interface RuntimeTarget {
  key: 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'win32-arm64';
  platform: 'darwin' | 'win32';
  arch: 'arm64' | 'x64';
  target: string;
  asset: string;
  sha256: string;
  entrypoint: string;
  pathDir: string;
}

type RawTarget = Omit<RuntimeTarget, 'key' | 'platform' | 'arch'>;

const config = runtimeTargetConfig as {
  schema: string;
  version: string;
  releaseRepository: string;
  targets: Record<string, RawTarget>;
};

if (config.schema !== 'rambo.runtime-targets.v1') {
  throw new Error('运行时目标配置格式无效');
}

export const RUNTIME_BASELINE_VERSION = config.version;
export const RUNTIME_RELEASE_REPOSITORY = config.releaseRepository;

export function runtimeTargetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): RuntimeTarget['key'] {
  if ((platform === 'darwin' || platform === 'win32') && (arch === 'arm64' || arch === 'x64')) {
    return `${platform}-${arch}` as RuntimeTarget['key'];
  }
  throw new Error(`Codex App Server 暂不支持 ${platform}-${arch}`);
}

export function runtimeTargetFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): RuntimeTarget {
  const key = runtimeTargetKey(platform, arch);
  const raw = config.targets[key];
  if (!raw || !/^[a-f\d]{64}$/u.test(raw.sha256)) {
    throw new Error(`运行时目标配置缺失或损坏：${key}`);
  }
  return {
    key,
    platform: platform as RuntimeTarget['platform'],
    arch: arch as RuntimeTarget['arch'],
    ...raw
  };
}

export function runtimeEntryPath(root: string, entrypoint: string): string {
  return join(root, ...entrypoint.split('/'));
}

export function runtimeManifestMatches(
  manifest: Record<string, unknown> | null | undefined,
  version: string,
  target: RuntimeTarget
): boolean {
  return manifest?.version === version &&
    manifest?.variant === 'codex-app-server' &&
    manifest?.target === target.target &&
    manifest?.entrypoint === target.entrypoint &&
    manifest?.pathDir === target.pathDir;
}

export function isSafeArchiveEntry(entry: string): boolean {
  if (!entry || entry.includes('\0')) return false;
  const normalized = entry.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized)) return false;
  return !normalized.split('/').some(part => part === '..');
}
