import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const decoderRoot = join(projectRoot, 'native/wechat-silk-decoder');
const decoderName = 'rambo-wechat-silk-decoder';
const decoderSource = join(decoderRoot, 'target/release', decoderName);
const require = createRequire(join(projectRoot, 'package.json'));
const copyForBundle = process.argv.includes('--copy');

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

if (copyForBundle) {
  const ffmpegSource = require('ffmpeg-static');
  if (typeof ffmpegSource !== 'string' || !existsSync(ffmpegSource)) {
    throw new Error('FFmpeg 未安装，无法打包微信视频读取能力。');
  }
  const ffmpegLicense = join(dirname(ffmpegSource), 'LICENSE');
  const outputDirectory = join(projectRoot, 'out/media-tools');
  mkdirSync(outputDirectory, { recursive: true });
  for (const [source, target] of [
    [decoderSource, join(outputDirectory, decoderName)],
    [ffmpegSource, join(outputDirectory, 'ffmpeg')],
    [join(decoderRoot, 'LICENSE'), join(outputDirectory, 'wechat-silk-license.txt')],
    [ffmpegLicense, join(outputDirectory, 'ffmpeg-license.txt')]
  ]) {
    copyFileSync(source, target);
  }
  chmodSync(join(outputDirectory, decoderName), 0o755);
  chmodSync(join(outputDirectory, 'ffmpeg'), 0o755);
}
