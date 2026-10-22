import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ActivityKind, ActivityStatus, Bot, Chat, GroupChat, GroupMessage, Memory, Message, MessageStatus, PermissionMode, RoutineListItem,
  RoutineDefinition, RoutineRun, RoutineRunStatus, ThreadModelSource, TurnModelSource,
  TurnActivity, TurnPermissionSnapshot, TurnRecord, TurnReroute, TurnStatus
} from '../shared/contracts';
import { followingRun, parseRoutineSchedule } from './routine-schedule';

const now = () => new Date().toISOString();
type Row = Record<string, unknown>;
const permissionModes = new Set<PermissionMode>(['fullAccess', 'workspaceWrite', 'readOnly']);
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
const botFrom = (r: Row): Bot => ({ ...r, archived: !!r.archived }) as unknown as Bot;
const chatFrom = (r: Row): Chat => ({
  ...r,
  archived: !!r.archived,
  routineRunId: typeof r.routineRunId === 'string' ? r.routineRunId : null
}) as unknown as Chat;
const messageFrom = (row: Row): Message => ({
  id: String(row.id),
  chatId: String(row.chatId),
  role: row.role as Message['role'],
  text: String(row.text),
  status: row.status as MessageStatus,
  itemId: typeof row.itemId === 'string' ? row.itemId : null,
  createdAt: String(row.createdAt),
  turnId: typeof row.turnId === 'string' ? row.turnId : null,
  phase: row.phase === 'commentary' || row.phase === 'partial_answer' || row.phase === 'final_answer'
    ? row.phase
    : null
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
  return {
    id: String(row.id), routineId: String(row.routineId), botId: String(row.botId),
    routineTitle: String(row.routineTitle), instruction: String(row.instruction),
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
    createdAt: String(row.createdAt)
  };
}

function turnFrom(r: Row, reroutes: TurnReroute[] = []): TurnRecord {
  return {
    id: String(r.id), turnId: typeof r.turnId === 'string' ? r.turnId : null,
    threadId: String(r.threadId), chatId: String(r.chatId),
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
        archived INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        title TEXT NOT NULL, threadId TEXT, groupChatId TEXT REFERENCES group_chats(id) ON DELETE CASCADE,
        archived INTEGER NOT NULL DEFAULT 0, routineToolsEnabled INTEGER NOT NULL DEFAULT 0,
        memoryToolsEnabled INTEGER NOT NULL DEFAULT 0, routineRunId TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_chats (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        defaultBotId TEXT REFERENCES bots(id) ON DELETE RESTRICT,
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
        senderName TEXT, text TEXT NOT NULL, status TEXT NOT NULL, itemId TEXT, createdAt TEXT NOT NULL);
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
        scheduledFor TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        chatId TEXT,
        sourceChatId TEXT,
        turnId TEXT,
        summary TEXT,
        error TEXT,
        process TEXT,
        startedAt TEXT,
        completedAt TEXT,
        createdAt TEXT NOT NULL,
        dedupeKey TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS routine_runs_routine ON routine_runs(routineId,createdAt DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, itemId TEXT, createdAt TEXT NOT NULL,
        turnId TEXT, phase TEXT);
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
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, turnId TEXT, threadId TEXT NOT NULL,
        chatId TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
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
    if (schemaVersion > 16) throw new Error('本机数据库版本高于当前应用支持版本');
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
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
          INSERT INTO group_chats_v8(id,title,defaultBotId,createdAt,updatedAt)
            SELECT id,title,defaultBotId,createdAt,updatedAt FROM group_chats;
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
    this.db.exec(`UPDATE routine_runs SET sourceChatId=chatId,chatId=NULL
      WHERE sourceChatId IS NULL AND chatId IS NOT NULL`);
    const chatColumns = this.db.prepare('PRAGMA table_info(chats)').all() as Row[];
    if (!chatColumns.some(column => column.name === 'groupChatId')) this.db.exec('ALTER TABLE chats ADD COLUMN groupChatId TEXT REFERENCES group_chats(id) ON DELETE CASCADE');
    if (!chatColumns.some(column => column.name === 'model')) this.db.exec('ALTER TABLE chats ADD COLUMN model TEXT');
    if (!chatColumns.some(column => column.name === 'permission')) this.db.exec('ALTER TABLE chats ADD COLUMN permission TEXT');
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
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as Row[];
    if (!messageColumns.some(column => column.name === 'turnId')) this.db.exec('ALTER TABLE messages ADD COLUMN turnId TEXT');
    if (!messageColumns.some(column => column.name === 'phase')) this.db.exec('ALTER TABLE messages ADD COLUMN phase TEXT');
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
      CREATE INDEX IF NOT EXISTS turn_activities_chat ON turn_activities(chatId, createdAt);`);
    this.db.prepare("UPDATE messages SET status='interrupted' WHERE status='streaming'").run();
    this.db.prepare("UPDATE group_messages SET status='interrupted' WHERE status='streaming'").run();
    this.db.prepare("UPDATE turns SET status='unknown' WHERE status IN ('starting','running')").run();
    this.db.exec('PRAGMA user_version=16');
  }
  bots(): Bot[] { return (this.db.prepare('SELECT * FROM bots ORDER BY createdAt').all() as Row[]).map(botFrom); }
  bot(id: string): Bot {
    const r = this.db.prepare('SELECT * FROM bots WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('机器人不存在');
    return botFrom(r);
  }
  chats(): Chat[] { return (this.db.prepare('SELECT * FROM chats WHERE groupChatId IS NULL AND archived=0 AND routineRunId IS NULL ORDER BY updatedAt DESC').all() as Row[]).map(chatFrom); }
  allChats(): Chat[] { return (this.db.prepare('SELECT * FROM chats WHERE archived=0 ORDER BY updatedAt DESC').all() as Row[]).map(chatFrom); }
  botChats(botId: string): Chat[] { return (this.db.prepare('SELECT * FROM chats WHERE botId=? ORDER BY updatedAt DESC').all(botId) as Row[]).map(chatFrom); }
  groups(): GroupChat[] {
    const rows = this.db.prepare('SELECT id FROM group_chats ORDER BY updatedAt DESC, createdAt DESC').all() as Row[];
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
        kind: definition.kind === 'once' ? 'once' : 'recurring',
        frequency: definition.frequency as RoutineDefinition['frequency'] | null | undefined,
        weekday: typeof definition.weekday === 'number' ? definition.weekday : null,
        dayOfMonth: typeof definition.dayOfMonth === 'number' ? definition.dayOfMonth : null,
        runDate: typeof definition.runAt === 'string' ? definition.runAt.slice(0, 10) : null,
        timezone: typeof definition.timezone === 'string' ? definition.timezone : 'Asia/Shanghai'
      });
    } catch { /* legacy rows keep a readable empty definition */ }
    const typedDefinition: RoutineDefinition = {
      instruction: typeof definition.instruction === 'string' ? definition.instruction : '',
      schedule,
      kind: definition.kind === 'once' ? 'once' : 'recurring',
      timezone: typeof definition.timezone === 'string' ? definition.timezone : 'Asia/Shanghai',
      frequency: (definition.frequency as RoutineDefinition['frequency'] | null | undefined) ?? inferred?.frequency ?? null,
      weekday: typeof definition.weekday === 'number' ? definition.weekday : inferred?.weekday ?? null,
      dayOfMonth: typeof definition.dayOfMonth === 'number' ? definition.dayOfMonth : inferred?.dayOfMonth ?? null,
      time: typeof definition.time === 'string' ? definition.time : inferred?.time ?? '09:00',
      runAt: typeof definition.runAt === 'string' ? definition.runAt : inferred?.runAt ?? null,
      catchUp: definition.catchUp !== false,
      rememberLastResult: definition.rememberLastResult === true,
      successNotification: definition.successNotification === true
    };
    const latestRunRow = this.db.prepare('SELECT * FROM routine_runs WHERE routineId=? ORDER BY createdAt DESC LIMIT 1')
      .get(String(row.id)) as Row | undefined;
    return {
      id: String(row.id), title: String(row.title), botId: String(row.botId),
      sourceChatId: typeof row.sourceChatId === 'string' ? row.sourceChatId : this.ensureBotChat(String(row.botId)).id,
      definition: typedDefinition,
      status: row.status as RoutineListItem['status'],
      nextRunAt: row.nextRunAt === null
        ? null
        : typeof row.nextRunAt === 'string'
          ? row.nextRunAt
          : typedDefinition.runAt,
      lastRun: latestRunRow ? routineRunFrom(latestRunRow) : null,
      createdAt: String(row.createdAt), updatedAt: String(row.updatedAt)
    };
  }
  routines(): RoutineListItem[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY updatedAt DESC,createdAt DESC').all() as Row[])
      .map(row => this.routineFrom(row));
  }
  routine(id: string): RoutineListItem {
    const row = this.db.prepare('SELECT * FROM routines WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('定时任务不存在');
    return this.routineFrom(row);
  }
  createRoutine(input: {
    botId: string; title: string; instruction: string; schedule: string; sourceCallId: string;
    kind?: RoutineDefinition['kind']; time?: string; runDate?: string | null; frequency?: RoutineDefinition['frequency'];
    weekday?: number | null; dayOfMonth?: number | null; catchUp?: boolean;
    rememberLastResult?: boolean; successNotification?: boolean; now?: Date;
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

    const triggerTime = input.time ?? (schedule.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0] ?? '09:00');
    const sourceChatId = this.ensureBotChat(bot.id).id;
    const parsed = parseRoutineSchedule({
      schedule, triggerTime, kind: input.kind, frequency: input.frequency ?? null,
      weekday: input.weekday ?? null, dayOfMonth: input.dayOfMonth ?? null,
      runDate: input.runDate ?? null, catchUp: input.catchUp,
      rememberLastResult: input.rememberLastResult, successNotification: input.successNotification,
      now: input.now
    });
    const definition: RoutineDefinition = {
      instruction, schedule, kind: parsed.kind, timezone: parsed.timezone,
      frequency: parsed.frequency, weekday: parsed.weekday, dayOfMonth: parsed.dayOfMonth,
      time: parsed.time, runAt: parsed.runAt, catchUp: parsed.catchUp,
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
    title?: string; instruction?: string; schedule?: string; time?: string;
    catchUp?: boolean; rememberLastResult?: boolean; successNotification?: boolean; now?: Date;
  }): RoutineListItem {
    const routine = this.routine(id);
    const title = patch.title === undefined ? routine.title : patch.title.trim();
    const instruction = patch.instruction === undefined ? routine.definition.instruction : patch.instruction.trim();
    const schedule = patch.schedule === undefined ? routine.definition.schedule : patch.schedule.trim();
    if (!title || title.length > 120) throw new Error('任务名称须为 1–120 个字符');
    if (!instruction || instruction.length > 20_000) throw new Error('任务指令不能为空或超过长度限制');
    if (!schedule || schedule.length > 1_000) throw new Error('周期表达不能为空或超过长度限制');
    const time = patch.time === undefined ? routine.definition.time : patch.time.trim();
    if (title === routine.title && instruction === routine.definition.instruction &&
        schedule === routine.definition.schedule && time === routine.definition.time &&
        patch.catchUp === undefined && patch.rememberLastResult === undefined &&
        patch.successNotification === undefined) return routine;
    const parsed = parseRoutineSchedule({
      schedule, triggerTime: time, kind: routine.definition.kind,
      frequency: routine.definition.frequency, weekday: routine.definition.weekday,
      dayOfMonth: routine.definition.dayOfMonth,
      runDate: routine.definition.runAt?.slice(0, 10) ?? null,
      catchUp: patch.catchUp ?? routine.definition.catchUp,
      rememberLastResult: patch.rememberLastResult ?? routine.definition.rememberLastResult,
      successNotification: patch.successNotification ?? routine.definition.successNotification,
      now: patch.now
    });
    const definition: RoutineDefinition = {
      instruction, schedule, kind: parsed.kind, timezone: parsed.timezone,
      frequency: parsed.frequency, weekday: parsed.weekday, dayOfMonth: parsed.dayOfMonth,
      time: parsed.time, runAt: routine.definition.kind === 'once' ? routine.definition.runAt : parsed.runAt,
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
    if (routine.status !== status) {
      this.db.prepare('UPDATE routines SET status=?,updatedAt=? WHERE id=?').run(status, now(), id);
    }
    return this.routine(id);
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
      scheduledFor: input.scheduledFor, status: input.status ?? 'pending',
      trigger: input.trigger, chatId: null, sourceChatId: routine.sourceChatId, turnId: null, summary: null,
      error: null, process: input.process ?? null, startedAt: null,
      completedAt: null, createdAt: date
    };
    this.db.prepare(`INSERT INTO routine_runs(
      id,routineId,botId,routineTitle,instruction,scheduledFor,status,trigger,chatId,turnId,
      sourceChatId,summary,error,process,startedAt,completedAt,createdAt,dedupeKey)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      run.id, run.routineId, run.botId, run.routineTitle, run.instruction,
      run.scheduledFor, run.status, run.trigger, null, null, run.sourceChatId, null, null,
      run.process, null, null, run.createdAt, input.dedupeKey ?? null
    );
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
    'status' | 'chatId' | 'sourceChatId' | 'turnId' | 'summary' | 'error' | 'process' | 'startedAt' | 'completedAt'>>): RoutineRun {
    const row = this.db.prepare('SELECT * FROM routine_runs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('Routine 运行记录不存在');
    const merged = { ...routineRunFrom(row), ...patch };
    this.db.prepare(`UPDATE routine_runs SET status=?,chatId=?,sourceChatId=?,turnId=?,summary=?,error=?,process=?,startedAt=?,completedAt=?
      WHERE id=?`).run(merged.status, merged.chatId, merged.sourceChatId, merged.turnId, merged.summary, merged.error,
      merged.process, merged.startedAt, merged.completedAt, id);
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO bots(id,name,avatar,createdAt) VALUES(?,?,?,?)').run(id, name, avatar, now());
      const chat = this.ensureBotChat(id);
      this.db.exec('COMMIT');
      return { bot: this.bot(id), chat };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  updateBot(id: string, patch: Record<string, unknown>): Bot {
    this.bot(id);
    const columns = new Set(['name', 'avatar', 'role', 'instructions', 'model', 'permission']);
    for (const [key, value] of Object.entries(patch)) {
      if (!columns.has(key)) throw new Error('不支持的机器人字段');
      this.db.prepare(`UPDATE bots SET ${key}=? WHERE id=?`).run(typeof value === 'boolean' ? Number(value) : value as string | null, id);
    }
    return this.bot(id);
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
  groupMessages(groupId: string): GroupMessage[] {
    this.group(groupId);
    return this.db.prepare('SELECT id,groupId,role,senderBotId,senderName,text,status,itemId,createdAt FROM group_messages WHERE groupId=? ORDER BY createdAt,rowid')
      .all(groupId) as unknown as GroupMessage[];
  }
  addGroupMessage(groupId: string, role: GroupMessage['role'], text: string, options: {
    senderBot?: Bot | null; senderName?: string | null; status?: MessageStatus; itemId?: string | null;
  } = {}): GroupMessage {
    this.group(groupId);
    if (options.senderBot && !this.group(groupId).memberIds.includes(options.senderBot.id)) throw new Error('回复 Bot 不属于此群聊');
    const message: GroupMessage = {
      id: randomUUID(), groupId, role, senderBotId: options.senderBot?.id ?? null,
      senderName: options.senderBot?.name ?? options.senderName ?? null, text,
      status: options.status ?? 'complete', itemId: options.itemId ?? null, createdAt: now()
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO group_messages(id,groupId,role,senderBotId,senderName,text,status,itemId,createdAt) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(message.id, groupId, role, message.senderBotId, message.senderName, text, message.status, message.itemId, message.createdAt);
      this.db.prepare('UPDATE group_chats SET updatedAt=? WHERE id=?').run(message.createdAt, groupId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return message;
  }
  groupAssistantItem(groupId: string, botId: string, itemId: string, text: string, append: boolean, status: MessageStatus): GroupMessage {
    const bot = this.bot(botId);
    const existing = this.db.prepare("SELECT * FROM group_messages WHERE groupId=? AND senderBotId=? AND itemId=? AND role='assistant'")
      .get(groupId, botId, itemId) as unknown as GroupMessage | undefined;
    if (!existing) return this.addGroupMessage(groupId, 'assistant', text, { senderBot: bot, status, itemId });
    const value = append ? existing.text + text : text;
    this.db.prepare('UPDATE group_messages SET text=?,status=? WHERE id=?').run(value, status, existing.id);
    return { ...existing, text: value, status };
  }
  finishGroupMessages(groupId: string, botId: string, status: MessageStatus): void {
    this.db.prepare("UPDATE group_messages SET status=? WHERE groupId=? AND senderBotId=? AND role='assistant' AND status='streaming'")
      .run(status, groupId, botId);
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
  applyBotPermissionToChats(botId: string, permission: PermissionMode): void {
    this.bot(botId);
    if (!permissionModes.has(permission)) throw new Error('无效的权限模式');
    const updatedAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE bots SET permission=? WHERE id=?').run(permission, botId);
      this.db.prepare('UPDATE chats SET permission=?,updatedAt=? WHERE botId=?').run(permission, updatedAt, botId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  bindThread(id: string, threadId: string, routineToolsEnabled = false, memoryToolsEnabled = false): void {
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
    return (this.db.prepare('SELECT * FROM messages WHERE chatId=? ORDER BY createdAt, rowid').all(chatId) as Row[])
      .map(messageFrom);
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
    phase: Message['phase'] = null
  ): Message {
    this.chat(chatId);
    const message: Message = {
      id: randomUUID(), chatId, role, text, status, itemId, createdAt: now(), turnId, phase
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO messages(id,chatId,role,text,status,itemId,createdAt,turnId,phase) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(message.id, chatId, role, text, status, itemId, message.createdAt, turnId, phase);
      this.db.prepare('UPDATE chats SET updatedAt=? WHERE id=?').run(message.createdAt, chatId);
      if (role === 'user') this.db.prepare("UPDATE chats SET title=? WHERE id=? AND title='新对话'").run(text.slice(0, 40), chatId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return message;
  }
  beginTurn(chatId: string, text: string, input: {
    threadId: string; requestedModel: string | null; modelSource: TurnModelSource;
    permissionSnapshot: TurnPermissionSnapshot; threadModelObservation?: ThreadModelObservation | null;
  }): { message: Message; turn: TurnRecord } {
    this.chat(chatId);
    const message: Message = {
      id: randomUUID(), chatId, role: 'user', text, status: 'complete', itemId: null, createdAt: now(),
      turnId: null, phase: null
    };
    const id = randomUUID();
    const threadModel = input.threadModelObservation;
    const turn: TurnRecord = {
      id, turnId: null, threadId: input.threadId, chatId,
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
      this.db.prepare('INSERT INTO messages(id,chatId,role,text,status,itemId,createdAt,turnId,phase) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(message.id, chatId, 'user', text, 'complete', null, message.createdAt, null, null);
      this.db.prepare('UPDATE chats SET updatedAt=? WHERE id=?').run(message.createdAt, chatId);
      this.db.prepare("UPDATE chats SET title=? WHERE id=? AND title='新对话'").run(text.slice(0, 40), chatId);
      this.db.prepare(`INSERT INTO turns(id,turnId,threadId,chatId,requestedModel,modelSource,
        threadModelAtRequest,threadModelProviderAtRequest,threadModelSource,threadModelObservedAt,
        serverResolvedModel,serverResolvedProvider,resolutionSource,reroutes,permissionSnapshot,status,startedAt,completedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        turn.id, null, turn.threadId, turn.chatId, turn.requestedModel, turn.modelSource,
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
    const existingRow = this.db.prepare("SELECT * FROM messages WHERE chatId=? AND itemId=? AND role='assistant'")
      .get(chatId, itemId) as Row | undefined;
    if (!existingRow) return this.addMessage(chatId, 'assistant', text, status, itemId, turnId, phase);
    const existing = messageFrom(existingRow);
    const value = append ? existing.text + text : text;
    this.db.prepare('UPDATE messages SET text=?,status=?,turnId=COALESCE(?,turnId),phase=COALESCE(?,phase) WHERE id=?')
      .run(value, status, turnId, phase, existing.id);
    return {
      ...existing,
      text: value,
      status,
      turnId: turnId ?? existing.turnId,
      phase: phase ?? existing.phase
    };
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
  finishMessages(chatId: string, status: MessageStatus): void {
    this.db.prepare("UPDATE messages SET status=? WHERE chatId=? AND status='streaming'").run(status, chatId);
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
  settings(): Record<string, string> { return Object.fromEntries(this.db.prepare('SELECT key,value FROM settings').all().map(r => [String(r.key), String(r.value)])); }
  setSetting(key: string, value: string): void { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
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
