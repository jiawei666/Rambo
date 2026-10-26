import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const projectRoot = resolve(import.meta.dirname, '..');
const sourceApp = join(projectRoot, 'node_modules/electron/dist/Electron.app');
const appData = join(sourceApp, 'Contents/Info.plist');
if (!existsSync(sourceApp) || !existsSync(appData)) {
  throw new Error('找不到 Electron.app；请先安装项目依赖。');
}
if (!existsSync(join(projectRoot, 'out/main/wechat-worker.js'))) {
  throw new Error('缺少微信 Worker 构建产物；请先运行 npm run build。');
}

const runRoot = mkdtempSync(join(tmpdir(), 'rambo-wechat-live-'));
const diagnosticApp = join(runRoot, 'Rambo WeChat Live Diagnostic.app');
let child = null;

function cleanup() {
  try { rmSync(runRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
  catch { /* only remove the temporary app bundle created by this runner */ }
}

try {
  try {
    execFileSync('/bin/cp', ['-c', '-R', sourceApp, diagnosticApp], { stdio: 'ignore' });
  } catch {
    execFileSync('/bin/cp', ['-R', sourceApp, diagnosticApp], { stdio: 'ignore' });
  }
  const info = join(diagnosticApp, 'Contents/Info.plist');
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier local.rambo.wechat-live-diagnostic', info]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName RamboWechatLiveDiagnostic', info]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName Rambo 微信实时诊断', info]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', diagnosticApp], { stdio: 'ignore' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', diagnosticApp], { stdio: 'ignore' });

  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(join(diagnosticApp, 'Contents/MacOS/Electron'), [join(projectRoot, 'tests/manual/wechat-live')], {
    cwd: projectRoot,
    env,
    stdio: 'inherit'
  });
  child.once('error', error => {
    process.stderr.write(`独立诊断应用启动失败：${error.message}\n`);
    cleanup();
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    process.exitCode = signal ? 1 : code ?? 1;
  });
  process.once('SIGINT', () => child?.kill('SIGINT'));
  process.once('SIGTERM', () => child?.kill('SIGTERM'));
} catch (error) {
  cleanup();
  throw error;
}
