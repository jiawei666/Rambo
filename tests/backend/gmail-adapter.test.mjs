import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/gmail-adapter.ts', import.meta.url), 'utf8');
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const dependencies = {
  'connector-credentials': readFileSync(new URL('../../src/main/connector-credentials.ts', import.meta.url), 'utf8'),
  'gmail-oauth': readFileSync(new URL('../../src/main/gmail-oauth.ts', import.meta.url), 'utf8'),
  'mail-adapter': readFileSync(new URL('../../src/main/mail-adapter.ts', import.meta.url), 'utf8'),
  'contracts': readFileSync(new URL('../../src/shared/contracts.ts', import.meta.url), 'utf8')
};
const compiled = ts.transpileModule(source, { compilerOptions }).outputText
  .replaceAll("from '../shared/contracts'", "from 'data:text/javascript;base64,' + 'contracts'")
  .replaceAll("from './connector-credentials'", "from 'data:text/javascript;base64,' + 'connector-credentials'")
  .replaceAll("from './gmail-oauth'", "from 'data:text/javascript;base64,' + 'gmail-oauth'")
  .replaceAll("from './mail-adapter'", "from 'data:text/javascript;base64,' + 'mail-adapter'");
const contractsUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(dependencies.contracts, { compilerOptions }).outputText).toString('base64')}`;
const mailAdapterUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(dependencies['mail-adapter'], { compilerOptions }).outputText).toString('base64')}`;
const connectorCredentialsUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(dependencies['connector-credentials'], { compilerOptions }).outputText).toString('base64')}`;
const gmailOAuthUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(dependencies['gmail-oauth'], { compilerOptions }).outputText.replace("from '../shared/contracts'", `from '${contractsUrl}'`)).toString('base64')}`;
const executable = compiled
  .replace("from 'data:text/javascript;base64,' + 'contracts'", `from '${contractsUrl}'`)
  .replace("from 'data:text/javascript;base64,' + 'connector-credentials'", `from '${connectorCredentialsUrl}'`)
  .replace("from 'data:text/javascript;base64,' + 'gmail-oauth'", `from '${gmailOAuthUrl}'`)
  .replace("from 'data:text/javascript;base64,' + 'mail-adapter'", `from '${mailAdapterUrl}'`);
const { GmailApiAdapter } = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);

const connection = {
  id: '2a555dcf-6b3b-4eca-a098-c58e20f64d64',
  providerId: 'gmail',
  displayName: '个人 Gmail',
  accountLabel: 'person@gmail.com',
  authKind: 'oauth-desktop',
  status: 'ready',
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z'
};

const credential = {
  kind: 'oauth-token',
  email: 'person@gmail.com',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: '2026-10-24T00:00:00.000Z',
  scope: 'gmail.modify',
  tokenType: 'Bearer',
  oauthClientId: 'rambo-test.apps.googleusercontent.com',
  oauthClientSecret: 'test-client-secret'
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function adapterWith(fetchImpl, tokenSaver = () => {}, now = () => Date.parse('2026-10-23T00:00:00.000Z')) {
  return new GmailApiAdapter(connection, credential, {
    fetch: fetchImpl,
    now,
    saveToken: tokenSaver
  });
}

test('Gmail adapter maps search filters and returns normalized message identity', async () => {
  const calls = [];
  const client = adapterWith(async (url, init) => {
    calls.push([String(url), init]);
    if (String(url).includes('/messages?')) return json({ messages: [{ id: 'abc_123' }] });
    return json({
      id: 'abc_123', threadId: 'thread-9', labelIds: ['UNREAD'], snippet: 'Please review',
      internalDate: String(Date.parse('2026-10-22T12:00:00.000Z')),
      payload: { headers: [
        { name: 'Subject', value: 'Invoice' },
        { name: 'From', value: 'Billing <billing@example.com>' },
        { name: 'To', value: 'person@gmail.com' },
        { name: 'Date', value: 'Tue, 22 Oct 2026 12:00:00 +0000' }
      ] }
    });
  });
  const result = await client.search(connection, {
    query: 'invoice', from: 'billing@example.com', subject: 'October bill',
    since: '2026-10-01', unreadOnly: true, limit: 5
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: 'gmail:abc_123', threadId: 'thread-9', subject: 'Invoice',
    from: 'Billing <billing@example.com>', to: ['person@gmail.com'],
    date: '2026-10-22T12:00:00.000Z', snippet: 'Please review',
    unread: true, hasAttachments: false
  });
  const searchUrl = new URL(calls[0][0]);
  assert.equal(searchUrl.searchParams.get('maxResults'), '5');
  assert.equal(searchUrl.searchParams.get('q'), 'invoice from:billing@example.com subject:"October bill" after:2026/10/01 is:unread');
  assert.match(calls[0][1].headers.authorization, /^Bearer access-token$/u);
});

test('Gmail adapter reads body, decodes attachment data and preserves reply headers', async () => {
  const calls = [];
  const original = {
    id: 'original_1', threadId: 'thread-1', labelIds: ['INBOX'], snippet: 'Original',
    internalDate: String(Date.parse('2026-10-22T12:00:00.000Z')),
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'Subject', value: 'Question' },
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'To', value: 'person@gmail.com' },
        { name: 'Message-ID', value: '<original@example.com>' },
        { name: 'References', value: '<root@example.com> <original@example.com>' }
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Hello there').toString('base64url') } },
        { partId: '2', mimeType: 'application/pdf', filename: 'report.pdf',
          body: { attachmentId: 'att_1', size: 3 } }
      ]
    }
  };
  const client = adapterWith(async (url, init) => {
    calls.push([String(url), init]);
    if (String(url).includes('/attachments/')) return json({ data: Buffer.from('PDF').toString('base64url') });
    if (String(url).includes('/messages/send')) return json({ id: 'sent_1' });
    return json(original);
  });
  const message = await client.read(connection, 'gmail:original_1');
  assert.equal(message.text, 'Hello there');
  assert.equal(message.messageId, '<original@example.com>');
  assert.deepEqual(message.references, ['<root@example.com>', '<original@example.com>']);
  assert.equal(message.attachments[0].id, '2');
  const attachment = await client.getAttachment(connection, {
    id: 'gmail:original_1', attachmentId: 'att_1'
  });
  assert.equal(attachment.filename, 'report.pdf');
  assert.equal(attachment.dataBase64, Buffer.from('PDF').toString('base64'));
  const sent = await client.reply(connection, { id: 'gmail:original_1', text: 'Thanks' });
  assert.equal(sent.messageId, 'gmail:sent_1');
  const sendCall = calls.find(([url]) => url.includes('/messages/send'));
  const body = JSON.parse(sendCall[1].body);
  assert.equal(body.threadId, 'thread-1');
  const raw = Buffer.from(body.raw, 'base64url').toString('utf8');
  assert.match(raw, /^To: alice@example\.com$/mu);
  assert.match(raw, /^In-Reply-To: <original@example\.com>$/mu);
  assert.match(raw, /^References: <root@example\.com> <original@example\.com>$/mu);
  assert.match(raw, /^Subject: Re: Question$/mu);
});

