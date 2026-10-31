import { randomUUID } from 'node:crypto';
import type {
  ConnectorConnection,
  ConnectorCapabilityStatus
} from '../shared/contracts';
import type { ConnectorCredentialPayload } from './connector-credentials';
import type {
  WechatWorkerMessage,
  WechatWorkerPage,
  WechatWorkerRequest,
  WechatWorkerResponse,
  WechatWorkerResult,
  WechatWorkerSession
} from './wechat-worker';

export type WechatCredential = Extract<
  ConnectorCredentialPayload,
  { kind: 'wechat-sqlcipher' }
>;

export interface WechatTimeRange {
  start: string;
  end: string;
}

export interface WechatSession {
  sessionId: string;
  displayName: string;
  type: 'private' | 'group' | 'official' | 'service' | 'system' | 'unknown';
  latestMessageAt: string | null;
  unreadCount: number;
}

export interface WechatMediaRef {
  mediaId: string;
  kind: 'image' | 'thumbnail' | 'video' | 'audio' | 'file' | 'sticker' | 'unknown';
  status: 'available' | 'thumbnailOnly' | 'missing' | 'unavailable';
  mimeType: string | null;
  size: number | null;
  resourceHandle: string | null;
  transcription?: string | null;
}

export interface WechatMessage {
  messageId: string;
  localId: string | null;
  serverId: string | null;
  sessionId: string;
  senderId: string;
  senderDisplayName: string;
  sentAt: string;
  sequence: number;
  type: string;
  subtype: string | null;
  text: string | null;
  quoteMessageId: string | null;
  card: Record<string, unknown> | null;
  media: WechatMediaRef[];
  unknownPayload: Record<string, unknown> | null;
}

export interface WechatPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  returnedCount: number;
  knownTotal: number | null;
  coverage: {
    start: string;
    end: string;
    localOnly: true;
    complete: boolean;
    notes: string[];
  };
  truncation: 'messages' | 'bytes' | 'protocol' | null;
  readAt: string;
}

export interface WechatMessageQuery {
  sessionIds: string[];
  start: string;
  end: string;
  cursor?: string;
}

export interface WechatSearchQuery {
  query: string;
  sessionIds?: string[];
  start: string;
  end: string;
  messageTypes?: string[];
  cursor?: string;
}

export interface WechatReader {
  status(): Promise<Record<string, ConnectorCapabilityStatus>>;
  sessions(
    connection: ConnectorConnection,
    credential: WechatCredential,
    query?: { query?: string; cursor?: string }
  ): Promise<WechatPage<WechatSession>>;
  messages(
    connection: ConnectorConnection,
    credential: WechatCredential,
    query: WechatMessageQuery
  ): Promise<WechatPage<WechatMessage>>;
  search(
    connection: ConnectorConnection,
    credential: WechatCredential,
    query: WechatSearchQuery
  ): Promise<WechatPage<WechatMessage>>;
  readMedia(
    connection: ConnectorConnection,
    credential: WechatCredential,
    resourceHandle: string
  ): Promise<{
    bytes: Buffer;
    mimeType: string;
    fileName: string;
    kind?: WechatMediaRef['kind'];
    status?: WechatMediaRef['status'];
    transcription?: string | null;
    limitation?: string;
  }>;
  invalidate(connectionId: string): void;
}

export interface WechatAdapter {
  readonly providerId: 'wechat';
  reader: WechatReader;
  verify(connection: ConnectorConnection): Promise<Record<string, ConnectorCapabilityStatus>>;
}

export interface WechatWorkerTransportRequest {
  connectionId: string;
  request: WechatWorkerRequest;
  timeoutMs?: number;
}

export interface WechatWorkerTransport {
  send(input: WechatWorkerTransportRequest): Promise<WechatWorkerResponse>;
  terminate(connectionId: string): void;
  dispose(): void;
}

export function unavailableWechatTransport(): WechatWorkerTransport {
  return {
    async send() {
      throw new Error('微信本机读取服务尚未启动');
    },
    terminate() {},
    dispose() {}
  };
}

const MAX_CURSOR_BYTES = 8_192;
const MAX_QUERY_DAYS = 366;
const MAX_PAGE_MESSAGES = 100;
const MAX_PAGE_BYTES = 256 * 1024;
const WORKER_REQUEST_TIMEOUT_MS = 30_000;

