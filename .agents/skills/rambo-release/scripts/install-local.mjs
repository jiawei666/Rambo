#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Rambo 本机安装只能在 macOS 上执行');

const root = resolve(process.cwd());
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const expectedVersion = String(packageJson.version || '').trim();
const sourceApp = join(root, 'dist', 'mac-arm64', 'Rambo.app');
const installDirectory = process.env.RAMBO_INSTALL_DIR
  ? resolve(process.env.RAMBO_INSTALL_DIR)
  : '/Applications';
const targetApp = join(installDirectory, 'Rambo.app');
const bundleId = 'local.rambo.desktop';
const helper = '/usr/bin/osascript';

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
  throw new Error(`package.json version 不是有效的 semver：${expectedVersion}`);
}
if (!existsSync(sourceApp)) throw new Error(`找不到构建产物：${sourceApp}`);

console.log('[rambo-release] 核验待安装应用');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', sourceApp], {
  cwd: root,
  stdio: 'inherit'
});
const sourceVersion = execFileSync('/usr/bin/plutil', [
  '-extract', 'CFBundleShortVersionString', 'raw', join(sourceApp, 'Contents', 'Info.plist')
], { encoding: 'utf8' }).trim();
const sourceBundleId = execFileSync('/usr/bin/plutil', [
  '-extract', 'CFBundleIdentifier', 'raw', join(sourceApp, 'Contents', 'Info.plist')
], { encoding: 'utf8' }).trim();
if (sourceVersion !== expectedVersion) {
  throw new Error(`构建产物版本 ${sourceVersion} 与 package.json 的 ${expectedVersion} 不一致`);
}
if (sourceBundleId !== bundleId) {
  throw new Error(`构建产物 Bundle ID ${sourceBundleId} 与预期 ${bundleId} 不一致`);
}

console.log('[rambo-release] 正常退出正在运行的 Rambo');
try {
  execFileSync(helper, ['-e', `tell application id "${bundleId}" to quit`], {
    cwd: root,
    stdio: 'ignore',
    timeout: 15_000
  });
  execFileSync('/usr/bin/pgrep', ['-x', 'Rambo'], {
    cwd: root,
    stdio: 'ignore',
    timeout: 15_000
  });
  execFileSync('/bin/sh', [
    '-c',
    'for attempt in {1..50}; do /usr/bin/pgrep -x Rambo >/dev/null || exit 0; sleep 0.2; done; exit 1'
  ], { cwd: root, stdio: 'ignore', timeout: 15_000 });
} catch {
  // No installed/running instance needs no shutdown; a running instance that
  // cannot quit is checked again below and fails before replacing the bundle.
}

const stillRunning = (() => {
  try {
    execFileSync('/usr/bin/pgrep', ['-x', 'Rambo'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
if (stillRunning) {
  throw new Error('Rambo 仍在运行，未替换 /Applications 中的应用。请正常退出后重试。');
}

await mkdir(installDirectory, { recursive: true });
console.log(`[rambo-release] 安装 Rambo ${expectedVersion} 到 ${targetApp}`);
await rm(targetApp, { recursive: true, force: true });
execFileSync('/usr/bin/ditto', [sourceApp, targetApp], { cwd: root, stdio: 'inherit' });
execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', targetApp], {
  cwd: root,
  stdio: 'inherit'
});

console.log('[rambo-release] 复核本机安装');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', targetApp], {
  cwd: root,
  stdio: 'inherit'
});
const installedVersion = execFileSync('/usr/bin/plutil', [
  '-extract', 'CFBundleShortVersionString', 'raw', join(targetApp, 'Contents', 'Info.plist')
], { encoding: 'utf8' }).trim();
if (installedVersion !== expectedVersion) {
  throw new Error(`已安装版本 ${installedVersion} 与预期 ${expectedVersion} 不一致`);
}

console.log(JSON.stringify({ installedVersion, targetApp }, null, 2));
