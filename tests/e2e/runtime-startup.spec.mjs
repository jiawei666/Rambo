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
const fs = require('node:fs');
const path = require('node:path');
const input = readline.createInterface({ input: process.stdin });
let loginStartedAt = 0;
let loginCompletionSent = false;
function loginStatePath() {
  return process.env.RAMBO_FIXTURE_LOGIN_STATE ||
    path.join(process.env.CODEX_HOME || '', 'fixture-login-state.txt');
}
function tomlString(value) {
  const raw = value.trim();
  try { return JSON.parse(raw); } catch {}
  const single = raw.match(/^'([^']*)'$/);
  return single ? single[1] : null;
}
function readStandardConfig() {
  const config = {
    model: null,
    model_provider: null,
    model_catalog_json: null,
    model_providers: {}
  };
  let section = '';
  try {
    const source = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    for (const rawLine of source.split(/\\r?\\n/)) {
      const line = rawLine.replace(/\\s+#.*$/, '').trim();
      if (!line) continue;
      const header = line.match(/^\\[([^\\]]+)\\]$/);
      if (header) {
        section = header[1].trim();
        continue;
      }
      const pair = line.match(/^([A-Za-z0-9_.-]+)\\s*=\\s*(.+)$/);
      if (!pair) continue;
      const [, key, rawValue] = pair;
      const value = tomlString(rawValue);
      if (!section && (
        key === 'model' ||
        key === 'model_provider' ||
        key === 'model_catalog_json'
      )) {
        config[key] = value;
        continue;
      }
      const provider = section.match(/^model_providers\\.([^.]+)(?:\\.([^.]+))?$/);
      if (!provider) continue;
      const [, providerId, child] = provider;
      config.model_providers[providerId] ??= {};
      if (child === 'auth') {
        config.model_providers[providerId].auth ??= {};
        config.model_providers[providerId].auth[key] = key === 'args'
          ? (rawValue.match(/"((?:\\\\.|[^"])*)"/g) ?? [])
              .map(item => tomlString(item))
              .filter(item => item !== null)
          : value;
      } else {
        config.model_providers[providerId][key] = value;
      }
    }
  } catch {}
  return config;
}
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  let result = {};
  if (message.method === 'initialize') {
    result = { userAgent: 'codex_cli_rs/${version}', platformFamily: 'unix', platformOs: 'macos' };
  } else if (message.method === 'account/read') {
    const loginComplete = fs.existsSync(loginStatePath()) ||
      (loginStartedAt && Date.now() - loginStartedAt > 5000);
    if (loginComplete) {
      fs.mkdirSync(path.dirname(loginStatePath()), { recursive: true });
      fs.writeFileSync(loginStatePath(), 'connected');
      if (loginStartedAt && !loginCompletionSent) {
        loginCompletionSent = true;
        process.stdout.write(JSON.stringify({
          method: 'account/login/completed',
          params: { loginId: 'clean-user-login' }
        }) + '\\n');
      }
      result = { account: { type: 'chatgpt', email: 'clean-user@example.com' } };
    } else {
      result = { account: null };
    }
  } else if (message.method === 'account/login/start') {
    loginStartedAt = Date.now();
    result = {
      type: 'chatgpt',
      loginId: 'clean-user-login',
      authUrl: 'https://example.com/rambo-clean-user-login'
    };
  } else if (message.method === 'config/read') {
    result = {
      config: {
        ...readStandardConfig(),
        mcp_servers: {},
        features: { apps: false, plugins: false }
      }
    };
  } else if (message.method === 'model/list') {
    const standardConfig = readStandardConfig();
    let configuredCatalog = null;
    if (standardConfig.model_catalog_json) {
      try {
        configuredCatalog = JSON.parse(fs.readFileSync(standardConfig.model_catalog_json, 'utf8'));
      } catch {}
    }
    if (Array.isArray(configuredCatalog?.models)) {
      result = {
        data: configuredCatalog.models
          .filter(model => typeof model.slug === 'string' && model.slug)
          .map(model => ({
            id: model.slug,
            model: model.slug,
            displayName: model.display_name || model.slug,
            isDefault: model.slug === standardConfig.model
          })),
        nextCursor: null
      };
    } else if (standardConfig.model_provider === 'external-provider') {
      result = {
        data: [{
          id: 'external-fixture-model',
          model: 'external-fixture-model',
          displayName: 'External Fixture Model',
          isDefault: true
        }],
        nextCursor: null
      };
    } else if (standardConfig.model_provider === 'openai') {
      result = {
        data: [{
          id: 'chatgpt-fixture-model',
          model: 'chatgpt-fixture-model',
          displayName: 'ChatGPT Fixture Model',
          isDefault: true
        }, {
          id: 'chatgpt-fixture-model-alt',
          model: 'chatgpt-fixture-model-alt',
          displayName: 'ChatGPT Fixture Model Alt',
          isDefault: false
        }],
        nextCursor: null
      };
    } else {
      const configuredModel = standardConfig.model;
      result = {
        data: [{
          id: configuredModel || 'gpt-5',
          model: configuredModel || 'gpt-5',
          displayName: configuredModel || 'GPT-5',
          isDefault: true
        }],
        nextCursor: null
      };
    }
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

test('Rambo 首次导入本机 Codex 配置并可重启独立运行时', async () => {
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
    await page.getByRole('tab', { name: '模型配置', exact: true }).click();
    await page.getByRole('tab', { name: '运行环境', exact: true }).click();
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接', { timeout: 30_000 });
    await page.getByRole('tab', { name: '模型服务', exact: true }).click();
    await expect(page.locator('.current-source-title strong')).toHaveText('Rambo 配置');
    await expect(page.locator('.current-source-details')).toContainText('接入方式');
    await expect(page.locator('.current-source-details')).toContainText('ChatGPT 登录');
    await expect(page.locator('.current-source-details')).not.toContainText(/已导入|Codex 配置已导入/);
    expect(lstatSync(join(profile, 'codex-home/auth.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(profile, 'codex-home/auth.json'), 'utf8')).toBe('{"auth_mode":"chatgpt"}');
    expect(readFileSync(join(profile, 'codex-home/config.toml'), 'utf8')).toBe('model="fixture-model"');
    expect(existsSync(join(profile, 'codex-home/state_5.sqlite'))).toBe(false);
    expect(existsSync(join(profile, 'codex-home/sessions/native-history'))).toBe(false);
    await expect(page.locator('.runtime-home-row')).toContainText(join(profile, 'codex-home'));
    await expect(page.locator('.runtime-home-row').locator('input, textarea, button')).toHaveCount(0);
    await expect(page.locator('.configuration-mode-section')).toHaveCount(0);
    await expect(page.getByText(/持续跟随本机/)).toHaveCount(0);
    await expect(page.locator('.current-source-card')).toHaveAttribute('data-source', 'local');
    await expect(page.locator('.current-source-title strong')).toHaveText('Rambo 配置');
    await expect(page.locator('.current-source-details')).not.toContainText(/已导入|Codex 配置已导入/);
    await expect(page.getByRole('button', { name: '更改', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '运行环境', exact: true }).click();
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
    const modelProxy = page.getByRole('checkbox', { name: '大模型', exact: true });
    const gmailProxy = page.getByRole('checkbox', { name: 'Gmail', exact: true });
    await expect(page.getByRole('button', { name: '保存代理', exact: true })).toHaveCount(0);
    await expect(modelProxy).not.toBeChecked();
    await expect(gmailProxy).not.toBeChecked();
    await proxyInput.fill(configuredProxy);
    await expect(page.locator('.runtime-proxy-actions').getByRole('status'))
      .toContainText('已自动保存', { timeout: 30_000 });
    await expect(page.locator('.runtime-card-status')).toContainText('Codex 已连接');
    await expect.poll(async () => (await page.evaluate(() => window.rambo.snapshot())).runtimeProxy)
      .toBe(configuredProxy);
    let scopedChildren = codexChildren(app.process().pid);
    expect(scopedChildren).toHaveLength(1);
    expect(scopedChildren[0].pid).toBe(children[0].pid);
    expect(processEnvironment(scopedChildren[0].pid).HTTPS_PROXY).not.toBe(configuredProxy);

    await gmailProxy.check();
    await expect(page.locator('.runtime-proxy-actions').getByRole('status'))
      .toContainText('已自动保存', { timeout: 30_000 });
    await expect.poll(async () => (await page.evaluate(() => window.rambo.snapshot())).runtimeProxyScopes)
      .toEqual(['gmail']);
    scopedChildren = codexChildren(app.process().pid);
    expect(scopedChildren).toHaveLength(1);
    expect(scopedChildren[0].pid).toBe(children[0].pid);
    expect(processEnvironment(scopedChildren[0].pid).HTTPS_PROXY).not.toBe(configuredProxy);

    await modelProxy.check();
    await expect(page.locator('.runtime-proxy-actions').getByRole('status'))
      .toContainText('已自动保存', { timeout: 30_000 });
    await expect.poll(async () => (await page.evaluate(() => window.rambo.snapshot())).runtimeProxyScopes)
      .toEqual(['model', 'gmail']);
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
    await page.getByRole('tab', { name: '模型配置', exact: true }).click();
    await page.getByRole('tab', { name: '运行环境', exact: true }).click();
    await expect(page.getByLabel('代理地址')).toHaveValue(configuredProxy);
    await expect(page.getByRole('checkbox', { name: '大模型', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Gmail', exact: true })).toBeChecked();
  } finally {
    try {
      if (app) await app.close();
    } finally {
      cleanupRunProcesses(run);
      removeAcceptanceRun(run);
    }
  }
});

test('Magpie 断开后的 Provider 配置在重启时同步模型目录', async () => {
  test.setTimeout(120_000);
  mkdirSync(join(root, 'acceptance-runs'), { recursive: true });
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'provider-catalog-restart-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  const isolatedHome = join(run, 'home');
  mkdirSync(profile);
  mkdirSync(isolatedHome);
  writeDownloadableRuntimePackage(join(profile, 'runtime/codex/0.165.0'));
  mkdirSync(join(profile, 'codex-home'), { recursive: true });
  const configPath = join(profile, 'codex-home/config.toml');
  const connectedConfig = [
    'model = "external-fixture-model"',
    'model_provider = "external-provider"',
    '',
    '[model_providers.external-provider]',
    'name = "External Provider"',
    'base_url = "http://127.0.0.1:4312/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    ''
  ].join('\n');
  writeFileSync(configPath, connectedConfig);
  writeFileSync(join(profile, 'codex-home/auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'fixture-only-token' }
  }));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1', runId, project: root
  }));
  const env = {
    ...process.env,
    RAMBO_ACCEPTANCE_RUN: run,
    HOME: isolatedHome,
    CODEX_HOME: join(isolatedHome, '.codex'),
    RAMBO_FIXTURE_LOGIN_STATE: join(profile, 'fixture-login-state.txt')
  };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const launch = () => electron.launch({
    executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [root, `--user-data-dir=${profile}`],
    cwd: root,
    env
  });
  let app;
  try {
    app = await launch();
    let page = await app.firstWindow();
    await expect(page.getByLabel('创建 Bot')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '模型配置', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '可用模型列表已更新为 1 个模型' }))
      .toBeVisible({ timeout: 30_000 });
    const modelSelect = page.getByLabel('新建 Bot 默认模型');
    await expect(modelSelect.locator('option[value="external-fixture-model"]')).toHaveCount(1);

    await page.getByRole('button', { name: '返回聊天' }).click();
    const botName = `Disconnected Provider ${Date.now()}`;
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill(botName);
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    const botBeforeRestart = await page.evaluate(name => window.rambo.snapshot().then(snapshot =>
      snapshot.bots.find(bot => bot.name === name)
    ), botName);
    expect(botBeforeRestart?.model).toBe('external-fixture-model');

    await app.close();
    app = null;
    writeFileSync(configPath, connectedConfig.replace(
      'model_provider = "external-provider"',
      'model_provider = "openai"'
    ));

    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByLabel('创建 Bot')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '模型配置', exact: true }).click();
    const restartedModelSelect = page.getByLabel('新建 Bot 默认模型');
    await expect(restartedModelSelect.locator('option[value="chatgpt-fixture-model"]'))
      .toHaveCount(1, { timeout: 30_000 });
    await expect(restartedModelSelect.locator('option[value="external-fixture-model"]'))
      .toHaveCount(0);
    await expect.poll(() => page.evaluate(name => window.rambo.snapshot().then(snapshot =>
      snapshot.bots.find(bot => bot.name === name)?.model
    ), botName), { timeout: 30_000 }).toBe('chatgpt-fixture-model');
  } finally {
    try {
      if (app) await app.close();
    } finally {
      cleanupRunProcesses(run);
      removeAcceptanceRun(run);
    }
  }
});

