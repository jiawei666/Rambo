import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const candidate = process.env.RAMBO_APP_PATH
  ? resolve(process.env.RAMBO_APP_PATH)
  : join(root, 'dist/mac-arm64/Rambo.app');

test('候选应用内置 Codex App Server，并在空配置下直接启动', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-packaged-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  const nativeHome = join(run, 'native-codex');
  mkdirSync(nativeHome);
  const packagedRuntime = join(candidate, 'Contents/Resources/runtime/codex/0.165.0');
  expect(existsSync(join(packagedRuntime, 'codex-package.json'))).toBe(true);
  expect(existsSync(join(packagedRuntime, 'bin/codex-app-server'))).toBe(true);
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  try {
    const env = {
      ...process.env,
      CODEX_HOME: nativeHome,
      RAMBO_ACCEPTANCE_RUN: run
    };
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
    await expect(page.getByRole('heading', { name: '系统设置', exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('tab', { name: '账号', exact: true }))
      .toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-sidebar-action="configure"]')).toBeVisible();
    await expect(page.getByLabel('创建 Bot')).toHaveCount(0);

    const appPid = app.process().pid;
    let runtimeSnapshot = null;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      runtimeSnapshot = await page.evaluate(() => window.rambo.snapshot().then(snapshot => snapshot.runtime));
      if (runtimeSnapshot.status === 'ready' || runtimeSnapshot.status === 'error') break;
      await page.waitForTimeout(100);
    }
    expect(runtimeSnapshot, JSON.stringify(runtimeSnapshot)).not.toBeNull();
    expect(runtimeSnapshot.status, JSON.stringify(runtimeSnapshot)).toBe('ready');
    expect(runtimeSnapshot.version).toBe('0.165.0');
    expect(runtimeSnapshot.source).toBe('packaged');
    await expect(page.locator('.runtime-version')).toContainText('0.165.0 · 内置');
    const processes = execFileSync('/bin/ps', ['-axo', 'ppid=,command='], { encoding: 'utf8' }).split('\n');
    const runtimeCommand = processes
      .map(line => line.trim().match(/^(\d+)\s+(.*)$/))
      .find(match => match?.[1] === String(appPid) &&
        match[2].includes('/bin/codex-app-server'))?.[2] ?? '';
    expect(runtimeCommand).toContain(join(packagedRuntime, 'bin/codex-app-server'));
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

test('候选应用点击 ChatGPT 登录后提供可重开地址', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-packaged-chatgpt-login-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  const nativeHome = join(run, 'native-codex');
  mkdirSync(profile);
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  try {
    const env = {
      ...process.env,
      CODEX_HOME: nativeHome,
      RAMBO_ACCEPTANCE_RUN: run
    };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: join(candidate, 'Contents/MacOS/Rambo'),
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '系统设置', exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '登录 ChatGPT', exact: true })).toBeVisible();

    await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).click();
    const retryLink = page.getByRole('link', { name: '重新打开登录页面', exact: true });
    await expect(retryLink).toBeVisible({ timeout: 30_000 });
    const loginUrl = await retryLink.getAttribute('href');
    expect(loginUrl).toBeTruthy();
    expect(new URL(loginUrl).protocol).toBe('https:');
    expect(new URL(loginUrl).host).toBe('auth.openai.com');
    await expect(page.getByRole('button', { name: '等待授权…', exact: true })).toBeDisabled();
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});