/** Return only stable, relative database diagnostics safe to show in the UI. */
export function incompleteWechatDatabaseDiagnostics(notes: readonly string[]): string[] {
  return notes.flatMap(note => {
    const match = /^未覆盖 ([a-z0-9._/-]{1,500})：([a-z][a-z0-9_]{0,79})$/iu.exec(note);
    if (!match || match[1].startsWith('/') || match[1].includes('\\') ||
        match[1].split('/').some(part => !part || part === '.' || part === '..')) return [];
    return [note];
  });
}

export function assertWechatPageDatabasesReadable(
  label: string,
  page: Pick<WechatPage<unknown>, 'coverage' | 'hasMore'>
): void {
  const issues = incompleteWechatDatabaseDiagnostics(page.coverage.notes);
  if (issues.length) {
    throw new Error(`${label}数据库读取不完整：${issues.join('；')}。请重新运行微信连接向导。`);
  }
}

export function parseWechatTimeRange(input: {
  start?: unknown;
  end?: unknown;
  relativeMinutes?: unknown;
}, now = new Date()): WechatTimeRange {
  if (input.relativeMinutes !== undefined) {
    if (!Number.isInteger(input.relativeMinutes) ||
        Number(input.relativeMinutes) < 1 ||
        Number(input.relativeMinutes) > MAX_QUERY_DAYS * 24 * 60) {
      throw new Error('相对时间范围必须为 1 分钟到 366 天');
    }
    const end = now;
    const start = new Date(end.getTime() - Number(input.relativeMinutes) * 60_000);
    return validateRange(start.toISOString(), end.toISOString());
  }
  if (typeof input.start !== 'string' || typeof input.end !== 'string') {
    throw new Error('微信查询必须提供明确起止时间或相对时间');
  }
  return validateRange(input.start, input.end);
}

function validateRange(startValue: string, endValue: string): WechatTimeRange {
  const start = Date.parse(startValue);
  const end = Date.parse(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error('微信查询时间格式无效');
  }
  if (end <= start) throw new Error('微信查询结束时间必须晚于开始时间');
  if (end - start > MAX_QUERY_DAYS * 86_400_000) {
    throw new Error('微信单次查询范围不能超过 366 天');
  }
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString()
  };
}

export function boundedWechatPage<T>(
  items: T[],
  input: {
    range: WechatTimeRange;
    cursor: string | null;
    knownTotal: number | null;
    coverageNotes?: string[];
    complete?: boolean;
  }
): WechatPage<T> {
  let selected = items.slice(0, MAX_PAGE_MESSAGES);
  let truncation: WechatPage<T>['truncation'] =
    items.length > selected.length ? 'messages' : null;
  for (let index = selected.length; index >= 0; index--) {
    const bytes = Buffer.byteLength(JSON.stringify(selected), 'utf8');
    if (bytes <= MAX_PAGE_BYTES) break;
    selected = selected.slice(0, Math.max(0, index - 1));
    truncation = 'bytes';
  }
  const hasMore = selected.length < items.length;
  return {
    items: selected,
    nextCursor: hasMore ? input.cursor ?? publicCursor() : null,
    hasMore,
    returnedCount: selected.length,
    knownTotal: input.knownTotal,
    coverage: {
      start: input.range.start,
      end: input.range.end,
      localOnly: true,
      complete: !hasMore && input.complete !== false,
      notes: input.coverageNotes ?? []
    },
    truncation,
    readAt: new Date().toISOString()
  };
}

export function publicCursor(): string {
  return randomUUID();
}

export function assertValidCursor(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_CURSOR_BYTES ||
      !/^[a-zA-Z0-9_-]{8,200}$/u.test(value)) {
    throw new Error('微信分页游标无效');
  }
  return value;
}

export class SqlCipherWechatReader implements WechatReader {
  constructor(private readonly transport: WechatWorkerTransport) {}

  async status(): Promise<Record<string, ConnectorCapabilityStatus>> {
    return {
      'wechat.sessions': 'unavailable',
      'wechat.messages': 'unavailable',
      'wechat.search': 'unavailable',
      'wechat.media': 'unavailable'
    };
  }

