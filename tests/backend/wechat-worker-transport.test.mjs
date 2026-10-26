import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(
  new URL('../../src/main/wechat-worker-transport.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { ElectronWechatWorkerTransport } = await import(moduleUrl);

class FakeWorker {
  messages = [];
  killed = false;
  listeners = new Map();

  postMessage(value) {
    this.messages.push(value);
  }

  kill() {
    this.killed = true;
    return true;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function request(id = 'request-1') {
  return {
    connectionId: 'connection-1',
    timeoutMs: 1000,
    request: {
      id,
      operation: 'sessions',
      dataDirectory: '/tmp/profile',
      databases: [],
      query: {}
    }
  };
}

test('WeChat worker transport lazily starts one process and routes responses by request id', async () => {
  const workers = [];
  let forks = 0;
  const transport = new ElectronWechatWorkerTransport('/worker.js', () => {
    forks++;
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });

  const first = transport.send(request('first'));
  const second = transport.send(request('second'));
  assert.equal(forks, 1);
  assert.equal(workers[0].messages.length, 2);
  workers[0].emit('message', {
    id: 'second',
    ok: true,
    result: {
      items: [],
      nextCursor: null,
      hasMore: false,
      returnedCount: 0,
      knownTotal: 0,
      coverage: {
        start: null,
        end: null,
        localOnly: true,
        complete: true,
        databasePaths: [],
        skippedDatabases: [],
        notes: []
      },
      truncation: null,
      readAt: '2026-10-25T00:00:00.000Z'
    }
  });
  workers[0].emit('message', {
    id: 'first',
    ok: false,
    error: { code: 'QUERY_FAILED', message: '查询失败' }
  });

  assert.equal((await second).ok, true);
  const failed = await first;
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'QUERY_FAILED');
  transport.dispose();
  assert.equal(workers[0].killed, true);
});

test('WeChat worker transport rejects all pending calls when its process exits or a connection is invalidated', async () => {
  const workers = [];
  let forks = 0;
  const transport = new ElectronWechatWorkerTransport('/worker.js', () => {
    forks++;
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const pending = transport.send(request('exit-pending'));
  workers[0].emit('exit', 1);
  assert.equal(workers[0].killed, false);
  await assert.rejects(pending, /意外停止/u);
  const terminating = transport.send(request('terminating'));
  assert.equal(forks, 2);
  transport.terminate('connection-1');
  await assert.rejects(terminating, /连接已关闭/u);
  assert.equal(workers[1].killed, true);

  const next = transport.send(request('after-exit'));
  assert.equal(forks, 3);
  workers[2].emit('message', {
    id: 'after-exit',
    ok: false,
    error: { code: 'QUERY_FAILED', message: '查询失败' }
  });
  assert.equal((await next).ok, false);
  transport.dispose();
  assert.equal(workers[2].killed, true);
  await assert.rejects(transport.send(request('after-dispose')), /已停止/u);
});

test('WeChat worker transport times out a stuck process and removes that connection', async () => {
  const workers = [];
  const transport = new ElectronWechatWorkerTransport('/worker.js', () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const pending = transport.send({ ...request('timeout'), timeoutMs: 1 });
  await assert.rejects(pending, /读取超时/u);
  assert.equal(workers[0].killed, true);
});
