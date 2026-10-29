import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  acquireElectronFixtureLease,
  cleanupRunProcesses
} from '../e2e/fixtures/electron-app.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const acceptanceRuns = join(root, 'acceptance-runs');

test('Electron 验收实例跨进程互斥，并在持有者释放后允许下一次运行', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-electron-lease-'));
  const owner = spawn(process.execPath, ['-e', [
    "import('./tests/e2e/fixtures/electron-app.mjs').then(({ acquireElectronFixtureLease }) => {",
    `  acquireElectronFixtureLease(${JSON.stringify(directory)});`,
    "  process.stdout.write('ready\\n');",
    "  process.stdin.resume();",
    '});'
  ].join('\n')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit']
  });
  try {
    await new Promise((resolve, reject) => {
      owner.stdout.once('data', resolve);
      owner.once('error', reject);
    });
    const lease = readFileSync(join(directory, '.electron-fixture-active'), 'utf8');
    assert.match(lease, new RegExp(`^${owner.pid}\\n`));
    assert.throws(
      () => acquireElectronFixtureLease(directory),
      new RegExp(`已有 Electron 验收实例正在使用桌面：${owner.pid}`)
    );
    owner.stdin.end();
    await new Promise(resolve => owner.once('exit', resolve));
    writeFileSync(join(directory, '.electron-fixture-active'), '999999\n2026-10-27T00:00:00.000Z\n');
    const releaseAgain = acquireElectronFixtureLease(directory);
    releaseAgain();
  } finally {
    owner.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Electron 验收实例锁可回收已退出进程留下的文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-electron-stale-lease-'));
  try {
    writeFileSync(join(directory, '.electron-fixture-active'), '999999\n2026-10-27T00:00:00.000Z\n');
    const release = acquireElectronFixtureLease(directory);
    assert.match(readFileSync(join(directory, '.electron-fixture-active'), 'utf8'), new RegExp(`^${process.pid}\\n`));
    release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('第二个 Playwright 命令在开窗前因验收锁而失败', () => {
  const lease = acquireElectronFixtureLease(acceptanceRuns);
  try {
    const result = spawnSync(process.execPath, ['-e', [
      "import('./playwright.config.mjs').then(() => process.exit(0), error => {",
      '  console.error(error.message);',
      '  process.exit(1);',
      '});'
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, RAMBO_ELECTRON_FIXTURE_LEASE: '' }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /已有 Electron 验收实例正在使用桌面/);
  } finally {
    lease();
  }
});

test('验收清理只结束指定 run 的残留进程', async () => {
  mkdirSync(acceptanceRuns, { recursive: true });
  const run = mkdtempSync(join(acceptanceRuns, 'cleanup-fixture-'));
  const targetScript = join(run, 'fixture-process.mjs');
  writeFileSync(targetScript, 'setInterval(() => {}, 1 << 30);\n');
  const target = spawn(process.execPath, ['fixture-process.mjs'], {
    cwd: run,
    detached: true,
    stdio: 'ignore'
  });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30);'], {
    cwd: root,
    detached: true,
    stdio: 'ignore'
  });
  target.unref();
  unrelated.unref();

  const targetExit = waitForChildExit(target);
  const unrelatedExit = waitForChildExit(unrelated);
  try {
    await delay(100);
    assert.equal(processAlive(target.pid), true);
    assert.equal(processAlive(unrelated.pid), true);

    cleanupRunProcesses(run);
    await targetExit;

    assert.equal(processAlive(target.pid), false);
    assert.equal(processAlive(unrelated.pid), true);
  } finally {
    target.kill('SIGKILL');
    unrelated.kill('SIGKILL');
    await Promise.all([targetExit, unrelatedExit]);
    rmSync(run, { recursive: true, force: true });
  }
});

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}
