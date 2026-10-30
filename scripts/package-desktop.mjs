import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertNativeBuildTarget,
  parseBuildTarget
} from './platform-target.mjs';

const require = createRequire(import.meta.url);
const electronBuilderCli = require.resolve('electron-builder/out/cli/cli.js');
const electronInstaller = require.resolve('electron/install.js');
const electronVitePackage = require.resolve('electron-vite/package.json');
const electronViteCli = resolve(dirname(electronVitePackage), 'bin/electron-vite.js');

const [requestedPlatform, requestedArch, requestedMode = 'dir'] = process.argv.slice(2);
const target = parseBuildTarget(
  requestedArch === 'host'
    ? `${requestedPlatform}-${process.arch}`
    : `${requestedPlatform}-${requestedArch}`
);
const mode = requestedMode === 'nsis' ? 'nsis' : 'dir';
if (target.platform === 'darwin' && mode !== 'dir') {
  throw new Error('当前 macOS 打包入口只生成 .app 目录；DMG/签名发布流程尚未接入。');
}
assertNativeBuildTarget(target, '桌面应用打包');

const env = {
  ...process.env,
  RAMBO_BUILD_TARGET: target.key,
  RAMBO_RUNTIME_TARGET: target.key
};

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve('.'),
    env: { ...env, ...extraEnv },
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`命令失败（退出码 ${result.status ?? 'unknown'}）：${command} ${args.join(' ')}`);
  }
}

if (!existsSync(resolve('node_modules/electron/dist'))) {
  console.log('未找到 Electron 分发目录，正在为当前原生平台下载安装');
  run(process.execPath, [electronInstaller]);
}

const plan = [
  [process.execPath, [resolve('scripts/prepare-icon.mjs')]],
  [process.execPath, [resolve('scripts/prepare-runtime.mjs')]],
  [process.execPath, [electronViteCli, 'build']],
  [process.execPath, [resolve('scripts/build-native-media.mjs'), '--copy']]
];

if (target.platform === 'darwin') {
  plan.push([
    process.execPath,
    [
      electronBuilderCli,
      '--mac',
      '--dir',
      `--${target.arch}`
    ]
  ]);
  plan.push([
    process.execPath,
    [resolve('scripts/sign-mac.mjs')],
    { RAMBO_APP_PATH: target.arch === 'arm64' ? 'dist/mac-arm64/Rambo.app' : 'dist/mac/Rambo.app' }
  ]);
} else {
  plan.push([
    process.execPath,
    [
      electronBuilderCli,
      '--win',
      mode === 'nsis' ? 'nsis' : '--dir',
      `--${target.arch}`
    ]
  ]);
}

if (process.env.RAMBO_PACKAGE_DRY_RUN === '1') {
  console.log(JSON.stringify({
    target: target.key,
    mode,
    commands: plan.map(([command, args]) => [command, args])
  }, null, 2));
  process.exit(0);
}

for (const [command, args, extraEnv] of plan) {
  run(command, args, extraEnv);
}

console.log(`桌面应用已打包：${target.key} (${mode})`);
