import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext
};
const sourceRoot = new URL('../../src/', import.meta.url);
const resourcesSource = readFileSync(new URL('main/bot-resources.ts', sourceRoot), 'utf8');
const sourceFiles = {
  'bot-resources.mjs': resourcesSource,
  'contracts.mjs': readFileSync(new URL('shared/contracts.ts', sourceRoot), 'utf8'),
  'robot-avatar.mjs': readFileSync(new URL('shared/robot-avatar.ts', sourceRoot), 'utf8'),
  'routine-schedule.mjs': readFileSync(new URL('main/routine-schedule.ts', sourceRoot), 'utf8'),
  'store.mjs': readFileSync(new URL('main/store.ts', sourceRoot), 'utf8')
};

function writeFixtureModule(directory) {
  for (const [name, source] of Object.entries(sourceFiles)) {
    let compiled = ts.transpileModule(source, { compilerOptions }).outputText;
    if (name === 'store.mjs') {
      compiled = compiled
        .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'")
        .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
        .replaceAll("from '../shared/robot-avatar'", "from './robot-avatar.mjs'");
    } else if (name === 'bot-resources.mjs') {
      compiled = compiled.replaceAll("from '../shared/contracts'", "from './contracts.mjs'");
    }
    writeFileSync(join(directory, name), compiled, { mode: 0o600 });
  }
}

async function loadModules(directory) {
  writeFixtureModule(directory);
  const nonce = `${Date.now()}-${Math.random()}`;
  const resources = await import(
    `${pathToFileURL(join(directory, 'bot-resources.mjs')).href}?${nonce}`
  );
  const store = await import(`${pathToFileURL(join(directory, 'store.mjs')).href}?${nonce}`);
  return { ...resources, Store: store.Store };
}

function createHome() {
  const root = mkdtempSync(join(tmpdir(), 'rambo-resource-test-'));
  const codexRoot = join(root, '.codex');
  const agentsRoot = join(root, '.agents');
  mkdirSync(join(codexRoot, 'skills', '.system', 'pdf'), { recursive: true });
  mkdirSync(join(codexRoot, 'skills', 'custom-codex'), { recursive: true });
  mkdirSync(join(agentsRoot, 'skills', 'research'), { recursive: true });
  mkdirSync(join(codexRoot, 'plugins', 'cache'), { recursive: true });
  writeFileSync(join(codexRoot, 'skills', '.system', 'pdf', 'SKILL.md'), [
    '---',
    'name: pdf',
    'description: Bundled PDF fixture',
    '---',
    ''
  ].join('\n'));
  writeFileSync(join(codexRoot, 'skills', 'custom-codex', 'SKILL.md'), [
    '---',
    'description: Custom Codex fixture',
    '---',
    ''
  ].join('\n'));
  writeFileSync(join(agentsRoot, 'skills', 'research', 'SKILL.md'), [
    '---',
    'description: Agent fixture',
    '---',
    ''
  ].join('\n'));
  return root;
}

function writePlugin(home, marketplace, plugin, version, manifestPath, manifest) {
  const root = join(home, '.codex', 'plugins', 'cache', marketplace, plugin, version);
  const path = join(root, manifestPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest));
  return root;
}

