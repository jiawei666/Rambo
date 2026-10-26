import { DatabaseSync } from 'node:sqlite';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { extname, isAbsolute, join, sep } from 'node:path';
import { isMessageContent } from '../shared/contracts';
import type {
  ActivityKind, ActivityStatus, Bot, Chat, GroupChat, GroupMessage, Memory, Message, MessageContent,
  ConnectionStatus, ConnectorAuthKind, ConnectorConnection, ConnectorGrant, MessageStatus, PermissionMode, QuestionMessageContent,
  ResultCardMessageContent, RoutineListItem,
  RoutineDefinition, RoutineExecutionMode, RoutineRun, RoutineRunStatus, ThreadModelSource, TurnModelSource,
  TurnActivity, TurnDispatchStatus, TurnPermissionSnapshot, TurnRecord, TurnReroute, TurnStatus
} from '../shared/contracts';
import { encodeRobotAvatar, isCurrentRobotAvatar, parseRobotAvatar, ROBOT_EYE_STYLES } from '../shared/robot-avatar';
import { followingRun, isUnsupportedIntervalSchedule, parseRoutineSchedule } from './routine-schedule';

const now = () => new Date().toISOString();
type Row = Record<string, unknown>;
const generatedImageLabel = '生成文件：';
const generatedImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);

function generatedImagePaths(detail: string, threadId: string): string[] {
  const legacyPathMarker = `${sep}generated_images${sep}${threadId}${sep}`;
  return detail.split(/\r?\n/u).flatMap(line => {
    const labelled = line.startsWith(generatedImageLabel);
    const candidate = (labelled ? line.slice(generatedImageLabel.length) : line).trim();
    if (!isAbsolute(candidate) || !generatedImageExtensions.has(extname(candidate).toLocaleLowerCase())) return [];
    return labelled || candidate.includes(legacyPathMarker) ? [candidate] : [];
  });
}

function isGeneratedImageContent(content: MessageContent | null | undefined, paths: string[]): boolean {
  return content?.kind === 'media' && content.mediaType === 'image' && content.generated === true && paths.includes(content.url);
}

function generatedImageContent(path: string): MessageContent {
  return { kind: 'media', mediaType: 'image', url: path, alt: '生成图片', generated: true };
}

const permissionModes = new Set<PermissionMode>(['fullAccess', 'workspaceWrite', 'readOnly']);
function resolvedDefaultPermission(value: string | undefined): PermissionMode {
  if (value === undefined || value === '') return 'fullAccess';
  if (permissionModes.has(value as PermissionMode)) return value as PermissionMode;
  throw new Error('新建 Bot 的全局权限配置无效，请在系统设置中重新选择一个权限。');
}

export const DEFAULT_BOT_RESOURCE_IDS = [
  'skill:documents',
  'skill:pdf',
  'skill:spreadsheets',
  'skill:presentations',
  'skill:visualize',
  'skill:imagegen',
  'skill:openai-docs',
  'skill:skill-creator',
  'mcp:playwright'
] as const;

function resourceIdsFrom(value: unknown): string[] {
  const source = Array.isArray(value) ? value : (() => {
    if (typeof value !== 'string') return [];
    try { return JSON.parse(value); } catch { return []; }
  })();
  if (!Array.isArray(source)) return [];
  try {
    return [...new Set(source.filter((item): item is string =>
      typeof item === 'string' && item.length > 0 && item.length <= 200))];
  } catch { return []; }
}

function canonicalResourceId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.startsWith('skill:') || normalized.startsWith('mcp:') ||
      normalized.startsWith('app:') || normalized.startsWith('plugin:')) {
    return normalized;
  }
  return `skill:${normalized}`;
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function canonicalResourceIds(values: unknown): string[] {
  return [...new Set(resourceIdsFrom(values).map(canonicalResourceId))];
}
const routineExecutionModes = new Set<RoutineExecutionMode>(['chat', 'script', 'hybrid']);
function routineExecutionFrom(value: unknown): RoutineDefinition['execution'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { mode: 'chat' };
  const input = value as Record<string, unknown>;
  const mode = routineExecutionModes.has(input.mode as RoutineExecutionMode)
    ? input.mode as RoutineExecutionMode
    : 'chat';
  const template = typeof input.template === 'string' ? input.template.trim() : '';
  if (template.length > 20_000) throw new Error('Routine 脚本模板不能超过长度限制');
  return { mode, ...(template ? { template } : {}) };
}
function migrateRobotAvatarEyes(value: string): string | null {
  const selection = parseRobotAvatar(value);
  const current = isCurrentRobotAvatar(value);
  const retiredInput = /^agent-robot:v2:\d{1,3}:[a-z]+:input$/.test(value);
  if (current && !retiredInput && value === encodeRobotAvatar(selection)) return null;
  return encodeRobotAvatar({
    ...selection,
    eyeStyle: current && !retiredInput
      ? selection.eyeStyle
      : ROBOT_EYE_STYLES[randomInt(ROBOT_EYE_STYLES.length)]
  });
}
export type MessageAnswerTarget =
  | { scope: 'chat'; chatId: string; message: Message; content: QuestionMessageContent | ResultCardMessageContent }
  | { scope: 'group'; groupId: string; botId: string; message: GroupMessage; content: QuestionMessageContent | ResultCardMessageContent };
export interface UnknownTurnOperation {
  chatId: string;
  threadId: string;
  operationId: string;
  operation: 'turnStart' | 'turnSteer';
  turnId: string | null;
  startedAt: string;
}
export interface ThreadModelObservation {
  threadId: string;
  model: string | null;
  provider: string | null;
  source: ThreadModelSource;
  observedAt: string;
}
const botFrom = (r: Row): Bot => ({
  ...r,
  archived: !!r.archived,
  model: typeof r.model === 'string' ? r.model : '',
  resourceIds: resourceIdsFrom(r.resourceIdsJson),
  notificationsEnabled: r.notificationsEnabled !== 0
}) as unknown as Bot;
const chatFrom = (r: Row): Chat => ({
  ...r,
  archived: !!r.archived,
  routineRunId: typeof r.routineRunId === 'string' ? r.routineRunId : null,
  lastReadAt: typeof r.lastReadAt === 'string' ? r.lastReadAt : null,
  lastReadRowId: typeof r.lastReadRowId === 'number' ? r.lastReadRowId : null
}) as unknown as Chat;
const messageContentFrom = (row: Row): MessageContent | null => {
  if (typeof row.contentJson !== 'string') return null;
  try {
    const content = JSON.parse(row.contentJson);
    return isMessageContent(content) ? content : null;
  } catch { return null; }
};
const messageFrom = (row: Row): Message => ({
  id: String(row.id),
  chatId: String(row.chatId),
  role: row.role as Message['role'],
  text: String(row.text),
  status: row.status as MessageStatus,
  ...(typeof row.dispatchStatus === 'string' ? { dispatchStatus: row.dispatchStatus as TurnDispatchStatus } : {}),
  ...(typeof row.dispatchError === 'string' ? { dispatchError: row.dispatchError } : {}),
  itemId: typeof row.itemId === 'string' ? row.itemId : null,
  createdAt: String(row.createdAt),
  turnId: typeof row.turnId === 'string' ? row.turnId : null,
  phase: row.phase === 'commentary' || row.phase === 'partial_answer' || row.phase === 'final_answer'
    ? row.phase
    : null,
  source: row.source === 'voice' ? 'voice' : 'text',
  content: messageContentFrom(row)
});
const groupMessageFrom = (row: Row): GroupMessage => ({
  id: String(row.id), groupId: String(row.groupId), role: row.role as GroupMessage['role'],
  senderBotId: typeof row.senderBotId === 'string' ? row.senderBotId : null,
  senderName: typeof row.senderName === 'string' ? row.senderName : null,
  text: String(row.text), status: row.status as MessageStatus,
  itemId: typeof row.itemId === 'string' ? row.itemId : null,
  turnId: typeof row.turnId === 'string' ? row.turnId : null,
  phase: row.phase === 'commentary' || row.phase === 'partial_answer' || row.phase === 'final_answer'
    ? row.phase
    : null,
  createdAt: String(row.createdAt), content: messageContentFrom(row)
});
const activityFrom = (row: Row): TurnActivity => ({
  id: String(row.id),
  chatId: String(row.chatId),
  turnId: typeof row.turnId === 'string' ? row.turnId : null,
  itemId: String(row.itemId),
  kind: row.kind as ActivityKind,
  status: row.status as ActivityStatus,
  title: String(row.title),
  detail: String(row.detail),
  createdAt: String(row.createdAt),
  updatedAt: String(row.updatedAt)
});

function routineRunFrom(row: Row): RoutineRun {
  let definition: RoutineDefinition | null = null;
  if (typeof row.definitionJson === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.definitionJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        definition = parsed as RoutineDefinition;
      }
    } catch { /* damaged historical rows keep the column-level instruction fallback */ }
  }
  const instruction = String(row.instruction);
  const capturedDefinition: RoutineDefinition = definition ?? {
    instruction,
    execution: { mode: 'chat' },
    schedule: '',
    kind: 'recurring',
    timezone: 'Asia/Shanghai',
    frequency: null,
    weekday: null,
    dayOfMonth: null,
    times: [],
    time: '',
    runAt: null,
    catchUp: true,
    rememberLastResult: false,
    successNotification: false
  };
  return {
    id: String(row.id), routineId: String(row.routineId), botId: String(row.botId),
    routineTitle: String(row.routineTitle), instruction,
    definition: capturedDefinition,
    definitionVersion: typeof row.definitionVersion === 'string'
      ? row.definitionVersion
      : createHash('sha256').update(JSON.stringify(capturedDefinition)).digest('hex'),
    scheduledFor: String(row.scheduledFor), status: row.status as RoutineRunStatus,
    trigger: row.trigger as RoutineRun['trigger'],
    chatId: typeof row.chatId === 'string' ? row.chatId : null,
    sourceChatId: typeof row.sourceChatId === 'string' ? row.sourceChatId : null,
    turnId: typeof row.turnId === 'string' ? row.turnId : null,
    summary: typeof row.summary === 'string' ? row.summary : null,
    error: typeof row.error === 'string' ? row.error : null,
    process: typeof row.process === 'string' ? row.process : null,
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
    completedAt: typeof row.completedAt === 'string' ? row.completedAt : null,
    createdAt: String(row.createdAt),
    recoveryCount: Number.isInteger(row.recoveryCount) ? Number(row.recoveryCount) : 0,
    needsUserReason: typeof row.needsUserReason === 'string' ? row.needsUserReason : null
  };
}

function turnFrom(r: Row, reroutes: TurnReroute[] = []): TurnRecord {
  return {
    id: String(r.id), turnId: typeof r.turnId === 'string' ? r.turnId : null,
    threadId: String(r.threadId), chatId: String(r.chatId),
    userMessageId: typeof r.userMessageId === 'string' ? r.userMessageId : null,
    dispatchStatus: r.dispatchStatus === 'queued' || r.dispatchStatus === 'dispatching' ||
      r.dispatchStatus === 'dispatched' || r.dispatchStatus === 'needs_user' || r.dispatchStatus === 'failed'
      ? r.dispatchStatus
      : 'dispatched',
    dispatchError: typeof r.dispatchError === 'string' ? r.dispatchError : null,
    requestedModel: typeof r.requestedModel === 'string' ? r.requestedModel : null,
    modelSource: r.modelSource as TurnModelSource,
    threadModelAtRequest: typeof r.threadModelAtRequest === 'string' ? r.threadModelAtRequest : null,
    threadModelProviderAtRequest: typeof r.threadModelProviderAtRequest === 'string' ? r.threadModelProviderAtRequest : null,
    threadModelSource: r.threadModelSource as ThreadModelSource,
    threadModelObservedAt: typeof r.threadModelObservedAt === 'string' ? r.threadModelObservedAt : null,
    serverResolvedModel: typeof r.serverResolvedModel === 'string' ? r.serverResolvedModel : null,
    serverResolvedProvider: typeof r.serverResolvedProvider === 'string' ? r.serverResolvedProvider : null,
    resolutionSource: r.resolutionSource as TurnRecord['resolutionSource'],
    reroutes, permissionSnapshot: JSON.parse(String(r.permissionSnapshot)) as TurnPermissionSnapshot,
    status: r.status as TurnStatus, startedAt: String(r.startedAt),
    completedAt: typeof r.completedAt === 'string' ? r.completedAt : null
  };
}