test('Gmail adapter refreshes an expired token once, persists it and retries the request', async () => {
  let refreshCalls = 0;
  let persisted = null;
  const calls = [];
  const client = adapterWith(async (url, init) => {
    calls.push([String(url), init]);
    if (String(url).includes('oauth2.googleapis.com/token')) {
      refreshCalls += 1;
      return json({ access_token: 'fresh-access', token_type: 'Bearer', expires_in: 3600, scope: 'gmail.modify' });
    }
    return json({ emailAddress: 'person@gmail.com', historyId: '1' });
  }, (_connectionId, token) => { persisted = token; }, () => Date.parse('2026-10-24T00:00:00.000Z'));
  await client.verify(connection);
  assert.equal(refreshCalls, 1);
  assert.equal(persisted.accessToken, 'fresh-access');
  assert.equal(persisted.refreshToken, 'refresh-token');
  const refreshBody = String(calls.find(([url]) => url.includes('oauth2.googleapis.com/token'))[1].body);
  assert.equal(new URLSearchParams(refreshBody).get('client_id'), 'rambo-test.apps.googleusercontent.com');
  assert.equal(new URLSearchParams(refreshBody).get('client_secret'), 'test-client-secret');
  assert.equal(persisted.oauthClientId, 'rambo-test.apps.googleusercontent.com');
  assert.equal(persisted.oauthClientSecret, 'test-client-secret');
  assert.match(calls.at(-1)[1].headers.authorization, /^Bearer fresh-access$/u);
});

test('Gmail adapter saves drafts without sending and preserves an explicit thread', async () => {
  const calls = [];
  const client = adapterWith(async (url, init) => {
    calls.push([String(url), init]);
    return json({ id: 'draft-1', message: { id: 'message-1' } });
  });
  const result = await client.createDraft(connection, {
    to: ['person@example.com'],
    subject: 'Draft subject',
    text: 'Draft body',
    threadId: 'thread-7'
  });
  assert.deepEqual(result, { draftId: 'gmail-draft:draft-1', messageId: 'gmail:message-1' });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(new URL(url).pathname.endsWith('/drafts'), true);
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  assert.equal(body.message.threadId, 'thread-7');
  assert.equal(typeof body.message.raw, 'string');
  assert.equal(calls.some(([callUrl]) => String(callUrl).includes('/messages/send')), false);
});

test('Gmail adapter fails closed for wrong accounts, malformed IDs and oversized attachments', async () => {
  const client = adapterWith(async () => json({}));
  await assert.rejects(adapterWith(async () => json({ emailAddress: 'other@gmail.com' })).verify(connection), /不一致/u);
  await assert.rejects(client.read(connection, 'qq:1'), /邮件 ID 无效/u);
  const oversized = adapterWith(async url => {
    if (String(url).includes('/attachments/')) return json({ data: 'AA==' });
    return json({
      id: 'abc', payload: { parts: [{
        partId: '1', mimeType: 'text/plain', filename: 'big.bin',
        body: { attachmentId: 'att_big', size: 9 * 1024 * 1024 }
      }] }
    });
  });
  await assert.rejects(
    oversized.getAttachment(connection, { id: 'gmail:abc', attachmentId: 'att_big' }),
    /8 MiB/u
  );
});