async function withDirectories(run) {
  const modules = mkdtempSync(join(tmpdir(), 'rambo-resource-modules-'));
  const homeA = createHome();
  const homeB = createHome();
  const storeDirectory = mkdtempSync(join(tmpdir(), 'rambo-resource-store-'));
  try {
    const visualizeRoot = writePlugin(homeA, 'openai-bundled', 'visualize', '1.0.0', '.codex-plugin/plugin.json', {
      name: 'visualize',
      description: 'Bundled visualization fixture',
      mcpServers: './.mcp.json'
    });
    writeFileSync(join(visualizeRoot, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'visualize-runtime': {
          command: './bin/visualize-server',
          cwd: '.',
          env: { FIXTURE_TOKEN: 'plugin-only-token' }
        }
      }
    }));
    writePlugin(homeA, 'vendor', 'hook-plugin', '2.0.0', '.claude-plugin/plugin.json', {
      name: 'hook-plugin',
      description: 'Claude manifest fixture'
    });
    writePlugin(homeB, 'vendor', 'different-plugin', '3.0.0', 'plugin.json', {
      name: 'different-plugin',
      description: 'Home B fixture'
    });
    const loaded = await loadModules(modules);
    await run({ ...loaded, homeA, homeB, storeDirectory, visualizeRoot });
  } finally {
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
    rmSync(storeDirectory, { recursive: true, force: true });
    rmSync(modules, { recursive: true, force: true });
  }
}

test('resource discovery is isolated by home and recognizes current plugin layouts', async () => {
  await withDirectories(async ({
    discoverBotResources, clearBotResourceCache, homeA, homeB, visualizeRoot
  }) => {
    const first = discoverBotResources({
      home: homeA,
      mcpServers: [
        { name: 'zeta-server', description: 'Zeta fixture' },
        { name: 'alpha-server', description: 'Alpha fixture' },
        { name: 'no-description-server' },
        { name: 'playwright', description: 'Must not replace the built-in entry' },
        { name: 'visualize-runtime', description: 'Owned by the visualize plugin' }
      ]
    });
    const resources = new Map(first.resources.map(resource => [resource.id, resource]));
    assert.equal(resources.get('skill:pdf')?.bundled, true);
    assert.equal(resources.get('skill:pdf')?.source, 'Codex Skills');
    assert.equal(resources.get('skill:custom-codex')?.description, 'Custom Codex fixture');
    assert.equal(resources.get('skill:research')?.source, 'Agent Skills');
    assert.equal(resources.get('app:chatgpt')?.kind, 'app');
    assert.equal(resources.get('mcp:playwright')?.configKey, 'playwright');
    assert.equal(resources.get('mcp:playwright')?.source, 'MCP');
    assert.deepEqual(
      first.resources.filter(resource => resource.kind === 'mcp').map(resource => resource.name),
      ['alpha-server', 'no-description-server', 'Playwright', 'zeta-server']
    );
    assert.equal(resources.has('mcp:visualize-runtime'), false);
    const visualizeRuntime = first.pluginMcpRuntimes.find(runtime =>
      runtime.pluginId === 'visualize@openai-bundled');
    assert.deepEqual(visualizeRuntime?.serverNames, ['visualize-runtime']);
    assert.equal(
      visualizeRuntime?.mcpServers['visualize-runtime'].command,
      join(visualizeRoot, 'bin', 'visualize-server')
    );
    assert.equal(visualizeRuntime?.mcpServers['visualize-runtime'].cwd, visualizeRoot);
    assert.deepEqual(
      [resources.get('mcp:alpha-server')?.description, resources.get('mcp:alpha-server')?.source],
      ['Alpha fixture', 'Codex config']
    );
    assert.equal(
      resources.get('mcp:no-description-server')?.description,
      '来自 Codex config/read 的 MCP Server。'
    );
    assert.equal(resources.get('mcp:zeta-server')?.configKey, 'zeta-server');
    const mixedCase = discoverBotResources({
      home: homeA,
      mcpServers: { MyServer: { description: 'Mixed-case config key', command: 'secret' } }
    });
    assert.deepEqual(
      [
        mixedCase.resources.find(resource => resource.id === 'mcp:myserver')
          ?.configKey,
        mixedCase.resources.find(resource => resource.id === 'mcp:myserver')
          ?.name
      ],
      ['MyServer', 'MyServer']
    );
    assert.equal(JSON.stringify(mixedCase).includes('secret'), false);
    assert.deepEqual(
      [resources.get('plugin:visualize')?.name, resources.get('plugin:visualize')?.bundled],
      ['visualize', true]
    );
    assert.equal(resources.get('plugin:hook-plugin')?.source, 'Plugin · vendor');
    assert.equal(resources.has('plugin:1.0.0'), false);

    const second = discoverBotResources({ home: homeB });
    const secondIds = new Set(second.resources.map(resource => resource.id));
    assert.equal(secondIds.has('plugin:different-plugin'), true);
    assert.equal(secondIds.has('plugin:hook-plugin'), false);
    assert.equal(second.resources.some(resource => resource.id === 'plugin:hook-plugin'), false);

    clearBotResourceCache();
    writePlugin(homeA, 'vendor', 'newly-added', '1.0.0', 'manifest.json', {
      name: 'newly-added',
      description: 'Reloaded fixture'
    });
    assert.equal(
      discoverBotResources({ home: homeA }).resources.some(resource => resource.id === 'plugin:newly-added'),
      true
    );
    assert.equal(
      discoverBotResources(true, { home: homeA }).resources
        .some(resource => resource.id === 'plugin:newly-added'),
      true
    );
  });
});

