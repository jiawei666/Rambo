import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const version = '0.165.0';
const sha256 = 'db80061560c75c440efe11d347f5bebcf78aa895b40e38ca47623d8a37b41cd7';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('当前已固定校验的运行时仅支持 macOS arm64');
const dest = resolve('runtime/codex', version);
const preparedManifest = (() => {
  try {
    return JSON.parse(readFileSync(join(dest, 'codex-package.json'), 'utf8'));
  } catch {
    return null;
  }
})();
if (
  preparedManifest?.version === version &&
  preparedManifest?.variant === 'codex-app-server' &&
  preparedManifest?.entrypoint === 'bin/codex-app-server' &&
  existsSync(join(dest, 'bin/codex-app-server'))
) {
  console.log(`运行时已准备：${dest}`);
  process.exit(0);
}
const temporary = await mkdtemp(join(tmpdir(), 'rambo-runtime-'));
try {
  let archive = `/tmp/rambo-app-server-package-${version}-aarch64-apple-darwin.tar.gz`;
  if (!existsSync(archive)) {
    archive = join(temporary, 'runtime.tar.gz');
    const response = await fetch(`https://github.com/openai/codex/releases/download/rust-v${version}/codex-app-server-package-aarch64-apple-darwin.tar.gz`);
    if (!response.ok || !response.body) throw new Error(`下载运行时失败：${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  if (digest.digest('hex') !== sha256) throw new Error('运行时归档 SHA-256 不匹配');
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  if (listing.some(p => p.startsWith('/') || p.split('/').includes('..'))) throw new Error('归档路径不安全');
  const extracted = join(temporary, 'extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  const manifest = JSON.parse(readFileSync(join(extracted, 'codex-package.json'), 'utf8'));
  if (
    manifest.version !== version ||
    manifest.variant !== 'codex-app-server' ||
    manifest.entrypoint !== 'bin/codex-app-server' ||
    !existsSync(join(extracted, 'bin/codex-app-server'))
  ) throw new Error('归档布局与固定版本不匹配');
  await mkdir(resolve('runtime/codex'), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(extracted, dest);
  await writeFile(join(dest, 'rambo-runtime.json'), JSON.stringify({ version, sha256, source: `openai/codex rust-v${version}`, sessionSource: 'app-server' }, null, 2));
  console.log(`已准备独立 App Server ${version}：${dest}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
