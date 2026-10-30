#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { assertNativeBuildTarget, parseBuildTarget } from '../../../../scripts/platform-target.mjs';
import {
  releaseArtifactName,
  releaseMetadataName,
  releasePackageCommand,
  verifyPackagedRuntime
} from './release-utils.mjs';

const root = resolve(process.cwd());
const args = process.argv.slice(2);
const targetArgument = args.find(argument => !argument.startsWith('--')) ??
  `${process.platform}-${process.arch}`;
const skipBuild = args.includes('--skip-build');
const target = parseBuildTarget(targetArgument);
assertNativeBuildTarget(target, 'Rambo 发布包构建');

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const runtimeConfig = JSON.parse(
  await readFile(join(root, 'config', 'runtime-targets.json'), 'utf8')
);
const version = String(packageJson.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error(`package.json version 不是有效的 semver：${version}`);
}

const outputDirectory = join(root, 'dist', 'release', `v${version}`);
const artifactName = releaseArtifactName(version, target);
const artifactPath = join(outputDirectory, artifactName);
const checksumPath = `${artifactPath}.sha256`;
const metadataPath = join(outputDirectory, releaseMetadataName(version, target));

if (!skipBuild) {
  console.log(`[rambo-release] 构建 Rambo ${version} (${target.key})`);
  const build = spawnSync('npm', releasePackageCommand(target), {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw new Error(`Rambo 构建失败，npm 退出码：${build.status ?? 'unknown'}`);
  }
}

await rm(artifactPath, { force: true });
await rm(checksumPath, { force: true });
await rm(metadataPath, { force: true });
await mkdir(outputDirectory, { recursive: true });

let runtime;
if (target.platform === 'darwin') {
  const appPath = join(
    root,
    target.arch === 'arm64' ? 'dist/mac-arm64/Rambo.app' : 'dist/mac/Rambo.app'
  );
  if (!existsSync(appPath)) throw new Error(`构建成功但找不到应用：${appPath}`);
  const appStat = await stat(appPath);
  if (!appStat.isDirectory()) throw new Error(`应用路径不是目录：${appPath}`);

  // Electron ships a linker ad-hoc signature that does not seal the renamed app.
  console.log('[rambo-release] 重封本地 ad-hoc 签名（非 Developer ID）');
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
    cwd: root,
    stdio: 'inherit'
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
    cwd: root,
    stdio: 'inherit'
  });
  const signature = execFileSync(
    '/bin/sh',
    ['-c', '/usr/bin/codesign -dv --verbose=4 "$1" 2>&1', 'sh', appPath],
    { cwd: root, encoding: 'utf8' }
  );
  if (
    !/^Signature=adhoc$/mu.test(signature) ||
    /^Authority=/mu.test(signature) ||
    /^TeamIdentifier=(?!not set)/mu.test(signature)
  ) {
    throw new Error('发布产物不是预期的无证书 ad-hoc 签名');
  }

  runtime = await verifyPackagedRuntime({
    resourcesRoot: join(appPath, 'Contents', 'Resources'),
    targetKey: target.key,
    runtimeConfig
  });
  console.log('[rambo-release] 压缩 macOS 应用');
  execFileSync(
    '/usr/bin/ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, artifactPath],
    { cwd: root, stdio: 'inherit' }
  );
} else {
  const installerSource = join(root, 'dist', artifactName);
  const unpackedRoot = join(root, 'dist', 'win-unpacked');
  if (!existsSync(installerSource)) {
    throw new Error(`构建成功但找不到 Windows 安装包：${installerSource}`);
  }
  if (!existsSync(unpackedRoot)) {
    throw new Error(`构建成功但找不到 Windows unpacked 应用：${unpackedRoot}`);
  }
  runtime = await verifyPackagedRuntime({
    resourcesRoot: join(unpackedRoot, 'resources'),
    targetKey: target.key,
    runtimeConfig
  });
  await copyFile(installerSource, artifactPath);
}

const artifact = await readFile(artifactPath);
const digest = createHash('sha256').update(artifact).digest('hex');
const artifactStat = await stat(artifactPath);
await writeFile(checksumPath, `${digest}  ${basename(artifactPath)}\n`);
await writeFile(metadataPath, JSON.stringify({
  schema: 'rambo.release-artifact.v1',
  version,
  targetKey: target.key,
  platform: target.platform,
  arch: target.arch,
  artifact: basename(artifactPath),
  sha256: digest,
  bytes: artifactStat.size,
  appServer: runtime
}, null, 2));
console.log(JSON.stringify({
  version,
  target: target.key,
  artifact: artifactPath,
  checksum: checksumPath,
  metadata: metadataPath,
  sha256: digest,
  bytes: artifactStat.size,
  appServer: runtime
}, null, 2));
