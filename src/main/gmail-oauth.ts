import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConnectorAuthChallenge } from '../shared/contracts';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const CALLBACK_PATH = '/oauth/callback';
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const GMAIL_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify'
];

export type GmailOAuthConfig = {
  clientId: string;
  clientSecret: string;
};

export type GmailOAuthToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scope: string;
  tokenType: string;
};

export type GmailOAuthGrant = {
  connectionId: string;
  displayName: string;
  email: string;
  token: GmailOAuthToken;
};

export type GmailOAuthStart = {
  challenge: ConnectorAuthChallenge;
  authorizationUrl: string;
};

type PendingFlow = {
  connectionId: string;
  displayName: string;
  state: string;
  verifier: string;
  redirectUri: string;
  authorizationUrl: string;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  completion: Promise<GmailOAuthGrant>;
  resolve: (grant: GmailOAuthGrant) => void;
  reject: (error: Error) => void;
};

type GmailOAuthDependencies = {
  fetch: typeof fetch;
  openExternal: (url: string) => Promise<void>;
  now: () => number;
  randomBytes: (size: number) => Buffer;
  timeoutMs: number;
};

export class GmailOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailOAuthError';
  }
}

/**
 * Desktop OAuth with a loopback callback and PKCE. Starting a flow never opens
 * a browser; that only happens in open(), after an explicit user action.
 */
export class GmailOAuth {
  private readonly pending = new Map<string, PendingFlow>();

  constructor(
    private readonly config: GmailOAuthConfig,
    private readonly dependencies: Partial<GmailOAuthDependencies> = {}
  ) {
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/u.test(config.clientId)) {
      throw new GmailOAuthError('Gmail OAuth Client ID 配置无效');
    }
    if (!config.clientSecret) {
      throw new GmailOAuthError('Gmail OAuth Client Secret 配置无效');
    }
  }

  async start(challenge: ConnectorAuthChallenge): Promise<GmailOAuthStart> {
    if (challenge.providerId !== 'gmail' || challenge.authKind !== 'oauth-desktop') {
      throw new GmailOAuthError('Gmail 授权挑战无效');
    }
    if (!challenge.connectionId.startsWith('pending:gmail:')) {
      throw new GmailOAuthError('Gmail 授权挑战已失效');
    }
    if (this.pending.has(challenge.connectionId)) {
      throw new GmailOAuthError('Gmail 授权已经在进行中');
    }

    const state = randomUrlToken(this.dependencies.randomBytes ?? randomBytes);
    const verifier = randomUrlToken(this.dependencies.randomBytes ?? randomBytes);
    const server = createServer((request, response) => {
      void this.handleCallback(challenge.connectionId, request, response);
    });
    await listenOnLoopback(server);
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== 'number') {
      server.close();
      throw new GmailOAuthError('无法启动 Gmail 本机回调服务');
    }
    const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
    const authorizationUrl = authorizationUrlFor(
      this.config.clientId,
      redirectUri,
      state,
      verifier
    );
    const timeoutMs = this.dependencies.timeoutMs ?? FLOW_TIMEOUT_MS;
    let resolve!: (grant: GmailOAuthGrant) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<GmailOAuthGrant>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    // Flows can be cancelled before IPC attaches a waiter. Keep that rejection
    // handled without changing what open() returns to its caller.
    void completion.catch(() => {});
    const timer = setTimeout(() => {
      this.fail(challenge.connectionId, new GmailOAuthError('Gmail 授权已超时，请重新发起'));
    }, timeoutMs);
    timer.unref?.();
    const flow: PendingFlow = {
      connectionId: challenge.connectionId,
      displayName: challenge.displayName,
      state,
      verifier,
      redirectUri,
      authorizationUrl,
      server,
      timer,
      settled: false,
      completion,
      resolve,
      reject
    };
    this.pending.set(challenge.connectionId, flow);
    return {
      challenge: {
        ...challenge,
        url: redirectUri
      },
      authorizationUrl
    };
  }

  async open(challenge: ConnectorAuthChallenge): Promise<GmailOAuthGrant> {
    const flow = this.pending.get(challenge.connectionId);
    if (!flow) throw new GmailOAuthError('Gmail 授权挑战已失效，请重新开始');
    const openExternal = this.dependencies.openExternal;
    if (!openExternal) throw new GmailOAuthError('无法打开系统浏览器');
    await openExternal(flow.authorizationUrl);
    return flow.completion;
  }

  /** Opens the system browser and waits for the loopback callback. */
  async authorize(challenge: ConnectorAuthChallenge): Promise<GmailOAuthGrant> {
    return this.open(challenge);
  }

  cancel(challenge: ConnectorAuthChallenge): void {
    this.fail(challenge.connectionId, new GmailOAuthError('Gmail 授权已取消'));
  }

  dispose(): void {
    for (const connectionId of [...this.pending.keys()]) this.cancel({ connectionId } as ConnectorAuthChallenge);
  }

  private async handleCallback(
    connectionId: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const flow = this.pending.get(connectionId);
    if (!flow || flow.settled) {
      respondHtml(response, 409, '授权请求已结束。');
      return;
    }
    try {
      const host = String(request.headers.host ?? '');
      const expectedHost = `127.0.0.1:${(flow.server.address() as AddressInfo).port}`;
      if (request.method !== 'GET' || host !== expectedHost) {
        throw new GmailOAuthError('Gmail 回调请求来源无效');
      }
      const callback = new URL(request.url ?? '/', flow.redirectUri);
      if (callback.pathname !== CALLBACK_PATH) {
        throw new GmailOAuthError('Gmail 回调路径无效');
      }
      if (callback.searchParams.get('state') !== flow.state) {
        throw new GmailOAuthError('Gmail 回调 state 不匹配');
      }
      const oauthError = callback.searchParams.get('error');
      if (oauthError) {
        throw new GmailOAuthError(
          oauthError === 'access_denied' ? 'Google 授权已取消' : 'Google 拒绝了授权请求'
        );
      }
      const code = callback.searchParams.get('code');
      if (!code) throw new GmailOAuthError('Gmail 回调缺少授权码');

      const token = await this.exchangeCode(code, flow.verifier, flow.redirectUri);
      const email = await this.fetchEmail(token.accessToken);
      respondHtml(response, 200, 'Rambo 已收到 Google 授权，可以关闭此页面。');
      this.finish(connectionId, {
        connectionId: flow.connectionId,
        displayName: flow.displayName,
        email,
        token
      });
    } catch (error) {
      respondHtml(response, 400, error instanceof Error ? error.message : 'Gmail 授权失败');
      this.fail(connectionId, error instanceof Error ? error : new GmailOAuthError('Gmail 授权失败'));
    }
  }

  private async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<GmailOAuthToken> {
    const fetchImpl = this.dependencies.fetch ?? fetch;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000)
    });
    const payload = await responseJson(response);
    if (!response.ok) {
      throw new GmailOAuthError(oauthFailureMessage(payload, 'Google 令牌交换失败，请重新授权'));
    }
    return normalizeToken(payload, this.dependencies.now ?? Date.now, null);
  }

  private async fetchEmail(accessToken: string): Promise<string> {
    const fetchImpl = this.dependencies.fetch ?? fetch;
    const response = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000)
    });
    const payload = await responseJson(response);
    if (!response.ok || typeof payload?.email !== 'string' || !payload.email.includes('@')) {
      throw new GmailOAuthError('无法读取 Google 账号邮箱，请重新授权');
    }
    return payload.email.trim();
  }

  private finish(connectionId: string, grant: GmailOAuthGrant): void {
    const flow = this.pending.get(connectionId);
    if (!flow || flow.settled) return;
    flow.settled = true;
    clearTimeout(flow.timer);
    flow.server.close();
    this.pending.delete(connectionId);
    flow.resolve(grant);
  }

  private fail(connectionId: string, error: Error): void {
    const flow = this.pending.get(connectionId);
    if (!flow || flow.settled) return;
    flow.settled = true;
    clearTimeout(flow.timer);
    flow.server.close();
    this.pending.delete(connectionId);
    flow.reject(error);
  }
}

