import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const candidate = process.env.RAMBO_APP_PATH
  ? resolve(process.env.RAMBO_APP_PATH)
  : join(root, 'dist/mac-arm64/Rambo.app');

test('候选应用从包内启动并运行自己的 Codex App Server', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-packaged-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: join(candidate, 'Contents/MacOS/Rambo'),
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('Rambo');
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const paths = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      resourcesPath: process.resourcesPath
    }));
    expect(paths.userData).toBe(profile);
    expect(paths.resourcesPath).toBe(join(candidate, 'Contents/Resources'));
    await expect(page.getByLabel('创建 Bot')).toBeVisible();

    const appPid = app.process().pid;
    let runtimeCommand = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const processes = execFileSync(
        '/bin/ps',
        ['-axo', 'ppid=,command='],
        { encoding: 'utf8' }
      ).split('\n');
      runtimeCommand = processes
        .map(line => line.trim().match(/^(\d+)\s+(.*)$/))
        .find(match => match?.[1] === String(appPid) &&
          match[2].includes('/bin/codex-app-server'))?.[2] ?? '';
      if (runtimeCommand) break;
      await page.waitForTimeout(100);
    }
    expect(runtimeCommand).toContain(
      join(candidate, 'Contents/Resources/runtime/codex/0.163.0/bin/codex-app-server')
    );
    expect(runtimeCommand).toContain('--session-source app-server');
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('候选应用验收模式登录启动偏好可持久化', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-packaged-login-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  mkdirSync(join(run, 'chromium'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;

    app = await electron.launch({
      executablePath: join(candidate, 'Contents/MacOS/Rambo'),
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await page.getByLabel('设置', { exact: true }).click();
    const launchAtLogin = page.getByRole('checkbox', { name: '登录时启动' });
    await expect(launchAtLogin).toBeChecked();
    await launchAtLogin.uncheck();
    await expect(launchAtLogin).not.toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: '已关闭登录时启动' }))
      .toBeVisible();
    expect((await page.evaluate(() => window.rambo.snapshot())).settings.launchAtLogin)
      .toBe('false');

    await page.reload();
    await page.getByLabel('设置', { exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '登录时启动' })).not.toBeChecked();
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});
