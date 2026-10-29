import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { cleanupRunProcesses } from './fixtures/electron-app.mjs';

const root = resolve(import.meta.dirname, '../..');

function codexChildren(pid) {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(match => match && Number(match[2]) === pid &&
      /\/bin\/(?:codex-app-server|codex app-server) --listen stdio:\/\//.test(match[3]))
    .map(match => ({ pid: Number(match[1]), command: match[3] }));
}

function processEnvironment(pid) {
  const output = execFileSync('/bin/ps', ['eww', '-p', String(pid)], { encoding: 'utf8' });
  return Object.fromEntries(output.split(/\s+/u)
    .map(value => value.match(/^([^=]+)=(.*)$/u))
    .filter(Boolean)
    .map(match => [match[1], match[2]]));
}

function removeAcceptanceRun(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function writeUnavailableRuntime(home) {
  const runtime = join(home, '.codex/packages/app-server-daemon/releases/0.164.0');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  mkdirSync(join(runtime, 'codex-path'), { recursive: true });
  writeFileSync(join(runtime, 'bin/codex-app-server'), '#!/bin/sh\nexit 78\n', { mode: 0o755 });
  writeFileSync(join(runtime, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version: '0.164.0',
    target: 'aarch64-apple-darwin',
    variant: 'codex-app-server',
    entrypoint: 'bin/codex-app-server',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path'
  }));
}

function writeDownloadableRuntimePackage(root, version = '0.165.0') {
  const binary = join(root, 'bin/codex-app-server');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'codex-path'), { recursive: true });
  writeFileSync(binary, `#!/usr/bin/env node
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let loginStartedAt = 0;
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  let result = {};
  if (message.method === 'initialize') {
    result = { userAgent: 'codex_cli_rs/${version}', platformFamily: 'unix', platformOs: 'macos' };
  } else if (message.method === 'account/read') {
    result = loginStartedAt && Date.now() - loginStartedAt > 1200
      ? { account: { type: 'chatgpt', email: 'clean-user@example.com' } }
      : { account: null };
  } else if (message.method === 'account/login/start') {
    loginStartedAt = Date.now();
    result = {
      type: 'chatgpt',
      loginId: 'clean-user-login',
      authUrl: 'https://example.com/rambo-clean-user-login'
    };
  } else if (message.method === 'config/read') {
    result = { config: { model: null, mcp_servers: {}, features: { apps: false, plugins: false } } };
  } else if (message.method === 'model/list') {
    result = {
      data: [{ id: 'gpt-5', model: 'gpt-5', displayName: 'GPT-5', isDefault: true }],
      nextCursor: null
    };
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
  writeFileSync(join(root, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version,
    target: 'aarch64-apple-darwin',
    variant: 'codex-app-server',
    entrypoint: 'bin/codex-app-server',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path'
  }));
  writeFileSync(join(root, 'rambo-runtime.json'), JSON.stringify({
    version,
    updateChannel: 'manual',
    sessionSource: 'app-server'
  }));
  writeFileSync(join(root, 'payload.bin'), randomBytes(128 * 1024));
}

test('Rambo 使用独立运行时、复制本机 Codex 配置并可重启', async () => {
  test.setTimeout(120_000);
  mkdirSync(join(root, 'acceptance-runs'), { recursive: true });
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'native-startup-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  const isolatedHome = join(run, 'home');
  mkdirSync(profile);
  mkdirSync(isolatedHome);
  writeDownloadableRuntimePackage(join(profile, 'runtime/codex/0.165.0'));
  const nativeHome = join(isolatedHome, '.codex');
  mkdirSync(join(nativeHome, 'skills'), { recursive: true });
  mkdirSync(join(nativeHome, 'sessions'), { recursive: true });
  writeFileSync(join(nativeHome, 'config.toml'), 'model="fixture-model"');
  writeFileSync(join(nativeHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
  writeFileSync(join(nativeHome, 'AGENTS.md'), '# native instructions');
  writeFileSync(join(nativeHome, 'skills', 'native.md'), 'native skill');
  writeFileSync(join(nativeHome, 'state_5.sqlite'), 'native state');
  writeFileSync(join(run, 'run.json'), JSON.stringify({ schema: 'rambo.acceptance.run.v1', runId, project: root }));
  const env = {
    ...process.env,
    RAMBO_ACCEPTANCE_RUN: run,
    HOME: isolatedHome,
    CODEX_HOME: nativeHome
  };
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await expect(page.locator('[data-sidebar-action="create"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('创建 Bot')).toBeVisible();
    await expect(page.getByLabel('配置 Codex')).toHaveCount(0);
    await page.getByRole('button', { name: '收起侧栏' }).click();
    await expect(page.locator('[data-sidebar-action="create"]')).toBeVisible();
    await page.getByRole('button', { name: '展开侧栏' }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '账号', exact: true }).click();
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接', { timeout: 30_000 });
    await expect(page.locator('.current-source-card')).toContainText(
      /检测到本机登录态|fixture@example.com/,
      { timeout: 30_000 }
    );
    expect(lstatSync(join(profile, 'codex-home/auth.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(profile, 'codex-home/auth.json'), 'utf8')).toBe('{"auth_mode":"chatgpt"}');
    expect(readFileSync(join(profile, 'codex-home/config.toml'), 'utf8')).toBe('model="fixture-model"');
    expect(existsSync(join(profile, 'codex-home/state_5.sqlite'))).toBe(false);
    expect(existsSync(join(profile, 'codex-home/sessions/native-history'))).toBe(false);
    await expect(page.locator('.runtime-home-row')).toContainText(join(profile, 'codex-home'));
    await expect(page.locator('.runtime-home-row').locator('input, textarea, button')).toHaveCount(0);
    await expect(page.locator('.configuration-mode-section')).toContainText('已检测到本机 Codex');
    await expect(page.getByRole('radio', { name: /持续跟随本机/ })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: /独立配置/ }).click();
    await expect(page.getByRole('radio', { name: /独立配置/ })).toHaveAttribute('aria-checked', 'true');
    writeFileSync(join(nativeHome, 'config.toml'), 'model="native-independent-change"');
    await page.waitForTimeout(1_000);
    expect(readFileSync(join(profile, 'codex-home/config.toml'), 'utf8')).toBe('model="fixture-model"');
    await page.getByRole('radio', { name: /持续跟随本机/ }).click();
    await expect(page.getByRole('radio', { name: /持续跟随本机/ })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => readFileSync(join(profile, 'codex-home/config.toml'), 'utf8'))
      .toBe('model="native-independent-change"');
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接', { timeout: 30_000 });
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
    const homeBox = await page.locator('.runtime-home-row').boundingBox();
    expect(homeBox.y).toBeGreaterThan(connectedBox.y + connectedBox.height);
    const proxyInput = page.getByLabel('代理地址');
    await expect(proxyInput).toHaveAttribute('placeholder', 'http://127.0.0.1:10808');
    await expect(proxyInput).toHaveValue('');
    const children = codexChildren(app.process().pid);
    expect(children).toHaveLength(1);
    expect(children[0].command).toContain(join(profile, 'runtime/codex/0.165.0/bin/codex-app-server'));
    expect(children[0].command).toContain('--session-source app-server');
    const configuredProxy = 'http://127.0.0.1:9/';
    await expect(page.getByRole('button', { name: '保存代理', exact: true })).toHaveCount(0);
    await proxyInput.fill(configuredProxy);
    await expect(page.locator('.runtime-proxy-actions').getByRole('status'))
      .toContainText('已自动保存', { timeout: 30_000 });
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接');
    await expect.poll(async () => (await page.evaluate(() => window.rambo.snapshot())).runtimeProxy)
      .toBe(configuredProxy);
    const proxied = codexChildren(app.process().pid);
    expect(proxied).toHaveLength(1);
    expect(proxied[0].pid).not.toBe(children[0].pid);
    const proxiedEnv = processEnvironment(proxied[0].pid);
    expect(proxiedEnv.HTTPS_PROXY).toBe(configuredProxy);
    expect(proxiedEnv.HTTP_PROXY).toBe(configuredProxy);
    expect(proxiedEnv.ALL_PROXY).toBe(configuredProxy);
    expect(proxiedEnv.NO_PROXY).toBe('127.0.0.1,localhost');
    await restart.click();
    await expect(page.getByText('已请求重启 Codex。', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接');
    const restarted = codexChildren(app.process().pid);
    expect(restarted).toHaveLength(1);
    expect(restarted[0].pid).not.toBe(proxied[0].pid);
    expect(processEnvironment(restarted[0].pid).HTTPS_PROXY).toBe(configuredProxy);
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '账号', exact: true }).click();
    await expect(page.getByLabel('代理地址')).toHaveValue(configuredProxy);
  } finally {
    try {
      if (app) await app.close();
    } finally {
      cleanupRunProcesses(run);
      removeAcceptanceRun(run);
    }
  }
});

test('ChatGPT 登录返回可重开地址并自动刷新账号状态', async () => {
  test.setTimeout(90_000);
  mkdirSync(join(root, 'acceptance-runs'), { recursive: true });
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'login-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  const isolatedHome = join(run, 'home');
  mkdirSync(profile);
  mkdirSync(isolatedHome);
  writeDownloadableRuntimePackage(join(profile, 'runtime/codex/0.165.0'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));
  const env = {
    ...process.env,
    RAMBO_ACCEPTANCE_RUN: run,
    HOME: isolatedHome,
    CODEX_HOME: join(isolatedHome, '.codex')
  };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  let app;
  try {
    app = await electron.launch({
      executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '系统设置', exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '登录 ChatGPT', exact: true })).toBeVisible();

    await page.getByRole('button', { name: '登录 ChatGPT', exact: true }).click();
    const retryLink = page.getByRole('link', { name: '重新打开登录页面', exact: true });
    await expect(retryLink).toBeVisible({ timeout: 15_000 });
    await expect(retryLink).toHaveAttribute(
      'href',
      'https://example.com/rambo-clean-user-login'
    );
    await expect(page.getByRole('button', { name: '等待授权…', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() =>
      window.rambo.snapshot().then(value => value.modelSource.kind)
    )).toBe('chatgpt');

    await expect(page.locator('.current-source-card')).toHaveAttribute('data-source', 'chatgpt', {
      timeout: 30_000
    });
    await expect(page.locator('.current-source-card')).toContainText('clean-user@example.com');
    await expect(page.getByText('ChatGPT 登录已完成，账号已连接。', { exact: true })).toBeVisible();
    await expect(retryLink).toHaveCount(0);
    await expect(page.locator('[data-sidebar-action="create"]')).toBeVisible();
  } finally {
    try {
      if (app) await app.close();
    } finally {
      cleanupRunProcesses(run);
      removeAcceptanceRun(run);
    }
  }
});

test('未配置运行时首次启动自动打开账号设置且关闭后不重复弹出', async () => {
  test.setTimeout(60_000);
  mkdirSync(join(root, 'acceptance-runs'), { recursive: true });
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'first-run-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  const isolatedHome = join(run, 'home');
  mkdirSync(profile);
  writeUnavailableRuntime(isolatedHome);
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));
  const env = {
    ...process.env,
    RAMBO_ACCEPTANCE_RUN: run,
    HOME: isolatedHome,
    CODEX_HOME: join(isolatedHome, '.codex')
  };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({
      executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '系统设置', exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('tab', { name: '账号', exact: true }))
      .toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Codex 运行时', exact: true })).toBeVisible();
    await expect(page.locator('[data-sidebar-action="configure"]')).toBeVisible();
    await expect(page.getByLabel('配置 Codex')).toBeVisible();
    await expect(page.getByLabel('创建 Bot')).toHaveCount(0);

    await page.getByRole('button', { name: '返回聊天' }).click();
    await expect(page.getByRole('heading', { name: '系统设置', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('配置 Codex')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('创建 Bot')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '系统设置', exact: true })).toHaveCount(0);
    await page.getByLabel('配置 Codex').click();
    await expect(page.getByRole('heading', { name: '系统设置', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '账号', exact: true }))
      .toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Codex 运行时', exact: true })).toBeVisible();
  } finally {
    try {
      if (app) await app.close();
    } finally {
      cleanupRunProcesses(run);
      removeAcceptanceRun(run);
    }
  }
});

test('全新用户直接使用内置 App Server，并可通过独立按钮更新', async () => {
  test.setTimeout(120_000);
  mkdirSync(join(root, 'acceptance-runs'), { recursive: true });
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'clean-user-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  const isolatedHome = join(run, 'home');
  const packagedResourceRoot = join(run, 'packaged-resource');
  const updatePackageRoot = join(run, 'update-package');
  const archivePath = join(run, 'runtime-0.166.0.tar.gz');
  mkdirSync(profile);
  mkdirSync(isolatedHome);
  writeDownloadableRuntimePackage(
    join(packagedResourceRoot, 'runtime/codex/0.165.0'),
    '0.165.0'
  );
  writeDownloadableRuntimePackage(updatePackageRoot, '0.166.0');
  execFileSync('tar', ['-czf', archivePath, '-C', updatePackageRoot, '.']);
  const archive = readFileSync(archivePath);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  let responseRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.url === '/v1/responses' && request.method === 'POST') {
      responseRequestCount += 1;
      const reply = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `resp_clean_user_${responseRequestCount}`, output_text: 'OK' }));
      };
      if (responseRequestCount > 1) setTimeout(reply, 350);
      else reply();
      return;
    }
    if (request.url !== '/runtime-0.166.0.tar.gz') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': archive.length
    });
    const chunkSize = Math.max(1024, Math.ceil(archive.length / 64));
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= archive.length) {
        clearInterval(timer);
        response.end();
        return;
      }
      const next = Math.min(archive.length, offset + chunkSize);
      response.write(archive.subarray(offset, next));
      offset = next;
    }, 60);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('下载夹具未取得监听端口');
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));
  const env = {
    ...process.env,
    RAMBO_ACCEPTANCE_RUN: run,
    HOME: isolatedHome,
    CODEX_HOME: join(isolatedHome, '.codex'),
    RAMBO_ACCEPTANCE_PACKAGED_RUNTIME_ROOT: packagedResourceRoot,
    RAMBO_ACCEPTANCE_RUNTIME_UPDATE_VERSION: '0.166.0',
    RAMBO_ACCEPTANCE_RUNTIME_UPDATE_URL: `http://127.0.0.1:${address.port}/runtime-0.166.0.tar.gz`,
    RAMBO_ACCEPTANCE_RUNTIME_UPDATE_SHA256: archiveSha256
  };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  let app;
  try {
    app = await electron.launch({
      executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '系统设置', exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('tab', { name: '账号', exact: true }))
      .toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Codex 运行时', exact: true })).toBeVisible();
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接', { timeout: 30_000 });
    await expect(page.locator('.runtime-version')).toContainText('0.165.0 · 内置');
    await expect(page.getByRole('progressbar', { name: 'App Server 更新进度' })).toHaveCount(0);

    await page.getByRole('button', { name: '更新 App Server', exact: true }).click();
    const progress = page.getByRole('progressbar', { name: 'App Server 更新进度' });
    await expect(progress).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow')))
      .toBeGreaterThan(0);
    await expect(progress.locator('.runtime-progress-fill'))
      .toHaveCSS('transition-duration', '0.18s');
    await expect(page.locator('.runtime-download-progress')).toContainText('正在更新 App Server');
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接', { timeout: 30_000 });
    await expect(progress).toHaveCount(0);
    await expect(page.locator('.runtime-version')).toContainText('0.166.0 · 单独更新');
    await expect(page.getByText('App Server 已从 0.165.0 更新到 0.166.0。', { exact: true }))
      .toBeVisible();
    await expect(page.locator('[data-sidebar-action="configure"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('配置 Codex')).toBeVisible();
    await expect(page.getByLabel('创建 Bot')).toHaveCount(0);
    await page.getByRole('button', { name: '收起侧栏' }).click();
    await expect(page.locator('[data-sidebar-action="configure"]')).toBeVisible();
    await page.getByRole('button', { name: '展开侧栏' }).click();
    await expect(page.getByText('欢迎使用 Rambo', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '完成首次设置', exact: true })).toHaveCount(0);

    await expect(page.getByRole('heading', { name: '当前配置模式', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: /持续跟随本机/ })).toBeDisabled();
    await expect(page.getByRole('radio', { name: /独立配置/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('heading', { name: '选择配置方式', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录 ChatGPT', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '配置 API', exact: true }).click();
    await expect(page.getByRole('heading', { name: '手动 API 配置', exact: true })).toBeVisible();

    const snapshot = await page.evaluate(() => window.rambo.snapshot());
    expect(snapshot.runtime.status).toBe('ready');
    expect(snapshot.runtime.version).toBe('0.166.0');
    expect(snapshot.runtime.source).toBe('cache');
    expect(snapshot.runtime.progress).toBeNull();
    expect(snapshot.settings.initialSetupPrompted).toBe('true');
    expect(snapshot.bots).toHaveLength(0);
    expect(existsSync(join(profile, 'runtime/codex/0.166.0/codex-package.json'))).toBe(true);
    expect(codexChildren(app.process().pid)[0].command)
      .toContain(join(profile, 'runtime/codex/0.166.0/bin/codex-app-server'));
    expect(codexChildren(app.process().pid)).toHaveLength(1);

    const secret = 'sk-clean-user-fixture-secret';
    await page.getByLabel('服务名称').fill('Clean User API');
    await page.getByLabel('Base URL').fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel('模型 ID').fill('clean-user-model');
    await page.getByLabel('API Key').fill(secret);
    await page.getByRole('button', { name: '保存并使用', exact: true }).click();
    await expect(page.getByRole('heading', { name: '手动 API 配置', exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.rambo.snapshot().then(value => value.modelSource.kind)))
      .toBe('manualApi');
    await expect(page.locator('.current-source-card')).toHaveAttribute('data-source', 'manualApi');
    await expect(page.locator('.sidebar-onboarding')).toBeVisible();
    await expect(page.locator('[data-sidebar-action="create"]')).toBeVisible();
    await expect(page.locator('[data-topbar-action="create"]')).toHaveCount(0);
    const connectionTestButton = page.getByRole('button', { name: '测试连接', exact: true });
    const connectionTestResult = page.getByRole('status').filter({ hasText: '连接可用 · 首响应' });
    await connectionTestButton.click();
    await expect(connectionTestResult).toBeVisible({ timeout: 30_000 });
    const sourceCardHeight = await page.locator('.current-source-card').evaluate(element =>
      element.getBoundingClientRect().height
    );
    const connectionTestButtonWidth = await connectionTestButton.evaluate(element =>
      element.getBoundingClientRect().width
    );
    await connectionTestButton.click();
    await expect(connectionTestButton).toHaveAttribute('aria-busy', 'true');
    await expect(connectionTestButton).toHaveAccessibleName('测试连接');
    await expect(connectionTestResult).toBeVisible();
    await expect.poll(() => connectionTestButton.evaluate(element =>
      element.getBoundingClientRect().width
    )).toBe(connectionTestButtonWidth);
    await expect.poll(() => page.locator('.current-source-card').evaluate(element =>
      element.getBoundingClientRect().height
    )).toBe(sourceCardHeight);
    await expect(connectionTestButton).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
    await expect(connectionTestResult).toBeVisible();

    const runtimeConfigPath = join(profile, 'codex-home', 'config.toml');
    await expect.poll(() => {
      try { return readFileSync(runtimeConfigPath, 'utf8'); }
      catch { return ''; }
    }).toContain('model_provider = "rambo_manual"');
    const manualConfig = readFileSync(runtimeConfigPath, 'utf8');
    expect(manualConfig).toContain('model = "clean-user-model"');
    expect(manualConfig).not.toContain(secret);
    expect(existsSync(`${runtimeConfigPath}.rambo-base`)).toBe(false);
    expect(existsSync(`${runtimeConfigPath}.rambo-base-missing`)).toBe(true);

    await page.getByRole('button', { name: '更换配置', exact: true }).click();
    await expect(page.getByRole('radio', { name: /本机 Codex 配置副本/ })).toBeDisabled();
    await expect(page.getByRole('radio', { name: /ChatGPT 登录/ })).toBeDisabled();
    await expect(page.getByRole('radio', { name: /手动配置 API/ })).toHaveAttribute('aria-checked', 'true');
  } finally {
    try {
      if (app) await app.close();
    } finally {
      cleanupRunProcesses(run);
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      removeAcceptanceRun(run);
    }
  }
});
