import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server
} from 'node:http';
import { connect as connectTcp, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as connectTls } from 'node:tls';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_FRAGMENT_BYTES = 64 * 1024 * 1024;

const EXCLUDED_UPSTREAM_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'origin',
  'proxy-authorization',
  'proxy-connection',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-version',
  'transfer-encoding',
  'upgrade'
]);

export interface RealtimeAudioBridgeOptions {
  /** Explicit app proxy; when empty, standard proxy environment variables are used. */
  proxyUrl?: string | null;
  /** Test seam. Production connects to the official realtime origin. */
  upstreamBaseUrl?: string;
  environment?: NodeJS.ProcessEnv;
}

interface UpstreamConnection {
  socket: Socket;
  head: Buffer;
  responseHeaders: IncomingHttpHeaders;
}

interface ParsedHeaders {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  head: Buffer;
}

/**
 * Codex App Server 0.165/0.166 names the parsed notification `output_audio`
 * with an `audio` field, while the realtime service currently sends
 * `session.output_audio.delta` with `delta`. Keep this translation isolated
 * until the upstream parser accepts the live protocol name.
 */
export function adaptRealtimeAudioEvent(text: string): string {
  let message: any;
  try {
    message = JSON.parse(text);
  } catch {
    return text;
  }
  if (message?.type === 'output_audio.delta' && typeof message.audio === 'string') {
    return text;
  }
  if (
    message?.type !== 'session.output_audio.delta' &&
    message?.type !== 'output_audio.delta'
  ) {
    return text;
  }
  const audio = typeof message.audio === 'string' ? message.audio : message.delta;
  if (typeof audio !== 'string') return text;
  const adapted = {
    ...message,
    type: 'output_audio.delta',
    audio
  };
  if (audio === message.delta) delete adapted.delta;
  return JSON.stringify(adapted);
}

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function requestHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value ?? '';
}

function proxyUrlFromEnvironment(environment: NodeJS.ProcessEnv): string | null {
  for (const name of [
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'HTTP_PROXY',
    'http_proxy'
  ]) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return null;
}

function appendHeader(lines: string[], name: string, value: string): void {
  const normalized = value.replace(/[\r\n]/g, ' ').trim();
  if (normalized) lines.push(`${name}: ${normalized}`);
}

function forwardedHeaderLines(request: IncomingMessage): string[] {
  const lines: string[] = [];
  for (const [rawName, rawValue] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (EXCLUDED_UPSTREAM_HEADERS.has(name) || rawValue === undefined) continue;
    appendHeader(lines, name, Array.isArray(rawValue) ? rawValue.join(', ') : rawValue);
  }
  return lines;
}

function readResponseHeaders(socket: Socket): Promise<ParsedHeaders> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error('Upstream closed during WebSocket handshake'));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HANDSHAKE_BYTES) {
        fail(new Error('Upstream WebSocket handshake headers are too large'));
        return;
      }
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      cleanup();
      socket.pause();
      const lines = buffer.subarray(0, boundary).toString('latin1').split('\r\n');
      const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/u.exec(lines.shift() ?? '');
      if (!match) {
        reject(new Error('Invalid upstream HTTP response'));
        return;
      }
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
      }
      resolve({
        statusCode: Number(match[1]),
        statusMessage: match[2] ?? '',
        headers,
        head: buffer.subarray(boundary + 4)
      });
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function waitForSocket(socket: Socket, event: 'connect' | 'secureConnect'): Promise<void> {
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, onReady);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error('Upstream connection timed out'));
    };
    socket.once(event, onReady);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

async function openTransport(
  hostname: string,
  port: number,
  secure: boolean
): Promise<Socket> {
  const socket = secure
    ? connectTls({
        host: hostname,
        port,
        servername: hostname,
        ALPNProtocols: ['http/1.1']
      })
    : connectTcp({ host: hostname, port });
  await waitForSocket(socket, secure ? 'secureConnect' : 'connect');
  socket.setTimeout(0);
  return socket;
}

async function openProxyTunnel(
  proxyUrl: string,
  targetHostname: string,
  targetPort: number
): Promise<Socket> {
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    throw new Error('Realtime audio bridge proxy URL is invalid');
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new Error(`Unsupported realtime audio bridge proxy protocol: ${proxy.protocol}`);
  }
  const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  const socket = await openTransport(proxy.hostname, proxyPort, proxy.protocol === 'https:');
  const authority = `${targetHostname}:${targetPort}`;
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    'Proxy-Connection: Keep-Alive'
  ];
  if (proxy.username || proxy.password) {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const response = await readResponseHeaders(socket);
  if (response.statusCode !== 200) {
    socket.destroy();
    throw new Error(`Realtime audio bridge proxy CONNECT failed with HTTP ${response.statusCode}`);
  }
  if (response.head.length) socket.unshift(response.head);
  socket.resume();
  return socket;
}

