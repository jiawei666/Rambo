import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomUUID
} from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeWechatMessageContent, parseWechatMessageContent } from './wechat-content';
import {
  decryptWechatV2ImageDat,
  deriveWechatImageKeyCandidates,
  type WechatImageKey
} from './wechat-image-key';
import { decryptWechatDatabase } from './wechat-sqlcipher';

/**
 * The utility process protocol deliberately contains no connection or Grant
 * authority. The main process must filter the account, database list and
 * keys before sending a request here.
 */
export type WechatWorkerOperation = 'sessions' | 'messages' | 'search' | 'media';
export type WechatWorkerKey = string | Uint8Array | number[];
export type WechatWorkerDatabaseOpener = (plain: Buffer) => SqlDatabase;

export interface WechatWorkerDatabaseInput {
  /** Relative to dataDirectory. In the application this includes db_storage/. */
  path: string;
  /** The 32-byte SQLCipher key. Missing means this database is intentionally uncovered. */
  key?: WechatWorkerKey;
}

export interface WechatWorkerBaseRequest {
  id: string;
  operation: WechatWorkerOperation;
  /** The fixed account directory, never the WeChat.app bundle. */
  dataDirectory: string;
  databases: WechatWorkerDatabaseInput[];
  /** Used only for the local image key derivation needed by V2 .dat files. */
  accountId?: string;
  /** Independently captured and verified image key; database keys cannot decrypt media. */
  imageKey?: WechatImageKey;
}

export interface WechatWorkerSessionQuery {
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface WechatWorkerTimeQuery {
  start: string;
  end: string;
  cursor?: string;
  limit?: number;
  sessionIds?: string[];
}

export interface WechatWorkerSearchQuery extends WechatWorkerTimeQuery {
  query: string;
  messageTypes?: string[];
}

export interface WechatWorkerMediaQuery {
  resourceHandle: string;
}

export type WechatWorkerRequest =
  | (WechatWorkerBaseRequest & { operation: 'sessions'; query?: WechatWorkerSessionQuery })
  | (WechatWorkerBaseRequest & { operation: 'messages'; query: WechatWorkerTimeQuery })
  | (WechatWorkerBaseRequest & { operation: 'search'; query: WechatWorkerSearchQuery })
  | (WechatWorkerBaseRequest & { operation: 'media'; query: WechatWorkerMediaQuery; databases?: WechatWorkerDatabaseInput[] });

export interface WechatWorkerCoverage {
  start: string | null;
  end: string | null;
  localOnly: true;
  complete: boolean;
  databasePaths: string[];
  skippedDatabases: Array<{ path: string; reason: string }>;
  notes: string[];
}

export interface WechatWorkerPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  returnedCount: number;
  knownTotal: number;
  coverage: WechatWorkerCoverage;
  truncation: 'items' | 'bytes' | null;
  readAt: string;
}

export interface WechatWorkerSession {
  sessionId: string;
  displayName: string;
  type: 'private' | 'group' | 'official' | 'service' | 'system' | 'unknown';
  latestMessageAt: string | null;
  unreadCount: number;
}

export interface WechatWorkerMediaRef {
  mediaId: string;
  kind: 'image' | 'thumbnail' | 'video' | 'audio' | 'file' | 'sticker' | 'unknown';
  status: 'available' | 'thumbnailOnly' | 'missing' | 'unavailable';
  mimeType: string | null;
  size: number | null;
  resourceHandle: string | null;
  transcription?: string | null;
  diagnostics?: string[];
}

export interface WechatWorkerMessage {
  messageId: string;
  localId: string;
  serverId: string | null;
  sourceDatabase: string;
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
  details: Record<string, unknown> | null;
  media: WechatWorkerMediaRef[];
  unknownPayload: Record<string, unknown> | null;
  diagnostics: string[];
}

export interface WechatWorkerMediaResult {
  resourceHandle: string;
  kind: 'image' | 'thumbnail' | 'video' | 'audio' | 'file' | 'sticker' | 'unknown';
  status: 'available' | 'thumbnailOnly' | 'missing' | 'unavailable';
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  bytes?: Uint8Array;
  transcription?: string | null;
  limitation?: string;
  diagnostics: string[];
}

export type WechatWorkerResult =
  | WechatWorkerPage<WechatWorkerSession>
  | WechatWorkerPage<WechatWorkerMessage>
  | WechatWorkerMediaResult;

export type WechatWorkerResponse =
  | { id: string; ok: true; result: WechatWorkerResult }
  | { id: string; ok: false; error: { code: string; message: string } };

const MAX_DATABASES = 512;
const MAX_SESSION_IDS = 128;
const MAX_PAGE_ITEMS = 500;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_QUERY_DAYS = 366;
const MAX_CURSOR_AGE_MS = 15 * 60 * 1000;
const MAX_MEDIA_HANDLE_AGE_MS = 30 * 60 * 1000;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const ZSTD_COMPRESSION_TYPE = 4;

type SqlRow = Record<string, unknown>;
type SqlDatabase = InstanceType<typeof DatabaseSync>;

interface OpenDatabase {
  path: string;
  db: SqlDatabase;
  /** True when the base database was readable but its WAL snapshot was rejected. */
  walFallback?: boolean;
}

interface CursorState {
  fingerprint: string;
  offset: number;
  createdAt: number;
}

interface MediaHandleState {
  root: string;
  relativePath: string | null;
  kind: WechatWorkerMediaResult['kind'];
  status: WechatWorkerMediaResult['status'];
  accountId: string;
  voiceServerId: string | null;
  voiceSessionId: string | null;
  transcription: string | null;
  createdAt: number;
}

interface LocatedVoice {
  serverId: string;
  sessionId: string;
  size: number;
}

const cursors = new Map<string, CursorState>();
const mediaHandles = new Map<string, MediaHandleState>();

class WechatWorkerProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WechatWorkerProtocolError';
    this.code = code;
  }
}

function protocolError(code: string, message: string): never {
  throw new WechatWorkerProtocolError(code, message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value);
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : fallback;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  return fallback;
}

function integerValue(value: unknown, fallback = 0): number {
  const number = numberValue(value, fallback);
  return Number.isSafeInteger(number) ? number : fallback;
}

