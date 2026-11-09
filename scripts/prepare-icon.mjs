import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { currentBuildTarget } from './platform-target.mjs';
import { resolveFfmpegBinary } from './prepare-ffmpeg.mjs';

const source = resolve('assets/branding/app-logo-source.png');
const roundedSource = resolve('assets/branding/app-logo-rounded.png');
const target = currentBuildTarget();
const ffmpeg = (await resolveFfmpegBinary(target)).binary;
const radius = '0.205*min(W,H)';
const roundedMaskFilter = `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(${radius}+0.5-sqrt(pow(max(max(${radius}-X,0),X-(W-${radius})),2)+pow(max(max(${radius}-Y,0),Y-(H-${radius})),2)),0,1)*255'`;

execFileSync(ffmpeg, [
  '-y',
  '-i', source,
  '-vf', roundedMaskFilter,
  '-frames:v', '1',
  '-update', '1',
  roundedSource
], { stdio: 'ignore', windowsHide: true });

execFileSync(ffmpeg, [
  '-y',
  '-i', roundedSource,
  '-vf', 'scale=256:256:flags=lanczos',
  '-frames:v', '1',
  '-f', 'ico',
  resolve('assets/branding/app.ico')
], { stdio: 'ignore', windowsHide: true });
console.log('已由圆角品牌图生成 Windows ICO 图标');

if (process.platform !== 'darwin') process.exit(0);

const temporary = await mkdtemp(join(tmpdir(), 'rambo-icon-'));
try {
  const set = join(temporary, 'Rambo.iconset');
  await mkdir(set);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), roundedSource, '--out', join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', resolve('assets/branding/app.icns')]);
  console.log('已由圆角品牌图生成 macOS 图标尺寸集');
} finally { await rm(temporary, { recursive: true, force: true }); }
