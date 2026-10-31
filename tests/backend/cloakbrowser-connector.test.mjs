import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext
};

function compile(relativePath, replacements = []) {
  let output = ts.transpileModule(
    readFileSync(new URL(relativePath, root), 'utf8'),
    { compilerOptions }
  ).outputText;
  for (const [from, to] of replacements) output = output.replaceAll(from, to);
  return output;
}

const directory = mkdtempSync(join(import.meta.dirname, '.tmp', 'cloakbrowser-'));
mkdirSync(join(directory, 'platform'), { recursive: true });
writeFileSync(
  join(directory, 'platform', 'process.mjs'),
  compile('src/main/platform/process.ts'),
  { mode: 0o600 }
);
writeFileSync(
  join(directory, 'platform', 'fs.mjs'),
  compile('src/main/platform/fs.ts'),
  { mode: 0o600 }
);
writeFileSync(
  join(directory, 'cloakbrowser-runtime.mjs'),
  compile('src/main/cloakbrowser-runtime.ts', [
    ["from './platform/process'", "from './platform/process.mjs'"],
    ["from './platform/fs'", "from './platform/fs.mjs'"]
  ]),
  { mode: 0o600 }
);
writeFileSync(
  join(directory, 'cloakbrowser-proxy.mjs'),
  compile('src/main/cloakbrowser-proxy.ts'),
  { mode: 0o600 }
);
writeFileSync(
  join(directory, 'cloakbrowser-connector.mjs'),
  compile('src/main/cloakbrowser-connector.ts', [
    ["from './cloakbrowser-runtime'", "from './cloakbrowser-runtime.mjs'"],
    ["from './cloakbrowser-proxy'", "from './cloakbrowser-proxy.mjs'"]
  ]),
  { mode: 0o600 }
);

const nonce = `${Date.now()}-${Math.random()}`;
const {
  CloakBrowserRuntime,
  isSupportedCloakBrowserNodeVersion
} = await import(
  `${pathToFileURL(join(directory, 'cloakbrowser-runtime.mjs')).href}?${nonce}`
);
const { CloakBrowserMcpProxy } = await import(
  `${pathToFileURL(join(directory, 'cloakbrowser-proxy.mjs')).href}?${nonce}`
);
const { CloakBrowserConnector } = await import(
  `${pathToFileURL(join(directory, 'cloakbrowser-connector.mjs')).href}?${nonce}`
);

after(() => rmSync(directory, { recursive: true, force: true }));

class FakeCloakChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  killed = false;
  activeCalls = 0;
  maxActiveCalls = 0;
  startedCalls = [];
  finishedCalls = [];
  requests = [];
  stdin;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  constructor(delayMs = 25) {
    super();
    this.stdin = {
      destroyed: false,
      write: chunk => {
        for (const line of String(chunk).split(/\r?\n/u)) {
          if (line.trim()) this.accept(line);
        }
        return true;
      }
    };
    this.delayMs = delayMs;
  }

  kill() {
    if (this.killed) return true;
    this.killed = true;
    this.exitCode = 0;
    setImmediate(() => this.emit('close', 0, 'SIGTERM'));
    return true;
  }

  accept(line) {
    const message = JSON.parse(line);
    this.requests.push(message);
    if (message.id === undefined) return;
    if (message.method === 'initialize') {
      this.stderr.emit('data', 'Downloading CloakBrowser Chromium 200 MB\n');
      this.stderr.emit('data', 'Verifying checksum and signature\n');
      this.respond(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-cloakbrowser', version: '1.15.1' }
      });
      return;
    }
    if (message.method === 'tools/list') {
      this.respond(message.id, {
        tools: [
          'browser_navigate',
          'browser_snapshot',
          'browser_click',
          'cloakbrowser_binary_info',
          'cloakbrowser_bridge_info'
        ].map(name => ({
          name,
          description: name,
          inputSchema: { type: 'object', properties: {} }
        }))
      });
      return;
    }
    if (message.method !== 'tools/call') return;
    const name = message.params?.name;
    if (name === 'cloakbrowser_binary_info') {
      this.respond(message.id, {
        structuredContent: {
          executablePath: '/tmp/cloakbrowser/chrome',
          binary: {
            version: '145.0.0.0',
            binaryPath: '/tmp/cloakbrowser/chrome',
            cacheDir: '/tmp/cloakbrowser/cache'
          }
        },
        content: [{ type: 'text', text: '{"binary":{"version":"145.0.0.0"}}' }]
      });
      return;
    }
    if (name === 'cloakbrowser_bridge_info') {
      this.respond(message.id, {
        structuredContent: { browserEngine: 'cloak' },
        content: [{ type: 'text', text: '{"browserEngine":"cloak"}' }]
      });
      return;
    }
    this.startedCalls.push(name);
    this.activeCalls += 1;
    this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
    setTimeout(() => {
      this.activeCalls -= 1;
      this.finishedCalls.push(name);
      this.respond(message.id, {
        structuredContent: { tool: name },
        content: [{ type: 'text', text: `${name} complete` }]
      });
    }, this.delayMs);
  }

  respond(id, result) {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      result
    })}\n`));
  }
}

function createRuntimeFixture(options = {}) {
  const children = [];
  const spawnCalls = [];
  const userData = mkdtempSync(join(tmpdir(), 'rambo-cloakbrowser-data-'));
  const spawnProcess = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args, options: spawnOptions });
    const child = new FakeCloakChild(options.delayMs);
    children.push(child);
    return child;
  };
  const runtime = new CloakBrowserRuntime(userData, {
    spawnProcess,
    resolveNpx: () => '/fake/node/bin/npx',
    resolveNode: () => (
      Object.prototype.hasOwnProperty.call(options, 'nodePath')
        ? options.nodePath
        : '/fake/node/bin/node'
    ),
    probeNodeVersion: async () => options.nodeVersion ?? 'v24.14.0',
    platform: 'darwin',
    environment: {
      PATH: '/fake/node/bin:/usr/bin:/bin',
      HOME: '/Users/fixture',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NODE_EXTRA_CA_CERTS: '/Users/fixture/ca.pem',
      OPENAI_API_KEY: 'must-not-reach-third-party-code',
      AWS_SECRET_ACCESS_KEY: 'must-not-reach-third-party-code'
    },
    initializeTimeoutMs: 2_000,
    toolTimeoutMs: 2_000
  });
  return {
    runtime,
    children,
    spawnCalls,
    userData,
    cleanup: () => {
      void runtime.stop();
      rmSync(userData, { recursive: true, force: true });
    }
  };
}

class FakeConnectorStore {
  connections = [];
  grants = [];

  connectorConnections() {
    return this.connections;
  }

  connectorGrants() {
    return this.grants;
  }

  createConnectorConnection(input) {
    const date = '2026-10-31T00:00:00.000Z';
    const connection = {
      ...input,
      status: 'ready',
      createdAt: date,
      updatedAt: date
    };
    this.connections.push(connection);
    return connection;
  }

  setConnectorConnectionCapabilities(connectionId, capabilities) {
    const connection = this.connections.find(item => item.id === connectionId);
    assert.ok(connection);
    connection.capabilities = capabilities;
  }

  deleteConnectorConnection(connectionId) {
    this.connections = this.connections.filter(item => item.id !== connectionId);
  }

  grant(botId, connectionId) {
    this.grants.push({
      id: `${botId}:${connectionId}`,
      botId,
      connectionId,
      createdAt: '2026-10-31T00:00:00.000Z'
    });
  }

  revoke(botId, connectionId) {
    this.grants = this.grants.filter(grant =>
      grant.botId !== botId || grant.connectionId !== connectionId
    );
  }
}

test('CloakBrowser starts one shared runtime, sanitizes its environment, and serializes tool calls', async () => {
  const fixture = createRuntimeFixture({ delayMs: 35 });
  try {
    const progress = [];
    const [first, second] = await Promise.all([
      fixture.runtime.ensureStarted(value => progress.push(value)),
      fixture.runtime.ensureStarted()
    ]);
    assert.equal(first, second);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.deepEqual(fixture.spawnCalls[0].args, ['--yes', 'cloakbrowser-mcp@1.15.1']);
    assert.match(fixture.spawnCalls[0].options.env.PATH, /^\/fake\/node\/bin/u);
    assert.equal(fixture.spawnCalls[0].options.env.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(
      fixture.spawnCalls[0].options.env.NODE_EXTRA_CA_CERTS,
      '/Users/fixture/ca.pem'
    );
    assert.equal(fixture.spawnCalls[0].options.env.OPENAI_API_KEY, undefined);
    assert.equal(fixture.spawnCalls[0].options.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(fixture.spawnCalls[0].options.env.NODE_OPTIONS, '--use-env-proxy');
    assert.match(fixture.spawnCalls[0].options.env.NO_PROXY, /127\.0\.0\.1/u);
    assert.equal(
      fixture.spawnCalls[0].options.env.PLAYWRIGHT_MCP_USER_DATA_DIR,
      fixture.runtime.profileDirectory
    );
    assert.equal(
      fixture.spawnCalls[0].options.env.PLAYWRIGHT_MCP_OUTPUT_DIR,
      fixture.runtime.outputDirectory
    );
    assert.equal(fixture.spawnCalls[0].options.env.CLOAKBROWSER_AUTO_UPDATE, 'false');
    assert.equal(statSync(fixture.runtime.profileDirectory).mode & 0o777, 0o700);
    assert.deepEqual(progress.map(item => item.phase), [
      'checking-prerequisites',
      'installing',
      'downloading',
      'verifying-download',
      'starting',
      'verifying',
      'ready'
    ]);
    assert.equal(first.mcpVersion, '1.15.1');
    assert.equal(first.browserVersion, '145.0.0.0');
    assert.equal(first.executablePath, '/tmp/cloakbrowser/chrome');

    const tokenA = fixture.runtime.issueToken('bot-a');
    const tokenB = fixture.runtime.issueToken('bot-b');
    assert.match(tokenA, /^[a-f0-9]{64}$/u);
    assert.notEqual(tokenA, tokenB);
    assert.equal(fixture.runtime.botForToken(tokenA), 'bot-a');
    fixture.runtime.revokeBot('bot-a');
    assert.equal(fixture.runtime.botForToken(tokenA), null);
    assert.equal(fixture.runtime.botForToken(tokenB), 'bot-b');

    const firstCall = fixture.runtime.callTool('browser_navigate', { url: 'https://example.com' });
    const secondCall = fixture.runtime.callTool('browser_snapshot', {});
    await Promise.all([firstCall, secondCall]);
    assert.equal(fixture.children[0].maxActiveCalls, 1);
    assert.deepEqual(fixture.children[0].startedCalls, ['browser_navigate', 'browser_snapshot']);
    assert.deepEqual(fixture.children[0].finishedCalls, ['browser_navigate', 'browser_snapshot']);

    const slow = fixture.runtime.callTool('browser_navigate', { url: 'https://queued.example' });
    const revoked = fixture.runtime.callTool('browser_click', {}, () => false);
    await slow;
    await assert.rejects(revoked, /撤销/u);
    assert.equal(fixture.children[0].startedCalls.includes('browser_click'), false);
  } finally {
    await fixture.runtime.stop();
    fixture.cleanup();
  }
});

test('CloakBrowser HTTP proxy re-checks Bot grants, revokes old tokens, and keeps another Bot usable', async () => {
  const fixture = createRuntimeFixture({ delayMs: 40 });
  let proxy;
  const clients = [];
  try {
    await fixture.runtime.ensureStarted();
    const tokenA = fixture.runtime.issueToken('bot-a');
    const tokenB = fixture.runtime.issueToken('bot-b');
    const authorizedBots = new Set(['bot-a', 'bot-b']);
    proxy = new CloakBrowserMcpProxy(fixture.runtime, {
      authorizeToken: token => fixture.runtime.botForToken(token),
      authorizeBot: botId => authorizedBots.has(botId)
    });
    const endpoint = await proxy.start();

    const connect = async token => {
      const client = new Client(
        { name: 'cloakbrowser-test-client', version: '1.0.0' },
        { capabilities: {} }
      );
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      });
      await client.connect(transport);
      clients.push(client);
      return client;
    };
    const clientA = await connect(tokenA);
    const clientB = await connect(tokenB);
    assert.deepEqual(
      (await clientA.listTools()).tools.map(tool => tool.name),
      [
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'cloakbrowser_binary_info',
        'cloakbrowser_bridge_info'
      ]
    );

    await Promise.all([
      clientA.callTool({ name: 'browser_navigate', arguments: { url: 'https://a.example' } }),
      clientB.callTool({ name: 'browser_snapshot', arguments: {} })
    ]);
    assert.equal(fixture.children[0].maxActiveCalls, 1);

    authorizedBots.delete('bot-a');
    fixture.runtime.revokeBot('bot-a');
    proxy.revokeBot('bot-a');
    await assert.rejects(
      clientA.callTool({ name: 'browser_snapshot', arguments: {} }),
      /撤销|失效|关闭|closed|session/iu
    );
    await clientB.callTool({ name: 'browser_snapshot', arguments: {} });

    const staleClient = new Client(
      { name: 'stale-cloakbrowser-test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    const staleTransport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${tokenA}` } }
    });
    await assert.rejects(staleClient.connect(staleTransport), /401|撤销|无效/iu);
    await staleTransport.close().catch(() => {});
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await proxy?.stop();
    await fixture.runtime.stop();
    fixture.cleanup();
  }
});

