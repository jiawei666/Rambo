import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentBuildTarget, isSafeArchiveEntry } from './platform-target.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(projectRoot, 'config/runtime-targets.json'), 'utf8'));
const targetKey = currentBuildTarget().key;
const target = config.targets?.[targetKey];
if (!target) {
  throw new Error(`当前平台没有已校验的 Codex App Server 运行时：${targetKey}`);
}
const version = config.version;
const destination = resolve(projectRoot, 'runtime/codex', version);
const executable = join(destination, ...target.entrypoint.split('/'));
const preparedManifest = (() => {
  try {
    return JSON.parse(readFileSync(join(destination, 'codex-package.json'), 'utf8'));
  } catch {
    return null;
  }
})();
if (
  preparedManifest?.version === version &&
  preparedManifest?.variant === 'codex-app-server' &&
  preparedManifest?.target === target.target &&
  preparedManifest?.entrypoint === target.entrypoint &&
  preparedManifest?.pathDir === target.pathDir &&
  existsSync(executable)
) {
  const runtimeManifestPath = join(destination, 'rambo-runtime.json');
  const preparedRuntime = (() => {
    try {
      return JSON.parse(readFileSync(runtimeManifestPath, 'utf8'));
    } catch {
      return null;
    }
  })();
  if (preparedRuntime?.target === target.target && preparedRuntime?.sha256 === target.sha256) {
    console.log(`运行时已准备：${destination}`);
    process.exit(0);
  }
  await writeFile(runtimeManifestPath, JSON.stringify({
    version,
    sha256: target.sha256,
    target: target.target,
    source: `openai/codex rust-v${version}`,
    sessionSource: 'app-server'
  }, null, 2));
  console.log(`已补充运行时目标信息：${destination}`);
  process.exit(0);
}

async function renameWithRetry(source, targetPath) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(source, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!['EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) {
        throw error;
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

const tarCommand = process.platform === 'win32'
  ? join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';

function runTar(args, encoding) {
  try {
    return execFileSync(tarCommand, args, {
      encoding,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        '系统没有可用的 tar 解压工具。Windows 10/11 应自带 System32\\tar.exe；' +
        '请先更新系统或修复系统组件。'
      );
    }
    throw new Error(`解压 Codex 运行时归档失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

const temporary = await mkdtemp(join(tmpdir(), 'rambo-runtime-'));
try {
  const cachedArchive = join(
    tmpdir(),
    `rambo-app-server-package-${version}-${targetKey}.tar.gz`
  );
  let archive = cachedArchive;
  if (!existsSync(archive)) {
    archive = join(temporary, 'runtime.tar.gz');
    const response = await fetch(
      `https://github.com/openai/codex/releases/download/rust-v${version}/${target.asset}`
    );
    if (!response.ok || !response.body) throw new Error(`下载运行时失败：${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  if (digest.digest('hex') !== target.sha256) throw new Error('运行时归档 SHA-256 不匹配');
  const listing = String(runTar(['-tzf', archive], 'utf8'))
    .trim().split(/\r?\n/u).filter(Boolean);
  if (listing.some(entry => !isSafeArchiveEntry(entry))) throw new Error('归档路径不安全');
  const extracted = join(temporary, 'extracted');
  await mkdir(extracted);
  runTar(['-xzf', archive, '-C', extracted]);
  const manifest = JSON.parse(readFileSync(join(extracted, 'codex-package.json'), 'utf8'));
  const extractedExecutable = join(extracted, ...target.entrypoint.split('/'));
  if (
    manifest.version !== version ||
    manifest.variant !== 'codex-app-server' ||
    manifest.target !== target.target ||
    manifest.entrypoint !== target.entrypoint ||
    manifest.pathDir !== target.pathDir ||
    !existsSync(extractedExecutable)
  ) throw new Error('归档布局与固定平台目标不匹配');
  await mkdir(resolve(projectRoot, 'runtime/codex'), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await renameWithRetry(extracted, destination);
  await writeFile(join(destination, 'rambo-runtime.json'), JSON.stringify({
    version,
    sha256: target.sha256,
    target: target.target,
    source: `openai/codex rust-v${version}`,
    sessionSource: 'app-server'
  }, null, 2));
  console.log(`已准备独立 App Server ${version}（${target.target}）：${destination}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
