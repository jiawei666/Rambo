import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { currentBuildTarget } from './platform-target.mjs';
import { resolveFfmpegBinary } from './prepare-ffmpeg.mjs';

const source = resolve('assets/branding/app-logo-source.png');
const target = currentBuildTarget();
const ffmpeg = (await resolveFfmpegBinary(target)).binary;

execFileSync(ffmpeg, [
  '-y',
  '-i', source,
  '-vf', 'scale=256:256:flags=lanczos',
  '-frames:v', '1',
  '-f', 'ico',
  resolve('assets/branding/app.ico')
], { stdio: 'ignore', windowsHide: true });
console.log('已由指定原图生成 Windows ICO 图标');

if (process.platform !== 'darwin') process.exit(0);

const temporary = await mkdtemp(join(tmpdir(), 'rambo-icon-'));
try {
  const set = join(temporary, 'Rambo.iconset');
  await mkdir(set);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), source, '--out', join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', resolve('assets/branding/app.icns')]);
  console.log('已由指定原图生成 macOS 图标尺寸集（无重绘或裁剪）');
} finally { await rm(temporary, { recursive: true, force: true }); }