function bytesValue(value: unknown): Buffer {
  if (value === null || value === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(String(value), 'utf8');
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoFromSeconds(value: unknown): string | null {
  const raw = numberValue(value, NaN);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const milliseconds = raw > 100_000_000_000 ? raw : raw * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function parseTime(value: unknown, field: string): { iso: string; seconds: number } {
  if (typeof value !== 'string' || !value.trim()) protocolError('INVALID_QUERY', `${field} 必须是 ISO 8601 时间`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) protocolError('INVALID_QUERY', `${field} 时间格式无效`);
  return { iso: new Date(milliseconds).toISOString(), seconds: Math.floor(milliseconds / 1000) };
}

function parseRange(query: { start?: unknown; end?: unknown }): { start: string; end: string; startSeconds: number; endSeconds: number } {
  const start = parseTime(query.start, 'start');
  const end = parseTime(query.end, 'end');
  if (end.seconds <= start.seconds) protocolError('INVALID_QUERY', '结束时间必须晚于开始时间');
  if (end.seconds - start.seconds > MAX_QUERY_DAYS * 86_400) protocolError('INVALID_QUERY', '单次微信查询范围不能超过 366 天');
  return { start: start.iso, end: end.iso, startSeconds: start.seconds, endSeconds: end.seconds };
}

function validateDataDirectory(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    protocolError('INVALID_PATH', 'dataDirectory 必须是绝对目录');
  }
  try {
    const root = realpathSync(value);
    if (!statSync(root).isDirectory()) protocolError('INVALID_PATH', 'dataDirectory 不是目录');
    return root;
  } catch {
    protocolError('INVALID_PATH', 'dataDirectory 不可读取');
  }
}

function isInside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function validateRelativeDatabasePath(value: unknown): string {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\0') || value.includes('\\')) {
    protocolError('INVALID_PATH', '数据库路径必须是相对路径');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || !value.endsWith('.db')) {
    protocolError('INVALID_PATH', '数据库路径包含非法片段');
  }
  return normalize(value).split(sep).join('/');
}

function resolveDatabasePath(root: string, relativePath: string): string {
  const safePath = validateRelativeDatabasePath(relativePath);
  const candidate = resolve(root, safePath);
  if (!isInside(root, candidate)) protocolError('PATH_ESCAPE', '数据库路径越过账户目录');
  let actual: string;
  try {
    actual = realpathSync(candidate);
    if (!isInside(root, actual) || !statSync(actual).isFile()) protocolError('PATH_ESCAPE', '数据库路径越过账户目录');
  } catch {
    protocolError('DATABASE_MISSING', '数据库不存在或不可读取');
  }
  return actual;
}

function resolveMediaPath(root: string, relativePath: string): string | null {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) || relativePath.includes('\0') || relativePath.includes('\\')) return null;
  const candidate = resolve(root, relativePath);
  if (!isInside(root, candidate) || !existsSync(candidate)) return null;
  try {
    const actual = realpathSync(candidate);
    return isInside(root, actual) && statSync(actual).isFile() ? actual : null;
  } catch {
    return null;
  }
}

function keyBytes(value: WechatWorkerKey): Buffer {
  const bytes = typeof value === 'string'
    ? /^[a-f0-9]{64}$/iu.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
    : Buffer.from(value);
  if (bytes.length !== 32) protocolError('INVALID_KEY', '数据库密钥必须为 32 字节');
  return bytes;
}

function databaseInputList(request: WechatWorkerBaseRequest): WechatWorkerDatabaseInput[] {
  if (!Array.isArray(request.databases) || request.databases.length > MAX_DATABASES) {
    protocolError('INVALID_REQUEST', '数据库列表无效或超出数量限制');
  }
  const seen = new Set<string>();
  return request.databases.map(input => {
    const record = asRecord(input);
    const path = validateRelativeDatabasePath(record?.path);
    if (seen.has(path)) protocolError('INVALID_REQUEST', '数据库列表存在重复路径');
    seen.add(path);
    const key = record?.key;
    if (key !== undefined && typeof key !== 'string' && !Array.isArray(key) && !(key instanceof Uint8Array)) {
      protocolError('INVALID_KEY', '数据库密钥格式无效');
    }
    return { path, key: key as WechatWorkerKey | undefined };
  });
}

function validateDatabaseBoundaries(root: string, inputs: WechatWorkerDatabaseInput[]): void {
  for (const input of inputs) {
    const candidate = resolve(root, input.path);
    if (!isInside(root, candidate) || !existsSync(candidate)) continue;
    try {
      const actual = realpathSync(candidate);
      if (!isInside(root, actual) || !statSync(actual).isFile()) protocolError('PATH_ESCAPE', '数据库路径越过账户目录');
    } catch {
      protocolError('PATH_ESCAPE', '数据库路径越过账户目录');
    }
  }
}

function walPathFor(dbPath: string): string | null {
  const path = `${dbPath}-wal`;
  try { return existsSync(path) && statSync(path).isFile() ? path : null; }
  catch { return null; }
}

interface OpenResult {
  opened: OpenDatabase[];
  skipped: Array<{ path: string; reason: string }>;
}

function openDatabases(
  root: string,
  inputs: WechatWorkerDatabaseInput[],
  wanted: (path: string) => boolean,
  openDatabase: WechatWorkerDatabaseOpener = openPlainDatabase
): OpenResult {
  const opened: OpenDatabase[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const input of inputs) {
    if (!wanted(input.path)) continue;
    if (!input.key) {
      skipped.push({ path: input.path, reason: 'missing_key' });
      continue;
    }
    try {
      const path = resolveDatabasePath(root, input.path);
      const encrypted = readFileSync(path);
      const walPath = walPathFor(path);
      const wal = walPath ? readFileSync(walPath) : Buffer.alloc(0);
      try {
        const plain = decryptWechatDatabase(keyBytes(input.key), encrypted, wal);
        const database = openDatabase(plain);
        try {
          database.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
        } catch (error) {
          database.close();
          throw error;
        }
        opened.push({ path: input.path, db: database });
      } catch (error) {
        if (!wal.length || !allowsWalFallback(error)) throw error;
        // WeChat 4.2 may leave a WAL whose committed frame set cannot produce
        // a valid SQLite snapshot. Keep the already-verified base database
        // readable, but let coverage disclose that the latest commit is absent.
        const plainBase = decryptWechatDatabase(
          keyBytes(input.key),
          encrypted,
          Buffer.alloc(0)
        );
        opened.push({
          path: input.path,
          db: openDatabase(plainBase),
          walFallback: true
        });
      }
    } catch (error) {
      if (error instanceof WechatWorkerProtocolError && error.code === 'PATH_ESCAPE') throw error;
      skipped.push({ path: input.path, reason: databaseFailureReason(error) });
    }
  }
  return { opened, skipped };
}

function allowsWalFallback(error: unknown): boolean {
  const details = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : {};
  const code = String(details.code ?? '').toUpperCase();
  const message = String(details.message ?? error ?? '').toLowerCase();
  return code.startsWith('ERR_SQLITE') ||
    code.startsWith('SQLITE_') ||
    message.includes('sqlite') ||
    message.includes('database') ||
    message.includes('malformed') ||
    message.includes('not a database');
}

function databaseFailureReason(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (code === 'EACCES' || code === 'EPERM') return 'access_denied';
  if (code === 'ENOENT') return 'database_unreadable';
  if (code === 'SQLITE_CORRUPT') return 'database_corrupt';
  if (code === 'SQLITE_NOTADB') return 'database_invalid';
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('密钥无法验证')) return 'key_rejected';
  if (message.includes('不存在') || message.includes('不可读取')) return 'database_unreadable';
  if (message.includes('不是完整')) return 'database_invalid';
  return 'database_open_failed';
}

function openPlainDatabase(plain: Buffer): SqlDatabase {
  const memory = new DatabaseSync(':memory:');
  const deserialize = (memory as SqlDatabase & { deserialize?: (data: Uint8Array) => void }).deserialize;
  if (typeof deserialize === 'function') {
    deserialize.call(memory, plain);
    try { memory.exec('PRAGMA temp_store=MEMORY;'); } catch { /* old SQLite */ }
    return memory;
  }
  memory.close();
  // Decrypted WeChat content must never be persisted. The production utility
  // process runs on Electron's SQLite build, which provides deserialize().
  // Stock Node without it is a test environment, not a supported fallback.
  protocolError('MEMORY_SQLITE_UNAVAILABLE', '当前运行时不支持内存数据库，无法安全读取微信');
}

function closeDatabases(opened: OpenDatabase[]): void {
  for (const item of opened) {
    try { item.db.close(); } catch { /* already closed */ }
  }
}