test('CloakBrowser connector persists one shared connection and scopes thread access per Bot', async () => {
  const fixture = createRuntimeFixture({ delayMs: 10 });
  const store = new FakeConnectorStore();
  const connector = new CloakBrowserConnector(store, fixture.userData, {
    runtime: fixture.runtime
  });
  try {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const installed = await connector.install(
      connectionId,
      '共享 CloakBrowser',
      () => {}
    );
    assert.equal(installed.connection.id, connectionId);
    assert.equal(installed.connection.authKind, 'local-install');
    assert.equal(store.connections.length, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    await assert.rejects(
      connector.install(
        '22222222-2222-4222-8222-222222222222',
        '第二个 CloakBrowser',
        () => {}
      ),
      /已存在/u
    );

    assert.equal(await connector.threadConfig('bot-a'), null);
    store.grant('bot-a', connectionId);
    const configA = await connector.threadConfig('bot-a');
    assert.ok(configA);
    assert.equal(configA.enabled, true);
    assert.match(configA.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    const tokenA = configA.http_headers.Authorization.replace(/^Bearer /u, '');
    assert.match(tokenA, /^[a-f0-9]{64}$/u);
    assert.equal(await connector.threadConfig('bot-b'), null);

    store.grant('bot-b', connectionId);
    const configB = await connector.threadConfig('bot-b');
    const tokenB = configB.http_headers.Authorization.replace(/^Bearer /u, '');
    assert.notEqual(tokenA, tokenB);
    store.revoke('bot-a', connectionId);
    connector.revokeBot('bot-a');
    assert.equal(await connector.threadConfig('bot-a'), null);
    assert.equal(fixture.runtime.botForToken(tokenA), null);
    assert.equal(fixture.runtime.botForToken(tokenB), 'bot-b');
    assert.ok(await connector.threadConfig('bot-b'));

    await connector.stop();
    assert.equal(statSync(fixture.runtime.profileDirectory).isDirectory(), true);
    assert.equal(statSync(fixture.runtime.cacheDirectory).isDirectory(), true);
  } finally {
    await connector.stop();
    fixture.cleanup();
  }
});

test('CloakBrowser failed or cancelled installation leaves no connection or runtime behind', async () => {
  const stopped = [];
  const failedRuntime = {
    async ensureStarted() {
      throw new Error('download checksum failed');
    },
    clearTokens() {},
    async stop() {
      stopped.push('failed');
    }
  };
  const failedStore = new FakeConnectorStore();
  const failedConnector = new CloakBrowserConnector(failedStore, '/tmp/fixture', {
    runtime: failedRuntime
  });
  await assert.rejects(
    failedConnector.install(
      '33333333-3333-4333-8333-333333333333',
      '失败连接',
      () => {}
    ),
    /checksum failed/u
  );
  assert.equal(failedStore.connections.length, 0);
  assert.deepEqual(stopped, ['failed']);

  const controller = new AbortController();
  const cancelledRuntime = {
    async ensureStarted() {
      controller.abort();
      return {
        mcpVersion: '1.15.1',
        browserVersion: null,
        executablePath: null,
        cacheDirectory: null
      };
    },
    clearTokens() {},
    async stop() {
      stopped.push('cancelled');
    }
  };
  const cancelledStore = new FakeConnectorStore();
  const cancelledConnector = new CloakBrowserConnector(cancelledStore, '/tmp/fixture', {
    runtime: cancelledRuntime
  });
  await assert.rejects(
    cancelledConnector.install(
      '44444444-4444-4444-8444-444444444444',
      '取消连接',
      () => {},
      controller.signal
    ),
    /取消/u
  );
  assert.equal(cancelledStore.connections.length, 0);
  assert.deepEqual(stopped, ['failed', 'cancelled']);
});

test('CloakBrowser rejects unsupported or missing Node.js before starting npx', async () => {
  assert.equal(isSupportedCloakBrowserNodeVersion('v22.12.9'), false);
  assert.equal(isSupportedCloakBrowserNodeVersion('v22.13.0'), true);
  assert.equal(isSupportedCloakBrowserNodeVersion('v23.11.1'), false);
  assert.equal(isSupportedCloakBrowserNodeVersion('v24.0.0'), true);
  assert.equal(isSupportedCloakBrowserNodeVersion('v25.1.0'), true);
  assert.equal(isSupportedCloakBrowserNodeVersion('not-a-version'), false);

  const unsupported = createRuntimeFixture({ nodeVersion: 'v23.11.1' });
  try {
    await assert.rejects(
      unsupported.runtime.ensureStarted(),
      /Node\.js 22\.13\+.*24\+.*v23\.11\.1/u
    );
    assert.equal(unsupported.spawnCalls.length, 0);
  } finally {
    unsupported.cleanup();
  }

  const missing = createRuntimeFixture({ nodePath: null });
  try {
    await assert.rejects(
      missing.runtime.ensureStarted(),
      /找到了 npx.*没有找到对应的 Node\.js/u
    );
    assert.equal(missing.spawnCalls.length, 0);
  } finally {
    missing.cleanup();
  }
});

test('CloakBrowser only enables Node environment proxy support on Node.js 24+', async () => {
  const node22 = createRuntimeFixture({ nodeVersion: 'v22.13.0' });
  try {
    await node22.runtime.ensureStarted();
    assert.equal(node22.spawnCalls[0].options.env.NODE_OPTIONS, undefined);
    assert.match(node22.spawnCalls[0].options.env.NO_PROXY, /localhost/u);
  } finally {
    await node22.runtime.stop();
    node22.cleanup();
  }
});
