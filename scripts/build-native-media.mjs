import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  assertNativeBuildTarget,
  currentBuildTarget,
  executableSuffix
} from './platform-target.mjs';
import { resolveFfmpegBinary } from './prepare-ffmpeg.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = currentBuildTarget();
const decoderRoot = join(projectRoot, 'native/wechat-silk-decoder');
const decoderName = 'rambo-wechat-silk-decoder';
const suffix = executableSuffix(target.platform);
const decoderSource = join(decoderRoot, 'target/release', `${decoderName}${suffix}`);
const windowsScannerRoot = join(projectRoot, 'native/wechat-windows-key-scanner');
const windowsScannerName = 'rambo-wechat-key-scanner';
const windowsScannerSource = join(
  windowsScannerRoot,
  'target/release',
  `${windowsScannerName}${suffix}`
);
const copyForBundle = process.argv.includes('--copy');

if (copyForBundle || target.platform === 'win32') {
  assertNativeBuildTarget(target, '构建本机媒体与微信扫描组件');
}

const cargo = spawnSync('cargo', ['build', '--release', '--manifest-path', join(decoderRoot, 'Cargo.toml')], {
  cwd: projectRoot,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024
});
if (cargo.stdout) process.stdout.write(cargo.stdout);
if (cargo.stderr) process.stderr.write(cargo.stderr);
if (cargo.error) throw new Error(`构建微信语音解码器失败：${cargo.error.message}`);
if (cargo.status !== 0 || !existsSync(decoderSource)) {
  throw new Error('构建微信语音解码器失败，请检查 Rust 工具链。');
}

if (target.platform === 'win32') {
  const scannerBuild = spawnSync('cargo', [
    'build',
    '--release',
    '--manifest-path',
    join(windowsScannerRoot, 'Cargo.toml')
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
  if (scannerBuild.stdout) process.stdout.write(scannerBuild.stdout);
  if (scannerBuild.stderr) process.stderr.write(scannerBuild.stderr);
  if (scannerBuild.error) throw new Error(`构建 Windows 微信密钥扫描器失败：${scannerBuild.error.message}`);
  if (scannerBuild.status !== 0 || !existsSync(windowsScannerSource)) {
    throw new Error('构建 Windows 微信密钥扫描器失败，请检查 Rust 工具链。');
  }
}

if (copyForBundle) {
  const ffmpeg = await resolveFfmpegBinary(target);
  const ffmpegSource = ffmpeg.binary;
  const ffmpegLicense = ffmpeg.license;
  const outputDirectory = join(projectRoot, 'out/media-tools');
  mkdirSync(outputDirectory, { recursive: true });
  const files = [
    [decoderSource, join(outputDirectory, `${decoderName}${suffix}`)],
    [ffmpegSource, join(outputDirectory, `ffmpeg${suffix}`)],
    [join(decoderRoot, 'LICENSE'), join(outputDirectory, 'wechat-silk-license.txt')],
    [ffmpegLicense, join(outputDirectory, 'ffmpeg-license.txt')]
  ];
  if (target.platform === 'win32') {
    files.push(
      [windowsScannerSource, join(outputDirectory, `${windowsScannerName}.exe`)],
      [join(windowsScannerRoot, 'LICENSE'), join(outputDirectory, 'wechat-windows-key-scanner-license.txt')],
      [join(windowsScannerRoot, 'UPSTREAM.md'), join(outputDirectory, 'wechat-windows-key-scanner-UPSTREAM.md')]
    );
  }
  for (const [source, target] of files) {
    copyFileSync(source, target);
  }
  chmodSync(join(outputDirectory, `${decoderName}${suffix}`), 0o755);
  chmodSync(join(outputDirectory, `ffmpeg${suffix}`), 0o755);
  if (target.platform === 'win32') {
    chmodSync(join(outputDirectory, `${windowsScannerName}.exe`), 0o755);
  }
}
