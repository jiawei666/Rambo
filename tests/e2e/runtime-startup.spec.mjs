import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

function codexChildren(pid) {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(match => match && Number(match[2]) === pid && /\/bin\/codex app-server --listen stdio:\/\//.test(match[3]))
    .map(match => ({ pid: Number(match[1]), command: match[3] }));
}

test('Rambo 用本机同一 Codex 二进制启动、读取共享登录态并可重启', async () => {
  test.setTimeout(90_000);
  mkdirSync(join(root, 'acceptance-runs'), { recursive: true });
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'native-startup-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  writeFileSync(join(run, 'run.json'), JSON.stringify({ schema: 'rambo.acceptance.run.v1', runId, project: root }));
  const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '常规', exact: true }).click();
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接', { timeout: 30_000 });
    await expect(page.locator('.account-copy')).toContainText('登录方式：chatgpt', { timeout: 30_000 });
    const native = process.env.CODEX_HOME || join(homedir(), '.codex');
    expect(readlinkSync(join(profile, 'codex-home/auth.json'))).toBe(join(native, 'auth.json'));
    await expect(page.getByLabel('Codex Home')).toContainText(join(profile, 'codex-home'));
    await expect(page.getByLabel('Codex Home').locator('input, textarea, button')).toHaveCount(0);
    const restart = page.getByRole('button', { name: '重启运行时', exact: true });
    const connected = page.locator('.runtime-card-status');
    const [restartBox, connectedBox] = await Promise.all([
      restart.boundingBox(),
      connected.getByText('Codex 已连接', { exact: true }).boundingBox()
    ]);
    expect(restartBox).not.toBeNull();
    expect(connectedBox).not.toBeNull();
    expect(restartBox.x).toBeGreaterThan(connectedBox.x);
    expect(Math.abs(
      (restartBox.y + restartBox.height / 2) - (connectedBox.y + connectedBox.height / 2)
    )).toBeLessThanOrEqual(1);
    const homeBox = await page.getByLabel('Codex Home').boundingBox();
    expect(homeBox.y).toBeGreaterThan(connectedBox.y + connectedBox.height);
    const children = codexChildren(app.process().pid);
    expect(children).toHaveLength(1);
    expect(children[0].command).toContain(join(native, 'packages/app-server-daemon/releases/'));
    expect(children[0].command).not.toContain('--session-source');
    await restart.click();
    await expect(page.getByText('已请求重启 Codex。', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接');
    const restarted = codexChildren(app.process().pid);
    expect(restarted).toHaveLength(1);
    expect(restarted[0].pid).not.toBe(children[0].pid);
  } finally {
    if (app) await app.close();
    rmSync(run, { recursive: true, force: true });
  }
});