test('标准 Codex 外部 Provider 不经过专属状态即可生效并被 Rambo 保留', async () => {
  test.setTimeout(120_000);
  mkdirSync(join(root, 'acceptance-runs'), { recursive: true });
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'standard-provider-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  const isolatedHome = join(run, 'home');
  mkdirSync(profile);
  mkdirSync(isolatedHome);
  writeDownloadableRuntimePackage(join(profile, 'runtime/codex/0.165.0'));
  const tokenPath = join(run, 'external-provider-token');
  writeFileSync(tokenPath, 'external-provider-secret', { mode: 0o600 });
  const standardConfig = [
    '# external provider config',
    'model = "external-fixture-model"',
    'model_provider = "external-provider"',
    '',
    '[model_providers.external-provider]',
    'name = "External Provider"',
    'base_url = "http://127.0.0.1:4312/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[model_providers.external-provider.auth]',
    'command = "/bin/cat"',
    `args = [${JSON.stringify(tokenPath)}]`,
    'timeout_ms = 5000',
    'refresh_interval_ms = 0',
    '',
    '[projects."/tmp/external-provider-project"]',
    'trust_level = "trusted"',
    ''
  ].join('\n');
  mkdirSync(join(profile, 'codex-home'), { recursive: true });
  const configPath = join(profile, 'codex-home/config.toml');
  writeFileSync(configPath, standardConfig);
  writeFileSync(join(profile, 'magpie.json'), JSON.stringify({
    managedBy: 'magpie',
    baseURL: 'http://127.0.0.1:9/v1',
    apiKey: 'must-not-be-read',
    model: 'must-not-be-used'
  }));
  writeFileSync(join(run, 'run.json'), JSON.stringify({ schema: 'rambo.acceptance.run.v1', runId, project: root }));
  const env = {
    ...process.env,
    RAMBO_ACCEPTANCE_RUN: run,
    HOME: isolatedHome,
    CODEX_HOME: join(isolatedHome, '.codex'),
    RAMBO_FIXTURE_LOGIN_STATE: join(profile, 'fixture-login-state.txt')
  };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  let app;
  try {
    app = await electron.launch({
      executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await expect(page.getByLabel('创建 Bot')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '模型配置', exact: true }).click();

    const sourceCard = page.locator('.current-source-card[data-source="local"]');
    await expect(sourceCard).toBeVisible({ timeout: 30_000 });
    await expect(sourceCard).toContainText('Rambo 配置');
    await expect(sourceCard).toContainText('External Provider');
    await expect(sourceCard).toContainText('http://127.0.0.1:4312/v1');
    await expect(sourceCard).toContainText('已配置');
    await expect(sourceCard).not.toContainText(/Magpie|must-not-be-used|external-provider-secret/);
    await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '更改', exact: true })).toBeVisible();
    expect(readFileSync(configPath, 'utf8')).toBe(standardConfig);
    const updatedConfig = standardConfig.replace('External Provider', 'Updated External Provider');
    writeFileSync(configPath, updatedConfig);
    expect(readFileSync(configPath, 'utf8')).toBe(updatedConfig);

    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(sourceCard).toContainText('Updated External Provider');
    await expect(page.getByRole('status').filter({ hasText: '可用模型列表已更新为 1 个模型' }))
      .toBeVisible();
    expect(readFileSync(configPath, 'utf8')).toBe(updatedConfig);
    await expect(page.getByLabel('新建 Bot 默认模型')
      .locator('option[value="external-fixture-model"]')).toHaveCount(1);

    await page.getByRole('button', { name: '返回聊天' }).click();
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('External Provider Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('button', { name: '打开 External Provider Pilot 设置' }).click();
    await page.getByRole('tab', { name: '模型' }).click();
    const botModel = page.getByLabel('Bot 模型');
    await expect(botModel).toBeEnabled();
    await expect(botModel.locator('option[value="external-fixture-model"]')).toHaveCount(1);
    await page.getByRole('button', { name: /返回聊天/ }).click();
    await page.evaluate(() => {
      window.__voiceMicRequests = 0;
      const mediaDevices = navigator.mediaDevices;
      const original = mediaDevices.getUserMedia.bind(mediaDevices);
      mediaDevices.getUserMedia = (...args) => {
        window.__voiceMicRequests += 1;
        return original(...args);
      };
    });
    await page.getByRole('button', { name: '开始语音', exact: true }).click();
    await expect(page.locator('.current-bot-voice-error-title')).toHaveText('语音模型不支持');
    await expect(page.locator('.current-bot-voice-error-detail'))
      .toContainText('当前标准外部 Provider');
    expect(await page.evaluate(() => window.__voiceMicRequests)).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(updatedConfig);

    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '模型配置', exact: true }).click();
    await page.getByRole('button', { name: '更改', exact: true }).click();
    await page.getByRole('button', { name: '登录或切换 ChatGPT 账号', exact: true }).click();
    const loginLink = page.getByRole('link', { name: '重新打开登录页面', exact: true });
    await expect(loginLink).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.current-source-card')).toHaveAttribute('data-source', 'local');
    expect(readFileSync(configPath, 'utf8')).toBe(updatedConfig);
    await expect.poll(() => page.evaluate(() =>
      window.rambo.snapshot().then(value => value.modelSource.kind)
    ), { timeout: 30_000 }).toBe('chatgpt');
    await expect(page.locator('.current-source-card')).toHaveAttribute('data-source', 'chatgpt');
    expect(readFileSync(configPath, 'utf8')).toBe(
      updatedConfig.replace('model_provider = "external-provider"', 'model_provider = "openai"')
    );
    expect(readFileSync(configPath, 'utf8')).toContain('[model_providers.external-provider]');
    expect(readFileSync(configPath, 'utf8')).toContain('[projects."/tmp/external-provider-project"]');
    await expect(page.getByText(/模型来源由 Magpie 管理/u)).toHaveCount(0);
  } finally {
    try {
      if (app) await app.close();
    } finally {
      cleanupRunProcesses(run);
      removeAcceptanceRun(run);
    }
  }
});