function hasTable(db: SqlDatabase, name: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name));
  } catch {
    return false;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function contactNames(opened: OpenDatabase[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const item of opened) {
    if (!/(^|\/)contact\/contact\.db$/u.test(item.path) || !hasTable(item.db, 'contact')) continue;
    try {
      const rows = item.db.prepare('SELECT username,alias,nick_name,remark,description FROM contact WHERE username IS NOT NULL AND username <> ?').all('') as SqlRow[];
      for (const row of rows) {
        const id = stringValue(row.username);
        if (!id) continue;
        const display = [row.remark, row.nick_name, row.alias, row.description, row.username]
          .map(stringValue).find(value => value?.trim());
        if (display) names.set(id, display.trim());
      }
    } catch { /* an older contact schema is reported through coverage */ }
  }
  return names;
}

function sessionType(username: string, rawType: unknown): WechatWorkerSession['type'] {
  if (username.endsWith('@chatroom')) return 'group';
  if (username === 'filehelper' || username === 'fmessage' || username === 'newsapp' || username.startsWith('weixin')) return 'system';
  if (username.startsWith('gh_') || username.startsWith('mp_')) return 'official';
  const type = integerValue(rawType, -1);
  if (type === 1 || type === 2) return 'group';
  if (type === 3) return 'official';
  return username ? 'private' : 'unknown';
}

function makeCoverage(
  start: string | null,
  end: string | null,
  opened: OpenDatabase[],
  skipped: Array<{ path: string; reason: string }>,
  notes: string[] = []
): WechatWorkerCoverage {
  const walFallbackCount = opened.filter(item => item.walFallback).length;
  const coverageNotes = [...notes];
  if (walFallbackCount > 0) {
    coverageNotes.push(
      `有 ${walFallbackCount} 个数据库的 WAL 回放结果不可用，已读取基础数据库；查询可能不包含最新提交`
    );
  }
  return {
    start,
    end,
    localOnly: true,
    complete: skipped.length === 0 && walFallbackCount === 0,
    databasePaths: opened.map(item => item.path),
    skippedDatabases: skipped,
    notes: coverageNotes
  };
}

function pageFingerprint(operation: string, root: string, query: unknown, inputs: WechatWorkerDatabaseInput[]): string {
  return createHash('sha256').update(canonicalJson({ operation, root, query, databases: inputs.map(({ path }) => path) })).digest('hex');
}

function pruneState(): void {
  const now = Date.now();
  for (const [key, state] of cursors) if (now - state.createdAt > MAX_CURSOR_AGE_MS) cursors.delete(key);
  for (const [key, state] of mediaHandles) if (now - state.createdAt > MAX_MEDIA_HANDLE_AGE_MS) mediaHandles.delete(key);
}

function cursorOffset(cursor: unknown, fingerprint: string): number {
  pruneState();
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  if (typeof cursor !== 'string' || !/^[a-f0-9-]{16,80}$/u.test(cursor)) protocolError('INVALID_CURSOR', '微信分页游标无效或已过期');
  const state = cursors.get(cursor);
  if (!state || state.fingerprint !== fingerprint || Date.now() - state.createdAt > MAX_CURSOR_AGE_MS) {
    cursors.delete(cursor as string);
    protocolError('INVALID_CURSOR', '微信分页游标不属于当前查询或已过期');
  }
  return state.offset;
}

function createCursor(fingerprint: string, offset: number): string {
  const token = randomUUID();
  cursors.set(token, { fingerprint, offset, createdAt: Date.now() });
  return token;
}

function page<T>(items: T[], options: {
  fingerprint: string;
  cursor?: string;
  limit?: number;
  coverage: WechatWorkerCoverage;
}): WechatWorkerPage<T> {
  const offset = cursorOffset(options.cursor, options.fingerprint);
  const limit = options.limit === undefined ? 100 : integerValue(options.limit, -1);
  if (limit < 1 || limit > MAX_PAGE_ITEMS) protocolError('INVALID_QUERY', `limit 必须为 1 到 ${MAX_PAGE_ITEMS}`);
  if (offset > items.length) protocolError('INVALID_CURSOR', '微信分页游标超出当前结果');
  const selected: T[] = [];
  let bytes = 2;
  let truncation: WechatWorkerPage<T>['truncation'] = null;
  for (let index = offset; index < items.length && selected.length < limit; index += 1) {
    const candidate = [...selected, items[index]];
    const candidateBytes = Buffer.byteLength(JSON.stringify(jsonSafe(candidate)), 'utf8');
    if (candidateBytes > MAX_RESULT_BYTES) {
      truncation = 'bytes';
      break;
    }
    selected.push(items[index]);
    bytes = candidateBytes;
  }
  if (selected.length >= limit && offset + selected.length < items.length) truncation = 'items';
  if (!selected.length && offset < items.length) protocolError('RESULT_TOO_LARGE', '单条微信记录超过 worker 返回大小限制');
  const nextOffset = offset + selected.length;
  const hasMore = nextOffset < items.length;
  const nextCursor = hasMore ? createCursor(options.fingerprint, nextOffset) : null;
  const coverage = { ...options.coverage, complete: options.coverage.complete && !hasMore };
  return {
    items: selected,
    nextCursor,
    hasMore,
    returnedCount: selected.length,
    knownTotal: items.length,
    coverage,
    truncation,
    readAt: nowIso()
  };
}

function messageTable(sessionId: string): string {
  return `Msg_${createHash('md5').update(sessionId).digest('hex')}`;
}

interface RawMessage {
  database: string;
  sessionId: string;
  localId: number;
  serverId: string;
  localType: number;
  sortSeq: number;
  createTime: number;
  senderId: string;
  content: string;
  packed: Buffer;
  compression: number;
}

function readMessageRows(
  opened: OpenDatabase[],
  sessionIds: string[],
  startSeconds: number,
  endSeconds: number,
  skipped: Array<{ path: string; reason: string }>
): RawMessage[] {
  const rows: RawMessage[] = [];
  for (const item of opened) {
    if (!/^(.+\/)?message\/(?:biz_)?message_\d+\.db$/u.test(item.path)) continue;
    for (const sessionId of sessionIds) {
      const table = messageTable(sessionId);
      if (!hasTable(item.db, table)) continue;
      try {
        const query = `SELECT m.local_id,m.server_id,m.local_type,m.sort_seq,m.create_time,n.user_name AS sender,m.message_content,m.WCDB_CT_message_content,m.packed_info_data FROM ${quoteIdentifier(table)} m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE IFNULL(m.create_time,0)>=? AND IFNULL(m.create_time,0)<? ORDER BY m.create_time ASC,m.sort_seq ASC,m.local_id ASC`;
        const statement = item.db.prepare(query);
        statement.setReadBigInts(true);
        const rawRows = statement.all(startSeconds, endSeconds) as SqlRow[];
        for (const raw of rawRows) {
          rows.push({
            database: item.path,
            sessionId,
            localId: integerValue(raw.local_id),
            serverId: stringValue(raw.server_id) ?? '',
            localType: integerValue(raw.local_type),
            sortSeq: integerValue(raw.sort_seq),
            createTime: integerValue(raw.create_time),
            senderId: stringValue(raw.sender) ?? '',
            content: decodeWechatMessageContent(raw.message_content, raw.WCDB_CT_message_content),
            packed: bytesValue(raw.packed_info_data),
            compression: integerValue(raw.WCDB_CT_message_content)
          });
        }
      } catch (error) {
        skipped.push({ path: item.path, reason: messageQueryFailureReason(error) });
      }
    }
  }
  rows.sort((a, b) => a.createTime - b.createTime || a.sortSeq - b.sortSeq || a.database.localeCompare(b.database) || a.localId - b.localId);
  return rows;
}

function messageQueryFailureReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === 'ERR_OUT_OF_RANGE') return 'message_integer_out_of_range';
    if (code === 'SQLITE_CORRUPT') return 'message_table_corrupt';
    if (code === 'SQLITE_NOTADB') return 'message_table_invalid';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/no such column/iu.test(message)) return 'message_column_missing';
  if (/no such table/iu.test(message)) return 'message_table_missing';
  return 'message_query_failed';
}

