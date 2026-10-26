import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const source = readFileSync(new URL('../../src/main/gmail-imap-adapter.ts', import.meta.url), 'utf8');
const baseSource = readFileSync(new URL('../../src/main/imap-smtp-mail-adapter.ts', import.meta.url), 'utf8');
const mailAdapter = readFileSync(new URL('../../src/main/mail-adapter.ts', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('../../src/shared/contracts.ts', import.meta.url), 'utf8');
const stubs = {
  imapflow: 'export class ImapFlow {}',
  mailparser: 'export async function simpleParser() { return { attachments: [] }; }',
  nodemailer: `export function createTransport(config) {
    globalThis.__ramboGmailTransports ??= [];
    globalThis.__ramboGmailTransports.push(config);
    return {
      verify: async () => true,
      sendMail: async () => ({ message: Buffer.from('MIME'), messageId: '<sent@example.com>', accepted: ['to@example.com'] }),
      close() {}
    };
  }`
};
const stubUrls = Object.fromEntries(Object.entries(stubs).map(([name, code]) => [
  name, `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
]));
const moduleUrl = sourceText => `data:text/javascript;base64,${Buffer.from(sourceText).toString('base64')}`;
const mailAdapterUrl = moduleUrl(ts.transpileModule(mailAdapter, { compilerOptions }).outputText);
const contractsUrl = moduleUrl(ts.transpileModule(contracts, { compilerOptions }).outputText);
const baseExecutable = ts.transpileModule(baseSource, { compilerOptions }).outputText
  .replace("from '../shared/contracts'", `from '${contractsUrl}'`)
  .replace("from './mail-adapter'", `from '${mailAdapterUrl}'`)
  .replace("from 'imapflow'", `from '${stubUrls.imapflow}'`)
  .replace("from 'mailparser'", `from '${stubUrls.mailparser}'`)
  .replace("from 'nodemailer'", `from '${stubUrls.nodemailer}'`);
const baseUrl = moduleUrl(baseExecutable);
const executable = ts.transpileModule(source, { compilerOptions }).outputText
  .replace("from './imap-smtp-mail-adapter'", `from '${baseUrl}'`);
const { GmailImapAdapter } = await import(moduleUrl(executable));

const connection = {
  id: '2b0f4a17-7a14-4f56-a1a1-7af19d7d55c8',
  providerId: 'gmail',
  displayName: '个人 Gmail',
  accountLabel: 'owner@gmail.com',
  authKind: 'credentials',
  status: 'ready',
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z'
};
const credential = { kind: 'imap-password', email: 'owner@gmail.com', password: 'abcd efgh ijkl mnop' };

function resetTransports() {
  globalThis.__ramboGmailTransports = [];
}

test('Gmail adapter authenticates to Gmail IMAP and SMTP with the app password', async () => {
  resetTransports();
  let imapConfig;
  const client = {
    async connect() {},
    async noop() {},
    async logout() {}
  };
  const adapter = new GmailImapAdapter(connection, credential, {
    imapClient: config => { imapConfig = config; return client; }
  });
  await adapter.verify(connection);

  assert.equal(imapConfig.host, 'imap.gmail.com');
  assert.equal(imapConfig.port, 993);
  assert.equal(imapConfig.secure, true);
  assert.deepEqual(imapConfig.auth, { user: 'owner@gmail.com', pass: credential.password });
  assert.equal(globalThis.__ramboGmailTransports[0].host, 'smtp.gmail.com');
  assert.equal(globalThis.__ramboGmailTransports[0].port, 465);
  assert.equal(globalThis.__ramboGmailTransports[0].secure, true);
  assert.deepEqual(globalThis.__ramboGmailTransports[0].auth, {
    user: 'owner@gmail.com', pass: credential.password
  });
});

test('Gmail searches the localized All Mail mailbox by special use and returns Gmail-prefixed IMAP UIDs', async () => {
  const locks = [];
  const queries = [];
  const client = {
    async connect() {},
    async list() {
      return [
        { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
        { path: '[Gmail]/所有邮件', name: '所有邮件', specialUse: '\\All' },
        { path: '[Gmail]/草稿', name: '草稿', specialUse: '\\Drafts' }
      ];
    },
    async getMailboxLock(mailbox) {
      locks.push(mailbox);
      return { release() {} };
    },
    async search(query) { queries.push(query); return [27]; },
    async *fetch() {
      yield {
        uid: 27,
        envelope: {
          subject: 'Invoice',
          from: [{ address: 'sender@example.com' }],
          to: [{ address: 'owner@gmail.com' }],
          date: new Date('2026-10-25T10:00:00.000Z')
        },
        internalDate: new Date('2026-10-25T10:00:00.000Z'),
        flags: new Set(),
        bodyStructure: null,
        bodyParts: new Map([['1', Buffer.from('Payment due')]])
      };
    },
    async logout() {}
  };
  const adapter = new GmailImapAdapter(connection, credential, { imapClient: () => client });
  const results = await adapter.search(connection, { query: 'invoice', unreadOnly: true });

  assert.deepEqual(locks, ['[Gmail]/所有邮件']);
  assert.deepEqual(queries, [{ text: 'invoice', seen: false }]);
  assert.equal(results[0].id, 'gmail:27');
  assert.equal(results[0].subject, 'Invoice');
  assert.equal(results[0].unread, true);
});

test('Gmail falls back to the configured mailbox when special use is absent', async () => {
  const locks = [];
  const client = {
    async connect() {},
    async list() { return [{ path: '[Gmail]/All Mail', name: 'All Mail' }]; },
    async getMailboxLock(mailbox) {
      locks.push(mailbox);
      return { release() {} };
    },
    async search() { return []; },
    async logout() {}
  };
  const adapter = new GmailImapAdapter(connection, credential, { imapClient: () => client });

  assert.deepEqual(await adapter.search(connection, {}), []);
  assert.deepEqual(locks, ['[Gmail]/All Mail']);
});

test('Gmail drafts are appended to the Gmail Drafts label without sending', async () => {
  const calls = [];
  const client = {
    async connect() {},
    async list() {
      return [{ path: '[Gmail]/草稿', name: '草稿', specialUse: '\\Drafts' }];
    },
    async getMailboxLock(mailbox) {
      calls.push(['lock', mailbox]);
      return { release() { calls.push(['release']); } };
    },
    async append(mailbox, raw, flags) {
      calls.push(['append', mailbox, Buffer.from(raw).toString('utf8'), flags]);
      return { uid: 123 };
    },
    async logout() {}
  };
  const adapter = new GmailImapAdapter(connection, credential, { imapClient: () => client });
  const result = await adapter.createDraft(connection, {
    to: ['to@example.com'], subject: 'Draft', text: 'Draft body'
  });

  assert.deepEqual(result, { draftId: 'gmail-draft:123' });
  assert.deepEqual(calls.map(call => call[0]), ['lock', 'append', 'release']);
  assert.equal(calls[0][1], '[Gmail]/草稿');
  assert.equal(calls[1][1], '[Gmail]/草稿');
  assert.equal(calls[1][2], 'MIME');
  assert.deepEqual(calls[1][3], ['\\Draft']);
  assert.equal(globalThis.__ramboGmailTransports.at(-1).streamTransport, true);
});

test('Gmail sends mail over SMTP with the app password', async () => {
  resetTransports();
  const adapter = new GmailImapAdapter(connection, credential);
  const result = await adapter.send(connection, {
    to: ['to@example.com'], subject: 'Hello', text: 'Test'
  });

  assert.deepEqual(result, { messageId: '<sent@example.com>', accepted: ['to@example.com'] });
  assert.equal(globalThis.__ramboGmailTransports[0].host, 'smtp.gmail.com');
  assert.deepEqual(globalThis.__ramboGmailTransports[0].auth, {
    user: 'owner@gmail.com', pass: credential.password
  });
});