  async sessions(
    connection: ConnectorConnection,
    credential: WechatCredential,
    query: { query?: string; cursor?: string } = {}
  ): Promise<WechatPage<WechatSession>> {
    const response = await this.send(connection, credential, {
      id: randomUUID(),
      operation: 'sessions',
      dataDirectory: credential.dataDirectory,
      databases: this.databases(credential),
      accountId: credential.accountId,
      query
    });
    if (!isWorkerPageOf<WechatWorkerSession>(response, 'sessionId')) {
      throw new Error('微信 Worker 返回了无效的会话结果');
    }
    return {
      items: response.items,
      nextCursor: response.nextCursor,
      hasMore: response.hasMore,
      returnedCount: response.returnedCount,
      knownTotal: response.knownTotal,
      coverage: {
        start: response.coverage.start ?? new Date(0).toISOString(),
        end: response.coverage.end ?? new Date().toISOString(),
        localOnly: true,
        complete: response.coverage.complete,
        notes: this.coverageNotes(response.coverage)
      },
      truncation: response.truncation === null ? null
        : response.truncation === 'items' ? 'messages' : 'bytes',
      readAt: response.readAt
    };
  }

  async messages(
    connection: ConnectorConnection,
    credential: WechatCredential,
    query: WechatMessageQuery
  ): Promise<WechatPage<WechatMessage>> {
    const response = await this.send(connection, credential, {
      id: randomUUID(),
      operation: 'messages',
      dataDirectory: credential.dataDirectory,
      databases: this.databases(credential),
      accountId: credential.accountId,
      ...(credential.imageKey ? { imageKey: credential.imageKey } : {}),
      query: {
        start: query.start,
        end: query.end,
        sessionIds: query.sessionIds,
        ...(query.cursor ? { cursor: query.cursor } : {})
      }
    });
    if (!isWorkerPageOf<WechatWorkerMessage>(response, 'messageId')) {
      throw new Error('微信 Worker 返回了无效的消息结果');
    }
    return this.messagePage(response);
  }

  async search(
    connection: ConnectorConnection,
    credential: WechatCredential,
    query: WechatSearchQuery
  ): Promise<WechatPage<WechatMessage>> {
    const response = await this.send(connection, credential, {
      id: randomUUID(),
      operation: 'search',
      dataDirectory: credential.dataDirectory,
      databases: this.databases(credential),
      accountId: credential.accountId,
      ...(credential.imageKey ? { imageKey: credential.imageKey } : {}),
      query: {
        start: query.start,
        end: query.end,
        query: query.query,
        ...(query.sessionIds ? { sessionIds: query.sessionIds } : {}),
        ...(query.messageTypes ? { messageTypes: query.messageTypes } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {})
      }
    });
    if (!isWorkerPageOf<WechatWorkerMessage>(response, 'messageId')) {
      throw new Error('微信 Worker 返回了无效的搜索消息结果');
    }
    return this.messagePage(response);
  }

  async readMedia(
    connection: ConnectorConnection,
    credential: WechatCredential,
    resourceHandle: string
  ): Promise<{
    bytes: Buffer;
    mimeType: string;
    fileName: string;
    kind: WechatMediaRef['kind'];
    status: WechatMediaRef['status'];
    transcription?: string | null;
    limitation?: string;
  }> {
    const response = await this.send(connection, credential, {
      id: randomUUID(),
      operation: 'media',
      dataDirectory: credential.dataDirectory,
      databases: this.databases(credential),
      accountId: credential.accountId,
      ...(credential.imageKey ? { imageKey: credential.imageKey } : {}),
      query: { resourceHandle }
    });
    if (!('resourceHandle' in response) || response.resourceHandle !== resourceHandle) {
      throw new Error('微信 Worker 返回了无效的媒体结果');
    }
    if ((response.status !== 'available' && response.status !== 'thumbnailOnly') ||
        !response.bytes || !response.mimeType || !response.fileName) {
      throw new Error(response.diagnostics.join('；') || '微信媒体资源当前不可用');
    }
    return {
      bytes: Buffer.from(response.bytes),
      mimeType: response.mimeType,
      fileName: response.fileName,
      kind: response.kind,
      status: response.status,
      ...(response.transcription ? { transcription: response.transcription } : {}),
      ...(response.limitation ? { limitation: response.limitation } : {})
    };
  }

