import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync
} from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(projectRoot, 'package.json'));

const WINDOWS_ARM64_FFMPEG = {
  archiveName: 'ffmpeg-N-128198-g37515cfd87-winarm64-gpl.zip',
  sha256: 'cab1325cc38b7f2ead048ff705ed556a136b6c85d159b42de60bb87661910258',
  url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-29-19-17/ffmpeg-N-128198-g37515cfd87-winarm64-gpl.zip'
};

function fileDigest(path) {
  return new Promise((resolveDigest, reject) => {
    const digest = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', chunk => digest.update(chunk))
      .on('end', () => resolveDigest(digest.digest('hex')));
  });
}

async function downloadVerifiedArchive(url, sha256, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载 Windows ARM64 FFmpeg 失败：${response.status}`);
  const total = Number(response.headers.get('content-length'));
  let downloaded = 0;
  let lastReport = 0;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.byteLength;
      const now = Date.now();
      if (now - lastReport >= 5_000) {
        lastReport = now;
        const percent = Number.isFinite(total) && total > 0
          ? ` ${(downloaded / total * 100).toFixed(1)}%`
          : '';
        process.stdout.write(`下载 Windows ARM64 FFmpeg${percent}\n`);
      }
      this.push(chunk);
      callback();
    }
  });
  await pipeline(
    Readable.fromWeb(response.body),
    progress,
    createWriteStream(destination)
  );
  const actual = await fileDigest(destination);
  if (actual !== sha256) throw new Error('Windows ARM64 FFmpeg SHA-256 不匹配');
}

function extractZip(archive, destination) {
  const tar = spawnSync('tar', ['-xf', archive, '-C', destination], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (tar.status === 0) return;
  if (process.platform !== 'win32') {
    throw new Error(`解压 Windows ARM64 FFmpeg 失败：${tar.stderr || tar.error?.message || tar.status}`);
  }
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const powershell = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`
  ], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (powershell.status !== 0) {
    throw new Error(`解压 Windows ARM64 FFmpeg 失败：${powershell.stderr || powershell.error?.message || powershell.status}`);
  }
}

function findNamedFile(root, names) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && names.has(entry.name.toLowerCase())) return path;
    if (entry.isDirectory()) {
      const found = findNamedFile(path, names);
      if (found) return found;
    }
  }
  return null;
}

async function prepareWindowsArm64Ffmpeg() {
  const cacheDirectory = join(projectRoot, '.cache/ffmpeg/win32-arm64');
  const binary = join(cacheDirectory, 'ffmpeg.exe');
  const license = join(cacheDirectory, 'LICENSE.txt');
  if (existsSync(binary) && existsSync(license)) return { binary, license };

  mkdirSync(cacheDirectory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'rambo-ffmpeg-'));
  try {
    const archive = join(temporary, WINDOWS_ARM64_FFMPEG.archiveName);
    await downloadVerifiedArchive(WINDOWS_ARM64_FFMPEG.url, WINDOWS_ARM64_FFMPEG.sha256, archive);
    const extracted = join(temporary, 'extracted');
    await mkdir(extracted);
    extractZip(archive, extracted);
    const sourceBinary = findNamedFile(extracted, new Set(['ffmpeg.exe']));
    const sourceLicense = findNamedFile(extracted, new Set(['license', 'license.txt', 'copying.gplv2']));
    if (!sourceBinary) throw new Error('Windows ARM64 FFmpeg 归档中没有 ffmpeg.exe');
    if (!sourceLicense) throw new Error('Windows ARM64 FFmpeg 归档中没有许可证文件');
    const temporaryBinary = `${binary}.${process.pid}.tmp`;
    const temporaryLicense = `${license}.${process.pid}.tmp`;
    await copyFile(sourceBinary, temporaryBinary);
    await copyFile(sourceLicense, temporaryLicense);
    await rename(temporaryBinary, binary);
    await rename(temporaryLicense, license);
    return { binary, license };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function resolveFfmpegBinary(target) {
  if (target.platform === 'win32' && target.arch === 'arm64') {
    return prepareWindowsArm64Ffmpeg();
  }
  let binary;
  try {
    binary = require('ffmpeg-static');
  } catch {
    throw new Error('当前构建机没有 ffmpeg-static；请重新安装依赖或改用已支持的构建目标。');
  }
  if (typeof binary !== 'string' || !existsSync(binary)) {
    throw new Error(`当前构建机没有 ${target.key} 可用的 FFmpeg 二进制。`);
  }
  const license = join(dirname(binary), 'LICENSE');
  if (!existsSync(license)) throw new Error('FFmpeg 许可证文件缺失，拒绝打包。');
  return { binary, license };
}