test('default resource discovery prefers USERPROFILE on Windows-style launch environments', async () => {
  await withDirectories(async ({ discoverBotResources, clearBotResourceCache, homeA, homeB }) => {
    const originalUserProfile = process.env.USERPROFILE;
    const originalHome = process.env.HOME;
    try {
      process.env.USERPROFILE = homeA;
      process.env.HOME = homeB;
      clearBotResourceCache();
      const discovered = discoverBotResources();
      assert.equal(
        discovered.resources.some(resource => resource.id === 'skill:custom-codex'),
        true
      );
      assert.equal(
        discovered.resources.some(resource => resource.id === 'plugin:different-plugin'),
        false
      );
    } finally {
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      clearBotResourceCache();
    }
  });
});

test('MCP metadata is cache-keyed without retaining configuration secrets', async () => {
  await withDirectories(async ({ discoverBotResources, clearBotResourceCache, homeA }) => {
    const metadata = {
      'cache-server': {
        description: 'Cached fixture',
        command: 'must not be copied',
        env: { TOKEN: 'do-not-record' }
      }
    };
    const first = discoverBotResources({ home: homeA, knownMcpServers: metadata });
    const second = discoverBotResources({ home: homeA, knownMcpServers: metadata });
    assert.notStrictEqual(first.resources, second.resources);
    assert.equal(second.resources.some(resource => resource.id === 'mcp:cache-server'), true);
    assert.equal(JSON.stringify(second).includes('do-not-record'), false);
    assert.equal(JSON.stringify(second).includes('must not be copied'), false);

    const changed = discoverBotResources({
      home: homeA,
      knownMcpServers: {
        ...metadata,
        'new-server': { description: 'Added after the first lookup' }
      }
    });
    assert.equal(changed.resources.some(resource => resource.id === 'mcp:new-server'), true);

    clearBotResourceCache();
    const afterClear = discoverBotResources({ home: homeA, knownMcpServers: metadata });
    assert.equal(afterClear.resources.some(resource => resource.id === 'mcp:new-server'), false);
  });
});

test('global resource IDs are canonicalized while MCP config keys remain intact', async () => {
  await withDirectories(async ({ resourceIdsSetting }) => {
    assert.deepEqual(
      resourceIdsSetting(JSON.stringify([
        ' documents ', 'skill:PDF', 'Skill:pdf', 'MCP:MyServer', 'mcp:myserver',
        'app:ChatGPT', 'PLUGIN:Hook-Plugin', '', 'unknown:entry', 42
      ])),
      ['skill:documents', 'skill:pdf', 'mcp:myserver', 'app:chatgpt', 'plugin:hook-plugin']
    );
  });
});