function isTerminalTurnStatus(status: TurnStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export class Store {
  private db: DatabaseSync;
  private closed = false;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'rambo.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '', model TEXT, permission TEXT NOT NULL DEFAULT 'fullAccess',
        archived INTEGER NOT NULL DEFAULT 0, notificationsEnabled INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        title TEXT NOT NULL, threadId TEXT, groupChatId TEXT REFERENCES group_chats(id) ON DELETE CASCADE,
        archived INTEGER NOT NULL DEFAULT 0, routineToolsEnabled INTEGER NOT NULL DEFAULT 0,
        memoryToolsEnabled INTEGER NOT NULL DEFAULT 0,
        routineRunId TEXT,
        lastReadAt TEXT, lastReadRowId INTEGER,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_chats (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        defaultBotId TEXT REFERENCES bots(id) ON DELETE RESTRICT,
        archived INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_chat_members (
        groupChatId TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
        botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, joinedAt TEXT NOT NULL,
        PRIMARY KEY(groupChatId, botId), UNIQUE(groupChatId, position));
      CREATE INDEX IF NOT EXISTS group_chat_members_bot ON group_chat_members(botId, groupChatId);
      CREATE TABLE IF NOT EXISTS group_chat_sessions (
        groupChatId TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
        botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('member')),
        chatId TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
        PRIMARY KEY(groupChatId, botId, purpose));
      CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL, senderBotId TEXT REFERENCES bots(id) ON DELETE SET NULL,
        senderName TEXT, text TEXT NOT NULL, status TEXT NOT NULL, itemId TEXT, createdAt TEXT NOT NULL,
        turnId TEXT, phase TEXT, contentJson TEXT);
      CREATE INDEX IF NOT EXISTS group_messages_timeline ON group_messages(groupId, createdAt, id);
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        sourceChatId TEXT,
        definitionJson TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
        nextRunAt TEXT, lastScheduledFor TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS routines_updated ON routines(updatedAt DESC, createdAt DESC);
      CREATE TABLE IF NOT EXISTS routine_runs (
        id TEXT PRIMARY KEY,
        routineId TEXT NOT NULL,
        botId TEXT NOT NULL,
        routineTitle TEXT NOT NULL,
        instruction TEXT NOT NULL,
        definitionJson TEXT,
        definitionVersion TEXT,
        scheduledFor TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        chatId TEXT,
        sourceChatId TEXT,
        turnId TEXT,
        summary TEXT,
        error TEXT,
        recoveryCount INTEGER NOT NULL DEFAULT 0,
        needsUserReason TEXT,
        process TEXT,
        startedAt TEXT,
        completedAt TEXT,
        createdAt TEXT NOT NULL,
        dedupeKey TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS routine_runs_routine ON routine_runs(routineId,createdAt DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, itemId TEXT, createdAt TEXT NOT NULL,
        turnId TEXT, phase TEXT, contentJson TEXT, source TEXT NOT NULL DEFAULT 'text',
        dispatchStatus TEXT, dispatchError TEXT);
      CREATE TABLE IF NOT EXISTS chat_message_queue (
        messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('queued','dispatching','dispatched','needs_user','failed')),
        error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_message_queue_ready ON chat_message_queue(chatId,status,createdAt);
      CREATE TABLE IF NOT EXISTS turn_activities (
        id TEXT PRIMARY KEY,
        chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        turnId TEXT,
        itemId TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(chatId, itemId));
      CREATE TABLE IF NOT EXISTS unknown_turn_operations (
        chatId TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        threadId TEXT NOT NULL, operationId TEXT NOT NULL, operation TEXT NOT NULL,
        turnId TEXT, startedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chatId, createdAt);
      CREATE INDEX IF NOT EXISTS turn_activities_chat ON turn_activities(chatId, createdAt);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, botId TEXT REFERENCES bots(id) ON DELETE CASCADE,
        text TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL,
        sourceCallId TEXT);
      CREATE TABLE IF NOT EXISTS connector_connections (
        id TEXT PRIMARY KEY,
        providerId TEXT NOT NULL,
        displayName TEXT NOT NULL,
        accountLabel TEXT NOT NULL,
        authKind TEXT NOT NULL,
        credentialRef TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_grants (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        connectionId TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
        createdAt TEXT NOT NULL,
        UNIQUE(botId, connectionId));
      CREATE INDEX IF NOT EXISTS connector_grants_bot ON connector_grants(botId);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_resources (
        botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        resourceId TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        PRIMARY KEY(botId, resourceId));
      CREATE TABLE IF NOT EXISTS direct_mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL CHECK(transport IN ('stdio','http')),
        command TEXT,
        argsJson TEXT NOT NULL DEFAULT '[]',
        cwd TEXT,
        url TEXT,
        credentialRef TEXT,
        headerKeysJson TEXT NOT NULL DEFAULT '[]',
        envKeysJson TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_connection_capabilities (
        connectionId TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY(connectionId, capability));
      CREATE TABLE IF NOT EXISTS wechat_connections (
        connectionId TEXT PRIMARY KEY REFERENCES connector_connections(id) ON DELETE CASCADE,
        accountId TEXT NOT NULL,
        dataDirectory TEXT NOT NULL,
        wechatVersion TEXT NOT NULL,
        wechatBuild TEXT NOT NULL,
        captureVersion TEXT NOT NULL,
        lastVerifiedAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, turnId TEXT, threadId TEXT NOT NULL,
        chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        userMessageId TEXT, dispatchStatus TEXT NOT NULL DEFAULT 'dispatched', dispatchError TEXT,
        requestedModel TEXT, modelSource TEXT NOT NULL,
        threadModelAtRequest TEXT, threadModelProviderAtRequest TEXT,
        threadModelSource TEXT NOT NULL DEFAULT 'unknown', threadModelObservedAt TEXT,
        serverResolvedModel TEXT, serverResolvedProvider TEXT,
        resolutionSource TEXT NOT NULL DEFAULT 'unknown', reroutes TEXT NOT NULL DEFAULT '[]',
        permissionSnapshot TEXT NOT NULL, status TEXT NOT NULL,
        startedAt TEXT NOT NULL, completedAt TEXT);
      CREATE INDEX IF NOT EXISTS turns_chat_started ON turns(chatId, startedAt);
      CREATE INDEX IF NOT EXISTS turns_thread_turn ON turns(threadId, turnId);
      CREATE TABLE IF NOT EXISTS thread_model_observations (
        threadId TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        model TEXT, provider TEXT, source TEXT NOT NULL, observedAt TEXT NOT NULL);`);
    const schemaVersion = Number((this.db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version ?? 0);
    if (schemaVersion > 24) throw new Error('本机数据库版本高于当前应用支持版本');
    const groupColumns = this.db.prepare('PRAGMA table_info(group_chats)').all() as Row[];
    const defaultBotColumn = groupColumns.find(column => column.name === 'defaultBotId');
    if (defaultBotColumn?.notnull) {
      // Bot deletion may leave a saved group with no members. Rebuild only this
      // table so that an empty group can be retained without a fake default Bot.
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE group_chats_v8 (
            id TEXT PRIMARY KEY, title TEXT NOT NULL,
            defaultBotId TEXT REFERENCES bots(id) ON DELETE RESTRICT,
            archived INTEGER NOT NULL DEFAULT 0,
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
          INSERT INTO group_chats_v8(id,title,defaultBotId,archived,createdAt,updatedAt)
            SELECT id,title,defaultBotId,${groupColumns.some(column => column.name === 'archived') ? 'archived' : '0'},createdAt,updatedAt FROM group_chats;
          DROP TABLE group_chats;
          ALTER TABLE group_chats_v8 RENAME TO group_chats;
          COMMIT;`);
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* no open migration transaction */ }
        throw error;
      } finally {
        this.db.exec('PRAGMA foreign_keys=ON');
      }
      const violations = this.db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new Error('群聊数据迁移后未通过外键检查');
    }
    if (!(this.db.prepare('PRAGMA table_info(group_chats)').all() as Row[]).some(column => column.name === 'archived')) {
      this.db.exec('ALTER TABLE group_chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    }
    const routineColumns = this.db.prepare('PRAGMA table_info(routines)').all() as Row[];
    if (!routineColumns.some(column => column.name === 'sourceCallId')) this.db.exec('ALTER TABLE routines ADD COLUMN sourceCallId TEXT');
    if (!routineColumns.some(column => column.name === 'sourceChatId')) this.db.exec('ALTER TABLE routines ADD COLUMN sourceChatId TEXT');
    if (!routineColumns.some(column => column.name === 'nextRunAt')) this.db.exec('ALTER TABLE routines ADD COLUMN nextRunAt TEXT');
    if (!routineColumns.some(column => column.name === 'lastScheduledFor')) this.db.exec('ALTER TABLE routines ADD COLUMN lastScheduledFor TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS routines_source_call ON routines(sourceCallId) WHERE sourceCallId IS NOT NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS routines_due ON routines(status,nextRunAt)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY, routineId TEXT NOT NULL, botId TEXT NOT NULL,
      routineTitle TEXT NOT NULL, instruction TEXT NOT NULL, scheduledFor TEXT NOT NULL,
      status TEXT NOT NULL, trigger TEXT NOT NULL, chatId TEXT, sourceChatId TEXT, turnId TEXT,
      summary TEXT, error TEXT, process TEXT, startedAt TEXT, completedAt TEXT,
      createdAt TEXT NOT NULL, dedupeKey TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS routine_runs_routine ON routine_runs(routineId,createdAt DESC);`);
    const routineRunColumns = this.db.prepare('PRAGMA table_info(routine_runs)').all() as Row[];
    if (!routineRunColumns.some(column => column.name === 'sourceChatId')) {
      this.db.exec('ALTER TABLE routine_runs ADD COLUMN sourceChatId TEXT');
    }
    if (!routineRunColumns.some(column => column.name === 'definitionJson')) {
      this.db.exec('ALTER TABLE routine_runs ADD COLUMN definitionJson TEXT');
    }
    if (!routineRunColumns.some(column => column.name === 'definitionVersion')) {
      this.db.exec('ALTER TABLE routine_runs ADD COLUMN definitionVersion TEXT');
    }
    this.db.exec(`UPDATE routine_runs SET sourceChatId=chatId,chatId=NULL
      WHERE sourceChatId IS NULL AND chatId IS NOT NULL`);
    const chatColumns = this.db.prepare('PRAGMA table_info(chats)').all() as Row[];
    const botColumns = this.db.prepare('PRAGMA table_info(bots)').all() as Row[];
    if (!botColumns.some(column => column.name === 'resourceIdsJson')) {
      this.db.exec("ALTER TABLE bots ADD COLUMN resourceIdsJson TEXT NOT NULL DEFAULT '[]'");
    }
    if (!botColumns.some(column => column.name === 'notificationsEnabled')) {
      this.db.exec('ALTER TABLE bots ADD COLUMN notificationsEnabled INTEGER NOT NULL DEFAULT 1');
    }
    if (!chatColumns.some(column => column.name === 'groupChatId')) this.db.exec('ALTER TABLE chats ADD COLUMN groupChatId TEXT REFERENCES group_chats(id) ON DELETE CASCADE');
    if (!chatColumns.some(column => column.name === 'model')) this.db.exec('ALTER TABLE chats ADD COLUMN model TEXT');
    if (!chatColumns.some(column => column.name === 'permission')) this.db.exec('ALTER TABLE chats ADD COLUMN permission TEXT');
    if (!chatColumns.some(column => column.name === 'lastReadAt')) this.db.exec('ALTER TABLE chats ADD COLUMN lastReadAt TEXT');
    if (!chatColumns.some(column => column.name === 'lastReadRowId')) this.db.exec('ALTER TABLE chats ADD COLUMN lastReadRowId INTEGER');
    if (!chatColumns.some(column => column.name === 'routineToolsEnabled')) this.db.exec('ALTER TABLE chats ADD COLUMN routineToolsEnabled INTEGER NOT NULL DEFAULT 0');
    if (!chatColumns.some(column => column.name === 'memoryToolsEnabled')) this.db.exec('ALTER TABLE chats ADD COLUMN memoryToolsEnabled INTEGER NOT NULL DEFAULT 0');
    if (!chatColumns.some(column => column.name === 'routineRunId')) this.db.exec('ALTER TABLE chats ADD COLUMN routineRunId TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS chats_one_routine_run_chat ON chats(routineRunId) WHERE routineRunId IS NOT NULL');
    const memoryColumns = this.db.prepare('PRAGMA table_info(memories)').all() as Row[];
    if (!memoryColumns.some(column => column.name === 'sourceCallId')) this.db.exec('ALTER TABLE memories ADD COLUMN sourceCallId TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS memories_source_call ON memories(sourceCallId) WHERE sourceCallId IS NOT NULL');
    this.db.prepare('UPDATE memories SET approved=1 WHERE approved<>1').run();
    if (schemaVersion < 13) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY botId
            ORDER BY archived ASC, (threadId IS NOT NULL) DESC, updatedAt DESC, createdAt DESC, id DESC
          ) AS position
          FROM chats WHERE groupChatId IS NULL
        )
        UPDATE chats
        SET archived=CASE WHEN id IN (SELECT id FROM ranked WHERE position=1) THEN 0 ELSE 1 END
        WHERE groupChatId IS NULL`);
        const bots = this.db.prepare('SELECT id FROM bots').all() as Row[];
        for (const row of bots) {
          const botId = String(row.id);
          const existing = this.db.prepare('SELECT id FROM chats WHERE botId=? AND groupChatId IS NULL AND archived=0 LIMIT 1')
            .get(botId) as Row | undefined;
          if (!existing) {
            const legacy = this.db.prepare('SELECT id FROM chats WHERE botId=? AND groupChatId IS NULL ORDER BY updatedAt DESC,createdAt DESC LIMIT 1')
              .get(botId) as Row | undefined;
            if (legacy) this.db.prepare('UPDATE chats SET archived=0 WHERE id=?').run(String(legacy.id));
            else {
              const date = now();
              this.db.prepare('INSERT INTO chats(id,botId,title,createdAt,updatedAt) VALUES(?,?,?,?,?)')
                .run(randomUUID(), botId, '新对话', date, date);
            }
          }
        }
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS chats_one_direct_chat_per_bot
          ON chats(botId) WHERE groupChatId IS NULL AND archived=0`);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* migration transaction may already be closed */ }
        throw error;
      }
    }
    // Version 12 may still contain multiple active direct chats. Replace the
    // legacy uniqueness constraint only after the v13 migration has archived
    // all but the surviving chat for each Bot.
    this.db.exec('DROP INDEX IF EXISTS chats_one_direct_chat_per_bot');
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS chats_one_direct_chat_per_bot
      ON chats(botId) WHERE groupChatId IS NULL AND archived=0 AND routineRunId IS NULL`);
    const turnColumns = this.db.prepare('PRAGMA table_info(turns)').all() as Row[];
    if (!turnColumns.some(column => column.name === 'threadModelAtRequest')) this.db.exec('ALTER TABLE turns ADD COLUMN threadModelAtRequest TEXT');
    if (!turnColumns.some(column => column.name === 'threadModelProviderAtRequest')) this.db.exec('ALTER TABLE turns ADD COLUMN threadModelProviderAtRequest TEXT');
    if (!turnColumns.some(column => column.name === 'threadModelSource')) this.db.exec("ALTER TABLE turns ADD COLUMN threadModelSource TEXT NOT NULL DEFAULT 'unknown'");
    if (!turnColumns.some(column => column.name === 'threadModelObservedAt')) this.db.exec('ALTER TABLE turns ADD COLUMN threadModelObservedAt TEXT');
    if (!turnColumns.some(column => column.name === 'userMessageId')) this.db.exec('ALTER TABLE turns ADD COLUMN userMessageId TEXT');
    if (!turnColumns.some(column => column.name === 'dispatchStatus')) this.db.exec("ALTER TABLE turns ADD COLUMN dispatchStatus TEXT NOT NULL DEFAULT 'dispatched'");
    if (!turnColumns.some(column => column.name === 'dispatchError')) this.db.exec('ALTER TABLE turns ADD COLUMN dispatchError TEXT');
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as Row[];
    if (!messageColumns.some(column => column.name === 'turnId')) this.db.exec('ALTER TABLE messages ADD COLUMN turnId TEXT');
    if (!messageColumns.some(column => column.name === 'phase')) this.db.exec('ALTER TABLE messages ADD COLUMN phase TEXT');
    if (!messageColumns.some(column => column.name === 'contentJson')) this.db.exec('ALTER TABLE messages ADD COLUMN contentJson TEXT');
    if (!messageColumns.some(column => column.name === 'source')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'text'");
    }
    if (!messageColumns.some(column => column.name === 'dispatchStatus')) this.db.exec('ALTER TABLE messages ADD COLUMN dispatchStatus TEXT');
    if (!messageColumns.some(column => column.name === 'dispatchError')) this.db.exec('ALTER TABLE messages ADD COLUMN dispatchError TEXT');
    const routineRunStateColumns = this.db.prepare('PRAGMA table_info(routine_runs)').all() as Row[];
    if (!routineRunStateColumns.some(column => column.name === 'recoveryCount')) this.db.exec('ALTER TABLE routine_runs ADD COLUMN recoveryCount INTEGER NOT NULL DEFAULT 0');
    if (!routineRunStateColumns.some(column => column.name === 'needsUserReason')) this.db.exec('ALTER TABLE routine_runs ADD COLUMN needsUserReason TEXT');
    const groupMessageColumns = this.db.prepare('PRAGMA table_info(group_messages)').all() as Row[];
    if (!groupMessageColumns.some(column => column.name === 'turnId')) this.db.exec('ALTER TABLE group_messages ADD COLUMN turnId TEXT');
    if (!groupMessageColumns.some(column => column.name === 'phase')) this.db.exec('ALTER TABLE group_messages ADD COLUMN phase TEXT');
    if (!groupMessageColumns.some(column => column.name === 'contentJson')) this.db.exec('ALTER TABLE group_messages ADD COLUMN contentJson TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS turn_activities (
      id TEXT PRIMARY KEY,
      chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      turnId TEXT,
      itemId TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(chatId, itemId));
    CREATE INDEX IF NOT EXISTS turn_activities_chat ON turn_activities(chatId, createdAt);
    CREATE TABLE IF NOT EXISTS chat_message_queue (
      messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('queued','dispatching','dispatched','needs_user','failed')),
      error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS chat_message_queue_ready ON chat_message_queue(chatId,status,createdAt);`);
    this.db.prepare("UPDATE messages SET status='interrupted' WHERE status='streaming'").run();
    this.db.prepare("UPDATE group_messages SET status='interrupted' WHERE status='streaming'").run();
    this.db.prepare("UPDATE turns SET status='unknown' WHERE status IN ('starting','running')").run();
    const unresolvedDispatchReason = '上次启动时消息已进入派发，但结果无法确认；请检查后决定是否重新发送。';
    this.db.prepare(`UPDATE chat_message_queue SET status='needs_user',error=?,updatedAt=? WHERE status='dispatching'`)
      .run(unresolvedDispatchReason, now());
    this.db.prepare(`UPDATE messages SET dispatchStatus='needs_user',dispatchError=?
      WHERE id IN (SELECT messageId FROM chat_message_queue WHERE status='needs_user') AND dispatchStatus='dispatching'`)
      .run(unresolvedDispatchReason);
    this.db.prepare(`UPDATE messages SET dispatchStatus='needs_user',dispatchError=?
      WHERE dispatchStatus='dispatching' AND id NOT IN (SELECT userMessageId FROM turns WHERE userMessageId IS NOT NULL)`)
      .run(unresolvedDispatchReason);
    if (schemaVersion < 21) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const bots = this.db.prepare('SELECT id, avatar FROM bots').all() as Row[];
        const updateAvatar = this.db.prepare('UPDATE bots SET avatar=? WHERE id=?');
        for (const bot of bots) {
          const avatar = migrateRobotAvatarEyes(String(bot.avatar ?? ''));
          if (avatar) updateAvatar.run(avatar, String(bot.id));
        }
        this.db.exec('PRAGMA user_version=21');
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* migration transaction may already be closed */ }
        throw error;
      }
    }
    if (schemaVersion < 22) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const globalResources = canonicalResourceIds(
          (this.db.prepare("SELECT value FROM settings WHERE key='globalResourceIds'").get() as Row | undefined)?.value
        );
        const defaultResources = canonicalResourceIds(
          (this.db.prepare("SELECT value FROM settings WHERE key='globalDefaultResourceIds'").get() as Row | undefined)?.value
        ).filter(resourceId => globalResources.includes(resourceId));
        const legacyBotResources = this.db.prepare(
          'SELECT botId,resourceId,enabled FROM bot_resources'
        ).all() as Row[];
        const enabledByBot = new Map<string, Set<string>>();
        for (const row of legacyBotResources) {
          if (!row.enabled) continue;
          const botId = String(row.botId);
          const values = enabledByBot.get(botId) ?? new Set<string>();
          values.add(canonicalResourceId(String(row.resourceId)));
          enabledByBot.set(botId, values);
        }
        if (globalResources.length) {
          this.db.prepare(`INSERT INTO settings(key,value) VALUES('globalResourceIds',?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
            .run(JSON.stringify(globalResources));
          this.db.prepare(`INSERT INTO settings(key,value) VALUES('globalDefaultResourceIds',?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
            .run(JSON.stringify(defaultResources));
          this.db.exec('DELETE FROM bot_resources');
          const insert = this.db.prepare(
            'INSERT INTO bot_resources(botId,resourceId,enabled) VALUES(?,?,?)'
          );
          const bots = this.db.prepare('SELECT id FROM bots').all() as Row[];
          for (const bot of bots) {
            const botId = String(bot.id);
            const enabled = enabledByBot.get(botId) ?? new Set<string>();
            for (const resourceId of globalResources) {
              insert.run(botId, resourceId, Number(enabled.has(resourceId)));
            }
          }
        }
        this.db.exec('PRAGMA user_version=22');
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* migration may already have closed */ }
        throw error;
      }
    }
    if (schemaVersion < 23) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('PRAGMA user_version=23');
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* migration may already have closed */ }
        throw error;
      }
    }
    if (schemaVersion < 24) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('PRAGMA user_version=24');
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* migration may already have closed */ }
        throw error;
      }
    }
  }
  bots(): Bot[] { return (this.db.prepare('SELECT * FROM bots ORDER BY createdAt').all() as Row[]).map(botFrom); }
  connectorConnections(): ConnectorConnection[] {
    const capabilityRows = this.db.prepare(
      'SELECT connectionId,capability,status FROM connector_connection_capabilities'
    ).all() as Row[];
    const capabilitiesByConnection = new Map<string, Record<string, 'ready' | 'unavailable'>>();
    for (const row of capabilityRows) {
      const connectionId = String(row.connectionId);
      const capabilities = capabilitiesByConnection.get(connectionId) ?? {};
      capabilities[String(row.capability)] =
        row.status === 'ready' ? 'ready' : 'unavailable';
      capabilitiesByConnection.set(connectionId, capabilities);
    }
    return (this.db.prepare('SELECT * FROM connector_connections ORDER BY createdAt DESC').all() as Row[])
      .map(row => ({
        id: String(row.id),
        providerId: String(row.providerId),
        displayName: String(row.displayName),
        accountLabel: String(row.accountLabel),
        authKind: row.authKind as ConnectorConnection['authKind'],
        status: row.status as ConnectionStatus,
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
        ...(capabilitiesByConnection.has(String(row.id))
          ? { capabilities: capabilitiesByConnection.get(String(row.id)) }
          : {})
      }));
  }
  connectorConnection(id: string): ConnectorConnection {
    const connection = this.connectorConnections().find(item => item.id === id);
    if (!connection) throw new Error('连接不存在');
    return connection;
  }
  createConnectorConnection(input: {
    id: string; providerId: string; displayName: string; accountLabel: string;
    authKind: ConnectorConnection['authKind']; credentialRef: string;
    capabilities?: Record<string, 'ready' | 'unavailable'>;
  }): ConnectorConnection {
    const date = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO connector_connections
        (id,providerId,displayName,accountLabel,authKind,credentialRef,status,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,'ready',?,?)`)
        .run(input.id, input.providerId, input.displayName, input.accountLabel, input.authKind,
          input.credentialRef, date, date);
      for (const [capability, status] of Object.entries(input.capabilities ?? {})) {
        this.db.prepare(`INSERT INTO connector_connection_capabilities(connectionId,capability,status,updatedAt)
          VALUES(?,?,?,?)`).run(input.id, capability, status, date);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.connectorConnection(input.id);
  }
  setConnectorConnectionStatus(id: string, status: ConnectionStatus): ConnectorConnection {
    this.connectorConnection(id);
    this.db.prepare('UPDATE connector_connections SET status=?,updatedAt=? WHERE id=?').run(status, now(), id);
    return this.connectorConnection(id);
  }
  deleteConnectorConnection(id: string): void {
    this.connectorConnection(id);
    this.db.prepare('DELETE FROM connector_connections WHERE id=?').run(id);
  }
  connectorCredentialRef(id: string): string {
    const row = this.db.prepare('SELECT credentialRef FROM connector_connections WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('连接不存在');
    return String(row.credentialRef);
  }
  updateConnectorConnectionCredential(input: {
    id: string;
    credentialRef: string;
    authKind?: ConnectorAuthKind;
    displayName?: string;
    status: ConnectionStatus;
  }): ConnectorConnection {
    this.connectorConnection(input.id);
    this.db.prepare(`UPDATE connector_connections SET
      credentialRef=?,authKind=COALESCE(?,authKind),displayName=COALESCE(?,displayName),status=?,updatedAt=? WHERE id=?`)
      .run(input.credentialRef, input.authKind ?? null, input.displayName ?? null, input.status, now(), input.id);
    return this.connectorConnection(input.id);
  }
  connectorGrants(): ConnectorGrant[] {
    return (this.db.prepare('SELECT * FROM connector_grants ORDER BY createdAt').all() as Row[])
      .map(row => ({
        id: String(row.id), botId: String(row.botId),
        connectionId: String(row.connectionId), createdAt: String(row.createdAt)
      }));
  }
  setConnectorGrant(botId: string, connectionId: string, granted: boolean): ConnectorGrant[] {
    this.bot(botId);
    this.connectorConnection(connectionId);
    if (granted) {
      this.db.prepare(`INSERT OR IGNORE INTO connector_grants(id,botId,connectionId,createdAt)
        VALUES(?,?,?,?)`).run(randomUUID(), botId, connectionId, now());
    } else {
      this.db.prepare('DELETE FROM connector_grants WHERE botId=? AND connectionId=?').run(botId, connectionId);
    }
    return this.connectorGrants().filter(item => item.botId === botId);
  }
  bot(id: string): Bot {
    const r = this.db.prepare('SELECT * FROM bots WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('机器人不存在');
    return botFrom(r);
  }
  chats(): Chat[] { return (this.db.prepare('SELECT * FROM chats WHERE groupChatId IS NULL AND archived=0 AND routineRunId IS NULL ORDER BY updatedAt DESC').all() as Row[]).map(chatFrom); }
  ownedCodexThreadIds(): string[] {
    return (this.db.prepare('SELECT DISTINCT threadId FROM chats WHERE threadId IS NOT NULL').all() as Row[])
      .map(row => String(row.threadId));
  }
  allChats(): Chat[] { return (this.db.prepare('SELECT * FROM chats WHERE archived=0 ORDER BY updatedAt DESC').all() as Row[]).map(chatFrom); }
  botChats(botId: string): Chat[] { return (this.db.prepare('SELECT * FROM chats WHERE botId=? ORDER BY updatedAt DESC').all(botId) as Row[]).map(chatFrom); }
  recentMessages(): Record<string, string> {
    const rows = this.db.prepare(`SELECT messages.chatId, messages.text
      FROM messages
      JOIN chats ON chats.id=messages.chatId
      WHERE chats.groupChatId IS NULL AND chats.archived=0
        AND (chats.routineRunId IS NULL OR chats.routineRunId='')
        AND messages.role IN ('user', 'assistant')
        AND messages.id=(
          SELECT latest.id FROM messages AS latest
          WHERE latest.chatId=messages.chatId AND latest.role IN ('user', 'assistant')
          ORDER BY latest.createdAt DESC, latest.rowid DESC LIMIT 1
        )`).all() as Row[];
    return Object.fromEntries(rows.map(row => [String(row.chatId), String(row.text)]));
  }
  unreadCounts(): Record<string, number> {
    const rows = this.db.prepare(`SELECT messages.chatId, COUNT(*) AS count
      FROM messages
      JOIN chats ON chats.id=messages.chatId
      WHERE chats.groupChatId IS NULL AND chats.archived=0
        AND (chats.routineRunId IS NULL OR chats.routineRunId='')
        AND messages.role='assistant'
        AND (
          chats.lastReadAt IS NULL OR
          messages.createdAt > chats.lastReadAt OR
          (messages.createdAt = chats.lastReadAt AND messages.rowid > COALESCE(chats.lastReadRowId, 0))
        )
      GROUP BY messages.chatId`).all() as Row[];
    return Object.fromEntries(rows.map(row => [String(row.chatId), Number(row.count)]));
  }
  markChatRead(chatId: string, readAt = now()): void {
    const chat = this.chat(chatId);
    if (chat.groupChatId || chat.routineRunId) throw new Error('只能标记可见私聊为已读');
    const lastRow = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS rowId FROM messages WHERE chatId=?').get(chatId) as Row;
    this.db.prepare('UPDATE chats SET lastReadAt=?,lastReadRowId=? WHERE id=?')
      .run(readAt, Number(lastRow.rowId ?? 0), chatId);
  }
  groups(): GroupChat[] {
    const rows = this.db.prepare('SELECT id FROM group_chats WHERE archived=0 ORDER BY updatedAt DESC, createdAt DESC').all() as Row[];
    return rows.map(row => this.group(String(row.id)));
  }
  archivedGroups(): GroupChat[] {
    const rows = this.db.prepare('SELECT id FROM group_chats WHERE archived=1 ORDER BY updatedAt DESC, createdAt DESC').all() as Row[];
    return rows.map(row => this.group(String(row.id)));
  }
  private routineFrom(row: Row): RoutineListItem {
    let parsed: unknown = {};
    try { parsed = JSON.parse(String(row.definitionJson)); } catch { /* retain a readable placeholder for damaged legacy rows */ }
    const definition = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const schedule = typeof definition.schedule === 'string' ? definition.schedule : '';
    let inferred: ReturnType<typeof parseRoutineSchedule> | null = null;
    try {
      inferred = parseRoutineSchedule({
        schedule: schedule || '每天', triggerTime: typeof definition.time === 'string' ? definition.time : '09:00',
        triggerTimes: Array.isArray(definition.times)
          ? definition.times.filter((time): time is string => typeof time === 'string')
          : null,
        kind: definition.kind === 'once' ? 'once' : 'recurring',
        frequency: definition.frequency as RoutineDefinition['frequency'] | null | undefined,
        weekday: typeof definition.weekday === 'number' ? definition.weekday : null,
        dayOfMonth: typeof definition.dayOfMonth === 'number' ? definition.dayOfMonth : null,
        runDate: typeof definition.runAt === 'string' ? definition.runAt.slice(0, 10) : null,
        timezone: typeof definition.timezone === 'string' ? definition.timezone : 'Asia/Shanghai'
      });
    } catch { /* legacy rows keep a readable empty definition */ }
    const unsafeLegacySchedule = Boolean(schedule && isUnsupportedIntervalSchedule(schedule));
    const legacyNextRunAt = row.nextRunAt === null
      ? null
      : typeof row.nextRunAt === 'string'
        ? row.nextRunAt
        : inferred?.runAt ?? null;
    const typedDefinition: RoutineDefinition = {
      instruction: typeof definition.instruction === 'string' ? definition.instruction : '',
      execution: routineExecutionFrom(definition.execution),
      schedule,
      kind: definition.kind === 'once' ? 'once' : 'recurring',
      timezone: typeof definition.timezone === 'string' ? definition.timezone : 'Asia/Shanghai',
      frequency: (definition.frequency as RoutineDefinition['frequency'] | null | undefined) ?? inferred?.frequency ?? null,
      weekday: typeof definition.weekday === 'number' ? definition.weekday : inferred?.weekday ?? null,
      dayOfMonth: typeof definition.dayOfMonth === 'number' ? definition.dayOfMonth : inferred?.dayOfMonth ?? null,
      times: Array.isArray(definition.times)
        ? definition.times.filter((time): time is string => typeof time === 'string')
        : inferred?.times ?? [typeof definition.time === 'string' ? definition.time : '09:00'],
      time: typeof definition.time === 'string' ? definition.time : inferred?.time ?? '09:00',
      runAt: typeof definition.runAt === 'string' ? definition.runAt : inferred?.runAt ?? null,
      catchUp: definition.catchUp !== false,
      rememberLastResult: definition.rememberLastResult === true,
      successNotification: definition.successNotification === true
    };
    const latestRunRow = this.db.prepare('SELECT * FROM routine_runs WHERE routineId=? ORDER BY createdAt DESC LIMIT 1')
      .get(String(row.id)) as Row | undefined;
    const latestRun = latestRunRow ? routineRunFrom(latestRunRow) : null;
    return {
      id: String(row.id), title: String(row.title), botId: String(row.botId),
      sourceChatId: typeof row.sourceChatId === 'string' ? row.sourceChatId : this.ensureBotChat(String(row.botId)).id,
      definition: typedDefinition,
      status: unsafeLegacySchedule ? 'paused' : row.status as RoutineListItem['status'],
      nextRunAt: unsafeLegacySchedule ? null : legacyNextRunAt,
      lastRun: latestRun,
      createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
      ...(unsafeLegacySchedule
        ? { statusReason: '这条任务的旧周期包含每 N 分钟/小时表达，当前版本不能可靠执行；请把一天内的具体 HH:mm 时刻重新保存为一条任务。' }
        : latestRun?.status === 'needs_user'
          ? { statusReason: latestRun.needsUserReason ?? latestRun.error ?? '上次运行结果尚未确认。' }
        : {})
    };
  }
  routines(): RoutineListItem[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY updatedAt DESC,createdAt DESC').all() as Row[])
      .map(row => this.routineFrom(row));
  }
  disableUnsupportedLegacyRoutines(): string[] {
    const disabled: string[] = [];
    for (const row of this.db.prepare('SELECT id,definitionJson,status,nextRunAt FROM routines').all() as Row[]) {
      let definition: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(row.definitionJson));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        definition = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const schedule = typeof definition.schedule === 'string' ? definition.schedule : '';
      if (!isUnsupportedIntervalSchedule(schedule)) continue;
      if (row.status !== 'paused' || row.nextRunAt !== null) {
        this.db.prepare('UPDATE routines SET status=?,nextRunAt=NULL,updatedAt=? WHERE id=?')
          .run('paused', now(), String(row.id));
      }
      disabled.push(String(row.id));
    }
    return disabled;
  }
  routine(id: string): RoutineListItem {
    const row = this.db.prepare('SELECT * FROM routines WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('定时任务不存在');
    return this.routineFrom(row);
  }
  routineBySourceCallId(sourceCallId: string): RoutineListItem | null {
    const row = this.db.prepare('SELECT * FROM routines WHERE sourceCallId=?').get(sourceCallId) as Row | undefined;
    return row ? this.routineFrom(row) : null;
  }
  createRoutine(input: {
    botId: string; title: string; instruction: string; schedule: string; sourceCallId: string;
    kind?: RoutineDefinition['kind']; time?: string; triggerTimes?: string[] | null; runDate?: string | null;
    frequency?: RoutineDefinition['frequency'];
    weekday?: number | null; dayOfMonth?: number | null; catchUp?: boolean;
    rememberLastResult?: boolean; successNotification?: boolean;
    executionMode?: RoutineExecutionMode; executionTemplate?: string | null; timezone?: string; now?: Date;
  }): RoutineListItem {
    const bot = this.bot(input.botId);
    if (bot.archived) throw new Error('已归档的 Bot 不能创建定时任务');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
    const schedule = typeof input.schedule === 'string' ? input.schedule.trim() : '';
    const sourceCallId = typeof input.sourceCallId === 'string' ? input.sourceCallId.trim() : '';
    if (!title || title.length > 120) throw new Error('任务名称须为 1–120 个字符');
    if (!instruction || instruction.length > 20_000) throw new Error('任务指令不能为空或超过长度限制');
    if (!schedule || schedule.length > 1_000) throw new Error('周期表达不能为空或超过长度限制');
    if (!sourceCallId || sourceCallId.length > 200) throw new Error('无效的任务创建请求标识');
    const execution = routineExecutionFrom({
      mode: input.executionMode ?? 'chat',
      ...(input.executionTemplate ? { template: input.executionTemplate } : {})
    });
    if (execution.mode !== 'chat' && !execution.template) {
      throw new Error('脚本或混合执行方式需要提供执行模板');
    }

    const suppliedTriggerTimes = Array.isArray(input.triggerTimes)
      ? input.triggerTimes.filter((time): time is string => typeof time === 'string')
      : [];
    const triggerTime = input.time
      ?? suppliedTriggerTimes[0]
      ?? schedule.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0]
      ?? '';
    const sourceChatId = this.ensureBotChat(bot.id).id;
    const parsed = parseRoutineSchedule({
      schedule, triggerTime, triggerTimes: input.triggerTimes ?? null, kind: input.kind, frequency: input.frequency ?? null,
      weekday: input.weekday ?? null, dayOfMonth: input.dayOfMonth ?? null,
      runDate: input.runDate ?? null, catchUp: input.catchUp,
      rememberLastResult: input.rememberLastResult, successNotification: input.successNotification,
      timezone: input.timezone, now: input.now
    });
    const definition: RoutineDefinition = {
      instruction, execution, schedule, kind: parsed.kind, timezone: parsed.timezone,
      frequency: parsed.frequency, weekday: parsed.weekday, dayOfMonth: parsed.dayOfMonth,
      times: parsed.times, time: parsed.time, runAt: parsed.runAt, catchUp: parsed.catchUp,
      rememberLastResult: parsed.rememberLastResult, successNotification: parsed.successNotification
    };
    const definitionJson = JSON.stringify(definition);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT id,botId,title,definitionJson FROM routines WHERE sourceCallId=?').get(sourceCallId) as Row | undefined;
      if (existing) {
        if (String(existing.botId) !== bot.id || String(existing.title) !== title || String(existing.definitionJson) !== definitionJson) {
          throw new Error('任务创建请求标识冲突');
        }
        this.db.exec('COMMIT');
        return this.routine(String(existing.id));
      }
      const id = randomUUID(), date = now();
      this.db.prepare(`INSERT INTO routines(
        id,title,botId,sourceChatId,definitionJson,status,nextRunAt,createdAt,updatedAt,sourceCallId)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        id, title, bot.id, sourceChatId, definitionJson, 'active',
        parsed.nextRunAt, date, date, sourceCallId
      );
      this.db.exec('COMMIT');
      return this.routine(id);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be committed */ }
      throw error;
    }
  }
  updateRoutine(id: string, patch: {
    title?: string; instruction?: string; schedule?: string; time?: string; triggerTimes?: string[] | null;
    frequency?: RoutineDefinition['frequency']; weekday?: number | null; dayOfMonth?: number | null;
    catchUp?: boolean; rememberLastResult?: boolean; successNotification?: boolean;
    executionMode?: RoutineExecutionMode; executionTemplate?: string | null; now?: Date;
  }): RoutineListItem {
    const routine = this.routine(id);
    const title = patch.title === undefined ? routine.title : patch.title.trim();
    const instruction = patch.instruction === undefined ? routine.definition.instruction : patch.instruction.trim();
    const schedule = patch.schedule === undefined ? routine.definition.schedule : patch.schedule.trim();
    const execution = routineExecutionFrom({
      mode: patch.executionMode ?? routine.definition.execution.mode,
      template: patch.executionTemplate === undefined
        ? routine.definition.execution.template
        : patch.executionTemplate
    });
    if (!title || title.length > 120) throw new Error('任务名称须为 1–120 个字符');
    if (!instruction || instruction.length > 20_000) throw new Error('任务指令不能为空或超过长度限制');
    if (!schedule || schedule.length > 1_000) throw new Error('周期表达不能为空或超过长度限制');
    if (execution.mode !== 'chat' && !execution.template) {
      throw new Error('脚本或混合执行方式需要提供执行模板');
    }
    const time = patch.time === undefined ? routine.definition.time : patch.time.trim();
    const triggerTimes = patch.triggerTimes === undefined
      ? (patch.time === undefined ? routine.definition.times : [time])
      : patch.triggerTimes;
    const sameTriggerTimes = JSON.stringify(triggerTimes ?? []) === JSON.stringify(routine.definition.times);
    if (title === routine.title && instruction === routine.definition.instruction &&
        schedule === routine.definition.schedule && time === routine.definition.time &&
        sameTriggerTimes &&
        execution.mode === routine.definition.execution.mode &&
        execution.template === routine.definition.execution.template &&
        patch.catchUp === undefined && patch.rememberLastResult === undefined &&
        patch.successNotification === undefined) return routine;
    const parsed = parseRoutineSchedule({
      schedule, triggerTime: time, triggerTimes, kind: routine.definition.kind,
      frequency: patch.frequency === undefined ? null : patch.frequency,
      weekday: patch.weekday,
      dayOfMonth: patch.dayOfMonth,
      runDate: routine.definition.runAt?.slice(0, 10) ?? null,
      catchUp: patch.catchUp ?? routine.definition.catchUp,
      rememberLastResult: patch.rememberLastResult ?? routine.definition.rememberLastResult,
      successNotification: patch.successNotification ?? routine.definition.successNotification,
      now: patch.now
    });
    const definition: RoutineDefinition = {
      instruction, execution, schedule, kind: parsed.kind, timezone: parsed.timezone,
      frequency: parsed.frequency, weekday: parsed.weekday, dayOfMonth: parsed.dayOfMonth,
      times: parsed.times, time: parsed.time,
      runAt: routine.definition.kind === 'once' ? routine.definition.runAt : parsed.runAt,
      catchUp: parsed.catchUp, rememberLastResult: parsed.rememberLastResult,
      successNotification: parsed.successNotification
    };
    this.db.prepare('UPDATE routines SET title=?,definitionJson=?,nextRunAt=?,updatedAt=? WHERE id=?')
      .run(title, JSON.stringify(definition), parsed.nextRunAt, now(), id);
    return this.routine(id);
  }
  setRoutineStatus(id: string, status: RoutineListItem['status']): RoutineListItem {
    const routine = this.routine(id);
    if (status !== 'active' && status !== 'paused') throw new Error('无效的 Routine 状态');
    if (status === 'active' && this.routineRuns(id).some(run => run.status === 'needs_user')) {
      throw new Error('请先检查上次运行结果，再确认恢复定时计划。');
    }
    if (routine.status !== status) {
      this.db.prepare('UPDATE routines SET status=?,updatedAt=? WHERE id=?').run(status, now(), id);
    }
    return this.routine(id);
  }
  resolveRoutineRunAndResume(id: string): RoutineListItem {
    this.routine(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const checkedAt = now();
      const result = this.db.prepare(`UPDATE routine_runs SET status='interrupted',
        process=CASE WHEN process IS NULL OR process='' THEN ? ELSE process || char(10) || ? END,
        needsUserReason=NULL,completedAt=COALESCE(completedAt,?) WHERE routineId=? AND status='needs_user'`)
        .run('用户检查后选择恢复计划；上次外部操作结果仍保留为未确认。',
          '用户检查后选择恢复计划；上次外部操作结果仍保留为未确认。', checkedAt, id);
      if (result.changes === 0) throw new Error('没有等待确认的 Routine 运行记录');
      this.db.prepare('UPDATE routines SET status=\'active\',updatedAt=? WHERE id=?').run(now(), id);
      this.db.exec('COMMIT');
      return this.routine(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  deleteRoutine(id: string): void {
    this.routine(id);
    this.db.prepare('DELETE FROM routines WHERE id=?').run(id);
  }
  routineRuns(routineId?: string): RoutineRun[] {
    const rows = routineId
      ? this.db.prepare('SELECT * FROM routine_runs WHERE routineId=? ORDER BY createdAt DESC,rowid DESC').all(routineId)
      : this.db.prepare('SELECT * FROM routine_runs ORDER BY createdAt DESC,rowid DESC').all();
    return (rows as Row[]).map(routineRunFrom);
  }
  createRoutineRun(input: {
    routineId: string; scheduledFor: string; trigger: RoutineRun['trigger'];
    status?: RoutineRunStatus; process?: string | null; dedupeKey?: string | null;
  }): RoutineRun {
    const routine = this.routine(input.routineId);
    const date = now();
    const run: RoutineRun = {
      id: randomUUID(), routineId: routine.id, botId: routine.botId,
      routineTitle: routine.title, instruction: routine.definition.instruction,
      definition: routine.definition,
      definitionVersion: createHash('sha256').update(JSON.stringify(routine.definition)).digest('hex'),
      scheduledFor: input.scheduledFor, status: input.status ?? 'pending',
      trigger: input.trigger, chatId: null, sourceChatId: routine.sourceChatId, turnId: null, summary: null,
      error: null, process: input.process ?? null, startedAt: null,
      completedAt: null, createdAt: date, recoveryCount: 0, needsUserReason: null
    };
    this.db.exec('SAVEPOINT create_routine_run');
    try {
      this.db.prepare(`INSERT INTO routine_runs(
        id,routineId,botId,routineTitle,instruction,definitionJson,definitionVersion,
        scheduledFor,status,trigger,chatId,turnId,sourceChatId,summary,error,process,
        startedAt,completedAt,createdAt,dedupeKey)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        run.id, run.routineId, run.botId, run.routineTitle, run.instruction,
        JSON.stringify(run.definition), run.definitionVersion,
        run.scheduledFor, run.status, run.trigger, null, null, run.sourceChatId, null, null,
        run.process, null, null, run.createdAt, input.dedupeKey ?? null
      );
      this.db.exec('RELEASE create_routine_run');
    } catch (error) {
      try { this.db.exec('ROLLBACK TO create_routine_run'); } catch { /* savepoint may be closed */ }
      try { this.db.exec('RELEASE create_routine_run'); } catch { /* savepoint may be closed */ }
      throw error;
    }
    return run;
  }
  createRoutineExecutionChat(runId: string, botId: string, title: string): Chat {
    const run = this.routineRun(runId);
    if (run.botId !== botId) throw new Error('Routine 运行与 Bot 不匹配');
    const existing = this.db.prepare('SELECT id FROM chats WHERE routineRunId=? LIMIT 1').get(runId) as Row | undefined;
    if (typeof existing?.id === 'string') return this.chat(existing.id);
    const normalizedTitle = title.trim().slice(0, 120) || run.routineTitle;
    const id = randomUUID(), date = now();
    this.db.prepare(`INSERT INTO chats(
      id,botId,title,groupChatId,archived,routineToolsEnabled,memoryToolsEnabled,routineRunId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id, botId, normalizedTitle, null, 0, 0, 0, runId, date, date
    );
    return this.chat(id);
  }
  routineRun(id: string): RoutineRun {
    const row = this.db.prepare('SELECT * FROM routine_runs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('Routine 运行记录不存在');
    return routineRunFrom(row);
  }
  updateRoutineRun(id: string, patch: Partial<Pick<RoutineRun,
    'status' | 'chatId' | 'sourceChatId' | 'turnId' | 'summary' | 'error' | 'process' | 'startedAt' | 'completedAt' |
    'recoveryCount' | 'needsUserReason'>>): RoutineRun {
    const row = this.db.prepare('SELECT * FROM routine_runs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('Routine 运行记录不存在');
    const merged = { ...routineRunFrom(row), ...patch };
    this.db.prepare(`UPDATE routine_runs SET status=?,chatId=?,sourceChatId=?,turnId=?,summary=?,error=?,process=?,startedAt=?,completedAt=?,
      recoveryCount=?,needsUserReason=? WHERE id=?`).run(
      merged.status, merged.chatId, merged.sourceChatId, merged.turnId, merged.summary, merged.error,
      merged.process, merged.startedAt, merged.completedAt, merged.recoveryCount, merged.needsUserReason, id);
    return this.routineRun(id);
  }
  claimRoutineRunRecovery(id: string): RoutineRun | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status,recoveryCount FROM routine_runs WHERE id=?').get(id) as Row | undefined;
      if (!row || (row.status !== 'pending' && row.status !== 'running') || Number(row.recoveryCount ?? 0) >= 1) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(`UPDATE routine_runs SET recoveryCount=recoveryCount+1,status='running',needsUserReason=NULL,
        error=NULL,completedAt=NULL,startedAt=COALESCE(startedAt,?),process=? WHERE id=?`)
        .run(now(), '应用重启后自动恢复（1/1）', id);
      this.db.exec('COMMIT');
      return this.routineRun(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  markRoutineRunNeedsUser(id: string, reason: string): RoutineRun {
    const run = this.routineRun(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`UPDATE routine_runs SET status='needs_user',error=?,needsUserReason=?,completedAt=? WHERE id=?
        AND status IN ('pending','running')`).run(reason, reason, now(), id);
      if (result.changes > 0) {
        this.db.prepare(`UPDATE routines SET status='paused',updatedAt=? WHERE id=? AND status='active'`)
          .run(now(), run.routineId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.routineRun(id);
  }
  markRoutineScheduled(routineId: string, scheduledFor: string, after = new Date()): RoutineListItem {
    const routine = this.routine(routineId);
    const nextRunAt = routine.definition.kind === 'once'
      ? null
      : followingRun(routine.definition, new Date(Math.max(after.getTime(), Date.parse(scheduledFor) + 1_000)));
    this.db.prepare('UPDATE routines SET nextRunAt=?,lastScheduledFor=?,updatedAt=? WHERE id=?')
      .run(nextRunAt, scheduledFor, now(), routineId);
    return this.routine(routineId);
  }
  setRoutineNextRunForAcceptance(routineId: string, nextRunAt: string): RoutineListItem {
    this.routine(routineId);
    this.db.prepare('UPDATE routines SET nextRunAt=?,updatedAt=? WHERE id=?')
      .run(nextRunAt, now(), routineId);
    return this.routine(routineId);
  }
  dueRoutines(at = new Date()): RoutineListItem[] {
    return (this.db.prepare(`SELECT * FROM routines WHERE status='active' AND nextRunAt IS NOT NULL
      AND nextRunAt<=? ORDER BY nextRunAt,createdAt`).all(at.toISOString()) as Row[]).map(row => this.routineFrom(row));
  }
  clearRoutineNextRun(routineId: string): RoutineListItem {
    this.routine(routineId);
    this.db.prepare('UPDATE routines SET nextRunAt=NULL,updatedAt=? WHERE id=?').run(now(), routineId);
    return this.routine(routineId);
  }
  group(id: string): GroupChat {
    const row = this.db.prepare('SELECT * FROM group_chats WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('群聊不存在');
    const members = this.db.prepare('SELECT botId FROM group_chat_members WHERE groupChatId=? ORDER BY position').all(id) as Row[];
    return {
      id: String(row.id), title: String(row.title),
      archived: Boolean(row.archived),
      defaultBotId: typeof row.defaultBotId === 'string' ? row.defaultBotId : null,
      memberIds: members.map(member => String(member.botId)),
      createdAt: String(row.createdAt), updatedAt: String(row.updatedAt)
    };
  }
  chat(id: string): Chat {
    const r = this.db.prepare('SELECT * FROM chats WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('聊天不存在');
    return chatFrom(r);
  }
  createBot(name: string, avatar: string): { bot: Bot; chat: Chat } {
    const id = randomUUID();
    const settings = this.settings();
    const model = typeof settings.defaultBotModel === 'string' ? settings.defaultBotModel.trim() : '';
    if (!model) throw new Error('模型配置尚未就绪，暂时不能新建 Bot');
    const permission = resolvedDefaultPermission(settings.defaultBotPermission);
    const enabledResources = canonicalResourceIds(settings.globalDefaultResourceIds);
    const visibleResources = canonicalResourceIds(settings.globalResourceIds);
    const resourceIds = [...new Set(enabledResources.filter(id => visibleResources.includes(id)))];
    const resourceRecords = visibleResources.map(resourceId => ({
      resourceId,
      enabled: resourceIds.includes(resourceId)
    }));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO bots(id,name,avatar,model,permission,resourceIdsJson,createdAt)
        VALUES(?,?,?,?,?,?,?)`)
        .run(id, name, avatar, model, permission, JSON.stringify(resourceIds), now());
      const insertResource = this.db.prepare(
        'INSERT INTO bot_resources(botId,resourceId,enabled) VALUES(?,?,?)'
      );
      for (const resource of resourceRecords) {
        insertResource.run(id, resource.resourceId, resource.enabled ? 1 : 0);
      }
      const chat = this.ensureBotChat(id);
      this.db.exec('COMMIT');
      return { bot: this.bot(id), chat };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  materializeBotExecutionDefaults(
    model: string,
    permission: PermissionMode,
    previousPermission?: PermissionMode
  ): number {
    const normalizedModel = model.trim();
    if (!normalizedModel || normalizedModel.length > 500 || !permissionModes.has(permission)) {
      throw new Error('Bot 执行初值无效');
    }
    const marker = 'botExecutionDefaultsMigratedV1';
    const alreadyMigrated = this.db.prepare('SELECT value FROM settings WHERE key=?')
      .get(marker) as Row | undefined;
    if (alreadyMigrated?.value === '1') return 0;
    const rows = this.db.prepare(`SELECT b.id,b.model,b.permission,c.model AS chatModel,
      c.permission AS chatPermission, s.value AS previousGlobalPermission
      FROM bots b LEFT JOIN chats c ON c.botId=b.id AND c.groupChatId IS NULL
        AND c.routineRunId IS NULL AND c.archived=0
      LEFT JOIN settings s ON s.key='defaultBotPermission'`).all() as Row[];
    const update = this.db.prepare('UPDATE bots SET model=?,permission=? WHERE id=?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const existingModel = typeof row.model === 'string' && row.model.trim()
          ? row.model.trim()
          : typeof row.chatModel === 'string' && row.chatModel.trim()
            ? row.chatModel.trim()
            : normalizedModel;
        const globalPermission = previousPermission ?? (typeof row.previousGlobalPermission === 'string' &&
          permissionModes.has(row.previousGlobalPermission as PermissionMode)
          ? row.previousGlobalPermission as PermissionMode
          : permission);
        const chatPermission = typeof row.chatPermission === 'string' &&
          permissionModes.has(row.chatPermission as PermissionMode)
          ? row.chatPermission as PermissionMode
          : null;
        // The settings default existed before per-Bot defaults and captured the
        // permission that legacy Bots inherited. Chat override still wins.
        const existingPermission = chatPermission ?? globalPermission ?? permission;
        update.run(existingModel, existingPermission, String(row.id));
      }
      this.db.prepare(`INSERT INTO settings(key,value) VALUES(?, '1')
        ON CONFLICT(key) DO UPDATE SET value='1'`).run(marker);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }
  updateBot(id: string, patch: Record<string, unknown>): Bot {
    this.bot(id);
    const columns = new Set(['name', 'avatar', 'role', 'instructions', 'model', 'permission', 'notificationsEnabled']);
    for (const [key, value] of Object.entries(patch)) {
      if (!columns.has(key)) throw new Error('不支持的机器人字段');
      this.db.prepare(`UPDATE bots SET ${key}=? WHERE id=?`).run(typeof value === 'boolean' ? Number(value) : value as string | null, id);
    }
    return this.bot(id);
  }
  updateBotExecutionConfig(
    id: string,
    patch: { model: string; permission: PermissionMode }
  ): Bot {
    this.bot(id);
    const model = patch.model.trim();
    if (!model || model.length > 500) throw new Error('Bot 模型无效');
    if (!permissionModes.has(patch.permission)) throw new Error('无效的权限模式');
    this.db.prepare('UPDATE bots SET model=?,permission=? WHERE id=?')
      .run(model, patch.permission, id);
    return this.bot(id);
  }
  setBotResource(botId: string, resourceId: string, enabled: boolean): Bot {
    this.bot(botId);
    const normalizedId = canonicalResourceId(resourceId);
    const global = canonicalResourceIds(this.settings().globalResourceIds);
    if (!global.includes(normalizedId)) throw new Error('资源不在全局可选目录中');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO bot_resources(botId,resourceId,enabled) VALUES(?,?,?)
        ON CONFLICT(botId,resourceId) DO UPDATE SET enabled=excluded.enabled`)
        .run(botId, normalizedId, Number(enabled));
      const active = (this.db.prepare(
        'SELECT resourceId FROM bot_resources WHERE botId=? AND enabled=1 ORDER BY rowid'
      ).all(botId) as Row[]).map(row => String(row.resourceId));
      this.db.prepare('UPDATE bots SET resourceIdsJson=? WHERE id=?')
        .run(JSON.stringify(active), botId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.bot(botId);
  }
  botResourceEnabled(botId: string, resourceId: string): boolean {
    const normalizedId = canonicalResourceId(resourceId);
    const row = this.db.prepare(
      'SELECT enabled FROM bot_resources WHERE botId=? AND resourceId=?'
    ).get(botId, normalizedId) as Row | undefined;
    return !!row?.enabled;
  }
  botResourceRecords(botId: string): Array<{ resourceId: string; enabled: boolean }> {
    this.bot(botId);
    return (this.db.prepare(
      'SELECT resourceId,enabled FROM bot_resources WHERE botId=? ORDER BY rowid'
    ).all(botId) as Row[]).map(row => ({
      resourceId: String(row.resourceId),
      enabled: !!row.enabled
    }));
  }
  setConnectorConnectionCapabilities(
    connectionId: string,
    capabilities: Record<string, 'ready' | 'unavailable'>
  ): void {
    this.connectorConnection(connectionId);
    const date = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.db.prepare(`INSERT INTO connector_connection_capabilities
        (connectionId,capability,status,updatedAt) VALUES(?,?,?,?)
        ON CONFLICT(connectionId,capability) DO UPDATE
        SET status=excluded.status,updatedAt=excluded.updatedAt`);
      for (const [capability, status] of Object.entries(capabilities)) {
        upsert.run(connectionId, capability, status, date);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  saveWechatConnectionBinding(input: {
    connectionId: string;
    accountId: string;
    dataDirectory: string;
    wechatVersion: string;
    wechatBuild: string;
    captureVersion: string;
  }): void {
    this.connectorConnection(input.connectionId);
    const date = now();
    this.db.prepare(`INSERT INTO wechat_connections
      (connectionId,accountId,dataDirectory,wechatVersion,wechatBuild,captureVersion,lastVerifiedAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(connectionId) DO UPDATE SET
        accountId=excluded.accountId,dataDirectory=excluded.dataDirectory,
        wechatVersion=excluded.wechatVersion,wechatBuild=excluded.wechatBuild,
        captureVersion=excluded.captureVersion,lastVerifiedAt=excluded.lastVerifiedAt,
        updatedAt=excluded.updatedAt`).run(
          input.connectionId, input.accountId, input.dataDirectory,
          input.wechatVersion, input.wechatBuild, input.captureVersion, date, date
        );
  }
  wechatConnectionBinding(connectionId: string): {
    connectionId: string;
    accountId: string;
    dataDirectory: string;
    wechatVersion: string;
    wechatBuild: string;
    captureVersion: string;
    lastVerifiedAt: string;
  } {
    const row = this.db.prepare('SELECT * FROM wechat_connections WHERE connectionId=?')
      .get(connectionId) as Row | undefined;
    if (!row) throw new Error('微信连接绑定不存在，请重新连接');
    return {
      connectionId: String(row.connectionId),
      accountId: String(row.accountId),
      dataDirectory: String(row.dataDirectory),
      wechatVersion: String(row.wechatVersion),
      wechatBuild: String(row.wechatBuild),
      captureVersion: String(row.captureVersion),
      lastVerifiedAt: String(row.lastVerifiedAt)
    };
  }
  syncBotResources(resourceIds: string[], defaultResourceIds: string[]): void {
    const global = canonicalResourceIds(resourceIds);
    const defaults = canonicalResourceIds(defaultResourceIds).filter(id => global.includes(id));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO settings(key,value) VALUES('globalResourceIds',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(global));
      this.db.prepare(`INSERT INTO settings(key,value) VALUES('globalDefaultResourceIds',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(defaults));
      const bots = this.db.prepare('SELECT id FROM bots').all() as Row[];
      for (const row of bots) {
        const botId = String(row.id);
        this.db.prepare('DELETE FROM bot_resources WHERE botId=? AND resourceId NOT IN (SELECT value FROM json_each(?))')
          .run(botId, JSON.stringify(global));
        const upsert = this.db.prepare(`INSERT INTO bot_resources(botId,resourceId,enabled)
          VALUES(?,?,0) ON CONFLICT(botId,resourceId) DO NOTHING`);
        for (const resourceId of global) upsert.run(botId, resourceId);
        const active = (this.db.prepare(
          'SELECT resourceId FROM bot_resources WHERE botId=? AND enabled=1 ORDER BY rowid'
        ).all(botId) as Row[]).map(item => String(item.resourceId));
        this.db.prepare('UPDATE bots SET resourceIdsJson=? WHERE id=?')
          .run(JSON.stringify(active), botId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  setGlobalResourceIncluded(resourceId: string, included: boolean): {
    globalResourceIds: string[];
    globalDefaultResourceIds: string[];
  } {
    const normalizedId = canonicalResourceId(resourceId);
    const global = canonicalResourceIds(this.settings().globalResourceIds);
    const next = included
      ? [...new Set([...global, normalizedId])]
      : global.filter(id => id !== normalizedId);
    const defaults = canonicalResourceIds(this.settings().globalDefaultResourceIds)
      .filter(id => next.includes(id));
    this.syncBotResources(next, defaults);
    return { globalResourceIds: next, globalDefaultResourceIds: defaults };
  }
  setGlobalResourceDefault(resourceId: string, enabled: boolean): {
    globalResourceIds: string[];
    globalDefaultResourceIds: string[];
  } {
    const normalizedId = canonicalResourceId(resourceId);
    const global = canonicalResourceIds(this.settings().globalResourceIds);
    if (!global.includes(normalizedId)) throw new Error('资源必须先加入全局可选目录');
    const current = canonicalResourceIds(this.settings().globalDefaultResourceIds)
      .filter(id => global.includes(id));
    const next = enabled
      ? [...new Set([...current, normalizedId])]
      : current.filter(id => id !== normalizedId);
    this.syncBotResources(global, next);
    return { globalResourceIds: global, globalDefaultResourceIds: next };
  }
  directMcpServers(): Array<{
    id: string; name: string; description: string; transport: 'stdio' | 'http';
    command: string | null; args: string[]; cwd: string | null; url: string | null;
    credentialRef: string | null; headerKeys: string[]; envKeys: string[];
    enabled: boolean; createdAt: string; updatedAt: string;
  }> {
    return (this.db.prepare(
      'SELECT * FROM direct_mcp_servers ORDER BY name COLLATE NOCASE'
    ).all() as Row[]).map(row => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      transport: row.transport === 'http' ? 'http' : 'stdio',
      command: typeof row.command === 'string' ? row.command : null,
      args: parseStringArray(row.argsJson),
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      url: typeof row.url === 'string' ? row.url : null,
      credentialRef: typeof row.credentialRef === 'string' ? row.credentialRef : null,
      headerKeys: parseStringArray(row.headerKeysJson),
      envKeys: parseStringArray(row.envKeysJson),
      enabled: Boolean(row.enabled),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt)
    }));
  }
  directMcpServer(id: string): ReturnType<Store['directMcpServers']>[number] | null {
    return this.directMcpServers().find(server => server.id === id) ?? null;
  }
  createDirectMcpServer(input: {
    name: string; description: string; enabled: boolean;
    transport: 'stdio' | 'http'; command: string | null; args: string[];
    cwd: string | null; url: string | null; credentialRef: string | null;
    headers: Record<string, string>; env: Record<string, string>;
  }): ReturnType<Store['directMcpServers']>[number] {
    const date = now();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO direct_mcp_servers(
      id,name,description,transport,command,argsJson,cwd,url,credentialRef,
      headerKeysJson,envKeysJson,enabled,createdAt,updatedAt
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.name, input.description, input.transport, input.command,
      JSON.stringify(input.args), input.cwd, input.url, input.credentialRef,
      JSON.stringify(Object.keys(input.headers).sort()),
      JSON.stringify(Object.keys(input.env).sort()),
      Number(input.enabled), date, date
    );
    return this.directMcpServer(id)!;
  }
  updateDirectMcpServer(id: string, input: {
    name: string; description: string; enabled: boolean;
    transport: 'stdio' | 'http'; command: string | null; args: string[];
    cwd: string | null; url: string | null; credentialRef: string | null;
    headers?: Record<string, string>; env?: Record<string, string>;
  }): ReturnType<Store['directMcpServers']>[number] {
    if (!this.directMcpServer(id)) throw new Error('MCP Server 不存在');
    const headerKeys = input.headers === undefined
      ? null
      : JSON.stringify(Object.keys(input.headers).sort());
    const envKeys = input.env === undefined
      ? null
      : JSON.stringify(Object.keys(input.env).sort());
    this.db.prepare(`UPDATE direct_mcp_servers SET
      name=?,description=?,transport=?,command=?,argsJson=?,cwd=?,url=?,
      credentialRef=?,headerKeysJson=COALESCE(?,headerKeysJson),
      envKeysJson=COALESCE(?,envKeysJson),enabled=?,updatedAt=? WHERE id=?`).run(
      input.name, input.description, input.transport, input.command,
      JSON.stringify(input.args), input.cwd, input.url, input.credentialRef,
      headerKeys,
      envKeys,
      Number(input.enabled), now(), id
    );
    return this.directMcpServer(id)!;
  }
  deleteDirectMcpServer(id: string): void {
    if (!this.directMcpServer(id)) throw new Error('MCP Server 不存在');
    this.db.prepare('DELETE FROM direct_mcp_servers WHERE id=?').run(id);
  }
  setBotArchived(id: string, archived: boolean): Bot {
    this.bot(id);
    if (typeof archived !== 'boolean') throw new Error('无效的归档状态');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE bots SET archived=? WHERE id=?').run(Number(archived), id);
      if (archived) {
        this.db.prepare("UPDATE routines SET status='paused',updatedAt=? WHERE botId=? AND status='active'")
          .run(now(), id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.bot(id);
  }
  deleteBot(id: string): void {
    this.bot(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE group_chats SET defaultBotId=NULL,updatedAt=? WHERE defaultBotId=?').run(now(), id);
      this.db.prepare('DELETE FROM group_chat_members WHERE botId=?').run(id);
      this.db.prepare('DELETE FROM bots WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  ensureBotChat(botId: string): Chat {
    this.bot(botId);
    const existing = this.db.prepare(`SELECT id FROM chats WHERE botId=? AND groupChatId IS NULL
      AND archived=0 AND routineRunId IS NULL LIMIT 1`)
      .get(botId) as Row | undefined;
    if (typeof existing?.id === 'string') return this.chat(existing.id);
    const legacy = this.db.prepare(`SELECT id FROM chats WHERE botId=? AND groupChatId IS NULL
      AND routineRunId IS NULL ORDER BY updatedAt DESC,createdAt DESC LIMIT 1`)
      .get(botId) as Row | undefined;
    if (typeof legacy?.id === 'string') {
      this.db.prepare('UPDATE chats SET archived=0 WHERE id=?').run(legacy.id);
      return this.chat(legacy.id);
    }
    const id = randomUUID(), date = now();
    this.db.prepare('INSERT INTO chats(id,botId,title,createdAt,updatedAt) VALUES(?,?,?,?,?)').run(id, botId, '新对话', date, date);
    return this.chat(id);
  }
  createGroup(title: string, botIds: string[]): GroupChat {
    const normalizedTitle = title.trim();
    if (!normalizedTitle || normalizedTitle.length > 120) throw new Error('群聊名称须为 1–120 个字符');
    if (!Array.isArray(botIds) || botIds.length < 2) throw new Error('群聊至少需要选择两个 Bot');
    if (botIds.some(botId => typeof botId !== 'string' || !botId.trim())) throw new Error('无效的群聊成员');
    if (new Set(botIds).size !== botIds.length) throw new Error('群聊成员不能重复');
    const members = botIds.map(botId => this.bot(botId));
    if (members.some(bot => bot.archived)) throw new Error('已归档的 Bot 不能加入新群聊');

    const id = randomUUID(), createdAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO group_chats(id,title,defaultBotId,createdAt,updatedAt) VALUES(?,?,?,?,?)')
        .run(id, normalizedTitle, null, createdAt, createdAt);
      const insertMember = this.db.prepare('INSERT INTO group_chat_members(groupChatId,botId,position,joinedAt) VALUES(?,?,?,?)');
      botIds.forEach((botId, position) => insertMember.run(id, botId, position, createdAt));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.group(id);
  }
  setGroupArchived(id: string, archived: boolean): GroupChat {
    this.group(id);
    if (typeof archived !== 'boolean') throw new Error('无效的归档状态');
    this.db.prepare('UPDATE group_chats SET archived=?,updatedAt=? WHERE id=?').run(Number(archived), now(), id);
    return this.group(id);
  }
  deleteGroup(id: string): void {
    this.group(id);
    this.db.prepare('DELETE FROM group_chats WHERE id=?').run(id);
  }
  addGroupMembers(groupId: string, botIds: string[]): GroupChat {
    const group = this.group(groupId);
    if (!Array.isArray(botIds) || botIds.length === 0) throw new Error('请选择要加入的 Bot');
    if (botIds.some(botId => typeof botId !== 'string' || !botId.trim())) throw new Error('无效的群聊成员');
    if (new Set(botIds).size !== botIds.length) throw new Error('群聊成员不能重复');
    if (botIds.some(botId => group.memberIds.includes(botId))) throw new Error('所选 Bot 已在群聊中');
    if (botIds.map(botId => this.bot(botId)).some(bot => bot.archived)) {
      throw new Error('已归档的 Bot 不能加入群聊');
    }
    const joinedAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertMember = this.db.prepare(
        'INSERT INTO group_chat_members(groupChatId,botId,position,joinedAt) VALUES(?,?,?,?)'
      );
      botIds.forEach((botId, offset) => {
        insertMember.run(groupId, botId, group.memberIds.length + offset, joinedAt);
      });
      this.db.prepare('UPDATE group_chats SET updatedAt=? WHERE id=?').run(joinedAt, groupId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.group(groupId);
  }
  groupSession(groupId: string, botId: string): Chat {
    const group = this.group(groupId);
    const bot = this.bot(botId);
    if (!group.memberIds.includes(botId)) throw new Error('该 Bot 不属于此群聊');
    const existing = this.db.prepare("SELECT chatId FROM group_chat_sessions WHERE groupChatId=? AND botId=? AND purpose='member'")
      .get(groupId, botId) as Row | undefined;
    if (typeof existing?.chatId === 'string') {
      return this.chat(existing.chatId);
    }

    const chatId = randomUUID(), date = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO chats(id,botId,title,groupChatId,permission,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?)`).run(chatId, bot.id, `群聊：${group.title}`, groupId, null, date, date);
      this.db.prepare("INSERT INTO group_chat_sessions(groupChatId,botId,purpose,chatId) VALUES(?,?,'member',?)")
        .run(groupId, botId, chatId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.chat(chatId);
  }
  groupMemberChats(groupId: string): Chat[] {
    const group = this.group(groupId);
    return group.memberIds.map(botId => this.bot(botId)).filter(bot => !bot.archived)
      .map(bot => this.groupSession(groupId, bot.id));
  }
  groupSessions(): Array<{ groupId: string; botId: string; purpose: 'member' | 'router'; chatId: string }> {
    return this.db.prepare('SELECT groupChatId AS groupId,botId,purpose,chatId FROM group_chat_sessions')
      .all() as Array<{ groupId: string; botId: string; purpose: 'member' | 'router'; chatId: string }>;
  }
  groupSessionChats(groupId: string): Chat[] {
    this.group(groupId);
    const rows = this.db.prepare(`SELECT chats.id FROM chats
      JOIN group_chat_sessions ON group_chat_sessions.chatId=chats.id
      WHERE group_chat_sessions.groupChatId=? ORDER BY group_chat_sessions.botId`).all(groupId) as Row[];
    return rows.map(row => this.chat(String(row.id)));
  }
  groupMessages(groupId: string): GroupMessage[] {
    this.group(groupId);
    const generatedByMemberTurn = new Map<string, string[]>();
    const sessions = this.db.prepare(`SELECT botId,chatId FROM group_chat_sessions
      WHERE groupChatId=? AND purpose='member'`).all(groupId) as Row[];
    for (const session of sessions) {
      const botId = String(session.botId);
      const pathsByTurn = this.generatedImagePathsByTurn(String(session.chatId));
      for (const [turnId, paths] of pathsByTurn) generatedByMemberTurn.set(`${botId}:${turnId}`, paths);
    }
    return (this.db.prepare('SELECT * FROM group_messages WHERE groupId=? ORDER BY createdAt,rowid').all(groupId) as Row[])
      .map(row => {
        const message = groupMessageFrom(row);
        const paths = message.senderBotId && message.turnId
          ? generatedByMemberTurn.get(`${message.senderBotId}:${message.turnId}`) ?? []
          : [];
        return message.content || !paths.length
          ? message
          : { ...message, content: generatedImageContent(paths[0]) };
      });
  }
  addGroupMessage(groupId: string, role: GroupMessage['role'], text: string, options: {
    senderBot?: Bot | null; senderName?: string | null; status?: MessageStatus; itemId?: string | null;
    turnId?: string | null; phase?: GroupMessage['phase']; content?: MessageContent | null;
  } = {}): GroupMessage {
    this.group(groupId);
    if (options.senderBot && !this.group(groupId).memberIds.includes(options.senderBot.id)) throw new Error('回复 Bot 不属于此群聊');
    const message: GroupMessage = {
      id: randomUUID(), groupId, role, senderBotId: options.senderBot?.id ?? null,
      senderName: options.senderBot?.name ?? options.senderName ?? null, text,
      status: options.status ?? 'complete', itemId: options.itemId ?? null, createdAt: now(),
      turnId: options.turnId ?? null, phase: options.phase ?? null, content: options.content ?? null
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO group_messages(id,groupId,role,senderBotId,senderName,text,status,itemId,createdAt,turnId,phase,contentJson) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(message.id, groupId, role, message.senderBotId, message.senderName, text, message.status, message.itemId, message.createdAt,
          message.turnId, message.phase, message.content ? JSON.stringify(message.content) : null);
      this.db.prepare('UPDATE group_chats SET updatedAt=? WHERE id=?').run(message.createdAt, groupId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return message;
  }
  groupAssistantItem(
    groupId: string,
    botId: string,
    itemId: string,
    text: string,
    append: boolean,
    status: MessageStatus,
    turnId: string | null = null,
    phase: GroupMessage['phase'] = null
  ): GroupMessage {
    const bot = this.bot(botId);
    let existingRow: Row | undefined;
    if (turnId) {
      const rows = this.db.prepare("SELECT * FROM group_messages WHERE groupId=? AND senderBotId=? AND turnId=? AND role='assistant' ORDER BY rowid DESC")
        .all(groupId, botId, turnId) as Row[];
      existingRow = rows.find(row => typeof row.contentJson !== 'string');
      if (!existingRow) {
        const memberSession = this.db.prepare(`SELECT chatId FROM group_chat_sessions
          WHERE groupChatId=? AND botId=? AND purpose='member'`).get(groupId, botId) as Row | undefined;
        const generatedPaths = typeof memberSession?.chatId === 'string'
          ? this.generatedImagePathsByTurn(memberSession.chatId).get(turnId) ?? []
          : [];
        existingRow = rows.find(row => isGeneratedImageContent(groupMessageFrom(row).content, generatedPaths));
      }
    } else {
      existingRow = this.db.prepare("SELECT * FROM group_messages WHERE groupId=? AND senderBotId=? AND itemId=? AND role='assistant'")
        .get(groupId, botId, itemId) as Row | undefined;
    }
    if (!existingRow) {
      return this.addGroupMessage(groupId, 'assistant', text, { senderBot: bot, status, itemId, turnId, phase });
    }
    const existing = groupMessageFrom(existingRow);
    const value = append && existing.itemId === itemId ? existing.text + text : text;
    this.db.prepare('UPDATE group_messages SET text=?,status=?,itemId=?,turnId=COALESCE(?,turnId),phase=? WHERE id=?')
      .run(value, status, itemId, turnId, phase, existing.id);
    this.db.prepare('UPDATE group_chats SET updatedAt=? WHERE id=?').run(now(), groupId);
    return { ...existing, text: value, status, itemId, turnId: turnId ?? existing.turnId, phase };
  }
  removeGroupAssistantTurn(groupId: string, botId: string, turnId: string | null, itemId: string): string | null {
    const row = turnId
      ? this.db.prepare("SELECT id FROM group_messages WHERE groupId=? AND senderBotId=? AND turnId=? AND role='assistant' ORDER BY rowid DESC LIMIT 1")
        .get(groupId, botId, turnId) as Row | undefined
      : this.db.prepare("SELECT id FROM group_messages WHERE groupId=? AND senderBotId=? AND itemId=? AND role='assistant'")
        .get(groupId, botId, itemId) as Row | undefined;
    if (!row) return null;
    const id = String(row.id);
    this.db.prepare('DELETE FROM group_messages WHERE id=?').run(id);
    return id;
  }
  finishGroupMessages(groupId: string, botId: string, status: MessageStatus): GroupMessage[] {
    const rows = this.db.prepare("SELECT * FROM group_messages WHERE groupId=? AND senderBotId=? AND role='assistant' AND status='streaming'")
      .all(groupId, botId) as Row[];
    this.db.prepare("UPDATE group_messages SET status=? WHERE groupId=? AND senderBotId=? AND role='assistant' AND status='streaming'")
      .run(status, groupId, botId);
    return rows.map(row => groupMessageFrom({ ...row, status }));
  }
  updateChat(id: string, patch: { model?: string | null; permission?: PermissionMode | null }): void {
    this.chat(id);
    const allowed = new Set(['model', 'permission']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error('不支持的聊天字段');
    if (patch.model !== undefined && patch.model !== null && (typeof patch.model !== 'string' || !patch.model.trim() || patch.model.length > 200)) throw new Error('无效的聊天模型');
    if (patch.permission !== undefined && patch.permission !== null && !permissionModes.has(patch.permission)) throw new Error('无效的权限模式');
    const columns: string[] = [], values: Array<string | number | null> = [];
    if (patch.model !== undefined) { columns.push('model=?'); values.push(patch.model); }
    if (patch.permission !== undefined) { columns.push('permission=?'); values.push(patch.permission); }
    if (!columns.length) return;
    columns.push('updatedAt=?'); values.push(now()); values.push(id);
    this.db.prepare(`UPDATE chats SET ${columns.join(',')} WHERE id=?`).run(...values);
  }
  bindThread(
    id: string,
    threadId: string,
    routineToolsEnabled = false,
    memoryToolsEnabled = false
  ): void {
    this.db.prepare('UPDATE chats SET threadId=?,routineToolsEnabled=?,memoryToolsEnabled=? WHERE id=?')
      .run(threadId, Number(routineToolsEnabled), Number(memoryToolsEnabled), id);
  }
  chatRoutineToolsEnabled(id: string): boolean {
    const row = this.db.prepare('SELECT routineToolsEnabled FROM chats WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('聊天不存在');
    return !!row.routineToolsEnabled;
  }
  chatMemoryToolsEnabled(id: string): boolean {
    const row = this.db.prepare('SELECT memoryToolsEnabled FROM chats WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('聊天不存在');
    return !!row.memoryToolsEnabled;
  }
  messages(chatId: string): Message[] {
    this.chat(chatId);
    const generatedByTurn = this.generatedImagePathsByTurn(chatId);
    return (this.db.prepare('SELECT * FROM messages WHERE chatId=? ORDER BY createdAt, rowid').all(chatId) as Row[])
      .map(row => {
        const message = messageFrom(row);
        const paths = message.role === 'assistant' && message.turnId
          ? generatedByTurn.get(message.turnId) ?? []
          : [];
        return message.content || !paths.length
          ? message
          : { ...message, content: generatedImageContent(paths[0]) };
      });
  }
  enqueueChatMessage(chatId: string, text: string): Message {
    this.chat(chatId);
    const message: Message = {
      id: randomUUID(), chatId, role: 'user', text, status: 'complete', itemId: null,
      createdAt: now(), turnId: null, phase: null, source: 'text', dispatchStatus: 'queued'
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO messages(
        id,chatId,role,text,status,itemId,createdAt,turnId,phase,source,dispatchStatus)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(message.id, chatId, 'user', text, 'complete', null, message.createdAt, null, null, 'text', 'queued');
      this.db.prepare(`INSERT INTO chat_message_queue(messageId,chatId,status,createdAt,updatedAt)
        VALUES(?,?, 'queued', ?, ?)`)
        .run(message.id, chatId, message.createdAt, message.createdAt);
      this.db.prepare('UPDATE chats SET updatedAt=?,title=CASE WHEN title=\'新对话\' THEN ? ELSE title END WHERE id=?')
        .run(message.createdAt, text.slice(0, 40), chatId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return message;
  }
  queuedChatMessages(chatId?: string): Message[] {
    const rows = (chatId
      ? this.db.prepare(`SELECT m.*,q.status AS dispatchStatus,q.error AS dispatchError FROM chat_message_queue q
          JOIN messages m ON m.id=q.messageId WHERE q.chatId=? AND q.status='queued' ORDER BY q.createdAt,q.rowid`).all(chatId)
      : this.db.prepare(`SELECT m.*,q.status AS dispatchStatus,q.error AS dispatchError FROM chat_message_queue q
          JOIN messages m ON m.id=q.messageId WHERE q.status='queued' ORDER BY q.createdAt,q.rowid`).all()) as Row[];
    return rows.map(messageFrom);
  }
  queuedChatMessageChats(): string[] {
    return (this.db.prepare("SELECT DISTINCT chatId FROM chat_message_queue WHERE status='queued'").all() as Row[])
      .map(row => String(row.chatId));
  }
  setQueuedChatMessageStatus(
    messageId: string,
    status: TurnDispatchStatus,
    error: string | null = null
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE chat_message_queue SET status=?,error=?,updatedAt=? WHERE messageId=?')
        .run(status, error, now(), messageId);
      this.db.prepare('UPDATE messages SET dispatchStatus=?,dispatchError=? WHERE id=?')
        .run(status, error, messageId);
      this.db.exec('COMMIT');
    } catch (failure) {
      this.db.exec('ROLLBACK');
      throw failure;
    }
  }
  setMessageDispatchStatus(messageId: string, status: TurnDispatchStatus, error: string | null = null): void {
    this.db.prepare('UPDATE messages SET dispatchStatus=?,dispatchError=? WHERE id=?')
      .run(status, error, messageId);
  }
  private generatedImagePathsByTurn(chatId: string): Map<string, string[]> {
    const threadId = this.chat(chatId).threadId;
    const pathsByTurn = new Map<string, string[]>();
    if (!threadId) return pathsByTurn;
    const rows = this.db.prepare(`SELECT turnId,detail FROM turn_activities
      WHERE chatId=? AND kind='image' AND status='complete' AND turnId IS NOT NULL ORDER BY rowid`)
      .all(chatId) as Row[];
    for (const row of rows) {
      const turnId = String(row.turnId);
      const paths = generatedImagePaths(String(row.detail ?? ''), threadId);
      if (!paths.length) continue;
      const current = pathsByTurn.get(turnId) ?? [];
      pathsByTurn.set(turnId, [...current, ...paths.filter(path => !current.includes(path))]);
    }
    return pathsByTurn;
  }
  generatedImagePathsForMessage(messageId: string): string[] {
    const row = this.db.prepare(`SELECT chatId,turnId FROM messages WHERE id=? AND role='assistant'
      UNION ALL
      SELECT sessions.chatId,messages.turnId FROM group_messages AS messages
      JOIN group_chat_sessions AS sessions ON sessions.groupChatId=messages.groupId
        AND sessions.botId=messages.senderBotId AND sessions.purpose='member'
      WHERE messages.id=? AND messages.role='assistant'
      LIMIT 1`).get(messageId, messageId) as Row | undefined;
    if (typeof row?.chatId !== 'string' || typeof row.turnId !== 'string') return [];
    return this.generatedImagePathsByTurn(row.chatId).get(row.turnId) ?? [];
  }
  attachGeneratedImageToTurn(chatId: string, turnId: string): Message | null {
    const paths = this.generatedImagePathsByTurn(chatId).get(turnId) ?? [];
    if (!paths.length) return null;
    const rows = this.db.prepare(`SELECT * FROM messages
      WHERE chatId=? AND turnId=? AND role='assistant' ORDER BY rowid DESC`).all(chatId, turnId) as Row[];
    const row = rows.find(candidate => typeof candidate.contentJson !== 'string' ||
      isGeneratedImageContent(messageFrom(candidate).content, paths));
    if (!row) return null;
    const existing = messageFrom(row);
    if (isGeneratedImageContent(existing.content, paths)) return existing;
    const content = generatedImageContent(paths[0]);
    const serialized = JSON.stringify(content);
    this.db.prepare('UPDATE messages SET contentJson=? WHERE id=?').run(serialized, existing.id);
    this.db.prepare('UPDATE chats SET updatedAt=? WHERE id=?').run(now(), chatId);
    return { ...existing, content };
  }
  attachGeneratedImageToGroupTurn(groupId: string, botId: string, chatId: string, turnId: string): GroupMessage | null {
    const paths = this.generatedImagePathsByTurn(chatId).get(turnId) ?? [];
    if (!paths.length) return null;
    const rows = this.db.prepare(`SELECT * FROM group_messages
      WHERE groupId=? AND senderBotId=? AND turnId=? AND role='assistant' ORDER BY rowid DESC`)
      .all(groupId, botId, turnId) as Row[];
    const row = rows.find(candidate => typeof candidate.contentJson !== 'string' ||
      isGeneratedImageContent(groupMessageFrom(candidate).content, paths));
    if (!row) return null;
    const existing = groupMessageFrom(row);
    if (isGeneratedImageContent(existing.content, paths)) return existing;
    const content = generatedImageContent(paths[0]);
    const serialized = JSON.stringify(content);
    this.db.prepare('UPDATE group_messages SET contentJson=? WHERE id=?').run(serialized, existing.id);
    this.db.prepare('UPDATE group_chats SET updatedAt=? WHERE id=?').run(now(), groupId);
    return { ...existing, content };
  }
  activities(chatId: string): TurnActivity[] {
    this.chat(chatId);
    return (this.db.prepare('SELECT * FROM turn_activities WHERE chatId=? ORDER BY createdAt, rowid').all(chatId) as Row[])
      .map(activityFrom);
  }
  addMessage(
    chatId: string,
    role: Message['role'],
    text: string,
    status: MessageStatus = 'complete',
    itemId: string | null = null,
    turnId: string | null = null,
    phase: Message['phase'] = null,
    content: MessageContent | null = null,
    source: Message['source'] = 'text'
  ): Message {
    this.chat(chatId);
    const message: Message = {
      id: randomUUID(), chatId, role, text, status, itemId, createdAt: now(), turnId, phase, source, content
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO messages(id,chatId,role,text,status,itemId,createdAt,turnId,phase,contentJson,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(message.id, chatId, role, text, status, itemId, message.createdAt, turnId, phase,
          content ? JSON.stringify(content) : null, source);
      this.db.prepare('UPDATE chats SET updatedAt=? WHERE id=?').run(message.createdAt, chatId);
      if (role === 'user') this.db.prepare("UPDATE chats SET title=? WHERE id=? AND title='新对话'").run(text.slice(0, 40), chatId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return message;
  }
  pendingAnswerTarget(chatId: string): MessageAnswerTarget | null {
    const message = this.messages(chatId).reverse().find(candidate =>
      candidate.role === 'assistant' &&
      (candidate.content?.kind === 'question' && candidate.content.state === 'pending' ||
        candidate.content?.kind === 'card' && candidate.content.state === 'pending')
    );
    if (!message) return null;
    return { scope: 'chat', chatId, message, content: message.content as QuestionMessageContent | ResultCardMessageContent };
  }
  pendingGroupAnswerTarget(groupId: string): MessageAnswerTarget | null {
    const message = this.groupMessages(groupId).reverse().find(candidate =>
      candidate.role === 'assistant' && typeof candidate.senderBotId === 'string' &&
      (candidate.content?.kind === 'question' && candidate.content.state === 'pending' ||
        candidate.content?.kind === 'card' && candidate.content.state === 'pending')
    );
    if (!message?.senderBotId) return null;
    return {
      scope: 'group', groupId, botId: message.senderBotId, message,
      content: message.content as QuestionMessageContent | ResultCardMessageContent
    };
  }
  answerTarget(messageId: string): MessageAnswerTarget | null {
    const chatRow = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as Row | undefined;
    if (chatRow) {
      const message = messageFrom(chatRow);
      if (message.role !== 'assistant' ||
          !(message.content?.kind === 'question' && message.content.state === 'pending' ||
            message.content?.kind === 'card' && message.content.state === 'pending')) return null;
      return { scope: 'chat', chatId: message.chatId, message, content: message.content };
    }
    const groupRow = this.db.prepare('SELECT * FROM group_messages WHERE id=?').get(messageId) as Row | undefined;
    if (!groupRow) return null;
    const message = groupMessageFrom(groupRow);
    if (message.role !== 'assistant' || !message.senderBotId ||
        !(message.content?.kind === 'question' && message.content.state === 'pending' ||
          message.content?.kind === 'card' && message.content.state === 'pending')) return null;
    return { scope: 'group', groupId: message.groupId, botId: message.senderBotId, message, content: message.content };
  }
  messageAssetBotId(messageId: string): string | null {
    const row = this.db.prepare(`SELECT c.botId AS botId FROM messages m
      JOIN chats c ON c.id=m.chatId WHERE m.id=? AND m.role='assistant'
      UNION ALL
      SELECT senderBotId AS botId FROM group_messages WHERE id=? AND role='assistant' AND senderBotId IS NOT NULL
      LIMIT 1`).get(messageId, messageId) as Row | undefined;
    return typeof row?.botId === 'string' ? row.botId : null;
  }
  saveAnsweredContent(messageId: string, content: QuestionMessageContent | ResultCardMessageContent): MessageAnswerTarget {
    const serialized = JSON.stringify(content);
    const chatRow = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as Row | undefined;
    if (chatRow) {
      this.db.prepare('UPDATE messages SET contentJson=? WHERE id=?').run(serialized, messageId);
      const message = messageFrom({ ...chatRow, contentJson: serialized });
      return { scope: 'chat', chatId: message.chatId, message, content };
    }
    const groupRow = this.db.prepare('SELECT * FROM group_messages WHERE id=?').get(messageId) as Row | undefined;
    if (!groupRow) throw new Error('卡片不存在');
    this.db.prepare('UPDATE group_messages SET contentJson=? WHERE id=?').run(serialized, messageId);
    const message = groupMessageFrom({ ...groupRow, contentJson: serialized });
    if (!message.senderBotId) throw new Error('卡片所属 Bot 已不可用');
    return { scope: 'group', groupId: message.groupId, botId: message.senderBotId, message, content };
  }
  beginTurn(chatId: string, text: string, input: {
    threadId: string; requestedModel: string | null; modelSource: TurnModelSource;
    permissionSnapshot: TurnPermissionSnapshot; threadModelObservation?: ThreadModelObservation | null;
    promptVisible?: boolean; userMessageId?: string | null;
  }): { message: Message; turn: TurnRecord } {
    this.chat(chatId);
    const existingMessage = input.userMessageId
      ? this.db.prepare('SELECT * FROM messages WHERE id=? AND chatId=?').get(input.userMessageId, chatId) as Row | undefined
      : undefined;
    if (input.userMessageId && (!existingMessage || existingMessage.role !== 'user')) {
      throw new Error('待派发消息不存在或不属于当前聊天');
    }
    const message: Message = existingMessage
      ? { ...messageFrom(existingMessage), dispatchStatus: 'dispatching', dispatchError: null }
      : {
          id: randomUUID(), chatId, role: 'user', text, status: 'complete', itemId: null, createdAt: now(),
          turnId: null, phase: null, source: 'text', dispatchStatus: 'dispatching'
        };
    const id = randomUUID();
    const threadModel = input.threadModelObservation;
    const turn: TurnRecord = {
      id, turnId: null, threadId: input.threadId, chatId,
      userMessageId: input.promptVisible === false ? null : message.id,
      dispatchStatus: 'dispatching', dispatchError: null,
      requestedModel: input.requestedModel, modelSource: input.modelSource,
      threadModelAtRequest: threadModel?.model ?? null,
      threadModelProviderAtRequest: threadModel?.provider ?? null,
      threadModelSource: threadModel?.source ?? 'unknown',
      threadModelObservedAt: threadModel?.observedAt ?? null,
      serverResolvedModel: null, serverResolvedProvider: null, resolutionSource: 'unknown', reroutes: [],
      permissionSnapshot: input.permissionSnapshot, status: 'starting', startedAt: now(), completedAt: null
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.promptVisible !== false) {
        if (existingMessage) {
          this.db.prepare("UPDATE messages SET dispatchStatus='dispatching',dispatchError=NULL WHERE id=?")
            .run(message.id);
          this.db.prepare("UPDATE chat_message_queue SET status='dispatching',error=NULL,updatedAt=? WHERE messageId=? AND status='queued'")
            .run(now(), message.id);
        } else {
          this.db.prepare(`INSERT INTO messages(
            id,chatId,role,text,status,itemId,createdAt,turnId,phase,source,dispatchStatus)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
            .run(message.id, chatId, 'user', text, 'complete', null, message.createdAt, null, null, 'text', 'dispatching');
        }
        this.db.prepare('UPDATE chats SET updatedAt=? WHERE id=?').run(message.createdAt, chatId);
        this.db.prepare("UPDATE chats SET title=? WHERE id=? AND title='新对话'").run(text.slice(0, 40), chatId);
      }
      this.db.prepare(`INSERT INTO turns(id,turnId,threadId,chatId,userMessageId,dispatchStatus,dispatchError,requestedModel,modelSource,
        threadModelAtRequest,threadModelProviderAtRequest,threadModelSource,threadModelObservedAt,
        serverResolvedModel,serverResolvedProvider,resolutionSource,reroutes,permissionSnapshot,status,startedAt,completedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        turn.id, null, turn.threadId, turn.chatId, turn.userMessageId, turn.dispatchStatus, turn.dispatchError,
        turn.requestedModel, turn.modelSource,
        turn.threadModelAtRequest, turn.threadModelProviderAtRequest, turn.threadModelSource, turn.threadModelObservedAt,
        null, null, turn.resolutionSource, '[]', JSON.stringify(turn.permissionSnapshot), turn.status, turn.startedAt, null
      );
      this.db.exec('COMMIT');
      return { message, turn };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveThreadModelObservation(chatId: string, threadId: string, model: string | null, provider: string | null, source: ThreadModelSource): ThreadModelObservation {
    this.chat(chatId);
    const observation: ThreadModelObservation = { threadId, model, provider, source, observedAt: now() };
    this.db.prepare(`INSERT INTO thread_model_observations(threadId,chatId,model,provider,source,observedAt)
      VALUES(?,?,?,?,?,?) ON CONFLICT(threadId) DO UPDATE SET chatId=excluded.chatId,model=excluded.model,
      provider=excluded.provider,source=excluded.source,observedAt=excluded.observedAt`)
      .run(threadId, chatId, model, provider, source, observation.observedAt);
    return observation;
  }
  threadModelObservation(threadId: string): ThreadModelObservation | null {
    const row = this.db.prepare('SELECT threadId,model,provider,source,observedAt FROM thread_model_observations WHERE threadId=?').get(threadId) as Row | undefined;
    if (!row) return null;
    return {
      threadId: String(row.threadId), model: typeof row.model === 'string' ? row.model : null,
      provider: typeof row.provider === 'string' ? row.provider : null,
      source: row.source as ThreadModelSource, observedAt: String(row.observedAt)
    };
  }
  turns(chatId: string): TurnRecord[] {
    this.chat(chatId);
    const rows = this.db.prepare('SELECT * FROM turns WHERE chatId=? ORDER BY startedAt,rowid').all(chatId) as Row[];
    return rows.map(row => {
      const reroutes = JSON.parse(String(row.reroutes)) as TurnReroute[];
      return turnFrom(row, reroutes);
    });
  }
  unresolvedTurns(): TurnRecord[] {
    const rows = this.db.prepare("SELECT * FROM turns WHERE status IN ('starting','running','unknown') ORDER BY startedAt,rowid").all() as Row[];
    return rows.map(row => turnFrom(row, JSON.parse(String(row.reroutes)) as TurnReroute[]));
  }
  turn(id: string): TurnRecord | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    return turnFrom(row, JSON.parse(String(row.reroutes)) as TurnReroute[]);
  }
  turnByServerId(threadId: string, turnId: string): TurnRecord | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE threadId=? AND turnId=? ORDER BY startedAt DESC LIMIT 1').get(threadId, turnId) as Row | undefined;
    if (!row) return null;
    return turnFrom(row, JSON.parse(String(row.reroutes)) as TurnReroute[]);
  }
  attachTurnId(id: string, threadId: string, turnId: string, status?: 'running' | 'unknown' | 'completed' | 'failed' | 'interrupted'): void {
    const row = this.db.prepare('SELECT status,threadId FROM turns WHERE id=?').get(id) as Row | undefined;
    if (!row || row.threadId !== threadId) return;
    const current = row.status as TurnStatus;
    if (status && isTerminalTurnStatus(current)) {
      this.db.prepare('UPDATE turns SET turnId=? WHERE id=? AND turnId IS NULL').run(turnId, id);
      return;
    }
    let nextStatus = current;
    let completedAt: string | null = null;
    if (status === 'running' && (current === 'starting' || current === 'unknown')) nextStatus = 'running';
    else if (status === 'unknown' && (current === 'starting' || current === 'running')) nextStatus = 'unknown';
    else if (status && isTerminalTurnStatus(status) && !isTerminalTurnStatus(current)) {
      nextStatus = status;
      completedAt = now();
    }
    this.db.prepare('UPDATE turns SET turnId=COALESCE(turnId,?),status=?,completedAt=COALESCE(completedAt,?) WHERE id=?')
      .run(turnId, nextStatus, completedAt, id);
  }
  setTurnStatus(id: string, status: TurnStatus): void {
    const row = this.db.prepare('SELECT status FROM turns WHERE id=?').get(id) as Row | undefined;
    if (!row) return;
    const current = row.status as TurnStatus;
    if (isTerminalTurnStatus(current)) return;
    const completedAt = isTerminalTurnStatus(status) ? now() : null;
    this.db.prepare('UPDATE turns SET status=?,completedAt=COALESCE(?,completedAt) WHERE id=?').run(status, completedAt, id);
  }
  setTurnDispatchStatus(id: string, status: TurnDispatchStatus, error: string | null = null): void {
    const turn = this.db.prepare('SELECT userMessageId FROM turns WHERE id=?').get(id) as Row | undefined;
    if (!turn) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE turns SET dispatchStatus=?,dispatchError=? WHERE id=?').run(status, error, id);
      if (typeof turn.userMessageId === 'string') {
        this.db.prepare('UPDATE messages SET dispatchStatus=?,dispatchError=? WHERE id=?')
          .run(status, error, turn.userMessageId);
        this.db.prepare('UPDATE chat_message_queue SET status=?,error=?,updatedAt=? WHERE messageId=?')
          .run(status, error, now(), turn.userMessageId);
      }
      this.db.exec('COMMIT');
    } catch (failure) {
      this.db.exec('ROLLBACK');
      throw failure;
    }
  }
  addTurnReroute(id: string, reroute: TurnReroute): void {
    const row = this.db.prepare('SELECT reroutes FROM turns WHERE id=?').get(id) as Row | undefined;
    if (!row) return;
    const reroutes = JSON.parse(String(row.reroutes)) as TurnReroute[];
    if (reroutes.some(value => value.fromModel === reroute.fromModel && value.toModel === reroute.toModel && value.reason === reroute.reason)) return;
    reroutes.push(reroute);
    this.db.prepare(`UPDATE turns SET reroutes=?,serverResolvedModel=?,resolutionSource='modelRerouted' WHERE id=?`)
      .run(JSON.stringify(reroutes), reroute.toModel, id);
  }
  markUnknownTurnOperation(input: UnknownTurnOperation): void {
    this.db.prepare(`INSERT INTO unknown_turn_operations(chatId,threadId,operationId,operation,turnId,startedAt)
      VALUES(?,?,?,?,?,?) ON CONFLICT(chatId) DO UPDATE SET threadId=excluded.threadId,
      operationId=excluded.operationId,operation=excluded.operation,turnId=excluded.turnId,startedAt=excluded.startedAt`)
      .run(input.chatId, input.threadId, input.operationId, input.operation, input.turnId, input.startedAt);
  }
  unknownTurnOperations(): UnknownTurnOperation[] {
    return this.db.prepare('SELECT chatId,threadId,operationId,operation,turnId,startedAt FROM unknown_turn_operations')
      .all() as unknown as UnknownTurnOperation[];
  }
  clearUnknownTurnOperation(chatId: string, operationId?: string): void {
    if (operationId) this.db.prepare('DELETE FROM unknown_turn_operations WHERE chatId=? AND operationId=?').run(chatId, operationId);
    else this.db.prepare('DELETE FROM unknown_turn_operations WHERE chatId=?').run(chatId);
  }
  assistantItem(
    chatId: string,
    itemId: string,
    text: string,
    append: boolean,
    status: MessageStatus,
    turnId: string | null = null,
    phase: Message['phase'] = null
  ): Message {
    let existingRow: Row | undefined;
    if (turnId) {
      const rows = this.db.prepare("SELECT * FROM messages WHERE chatId=? AND turnId=? AND role='assistant' ORDER BY rowid DESC")
        .all(chatId, turnId) as Row[];
      existingRow = rows.find(row => typeof row.contentJson !== 'string');
      if (!existingRow) {
        const generatedPaths = this.generatedImagePathsByTurn(chatId).get(turnId) ?? [];
        existingRow = rows.find(row => isGeneratedImageContent(messageFrom(row).content, generatedPaths));
      }
    } else {
      existingRow = this.db.prepare("SELECT * FROM messages WHERE chatId=? AND itemId=? AND role='assistant'")
        .get(chatId, itemId) as Row | undefined;
    }
    if (!existingRow) return this.addMessage(chatId, 'assistant', text, status, itemId, turnId, phase);
    const existing = messageFrom(existingRow);
    const value = append && existing.itemId === itemId ? existing.text + text : text;
    this.db.prepare('UPDATE messages SET text=?,status=?,itemId=?,turnId=COALESCE(?,turnId),phase=? WHERE id=?')
      .run(value, status, itemId, turnId, phase, existing.id);
    return {
      ...existing,
      text: value,
      status,
      itemId,
      turnId: turnId ?? existing.turnId,
      phase
    };
  }
  voiceItem(
    chatId: string,
    itemId: string,
    role: 'user' | 'assistant',
    text: string,
    append: boolean,
    status: MessageStatus
  ): Message {
    const existingRow = this.db.prepare(
      "SELECT * FROM messages WHERE chatId=? AND itemId=? AND role=? AND source='voice' ORDER BY rowid DESC LIMIT 1"
    ).get(chatId, itemId, role) as Row | undefined;
    if (!existingRow) return this.addMessage(chatId, role, text, status, itemId, null, null, null, 'voice');
    const existing = messageFrom(existingRow);
    const value = append ? existing.text + text : text;
    this.db.prepare("UPDATE messages SET text=?,status=? WHERE id=? AND source='voice'")
      .run(value, status, existing.id);
    this.db.prepare('UPDATE chats SET updatedAt=? WHERE id=?').run(now(), chatId);
    return { ...existing, text: value, status };
  }
  removeVoiceAssistantItems(chatId: string): Message[] {
    const rows = this.db.prepare(
      "SELECT * FROM messages WHERE chatId=? AND role='assistant' AND source='voice'"
    ).all(chatId) as Row[];
    if (!rows.length) return [];
    this.db.prepare("DELETE FROM messages WHERE chatId=? AND role='assistant' AND source='voice'").run(chatId);
    return rows.map(messageFrom);
  }
  removeLastVoiceAssistantItem(chatId: string): Message | null {
    const row = this.db.prepare(
      "SELECT * FROM messages WHERE chatId=? AND role='assistant' AND source='voice' ORDER BY rowid DESC LIMIT 1"
    ).get(chatId) as Row | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM messages WHERE id=?').run(String(row.id));
    return messageFrom(row);
  }
  removeVoiceItem(chatId: string, itemId: string, role: 'user' | 'assistant'): Message | null {
    const row = this.db.prepare(
      "SELECT * FROM messages WHERE chatId=? AND itemId=? AND role=? AND source='voice' ORDER BY rowid DESC LIMIT 1"
    ).get(chatId, itemId, role) as Row | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM messages WHERE id=? AND source='voice'").run(String(row.id));
    return messageFrom(row);
  }
  activity(input: {
    chatId: string;
    turnId: string | null;
    itemId: string;
    kind: ActivityKind;
    status: ActivityStatus;
    title: string;
    detail?: string;
    appendDetail?: boolean;
  }): TurnActivity {
    this.chat(input.chatId);
    const timestamp = now();
    const existingRow = this.db.prepare('SELECT * FROM turn_activities WHERE chatId=? AND itemId=?')
      .get(input.chatId, input.itemId) as Row | undefined;
    if (!existingRow) {
      const activity: TurnActivity = {
        id: randomUUID(),
        chatId: input.chatId,
        turnId: input.turnId,
        itemId: input.itemId,
        kind: input.kind,
        status: input.status,
        title: input.title,
        detail: input.detail ?? '',
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.db.prepare(`INSERT INTO turn_activities(id,chatId,turnId,itemId,kind,status,title,detail,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        activity.id, activity.chatId, activity.turnId, activity.itemId, activity.kind,
        activity.status, activity.title, activity.detail, activity.createdAt, activity.updatedAt
      );
      return activity;
    }
    const existing = activityFrom(existingRow);
    const detail = input.appendDetail
      ? existing.detail + (input.detail ?? '')
      : input.detail ?? existing.detail;
    const activity: TurnActivity = {
      ...existing,
      turnId: input.turnId ?? existing.turnId,
      kind: input.kind,
      status: input.status,
      title: input.title || existing.title,
      detail,
      updatedAt: timestamp
    };
    this.db.prepare('UPDATE turn_activities SET turnId=?,kind=?,status=?,title=?,detail=?,updatedAt=? WHERE id=?')
      .run(activity.turnId, activity.kind, activity.status, activity.title, activity.detail, activity.updatedAt, activity.id);
    return activity;
  }
  finishMessages(chatId: string, status: MessageStatus): Message[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE chatId=? AND role='assistant' AND status='streaming'")
      .all(chatId) as Row[];
    this.db.prepare("UPDATE messages SET status=? WHERE chatId=? AND status='streaming'").run(status, chatId);
    return rows.map(row => messageFrom({ ...row, status }));
  }
  search(query: string, botId?: string | null): Array<{ message: Message; chat: Chat; bot: Bot }> {
    if (!query.trim()) return [];
    if (botId) this.bot(botId);
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const sql = `SELECT messages.* FROM messages
      JOIN chats ON chats.id=messages.chatId
      JOIN bots ON bots.id=chats.botId
      WHERE chats.groupChatId IS NULL AND chats.archived=0 AND chats.routineRunId IS NULL
        AND messages.text LIKE ? ESCAPE '\\' AND bots.archived=0${botId ? ' AND chats.botId=?' : ''}
      ORDER BY messages.createdAt DESC LIMIT 100`;
    const args = botId ? [`%${escaped}%`, botId] : [`%${escaped}%`];
    const messages = (this.db.prepare(sql).all(...args) as Row[]).map(messageFrom);
    return messages.map(message => { const chat = this.chat(message.chatId); return { message, chat, bot: this.bot(chat.botId) }; });
  }
  settings(): Record<string, string> {
    const persisted = Object.fromEntries(this.db.prepare('SELECT key,value FROM settings').all()
      .map(r => [String(r.key), String(r.value)]));
    return { globalPermission: 'fullAccess', ...persisted };
  }
  setSetting(key: string, value: string): void { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  setExecutionDefaultModel(model: string): void {
    const normalized = model.trim();
    if (!normalized) throw new Error('新建 Bot 的模型不能为空');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setSetting('defaultBotModel', normalized);
      this.setSetting('modelInitializationError', '');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }
  setExecutionDefaults(input: { model: string; permission: PermissionMode }): void {
    const model = input.model.trim();
    if (!model) throw new Error('新建 Bot 的模型不能为空');
    if (!permissionModes.has(input.permission)) throw new Error('无效的全局权限模式');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.setSetting('defaultBotModel', model);
      this.setSetting('defaultBotPermission', input.permission);
      this.setSetting('modelInitializationError', '');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }
  memories(botId: string | null): Memory[] {
    return this.db.prepare('SELECT * FROM memories WHERE botId IS ? ORDER BY createdAt').all(botId)
      .map(r => ({ ...r, approved: true })) as unknown as Memory[];
  }
  saveMemory(input: { id?: string; botId: string | null; text: string; approved?: boolean; sourceCallId?: string }): Memory {
    if (input.botId) this.bot(input.botId);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text || text.length > 20_000) throw new Error('记忆内容须为 1–20000 个字符');
    const sourceCallId = input.sourceCallId?.trim() || null;
    if (sourceCallId && sourceCallId.length > 200) throw new Error('无效的记忆保存请求标识');
    if (sourceCallId) {
      const previous = this.db.prepare('SELECT id,botId,text FROM memories WHERE sourceCallId=?').get(sourceCallId) as Row | undefined;
      if (previous) {
        if ((previous.botId ?? null) !== input.botId || String(previous.text) !== text || (input.id && previous.id !== input.id)) {
          throw new Error('记忆保存请求标识冲突');
        }
        return this.memories(input.botId).find(memory => memory.id === previous.id)!;
      }
    }
    const id = input.id ?? randomUUID();
    const existing = this.db.prepare('SELECT botId FROM memories WHERE id=?').get(id) as Row | undefined;
    if (existing && (existing.botId ?? null) !== input.botId) throw new Error('不能修改其他 Bot 的专属记忆');
    this.db.prepare(`INSERT INTO memories(id,botId,text,approved,createdAt,sourceCallId) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text,approved=1,createdAt=excluded.createdAt,
        sourceCallId=COALESCE(excluded.sourceCallId,memories.sourceCallId)
      WHERE memories.botId IS excluded.botId`)
      .run(id, input.botId, text, 1, now(), sourceCallId);
    return this.memories(input.botId).find(memory => memory.id === id)!;
  }
  deleteMemory(id: string): void { this.db.prepare('DELETE FROM memories WHERE id=?').run(id); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
