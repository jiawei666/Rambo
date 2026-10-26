import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/qq-mail-adapter.ts', import.meta.url), 'utf8');
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const mailAdapter = readFileSync(new URL('../../src/main/mail-adapter.ts', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('../../src/shared/contracts.ts', import.meta.url), 'utf8');
const stubs = {
  imapflow: 'export class ImapFlow {}',
  mailparser: 'export async function simpleParser() { return {}; }',
  nodemailer: 'export function createTransport() { return { sendMail: async () => ({ message: Buffer.from("MIME") }) }; }'
};
const stubUrls = Object.fromEntries(Object.entries(stubs).map(([name, code]) => [
  name, `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
]));
const mailAdapterUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(mailAdapter, { compilerOptions }).outputText).toString('base64')}`;
const contractsUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(contracts, { compilerOptions }).outputText).toString('base64')}`;
const executable = ts.transpileModule(source, { compilerOptions }).outputText
  .replace("from '../shared/contracts'", `from '${contractsUrl}'`)
  .replace("from './mail-adapter'", `from '${mailAdapterUrl}'`)
  .replace("from 'imapflow'", `from '${stubUrls.imapflow}'`)
  .replace("from 'mailparser'", `from '${stubUrls.mailparser}'`)
  .replace("from 'nodemailer'", `from '${stubUrls.nodemailer}'`);
const { QQMailAdapter } = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);

const connection = {
  id: '1b0f4a17-7a14-4f56-a1a1-7af19d7d55c8',
  providerId: 'qqmail',
  displayName: 'QQ 邮箱',
  accountLabel: 'owner@qq.com',
  authKind: 'credentials',
  status: 'ready',
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z'
};
const credential = { kind: 'imap-password', email: 'owner@qq.com', password: 'authorization-code' };

test('QQ adapter saves a draft into Drafts without sending it', async () => {
  const calls = [];
  const client = {
    async connect() { calls.push(['connect']); },
    async getMailboxLock(mailbox) { calls.push(['lock', mailbox]); return { release() { calls.push(['release']); } }; },
    async append(mailbox, raw, flags) {
      calls.push(['append', mailbox, Buffer.from(raw).toString('utf8'), flags]);
      return { uid: 123 };
    },
    async logout() { calls.push(['logout']); }
  };
  const adapter = new QQMailAdapter(connection, credential, { imapClient: () => client });
  const result = await adapter.createDraft(connection, {
    to: ['person@example.com'], subject: 'QQ 草稿', text: '草稿正文'
  });
  assert.deepEqual(result, { draftId: 'qq-draft:123' });
  assert.deepEqual(calls.map(call => call[0]), ['connect', 'lock', 'append', 'release', 'logout']);
  assert.equal(calls[1][1], 'Drafts');
  assert.equal(calls[2][1], 'Drafts');
  assert.equal(calls[2][2], 'MIME');
  assert.deepEqual(calls[2][3], ['\\Draft']);
});
