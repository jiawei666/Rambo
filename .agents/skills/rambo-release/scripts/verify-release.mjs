#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  parseReleaseTargets,
  releaseArtifactName,
  releaseMetadataName,
  releasePortableArtifactName
} from './release-utils.mjs';

const root = resolve(process.cwd());
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeConfig = JSON.parse(
  await readFile(join(root, 'config', 'runtime-targets.json'), 'utf8')
);
const version = String(packageJson.version || '').trim();
const targetKeys = parseReleaseTargets(process.argv[2]);
const outputDirectory = join(root, 'dist', 'release', `v${version}`);
const verified = [];

for (const targetKey of targetKeys) {
  const [platform, arch] = targetKey.split('-');
  const target = { key: targetKey, platform, arch };
  const artifactPath = join(outputDirectory, releaseArtifactName(version, target));
  const checksumPath = `${artifactPath}.sha256`;
  const metadataPath = join(outputDirectory, releaseMetadataName(version, target));
  const portableArtifactName = releasePortableArtifactName(version, target);
  const portableArtifactPath = portableArtifactName ? join(outputDirectory, portableArtifactName) : null;
  const portableChecksumPath = portableArtifactPath ? `${portableArtifactPath}.sha256` : null;
  for (const path of [artifactPath, checksumPath, metadataPath]) {
    if (!existsSync(path)) throw new Error(`缺少发布文件：${path}`);
  }
  if (portableArtifactPath && !existsSync(portableArtifactPath)) {
    throw new Error(`缺少 Windows 免安装 ZIP：${portableArtifactPath}`);
  }
  if (portableChecksumPath && !existsSync(portableChecksumPath)) {
    throw new Error(`缺少 Windows 免安装 ZIP 校验文件：${portableChecksumPath}`);
  }

  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const runtimeTarget = runtimeConfig.targets?.[targetKey];
  if (!runtimeTarget) throw new Error(`运行时配置缺少目标：${targetKey}`);
  if (
    metadata.schema !== 'rambo.release-artifact.v1' ||
    metadata.version !== version ||
    metadata.targetKey !== targetKey ||
    metadata.artifact !== releaseArtifactName(version, target) ||
    metadata.portableArtifact !== (portableArtifactName ?? null) ||
    metadata.appServer?.version !== runtimeConfig.version ||
    metadata.appServer?.target !== runtimeTarget.target ||
    metadata.appServer?.sha256 !== runtimeTarget.sha256
  ) {
    throw new Error(`${targetKey} 的发布元数据与当前版本或运行时配置不一致`);
  }
  if (metadata.appServer.architecture !== arch) {
    throw new Error(
      `${targetKey} 的内置 App Server 架构为 ${metadata.appServer.architecture}，应为 ${arch}`
    );
  }

  const artifact = await readFile(artifactPath);
  const digest = createHash('sha256').update(artifact).digest('hex');
  if (digest !== metadata.sha256) throw new Error(`${targetKey} 安装包 SHA-256 与元数据不一致`);
  const checksum = String(await readFile(checksumPath, 'utf8')).trim().split(/\s+/u)[0];
  if (checksum !== digest) throw new Error(`${targetKey} 校验文件内容不正确`);
  const artifactStat = await stat(artifactPath);
  if (artifactStat.size !== metadata.bytes) {
    throw new Error(`${targetKey} 安装包大小与元数据不一致`);
  }
  let portable = null;
  if (portableArtifactPath && portableChecksumPath) {
    const portableArtifact = await readFile(portableArtifactPath);
    const portableDigest = createHash('sha256').update(portableArtifact).digest('hex');
    if (portableDigest !== metadata.portableSha256) {
      throw new Error(`${targetKey} 免安装 ZIP SHA-256 与元数据不一致`);
    }
    const portableChecksum = String(await readFile(portableChecksumPath, 'utf8'))
      .trim()
      .split(/\s+/u)[0];
    if (portableChecksum !== portableDigest) {
      throw new Error(`${targetKey} 免安装 ZIP 校验文件内容不正确`);
    }
    const portableStat = await stat(portableArtifactPath);
    if (portableStat.size !== metadata.portableBytes) {
      throw new Error(`${targetKey} 免安装 ZIP 大小与元数据不一致`);
    }
    const archiveEntries = execFileSync(
      'unzip',
      ['-Z1', portableArtifactPath],
      { encoding: 'utf8' }
    ).split(/\r?\n/u);
    for (const required of ['win-unpacked/Rambo.exe', 'win-unpacked/resources/app.asar']) {
      if (!archiveEntries.includes(required)) {
        throw new Error(`${targetKey} 免安装 ZIP 缺少入口：${required}`);
      }
    }
    portable = {
      artifact: portableArtifactPath,
      sha256: portableDigest,
      bytes: portableStat.size
    };
  }
  verified.push({
    target: targetKey,
    artifact: artifactPath,
    sha256: digest,
    bytes: artifactStat.size,
    portable,
    appServer: metadata.appServer
  });
}

console.log(JSON.stringify({ version, verified }, null, 2));
