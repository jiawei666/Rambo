import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/mail-runtime.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { MailRuntime } = await import(moduleUrl);

function connection(id, providerId = 'qqmail') {
  return {
    id,
    providerId,
    displayName: id,
    accountLabel: `${id}@${providerId === 'gmail' ? 'gmail.com' : 'qq.com'}`,
    authKind: 'credentials',
    status: 'ready',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z'
  };
}

test('MailRuntime serializes calls per connection while allowing different connections to run independently', async () => {
  const active = new Map();
  const events = [];
  let globalActive = 0;
  let maxGlobalActive = 0;
  let factoryCalls = 0;
  const adapters = {
    async adapter(value) {
      factoryCalls += 1;
      return {
        providerId: value.providerId,
        async search() { return []; },
        async read() { throw new Error('unused'); },
        async getAttachment() { throw new Error('unused'); },
        async reply() { throw new Error('unused'); },
        async send() { throw new Error('unused'); },
        async verify() {
          const current = (active.get(value.id) ?? 0) + 1;
          active.set(value.id, current);
          assert.equal(current, 1, 'same connection must not overlap');
          globalActive += 1;
          maxGlobalActive = Math.max(maxGlobalActive, globalActive);
          events.push(`start:${value.id}`);
          await new Promise(resolve => setTimeout(resolve, 20));
          active.set(value.id, 0);
          globalActive -= 1;
          events.push(`end:${value.id}`);
        }
      };
    }
  };
  const runtime = new MailRuntime(adapters);
  const a = connection('a');
  const b = connection('b');
  await Promise.all([
    runtime.withAdapter(a, adapter => adapter.verify(a)),
    runtime.withAdapter(a, adapter => adapter.verify(a)),
    runtime.withAdapter(b, adapter => adapter.verify(b))
  ]);
  assert.equal(events.filter(event => event === 'start:a').length, 2);
  assert.equal(events.filter(event => event === 'end:a').length, 2);
  assert.equal(events.filter(event => event === 'start:b').length, 1);
  assert.equal(events.filter(event => event === 'end:b').length, 1);
  assert.equal(maxGlobalActive, 2);
  assert.equal(factoryCalls, 2);
});

test('MailRuntime retries adapter creation after a failure and invalidates the cached adapter', async () => {
  let calls = 0;
  const runtime = new MailRuntime({
    async adapter() {
      calls += 1;
      if (calls === 1) throw new Error('keychain locked');
      return { verify: async () => {} };
    }
  });
  const value = connection('retry');
  await assert.rejects(runtime.withAdapter(value, () => { throw new Error('unused'); }), /keychain locked/u);
  await runtime.withAdapter(value, adapter => adapter.verify());
  assert.equal(calls, 2);
});

test('MailRuntime validates an ephemeral credential without caching its adapter', async () => {
  let factoryCalls = 0;
  let storedCalls = 0;
  let storedCredentialCalls = 0;
  const runtime = new MailRuntime({
    async adapter() {
      storedCalls += 1;
      return { verify: async () => {} };
    },
    loadStoredCredential() {
      storedCredentialCalls += 1;
      return {
        kind: 'oauth-token',
        email: 'pending-update@gmail.com',
        accessToken: 'stored-access',
        refreshToken: 'stored-refresh',
        expiresAt: null,
        scope: 'gmail.modify',
        tokenType: 'Bearer',
        oauthClientId: 'stored-project.apps.googleusercontent.com',
        oauthClientSecret: 'stored-oauth-secret'
      };
    },
    async adapterForCredential(_connection, credential, storedCredential) {
      factoryCalls += 1;
      assert.equal(credential.kind, 'oauth-token');
      assert.equal(storedCredential.kind, 'oauth-token');
      return { verify: async () => {} };
    }
  });
  const value = connection('pending-update', 'gmail');
  const credential = {
    kind: 'oauth-token',
    email: value.accountLabel,
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: null,
    scope: 'gmail.modify',
    tokenType: 'Bearer'
  };
  await runtime.withCredentialAdapter(value, credential, adapter => adapter.verify(value));
  await runtime.withCredentialAdapter(value, credential, adapter => adapter.verify(value));
  assert.equal(factoryCalls, 2);
  assert.equal(storedCredentialCalls, 2);
  assert.equal(storedCalls, 0);
});
