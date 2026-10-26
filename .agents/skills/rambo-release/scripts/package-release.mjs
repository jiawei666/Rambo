#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Rambo 发布包只能在 macOS 上构建');

const root = resolve(process.cwd());
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json version 不是有效的 semver：${version}`);
}

const outputDirectory = join(root, 'dist', 'release', `v${version}`);
const appPath = join(root, 'dist', 'mac-arm64', 'Rambo.app');
const zipName = `Rambo-v${version}-macOS-arm64.zip`;
const zipPath = join(outputDirectory, zipName);
const checksumPath = `${zipPath}.sha256`;

console.log(`[rambo-release] 构建 Rambo ${version}`);
execFileSync('npm', ['run', 'package:mac'], { cwd: root, stdio: 'inherit' });
if (!existsSync(appPath)) throw new Error(`构建成功但找不到应用：${appPath}`);

const appStat = await stat(appPath);
if (!appStat.isDirectory()) throw new Error(`应用路径不是目录：${appPath}`);

// Electron ships a linker ad-hoc signature that does not seal the renamed app.
// Re-seal with an ad-hoc signature: no Developer ID, no notarization, but a
// valid local bundle that macOS can launch when Gatekeeper is overridden.
console.log('[rambo-release] 重封本地 ad-hoc 签名（非 Developer ID）');
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
  cwd: root, stdio: 'inherit'
});
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
  cwd: root, stdio: 'inherit'
});
const signature = execFileSync('/bin/sh', ['-c', '/usr/bin/codesign -dv --verbose=4 "$1" 2>&1', 'sh', appPath], {
  cwd: root, encoding: 'utf8'
});
if (!/^Signature=adhoc$/m.test(signature) || /^Authority=/m.test(signature) || /^TeamIdentifier=(?!not set)/m.test(signature)) {
  throw new Error('发布产物不是预期的无证书 ad-hoc 签名');
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

console.log(`[rambo-release] 压缩 ${basename(appPath)}`);
execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], {
  cwd: dirname(appPath), stdio: 'inherit'
});

const buffer = await readFile(zipPath);
const digest = createHash('sha256').update(buffer).digest('hex');
await writeFile(checksumPath, `${digest}  ${zipName}\n`);

const zipStat = await stat(zipPath);
console.log(JSON.stringify({
  version,
  app: appPath,
  zip: zipPath,
  checksum: checksumPath,
  sha256: digest,
  bytes: zipStat.size
}, null, 2));
