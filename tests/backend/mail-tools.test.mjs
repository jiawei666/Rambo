import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/mail-tools.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText.replace(
  "from '../shared/contracts'",
  "from 'data:text/javascript;base64,' + ''"
);
const contracts = readFileSync(new URL('../../src/shared/contracts.ts', import.meta.url), 'utf8');
const contractsCompiled = ts.transpileModule(contracts, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const executable = compiled.replace(
  "from 'data:text/javascript;base64,' + ''",
  `from 'data:text/javascript;base64,${Buffer.from(contractsCompiled).toString('base64')}'`
);
const { executeMailTool, mailConnectionDirectory } = await import(
  `data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`
);

const connection = {
  id: '0f1e6a82-7a14-4f56-a1a1-7af19d7d55c8',
  providerId: 'qqmail',
  displayName: '工作 QQ 邮箱',
  accountLabel: 'owner@qq.com',
  authKind: 'credentials',
  status: 'ready',
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z'
};

function host(overrides = {}) {
  const calls = [];
  return {
    calls,
    connection(botId, connectionId) {
      assert.equal(botId, 'bot-owner');
      if (connectionId !== connection.id) throw new Error('当前 Bot 没有该邮箱连接的使用权限');
      return connection;
    },
    providers: () => [{ id: 'qqmail', name: 'QQ 邮箱' }],
    async run(_connection, action) {
      const adapter = {
        async search(_value, input) { calls.push(['search', input]); return [{ id: 'qq:42' }]; },
        async read(_value, id) { calls.push(['read', id]); return { id, text: 'body' }; },
        async getAttachment(_value, input) { calls.push(['attachment', input]); return { dataBase64: 'AA==' }; },
        async createDraft(_value, input) { calls.push(['draft', input]); return { draftId: 'draft-42' }; },
        async reply(_value, input) { calls.push(['reply', input]); return { messageId: 'sent' }; },
        async send(_value, input) { calls.push(['send', input]); return { messageId: 'sent' }; },
        async verify() {}
      };
      return action(adapter);
    },
    ...overrides
  };
}

test('mail tool results keep the actual connection identity and do not expose credentials', async () => {
  const value = host();
  const response = await executeMailTool(value, 'bot-owner', 'mail_search', {
    connection_id: connection.id,
    query: 'invoice',
    unread_only: true,
    limit: 10
  });
  assert.equal(response.success, true);
  const payload = JSON.parse(response.contentItems[0].text);
  assert.match(payload.connection_id, /^[a-f0-9-]{36}$/u);
  assert.equal(payload.provider, 'qqmail');
  assert.equal(payload.provider_name, 'QQ 邮箱');
  assert.equal(payload.account, 'owner@qq.com');
  assert.equal(JSON.stringify(payload).includes('authorization'), false);
  assert.deepEqual(value.calls[0], ['search', { query: 'invoice', unreadOnly: true, limit: 10 }]);
});

test('mail tool maps read, attachment, draft, reply and send inputs', async () => {
  const value = host();
  await executeMailTool(value, 'bot-owner', 'mail_read', {
    connection_id: connection.id, message_id: 'qq:42'
  });
  await executeMailTool(value, 'bot-owner', 'mail_get_attachment', {
    connection_id: connection.id, message_id: 'qq:42', attachment_id: '1'
  });
  await executeMailTool(value, 'bot-owner', 'mail_create_draft', {
    connection_id: connection.id, to: ['to@example.com'], subject: '草稿', text: '正文'
  });
  await executeMailTool(value, 'bot-owner', 'mail_reply', {
    connection_id: connection.id, message_id: 'qq:42', text: '收到', reply_all: true
  });
  await executeMailTool(value, 'bot-owner', 'mail_send', {
    connection_id: connection.id, to: ['to@example.com'], subject: '标题', text: '正文'
  });
  assert.deepEqual(value.calls.map(call => call[0]), ['read', 'attachment', 'draft', 'reply', 'send']);
  assert.deepEqual(value.calls[0][1], 'qq:42');
  assert.deepEqual(value.calls[1][1], { id: 'qq:42', attachmentId: '1' });
  assert.deepEqual(value.calls[2][1], {
    to: ['to@example.com'], subject: '草稿', text: '正文'
  });
  assert.deepEqual(value.calls[3][1], { id: 'qq:42', text: '收到', replyAll: true });
  assert.deepEqual(value.calls[4][1], {
    to: ['to@example.com'], subject: '标题', text: '正文'
  });
});

test('mail tool rejects unauthorized or malformed connection calls without falling back', async () => {
  const value = host();
  const denied = await executeMailTool(value, 'bot-owner', 'mail_search', {
    connection_id: '11111111-1111-4111-8111-111111111111'
  });
  assert.equal(denied.success, false);
  assert.match(denied.contentItems[0].text, /权限/u);
  const malformed = await executeMailTool(value, 'bot-owner', 'mail_read', {
    connection_id: connection.id
  });
  assert.equal(malformed.success, false);
  assert.match(malformed.contentItems[0].text, /message_id/u);
});

test('mail connection directory shows only granted ready connections for the current Bot', () => {
  const directory = mailConnectionDirectory(
    [connection, { ...connection, id: 'unready', status: 'expired' }],
    [{ id: 'grant', botId: 'bot-owner', connectionId: connection.id, createdAt: '' }],
    'bot-owner',
    providerId => providerId === 'qqmail' ? 'QQ 邮箱' : providerId
  );
  assert.deepEqual(directory, [{
    connection_id: connection.id,
    provider: 'qqmail',
    provider_name: 'QQ 邮箱',
    account: 'owner@qq.com',
    display_name: '工作 QQ 邮箱',
    default_sender: true
  }]);
});
