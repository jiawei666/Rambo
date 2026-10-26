import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/bot-credential-tools.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
  BotCredentialInputError,
  normalizeBotCredentialInput,
  redactCredentialError
} = await import(moduleUrl);

const qqConnection = {
  id: '1b72665d-e842-43ef-8d95-81022d343a80',
  providerId: 'qqmail',
  displayName: '工作邮箱',
  accountLabel: 'person@qq.com',
  authKind: 'credentials',
  status: 'ready',
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z'
};

test('credential input normalizes only supported QQ and Gmail new-connection payloads', () => {
  assert.deepEqual(normalizeBotCredentialInput({
    provider_id: 'qqmail',
    display_name: ' 工作 QQ ',
    email: '  Person@QQ.com ',
    secret: ' auth-code '
  }), {
    connectionId: null,
    providerId: 'qqmail',
    displayName: '工作 QQ',
    email: 'person@qq.com',
    payload: {
      kind: 'imap-password',
      email: 'person@qq.com',
      password: 'auth-code'
    }
  });

  assert.deepEqual(normalizeBotCredentialInput({
    provider_id: 'gmail',
    display_name: 'Gmail',
    email: 'person@gmail.com',
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: '2026-10-27T00:00:00.000Z'
  }), {
    connectionId: null,
    providerId: 'gmail',
    displayName: 'Gmail',
    email: 'person@gmail.com',
    payload: {
      kind: 'oauth-token',
      email: 'person@gmail.com',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: '2026-10-27T00:00:00.000Z',
      scope: 'gmail.modify',
      tokenType: 'Bearer'
    }
  });
});

test('credential input rejects malformed, mixed, and cross-account updates', () => {
  const cases = [
    [{ provider_id: 'qqmail', display_name: 'QQ', email: 'not-an-email', secret: 'code' }, /有效的邮箱/u],
    [{ provider_id: 'unsupported', display_name: 'X', email: 'x@example.com', secret: 'code' }, /只支持/u],
    [{ provider_id: 'qqmail', display_name: 'QQ', email: 'x@qq.com', secret: 'code', access_token: 'token' }, /不接受 OAuth/u],
    [{ provider_id: 'gmail', display_name: 'Gmail', email: 'x@gmail.com', access_token: 'token', secret: 'code' }, /不接受 secret/u],
    [{ provider_id: 'qqmail', display_name: 'QQ', email: 'x@qq.com', secret: 'code', extra: 'value' }, /不支持凭证字段/u],
    [{ provider_id: 'qqmail', display_name: 'QQ', email: 'x@qq.com', secret: '   ' }, /QQ 邮箱授权码/u]
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => normalizeBotCredentialInput(input), pattern);
  }

  assert.throws(() => normalizeBotCredentialInput({
    connection_id: qqConnection.id,
    provider_id: 'gmail',
    email: qqConnection.accountLabel,
    access_token: 'token'
  }, qqConnection), /token|连接/u);
  assert.throws(() => normalizeBotCredentialInput({
    connection_id: qqConnection.id,
    provider_id: 'qqmail',
    display_name: 'Other account',
    email: 'other@qq.com',
    secret: 'code'
  }, qqConnection), /邮箱账号必须与已有连接一致/u);
  assert.throws(() => normalizeBotCredentialInput({
    connection_id: 'another-id',
    email: qqConnection.accountLabel,
    secret: 'code'
  }, qqConnection), /连接 ID 与已有连接不匹配/u);
});

test('credential updates retain the existing account and never infer a replacement connection', () => {
  assert.deepEqual(normalizeBotCredentialInput({
    connection_id: qqConnection.id,
    email: 'PERSON@qq.com',
    secret: 'replacement'
  }, qqConnection), {
    connectionId: qqConnection.id,
    providerId: 'qqmail',
    displayName: null,
    email: 'person@qq.com',
    payload: {
      kind: 'imap-password',
      email: 'person@qq.com',
      password: 'replacement'
    }
  });
});

test('credential errors remove supplied secrets and secret-like parameters before display', () => {
  const message = redactCredentialError(
    new Error('login failed for qq-secret and access_token=token-secret password: password-secret'),
    ['qq-secret', 'token-secret']
  );
  assert.equal(message, 'login failed for [已隐藏] and [已隐藏] [已隐藏]');
  assert.match(redactCredentialError('', []), /连接验证失败/u);
  assert.ok(redactCredentialError(new Error('x'.repeat(700)), []).length <= 500);
  assert.throws(() => normalizeBotCredentialInput(null), BotCredentialInputError);
});