async function openTargetSocket(
  target: URL,
  proxyUrl: string | null
): Promise<Socket> {
  const port = Number(target.port || (target.protocol === 'wss:' ? 443 : 80));
  if (!proxyUrl) {
    return openTransport(target.hostname, port, target.protocol === 'wss:');
  }
  const tunnel = await openProxyTunnel(proxyUrl, target.hostname, port);
  if (target.protocol !== 'wss:') return tunnel;
  const secure = connectTls({
    socket: tunnel,
    servername: target.hostname,
    ALPNProtocols: ['http/1.1']
  });
  await waitForSocket(secure, 'secureConnect');
  secure.setTimeout(0);
  return secure;
}

function encodeServerFrame(opcode: number, payload: Buffer, final = true): Buffer {
  const first = (final ? 0x80 : 0) | (opcode & 0x0f);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

class WebSocketEventAdapter {
  private buffer: Buffer = Buffer.alloc(0);
  private fragmentedText: Buffer[] | null = null;
  private fragmentedBytes = 0;

  push(chunk: Buffer): Buffer {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    const output: Buffer[] = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const reserved = first & 0x70;
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let payloadLength = second & 0x7f;
      let headerLength = 2;
      if (payloadLength === 126) {
        if (this.buffer.length < 4) break;
        payloadLength = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) break;
        const length = this.buffer.readBigUInt64BE(2);
        if (length > BigInt(MAX_FRAME_BYTES)) {
          throw new Error('Upstream WebSocket frame is too large');
        }
        payloadLength = Number(length);
        headerLength = 10;
      }
      if (payloadLength > MAX_FRAME_BYTES) {
        throw new Error('Upstream WebSocket frame is too large');
      }
      const maskLength = masked ? 4 : 0;
      const frameLength = headerLength + maskLength + payloadLength;
      if (this.buffer.length < frameLength) break;
      const frame = this.buffer.subarray(0, frameLength);
      const payloadStart = headerLength + maskLength;
      const payload = this.buffer.subarray(payloadStart, frameLength);
      this.buffer = this.buffer.subarray(frameLength);

      if (opcode === 0x1 && !masked && reserved === 0 && final && !this.fragmentedText) {
        const text = payload.toString('utf8');
        const adapted = adaptRealtimeAudioEvent(text);
        output.push(adapted === text
          ? frame
          : encodeServerFrame(0x1, Buffer.from(adapted, 'utf8')));
        continue;
      }
      if (opcode === 0x1 && !masked && reserved === 0 && !final) {
        this.fragmentedText = [Buffer.from(payload)];
        this.fragmentedBytes = payload.length;
        continue;
      }
      if (opcode === 0x0 && !masked && reserved === 0 && this.fragmentedText) {
        this.fragmentedBytes += payload.length;
        if (this.fragmentedBytes > MAX_FRAGMENT_BYTES) {
          throw new Error('Upstream fragmented WebSocket message is too large');
        }
        this.fragmentedText.push(Buffer.from(payload));
        if (final) {
          const text = Buffer.concat(this.fragmentedText).toString('utf8');
          const adapted = adaptRealtimeAudioEvent(text);
          output.push(encodeServerFrame(0x1, Buffer.from(adapted, 'utf8')));
          this.fragmentedText = null;
          this.fragmentedBytes = 0;
        }
        continue;
      }
      if (opcode !== 0x0 && this.fragmentedText) {
        throw new Error('Invalid interleaved WebSocket data frame');
      }
      output.push(frame);
    }
    return output.length ? Buffer.concat(output) : Buffer.alloc(0);
  }
}

