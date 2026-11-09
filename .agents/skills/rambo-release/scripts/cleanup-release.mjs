#!/usr/bin/env node
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const GENERATED_DIRECTORIES = new Set([
  'release',
  'mac',
  'mac-arm64',
  'mac-x64',
  'mac-universal',
  'win-unpacked',
  'win-arm64-unpacked'
]);

const GENERATED_FILES = new Set([
  '.DS_Store',
  'builder-debug.yml',
  'builder-effective-config.yaml'
]);

const GENERATED_METADATA_FILE = /^latest(?:-[A-Za-z0-9]+)?\.yml$/u;

const GENERATED_RELEASE_ARTIFACT =
  /^Rambo-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-(?:Windows-(?:x64|arm64)\.exe(?:\.blockmap|\.sha256)?|macOS-(?:arm64|x64)\.zip(?:\.sha256)?|Windows-(?:x64|arm64)-portable\.zip(?:\.sha256)?)$/u;

export async function cleanupReleaseArtifacts({
  repoRoot = process.cwd(),
  dryRun = false
} = {}) {
  const root = resolve(repoRoot);
  const distRoot = resolve(root, 'dist');
  if (distRoot !== join(root, 'dist')) {
    throw new Error(`拒绝清理仓库 dist 之外的路径：${distRoot}`);
  }

  let distStat;
  try {
    distStat = await lstat(distRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { distRoot, dryRun, removed: [], wouldRemove: [], retained: [] };
    }
    throw error;
  }
  if (distStat.isSymbolicLink()) {
    throw new Error(`拒绝清理符号链接 dist 目录：${distRoot}`);
  }
  if (!distStat.isDirectory()) {
    throw new Error(`仓库 dist 不是目录：${distRoot}`);
  }

  const entries = (await readdir(distRoot, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const generated = entries.filter(entry => {
    if (entry.isDirectory() && GENERATED_DIRECTORIES.has(entry.name)) return true;
    return entry.isFile() && (
      GENERATED_FILES.has(entry.name) ||
      GENERATED_METADATA_FILE.test(entry.name) ||
      GENERATED_RELEASE_ARTIFACT.test(entry.name)
    );
  });
  const generatedPaths = generated.map(entry => {
    const path = resolve(distRoot, entry.name);
    if (!path.startsWith(`${distRoot}${sep}`)) {
      throw new Error(`拒绝清理 dist 之外的路径：${path}`);
    }
    return { name: entry.name, path };
  });

  if (!dryRun) {
    for (const entry of generatedPaths) {
      await rm(entry.path, { recursive: true, force: false });
    }
  }

  const names = generatedPaths.map(entry => entry.name);
  return {
    distRoot,
    dryRun,
    removed: dryRun ? [] : names,
    wouldRemove: dryRun ? names : [],
    retained: entries
      .filter(entry => !generated.some(item => item.name === entry.name))
      .map(entry => entry.name)
  };
}

async function main() {
  const args = process.argv.slice(2);
  let releaseTag = null;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--release') {
      releaseTag = args[index + 1] ?? null;
      index += 1;
      if (!releaseTag) throw new Error('--release 后必须提供 v<version>');
      continue;
    }
    throw new Error(`不支持的参数：${argument}`);
  }
  if (!releaseTag) {
    throw new Error('发布成功后清理必须显式指定 --release v<version>');
  }

  const root = resolve(process.cwd());
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const expectedTag = `v${String(packageJson.version || '').trim()}`;
  if (releaseTag !== expectedTag) {
    throw new Error(`待清理版本 ${releaseTag} 与 package.json 的 ${expectedTag} 不一致`);
  }

  const result = await cleanupReleaseArtifacts({ repoRoot: root, dryRun });
  console.log(JSON.stringify({ releaseTag, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
