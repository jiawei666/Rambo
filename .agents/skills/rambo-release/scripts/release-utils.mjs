import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_RELEASE_TARGETS = ['darwin-arm64', 'win32-x64'];

export function releaseArtifactName(version, target) {
  if (target.platform === 'darwin') {
    return `Rambo-v${version}-macOS-${target.arch}.zip`;
  }
  return `Rambo-v${version}-Windows-${target.arch}.exe`;
}

export function releaseMetadataName(version, target) {
  return `Rambo-v${version}-${target.key}.release.json`;
}

export function releasePackageCommand(target) {
  if (target.platform === 'darwin') {
    return ['run', `package:mac:${target.arch}`];
  }
  return ['run', target.arch === 'x64' ? 'package:win' : 'package:win:arm64'];
}

export function parseReleaseTargets(value) {
  const values = String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const targets = values.length ? values : [...DEFAULT_RELEASE_TARGETS];
  const platforms = new Set();
  const keys = new Set();
  for (const key of targets) {
    const match = /^(darwin|win32)-(arm64|x64)$/u.exec(key);
    if (!match) throw new Error(`无效的发布目标：${key}`);
    if (keys.has(key)) throw new Error(`发布目标重复：${key}`);
    keys.add(key);
    platforms.add(match[1]);
  }
  if (!platforms.has('darwin') || !platforms.has('win32')) {
    throw new Error('正式发布必须同时包含 macOS 与 Windows 产物；单个平台只能做候选构建。');
  }
  return targets;
}

export async function verifyPackagedRuntime({
  resourcesRoot,
  targetKey,
  runtimeConfig,
  binaryVerifier = verifyRuntimeBinary
}) {
  const target = runtimeConfig.targets?.[targetKey];
  if (!target) throw new Error(`运行时配置缺少目标：${targetKey}`);
  const expectedVersion = runtimeConfig.version;
  const runtimeRoot = join(resourcesRoot, 'runtime', 'codex');
  const versions = (await readdir(runtimeRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  if (versions.length !== 1 || versions[0] !== expectedVersion) {
    throw new Error(
      `安装包必须只包含 App Server ${expectedVersion}，实际为：${versions.join(', ') || '(空)'}`
    );
  }

  const versionRoot = join(runtimeRoot, expectedVersion);
  const codexManifest = JSON.parse(await readFile(join(versionRoot, 'codex-package.json'), 'utf8'));
  const runtimeManifest = JSON.parse(await readFile(join(versionRoot, 'rambo-runtime.json'), 'utf8'));
  for (const [label, manifest] of [
    ['codex-package.json', codexManifest],
    ['rambo-runtime.json', runtimeManifest]
  ]) {
    if (manifest.version !== expectedVersion || manifest.target !== target.target) {
      throw new Error(
        `${label} 的版本或目标不匹配：期望 ${expectedVersion}/${target.target}，` +
        `实际 ${manifest.version}/${manifest.target}`
      );
    }
  }
  if (
    codexManifest.variant !== 'codex-app-server' ||
    codexManifest.entrypoint !== target.entrypoint ||
    codexManifest.pathDir !== target.pathDir ||
    runtimeManifest.sha256 !== target.sha256
  ) {
    throw new Error('安装包内 App Server manifest 与固定运行时配置不一致');
  }

  const binary = join(versionRoot, ...target.entrypoint.split('/'));
  const binaryStat = await stat(binary);
  if (!binaryStat.isFile() || binaryStat.size === 0) throw new Error(`App Server 入口无效：${binary}`);
  const architecture = await binaryVerifier(binary, targetKey);
  return {
    version: expectedVersion,
    target: target.target,
    sha256: target.sha256,
    binary,
    architecture,
    bytes: binaryStat.size
  };
}

export async function verifyRuntimeBinary(path, targetKey) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 64) throw new Error(`App Server 文件过小：${path}`);
    const expected = runtimeArchitecture(targetKey);
    const actual = detectBinaryArchitecture(header.subarray(0, bytesRead));
    if (actual !== expected) {
      throw new Error(`App Server 架构不匹配：期望 ${expected}，实际 ${actual || '未知'}`);
    }
    return actual;
  } finally {
    await handle.close();
  }
}

export function runtimeArchitecture(targetKey) {
  if (targetKey === 'darwin-arm64' || targetKey === 'win32-arm64') return 'arm64';
  if (targetKey === 'darwin-x64' || targetKey === 'win32-x64') return 'x64';
  throw new Error(`不支持的运行时目标：${targetKey}`);
}

export function detectBinaryArchitecture(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === 0xfeedfacf) {
    const cpuType = buffer.readUInt32LE(4);
    if (cpuType === 0x0100000c) return 'arm64';
    if (cpuType === 0x01000007) return 'x64';
    return null;
  }
  if (buffer.length >= 64 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset + 6 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) return null;
    const machine = buffer.readUInt16LE(peOffset + 4);
    if (machine === 0xaa64) return 'arm64';
    if (machine === 0x8664) return 'x64';
  }
  return null;
}