  invalidate(connectionId: string): void {
    this.transport.terminate(connectionId);
  }

  dispose(): void {
    this.transport.dispose();
  }

  private databases(credential: WechatCredential) {
    return Object.entries(credential.keys)
      .map(([path, key]) => ({ path, key: key.encKey }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private async send(
    connection: ConnectorConnection,
    credential: WechatCredential,
    request: WechatWorkerRequest
  ): Promise<WechatWorkerResult> {
    if (connection.providerId !== 'wechat' || connection.status !== 'ready') {
      throw new Error('微信连接已失效，请重新连接');
    }
    if (request.dataDirectory !== credential.dataDirectory) {
      throw new Error('微信连接的数据目录不一致，请重新连接');
    }
    const response = await this.transport.send({
      connectionId: connection.id,
      request,
      timeoutMs: WORKER_REQUEST_TIMEOUT_MS
    });
    if ('id' in response && response.id !== request.id) {
      throw new Error('微信 Worker 响应与请求不匹配');
    }
    if (!response.ok) {
      throw new Error(workerErrorMessage(response.error.code, response.error.message));
    }
    return response.result;
  }

  private messagePage(response: WechatWorkerPage<WechatWorkerMessage>): WechatPage<WechatMessage> {
    return {
      items: response.items.map(item => ({
        messageId: item.messageId,
        localId: item.localId,
        serverId: item.serverId,
        sessionId: item.sessionId,
        senderId: item.senderId,
        senderDisplayName: item.senderDisplayName,
        sentAt: item.sentAt,
        sequence: item.sequence,
        type: item.type,
        subtype: item.subtype,
        text: item.text,
        quoteMessageId: item.quoteMessageId,
        card: item.card,
        media: item.media.map(media => ({ ...media })),
        unknownPayload: item.unknownPayload
      })),
      nextCursor: response.nextCursor,
      hasMore: response.hasMore,
      returnedCount: response.returnedCount,
      knownTotal: response.knownTotal,
      coverage: {
        start: response.coverage.start ?? new Date(0).toISOString(),
        end: response.coverage.end ?? new Date().toISOString(),
        localOnly: true,
        complete: response.coverage.complete,
        notes: this.coverageNotes(response.coverage)
      },
      truncation: response.truncation === null ? null
        : response.truncation === 'items' ? 'messages' : 'bytes',
      readAt: response.readAt
    };
  }

  private coverageNotes(coverage: {
    skippedDatabases: Array<{ path: string; reason: string }>;
    notes: string[];
  }): string[] {
    return [
      ...coverage.notes,
      ...coverage.skippedDatabases.map(item => `未覆盖 ${item.path}：${item.reason}`)
    ];
  }
}

function workerErrorMessage(code: string, fallback: string): string {
  if (code === 'MEMORY_SQLITE_UNAVAILABLE') return '当前运行时不支持微信内存数据库读取';
  if (code === 'PATH_ESCAPE' || code === 'INVALID_PATH') return '微信数据目录校验失败，请重新连接';
  if (code === 'INVALID_CURSOR' || code === 'MEDIA_HANDLE_EXPIRED') return fallback;
  if (code === 'SESSION_NOT_FOUND') return fallback;
  if (code === 'RESULT_TOO_LARGE') return '微信查询结果过大，请缩小时间或会话范围';
  return fallback || '微信本机数据读取失败';
}

function isWorkerPageOf<Item extends object>(
  value: unknown,
  itemKey: keyof Item & string
): value is WechatWorkerPage<Item> {
  return !!value && typeof value === 'object' && 'items' in value &&
    Array.isArray(value.items) &&
    (value.items.length === 0 || value.items.every(item =>
      item && typeof item === 'object' && itemKey in item
    ));
}

export function wechatAdapter(reader: WechatReader): WechatAdapter {
  return {
    providerId: 'wechat',
    reader,
    verify: async () => ({
      'wechat.sessions': 'unavailable',
      'wechat.messages': 'unavailable',
      'wechat.search': 'unavailable',
      'wechat.media': 'unavailable'
    })
  };
}