function rejectUpgrade(socket: Duplex, status: string, body: string): void {
  if (socket.destroyed) return;
  const payload = Buffer.from(body);
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${payload.length}\r\n\r\n${body}`
  );
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes);
}

export class RealtimeAudioBridge {
  private server: Server | null = null;
  private baseUrl: string | null = null;
  private token = '';
  private starting: Promise<string> | null = null;
  private proxyUrl: string | null;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly upstreamBaseUrl: string;
  private readonly sockets = new Set<Duplex>();

  constructor(options: RealtimeAudioBridgeOptions = {}) {
    this.proxyUrl = options.proxyUrl?.trim() || null;
    this.environment = options.environment ?? process.env;
    this.upstreamBaseUrl = options.upstreamBaseUrl ?? 'wss://api.openai.com';
  }

  setProxyUrl(proxyUrl: string | null | undefined): void {
    this.proxyUrl = proxyUrl?.trim() || null;
  }

  async start(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    if (this.starting) return this.starting;
    const starting = this.listen();
    this.starting = starting;
    try {
      this.baseUrl = await starting;
      return this.baseUrl;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    this.token = '';
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async listen(): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    const server = createServer((_request, response) => {
      response.writeHead(404, { connection: 'close' });
      response.end();
    });
    this.token = token;
    this.server = server;
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
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
      server.close();
      throw new Error('Unable to bind the realtime audio bridge');
    }
    return `ws://127.0.0.1:${address.port}/v1/${token}`;
  }

  private proxyForConnection(): string | null {
    return this.proxyUrl ?? proxyUrlFromEnvironment(this.environment);
  }

  private async openUpstream(
    request: IncomingMessage,
    callId: string
  ): Promise<UpstreamConnection> {
    const target = new URL(`/v1/live/${encodeURIComponent(callId)}`, this.upstreamBaseUrl);
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      throw new Error('Realtime audio bridge upstream must use ws:// or wss://');
    }
    const socket = await openTargetSocket(target, this.proxyForConnection());
    const key = randomBytes(16).toString('base64');
    const lines = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...forwardedHeaderLines(request)
    ];
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    const response = await readResponseHeaders(socket);
    if (
      response.statusCode !== 101 ||
      response.headers.upgrade?.toLowerCase() !== 'websocket' ||
      response.headers['sec-websocket-accept'] !== websocketAccept(key)
    ) {
      socket.destroy();
      throw new Error(`Realtime upstream WebSocket handshake failed with HTTP ${response.statusCode}`);
    }
    return {
      socket,
      head: response.head,
      responseHeaders: response.headers
    };
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    socket.on('error', () => {});
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const prefix = `/v1/${this.token}/`;
    const tokenPath = url.pathname.slice(0, prefix.length);
    const callId = url.pathname.slice(prefix.length);
    if (
      !this.token ||
      !tokenMatches(tokenPath, prefix) ||
      !/^[A-Za-z0-9._~-]{1,512}$/u.test(callId)
    ) {
      rejectUpgrade(socket, '404 Not Found', 'Not found');
      return;
    }
    const key = requestHeader(request.headers, 'sec-websocket-key');
    if (
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !key ||
      request.headers['sec-websocket-version'] !== '13'
    ) {
      rejectUpgrade(socket, '400 Bad Request', 'Invalid WebSocket upgrade');
      return;
    }

    socket.pause();
    let upstream: UpstreamConnection;
    try {
      upstream = await this.openUpstream(request, callId);
    } catch {
      rejectUpgrade(socket, '502 Bad Gateway', 'Realtime upstream unavailable');
      return;
    }
    if (socket.destroyed || this.server === null) {
      upstream.socket.destroy();
      return;
    }

    this.sockets.add(upstream.socket);
    upstream.socket.once('close', () => this.sockets.delete(upstream.socket));
    const responseLines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`
    ];
    const selectedProtocol = upstream.responseHeaders['sec-websocket-protocol'];
    if (selectedProtocol) appendHeader(responseLines, 'Sec-WebSocket-Protocol', selectedProtocol);
    socket.write(`${responseLines.join('\r\n')}\r\n\r\n`);

    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      socket.destroy();
      upstream.socket.destroy();
      this.sockets.delete(socket);
      this.sockets.delete(upstream.socket);
    };
    socket.on('error', closeBoth);
    socket.on('close', closeBoth);
    upstream.socket.on('error', closeBoth);
    upstream.socket.on('close', closeBoth);
    socket.on('drain', () => upstream.socket.resume());
    upstream.socket.on('drain', () => socket.resume());
    socket.on('data', data => {
      if (!upstream.socket.write(data)) socket.pause();
    });

    const adapter = new WebSocketEventAdapter();
    const forwardUpstream = (data: Buffer) => {
      let adapted: Buffer;
      try {
        adapted = adapter.push(data);
      } catch {
        closeBoth();
        return;
      }
      if (adapted.length && !socket.write(adapted)) upstream.socket.pause();
    };
    if (head.length) upstream.socket.write(head);
    if (upstream.head.length) forwardUpstream(upstream.head);
    upstream.socket.on('data', forwardUpstream);
    socket.resume();
    upstream.socket.resume();
  }
}
