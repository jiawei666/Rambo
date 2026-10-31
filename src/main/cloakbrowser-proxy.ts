import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  isInitializeRequest
} from '@modelcontextprotocol/sdk/types.js';
import type { CloakBrowserRuntime } from './cloakbrowser-runtime';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 64;

interface ProxySession {
  botId: string;
  token: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface CloakBrowserMcpProxyOptions {
  authorizeToken: (token: string) => string | null;
  authorizeBot: (botId: string) => boolean;
}

function bearerToken(request: IncomingMessage): string | null {
  const raw = request.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = typeof value === 'string' ? /^Bearer\s+([a-f0-9]{64})$/iu.exec(value.trim()) : null;
  return match?.[1] ?? null;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (!size) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function jsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null
  }));
}

export class CloakBrowserMcpProxy {
  private server: Server | null = null;
  private url: string | null = null;
  private readonly sessions = new Map<string, ProxySession>();

  constructor(
    private readonly runtime: CloakBrowserRuntime,
    private readonly options: CloakBrowserMcpProxyOptions
  ) {}

  get endpoint(): string | null {
    return this.url;
  }

  async start(): Promise<string> {
    if (this.url) return this.url;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        jsonRpcError(
          response,
          500,
          ErrorCode.InternalError,
          error instanceof Error ? error.message.slice(0, 500) : 'CloakBrowser 代理失败'
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      await new Promise<void>(resolve => server.close(() => resolve()));
      throw new Error('无法取得 CloakBrowser 本地代理端口。');
    }
    this.server = server;
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    return this.url;
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(session => this.closeSession(session)));
    const server = this.server;
    this.server = null;
    this.url = null;
    if (!server) return;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  revokeBot(botId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.botId !== botId) continue;
      this.sessions.delete(sessionId);
      void this.closeSession(session);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.url) {
      jsonRpcError(response, 503, ErrorCode.InternalError, 'CloakBrowser 代理尚未启动');
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== '/mcp') {
      jsonRpcError(response, 404, ErrorCode.InvalidRequest, 'Not found');
      return;
    }
    const token = bearerToken(request);
    const botId = token ? this.options.authorizeToken(token) : null;
    if (!token || !botId || !this.options.authorizeBot(botId)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      jsonRpcError(response, 401, ErrorCode.InvalidRequest, 'CloakBrowser 访问已撤销或无效');
      return;
    }

    const header = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || session.token !== token || session.botId !== botId) {
        jsonRpcError(response, 404, ErrorCode.InvalidRequest, 'MCP 会话不存在或已失效');
        return;
      }
      await session.transport.handleRequest(request, response);
      return;
    }

    if (request.method !== 'POST') {
      jsonRpcError(response, 400, ErrorCode.InvalidRequest, '缺少 MCP 会话 ID');
      return;
    }
    const body = await requestBody(request);
    if (!isInitializeRequest(body)) {
      jsonRpcError(response, 400, ErrorCode.InvalidRequest, '没有有效 MCP 会话 ID');
      return;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      jsonRpcError(response, 503, ErrorCode.InternalError, 'CloakBrowser MCP 会话过多');
      return;
    }
    const server = this.createServer(botId, token);
    let session: ProxySession | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => {
        session = { botId, token, server, transport };
        this.sessions.set(id, session);
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) this.sessions.delete(id);
      void server.close().catch(() => {});
    };
    await server.connect(transport);
    try {
      await transport.handleRequest(request, response, body);
    } catch (error) {
      await Promise.allSettled([transport.close(), server.close()]);
      throw error;
    }
    if (!session) await server.close();
  }

  private createServer(botId: string, token: string): McpServer {
    const server = new McpServer(
      { name: 'rambo-cloakbrowser', version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions: [
          '这是 Rambo 管理的 CloakBrowser 共享浏览器。',
          '它使用独立 Chromium 与共享持久 profile，不会接管当前 Chrome 标签页。',
          '所有获授权 Bot 共用 Cookie、历史、扩展和标签页状态，工具调用由 Rambo 串行执行。'
        ].join('\n')
      }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.isAuthorized(botId, token)) {
        throw new McpError(ErrorCode.InvalidRequest, 'CloakBrowser 访问已撤销');
      }
      return { tools: this.runtime.listTools() as any };
    });
    server.setRequestHandler(CallToolRequestSchema, async request => {
      if (!this.isAuthorized(botId, token)) {
        throw new McpError(ErrorCode.InvalidRequest, 'CloakBrowser 访问已撤销或凭证已失效');
      }
      const name = typeof request.params.name === 'string' ? request.params.name : '';
      if (!name) throw new McpError(ErrorCode.InvalidParams, '缺少工具名称');
      const args = request.params.arguments && typeof request.params.arguments === 'object' &&
        !Array.isArray(request.params.arguments)
        ? request.params.arguments as Record<string, unknown>
        : {};
      return await this.runtime.callTool(
        name,
        args,
        () => this.isAuthorized(botId, token)
      ) as any;
    });
    return server;
  }

  private isAuthorized(botId: string, token: string): boolean {
    return this.options.authorizeBot(botId) && this.runtime.botForToken(token) === botId;
  }

  private async closeSession(session: ProxySession): Promise<void> {
    await Promise.allSettled([
      session.transport.close(),
      session.server.close()
    ]);
  }
}