export function normalizeToken(
  payload: any,
  now: () => number,
  previousRefreshToken: string | null
): GmailOAuthToken {
  if (!payload || typeof payload.access_token !== 'string' || !payload.access_token ||
      typeof payload.token_type !== 'string' || !payload.token_type ||
      typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in) ||
      payload.expires_in <= 0 || payload.expires_in > 86_400) {
    throw new GmailOAuthError('Google 返回的令牌格式无效');
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token
      ? payload.refresh_token
      : previousRefreshToken,
    expiresAt: new Date(now() + payload.expires_in * 1000).toISOString(),
    scope: typeof payload.scope === 'string' ? payload.scope : GMAIL_SCOPES.join(' '),
    tokenType: payload.token_type
  };
}

function authorizationUrlFor(
  clientId: string,
  redirectUri: string,
  state: string,
  verifier: string
): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function randomUrlToken(random: (size: number) => Buffer): string {
  return random(32).toString('base64url');
}

async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

async function responseJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function oauthFailureMessage(payload: any, fallback: string): string {
  const code = typeof payload?.error === 'string' ? payload.error : '';
  switch (code) {
    case 'invalid_client':
      return `${fallback}（Google 客户端配置无效）`;
    case 'invalid_grant':
      return `${fallback}（Google 授权码已失效，请重新发起）`;
    case 'redirect_uri_mismatch':
      return `${fallback}（Google 回调地址不匹配）`;
    case 'invalid_request':
      return `${fallback}（Google 令牌请求格式无效）`;
    case 'unsupported_grant_type':
      return `${fallback}（Google 不支持该授权类型）`;
    default:
      return fallback;
  }
}

function respondHtml(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"
  });
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Rambo</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:48px;max-width:620px;margin:auto">
<h1 style="font-size:20px">Rambo</h1><p>${escapeHtml(message)}</p></body></html>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
}