test('外部 Provider 的 model_catalog_json 驱动刷新后的模型下拉', async () => {
  test.setTimeout(90_000);
  mkdirSync(join(root, 'acceptance-runs'), { recursive: true });
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'provider-catalog-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  const isolatedHome = join(run, 'home');
  mkdirSync(profile);
  mkdirSync(isolatedHome);
  writeDownloadableRuntimePackage(join(profile, 'runtime/codex/0.165.0'));
  const codexHome = join(profile, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  const catalogPath = join(codexHome, 'gateway-models.json');
  writeFileSync(catalogPath, JSON.stringify({
    models: [{
      slug: 'gateway/gpt-luna',
      display_name: 'GPT-6-Luna · Codex',
      description: 'Gateway Luna',
      visibility: 'list'
    }, {
      slug: 'workbuddy/deepseek-v4.1-flash',
      display_name: 'DeepSeek · WorkBuddy',
      description: 'Gateway DeepSeek',
      visibility: 'list'
    }, {
      slug: 'qoder/lmodel',
      display_name: 'QoDuck · Qoder',
      description: 'Gateway QoDuck',
      visibility: 'list'
    }]
  }, null, 2));
  const configPath = join(codexHome, 'config.toml');
  const externalConfig = [
    'model = "gateway/gpt-luna"',
    'model_provider = "magpie"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    '',
    '[model_providers.magpie]',
    'name = "Magpie"',
    'base_url = "http://127.0.0.1:4312/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[model_providers.magpie.auth]',
    'command = "/bin/cat"',
    `args = [${JSON.stringify(join(run, 'gateway-token'))}]`,
    'timeout_ms = 5000',
    'refresh_interval_ms = 0',
    '',
    '[projects."/tmp/provider-catalog"]',
    'trust_level = "trusted"',
    ''
  ].join('\n');
  writeFileSync(configPath, externalConfig);
  writeFileSync(join(run, 'gateway-token'), 'fixture-only-token', { mode: 0o600 });
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1', runId, project: root
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
    await expect(page.getByLabel('创建 Bot')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '模型配置', exact: true }).click();
    const refreshConfig = page.getByRole('button', { name: '刷新', exact: true });
    await expect(page.locator('.current-source-heading').getByRole('button', {
      name: '刷新',
      exact: true
    })).toHaveCount(1);
    await expect(page.locator('.current-source-model-control').getByRole('button', {
      name: '刷新',
      exact: true
    })).toHaveCount(0);
    await expect(page.locator('#model-config-panel-service')).toContainText(
      '刷新会重新读取配置文件、重启运行时并同步模型'
    );
    await refreshConfig.click();
    await expect(page.getByRole('status').filter({
      hasText: '可用模型列表已更新为 3 个模型'
    })).toBeVisible({ timeout: 30_000 });
    const modelSelect = page.getByLabel('新建 Bot 默认模型');
    await expect(modelSelect.locator('option')).toHaveCount(3);
    await expect(modelSelect.locator('option[value="gateway/gpt-luna"]'))
      .toContainText('GPT-6-Luna · Codex');
    await expect(modelSelect.locator('option[value="workbuddy/deepseek-v4.1-flash"]'))
      .toContainText('DeepSeek · WorkBuddy');
    await expect(modelSelect.locator('option[value="qoder/lmodel"]'))
      .toContainText('QoDuck · Qoder');
    expect(readFileSync(configPath, 'utf8')).toBe(externalConfig);
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
    await expect.poll(() => page.evaluate(() =>
      window.rambo.snapshot().then(value => value.runtime.status)
    ), { timeout: 30_000 }).toBe('ready');
    const loginButton = page.getByRole('button', { name: '登录 ChatGPT', exact: true });
    const retryLink = page.getByRole('link', { name: '重新打开登录页面', exact: true });
    if (!(await loginButton.isVisible().catch(() => false))) {
      const changeConfig = page.getByRole('button', { name: '更改', exact: true });
      const chatgptOption = page.getByRole('button', { name: '登录或切换 ChatGPT 账号', exact: true });
      if (!(await chatgptOption.isVisible().catch(() => false))) {
        await expect(changeConfig).toBeVisible();
        await changeConfig.click();
      }
      await expect(chatgptOption).toBeVisible();
      await expect(chatgptOption).toBeEnabled({ timeout: 30_000 });
      await chatgptOption.click();
      await expect(retryLink).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => page.evaluate(() =>
        window.rambo.snapshot().then(value => value.modelSource.kind)
      ), { timeout: 30_000 }).toBe('local');
    }
    await expect.poll(
      async () => await loginButton.isVisible().catch(() => false) ||
        await retryLink.isVisible().catch(() => false),
      { timeout: 30_000 }
    ).toBe(true);
    if (await loginButton.isVisible().catch(() => false)) await loginButton.click();
    await expect(retryLink).toBeVisible({ timeout: 15_000 });
    await expect(retryLink).toHaveAttribute(
      'href',
      'https://example.com/rambo-clean-user-login'
    );
    await expect(page.getByRole('button', { name: '等待授权…', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() =>
      window.rambo.snapshot().then(value => value.modelSource.kind)
    ), { timeout: 30_000 }).toBe('chatgpt');

    await expect(page.locator('.current-source-card')).toHaveAttribute('data-source', 'chatgpt', {
      timeout: 30_000
    });
    await expect(page.locator('.current-source-card')).toContainText('clean-user@example.com');
    const loginNotice = page.getByText('ChatGPT 登录已完成，账号已连接。');
    await expect(loginNotice).toBeVisible();
    await expect(retryLink).toHaveCount(0);
    await expect(page.locator('[data-sidebar-action="create"]')).toBeVisible();

    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('status').filter({
      hasText: '可用模型列表已更新为 2 个模型'
    })).toBeVisible();
    await expect(loginNotice).toHaveCount(0);
    await expect(page.getByLabel('新建 Bot 默认模型').locator('option')).toHaveCount(2);
  } finally {
    try {
      if (app) await app.close();
    } finally {
      cleanupRunProcesses(run);
      removeAcceptanceRun(run);
    }
  }
});

