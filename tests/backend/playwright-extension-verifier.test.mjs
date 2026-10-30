import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import ts from 'typescript';

const source = new URL('../../src/main/playwright-extension-verifier.ts', import.meta.url);
const tempDirectory = mkdtempSync(join(tmpdir(), 'rambo-playwright-verifier-'));
const compiledPath = join(tempDirectory, 'playwright-extension-verifier.mjs');
const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText.replace(
  "from './platform/process'",
  "from './platform/process.mjs'"
);
const processSource = readFileSync(
  new URL('../../src/main/platform/process.ts', import.meta.url),
  'utf8'
);
mkdirSync(join(tempDirectory, 'platform'));
writeFileSync(join(tempDirectory, 'platform/process.mjs'), ts.transpileModule(processSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText);
writeFileSync(compiledPath, compiled);
const { PlaywrightExtensionVerifier } = await import(pathToFileURL(compiledPath).href);
rmSync(tempDirectory, { recursive: true, force: true });

class FakeMcpChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  signals = [];
  lines = [];

  constructor({
    tabs = ['- 0: (current) [Example] (https://example.test)'],
    defaultTab = '- 0: (current) [Example] (https://example.test)',
    snapshot = 'Page snapshot',
    oversizedInitialize = false
  } = {}) {
    super();
    this.tabs = [...tabs];
    this.defaultTab = defaultTab;
    this.snapshot = snapshot;
    this.oversizedInitialize = oversizedInitialize;
    this.stdin.on('data', chunk => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const request = JSON.parse(line);
        this.lines.push(request);
        if (request.id === undefined) continue;
        queueMicrotask(() => this.reply(request));
      }
    });
  }

  reply(request) {
    let result;
    if (request.method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05', capabilities: {},
        serverInfo: { name: 'fake', ...(this.oversizedInitialize ? { padding: 'x'.repeat(5_000_001) } : {}) }
      };
    } else if (request.method === 'tools/list') {
      result = { tools: [{ name: 'browser_tabs' }, { name: 'browser_snapshot' }] };
    } else if (request.method === 'tools/call' && request.params.name === 'browser_tabs') {
      result = { content: [{ type: 'text', text: this.tabs.shift() ?? this.defaultTab }] };
    } else if (request.method === 'tools/call' && request.params.name === 'browser_snapshot') {
      result = { content: [{ type: 'text', text: this.snapshot }] };
    } else {
      this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601 } })}\n`);
      return;
    }
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }

  kill(signal) {
    this.signals.push(signal);
    if (this.exitCode === null) {
      this.exitCode = 0;
      queueMicrotask(() => this.emit('close', 0, signal));
    }
    return true;
  }
}

test('Playwright extension verification lists a selected tab, takes one read-only snapshot, and drops page content', async () => {
  const child = new FakeMcpChild({ snapshot: 'PRIVATE PAGE BODY MUST NOT BE PERSISTED' });
  const command = [];
  const phases = [];
  const verifier = new PlaywrightExtensionVerifier({
    spawnProcess: (file, args, options) => {
      command.push({ file, args, options });
      return child;
    },
    resolveNpx: () => '/test/npx',
    now: () => new Date('2026-10-25T12:00:00.000Z')
  });

  const result = await verifier.verify(progress => phases.push(progress.phase));
  assert.deepEqual(result, { verifiedAt: '2026-10-25T12:00:00.000Z' });
  assert.equal(command[0].file, '/test/npx');
  assert.deepEqual(command[0].args, ['-y', '@playwright/mcp@0.0.83', '--extension']);
  assert.deepEqual(child.lines.filter(line => line.method === 'tools/call').map(line => line.params.name), [
    'browser_tabs', 'browser_snapshot'
  ]);
  assert.deepEqual(phases, ['starting', 'waiting-tab', 'checking-page', 'verified']);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('Playwright extension verification waits for the user to select a Chrome tab', async () => {
  const child = new FakeMcpChild({ tabs: [
    '- 0: [Playwright Extension](chrome-extension://extension-id/connect.html)',
    '- 0: (current) [Selected tab](https://example.test)'
  ] });
  const verifier = new PlaywrightExtensionVerifier({
    spawnProcess: () => child,
    resolveNpx: () => '/test/npx',
    timeoutMs: 5_000
  });

  await verifier.verify();
  assert.equal(child.lines.filter(line => line.method === 'tools/call' && line.params.name === 'browser_tabs').length, 2);
});

test('Playwright extension verification refuses success until a real tab is selected', async () => {
  const child = new FakeMcpChild({ tabs: [
    '- 0: [Playwright Extension](chrome-extension://extension-id/connect.html)'
  ], defaultTab: '- 0: [Playwright Extension](chrome-extension://extension-id/connect.html)' });
  const verifier = new PlaywrightExtensionVerifier({
    spawnProcess: () => child,
    resolveNpx: () => '/test/npx',
    timeoutMs: 1_000
  });

  await assert.rejects(verifier.verify(), /尚未确认 Chrome 标签页/u);
  assert.equal(child.lines.some(line => line.method === 'tools/call' && line.params.name === 'browser_snapshot'), false);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('Playwright extension verification can be cancelled while waiting for tab approval', async () => {
  const child = new FakeMcpChild({ tabs: [
    '- 0: [Playwright Extension](chrome-extension://extension-id/connect.html)'
  ] });
  const verifier = new PlaywrightExtensionVerifier({
    spawnProcess: () => child,
    resolveNpx: () => '/test/npx',
    timeoutMs: 5_000
  });
  const pending = verifier.verify();
  await new Promise(resolve => setTimeout(resolve, 50));
  verifier.cancel();
  await assert.rejects(pending, /已取消/u);
  assert.ok(child.signals.length > 0);
});

test('Playwright extension verifier gives actionable errors for missing npx or MCP tools', async () => {
  const missingNpx = new PlaywrightExtensionVerifier({ resolveNpx: () => null });
  await assert.rejects(missingNpx.verify(), /没有找到 Node.js 的 npx/u);

  const child = new FakeMcpChild();
  const originalReply = child.reply.bind(child);
  child.reply = request => {
    if (request.method === 'tools/list') {
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } })}\n`);
      return;
    }
    originalReply(request);
  };
  const missingTools = new PlaywrightExtensionVerifier({
    spawnProcess: () => child,
    resolveNpx: () => '/test/npx'
  });
  await assert.rejects(missingTools.verify(), /没有提供浏览器标签列表和只读快照工具/u);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('Playwright extension verifier rejects an oversized complete JSON-RPC line', async () => {
  const child = new FakeMcpChild({ oversizedInitialize: true });
  const verifier = new PlaywrightExtensionVerifier({
    spawnProcess: () => child,
    resolveNpx: () => '/test/npx'
  });

  await assert.rejects(verifier.verify(), /响应超出允许大小/u);
  assert.deepEqual(child.signals, ['SIGTERM']);
});