function safeMediaName(value: string | null): string | null {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) return null;
  return value;
}

function monthFor(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return '';
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
}

function mimeForBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'wxgf') return 'image/wxgf';
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 6)).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WAVE') return 'audio/wav';
  if (bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'OggS') return 'audio/ogg';
  if (bytes.length >= 3 && Buffer.from(bytes.subarray(0, 3)).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 4 && bytes[0] === 0x02 && bytes[1] === 0x23 && bytes[2] === 0x21) return 'audio/silk';
  if (bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === '%PDF') return 'application/pdf';
  if (bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'PK\x03\x04') return 'application/zip';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString('ascii') === 'ftyp') return 'video/mp4';
  return null;
}

function mimeForFileName(fileName: string | null): string | null {
  const extension = extname(fileName ?? '').toLocaleLowerCase();
  const types: Record<string, string> = {
    '.aac': 'audio/aac',
    '.amr': 'audio/amr',
    '.avi': 'video/x-msvideo',
    '.csv': 'text/csv',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.flac': 'audio/flac',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.m4a': 'audio/mp4',
    '.m4v': 'video/x-m4v',
    '.md': 'text/markdown',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain; charset=utf-8',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip'
  };
  return types[extension] ?? null;
}

function voiceKey(sessionId: string, serverId: string): string {
  return `${sessionId}\u0000${serverId}`;
}

