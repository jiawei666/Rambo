import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/gmail-oauth.ts', import.meta.url), 'utf8');
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
const { GmailOAuth, GmailOAuthError, normalizeToken } = await import(
  `data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`
);

const challenge = {
  connectionId: 'pending:gmail:3b24bd34-95fc-4ade-8e8b-70636f26ab13',
  providerId: 'gmail',
  authKind: 'oauth-desktop',
  displayName: '个人 Gmail',
  url: 'rambo-connector://oauth/callback'
};

function randomSource() {
  let value = 0;
  return size => Buffer.alloc(size, ++value);
}

function configured(overrides = {}) {
  const base = {
    clientId: 'rambo-test.apps.googleusercontent.com',
    clientSecret: 'test-client-secret',
    fetch: async () => new Response(JSON.stringify({})),
    openExternal: async () => {},
    now: () => Date.parse('2026-10-23T00:00:00.000Z'),
    randomBytes: randomSource(),
    timeoutMs: 100,
  };
  return {
    dependencies: { ...base, ...overrides },
    config: { clientId: base.clientId, clientSecret: base.clientSecret }
  };
}

test('Gmail OAuth starts with a loopback redirect and PKCE without opening a browser', async () => {
  const openCalls = [];
  const { config, dependencies } = configured({ openExternal: async url => openCalls.push(url) });
  const oauth = new GmailOAuth(config, dependencies);
  const started = await oauth.start(challenge);
  try {
    assert.equal(openCalls.length, 0);
    const redirect = new URL(started.challenge.url);
    assert.equal(redirect.hostname, '127.0.0.1');
    assert.equal(redirect.pathname, '/oauth/callback');
    const auth = new URL(started.authorizationUrl);
    assert.equal(auth.origin, 'https://accounts.google.com');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('access_type'), 'offline');
    assert.equal(auth.searchParams.get('prompt'), 'consent');
    assert.ok(auth.searchParams.get('state'));
    assert.ok(auth.searchParams.get('code_challenge'));
    assert.equal(auth.searchParams.get('redirect_uri'), started.challenge.url);
  } finally {
    oauth.cancel(started.challenge);
  }
});

test('Gmail OAuth rejects a challenge with the wrong state without exchanging the code', async () => {
  let fetchCalls = 0;
  const { config, dependencies } = configured({ fetch: async () => { fetchCalls += 1; return new Response('{}'); } });
  const oauth = new GmailOAuth(config, dependencies);
  const started = await oauth.start(challenge);
  try {
    const opening = oauth.open(started.challenge);
    const outcome = opening.catch(error => error);
    const url = new URL(started.challenge.url);
    url.searchParams.set('code', 'code');
    url.searchParams.set('state', 'wrong');
    const response = await fetch(url, { headers: { host: url.host } });
    assert.equal(response.status, 400);
    assert.equal(fetchCalls, 0);
    assert.match(String(await outcome), /state/u);
  } finally {
    oauth.cancel(started.challenge);
  }
});

test('Gmail OAuth exchanges the code, reads the account and never places secrets in the challenge', async () => {
  const fetchCalls = [];
  const { config: configuredConfig, dependencies } = configured({
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email gmail.modify'
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ email: 'person@gmail.com' }), { status: 200 });
    }
  });
  const oauth = new GmailOAuth({
    clientId: configuredConfig.clientId,
    clientSecret: configuredConfig.clientSecret
  }, dependencies);
  const started = await oauth.start(challenge);
  try {
    const opening = oauth.open(started.challenge);
    const outcome = opening.catch(error => error);
    const redirect = new URL(started.challenge.url);
    const auth = new URL(started.authorizationUrl);
    redirect.searchParams.set('code', 'auth-code');
    redirect.searchParams.set('state', auth.searchParams.get('state'));
    const response = await fetch(redirect, { headers: { host: redirect.host } });
    assert.equal(response.status, 200);
    const grant = await opening;
    assert.equal(grant.email, 'person@gmail.com');
    assert.equal(grant.token.accessToken, 'access');
    assert.equal(grant.token.refreshToken, 'refresh');
    assert.equal(JSON.stringify(started.challenge).includes('access'), false);
    assert.equal(fetchCalls.length, 2);
    const tokenBody = fetchCalls[0].init.body;
    assert.match(String(tokenBody), /code_verifier=/u);
    assert.equal(new URLSearchParams(String(tokenBody)).get('client_secret'), 'test-client-secret');
    assert.equal(String(tokenBody).includes('refresh'), false);
  } finally {
    oauth.cancel(started.challenge);
  }
});

test('Gmail OAuth maps safe token errors without exposing request secrets', async () => {
  const { config, dependencies } = configured({
    fetch: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
  });
  const oauth = new GmailOAuth(config, dependencies);
  const started = await oauth.start(challenge);
  try {
    const opening = oauth.open(started.challenge);
    const outcome = opening.catch(error => error);
    const redirect = new URL(started.challenge.url);
    redirect.searchParams.set('state', new URL(started.authorizationUrl).searchParams.get('state'));
    redirect.searchParams.set('code', 'bad-code');
    await fetch(redirect, { headers: { host: redirect.host } });
    assert.match(String(await outcome), /令牌交换失败.*授权码已失效/u);
    assert.equal(String(await outcome).includes('bad-code'), false);
    assert.equal(String(await outcome).includes('test-client-secret'), false);
    assert.equal(new URL(started.authorizationUrl).searchParams.has('client_secret'), false);
  } finally {
    oauth.cancel(started.challenge);
  }
});

test('Gmail OAuth validates user-supplied client credentials and rejects invalid tokens', () => {
  assert.throws(() => new GmailOAuth({ clientId: '', clientSecret: 'secret' }), GmailOAuthError);
  assert.throws(
    () => new GmailOAuth({ clientId: 'not-a-google-client', clientSecret: 'secret' }),
    /Client ID 配置无效/u
  );
  assert.throws(
    () => new GmailOAuth({ clientId: 'rambo-test.apps.googleusercontent.com', clientSecret: '' }),
    /Client Secret 配置无效/u
  );
  assert.throws(() => normalizeToken({ access_token: 'a', token_type: 'Bearer', expires_in: 0 }, Date.now, null), /令牌格式无效/u);
  assert.deepEqual(normalizeToken({
    access_token: 'a', token_type: 'Bearer', expires_in: 10, scope: 'x'
  }, () => 1000, 'refresh'), {
    accessToken: 'a', refreshToken: 'refresh',
    expiresAt: new Date(11_000).toISOString(), scope: 'x', tokenType: 'Bearer'
  });
});
