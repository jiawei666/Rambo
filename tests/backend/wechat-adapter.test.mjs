import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/wechat-adapter.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
  assertValidCursor,
  assertWechatPageDatabasesReadable,
  boundedWechatPage,
  incompleteWechatDatabaseDiagnostics,
  parseWechatTimeRange,
  SqlCipherWechatReader
} = await import(moduleUrl);

const now = new Date('2026-10-25T12:00:00.000Z');

test('WeChat time ranges resolve relative windows and reject open, reversed, invalid, and oversized ranges', () => {
  assert.deepEqual(parseWechatTimeRange({ relativeMinutes: 60 }, now), {
    start: '2026-10-25T11:00:00.000Z',
    end: '2026-10-25T12:00:00.000Z'
  });
  assert.deepEqual(parseWechatTimeRange({
    start: '2026-10-25T10:30:00+08:00',
    end: '2026-10-25T11:30:00+08:00'
  }, now), {
    start: '2026-10-25T02:30:00.000Z',
    end: '2026-10-25T03:30:00.000Z'
  });
  assert.throws(() => parseWechatTimeRange({ start: '2026-10-25T00:00:00Z' }, now), /必须提供/u);
  assert.throws(() => parseWechatTimeRange({ relativeMinutes: 0 }, now), /1 分钟到 366 天/u);
  assert.throws(() => parseWechatTimeRange({ relativeMinutes: 527041 }, now), /1 分钟到 366 天/u);
  assert.throws(() => parseWechatTimeRange({
    start: '2026-10-25T12:00:00Z',
    end: '2026-10-25T12:00:00Z'
  }, now), /结束时间必须晚于/u);
  assert.throws(() => parseWechatTimeRange({
    start: '2025-01-01T00:00:00Z',
    end: '2026-10-25T00:00:00Z'
  }, now), /不能超过 366 天/u);
  assert.throws(() => parseWechatTimeRange({
    start: 'not-a-date',
    end: '2026-10-25T00:00:00Z'
  }, now), /时间格式无效/u);
});

test('WeChat pages cap item count and serialized bytes and expose deterministic truncation semantics', () => {
  const range = {
    start: '2026-10-25T11:00:00.000Z',
    end: '2026-10-25T12:00:00.000Z'
  };
  const countPage = boundedWechatPage(Array.from({ length: 101 }, (_, index) => ({
    id: index, text: 'x'
  })), {
    range,
    cursor: 'subject-bound-cursor',
    knownTotal: 101
  });
  assert.equal(countPage.items.length, 100);
  assert.equal(countPage.returnedCount, 100);
  assert.equal(countPage.hasMore, true);
  assert.equal(countPage.nextCursor, 'subject-bound-cursor');
  assert.equal(countPage.truncation, 'messages');
  assert.equal(countPage.coverage.complete, false);

  const bytesPage = boundedWechatPage(Array.from({ length: 8 }, (_, index) => ({
    id: index,
    text: 'x'.repeat(64_000)
  })), {
    range,
    cursor: 'subject-bound-cursor',
    knownTotal: null
  });
  assert.ok(bytesPage.items.length < 8);
  assert.equal(bytesPage.hasMore, true);
  assert.equal(bytesPage.truncation, 'bytes');
  assert.equal(bytesPage.coverage.localOnly, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bytesPage.items), 'utf8') <= 256 * 1024);

  const finalPage = boundedWechatPage([{ id: 1 }], {
    range,
    cursor: null,
    knownTotal: 1,
    coverageNotes: ['local database']
  });
  assert.equal(finalPage.hasMore, false);
  assert.equal(finalPage.nextCursor, null);
  assert.equal(finalPage.coverage.complete, true);
  assert.deepEqual(finalPage.coverage.notes, ['local database']);
});

test('WeChat cursors are bounded opaque tokens', () => {
  assert.equal(assertValidCursor(undefined), null);
  assert.equal(assertValidCursor('cursor_1234'), 'cursor_1234');
  assert.throws(() => assertValidCursor('bad cursor'), /游标无效/u);
  assert.throws(() => assertValidCursor('x'.repeat(8_193)), /游标无效/u);
});

test('WeChat connection diagnostics distinguish skipped databases from result pagination', () => {
  assert.deepEqual(incompleteWechatDatabaseDiagnostics([
    'content_scan_used',
    'content_scan_used'
  ]), []);
  assert.deepEqual(incompleteWechatDatabaseDiagnostics([
    '未覆盖 db_storage/session/session.db：database_open_failed',
    '未覆盖 db_storage/contact/contact.db：access_denied',
    '用户正文不能作为诊断'
  ]), [
    '未覆盖 db_storage/session/session.db：database_open_failed',
    '未覆盖 db_storage/contact/contact.db：access_denied'
  ]);
  assert.doesNotThrow(() => assertWechatPageDatabasesReadable('会话', {
    hasMore: true,
    coverage: { complete: false, notes: [] }
  }));
  assert.throws(() => assertWechatPageDatabasesReadable('会话', {
    hasMore: false,
    coverage: { complete: false, notes: ['未覆盖 db_storage/session/session.db：access_denied'] }
  }), /会话数据库读取不完整.*access_denied/u);
});

test('WeChat media requests pass all credential database keys, including media databases', async () => {
  let captured;
  const reader = new SqlCipherWechatReader({
    send: async input => {
      captured = input.request;
      return {
        id: input.request.id,
        ok: true,
        result: {
          resourceHandle: 'ab'.repeat(16),
          kind: 'audio',
          status: 'available',
          mimeType: 'audio/wav',
          fileName: 'voice.wav',
          size: 4,
          bytes: new Uint8Array([82, 73, 70, 70]),
          diagnostics: []
        }
      };
    },
    terminate() {},
    dispose() {}
  });
  const connection = {
    id: 'wechat-connection', providerId: 'wechat', displayName: '本机微信', accountLabel: 'wxid_example',
    authKind: 'local-key-capture', status: 'ready', createdAt: now.toISOString(), updatedAt: now.toISOString()
  };
  const credential = {
    kind: 'wechat-sqlcipher', accountId: 'wxid_example', dataDirectory: '/tmp/wechat-profile',
    wechatVersion: '4.1.15', wechatBuild: '270135',
    keys: {
      'message/message_0.db': { encKey: 'ab'.repeat(32), salt: null },
      'message/media_0.db': { encKey: 'cd'.repeat(32), salt: null }
    }
  };
  const result = await reader.readMedia(connection, credential, 'ab'.repeat(16));
  assert.equal(result.mimeType, 'audio/wav');
  assert.deepEqual([...result.bytes], [82, 73, 70, 70]);
  assert.deepEqual(captured.databases.map(item => item.path), [
    'message/media_0.db',
    'message/message_0.db'
  ]);
  assert.equal(captured.operation, 'media');
});
