import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const sourceRoot = new URL('../../src/', import.meta.url);
const resourceToolsSource = readFileSync(
  new URL('main/bot-resource-tools.ts', sourceRoot),
  'utf8'
);
const resourcesSource = readFileSync(new URL('main/bot-resources.ts', sourceRoot), 'utf8');
const contractsSource = readFileSync(new URL('shared/contracts.ts', sourceRoot), 'utf8');
const robotAvatarSource = readFileSync(new URL('shared/robot-avatar.ts', sourceRoot), 'utf8');
const scheduleSource = readFileSync(new URL('main/routine-schedule.ts', sourceRoot), 'utf8');
const storeSource = readFileSync(new URL('main/store.ts', sourceRoot), 'utf8');

function compiled(source) {
  return ts.transpileModule(source, { compilerOptions }).outputText;
}

const files = {
  'bot-resource-tools.mjs': compiled(resourceToolsSource)
    .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
    .replaceAll("from './store'", "from './store.mjs'"),
  'bot-resources.mjs': compiled(resourcesSource)
    .replaceAll("from '../shared/contracts'", "from './contracts.mjs'"),
  'contracts.mjs': compiled(contractsSource),
  'robot-avatar.mjs': compiled(robotAvatarSource),
  'routine-schedule.mjs': compiled(scheduleSource),
  'store.mjs': compiled(storeSource)
    .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'")
    .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
    .replaceAll("from '../shared/robot-avatar'", "from './robot-avatar.mjs'")
};

async function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-resource-tools-test-'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(directory, name), source, { mode: 0o600 });
  }
  const nonce = `${Date.now()}-${Math.random()}`;
  try {
    const tools = await import(
      `${pathToFileURL(join(directory, 'bot-resource-tools.mjs')).href}?${nonce}`
    );
    const { Store } = await import(`${pathToFileURL(join(directory, 'store.mjs')).href}?${nonce}`);
    const store = new Store(directory);
    store.setSetting('defaultBotModel', 'test-model');
    store.setSetting('defaultBotPermission', 'fullAccess');
    store.syncBotResources(['mcp:playwright'], []);
    try {
      await run({ ...tools, store, directory });
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const resources = [{
  id: 'skill:pdf',
  kind: 'skill',
  name: 'pdf',
  description: 'PDF fixture',
  source: 'Codex Bundled',
  bundled: true,
  configKey: null
}, {
  id: 'mcp:playwright',
  kind: 'mcp',
  name: 'Playwright',
  description: 'Browser MCP',
  source: 'MCP',
  bundled: false,
  configKey: 'playwright'
}];

async function setupBot(store) {
  const { bot } = store.createBot('Resource Bot', 'a');
  store.__botId = bot.id;
  return bot;
}

test('resource tools manage global directory, defaults and only the current Bot switch', async () => {
  await withFixture(async ({ Store: _Store, executeBotResourceTool, store }) => {
    const first = await setupBot(store);
    const second = store.createBot('Other Bot', 'b').bot;

    let result = executeBotResourceTool(store, {
      botId: first.id, chatId: 'unused', resources,
      action: 'install_global', resourceId: 'skill:pdf'
    });
    assert.equal(result.success, true);
    assert.match(result.notice, /全局可选目录/u);
    assert.deepEqual(store.settings().globalResourceIds && JSON.parse(store.settings().globalResourceIds), ['mcp:playwright', 'skill:pdf']);
    assert.equal(store.botResourceEnabled(first.id, 'skill:pdf'), false);
    assert.deepEqual(store.botResourceRecords(second.id), [
      { resourceId: 'mcp:playwright', enabled: false },
      { resourceId: 'skill:pdf', enabled: false }
    ]);

    result = executeBotResourceTool(store, {
      botId: first.id, chatId: 'unused', resources,
      action: 'set_global_default', resourceId: 'mcp:playwright', enabled: true
    });
    assert.equal(result.success, true);
    assert.deepEqual(
      JSON.parse(store.settings().globalDefaultResourceIds),
      ['mcp:playwright']
    );
    assert.equal(store.botResourceEnabled(first.id, 'mcp:playwright'), false);
    assert.equal(store.botResourceEnabled(second.id, 'mcp:playwright'), false);

    const later = store.createBot('Later Bot', 'c').bot;
    assert.equal(store.botResourceEnabled(later.id, 'mcp:playwright'), true);
    assert.equal(store.botResourceEnabled(first.id, 'mcp:playwright'), false);

    result = executeBotResourceTool(store, {
      botId: first.id, chatId: 'unused', resources,
      action: 'set_current_bot', resourceId: 'skill:pdf', enabled: true
    });
    assert.equal(result.success, true);
    assert.equal(store.botResourceEnabled(first.id, 'skill:pdf'), true);
    assert.equal(store.botResourceEnabled(second.id, 'skill:pdf'), false);
    assert.equal(store.botResourceEnabled(later.id, 'skill:pdf'), false);
    assert.equal(store.botResourceEnabled(first.id, 'mcp:playwright'), false);
    assert.equal(store.botResourceEnabled(second.id, 'mcp:playwright'), false);

    result = executeBotResourceTool(store, {
      botId: first.id, chatId: 'unused', resources,
      action: 'remove_global', resourceId: 'skill:pdf'
    });
    assert.equal(result.success, true);
    assert.deepEqual(JSON.parse(store.settings().globalResourceIds), ['mcp:playwright']);
    assert.deepEqual(store.botResourceRecords(first.id).map(item => item.resourceId), ['mcp:playwright']);
    assert.deepEqual(store.botResourceRecords(second.id).map(item => item.resourceId), ['mcp:playwright']);
    assert.equal(store.botResourceEnabled(first.id, 'skill:pdf'), false);
  });
});

test('resource tools reject unknown, malformed and protected changes without mutating data', async () => {
  await withFixture(async ({ executeBotResourceTool, store }) => {
    const bot = await setupBot(store);
    assert.equal(executeBotResourceTool(store, {
      botId: bot.id, chatId: 'unused', resources,
      action: 'set_global_default', resourceId: 'mcp:playwright'
    }).success, false);
    assert.equal(executeBotResourceTool(store, {
      botId: bot.id, chatId: 'unused', resources,
      action: 'remove_global', resourceId: 'mcp:playwright'
    }).success, false);
    assert.equal(executeBotResourceTool(store, {
      botId: bot.id, chatId: 'unused', resources,
      action: 'set_current_bot', resourceId: 'skill:missing', enabled: true
    }).success, false);
    assert.equal(executeBotResourceTool(store, {
      botId: bot.id, chatId: 'unused', resources,
      action: 'set_current_bot', resourceId: 'skill:pdf', enabled: 'yes'
    }).success, false);
    assert.equal(executeBotResourceTool(store, {
      botId: bot.id, chatId: 'unused', resources,
      action: 'install_global', resourceId: 'skill:pdf', enabled: true
    }).success, false);
    assert.equal(executeBotResourceTool(store, {
      botId: bot.id, chatId: 'unused', resources,
      action: 'install_global', resourceId: 'skill:missing'
    }).success, false);
    assert.deepEqual(JSON.parse(store.settings().globalResourceIds), ['mcp:playwright']);
  });
});