test('未配置运行时首次启动自动打开模型配置设置且关闭后不重复弹出', async () => {
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
    await expect(page.getByRole('tab', { name: '模型配置', exact: true }))
      .toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: '运行环境', exact: true }).click();
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
    await expect(page.getByRole('tab', { name: '模型配置', exact: true }))
      .toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: '运行环境', exact: true }).click();
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
    if (request.url === '/v1/models' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: [
          { id: 'clean-user-model', name: 'Clean User Model' },
          { id: 'clean-user-model-alt', name: 'Clean User Model Alt' }
        ]
      }));
      return;
    }
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
    await expect(page.getByRole('tab', { name: '模型配置', exact: true }))
      .toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: '运行环境', exact: true }).click();
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

    await page.getByRole('tab', { name: '模型服务', exact: true }).click();
    await expect(page.locator('.configuration-mode-section')).toHaveCount(0);
    await expect(page.getByText(/持续跟随本机/)).toHaveCount(0);
    const currentSource = page.locator('.current-source-card');
    await expect(currentSource).toBeVisible();
    await expect(page.locator('.current-source-title strong')).toHaveText('Rambo 配置');
    await expect(page.locator('.current-source-details')).not.toContainText(/已导入|Codex 配置已导入/);
    const manualSource = page.getByRole('button', { name: '配置或更换 API 服务', exact: true });
    if (!(await manualSource.isVisible().catch(() => false))) {
      const changeConfig = page.getByRole('button', { name: '更改', exact: true });
      if (await changeConfig.isVisible().catch(() => false)) await changeConfig.click();
    }
    if (await manualSource.isVisible().catch(() => false)) await manualSource.click();
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
    await page.getByLabel('API Key').fill(secret);
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '已获取 2 个可选模型' })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存并使用', exact: true })).toBeDisabled();
    await page.locator('.manual-model-tag').filter({
      has: page.getByText('clean-user-model', { exact: true })
    })
      .locator('input[type="checkbox"]').check();
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

    await page.getByRole('button', { name: '更改', exact: true }).click();
    await expect(page.getByRole('radio', { name: /本机 Codex 配置副本/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '登录或切换 ChatGPT 账号', exact: true }))
      .toBeEnabled();
    await expect(page.getByRole('button', { name: '配置或更换 API 服务', exact: true }))
      .toBeEnabled();
    await expect(page.getByRole('radio', { name: /ChatGPT 登录|手动配置 API/ })).toHaveCount(0);
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
