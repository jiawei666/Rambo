import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const sourceRoot = new URL('../../src/', import.meta.url);
const directMcpSource = readFileSync(new URL('main/direct-mcp.ts', sourceRoot), 'utf8');
const storeSource = readFileSync(new URL('main/store.ts', sourceRoot), 'utf8');
const contractsSource = readFileSync(new URL('shared/contracts.ts', sourceRoot), 'utf8');
const robotAvatarSource = readFileSync(new URL('shared/robot-avatar.ts', sourceRoot), 'utf8');
const scheduleSource = readFileSync(new URL('main/routine-schedule.ts', sourceRoot), 'utf8');

function compiled(source) {
  return ts.transpileModule(source, { compilerOptions }).outputText;
}

const files = {
  'direct-mcp.mjs': compiled(directMcpSource)
    .replaceAll("from './connector-credentials'", "from './connector-credentials.mjs'")
    .replaceAll("from './store'", "from './store.mjs'"),
  'store.mjs': compiled(storeSource)
    .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'")
    .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
    .replaceAll("from '../shared/robot-avatar'", "from './robot-avatar.mjs'"),
  'contracts.mjs': compiled(contractsSource),
  'robot-avatar.mjs': compiled(robotAvatarSource),
  'routine-schedule.mjs': compiled(scheduleSource)
};

function fakeCredentials() {
  return {
    records: new Map(),
    next: 0,
    save(_id, payload) {
      const reference = `db:${String(++this.next).padStart(8, '0')}-0000-4000-8000-000000000000`;
      this.records.set(reference, structuredClone(payload));
      return reference;
    },
    replace(reference, payload) {
      assert.equal(this.records.has(reference), true);
      this.records.set(reference, structuredClone(payload));
    },
    load(reference) {
      const value = this.records.get(reference);
      if (!value) throw new Error('missing credential');
      return structuredClone(value);
    },
    delete(reference) {
      this.records.delete(reference);
    }
  };
}

async function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-direct-mcp-test-'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(directory, name), source, { mode: 0o600 });
  }
  const nonce = `${Date.now()}-${Math.random()}`;
  try {
    const [{ DirectMcpRegistry, DirectMcpError }, { Store }] = await Promise.all([
      import(`${pathToFileURL(join(directory, 'direct-mcp.mjs')).href}?${nonce}`),
      import(`${pathToFileURL(join(directory, 'store.mjs')).href}?${nonce}`)
    ]);
    const store = new Store(directory);
    try {
      await run({ DirectMcpRegistry, DirectMcpError, store });
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('stdio MCP keeps headers and environment values only in secure storage', async () => {
  await withFixture(async ({ DirectMcpRegistry, store }) => {
    const credentials = fakeCredentials();
    const registry = new DirectMcpRegistry(store, credentials);
    const added = registry.add({
      name: 'local-files',
      description: 'Read local files',
      transport: 'stdio',
      command: '/usr/local/bin/local-files',
      args: ['--root', '/tmp'],
      cwd: '/tmp',
      env: { API_TOKEN: 'env-secret-value' }
    });

    assert.equal(added.name, 'local-files');
    assert.deepEqual(added.envKeys, ['API_TOKEN']);
    assert.match(added.credentialRef, /^db:/u);
    assert.equal(JSON.stringify(store.directMcpServers()).includes('env-secret-value'), false);
    assert.deepEqual(credentials.load(added.credentialRef), {
      kind: 'mcp-secrets',
      serverName: 'local-files',
      headers: {},
      env: { API_TOKEN: 'env-secret-value' }
    });
    assert.deepEqual(registry.runtimeConfig([added]), {
      'local-files': {
        command: '/usr/local/bin/local-files',
        args: ['--root', '/tmp'],
        cwd: '/tmp',
        env: { API_TOKEN: 'env-secret-value' },
        enabled: true
      }
    });
  });
});

test('http MCP stores headers securely and rejects URL userinfo or duplicate names', async () => {
  await withFixture(async ({ DirectMcpRegistry, DirectMcpError, store }) => {
    const credentials = fakeCredentials();
    const registry = new DirectMcpRegistry(store, credentials);
    const added = registry.add({
      name: 'remote-tools',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret-token' }
    });
    assert.deepEqual(added.headerKeys, ['Authorization']);
    assert.equal(JSON.stringify(store.directMcpServers()).includes('Bearer secret-token'), false);
    assert.deepEqual(registry.runtimeConfig([added]), {
      'remote-tools': {
        url: 'https://example.com/mcp',
        http_headers: { Authorization: 'Bearer secret-token' },
        enabled: true
      }
    });
    assert.throws(() => registry.add({
      name: 'remote-tools',
      transport: 'http',
      url: 'https://example.com/other'
    }), /同名/u);
    assert.throws(() => registry.add({
      name: 'bad-url',
      transport: 'http',
      url: 'https://user:password@example.com/mcp'
    }), DirectMcpError);
  });
});

test('MCP enable toggles preserve secrets and deletion removes the opaque credential', async () => {
  await withFixture(async ({ DirectMcpRegistry, store }) => {
    const credentials = fakeCredentials();
    const registry = new DirectMcpRegistry(store, credentials);
    const added = registry.add({
      name: 'toggle-server',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      env: { TOKEN: 'keep-me' }
    });
    const enabled = registry.setEnabled(added.id, true);
    assert.equal(enabled.enabled, true);
    assert.equal(credentials.load(enabled.credentialRef).env.TOKEN, 'keep-me');
    assert.deepEqual(enabled.envKeys, ['TOKEN']);

    const updated = registry.update(added.id, {
      name: 'toggle-server',
      description: 'updated display only',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs']
    });
    assert.deepEqual(credentials.load(updated.credentialRef), {
      kind: 'mcp-secrets',
      serverName: 'toggle-server',
      headers: {},
      env: { TOKEN: 'keep-me' }
    });
    registry.remove(added.id);
    assert.equal(credentials.records.has(added.credentialRef), false);
    assert.deepEqual(store.directMcpServers(), []);
  });
});