test('discovery is separate from global selection and Bot switches', async () => {
  await withDirectories(async ({ discoverBotResources, selectedResources, Store, homeA, storeDirectory }) => {
    const discoveredIds = discoverBotResources({ home: homeA }).resources.map(resource => resource.id);
    assert.ok(discoveredIds.includes('skill:custom-codex'));
    assert.ok(discoveredIds.includes('plugin:hook-plugin'));

    const store = new Store(storeDirectory);
    try {
      store.setSetting('defaultBotModel', 'model-before-bots');
      store.setSetting('defaultBotPermission', 'readOnly');
      store.syncBotResources(
        ['skill:documents', 'skill:pdf', 'mcp:playwright', 'skill:custom-codex'],
        ['skill:documents', 'skill:pdf', 'mcp:playwright']
      );
      const first = store.createBot('First', 'avatar-first').bot;
      assert.equal(first.model, 'model-before-bots');
      assert.equal(first.permission, 'readOnly');
      assert.deepEqual(new Set(first.resourceIds), new Set([
        'skill:documents', 'skill:pdf', 'mcp:playwright'
      ]));
      assert.equal(store.botResourceEnabled(first.id, 'skill:custom-codex'), false);
      assert.deepEqual(new Set(
        selectedResources(first.id, store).map(resource => resource.id),
      ), new Set(['skill:documents', 'skill:pdf', 'mcp:playwright']));

      store.setBotResource(first.id, 'skill:documents', false);
      store.setSetting('defaultBotModel', 'model-for-second-bot');
      store.setSetting('defaultBotPermission', 'workspaceWrite');
      const second = store.createBot('Second', 'avatar-second').bot;
      assert.equal(store.bot(first.id).model, 'model-before-bots');
      assert.equal(store.bot(first.id).permission, 'readOnly');
      assert.equal(second.model, 'model-for-second-bot');
      assert.equal(second.permission, 'workspaceWrite');
      assert.equal(store.botResourceEnabled(first.id, 'skill:documents'), false);
      assert.equal(store.botResourceEnabled(second.id, 'skill:documents'), true);
      assert.equal(store.botResourceEnabled(first.id, 'mcp:playwright'), true);
      assert.equal(store.botResourceEnabled(second.id, 'mcp:playwright'), true);

      store.syncBotResources(
        ['skill:documents', 'skill:pdf', 'mcp:playwright', 'skill:custom-codex'],
        ['skill:documents', 'skill:pdf', 'mcp:playwright']
      );
      const globalAdded = store.botResourceRecords(first.id)
        .find(record => record.resourceId === 'skill:custom-codex');
      assert.deepEqual(globalAdded, { resourceId: 'skill:custom-codex', enabled: false });

      store.syncBotResources(['skill:pdf', 'mcp:playwright'], ['skill:pdf']);
      assert.equal(
        store.botResourceRecords(first.id).some(record => record.resourceId === 'skill:documents'),
        false
      );
      assert.throws(
        () => store.setBotResource(first.id, 'skill:documents', true),
        /不在全局可选目录/u
      );

      store.syncBotResources(
        ['skill:documents', 'skill:pdf', 'mcp:playwright'],
        ['skill:documents', 'skill:pdf', 'mcp:playwright']
      );
      assert.equal(store.botResourceEnabled(first.id, 'skill:documents'), false);
      assert.equal(store.botResourceEnabled(second.id, 'skill:documents'), false);
      assert.deepEqual(new Set(
        selectedResources(first.id, store).map(resource => resource.id),
      ), new Set(['skill:pdf', 'mcp:playwright']));
      assert.deepEqual(new Set(
        selectedResources(second.id, store).map(resource => resource.id),
      ), new Set(['skill:pdf', 'mcp:playwright']));

      store.setBotResource(second.id, 'skill:documents', true);
      assert.equal(store.botResourceEnabled(first.id, 'skill:documents'), false);
      assert.equal(store.botResourceEnabled(second.id, 'skill:documents'), true);
    } finally {
      store.close();
    }
  });
});
