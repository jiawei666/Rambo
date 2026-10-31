import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';

const source = readFileSync(new URL('../../src/main/connector-credentials.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText.replace(
  "from 'node:sqlite'",
  "from 'node:sqlite'"
).replace(
  "from './platform/fs'",
  "from './platform/fs.mjs'"
);
const platformFsSource = readFileSync(
  new URL('../../src/main/platform/fs.ts', import.meta.url),
  'utf8'
);
const compiledPlatformFs = ts.transpileModule(platformFsSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

test('connector credentials do not depend on Electron safeStorage or Keychain', () => {
  assert.doesNotMatch(source, /safeStorage|safe-storage|find-(?:generic|internet)-password/iu);
  assert.match(source, /createCipheriv\('aes-256-gcm'/u);
});

async function withModule(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-credentials-test-'));
  const modulePath = join(directory, 'connector-credentials.mjs');
  const { writeFileSync } = await import('node:fs');
  mkdirSync(join(directory, 'platform'));
  writeFileSync(join(directory, 'platform', 'fs.mjs'), compiledPlatformFs, { mode: 0o600 });
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  try {
    const module = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    await run(module, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fakeCipher() {
  return {
    available: () => true,
    encrypt: value => Buffer.from(`sealed:${value}`, 'utf8'),
    decrypt: value => {
      const text = value.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('wrong key');
      return text.slice('sealed:'.length);
    }
  };
}

const connectionId = '1b72665d-e842-43ef-8d95-81022d343a80';

test('connector credentials encrypt into SQLite, use a local key and delete only one record', async () => {
  await withModule(async ({ ConnectorCredentials, ConnectorCredentialsError }, directory) => {
    const store = new ConnectorCredentials(join(directory, 'profile'));
    const reference = store.save(connectionId, {
      kind: 'imap-password',
      email: 'person@qq.com',
      password: 'qq-authorization-code'
    });
    assert.match(reference, /^db:[a-f0-9-]{36}$/u);
    const files = readdirSync(join(directory, 'profile', 'connector-credentials'));
    assert.deepEqual(files.sort(), ['credential-key', 'credentials.sqlite', 'credentials.sqlite-shm', 'credentials.sqlite-wal'].filter(name => files.includes(name)).sort());
    const keyFile = join(directory, 'profile', 'connector-credentials', 'credential-key');
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    const databaseFile = join(directory, 'profile', 'connector-credentials', 'credentials.sqlite');
    assert.equal(statSync(databaseFile).mode & 0o777, 0o600);
    const database = new DatabaseSync(databaseFile);
    const stored = database.prepare(
      'SELECT body FROM connector_credentials WHERE reference=?'
    ).get(reference);
    database.close();
    assert.equal(String(stored.body).includes('qq-authorization-code'), false);
    assert.equal(store.load(reference).password, 'qq-authorization-code');
    assert.throws(() => store.load('db:../../outside'), ConnectorCredentialsError);
    const rejectedReference = `el${'ectron'}:${connectionId}`;
    assert.throws(() => store.load(rejectedReference), /连接凭证引用无效/u);
    assert.throws(() => store.replace(rejectedReference, {
      kind: 'imap-password',
      email: 'person@qq.com',
      password: 'replacement'
    }), /连接凭证不存在/u);

    const otherReference = store.save('1b72665d-e842-43ef-8d95-81022d343a81', {
      kind: 'imap-password',
      email: 'other@qq.com',
      password: 'other-code'
    });
    store.delete(reference);
    assert.throws(() => store.load(reference), /不存在/u);
    assert.equal(store.load(otherReference).email, 'other@qq.com');
    store.close();
  });
});

test('connector credentials reuse the same local key after restart', async () => {
  await withModule(async ({ ConnectorCredentials }, directory) => {
    const profile = join(directory, 'profile');
    const first = new ConnectorCredentials(profile);
    const reference = first.save(connectionId, {
      kind: 'imap-password',
      email: 'person@qq.com',
      password: 'persisted-secret'
    });
    first.close();

    const reopened = new ConnectorCredentials(profile);
    assert.equal(reopened.load(reference).password, 'persisted-secret');
    reopened.close();
  });
});

test('connector credentials refuse to save or load without an available local cipher', async () => {
  await withModule(async ({ ConnectorCredentials, ConnectorCredentialsError }, directory) => {
    const unavailable = { ...fakeCipher(), available: () => false };
    const store = new ConnectorCredentials(directory, unavailable);
    assert.throws(() => store.save(connectionId, {
      kind: 'imap-password',
      email: 'person@qq.com',
      password: 'secret'
    }), ConnectorCredentialsError);
    store.close();
  });
});

test('connector credentials report a decrypt failure without returning partial secrets', async () => {
  await withModule(async ({ ConnectorCredentials }, directory) => {
    const store = new ConnectorCredentials(directory, fakeCipher());
    const reference = store.save(connectionId, {
      kind: 'oauth-token',
      email: 'person@gmail.com',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2026-10-24T00:00:00.000Z',
      scope: 'https://www.googleapis.com/auth/gmail.modify',
      tokenType: 'Bearer',
      oauthClientId: 'person-project.apps.googleusercontent.com',
      oauthClientSecret: 'person-oauth-secret'
    });
    const wrongCipher = {
      ...fakeCipher(),
      decrypt: () => { throw new Error('key unavailable'); }
    };
    const broken = new ConnectorCredentials(directory, wrongCipher);
    assert.throws(() => broken.load(reference), /解密失败/u);
    const raw = readFileSync(join(directory, 'connector-credentials', 'credentials.sqlite'), 'utf8');
    assert.equal(raw.includes('person-oauth-secret'), false);
    store.close();
    broken.close();
  });
});

test('connector credentials replace an OAuth token without changing its reference', async () => {
  await withModule(async ({ ConnectorCredentials }, directory) => {
    const store = new ConnectorCredentials(directory, fakeCipher());
    const reference = store.save(connectionId, {
      kind: 'oauth-token', email: 'person@gmail.com', accessToken: 'first',
      refreshToken: 'refresh', expiresAt: '2026-10-24T00:00:00.000Z',
      scope: 'gmail.modify', tokenType: 'Bearer',
      oauthClientId: 'person-project.apps.googleusercontent.com',
      oauthClientSecret: 'person-oauth-secret'
    });
    store.replace(reference, {
      kind: 'oauth-token', email: 'person@gmail.com', accessToken: 'second',
      refreshToken: 'refresh', expiresAt: '2026-10-25T00:00:00.000Z',
      scope: 'gmail.modify', tokenType: 'Bearer',
      oauthClientId: 'person-project.apps.googleusercontent.com',
      oauthClientSecret: 'person-oauth-secret'
    });
    const loaded = store.load(reference);
    assert.equal(loaded.accessToken, 'second');
    assert.match(reference, /^db:/u);
    store.close();
  });
});

test('MCP header and environment secrets are encrypted as one opaque credential payload', async () => {
  await withModule(async ({ ConnectorCredentials, ConnectorCredentialsError }, directory) => {
    const store = new ConnectorCredentials(join(directory, 'profile'), fakeCipher());
    const reference = store.save(connectionId, {
      kind: 'mcp-secrets',
      serverName: 'fixture-mcp',
      headers: { Authorization: 'Bearer header-secret' },
      env: { API_TOKEN: 'env-secret' }
    });
    assert.deepEqual(store.load(reference), {
      kind: 'mcp-secrets',
      serverName: 'fixture-mcp',
      headers: { Authorization: 'Bearer header-secret' },
      env: { API_TOKEN: 'env-secret' }
    });
    const raw = readFileSync(join(directory, 'profile', 'connector-credentials', 'credentials.sqlite'), 'utf8');
    assert.equal(raw.includes('header-secret'), false);
    assert.equal(raw.includes('env-secret'), false);
    assert.throws(() => store.save(connectionId, {
      kind: 'mcp-secrets',
      serverName: 'fixture-mcp',
      headers: { 'Bad\nHeader': 'value' },
      env: {}
    }), ConnectorCredentialsError);
    store.close();
  });
});

test('model API keys are encrypted and reject malformed provider payloads', async () => {
  await withModule(async ({ ConnectorCredentials, ConnectorCredentialsError }, directory) => {
    const store = new ConnectorCredentials(join(directory, 'profile'));
    const reference = store.save(connectionId, {
      kind: 'model-api-key',
      providerId: 'rambo_manual',
      apiKey: 'sk-model-secret'
    });
    assert.deepEqual(store.load(reference), {
      kind: 'model-api-key',
      providerId: 'rambo_manual',
      apiKey: 'sk-model-secret'
    });
    const database = new DatabaseSync(join(directory, 'profile', 'connector-credentials', 'credentials.sqlite'));
    const stored = database.prepare('SELECT body FROM connector_credentials WHERE reference=?').get(reference);
    database.close();
    assert.equal(String(stored.body).includes('sk-model-secret'), false);
    assert.throws(() => store.save(connectionId, {
      kind: 'model-api-key',
      providerId: 'bad provider/id',
      apiKey: 'sk-model-secret'
    }), ConnectorCredentialsError);
    assert.throws(() => store.save(connectionId, {
      kind: 'model-api-key',
      providerId: 'rambo_manual',
      apiKey: '   '
    }), /模型 API 凭证格式无效/u);
  });
});

test('generic Bot secrets use the same encrypted store and never persist plaintext', async () => {
  await withModule(async ({ ConnectorCredentials, ConnectorCredentialsError }, directory) => {
    const profile = join(directory, 'profile');
    const store = new ConnectorCredentials(profile);
    const reference = store.save(connectionId, {
      kind: 'generic-secret',
      name: 'Deployment token',
      secret: 'generic-secret-value-93821'
    });
    assert.match(reference, /^db:/u);
    assert.deepEqual(store.load(reference), {
      kind: 'generic-secret',
      name: 'Deployment token',
      secret: 'generic-secret-value-93821'
    });
    const database = new DatabaseSync(join(profile, 'connector-credentials', 'credentials.sqlite'));
    const stored = database.prepare('SELECT body FROM connector_credentials WHERE reference=?').get(reference);
    database.close();
    assert.equal(String(stored.body).includes('generic-secret-value-93821'), false);
    store.close();

    const reopened = new ConnectorCredentials(profile);
    try {
      assert.equal(reopened.load(reference).secret, 'generic-secret-value-93821');
      assert.throws(() => reopened.save(connectionId, {
        kind: 'generic-secret',
        name: 'Invalid',
        secret: 'bad\0value'
      }), ConnectorCredentialsError);
    } finally { reopened.close(); }
  });
});

test('WeChat SQLCipher credentials round-trip an absolute account directory and reject invalid key material', async () => {
  await withModule(async ({ ConnectorCredentials, ConnectorCredentialsError }, directory) => {
    const store = new ConnectorCredentials(directory, fakeCipher());
    const reference = store.save(connectionId, {
      kind: 'wechat-sqlcipher',
      accountId: 'wxid_example',
      keys: {
        'session/session.db': {
          encKey: 'ab'.repeat(32),
          salt: 'cd'.repeat(16)
        },
        'message/message_0.db': {
          encKey: 'ef'.repeat(32),
          salt: '12'.repeat(16)
        }
      },
      dataDirectory: '/Users/example/Library/Containers/com.tencent.xinWeChat/Data/Profile',
      wechatVersion: '4.1.15',
      wechatBuild: '270135',
      imageKey: { aesKey: '0123456789abcdef', xorKey: 82 }
    });
    assert.deepEqual(store.load(reference), {
      kind: 'wechat-sqlcipher',
      accountId: 'wxid_example',
      keys: {
        'session/session.db': {
          encKey: 'ab'.repeat(32),
          salt: 'cd'.repeat(16)
        },
        'message/message_0.db': {
          encKey: 'ef'.repeat(32),
          salt: '12'.repeat(16)
        }
      },
      dataDirectory: '/Users/example/Library/Containers/com.tencent.xinWeChat/Data/Profile',
      wechatVersion: '4.1.15',
      wechatBuild: '270135',
      imageKey: { aesKey: '0123456789abcdef', xorKey: 82 }
    });
    const validKeys = { 'session/session.db': { encKey: 'ab'.repeat(32), salt: 'cd'.repeat(16) } };
    for (const payload of [
      { accountId: 'wxid', keys: {}, dataDirectory: '/tmp/wechat', wechatVersion: '4.1.15', wechatBuild: '270135' },
      { accountId: 'wxid', keys: { '../outside.db': { encKey: 'ab'.repeat(32), salt: null } }, dataDirectory: '/tmp/wechat', wechatVersion: '4.1.15', wechatBuild: '270135' },
      { accountId: 'wxid', keys: { 'session/session.db': { encKey: 'abcd', salt: null } }, dataDirectory: '/tmp/wechat', wechatVersion: '4.1.15', wechatBuild: '270135' },
      { accountId: 'wxid', keys: validKeys, dataDirectory: 'relative/profile', wechatVersion: '4.1.15', wechatBuild: '270135' },
      { accountId: 'wxid', keys: validKeys, dataDirectory: '/tmp/wechat', wechatVersion: '', wechatBuild: '270135' },
      { accountId: 'wxid', keys: validKeys, dataDirectory: '/tmp/wechat', wechatVersion: '4.1.15', wechatBuild: '' },
      { accountId: 'wxid', keys: validKeys, dataDirectory: '/tmp/wechat', wechatVersion: '4.1.15', wechatBuild: '270135', imageKey: { aesKey: 'short', xorKey: 82 } },
      { accountId: 'wxid', keys: validKeys, dataDirectory: '/tmp/wechat', wechatVersion: '4.1.15', wechatBuild: '270135', imageKey: { aesKey: '0123456789abcdef', xorKey: 256 } }
    ]) {
      assert.throws(() => store.save(connectionId, {
        kind: 'wechat-sqlcipher', ...payload
      }), ConnectorCredentialsError);
    }
    store.close();
  });
});