function imageKeyCandidates(
  root: string,
  accountId: string,
  imageKey?: WechatImageKey
): Array<{ aes: Buffer; xor: number }> {
  if (imageKey) return [{ aes: Buffer.from(imageKey.aesKey, 'ascii'), xor: imageKey.xorKey }];
  const documents = resolve(root, '../..');
  const containerData = resolve(documents, '..');
  const directories = [...new Set([
    join(documents, 'app_data/net/kvcomm'),
    join(documents, 'xwechat/net/kvcomm'),
    join(documents, 'app_data/ilink/kvcomm'),
    join(documents, 'app_data/roam/ilink/kvcomm'),
    join(containerData, 'Library/Application Support/com.tencent.xinWeChat/xwechat/net/kvcomm'),
    join(containerData, 'Library/Application Support/com.tencent.xinWeChat/net/kvcomm')
  ])];
  const codes = new Set<number>();
  for (const directory of directories) {
    try {
      for (const entry of readdirSync(directory)) {
        const match = /^key_(\d+)_/u.exec(entry);
        if (!match) continue;
        const code = Number(match[1]);
        if (Number.isSafeInteger(code) && code >= 0 && code <= 0xffffffff) codes.add(code);
      }
    } catch { /* optional directory */ }
  }
  const seen = new Set<string>();
  const candidates: Array<{ aes: Buffer; xor: number }> = [];
  for (const key of deriveWechatImageKeyCandidates(codes, accountId)) {
    const aes = Buffer.from(key.aesKey, 'ascii');
    const identity = `${key.aesKey}:${key.xorKey}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push({ aes, xor: key.xorKey });
  }
  return candidates;
}

function decryptEcbHead(head: Buffer, key: Buffer): Buffer | null {
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(head), decipher.final()]);
  } catch {
    return null;
  }
}

function decryptImageDat(
  bytes: Buffer,
  root: string,
  accountId: string,
  imageKey?: WechatImageKey
): { bytes: Buffer; mimeType: string } | null {
  const directMime = mimeForBytes(bytes);
  if (directMime?.startsWith('image/')) return { bytes, mimeType: directMime };
  const oldHeaders = [Buffer.from([0xff, 0xd8, 0xff]), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('GIF8')];
  for (const header of oldHeaders) {
    if (bytes.length <= header.length) continue;
    const xor = bytes[0] ^ header[0];
    const decoded = Buffer.from(bytes.map(value => value ^ xor));
    if (Buffer.from(decoded.subarray(0, header.length)).equals(header)) {
      const mimeType = mimeForBytes(decoded);
      if (mimeType?.startsWith('image/')) return { bytes: decoded, mimeType };
    }
  }
  if (bytes.length < 15 || bytes[0] !== 0x07 || bytes[1] !== 0x08 || bytes[2] !== 0x56 || bytes[4] !== 0x08 || bytes[5] !== 0x07) return null;
  const version = bytes[3];
  if (version !== 0x31 && version !== 0x32) return null;
  const aesSize = bytes.readUInt32LE(6);
  const xorSize = bytes.readUInt32LE(10);
  const body = bytes.subarray(15);
  const paddedSize = (Math.floor(aesSize / 16) + 1) * 16;
  if (paddedSize > body.length || xorSize > body.length - paddedSize) return null;
  if (version === 0x32) {
    for (const key of imageKeyCandidates(root, accountId, imageKey)) {
      const decoded = decryptWechatV2ImageDat(bytes, {
        aesKey: key.aes.toString('ascii'),
        xorKey: key.xor
      });
      if (decoded) return decoded;
    }
    return null;
  }
  for (const key of [{ aes: Buffer.from('cfcd208495d565ef', 'ascii'), xor: 0 }]) {
    const decryptedHead = decryptEcbHead(body.subarray(0, paddedSize), key.aes);
    if (!decryptedHead) continue;
    const padding = decryptedHead.at(-1) ?? 0;
    if (padding < 1 || padding > 16 || padding > decryptedHead.length) continue;
    if (!decryptedHead.subarray(decryptedHead.length - padding).every(value => value === padding)) continue;
    const head = decryptedHead.subarray(0, decryptedHead.length - padding);
    const middleEnd = body.length - xorSize;
    const output = Buffer.concat([head, body.subarray(paddedSize, middleEnd), Buffer.from(body.subarray(middleEnd).map(value => value ^ key.xor))]);
    const mimeType = mimeForBytes(output);
    if (mimeType?.startsWith('image/')) return { bytes: output, mimeType };
  }
  return null;
}

interface LocatedMedia {
  path: string | null;
  thumbnailPath: string | null;
  kind: WechatWorkerMediaRef['kind'];
  status: WechatWorkerMediaRef['status'];
  mimeType: string | null;
  size: number | null;
  fileName: string | null;
  transcription?: string | null;
  voiceServerId?: string;
  voiceSessionId?: string;
  limitation?: string;
}

function inspectPath(root: string, relativePath: string | null): { path: string; size: number } | null {
  if (!relativePath) return null;
  const path = resolveMediaPath(root, relativePath);
  if (!path) return null;
  try { return { path, size: statSync(path).size }; } catch { return null; }
}

function localStickerPath(root: string, md5: string | null): { path: string; size: number } | null {
  const expected = md5?.toLowerCase() ?? '';
  if (!/^[a-f0-9]{8,64}$/u.test(expected)) return null;
  const roots = [
    'msg/emoticon',
    'msg/emoji',
    'emoticon',
    'emoji',
    'cache/emoticon',
    'cache/emoji'
  ];
  const expectedNames = new Set([
    expected,
    `${expected}.gif`,
    `${expected}.png`,
    `${expected}.jpg`,
    `${expected}.jpeg`,
    `${expected}.dat`
  ]);
  const pending = roots.map(path => ({ path, depth: 0 }));
  let visited = 0;
  while (pending.length && visited < 4096) {
    const current = pending.shift()!;
    const directory = resolve(root, current.path);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > 4096) break;
      const relativePath = `${current.path}/${entry.name}`;
      if (entry.isDirectory() && current.depth < 4) {
        pending.push({ path: relativePath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !expectedNames.has(entry.name.toLowerCase())) continue;
      const inspected = inspectPath(root, relativePath);
      if (!inspected) continue;
      try {
        const bytes = readFileSync(inspected.path);
        if (createHash('md5').update(bytes).digest('hex') !== expected) continue;
      } catch { continue; }
      return inspected;
    }
  }
  return null;
}

function voiceRows(
  db: SqlDatabase,
  sessionId: string | null,
  serverId: string | null
): Array<{ serverId: string; sessionId: string; bytes: Buffer }> {
  if (!hasTable(db, 'VoiceInfo')) return [];
  try {
    const hasNames = hasTable(db, 'Name2Id');
    const query = hasNames
      ? `SELECT IFNULL(v.svr_id,0) AS server_id, IFNULL(n.user_name,'') AS session_id, v.voice_data
         FROM VoiceInfo v LEFT JOIN Name2Id n ON n.rowid=v.chat_name_id
         WHERE (?1 IS NULL OR n.user_name=?1) AND (?2 IS NULL OR CAST(v.svr_id AS TEXT)=?2) AND length(v.voice_data)>0`
      : `SELECT IFNULL(v.svr_id,0) AS server_id, '' AS session_id, v.voice_data
         FROM VoiceInfo v
         WHERE (?1 IS NULL OR CAST(v.svr_id AS TEXT)=?2) AND length(v.voice_data)>0`;
    const statement = db.prepare(query);
    statement.setReadBigInts(true);
    const rows = statement.all(sessionId, serverId) as SqlRow[];
    return rows.map(row => ({
      serverId: stringValue(row.server_id) ?? '',
      sessionId: stringValue(row.session_id) ?? '',
      bytes: bytesValue(row.voice_data)
    })).filter(row => row.serverId && row.bytes.length > 0);
  } catch {
    return [];
  }
}

function collectVoiceAvailability(opened: OpenDatabase[]): Map<string, LocatedVoice> {
  const voices = new Map<string, LocatedVoice>();
  for (const item of opened) {
    if (!/(^|\/)message\/media_\d+\.db$/u.test(item.path)) continue;
    for (const row of voiceRows(item.db, null, null)) {
      if (!row.sessionId) continue;
      voices.set(voiceKey(row.sessionId, row.serverId), {
        serverId: row.serverId,
        sessionId: row.sessionId,
        size: row.bytes.length
      });
    }
  }
  return voices;
}

function locateMessageMedia(
  root: string,
  sessionId: string,
  sentAt: string,
  serverId: string,
  descriptor: Record<string, unknown>,
  voiceAvailability: Map<string, LocatedVoice>
): LocatedMedia {
  const rawKind = String(descriptor.kind);
  const kind: WechatWorkerMediaRef['kind'] = rawKind === 'voice' ? 'audio'
    : rawKind === 'image' || rawKind === 'video' || rawKind === 'file' || rawKind === 'sticker'
      ? rawKind
      : 'unknown';
  const name = safeMediaName(stringValue(descriptor.name));
  if (kind === 'image' && name) {
    const directory = `msg/attach/${createHash('md5').update(sessionId).digest('hex')}/${monthFor(sentAt)}/Img`;
    const original = inspectPath(root, `${directory}/${name}_h.dat`) ?? inspectPath(root, `${directory}/${name}.dat`);
    const thumbnail = inspectPath(root, `${directory}/${name}_t.dat`);
    const selected = original ?? thumbnail;
    return {
      path: selected?.path ?? null,
      thumbnailPath: thumbnail?.path ?? null,
      kind: original ? 'image' : 'thumbnail',
      status: original ? 'available' : thumbnail ? 'thumbnailOnly' : 'missing',
      mimeType: null,
      size: selected?.size ?? null,
      fileName: selected ? basename(selected.path) : null,
      limitation: original ? undefined : thumbnail ? '仅有缩略图，本机未找到原图' : '微信尚未下载图片'
    };
  }
  if (kind === 'audio') {
    const voice = serverId && voiceAvailability.get(voiceKey(sessionId, serverId));
    if (!voice) {
      return {
        path: null,
        thumbnailPath: null,
        kind: 'audio',
        status: 'missing',
        mimeType: null,
        size: null,
        fileName: serverId ? `voice-${serverId}.silk` : null,
        limitation: serverId ? '微信尚未在本机媒体数据库保存这条语音' : '语音消息缺少稳定服务端 ID，无法定位本机语音'
      };
    }
    return {
      path: null,
      thumbnailPath: null,
      kind: 'audio',
      status: 'available',
      mimeType: 'audio/silk',
      size: voice.size,
      fileName: `voice-${voice.serverId}.silk`,
      transcription: stringValue(descriptor.transcription),
      voiceServerId: voice.serverId,
      voiceSessionId: voice.sessionId
    };
  }
  if (kind === 'video' && name) {
    const directory = `msg/video/${monthFor(sentAt)}`;
    const original = inspectPath(root, `${directory}/${name}.mp4`);
    const thumbnail = inspectPath(root, `${directory}/${name}_thumb.jpg`);
    return {
      path: original?.path ?? thumbnail?.path ?? null,
      thumbnailPath: thumbnail?.path ?? null,
      kind: original ? 'video' : 'thumbnail',
      status: original ? 'available' : thumbnail ? 'thumbnailOnly' : 'missing',
      mimeType: original ? 'video/mp4' : thumbnail ? 'image/jpeg' : null,
      size: (original ?? thumbnail)?.size ?? null,
      fileName: (original ?? thumbnail) ? basename((original ?? thumbnail)!.path) : null,
      limitation: original ? undefined : thumbnail ? '仅有视频封面，本机未找到原视频' : '微信尚未下载视频'
    };
  }
  if (kind === 'file') {
    const storedAs = safeMediaName(stringValue(descriptor.storedAs) ?? stringValue(descriptor.name));
    const candidate = storedAs ? inspectPath(root, `msg/file/${monthFor(sentAt)}/${storedAs}`) : null;
    return {
      path: candidate?.path ?? null,
      thumbnailPath: null,
      kind: 'file',
      status: candidate ? 'available' : 'missing',
      mimeType: mimeForFileName(candidate ? basename(candidate.path) : storedAs),
      size: candidate?.size ?? (integerValue(descriptor.size, 0) || null),
      fileName: candidate ? basename(candidate.path) : storedAs,
      limitation: candidate ? undefined : '微信尚未在本机保存普通文件'
    };
  }
  if (kind === 'sticker') {
    const candidate = localStickerPath(root, safeMediaName(stringValue(descriptor.md5)));
    if (!candidate) {
      return {
        path: null,
        thumbnailPath: null,
        kind: 'sticker',
        status: 'missing',
        mimeType: null,
        size: null,
        fileName: null,
        limitation: '微信未在本机保存贴纸；按本机只读边界不联网补取'
      };
    }
    return {
      path: candidate.path,
      thumbnailPath: null,
      kind: 'sticker',
      status: 'available',
      mimeType: mimeForFileName(basename(candidate.path)),
      size: candidate.size,
      fileName: basename(candidate.path)
    };
  }
  return {
    path: null,
    thumbnailPath: null,
    kind,
    status: 'unavailable',
    mimeType: null,
    size: null,
    fileName: null,
    limitation: '该媒体类型当前没有本机读取实现'
  };
}

function registerMedia(root: string, accountId: string, located: LocatedMedia): string | null {
  if ((!located.path && !located.voiceServerId) || located.status === 'missing' || located.status === 'unavailable') return null;
  pruneState();
  const handle = randomUUID().replaceAll('-', '');
  const relativePath = located.path ? relative(root, located.path).split(sep).join('/') : null;
  mediaHandles.set(handle, {
    root,
    relativePath,
    kind: located.kind,
    status: located.status,
    accountId,
    voiceServerId: located.voiceServerId ?? null,
    voiceSessionId: located.voiceSessionId ?? null,
    transcription: located.transcription ?? null,
    createdAt: Date.now()
  });
  return handle;
}

function mediaRef(
  root: string,
  accountId: string,
  imageKey: WechatImageKey | undefined,
  mediaId: string,
  descriptor: Record<string, unknown>,
  sessionId: string,
  sentAt: string,
  serverId: string,
  voiceAvailability: Map<string, LocatedVoice>
): WechatWorkerMediaRef {
  const located = locateMessageMedia(root, sessionId, sentAt, serverId, descriptor, voiceAvailability);
  let mimeType = located.mimeType;
  if (located.path && (located.kind === 'image' || located.kind === 'thumbnail' || located.kind === 'sticker')) {
    try {
      const decoded = decryptImageDat(readFileSync(located.path), root, accountId, imageKey);
      mimeType = decoded?.mimeType ?? mimeType;
    } catch { /* status remains explicit */ }
  }
  return {
    mediaId,
    kind: located.kind,
    status: located.status,
    mimeType,
    size: located.size,
    resourceHandle: registerMedia(root, accountId, located),
    ...(located.transcription ? { transcription: located.transcription } : {}),
    ...(located.limitation ? { diagnostics: [located.limitation] } : {})
  };
}

function messageFromRow(
  root: string,
  accountId: string,
  imageKey: WechatImageKey | undefined,
  names: Map<string, string>,
  row: RawMessage,
  voiceAvailability: Map<string, LocatedVoice>
): WechatWorkerMessage {
  const sentAt = isoFromSeconds(row.createTime) ?? new Date(0).toISOString();
  const parsed = parseWechatMessageContent(row.localType, row.content, row.packed);
  const serverId = row.serverId ? String(row.serverId) : null;
  const messageId = serverId
    ? `server:${row.database}:${serverId}`
    : `local:${row.database}:${row.localId}`;
  const media = parsed.mediaDescriptors.map((descriptor, index) => mediaRef(
    root,
    accountId,
    imageKey,
    `${messageId}:${index}`,
    descriptor as unknown as Record<string, unknown>,
    row.sessionId,
    sentAt,
    serverId ?? '',
    voiceAvailability
  ));
  const senderDisplayName = names.get(row.senderId) ?? row.senderId;
  return {
    messageId,
    localId: String(row.localId),
    serverId,
    sourceDatabase: row.database,
    sessionId: row.sessionId,
    senderId: row.senderId,
    senderDisplayName,
    sentAt,
    sequence: row.sortSeq || row.localId,
    type: parsed.type,
    subtype: parsed.subtype === null ? null : String(parsed.subtype),
    text: parsed.text,
    quoteMessageId: parsed.quoteMessageId,
    card: parsed.card,
    details: parsed.details,
    media,
    unknownPayload: parsed.unknownPayload,
    diagnostics: [...parsed.diagnostics]
  };
}

function buildMessage(
  root: string,
  accountId: string,
  imageKey: WechatImageKey | undefined,
  names: Map<string, string>,
  row: RawMessage,
  voiceAvailability: Map<string, LocatedVoice>
): WechatWorkerMessage {
  return messageFromRow(root, accountId, imageKey, names, row, voiceAvailability);
}

function sessionDatabases(inputs: WechatWorkerDatabaseInput[]): (path: string) => boolean {
  return path => /(^|\/)session\/session\.db$/u.test(path);
}

function contactsAndSession(
  root: string,
  inputs: WechatWorkerDatabaseInput[],
  openDatabase: WechatWorkerDatabaseOpener
): { opened: OpenDatabase[]; skipped: Array<{ path: string; reason: string }>; names: Map<string, string> } {
  const result = openDatabases(
    root,
    inputs,
    path => /(^|\/)(?:contact\/contact|session\/session)\.db$/u.test(path),
    openDatabase
  );
  return { ...result, names: contactNames(result.opened) };
}

function querySessions(
  request: Extract<WechatWorkerRequest, { operation: 'sessions' }>,
  root: string,
  inputs: WechatWorkerDatabaseInput[],
  openDatabase: WechatWorkerDatabaseOpener
): WechatWorkerPage<WechatWorkerSession> {
  const { opened, skipped, names } = contactsAndSession(root, inputs, openDatabase);
  const items = new Map<string, WechatWorkerSession>();
  try {
    for (const item of opened) {
      if (!/(^|\/)session\/session\.db$/u.test(item.path) || !hasTable(item.db, 'SessionTable')) continue;
      const rows = item.db.prepare('SELECT username,type,unread_count,summary,last_timestamp,sort_timestamp FROM SessionTable WHERE username IS NOT NULL AND username <> ?').all('') as SqlRow[];
      for (const row of rows) {
        const sessionId = stringValue(row.username);
        if (!sessionId) continue;
        const displayName = names.get(sessionId) ?? sessionId;
        if (request.query?.query && !`${sessionId} ${displayName}`.toLocaleLowerCase().includes(request.query.query.toLocaleLowerCase())) continue;
        const latestMessageAt = isoFromSeconds(row.last_timestamp) ?? isoFromSeconds(row.sort_timestamp);
        items.set(sessionId, {
          sessionId,
          displayName,
          type: sessionType(sessionId, row.type),
          latestMessageAt,
          unreadCount: Math.max(0, integerValue(row.unread_count))
        });
      }
    }
  } catch {
    skipped.push({ path: 'session/session.db', reason: 'session_table_unreadable' });
  } finally {
    closeDatabases(opened);
  }
  const sorted = [...items.values()].sort((a, b) => (Date.parse(b.latestMessageAt ?? '') || 0) - (Date.parse(a.latestMessageAt ?? '') || 0) || a.sessionId.localeCompare(b.sessionId));
  const query = request.query ?? {};
  const fingerprint = pageFingerprint('sessions', root, query, inputs);
  return page(sorted, { fingerprint, cursor: query.cursor, limit: query.limit, coverage: makeCoverage(null, null, opened, skipped) });
}

function validateSessionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SESSION_IDS || value.some(item => typeof item !== 'string' || !item || item.length > 500)) {
    protocolError('INVALID_QUERY', `sessionIds 必须包含 1 到 ${MAX_SESSION_IDS} 个稳定会话 ID`);
  }
  return [...new Set(value as string[])];
}

function queryMessages(
  request: Extract<WechatWorkerRequest, { operation: 'messages' }>,
  root: string,
  inputs: WechatWorkerDatabaseInput[],
  openDatabase: WechatWorkerDatabaseOpener
): WechatWorkerPage<WechatWorkerMessage> {
  const range = parseRange(request.query);
  const sessionIds = validateSessionIds(request.query.sessionIds);
  verifyKnownSessions(root, inputs, sessionIds, openDatabase);
  const messageResult = openDatabases(
    root,
    inputs,
    path => /(^|\/)message\/(?:biz_)?message_\d+\.db$/u.test(path),
    openDatabase
  );
  const mediaResult = openDatabases(
    root,
    inputs,
    path => /(^|\/)message\/media_\d+\.db$/u.test(path),
    openDatabase
  );
  const context = contactsAndSession(root, inputs, openDatabase);
  const rows = readMessageRows(messageResult.opened, sessionIds, range.startSeconds, range.endSeconds, messageResult.skipped);
  const voiceAvailability = collectVoiceAvailability(mediaResult.opened);
  const items = rows.map(row => buildMessage(
    root,
    request.accountId ?? basename(root),
    request.imageKey,
    context.names,
    row,
    voiceAvailability
  ));
  closeDatabases(messageResult.opened);
  closeDatabases(mediaResult.opened);
  closeDatabases(context.opened);
  const fingerprint = pageFingerprint('messages', root, { ...request.query, sessionIds }, inputs);
  return page(items, {
    fingerprint,
    cursor: request.query.cursor,
    limit: request.query.limit,
    coverage: makeCoverage(
      range.start,
      range.end,
      [...messageResult.opened, ...mediaResult.opened, ...context.opened],
      [...messageResult.skipped, ...mediaResult.skipped, ...context.skipped]
    )
  });
}

function searchableMessage(message: WechatWorkerMessage): string {
  return JSON.stringify({ text: message.text, card: message.card, details: message.details, media: message.media, unknown: message.unknownPayload }) ?? '';
}

function querySearch(
  request: Extract<WechatWorkerRequest, { operation: 'search' }>,
  root: string,
  inputs: WechatWorkerDatabaseInput[],
  openDatabase: WechatWorkerDatabaseOpener
): WechatWorkerPage<WechatWorkerMessage> {
  const range = parseRange(request.query);
  const keyword = request.query.query.trim();
  if (!keyword) protocolError('INVALID_QUERY', '搜索关键词不能为空');
  if (keyword.length > 500) protocolError('INVALID_QUERY', '搜索关键词过长');
  const sessionIds = request.query.sessionIds
    ? validateSessionIds(request.query.sessionIds)
    : collectSessionIds(root, inputs, openDatabase);
  if (request.query.sessionIds) verifyKnownSessions(root, inputs, sessionIds, openDatabase);
  const messageResult = openDatabases(
    root,
    inputs,
    path => /(^|\/)message\/(?:biz_)?message_\d+\.db$/u.test(path),
    openDatabase
  );
  const mediaResult = openDatabases(
    root,
    inputs,
    path => /(^|\/)message\/media_\d+\.db$/u.test(path),
    openDatabase
  );
  const context = contactsAndSession(root, inputs, openDatabase);
  const rows = readMessageRows(messageResult.opened, sessionIds, range.startSeconds, range.endSeconds, messageResult.skipped);
  const lowered = keyword.toLocaleLowerCase();
  const allowedTypes = request.query.messageTypes?.length ? new Set(request.query.messageTypes) : null;
  const voiceAvailability = collectVoiceAvailability(mediaResult.opened);
  const items = rows
    .map(row => buildMessage(
      root,
      request.accountId ?? basename(root),
      request.imageKey,
      context.names,
      row,
      voiceAvailability
    ))
    .filter(message => (!allowedTypes || allowedTypes.has(message.type)) && searchableMessage(message).toLocaleLowerCase().includes(lowered));
  closeDatabases(messageResult.opened);
  closeDatabases(mediaResult.opened);
  closeDatabases(context.opened);
  const fingerprint = pageFingerprint('search', root, { ...request.query, sessionIds }, inputs);
  return page(items, {
    fingerprint,
    cursor: request.query.cursor,
    limit: request.query.limit,
    coverage: makeCoverage(
      range.start,
      range.end,
      [...messageResult.opened, ...mediaResult.opened, ...context.opened],
      [...messageResult.skipped, ...mediaResult.skipped, ...context.skipped],
      ['content_scan_used', 'fts_not_available_in_worker_fixture']
    )
  });
}

function collectSessionIds(
  root: string,
  inputs: WechatWorkerDatabaseInput[],
  openDatabase: WechatWorkerDatabaseOpener
): string[] {
  const { opened } = openDatabases(root, inputs, sessionDatabases(inputs), openDatabase);
  const ids = new Set<string>();
  try {
    for (const item of opened) {
      if (!hasTable(item.db, 'SessionTable')) continue;
      const rows = item.db.prepare('SELECT username FROM SessionTable WHERE username IS NOT NULL AND username <> ?').all('') as SqlRow[];
      for (const row of rows) {
        const id = stringValue(row.username);
        if (id) ids.add(id);
      }
    }
  } finally { closeDatabases(opened); }
  return [...ids];
}

function verifyKnownSessions(
  root: string,
  inputs: WechatWorkerDatabaseInput[],
  requested: string[],
  openDatabase: WechatWorkerDatabaseOpener
): void {
  const result = openDatabases(root, inputs, sessionDatabases(inputs), openDatabase);
  const known = new Set<string>();
  let tableSeen = false;
  try {
    for (const item of result.opened) {
      if (!hasTable(item.db, 'SessionTable')) continue;
      tableSeen = true;
      const rows = item.db.prepare('SELECT username FROM SessionTable WHERE username IS NOT NULL AND username <> ?').all('') as SqlRow[];
      for (const row of rows) {
        const id = stringValue(row.username);
        if (id) known.add(id);
      }
    }
  } finally { closeDatabases(result.opened); }
  if (tableSeen) {
    const unknown = requested.filter(id => !known.has(id));
    if (unknown.length) protocolError('SESSION_NOT_FOUND', `微信会话不存在：${unknown.join(', ')}`);
  }
}

function readMedia(
  request: Extract<WechatWorkerRequest, { operation: 'media' }>,
  root: string,
  openDatabase: WechatWorkerDatabaseOpener
): WechatWorkerMediaResult {
  pruneState();
  const handle = request.query.resourceHandle;
  if (typeof handle !== 'string' || !/^[a-f0-9]{32}$/u.test(handle)) protocolError('INVALID_MEDIA_HANDLE', '微信媒体句柄无效');
  const state = mediaHandles.get(handle);
  if (!state || state.root !== root || Date.now() - state.createdAt > MAX_MEDIA_HANDLE_AGE_MS) {
    mediaHandles.delete(handle);
    protocolError('MEDIA_HANDLE_EXPIRED', '微信媒体资源句柄已失效');
  }
  if (state.accountId !== (request.accountId ?? '')) {
    protocolError('MEDIA_HANDLE_FORBIDDEN', '微信媒体资源不属于当前账号');
  }
  if (state.voiceServerId && state.voiceSessionId) {
    const result = openDatabases(
      root,
      request.databases,
      path => /(^|\/)message\/media_\d+\.db$/u.test(path),
      openDatabase
    );
    try {
      for (const item of result.opened) {
        const row = voiceRows(item.db, state.voiceSessionId, state.voiceServerId)[0];
        if (!row) continue;
        if (row.bytes.length > MAX_MEDIA_BYTES) {
          return {
            resourceHandle: handle,
            kind: state.kind,
            status: 'unavailable',
            mimeType: 'audio/silk',
            fileName: `voice-${state.voiceServerId}.silk`,
            size: row.bytes.length,
            diagnostics: ['微信语音超过单次媒体读取上限']
          };
        }
        const mimeType = mimeForBytes(row.bytes) ?? 'audio/silk';
        const fileName = mimeType === 'audio/wav'
          ? `voice-${state.voiceServerId}.wav`
          : `voice-${state.voiceServerId}.silk`;
        return {
          resourceHandle: handle,
          kind: 'audio',
          status: 'available',
          mimeType,
          fileName,
          size: row.bytes.length,
          bytes: new Uint8Array(row.bytes),
          ...(state.transcription ? { transcription: state.transcription } : {}),
          ...(mimeType === 'audio/silk'
            ? { limitation: '本机保存的是原始 SILK；当前动态 Tool 会以 audio/silk 交给 Agent，未伪装成 WAV。' }
            : {}),
          diagnostics: mimeType === 'audio/silk'
            ? ['本机保存的是原始 SILK；当前动态 Tool 会以 audio/silk 交给 Agent，未伪装成 WAV。']
            : []
        };
      }
    } finally {
      closeDatabases(result.opened);
    }
    return {
      resourceHandle: handle,
      kind: state.kind,
      status: 'missing',
      mimeType: null,
      fileName: null,
      size: null,
      diagnostics: ['微信尚未在本机媒体数据库保存这条语音']
    };
  }
  if (!state.relativePath) {
    return {
      resourceHandle: handle,
      kind: state.kind,
      status: 'unavailable',
      mimeType: null,
      fileName: null,
      size: null,
      diagnostics: ['微信媒体资源没有可读取的本机来源']
    };
  }
  const path = resolveMediaPath(root, state.relativePath);
  if (!path) return { resourceHandle: handle, kind: state.kind, status: 'missing', mimeType: null, fileName: null, size: null, diagnostics: ['微信媒体文件已不存在'] };
  const fileName = basename(path);
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { return { resourceHandle: handle, kind: state.kind, status: 'unavailable', mimeType: null, fileName, size: null, diagnostics: ['微信媒体文件不可读取'] }; }
  if (bytes.length > MAX_MEDIA_BYTES) {
    return {
      resourceHandle: handle,
      kind: state.kind,
      status: 'unavailable',
      mimeType: mimeForFileName(fileName),
      fileName,
      size: bytes.length,
      diagnostics: ['微信媒体超过单次读取上限']
    };
  }
  let output = bytes;
  let mimeType = mimeForFileName(fileName) ?? mimeForBytes(bytes);
  if (state.kind === 'image' || state.kind === 'thumbnail' || state.kind === 'sticker') {
    const decoded = decryptImageDat(bytes, root, state.accountId, request.imageKey);
    if (decoded) {
      output = decoded.bytes;
      mimeType = decoded.mimeType;
    } else if (state.kind === 'image' || state.kind === 'thumbnail') {
      return { resourceHandle: handle, kind: state.kind, status: 'unavailable', mimeType: null, fileName, size: bytes.length, diagnostics: ['图片缓存格式或图片密钥无法验证'] };
    }
  }
  if (!mimeType) mimeType = 'application/octet-stream';
  return {
    resourceHandle: handle,
    kind: state.kind,
    status: state.status,
    mimeType,
    fileName,
    size: output.length,
    bytes: new Uint8Array(output),
    diagnostics: []
  };
}

function validateBaseRequest(value: unknown): WechatWorkerBaseRequest {
  const record = asRecord(value);
  if (!record || typeof record.id !== 'string' || !record.id || typeof record.operation !== 'string') protocolError('INVALID_REQUEST', 'worker 请求格式无效');
  const root = validateDataDirectory(record.dataDirectory);
  const databases = databaseInputList(record as unknown as WechatWorkerBaseRequest);
  validateDatabaseBoundaries(root, databases);
  const imageKey = record.imageKey === undefined ? undefined : asRecord(record.imageKey);
  if (record.imageKey !== undefined &&
      (!imageKey ||
       typeof imageKey.aesKey !== 'string' ||
       !/^[a-f0-9]{16}$/iu.test(imageKey.aesKey) ||
       !Number.isInteger(imageKey.xorKey) ||
       Number(imageKey.xorKey) < 0 ||
       Number(imageKey.xorKey) > 0xff)) {
    protocolError('INVALID_IMAGE_KEY', '微信图片密钥格式无效');
  }
  return {
    id: record.id,
    operation: record.operation as WechatWorkerOperation,
    dataDirectory: root,
    databases,
    accountId: typeof record.accountId === 'string' && record.accountId ? record.accountId : undefined,
    ...(imageKey
      ? { imageKey: { aesKey: imageKey.aesKey as string, xorKey: Number(imageKey.xorKey) } }
      : {})
  };
}

export async function handleWechatWorkerRequest(
  value: unknown,
  openDatabase: WechatWorkerDatabaseOpener = openPlainDatabase
): Promise<WechatWorkerResponse> {
  let id = 'unknown';
  try {
    const base = validateBaseRequest(value);
    id = base.id;
    const request = { ...base, query: asRecord((value as Record<string, unknown>).query) ?? {} } as WechatWorkerRequest;
    let result: WechatWorkerResult;
    switch (base.operation) {
      case 'sessions': result = querySessions(request as Extract<WechatWorkerRequest, { operation: 'sessions' }>, base.dataDirectory, base.databases, openDatabase); break;
      case 'messages': result = queryMessages(request as Extract<WechatWorkerRequest, { operation: 'messages' }>, base.dataDirectory, base.databases, openDatabase); break;
      case 'search': result = querySearch(request as Extract<WechatWorkerRequest, { operation: 'search' }>, base.dataDirectory, base.databases, openDatabase); break;
      case 'media': result = readMedia(request as Extract<WechatWorkerRequest, { operation: 'media' }>, base.dataDirectory, openDatabase); break;
      default: protocolError('INVALID_REQUEST', '不支持的 worker 操作');
    }
    return { id, ok: true, result };
  } catch (error) {
    if (error instanceof WechatWorkerProtocolError) return { id, ok: false, error: { code: error.code, message: error.message } };
    return { id, ok: false, error: { code: 'WORKER_FAILURE', message: '微信本机数据读取失败' } };
  }
}

interface ParentPortLike {
  on(event: 'message', listener: (event: unknown) => void): unknown;
  postMessage(value: unknown): void;
}

function parentPort(): ParentPortLike | null {
  return (process as typeof process & { parentPort?: ParentPortLike }).parentPort ?? null;
}

export function installWechatWorkerMessageHandler(
  port: ParentPortLike = parentPort() as ParentPortLike,
  openDatabase: WechatWorkerDatabaseOpener = openPlainDatabase
): void {
  if (!port) return;
  port.on('message', event => {
    const payload = asRecord(event)?.data ?? event;
    void handleWechatWorkerRequest(payload, openDatabase).then(response => port.postMessage(response));
  });
}

const port = parentPort();
if (port) installWechatWorkerMessageHandler(port);
