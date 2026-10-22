import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  ActivityKind, ActivityStatus, AppEvent, AccountState, Bot, GroupMessage, ModelOption, Message,
  PermissionMode, Snapshot, TurnActivity, TurnModelSource, TurnPermissionSnapshot, TurnRecord,
  TurnStatus, VoiceSessionState
} from '../shared/contracts';
import type { CodexRuntime } from './runtime';
import { Store, type UnknownTurnOperation } from './store';
import { createRoutineDispatcher, RoutineScheduler } from './routine-scheduler';

type TrackedUnknownOperation = UnknownTurnOperation & { awaitingLateResponse: boolean };
type GroupResponseMode = 'judge' | 'directed' | 'everyone';
type GroupSessionBinding = { groupId: string; botId: string; purpose: 'member'; mode?: GroupResponseMode };
const GROUP_CONTEXT_MESSAGE_LIMIT = 40;
const GROUP_CONTEXT_CHAR_LIMIT = 12_000;
const GROUP_HISTORY_TOOL_NAMESPACE = 'rambo_group_history';
const GROUP_HISTORY_DEFAULT_LIMIT = 30;
const GROUP_HISTORY_MAX_LIMIT = 100;
const NO_GROUP_REPLY_TOKEN = '[[RAMBO_NO_GROUP_REPLY]]';
const ROUTINE_TOOL_NAMESPACE = 'rambo_routines';
const GROUP_HISTORY_TOOL = {
  type: 'namespace',
  name: GROUP_HISTORY_TOOL_NAMESPACE,
  description: '只读查询当前群聊的既有共享消息，用于按需查找首次上下文之外更早的记录。不能读取任何 Bot 私聊或其他群聊。',
  tools: [{
    type: 'function',
    name: 'read_history',
    description: '当用户要求回顾当前群聊更早的记录，而当前提供的最新群上下文不足时调用。可用 query 过滤当前群消息；结果只属于当前群。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选关键字；省略时返回最近的群消息。' },
        before: { type: 'string', description: '可选消息 ID；只返回该消息之前的记录。' },
        limit: { type: 'integer', minimum: 1, maximum: GROUP_HISTORY_MAX_LIMIT, description: '最多返回多少条，默认 30。' }
      },
      additionalProperties: false
    }
  }]
};
const CREATE_ROUTINE_TOOL = {
  type: 'function',
  name: 'create_routine',
  description: '当对话明确表达用户希望未来重复执行某项工作时调用，即使用户没有直接说“创建定时任务”。仅当任务内容、周期和一天内的明确触发时刻都已从对话确定后调用；缺少触发时刻时先询问用户，收到答复前不得调用本工具。不要推断或默认补时间，不要把一次性请求、随口提到的时间或 Bot 自己想到的自动化建议当作创建授权。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务名称。' },
      instruction: { type: 'string', description: '每次周期任务要执行的用户指令原文或忠实整理。' },
      schedule: { type: 'string', description: '从当前对话可确定的重复频率或周期，例如“每周一”；不要包含或推断一天中的时刻。' },
      triggerTime: {
        type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
        description: '用户在对话中明确给出的一天内触发时刻，24 小时制 HH:mm。缺失或不明确时先追问，禁止推断或使用默认时间。'
      },
      kind: {
        type: 'string', enum: ['recurring', 'once'],
        description: '未来重复执行使用 recurring；只执行一次的明确日期提醒使用 once。'
      },
      runDate: {
        type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'kind=once 时用户明确给出的本地日期 YYYY-MM-DD；周期任务省略。'
      },
      catchUp: {
        type: 'boolean',
        description: '错过窗口内的触发是否在启动或唤醒后补跑一次，默认 true。'
      }
    },
    required: ['title', 'instruction', 'schedule', 'triggerTime', 'kind'],
    additionalProperties: false
  }
};
const MEMORY_TOOL_NAMESPACE = 'rambo_memories';
const BOT_SELF_TOOL_NAMESPACE = 'rambo_bot';
const VOICE_TOOL_NAMESPACE = 'rambo_voice';
const VOICE_EVENT_CHANNEL = 'oai-events';
const VOICE_TOOL = {
  type: 'namespace',
  name: VOICE_TOOL_NAMESPACE,
  description: '管理当前 Bot 唯一私聊里的 Codex Live 语音会话。',
  tools: [{
    type: 'function',
    name: 'end_current_voice_session',
    description: '当用户明确要求结束当前语音通话、退出 Live 或关闭语音时调用。只结束语音媒体会话，不中断正在执行的普通任务。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }]
};
const VOICE_START_INSTRUCTIONS = [
  '这是 Rambo 中当前 Bot 唯一私聊的 Codex Live 语音会话，沿用该私聊 thread。',
  '请直接进行自然、简短的实时中文语音对话。用户插话时立即停止当前语音输出并响应。',
  '当用户明确表达结束语音、退出 Live 或关闭语音时，不要只口头告别。把结束请求交给当前 thread 的普通 Codex，并调用 rambo_voice.end_current_voice_session。',
  '结束语音不等于中断普通任务；若结束请求被拒绝或没有成功结果，如实告知用户。'
].join('\n');
const VOICE_END_INSTRUCTIONS = '在结束前简短确认通话结束；随后由宿主释放麦克风与媒体连接。';
const VOICE_PROMPT = [
  '你是当前 Rambo Bot 私聊中的 Codex Live 语音助手。',
  '用户明确要求结束语音、退出 Live 或关闭语音时，先说一句简短自然的中文结束语，然后把结束请求委派给当前 thread 的普通 Codex，由它调用 rambo_voice.end_current_voice_session。',
  '不要只口头假装挂断，也不要因为结束语音而中断独立运行的普通任务。'
].join('\n');
const MEMORY_MANAGEMENT_TOOL = {
  type: 'namespace',
  name: MEMORY_TOOL_NAMESPACE,
  description: 'Bot 自动整理、保存、编辑和删除长期记忆，不需要用户逐项批准。共享资料与 Bot 私有记忆严格区分。',
  tools: [{
    type: 'function',
    name: 'save_memory',
    description: '用户明确要求记住或修订时立即保存；日常交流告一段落后，稳定且有后续价值的内容由 Bot 自动整理保存。稳定且跨 Bot 适用的用户偏好或个人资料，即使先在一个 Bot 私聊中听到，也必须用 scope=aboutMe；只适用于当前 Bot 的事实用 scope=bot。scope 省略时仍默认为 bot。只有收到本工具 success=true 的成功结果后才能告诉用户已保存；调用失败、没有成功结果或没有调用工具时不得声称已保存。只操作当前 Bot 专属记忆或共用“关于我”，绝不读取或修改其他 Bot 的专属记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '更新现有记忆时使用已提供的记忆 ID；新增时省略。' },
        scope: { type: 'string', enum: ['bot', 'aboutMe'], description: '稳定且跨 Bot 适用的用户偏好或个人资料用 aboutMe；仅当前 Bot 适用的事实用 bot。省略时默认 bot。' },
        text: { type: 'string', description: '一条简洁、可长期使用的记忆内容。' }
      },
      required: ['text'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'delete_memory',
    description: '删除当前 Bot 自己的一条专属长期记忆。不能删除共用“关于我”或其他 Bot 的记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的当前 Bot 私有记忆 ID。' }
      },
      required: ['id'],
      additionalProperties: false
    }
  }]
};

const BOT_PROFILE_TOOL = {
  type: 'namespace',
  name: BOT_SELF_TOOL_NAMESPACE,
  description: '当前 Bot 管理自身的资料和运行配置。所有写入只作用于当前 Bot，无需用户逐次批准。不能操作其他 Bot、共享配置或应用级资源，也不能归档、删除自身或清空聊天。',
  tools: [{
    type: 'function',
    name: 'update_profile',
    description: '修改当前 Bot 自己的名称、头像、短职责或长期指令。用户明确要求，或你根据对话确认需要更新时直接调用；不要处理其他 Bot。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '新的 Bot 名称；省略表示不修改。' },
        avatar: { type: 'string', description: '新的头像标识或受支持的数据 URI；省略表示不修改。' },
        role: { type: 'string', description: '当前 Bot 的短职责；省略表示不修改。' },
        instructions: { type: 'string', description: '当前 Bot 的完整长期指令；省略表示不修改。' }
      },
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'update_config',
    description: '修改当前 Bot 自己的默认模型、默认权限，或自身唯一私聊的模型/权限覆盖。传 null 表示继承。只影响后续轮次。',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: ['string', 'null'], description: '新的 Bot 默认模型；null 表示继承全局。' },
        permission: { type: 'string', enum: ['fullAccess', 'workspaceWrite', 'readOnly'], description: '新的 Bot 默认权限。' },
        chatModel: { type: ['string', 'null'], description: '当前唯一私聊的模型覆盖；null 表示继承 Bot。' },
        chatPermission: { type: ['string', 'null'], enum: ['fullAccess', 'workspaceWrite', 'readOnly', null], description: '当前唯一私聊的权限覆盖；null 表示继承 Bot。' },
        applyPermissionToChats: { type: 'boolean', description: '修改默认权限时是否同时应用到该 Bot 已有会话。' }
      },
      additionalProperties: false
    }
  }]
};

const ROUTINE_MANAGEMENT_TOOL = {
  type: 'namespace',
  name: ROUTINE_TOOL_NAMESPACE,
  description: '当前 Bot 创建、修改、暂停、恢复或删除自己管理的 Routine。不能操作其他 Bot 的 Routine；删除定义时按 R14 保留过往运行历史。',
  tools: [CREATE_ROUTINE_TOOL, {
    type: 'function',
    name: 'update_routine',
    description: '修改当前 Bot 自己 Routine 的名称或执行定义。修改仅影响后续新触发的任务。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要修改的 Routine ID。' },
        title: { type: 'string' },
        instruction: { type: 'string' },
        schedule: { type: 'string' },
        triggerTime: {
          type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
          description: '可选的新的一日内触发时刻。'
        },
        catchUp: { type: 'boolean' },
        rememberLastResult: { type: 'boolean' },
        successNotification: { type: 'boolean' }
      },
      required: ['id'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'set_routine_status',
    description: '暂停或恢复当前 Bot 自己的一条 Routine。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused'] }
      },
      required: ['id', 'status'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'delete_routine',
    description: '删除当前 Bot 自己的一条 Routine 定义，保留该 Routine 的既有运行历史、聊天简报和成果。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  }]
};

function objectMap(): Record<string, any> { return Object.create(null) as Record<string, any>; }

function routineToolText(text: string) {
  return { contentItems: [{ type: 'inputText', text }], success: true };
}

function routineToolFailure(text: string) {
  return { contentItems: [{ type: 'inputText', text }], success: false };
}

type VoiceSession = {
  chatId: string;
  threadId: string;
  realtimeSessionId: string | null;
  state: VoiceSessionState['state'];
  error: string | null;
  offerSdp: string;
};

function voiceToolText(text: string) {
  return { contentItems: [{ type: 'inputText', text }], success: true };
}

function voiceToolFailure(text: string) {
  return { contentItems: [{ type: 'inputText', text }], success: false };
}

function recentGroupContext(messages: GroupMessage[]): string {
  const recent = messages.slice(-GROUP_CONTEXT_MESSAGE_LIMIT);
  const lines = recent.map(message =>
    `${message.role === 'user' ? '用户' : message.role === 'system' ? '系统' : message.senderName ?? 'Bot'}：${message.text}`
  );
  let latestUserIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (recent[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }

  const selected: number[] = [];
  let chars = 0;
  if (latestUserIndex >= 0) {
    selected.push(latestUserIndex);
    chars = lines[latestUserIndex].length;
    if (chars > GROUP_CONTEXT_CHAR_LIMIT) return lines[latestUserIndex];
    for (let index = latestUserIndex + 1; index < lines.length; index++) {
      const nextChars = chars + lines[index].length + (selected.length ? 1 : 0);
      if (nextChars > GROUP_CONTEXT_CHAR_LIMIT) break;
      selected.push(index);
      chars = nextChars;
    }
    for (let index = latestUserIndex - 1; index >= 0; index--) {
      const nextChars = chars + lines[index].length + (selected.length ? 1 : 0);
      if (nextChars > GROUP_CONTEXT_CHAR_LIMIT) break;
      selected.unshift(index);
      chars = nextChars;
    }
  } else {
    for (let index = lines.length - 1; index >= 0; index--) {
      const nextChars = chars + lines[index].length + (selected.length ? 1 : 0);
      if (nextChars > GROUP_CONTEXT_CHAR_LIMIT) break;
      selected.unshift(index);
      chars = nextChars;
    }
  }
  return selected.map(index => lines[index]).join('\n');
}

function groupHistoryText(messages: GroupMessage[]): string {
  if (!messages.length) return '当前群聊没有符合条件的更早记录。';
  return messages.map(message =>
    `[${message.id}] ${message.role === 'user'
      ? '用户'
      : message.role === 'system'
        ? '系统'
        : message.senderName ?? 'Bot'}：${message.text}`
  ).join('\n');
}

function hasUnknownOutcome(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'outcomeUnknown' in error &&
    (error as { outcomeUnknown?: unknown }).outcomeUnknown === true;
}

function isGroupNoReply(text: string): boolean {
  return text.trim() === NO_GROUP_REPLY_TOKEN;
}

function toUnixSeconds(iso: string): number { return Math.floor(Date.parse(iso) / 1000); }

function turnStartedAt(turn: any): number | null {
  return typeof turn?.startedAt === 'number' && Number.isFinite(turn.startedAt) ? turn.startedAt : null;
}

function serverStartMatches(operation: UnknownTurnOperation, turn: any): boolean {
  if (operation.operation === 'turnSteer') return operation.turnId === turn?.id;
  const eventStart = turnStartedAt(turn);
  if (eventStart === null) return false;
  return eventStart >= toUnixSeconds(operation.startedAt) - 2;
}

function isTerminalTurnStatus(status: TurnStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function activityStatus(status: unknown): ActivityStatus {
  if (status === 'inProgress') return 'running';
  if (status === 'completed') return 'complete';
  if (status === 'failed') return 'failed';
  if (status === 'declined') return 'declined';
  return 'unknown';
}

function agentMessagePhase(item: any): Message['phase'] {
  return item?.phase === 'commentary' || item?.phase === 'partial_answer' || item?.phase === 'final_answer'
    ? item.phase
    : null;
}

function stringifyActivityDetail(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function activityFromItem(item: any): {
  kind: ActivityKind;
  status: ActivityStatus;
  title: string;
  detail: string;
} | null {
  if (!item || typeof item.id !== 'string') return null;
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.join('\n') : '';
    const content = Array.isArray(item.content) ? item.content.join('\n') : '';
    return {
      kind: 'reasoning',
      status: 'complete',
      title: '思考过程',
      detail: summary || content
    };
  }
  if (item.type === 'commandExecution') {
    return {
      kind: 'command',
      status: activityStatus(item.status),
      title: typeof item.command === 'string' && item.command.trim() ? item.command : '运行命令',
      detail: [
        typeof item.cwd === 'string' ? `目录：${item.cwd}` : '',
        typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
        item.exitCode !== undefined && item.exitCode !== null ? `退出码：${item.exitCode}` : ''
      ].filter(Boolean).join('\n')
    };
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes)
      ? item.changes.map((change: any) => {
        const path = typeof change?.path === 'string' ? change.path : typeof change?.file === 'string' ? change.file : '';
        const diff = typeof change?.diff === 'string' ? change.diff : '';
        return [path, diff].filter(Boolean).join('\n');
      }).filter(Boolean).join('\n\n')
      : '';
    return {
      kind: 'file',
      status: activityStatus(item.status),
      title: '文件更改',
      detail: changes
    };
  }
  if (item.type === 'webSearch') {
    return {
      kind: 'web',
      status: 'complete',
      title: typeof item.query === 'string' && item.query.trim() ? `搜索：${item.query}` : '搜索网页',
      detail: stringifyActivityDetail(item.results)
    };
  }
  if (item.type === 'mcpToolCall') {
    return {
      kind: 'mcp',
      status: activityStatus(item.status),
      title: `${item.server ?? 'MCP'} · ${item.tool ?? '工具'}`,
      detail: [stringifyActivityDetail(item.arguments), stringifyActivityDetail(item.result), stringifyActivityDetail(item.error)]
        .filter(Boolean).join('\n\n')
    };
  }
  if (item.type === 'dynamicToolCall') {
    return {
      kind: 'tool',
      status: activityStatus(item.status),
      title: `${item.namespace ? `${item.namespace} · ` : ''}${item.tool ?? '工具'}`,
      detail: [stringifyActivityDetail(item.arguments), stringifyActivityDetail(item.contentItems)]
        .filter(Boolean).join('\n\n')
    };
  }
  if (item.type === 'plan') {
    return { kind: 'plan', status: 'complete', title: '计划', detail: typeof item.text === 'string' ? item.text : '' };
  }
  if (item.type === 'imageGeneration') {
    return {
      kind: 'image',
      status: item.status === 'failed' ? 'failed' : item.status === 'inProgress' ? 'running' : 'complete',
      title: '生成图片',
      detail: [item.revisedPrompt, item.savedPath, item.failure?.message].filter(value => typeof value === 'string').join('\n')
    };
  }
  if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
    return {
      kind: 'collab',
      status: activityStatus(item.status),
      title: item.type === 'subAgentActivity' ? '子 Agent 活动' : `协作 · ${item.tool ?? '委派'}`,
      detail: [item.prompt, stringifyActivityDetail(item.agentsStates)].filter(Boolean).join('\n\n')
    };
  }
  if (item.type === 'functionCallOutput') {
    return {
      kind: 'other',
      status: 'complete',
      title: `${item.namespace ? `${item.namespace} · ` : ''}${item.name ?? '工具结果'}`,
      detail: stringifyActivityDetail(item.output)
    };
  }
  return null;
}

export class Host {
  readonly activeTurns = new Map<string, string>();
  readonly routineScheduler: RoutineScheduler;
  private busyChats = new Set<string>();
  private loadedThreads = new Set<string>();
  private threadChats = new Map<string, string>();
  private unknownOperations = new Map<string, TrackedUnknownOperation>();
  private completedTurns = new Map<string, Set<string>>();
  private turnAssistantTexts = new Map<string, string>();
  private itemTurns = new Map<string, string>();
  private pendingTurnRecords = new Map<string, string>();
  private groupSessionsByChat = new Map<string, GroupSessionBinding>();
  private busyGroups = new Set<string>();
  private voiceSessions = new Map<string, VoiceSession>();
  private voiceStartWaiters = new Map<string, {
    resolve: (value: { chatId: string; threadId: string }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(readonly store: Store, readonly runtime: CodexRuntime, private publish: (event: AppEvent) => void) {
    this.routineScheduler = new RoutineScheduler(store, publish);
    this.routineScheduler.setDispatcher(createRoutineDispatcher(this, this.routineScheduler));
    for (const chat of store.allChats()) if (chat.threadId) this.threadChats.set(chat.threadId, chat.id);
    for (const session of store.groupSessions()) {
      if (session.purpose === 'member') this.groupSessionsByChat.set(session.chatId, {
        groupId: session.groupId, botId: session.botId, purpose: 'member'
      });
    }
    for (const operation of store.unknownTurnOperations()) {
      this.unknownOperations.set(operation.chatId, { ...operation, awaitingLateResponse: false });
    }
    for (const turn of store.unresolvedTurns()) {
      if (this.unknownOperations.has(turn.chatId)) continue;
      const operation: TrackedUnknownOperation = {
        chatId: turn.chatId, threadId: turn.threadId, operationId: turn.id,
        operation: 'turnStart', turnId: turn.turnId, startedAt: turn.startedAt,
        awaitingLateResponse: false
      };
      store.markUnknownTurnOperation(operation);
      this.unknownOperations.set(turn.chatId, operation);
    }
    runtime.on('state', state => {
      if (state.status !== 'ready') {
        this.loadedThreads.clear();
        for (const session of this.voiceSessions.values()) {
          this.publish({
            type: 'voiceState',
            session: {
              chatId: session.chatId,
              state: 'error',
              realtimeSessionId: session.realtimeSessionId,
              error: state.error ?? 'Codex 运行时已停止'
            }
          });
          this.publish({ type: 'voiceEndRequested', chatId: session.chatId, reason: 'Codex 运行时已停止' });
        }
        this.voiceSessions.clear();
    this.itemTurns.clear();
        for (const waiter of this.voiceStartWaiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('Codex 运行时已停止'));
        }
        this.voiceStartWaiters.clear();
        for (const operation of this.unknownOperations.values()) operation.awaitingLateResponse = false;
        for (const [chatId, turnId] of this.activeTurns) {
          let chat: ReturnType<Store['chat']> | null = null;
          let record: TurnRecord | null = null;
          try {
            chat = store.chat(chatId);
            if (chat.threadId) record = store.turnByServerId(chat.threadId, turnId);
          } catch { /* the chat may have been deleted while the runtime was stopping */ }
          if (record) {
            store.setTurnStatus(record.id, 'unknown');
            if (!this.unknownOperations.has(chatId) && chat?.threadId) {
              const operation: TrackedUnknownOperation = {
                chatId, threadId: chat.threadId, operationId: record.id,
                operation: 'turnStart', turnId, startedAt: record.startedAt, awaitingLateResponse: false
              };
              store.markUnknownTurnOperation(operation);
              this.unknownOperations.set(chatId, operation);
            }
            this.publishTurnMetadata(chatId, turnId);
          }
          try {
            const groupSession = this.groupSessionsByChat.get(chatId);
            if (groupSession?.purpose === 'member') store.finishGroupMessages(groupSession.groupId, groupSession.botId, 'interrupted');
            store.finishMessages(chatId, 'interrupted');
            publish({ type: 'turn', chatId, turnId: null });
          } catch { /* isolate a stale chat from the runtime state listener */ }
        }
        this.activeTurns.clear();
      }
      publish({ type: 'runtime', state });
    });
    runtime.on('notification', (method, params) => {
      try { this.notification(method, params); }
      catch {
        // Notification processing must not propagate into EventEmitter or stop the protocol reader.
        try { this.publish({ type: 'error', message: '处理 Codex 运行时通知失败' }); } catch { /* UI listener failure */ }
      }
    });
    runtime.on('serverRequest', request => {
      if (request?.params?.namespace === BOT_SELF_TOOL_NAMESPACE) void this.handleBotToolCall(request);
      else if (request?.params?.namespace === MEMORY_TOOL_NAMESPACE) void this.handleMemoryToolCall(request);
      else if (request?.params?.namespace === GROUP_HISTORY_TOOL_NAMESPACE) void this.handleGroupHistoryToolCall(request);
      else if (request?.params?.namespace === VOICE_TOOL_NAMESPACE) void this.handleVoiceToolCall(request);
      else void this.handleRoutineToolCall(request);
    });
  }

  snapshot(): Snapshot {
    return {
      bots: this.store.bots(), chats: this.store.chats(), groups: this.store.groups(), routines: this.store.routines(),
      routineRuns: this.store.routineRuns(),
      settings: this.store.settings(), runtime: this.runtime.state, activeTurns: Object.fromEntries(this.activeTurns)
    };
  }
  changed(): void { this.publish({ type: 'changed' }); }

  async submitAcceptanceRoutineTool(request: unknown): Promise<{
    id: string; result: unknown;
  }> {
    return this.submitAcceptanceTool(this.handleRoutineToolCall.bind(this), request);
  }

  async submitAcceptanceBotTool(request: unknown): Promise<{
    id: string; result: unknown;
  }> {
    return this.submitAcceptanceTool(this.handleBotToolCall.bind(this), request);
  }

  async submitAcceptanceMemoryTool(request: unknown): Promise<{
    id: string; result: unknown;
  }> {
    return this.submitAcceptanceTool(this.handleMemoryToolCall.bind(this), request);
  }

  async submitAcceptanceGroupHistoryTool(request: unknown): Promise<{
    id: string; result: unknown;
  }> {
    return this.submitAcceptanceTool(this.handleGroupHistoryToolCall.bind(this), request);
  }

  acceptNotification(method: string, params: unknown): void {
    if (method !== 'item/completed' && method !== 'turn/completed') {
      throw new Error('验收事件只能提交受支持的 App Server 完成通知');
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error('验收 App Server 通知参数格式无效');
    }
    this.notification(method, params);
  }

  async acceptRoutineTick(): Promise<void> {
    await this.routineScheduler.tick();
  }

  private async submitAcceptanceTool(
    handler: (request: any) => Promise<void>,
    request: unknown
  ): Promise<{ id: string; result: unknown }> {
    const id = `acceptance-routine-${randomUUID()}`;
    return new Promise(resolve => {
      const onResponse = (responseId: string | number, result: unknown) => {
        if (responseId !== id) return;
        this.runtime.off('acceptanceResponse', onResponse);
        resolve({ id, result });
      };
      this.runtime.on('acceptanceResponse', onResponse);
      void handler({ ...(request as object), id });
    });
  }

  private publishGroupMessage(message: GroupMessage): void {
    this.publish({ type: 'groupMessage', groupId: message.groupId, message });
  }

  private publishActivity(activity: TurnActivity): void {
    this.publish({ type: 'activity', activity });
  }

  private rememberItemTurn(itemId: string, turnId: unknown): void {
    if (typeof turnId === 'string' && itemId) {
      this.itemTurns.set(itemId, turnId);
      while (this.itemTurns.size > 2_000) {
        this.itemTurns.delete(this.itemTurns.keys().next().value as string);
      }
    }
  }

  private activityFor(
    chatId: string,
    turnId: string | null,
    itemId: string,
    kind: ActivityKind,
    status: ActivityStatus,
    title: string,
    detail = '',
    appendDetail = false
  ): TurnActivity {
    const activity = this.store.activity({ chatId, turnId, itemId, kind, status, title, detail, appendDetail });
    this.publishActivity(activity);
    return activity;
  }

  private registerGroupSession(chatId: string, binding: GroupSessionBinding): void {
    this.groupSessionsByChat.set(chatId, binding);
  }

  async sendGroup(groupId: string, text: string): Promise<void> {
    if (!text.trim() || text.length > 200_000) throw new Error('消息不能为空或超过长度限制');
    if (this.busyGroups.has(groupId)) throw new Error('群聊上一条消息正在处理，请稍后');
    const group = this.store.group(groupId);
    const members = group.memberIds.map(botId => this.store.bot(botId));
    const activeMembers = members.filter(bot => !bot.archived);
    if (!activeMembers.length) throw new Error('请先恢复群聊中的至少一个 Bot');
    this.busyGroups.add(groupId);
    try {
      this.publishGroupMessage(this.store.addGroupMessage(groupId, 'user', text));
      const everyone = /(?:^|\s)@everyone(?:$|\s)/iu.test(text);
      if (everyone) {
        await Promise.allSettled(activeMembers.map(bot => this.respondInGroup(groupId, bot, text, 'everyone')));
        return;
      }
      const namedMember = [...members].sort((a, b) => b.name.length - a.name.length).find(bot => {
        const marker = `@${bot.name}`;
        const start = text.indexOf(marker);
        if (start < 0) return false;
        if (start > 0 && !/\s/u.test(text[start - 1])) return false;
        const following = text[start + marker.length];
        return following === undefined || /[\s,，:：]/u.test(following);
      });
      if (namedMember) {
        if (namedMember.archived) {
          this.publishGroupMessage(this.store.addGroupMessage(groupId, 'system', `「${namedMember.name}」已归档，请先恢复后再点名。`, { status: 'failed' }));
          return;
        }
        await this.respondInGroup(groupId, namedMember, text, 'directed');
        return;
      }
      await Promise.allSettled(activeMembers.map(bot => this.respondInGroup(groupId, bot, text, 'judge')));
    } finally {
      this.busyGroups.delete(groupId);
    }
  }

  private async respondInGroup(groupId: string, bot: Bot, rawText: string, mode: GroupResponseMode): Promise<void> {
    try {
      const session = this.store.groupSession(groupId, bot.id);
      this.registerGroupSession(session.id, { groupId, botId: bot.id, purpose: 'member', mode });
      const transcript = recentGroupContext(this.store.groupMessages(groupId));
      const prompt = [
        '以下是当前群聊的共享消息记录。它只包含本群消息，不包含任何 Bot 的私聊内容。',
        transcript,
        mode === 'judge'
          ? `请独立判断这条普通消息是否与你的职责和群聊内容相关。合适时以你自己的 Bot 身份直接回复；没有有用补充时只输出 ${NO_GROUP_REPLY_TOKEN}。不要为礼貌而勉强回复，也不要替其他 Bot 分配任务。`
          : mode === 'everyone'
            ? '本轮是 @everyone 全员响应模式。用户要求每个活跃成员都分别发出正式、对用户可见的回复；你已作为其中一个成员被明确分派，必须以自己的 Bot 身份回复。不要判断是否接手后沉默，也不要因主题不属于你的职责而省略回复；如没有专业补充，就简短说明你的角度或限制。不得输出内部不回复标记。'
            : '这是明确发给你的群聊消息，请以你自己的 Bot 身份直接回复。'
      ].join('\n\n');
      await this.sendConversation(session.id, prompt, undefined, mode);
    } catch (error) {
      this.publishGroupMessage(this.store.addGroupMessage(groupId, 'system', `「${bot.name}」未能开始回复：${error instanceof Error ? error.message : String(error)}`, { status: 'failed' }));
    }
  }

  private publishTurnMetadata(chatId: string, turnId: string | null): void {
    this.publish({ type: 'turnMetadata', chatId, turnId });
    this.changed();
  }

  private workspace(bot: Bot): string {
    const path = join(this.store.directory, 'bots', bot.id, 'workspace');
    mkdirSync(path, { recursive: true });
    return path;
  }

  private applicationContext(
    bot: Bot,
    memoryToolsEnabled: boolean,
    includeBotMemory: boolean
  ): Record<string, { kind: 'application'; value: string }> {
    const context: Record<string, { kind: 'application'; value: string }> = {};
    const profile = [
      bot.role.trim() ? `短职责：${bot.role.trim()}` : '',
      bot.instructions.trim() ? `长期指令：\n${bot.instructions.trim()}` : ''
    ].filter(Boolean);
    if (profile.length) {
      context['rambo.bot-profile'] = {
        kind: 'application',
        value: `当前 Bot「${bot.name}」的资料：\n${profile.join('\n\n')}`
      };
    }

    const shared = this.store.memories(null);
    if (shared.length) {
      context['rambo.about-me'] = {
        kind: 'application',
        value: `共用个人资料“关于我”，所有 Bot 都可参考：\n${shared.map(memory => `- [${memory.id}] ${memory.text}`).join('\n')}`
      };
    }

    const privateMemories = includeBotMemory ? this.store.memories(bot.id) : [];
    if (privateMemories.length) {
      context['rambo.bot-memory'] = {
        kind: 'application',
        value: `当前 Bot 的专属长期记忆；不得将其视为其他 Bot 的资料：\n${privateMemories.map(memory => `- [${memory.id}] ${memory.text}`).join('\n')}`
      };
    }

    context['rambo.profile-rules'] = {
      kind: 'application',
      value: memoryToolsEnabled
        ? 'Bot 的短期职责和长期行为规则保存在当前 Bot 资料中，与事实、偏好记忆分开。你可以通过 rambo_bot.update_profile 自主修改自己的名称、头像、短职责和长期指令，无需用户逐次批准。只有在收到工具 success=true 后才能声称已保存；不能操作其他 Bot，也不能归档、永久删除自身或清空聊天。'
        : 'Bot 的短期职责和长期行为规则保存在当前 Bot 资料中，与事实、偏好记忆分开。当前上下文没有自管理写入工具，不要声称已经保存，应引导用户在对应 Bot 设置中完成。'
    };
    return context;
  }

  private instructions(
    bot: Bot,
    routineToolsEnabled: boolean,
    memoryToolsEnabled: boolean,
    groupResponseMode?: GroupResponseMode
  ): string {
    return [
      `你是 Rambo 中名为「${bot.name}」的个人助手。请用中文回复。`,
      '当前 Bot 资料、共用“关于我”和当前 Bot 的专属记忆会在每轮通过应用上下文提供；共用资料所有 Bot 可读，Bot 专属记忆只属于当前 Bot。',
      groupResponseMode === 'judge'
        ? `当前轮次是群聊普通消息的成员独立判断。只有这类判断轮在没有有用补充时才可输出内部标记 ${NO_GROUP_REPLY_TOKEN}；不得把内部标记换成 NO_REPLY 或任何其他正式回复。`
        : groupResponseMode
          ? '当前轮次是群聊中的正式回复。必须给出真实、对用户可见的回复；不得只输出内部不回复标记。'
          : `内部标记 ${NO_GROUP_REPLY_TOKEN} 和 NO_REPLY 仅用于群聊成员的判断场景，不适用于 Bot 私聊。私聊必须真实回答用户；即使当前 Bot 的职责范围有限，也只能简短说明本次无法完成的范围，不能用 NO_REPLY 代替答复。`,
      groupResponseMode
        ? '当前额外提供 rambo_group_history.read_history 只读工具。若用户询问本群更早记录而当前近期消息不足，调用它按需查询；它只能读取当前群，不能读取任何 Bot 私聊或其他群。'
        : '',
      memoryToolsEnabled
        ? '你可以在当前唯一单聊中通过应用工具自主管理自身，不需用户逐次批准：用 rambo_bot.update_profile 修改自己的名称、头像、短职责和长期完整指令；用 rambo_bot.update_config 修改自身默认模型/权限及当前单聊覆盖；用 rambo_memories.save_memory/delete_memory 管理自己的私有记忆；用 rambo_routines 创建、修改、暂停、恢复或删除自己的 Routine。只操作当前 Bot，不能修改其他 Bot、共享配置或应用级资源。绝不自我归档、永久删除自身或清空聊天；这些能力不提供，也不能借其他工具隐式完成。名称/头像变化应反映到所有展示身份；模型/权限从后续轮次生效；只在真实工具成功并回读持久化后声称完成。'
        : '当前上下文没有自管理写入工具；不要声称已修改自身资料、运行配置、记忆或 Routine，应引导用户在对应 Bot 私聊或设置中完成。',
      routineToolsEnabled
        ? '长期记忆和职责变更按各自规则处理。若用户对未来重复执行某项工作的意图可从对话明确判断，即使没说“创建定时任务”，也可自动整理创建；但只有任务内容、重复频率和一天内的具体触发时刻都已从对话明确确定，才调用 rambo_routines.create_routine。用户明确要求某日一次性的日期提醒时可创建 kind=once；一次性普通请求、随口提到的时间不自动转为长期计划。缺少或不明确时先向用户追问；收到明确答复前不得调用创建工具，也不得推断或默认补时间。Bot 自己想到的自动化建议仍先征求用户同意。创建后说明任务名称、计划和执行内容。任务由本机后台服务执行；窗口关闭不影响，Mac 真正睡眠或关机时不保证按时执行。'
        : '没有提供定时任务创建工具时，不要声称已保存周期任务定义。',
      memoryToolsEnabled
        ? '你自行整理并保存长期记忆，不需用户逐项批准。用户明确要求记住或修订时立即保存；日常交流告一段落后，也应把稳定且有后续价值的内容整理保存。稳定且跨 Bot 适用的用户偏好/个人资料应通过 rambo_memories.save_memory 的 scope=aboutMe 保存；只适用于当前 Bot 的事实用 scope=bot。自管理工具的 delete_memory 只作用于当前 Bot 私有记忆，不能删除共享“关于我”或其他 Bot 记忆。只有收到工具 success=true 后才能告诉用户“已保存”或“已删除”；失败、没有结果或没有调用时必须如实说明未完成。'
        : '当前上下文没有长期记忆写入工具；不要声称已保存或删除长期记忆。群聊中的记忆请求请引导用户在对应 Bot 私聊处理。'
    ].filter(Boolean).join('\n\n');
  }

  private async handleRoutineToolCall(request: any): Promise<void> {
    const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    let result = routineToolFailure('无法创建定时任务定义。');
    try {
      if (params.namespace !== ROUTINE_TOOL_NAMESPACE ||
          !['create_routine', 'update_routine', 'set_routine_status', 'delete_routine'].includes(String(params.tool))) {
        throw new Error('此对话不支持该任务工具。');
      }
      if (typeof params.threadId !== 'string' || !params.threadId || typeof params.callId !== 'string' || !params.callId) {
        throw new Error('任务创建请求缺少有效标识。');
      }
      const chatId = this.threadChats.get(params.threadId);
      if (!chatId || this.groupSessionsByChat.has(chatId) || !this.store.chatRoutineToolsEnabled(chatId)) {
        throw new Error('此对话未启用定时任务创建。请在单 Bot 文字聊天中提出请求。');
      }
      const chat = this.store.chat(chatId);
      if (chat.threadId !== params.threadId) throw new Error('任务请求与当前 Bot 会话不匹配。');
      const bot = this.store.bot(chat.botId);
      if (chat.archived || bot.archived) throw new Error('已归档的聊天或 Bot 不能创建定时任务。');

      let args = params.arguments;
      if (typeof args === 'string') args = JSON.parse(args);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('任务参数格式无效。');
      const input = args as Record<string, unknown>;
      if (params.tool === 'create_routine') {
        if (typeof input.title !== 'string' || typeof input.instruction !== 'string' ||
            typeof input.schedule !== 'string' || (input.kind !== 'recurring' && input.kind !== 'once')) {
          throw new Error('请提供任务名称、任务指令和周期表达。');
        }
        const triggerTime = typeof input.triggerTime === 'string' ? input.triggerTime.trim() : '';
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(triggerTime)) {
          throw new Error('缺少明确的一天内触发时刻。请先向用户追问具体时间；收到 HH:mm 格式的明确答复后再创建任务。');
        }
        const routine = this.store.createRoutine({
          botId: bot.id, title: input.title, instruction: input.instruction,
          schedule: `${input.schedule.trim()} ${triggerTime}`, kind: input.kind,
          time: triggerTime,
          runDate: input.kind === 'once' && typeof input.runDate === 'string' ? input.runDate : null,
          catchUp: input.catchUp !== false,
          sourceCallId: `${params.threadId}:${params.callId}`
        });
        result = routineToolText(
          `已创建${routine.definition.kind === 'once' ? '一次性' : '周期'}任务。任务 ID：${routine.id}。` +
          `${routine.nextRunAt ? `下次触发：${routine.nextRunAt}。` : '该一次性时间已经过去，需要手动立即运行。'}` +
          '任务由本机后台执行；窗口关闭不影响，系统睡眠或关机期间不保证准时。'
        );
      } else {
        if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('请提供当前 Bot 的 Routine ID。');
        const routine = this.store.routine(input.id);
        if (routine.botId !== bot.id) throw new Error('只能管理当前 Bot 自己的 Routine。');
        if (params.tool === 'update_routine') {
          const current = this.store.routine(routine.id);
          const updated = this.store.updateRoutine(routine.id, {
            title: input.title as string | undefined,
            instruction: input.instruction as string | undefined,
            schedule: (input.schedule as string | undefined) ?? (
              current.definition.kind === 'once' && input.triggerTime !== undefined ? current.definition.schedule : undefined
            ),
            time: input.triggerTime as string | undefined,
            catchUp: input.catchUp as boolean | undefined,
            rememberLastResult: input.rememberLastResult as boolean | undefined,
            successNotification: input.successNotification as boolean | undefined
          });
          result = routineToolText(`已更新 Routine ${updated.id}；变更只影响后续新触发的任务。`);
        } else if (params.tool === 'set_routine_status') {
          if (input.status !== 'active' && input.status !== 'paused') throw new Error('Routine 状态无效。');
          const updated = this.store.setRoutineStatus(routine.id, input.status);
          if (updated.status === 'paused') {
            this.routineScheduler.stopPending(updated.id, 'Bot 暂停了定时计划');
          }
          result = routineToolText(`Routine ${updated.id} 已${updated.status === 'paused' ? '暂停' : '恢复'}。`);
        } else {
          this.routineScheduler.stopPending(routine.id, 'Bot 删除了定时计划');
          this.store.deleteRoutine(routine.id);
          result = routineToolText(`已删除 Routine 定义 ${routine.id}；既有运行历史、聊天简报和成果仍保留。`);
        }
      }
      this.changed();
    } catch (error) {
      result = routineToolFailure(error instanceof Error ? error.message : '无法创建定时任务定义。');
    }
    try { this.runtime.respondToServerRequest(request.id, result); }
    catch { /* the runtime may have disconnected while the tool request was being handled */ }
  }

  private async handleGroupHistoryToolCall(request: any): Promise<void> {
    const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    let result = routineToolFailure('无法读取群聊历史。');
    try {
      if (params.namespace !== GROUP_HISTORY_TOOL_NAMESPACE || params.tool !== 'read_history') {
        throw new Error('此对话不支持该群聊历史操作。');
      }
      if (typeof params.threadId !== 'string' || !params.threadId || typeof params.callId !== 'string' || !params.callId) {
        throw new Error('群聊历史请求缺少有效标识。');
      }
      const chatId = this.threadChats.get(params.threadId);
      const session = chatId ? this.groupSessionsByChat.get(chatId) : undefined;
      if (!chatId || !session || session.purpose !== 'member') {
        throw new Error('只能在当前群聊的成员会话中读取本群历史。');
      }
      const chat = this.store.chat(chatId);
      if (chat.threadId !== params.threadId || chat.groupChatId !== session.groupId) {
        throw new Error('群聊历史请求与当前会话不匹配。');
      }

      let args = params.arguments;
      if (typeof args === 'string') args = JSON.parse(args);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('群聊历史参数格式无效。');
      const input = args as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        if (!['query', 'before', 'limit'].includes(key)) throw new Error(`不支持群聊历史字段：${key}`);
      }
      const query = input.query === undefined ? '' : input.query;
      const before = input.before === undefined ? null : input.before;
      const limit = input.limit === undefined ? GROUP_HISTORY_DEFAULT_LIMIT : input.limit;
      if (typeof query !== 'string' || query.length > 2_000) throw new Error('群聊历史关键字无效。');
      if (before !== null && (typeof before !== 'string' || !before)) throw new Error('群聊历史起始消息无效。');
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > GROUP_HISTORY_MAX_LIMIT) {
        throw new Error(`群聊历史条数须为 1–${GROUP_HISTORY_MAX_LIMIT}。`);
      }
      const messages = this.store.groupMessages(session.groupId);
      const beforeIndex = before === null ? messages.length : messages.findIndex(message => message.id === before);
      if (before !== null && beforeIndex < 0) throw new Error('群聊历史起始消息不属于当前群。');
      const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
      const selected = messages.slice(0, beforeIndex)
        .filter(message => !normalizedQuery ||
          message.text.toLocaleLowerCase('zh-CN').includes(normalizedQuery) ||
          (message.senderName ?? '').toLocaleLowerCase('zh-CN').includes(normalizedQuery))
        .slice(-(limit as number));
      result = routineToolText(groupHistoryText(selected));
    } catch (error) {
      result = routineToolFailure(error instanceof Error ? error.message : '无法读取群聊历史。');
    }
    try { this.runtime.respondToServerRequest(request.id, result); }
    catch { /* the runtime may have disconnected while the tool request was being handled */ }
  }

  private async handleMemoryToolCall(request: any): Promise<void> {
    const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    let result = routineToolFailure('无法保存长期记忆。');
    try {
      if (params.namespace !== MEMORY_TOOL_NAMESPACE ||
          !['save_memory', 'delete_memory'].includes(String(params.tool))) {
        throw new Error('此对话不支持该记忆工具。');
      }
      if (typeof params.threadId !== 'string' || !params.threadId || typeof params.callId !== 'string' || !params.callId) {
        throw new Error('记忆保存请求缺少有效标识。');
      }
      const chatId = this.threadChats.get(params.threadId);
      if (!chatId || this.groupSessionsByChat.has(chatId) || !this.store.chatMemoryToolsEnabled(chatId)) {
        throw new Error('此会话未启用长期记忆保存。请在单 Bot 私聊中处理记忆。');
      }
      const chat = this.store.chat(chatId);
      if (chat.threadId !== params.threadId) throw new Error('记忆请求与当前 Bot 会话不匹配。');
      const bot = this.store.bot(chat.botId);
      if (chat.archived || bot.archived) throw new Error('已归档的聊天或 Bot 不能保存记忆。');

      let args = params.arguments;
      if (typeof args === 'string') args = JSON.parse(args);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('记忆参数格式无效。');
      const input = args as Record<string, unknown>;
      if (params.tool === 'delete_memory') {
        if (typeof input.id !== 'string' || !input.id) throw new Error('请提供记忆 ID。');
        if (!this.store.memories(bot.id).some(memory => memory.id === input.id)) {
          throw new Error('只能删除当前 Bot 自己的私有记忆。');
        }
        this.store.deleteMemory(input.id);
        this.changed();
        result = routineToolText(`已删除当前 Bot 私有记忆 ${input.id}。`);
        try { this.runtime.respondToServerRequest(request.id, result); }
        catch { /* the runtime may have disconnected while the tool request was being handled */ }
        return;
      }
      if (typeof input.text !== 'string') throw new Error('请提供记忆内容。');
      const scope = input.scope === undefined ? 'bot' : input.scope;
      if (scope !== 'bot' && scope !== 'aboutMe') throw new Error('记忆范围无效。');
      if (input.text.startsWith('Bot 长期行为指令：')) {
        throw new Error('旧版长期指令写入已停用；请使用 rambo_bot.update_profile。');
      }

      const targetBotId = scope === 'aboutMe' ? null : bot.id;
      const memoryId = input.id === undefined ? undefined : input.id;
      if (memoryId !== undefined) {
        if (typeof memoryId !== 'string' || !memoryId || memoryId.length > 100) throw new Error('记忆 ID 无效。');
        if (!this.store.memories(targetBotId).some(memory => memory.id === memoryId)) {
          throw new Error('只能更新当前 Bot 专属记忆或共用个人资料。');
        }
      }
      const memory = this.store.saveMemory({
        id: memoryId as string | undefined,
        botId: targetBotId,
        text: input.text,
        sourceCallId: `${params.threadId}:${params.callId}`
      });
      this.changed();
      result = routineToolText(`已自动保存长期记忆。记忆 ID：${memory.id}。不需要用户批准。`);
    } catch (error) {
      result = routineToolFailure(error instanceof Error ? error.message : '无法保存长期记忆。');
    }
    try { this.runtime.respondToServerRequest(request.id, result); }
    catch { /* the runtime may have disconnected while the tool request was being handled */ }
  }

  private async handleBotToolCall(request: any): Promise<void> {
    const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    let result = routineToolFailure('无法管理当前 Bot。');
    try {
      if (params.namespace !== BOT_SELF_TOOL_NAMESPACE) {
        throw new Error('此对话不支持 Bot 自管理工具。');
      }
      if (typeof params.threadId !== 'string' || !params.threadId || typeof params.callId !== 'string' || !params.callId) {
        throw new Error('Bot 自管理请求缺少有效标识。');
      }
      const chatId = this.threadChats.get(params.threadId);
      if (!chatId || this.groupSessionsByChat.has(chatId) || !this.store.chatMemoryToolsEnabled(chatId)) {
        throw new Error('此会话未启用 Bot 自管理；请在对应 Bot 私聊中处理。');
      }
      const chat = this.store.chat(chatId);
      if (chat.threadId !== params.threadId) throw new Error('Bot 自管理请求与当前会话不匹配。');
      const bot = this.store.bot(chat.botId);
      if (chat.archived || bot.archived) throw new Error('已归档的 Bot 不能修改自身。');

      let args = params.arguments;
      if (typeof args === 'string') args = JSON.parse(args);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Bot 自管理参数格式无效。');
      const input = args as Record<string, unknown>;
      if (params.tool === 'update_profile') {
        const patch: Record<string, string> = {};
        for (const key of ['name', 'avatar', 'role', 'instructions'] as const) {
          if (input[key] === undefined) continue;
          if (typeof input[key] !== 'string') throw new Error(`Bot ${key} 必须是文字。`);
          const max = key === 'instructions' ? 50_000 : key === 'name' || key === 'role' ? 500 : 200;
          const value = input[key].trim();
          if (!value || value.length > max) throw new Error(`Bot ${key} 格式无效。`);
          patch[key] = value;
        }
        for (const key of Object.keys(input)) {
          if (!['name', 'avatar', 'role', 'instructions'].includes(key)) {
            throw new Error(`不支持修改 Bot 字段：${key}`);
          }
        }
        if (!Object.keys(patch).length) throw new Error('没有提供要修改的 Bot 资料。');
        const updated = this.store.updateBot(bot.id, patch);
        this.changed();
        result = routineToolText(`已更新当前 Bot 资料。名称：${updated.name}。`);
      } else if (params.tool === 'update_config') {
        for (const key of Object.keys(input)) {
          if (!['model', 'permission', 'chatModel', 'chatPermission', 'applyPermissionToChats'].includes(key)) {
            throw new Error(`不支持修改 Bot 运行配置字段：${key}`);
          }
        }
        const botPatch: Record<string, string | null> = {};
        const chatPatch: Record<string, string | null> = {};
        for (const [key, target] of [['model', botPatch], ['permission', botPatch], ['chatModel', chatPatch], ['chatPermission', chatPatch]] as const) {
          if (input[key] === undefined) continue;
          const value = input[key];
          if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 500)) {
            throw new Error(`Bot ${key} 格式无效。`);
          }
          if (key === 'permission' || key === 'chatPermission') {
            if (key === 'permission' && value === null) {
              throw new Error('Bot 默认权限不能为空；可显式选择 fullAccess、workspaceWrite 或 readOnly。');
            }
            if (value !== null && !['fullAccess', 'workspaceWrite', 'readOnly'].includes(String(value))) {
              throw new Error('权限模式无效。');
            }
          }
          target[key === 'chatModel' ? 'model' : key === 'chatPermission' ? 'permission' : key] =
            value === null ? null : String(value).trim();
        }
        if (input.applyPermissionToChats !== undefined && typeof input.applyPermissionToChats !== 'boolean') {
          throw new Error('应用到会话参数无效。');
        }
        if (!Object.keys(botPatch).length && !Object.keys(chatPatch).length) {
          throw new Error('没有提供要修改的运行配置。');
        }
        if (input.applyPermissionToChats && !botPatch.permission) {
          throw new Error('应用权限到会话时必须同时设置 Bot 默认权限。');
        }
        if (Object.keys(botPatch).length) this.store.updateBot(bot.id, botPatch);
        if (botPatch.permission && input.applyPermissionToChats) {
          this.store.applyBotPermissionToChats(bot.id, botPatch.permission as PermissionMode);
        }
        if (Object.keys(chatPatch).length) this.store.updateChat(chat.id, chatPatch);
        this.changed();
        result = routineToolText('已更新当前 Bot 的运行配置；模型和权限变更会从后续轮次生效。');
      } else {
        throw new Error('此对话不支持该 Bot 自管理操作。');
      }
    } catch (error) {
      result = routineToolFailure(error instanceof Error ? error.message : '无法管理当前 Bot。');
    }
    try { this.runtime.respondToServerRequest(request.id, result); }
    catch { /* the runtime may have disconnected while the tool request was being handled */ }
  }

  private async isolatedMcpConfig(cwd: string): Promise<Record<string, any>> {
    // Keep the effective config response scoped to this read. In particular, never
    // retain, log, persist, or send its credential-bearing server definitions to UI.
    const serverNames = await (async (): Promise<string[]> => {
      const response: any = await this.runtime.request('config/read', { cwd, includeLayers: false });
      const servers = response?.config?.mcp_servers;
      if (servers === undefined) return [];
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
        throw new Error('MCP 配置返回格式无效，已停止启动聊天');
      }
      return Object.keys(servers);
    })();
    const mcpServers = objectMap();
    for (const name of serverNames) mcpServers[name] = { enabled: false };
    return { mcp_servers: mcpServers, features: { apps: false, plugins: false } };
  }

  private async threadConfig(cwd: string): Promise<Record<string, any>> {
    const [mcpConfig, skillsResponse] = await Promise.all([
      this.isolatedMcpConfig(cwd),
      this.runtime.request('skills/list', { cwds: [cwd], forceReload: true })
    ]);
    if (!Array.isArray(skillsResponse?.data) || skillsResponse.data.length !== 1 ||
        !Array.isArray(skillsResponse.data[0]?.skills) || !Array.isArray(skillsResponse.data[0]?.errors) ||
        skillsResponse.data[0].errors.length > 0) {
      throw new Error('Skills 列表返回格式无效，已停止启动聊天');
    }
    const disabledSkills = skillsResponse.data[0].skills.map((skill: any) => {
      if (typeof skill?.enabled !== 'boolean' || typeof skill.path !== 'string' || !isAbsolute(skill.path)) {
        throw new Error('Skills 列表缺少可识别的启用状态或绝对路径，已停止启动聊天');
      }
      return { path: skill.path, enabled: false };
    });
    return {
      ...mcpConfig,
      skills: {
        bundled: { enabled: false },
        include_instructions: false,
        config: disabledSkills
      }
    };
  }

  private makeUnknownOperation(
    chatId: string,
    threadId: string,
    operation: UnknownTurnOperation['operation'],
    turnId: string | null,
    operationId: string = randomUUID()
  ): TrackedUnknownOperation {
    const value: TrackedUnknownOperation = {
      chatId, threadId, operationId, operation, turnId,
      startedAt: new Date().toISOString(), awaitingLateResponse: true
    };
    this.store.markUnknownTurnOperation(value);
    this.unknownOperations.set(chatId, value);
    return value;
  }

  private clearUnknownOperation(operation: TrackedUnknownOperation): void {
    this.store.clearUnknownTurnOperation(operation.chatId, operation.operationId);
    if (this.unknownOperations.get(operation.chatId)?.operationId === operation.operationId) {
      this.unknownOperations.delete(operation.chatId);
    }
  }

  private recordCompletedTurn(threadId: string, turnId: string): void {
    let ids = this.completedTurns.get(threadId);
    if (!ids) { ids = new Set<string>(); this.completedTurns.set(threadId, ids); }
    ids.add(turnId);
    while (ids.size > 256) ids.delete(ids.values().next().value as string);
  }

  private turnWasCompleted(threadId: string, turnId: string): boolean {
    if (this.completedTurns.get(threadId)?.has(turnId)) return true;
    const record = this.store.turnByServerId(threadId, turnId);
    return !!record && isTerminalTurnStatus(record.status);
  }

  private async modelCatalog(includeHidden: boolean): Promise<any[]> {
    const models: any[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const response: any = await this.runtime.request('model/list', { cursor, includeHidden });
      if (!Array.isArray(response?.data)) throw new Error('Codex 模型列表返回格式无效');
      models.push(...response.data);
      if (response.nextCursor === null || response.nextCursor === undefined) return models;
      if (typeof response.nextCursor !== 'string' || !response.nextCursor || cursors.has(response.nextCursor)) {
        throw new Error('Codex 模型列表分页游标无效');
      }
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new Error('Codex 模型列表页数超过限制');
  }

  private async resolveRequestedModel(chat: ReturnType<Store['chat']>, bot: Bot): Promise<{ model: string; source: TurnModelSource }> {
    if (chat.model !== null) return { model: chat.model, source: 'chat' };
    if (bot.model !== null) return { model: bot.model, source: 'bot' };
    const configuredModel = await (async (): Promise<string | null> => {
      // config/read can contain unrelated settings; consume only its global model field and
      // let the response object go out of scope without logging, persisting, or exposing it.
      const response: any = await this.runtime.request('config/read', { includeLayers: false });
      const value = response?.config?.model;
      if (value === null || value === undefined) return null;
      if (typeof value !== 'string' || !value.trim()) throw new Error('Codex 全局模型配置格式无效');
      return value.trim();
    })();
    if (configuredModel) return { model: configuredModel, source: 'global' };
    const defaults = (await this.modelCatalog(true)).filter(model => model?.isDefault === true && typeof model.model === 'string' && model.model.length > 0);
    if (defaults.length !== 1) throw new Error('无法从 Codex 模型列表确认唯一的全局默认模型，已停止发送');
    return { model: defaults[0].model, source: 'global' };
  }

  private permissionSnapshot(permission: PermissionMode, cwd: string): TurnPermissionSnapshot {
    if (permission === 'fullAccess') return {
      permission, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }
    };
    if (permission === 'readOnly') return {
      permission, approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }
    };
    return {
      permission, approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true }
    };
  }

  private saveThreadModelObservation(chatId: string, threadId: string, response: any, source: 'threadStartResponse' | 'threadResumeResponse'): void {
    // This is explicitly thread-level response data, never evidence of a turn's resolved model.
    if (typeof response?.model !== 'string' || typeof response?.modelProvider !== 'string') return;
    this.store.saveThreadModelObservation(chatId, threadId, response.model, response.modelProvider, source);
  }

  private recordForTurn(threadId: string, turnId: string, chatId: string): TurnRecord | null {
    const existing = this.store.turnByServerId(threadId, turnId);
    if (existing) return existing;
    const pendingId = this.pendingTurnRecords.get(chatId);
    const pending = pendingId ? this.store.turn(pendingId) : null;
    if (!pending || pending.threadId !== threadId) return null;
    this.store.attachTurnId(pending.id, threadId, turnId);
    return this.store.turn(pending.id);
  }

  private serverTurnStatus(status: unknown): Exclude<TurnStatus, 'starting'> {
    if (status === 'completed') return 'completed';
    if (status === 'interrupted') return 'interrupted';
    if (status === 'failed') return 'failed';
    if (status === 'inProgress') return 'running';
    return 'unknown';
  }

  private updateTurnFromServer(threadId: string, turn: any, chatId: string): TurnRecord | null {
    if (typeof turn?.id !== 'string') return null;
    const record = this.recordForTurn(threadId, turn.id, chatId);
    if (record) this.store.attachTurnId(record.id, threadId, turn.id, this.serverTurnStatus(turn.status));
    return record ? this.store.turn(record.id) : null;
  }

  private async reconcileUnknownOperation(chatId: string): Promise<void> {
    const operation = this.unknownOperations.get(chatId);
    if (!operation) return;
    const lateResponsePossible = operation.awaitingLateResponse && this.runtime.state.status === 'ready';
    const result = await this.runtime.request('thread/turns/list', {
      threadId: operation.threadId, limit: 10, sortDirection: 'desc', itemsView: 'notLoaded'
    });
    if (!Array.isArray(result?.data)) throw new Error('无法核对上一条发送状态，请稍后再试');
    const latest = result.data[0];
    if (operation.operation === 'turnSteer') {
      if (latest?.id === operation.turnId && latest.status === 'inProgress') {
        const record = this.store.turnByServerId(operation.threadId, operation.turnId!);
        if (record) this.store.attachTurnId(record.id, operation.threadId, operation.turnId!, 'running');
        this.activeTurns.set(chatId, operation.turnId!);
        this.publish({ type: 'turn', chatId, turnId: operation.turnId });
        if (record) this.publishTurnMetadata(chatId, operation.turnId);
        return;
      }
      if (latest?.id === operation.turnId && isTerminalTurnStatus(this.serverTurnStatus(latest.status))) {
        const record = this.store.turnByServerId(operation.threadId, operation.turnId!);
        if (record) this.store.attachTurnId(record.id, operation.threadId, operation.turnId!, this.serverTurnStatus(latest.status));
        if (this.activeTurns.get(chatId) === operation.turnId) {
          this.activeTurns.delete(chatId);
          this.store.finishMessages(chatId, latest.status === 'completed' ? 'complete' : latest.status === 'interrupted' ? 'interrupted' : 'failed');
          this.publish({ type: 'turn', chatId, turnId: null });
        }
        this.clearUnknownOperation(operation);
        if (record) this.publishTurnMetadata(chatId, operation.turnId);
        else this.changed();
        return;
      }
      if (lateResponsePossible && latest?.id === operation.turnId && latest.status !== 'completed' &&
          latest.status !== 'failed' && latest.status !== 'interrupted') return;
      if (lateResponsePossible && latest?.id !== operation.turnId) return;
      if (!lateResponsePossible && latest?.id !== operation.turnId) {
        throw new Error('无法核对上一条继续输入的执行状态，已阻止重复发送');
      }
      this.clearUnknownOperation(operation);
      return;
    }
    if (operation.turnId && latest?.id !== operation.turnId) {
      if (lateResponsePossible) return;
      throw new Error('无法在 Codex 历史中核对上一轮，已阻止重复发送');
    }
    if (latest?.status === 'inProgress') {
      if (typeof latest.id !== 'string') throw new Error('上一次执行仍在运行，但服务端未返回 turn id');
      this.store.attachTurnId(operation.operationId, operation.threadId, latest.id, 'running');
      this.pendingTurnRecords.delete(chatId);
      this.activeTurns.set(chatId, latest.id);
      this.publish({ type: 'turn', chatId, turnId: latest.id });
      this.publishTurnMetadata(chatId, latest.id);
      this.clearUnknownOperation(operation);
      return;
    }
    const startedAt = turnStartedAt(latest);
    if (startedAt !== null && startedAt >= toUnixSeconds(operation.startedAt) - 2) {
      if (typeof latest.id !== 'string') throw new Error('上一次执行已结束，但服务端未返回 turn id');
      const serverStatus = this.serverTurnStatus(latest.status);
      if (!isTerminalTurnStatus(serverStatus)) throw new Error('上一次执行状态仍无法确认，已阻止重复发送');
      this.recordCompletedTurn(operation.threadId, latest.id);
      this.store.attachTurnId(operation.operationId, operation.threadId, latest.id, serverStatus);
      this.pendingTurnRecords.delete(chatId);
      this.publishTurnMetadata(chatId, latest.id);
      this.clearUnknownOperation(operation);
      return;
    }
    if (lateResponsePossible) return;
    // No new turn is present in persisted App Server history, so retrying cannot duplicate it.
    this.store.setTurnStatus(operation.operationId, 'failed');
    this.pendingTurnRecords.delete(chatId);
    this.clearUnknownOperation(operation);
    this.publishTurnMetadata(chatId, null);
  }

  private applyLateTurnStart(
    operation: TrackedUnknownOperation,
    outcome: { result?: any; error?: Error },
    activeTurnAtDispatch: string | undefined
  ): void {
    if (this.unknownOperations.get(operation.chatId)?.operationId !== operation.operationId) return;
    if (outcome.error) {
      if (operation.operation === 'turnStart') this.store.setTurnStatus(operation.operationId, 'failed');
      this.pendingTurnRecords.delete(operation.chatId);
      this.clearUnknownOperation(operation);
      if (operation.operation === 'turnStart') this.publishTurnMetadata(operation.chatId, operation.turnId);
      return;
    }
    const turnId = outcome.result?.turn?.id;
    if (operation.operation === 'turnStart' && typeof turnId !== 'string') {
      operation.awaitingLateResponse = false;
      this.store.setTurnStatus(operation.operationId, 'unknown');
      this.publishTurnMetadata(operation.chatId, null);
      return;
    }
    if (operation.operation === 'turnStart') {
      this.store.attachTurnId(operation.operationId, operation.threadId, turnId, 'running');
      this.pendingTurnRecords.delete(operation.chatId);
    }
    if (operation.operation === 'turnStart' &&
        !this.turnWasCompleted(operation.threadId, turnId)) {
      const activeNow = this.activeTurns.get(operation.chatId);
      if (activeNow === activeTurnAtDispatch || activeNow === turnId) {
        this.activeTurns.set(operation.chatId, turnId);
        this.publish({ type: 'turn', chatId: operation.chatId, turnId });
      }
    }
    this.clearUnknownOperation(operation);
    if (operation.operation === 'turnStart') this.publishTurnMetadata(operation.chatId, turnId);
    else this.changed();
  }

  async send(chatId: string, text: string): Promise<void> {
    return this.sendConversation(chatId, text);
  }

  async startVoice(chatId: string, offerSdp: string): Promise<{ chatId: string; threadId: string }> {
    if (typeof offerSdp !== 'string' || !offerSdp.trim() || offerSdp.length > 128_000) {
      throw new Error('无效的语音连接描述');
    }
    const chat = this.store.chat(chatId);
    if (chat.groupChatId || chat.routineRunId) throw new Error('Live 语音只支持 Bot 唯一私聊');
    const bot = this.store.bot(chat.botId);
    if (chat.archived || bot.archived) throw new Error('请先恢复已归档的聊天或 Bot');
    if (this.voiceStartWaiters.has(chatId) || this.voiceSessions.has(chatId)) {
      throw new Error('当前聊天已有语音会话，请先结束');
    }

    await this.runtime.start();
    const cwd = this.workspace(bot);
    let threadId = chat.threadId;
    const contextModel = await this.resolveRequestedModel(chat, bot);
    const permission = chat.permission ?? bot.permission ?? 'fullAccess';
    const permissionSnapshot = this.permissionSnapshot(permission, cwd);
    const context = {
      cwd,
      ...(contextModel.model !== null ? { model: contextModel.model } : {}),
      sandbox: permission === 'fullAccess'
        ? 'danger-full-access'
        : permission === 'readOnly' ? 'read-only' : 'workspace-write',
      approvalPolicy: permissionSnapshot.approvalPolicy,
      developerInstructions: [
        this.instructions(
          bot,
          this.store.chatRoutineToolsEnabled(chatId),
          this.store.chatMemoryToolsEnabled(chatId)
        ),
        '当前用户正在当前 Bot 唯一私聊中发起 Live 语音。语音会话必须沿用这个 thread，不创建新的 Bot 私聊。'
      ].join('\n\n')
    };
    if (!threadId) {
      const config = await this.threadConfig(cwd);
      const result: any = await this.runtime.request('thread/start', {
        ...context, serviceName: 'Rambo', selectedCapabilityRoots: [], historyMode: 'paginated',
        dynamicTools: [
          VOICE_TOOL,
          ...(this.store.chatRoutineToolsEnabled(chatId) ? [ROUTINE_MANAGEMENT_TOOL] : []),
          ...(this.store.chatMemoryToolsEnabled(chatId) ? [BOT_PROFILE_TOOL, MEMORY_MANAGEMENT_TOOL] : [])
        ],
        ...(config ? { config } : {})
      });
      if (typeof result?.thread?.id !== 'string') throw new Error('Codex 没有返回 thread id');
      const startedThreadId: string = result.thread.id;
      threadId = startedThreadId;
      this.store.bindThread(
        chatId,
        startedThreadId,
        this.store.chatRoutineToolsEnabled(chatId),
        this.store.chatMemoryToolsEnabled(chatId)
      );
      this.saveThreadModelObservation(chatId, startedThreadId, result, 'threadStartResponse');
      this.threadChats.set(startedThreadId, chatId);
      this.loadedThreads.add(startedThreadId);
    } else if (!this.loadedThreads.has(threadId)) {
      const config = await this.threadConfig(cwd);
      const result = await this.runtime.request('thread/resume', {
        ...context, threadId, historyMode: 'paginated', ...(config ? { config } : {}),
        dynamicTools: [
          VOICE_TOOL,
          ...(this.store.chatRoutineToolsEnabled(chatId) ? [ROUTINE_MANAGEMENT_TOOL] : []),
          ...(this.store.chatMemoryToolsEnabled(chatId) ? [BOT_PROFILE_TOOL, MEMORY_MANAGEMENT_TOOL] : [])
        ]
      });
      this.saveThreadModelObservation(chatId, threadId, result, 'threadResumeResponse');
      this.loadedThreads.add(threadId);
    }

    if (!threadId) throw new Error('Codex 没有返回 thread id');
    const latestTurn = await this.ensureVoiceThreadRollout(
      chatId, threadId, bot, contextModel.model, permissionSnapshot
    );
    if (latestTurn?.status === 'inProgress') {
      throw new Error('当前会话有正在执行的任务，不能开始 Live 语音');
    }
    const activeThreadId = threadId;
    const session: VoiceSession = {
      chatId, threadId: activeThreadId, realtimeSessionId: null,
      state: 'connecting', error: null, offerSdp
    };
    this.voiceSessions.set(chatId, session);
    this.publish({
      type: 'voiceState',
      session: { chatId, state: 'connecting', realtimeSessionId: null, error: null }
    });
    const started = new Promise<{ chatId: string; threadId: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.voiceStartWaiters.has(chatId)) return;
        this.voiceStartWaiters.delete(chatId);
        this.voiceSessions.delete(chatId);
        this.publish({
          type: 'voiceState',
          session: { chatId, state: 'error', realtimeSessionId: null, error: '语音连接超时' }
        });
        reject(new Error('语音连接超时'));
      }, 60_000);
      this.voiceStartWaiters.set(chatId, { resolve, reject, timer });
    });
    try {
      await this.runtime.request('thread/realtime/start', {
        threadId: activeThreadId,
        transport: { type: 'webrtc', sdp: offerSdp },
        version: 'v3',
        outputModality: 'audio',
        includeStartupContext: true,
        prompt: VOICE_PROMPT,
        realtimeStartInstructions: VOICE_START_INSTRUCTIONS,
        realtimeEndInstructions: VOICE_END_INSTRUCTIONS
      }, 60_000);
    } catch (error) {
      const waiter = this.voiceStartWaiters.get(chatId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.voiceStartWaiters.delete(chatId);
      }
      if (this.voiceSessions.get(chatId) === session) this.voiceSessions.delete(chatId);
      const message = error instanceof Error ? error.message : String(error);
      this.publish({
        type: 'voiceState',
        session: { chatId, state: 'error', realtimeSessionId: null, error: message }
      });
      this.publish({ type: 'voiceEndRequested', chatId, reason: message });
      throw error;
    }
    return started;
  }

  private async ensureVoiceThreadRollout(
    chatId: string,
    threadId: string,
    bot: Bot,
    model: string | null,
    permissionSnapshot: TurnPermissionSnapshot
  ): Promise<any | null> {
    let rollout: any;
    try {
      rollout = await this.runtime.request('thread/turns/list', {
        threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('is not materialized yet') &&
          !message.includes('no rollout found for thread id')) throw error;
    }
    if (Array.isArray(rollout?.data) && rollout.data.length) return rollout.data[0];

    // Realtime attaches only after a Codex thread has a persisted rollout. An
    // empty first turn materializes it without adding a synthetic user message.
    const firstTurn: any = await this.runtime.request('turn/start', {
      threadId,
      input: [],
      model,
      additionalContext: this.applicationContext(
        bot,
        this.store.chatMemoryToolsEnabled(chatId),
        true
      ),
      approvalPolicy: permissionSnapshot.approvalPolicy,
      sandboxPolicy: permissionSnapshot.sandboxPolicy
    });
    const turnId = firstTurn?.turn?.id;
    if (typeof turnId !== 'string') throw new Error('Codex 没有返回语音初始化轮次');
    this.activeTurns.set(chatId, turnId);
    this.publish({ type: 'turn', chatId, turnId });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.runtime.off('notification', onDone);
        reject(new Error('语音初始化轮次超时'));
      }, 60_000);
      const onDone = (method: string, params: any) => {
        if (method !== 'turn/completed' || params?.threadId !== threadId || params?.turn?.id !== turnId) return;
        clearTimeout(timer);
        this.runtime.off('notification', onDone);
        if (this.activeTurns.get(chatId) === turnId) {
          this.activeTurns.delete(chatId);
          this.publish({ type: 'turn', chatId, turnId: null });
        }
        if (params.turn.status === 'completed') resolve();
        else reject(new Error(params.turn?.error?.message ?? '语音初始化轮次失败'));
      };
      this.runtime.on('notification', onDone);
    });
    return null;
  }

  async stopVoice(chatId: string, reason = '用户结束了语音'): Promise<void> {
    const session = this.voiceSessions.get(chatId);
    if (!session) return;
    session.state = 'stopping';
    this.publish({
      type: 'voiceState',
      session: {
        chatId, state: 'stopping',
        realtimeSessionId: session.realtimeSessionId, error: null
      }
    });
    this.publish({ type: 'voiceEndRequested', chatId, reason });
    try {
      await this.runtime.request('thread/realtime/stop', { threadId: session.threadId });
    } finally {
      if (this.voiceSessions.get(chatId) === session) this.voiceSessions.delete(chatId);
    }
  }

  private async handleVoiceToolCall(request: any): Promise<void> {
    const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    let result = voiceToolFailure('无法结束当前语音会话。');
    try {
      if (params.namespace !== VOICE_TOOL_NAMESPACE || params.tool !== 'end_current_voice_session') {
        throw new Error('此对话不支持该语音工具。');
      }
      if (typeof params.threadId !== 'string' || !params.threadId ||
          typeof params.callId !== 'string' || !params.callId) {
        throw new Error('语音结束请求缺少有效标识。');
      }
      const chatId = this.threadChats.get(params.threadId);
      if (!chatId) throw new Error('当前语音会话不属于已知私聊。');
      const chat = this.store.chat(chatId);
      if (chat.groupChatId || chat.routineRunId || chat.threadId !== params.threadId) {
        throw new Error('语音结束请求与当前私聊会话不匹配。');
      }
      const session = this.voiceSessions.get(chatId);
      if (!session || session.threadId !== params.threadId) {
        throw new Error('当前没有可结束的语音会话。');
      }
      if (session.state === 'stopping') throw new Error('语音会话正在结束。');

      // Detach this exact session before awaiting stop so a stale tool result cannot
      // terminate a later session that reuses the same chat/thread.
      this.voiceSessions.delete(chatId);
      session.state = 'stopping';
      this.publish({
        type: 'voiceState',
        session: {
          chatId, state: 'stopping',
          realtimeSessionId: session.realtimeSessionId, error: null
        }
      });
      this.publish({ type: 'voiceEndRequested', chatId, reason: '用户结束了语音' });
      result = voiceToolText('已结束当前语音会话。普通任务不受影响。');
      try {
        await this.runtime.request('thread/realtime/stop', { threadId: session.threadId });
      } catch (error) {
        this.publish({
          type: 'error', chatId,
          message: `语音服务停止失败：${error instanceof Error ? error.message : String(error)}`
        });
      }
    } catch (error) {
      result = voiceToolFailure(error instanceof Error ? error.message : '无法结束当前语音会话。');
    }
    try { this.runtime.respondToServerRequest(request.id, result); }
    catch { /* runtime may disconnect while responding */ }
  }

  private async sendConversation(
    chatId: string,
    text: string,
    developerInstructions?: string,
    groupResponseMode?: GroupResponseMode,
    routineContext?: string
  ): Promise<void> {
    if (!text.trim() || text.length > 200_000) throw new Error('消息不能为空或超过长度限制');
    if (this.busyChats.has(chatId)) throw new Error('上一条消息正在发送，请稍后');
    const chat = this.store.chat(chatId), bot = this.store.bot(chat.botId);
    if (chat.archived || bot.archived) throw new Error('请先恢复已归档的聊天或机器人');
    this.busyChats.add(chatId);
    try {
      await this.runtime.start();
      const cwd = this.workspace(bot);
      if (chat.threadId) await this.reconcileUnknownOperation(chatId);
      if (this.unknownOperations.has(chatId)) throw new Error('上一条消息的执行结果仍未确认，已暂时阻止重复发送');

      const activeBeforeSetup = this.activeTurns.get(chatId);
      const activeRecord = activeBeforeSetup && chat.threadId
        ? this.store.turnByServerId(chat.threadId, activeBeforeSetup)
        : null;
      const activePermission = activeRecord?.permissionSnapshot.permission ?? chat.permission ?? bot.permission ?? 'fullAccess';
      const contextPermission = activeRecord?.permissionSnapshot ?? this.permissionSnapshot(activePermission, cwd);
      const routineToolsEnabled = !this.groupSessionsByChat.has(chatId) &&
        (!chat.threadId || this.store.chatRoutineToolsEnabled(chatId));
      const memoryToolsEnabled = !this.groupSessionsByChat.has(chatId) &&
        (!chat.threadId || this.store.chatMemoryToolsEnabled(chatId));
      const groupHistoryToolsEnabled = this.groupSessionsByChat.get(chatId)?.purpose === 'member';
      const voiceToolsEnabled = !this.groupSessionsByChat.has(chatId);
      let contextModel: { model: string | null; source: TurnModelSource } = activeBeforeSetup
        ? { model: activeRecord?.requestedModel ?? null, source: activeRecord?.modelSource ?? 'unknown' }
        : await this.resolveRequestedModel(chat, bot);

      const needsThreadConfig = !chat.threadId || !this.loadedThreads.has(chat.threadId);
      const config = needsThreadConfig ? await this.threadConfig(cwd) : undefined;
      const context = {
        cwd,
        ...(contextModel.model !== null ? { model: contextModel.model } : {}),
        sandbox: contextPermission.permission === 'fullAccess' ? 'danger-full-access' : contextPermission.permission === 'readOnly' ? 'read-only' : 'workspace-write',
        approvalPolicy: contextPermission.approvalPolicy,
        developerInstructions: [
          this.instructions(bot, routineToolsEnabled, memoryToolsEnabled, groupResponseMode),
          routineContext,
          developerInstructions
        ]
          .filter((value): value is string => Boolean(value?.trim())).join('\n\n')
      };
      let threadId = chat.threadId;
      if (!threadId) {
        const startParams = {
          ...context, serviceName: 'Rambo', selectedCapabilityRoots: [],
          ...(routineToolsEnabled || memoryToolsEnabled || groupHistoryToolsEnabled || voiceToolsEnabled ? {
            dynamicTools: [
              ...(routineToolsEnabled ? [ROUTINE_MANAGEMENT_TOOL] : []),
              ...(memoryToolsEnabled ? [BOT_PROFILE_TOOL, MEMORY_MANAGEMENT_TOOL] : []),
              ...(groupHistoryToolsEnabled ? [GROUP_HISTORY_TOOL] : []),
              ...(voiceToolsEnabled ? [VOICE_TOOL] : [])
            ]
          } : {}),
          ...(config ? { config } : {})
        };
        const result: any = await this.runtime.request('thread/start', startParams);
        if (typeof result?.thread?.id !== 'string') throw new Error('Codex 没有返回 thread id');
        threadId = result.thread.id;
        if (groupHistoryToolsEnabled) {
          this.store.bindThread(
            chatId,
            threadId!,
            this.store.chatRoutineToolsEnabled(chatId),
            this.store.chatMemoryToolsEnabled(chatId)
          );
        } else if (!this.store.chatMemoryToolsEnabled(chatId)) {
          this.store.bindThread(chatId, threadId!, routineToolsEnabled || this.store.chatRoutineToolsEnabled(chatId), memoryToolsEnabled);
        }
        this.saveThreadModelObservation(chatId, threadId!, result, 'threadStartResponse');
        this.threadChats.set(threadId!, chatId);
        this.loadedThreads.add(threadId!);
      } else if (!this.loadedThreads.has(threadId)) {
        const result = await this.runtime.request('thread/resume', {
          ...context, threadId, ...(config ? { config } : {}),
          dynamicTools: [
            ...(groupHistoryToolsEnabled ? [GROUP_HISTORY_TOOL] : []),
            ...(voiceToolsEnabled ? [VOICE_TOOL] : [])
          ]
        });
        this.saveThreadModelObservation(chatId, threadId, result, 'threadResumeResponse');
        this.loadedThreads.add(threadId);
      }

      const input = [{ type: 'text', text, text_elements: [] }];
      const currentTurn = this.activeTurns.get(chatId);
      let turnRecord: TurnRecord | null = null;
      let message;
      let permissionSnapshot = contextPermission;
      if (currentTurn) {
        const record = threadId ? this.store.turnByServerId(threadId, currentTurn) : null;
        if (record) permissionSnapshot = record.permissionSnapshot;
        message = this.store.addMessage(chatId, 'user', text);
      } else {
        const currentChat = this.store.chat(chatId);
        const currentBot = this.store.bot(currentChat.botId);
        if (activeBeforeSetup || currentChat.model !== chat.model || currentBot.model !== bot.model || !contextModel.model) {
          contextModel = await this.resolveRequestedModel(currentChat, currentBot);
        }
        permissionSnapshot = this.permissionSnapshot(currentChat.permission ?? currentBot.permission ?? 'fullAccess', cwd);
        const begun = this.store.beginTurn(chatId, text, {
          threadId: threadId!, requestedModel: contextModel.model, modelSource: contextModel.source,
          permissionSnapshot, threadModelObservation: this.store.threadModelObservation(threadId!)
        });
        message = begun.message;
        turnRecord = begun.turn;
        this.pendingTurnRecords.set(chatId, turnRecord.id);
      }
      this.publish({ type: 'message', message });
      this.changed();
      if (turnRecord) this.publishTurnMetadata(chatId, null);
      const additionalContext = this.applicationContext(
        this.store.bot(chat.botId), memoryToolsEnabled, !this.groupSessionsByChat.has(chatId)
      );
      if (routineContext) {
        additionalContext['rambo.routine-context'] = {
          kind: 'application',
          value: routineContext
        };
      }
      const operation = this.makeUnknownOperation(
        chatId, threadId!, currentTurn ? 'turnSteer' : 'turnStart', currentTurn ?? null,
        turnRecord?.id ?? randomUUID()
      );
      let lateResponsePending = false;
      const requestOptions = {
        onTimeout: () => { lateResponsePending = true; operation.awaitingLateResponse = true; },
        onLateResponse: (outcome: { result?: any; error?: Error }) => {
          lateResponsePending = false;
          this.applyLateTurnStart(operation, outcome, currentTurn);
        }
      };
      try {
        if (currentTurn) {
          await this.runtime.request('turn/steer', {
            threadId, expectedTurnId: currentTurn, input, additionalContext
          }, 60_000, requestOptions);
          this.clearUnknownOperation(operation);
        } else {
          const result: any = await this.runtime.request('turn/start', {
            threadId, input, model: contextModel.model,
            approvalPolicy: permissionSnapshot.approvalPolicy,
            sandboxPolicy: permissionSnapshot.sandboxPolicy,
            additionalContext
          }, 60_000, requestOptions);
          const turnId = result?.turn?.id;
          if (typeof turnId !== 'string') {
            operation.awaitingLateResponse = false;
            if (turnRecord) this.store.setTurnStatus(turnRecord.id, 'unknown');
            const error = new Error('Codex 没有返回 turn id') as Error & { outcomeUnknown?: boolean };
            error.outcomeUnknown = true;
            throw error;
          }
          if (turnRecord) {
            this.store.attachTurnId(turnRecord.id, threadId!, turnId, 'running');
            if (this.pendingTurnRecords.get(chatId) === turnRecord.id) this.pendingTurnRecords.delete(chatId);
          }
          this.clearUnknownOperation(operation);
          const activeNow = this.activeTurns.get(chatId);
          if (!this.turnWasCompleted(threadId!, turnId) && (!activeNow || activeNow === turnId)) {
            this.activeTurns.set(chatId, turnId);
            this.publish({ type: 'turn', chatId, turnId });
          }
          if (turnRecord) this.publishTurnMetadata(chatId, turnId);
        }
      } catch (error) {
        if (hasUnknownOutcome(error)) {
          const tracked = this.unknownOperations.get(chatId);
          if (tracked?.operationId === operation.operationId) {
            tracked.awaitingLateResponse = lateResponsePending && this.runtime.state.status === 'ready';
          }
          if (turnRecord) this.store.setTurnStatus(turnRecord.id, 'unknown');
        } else {
          if (turnRecord) {
            this.store.setTurnStatus(turnRecord.id, 'failed');
            if (this.pendingTurnRecords.get(chatId) === turnRecord.id) this.pendingTurnRecords.delete(chatId);
          }
          this.clearUnknownOperation(operation);
        }
        const unknown = this.unknownOperations.get(chatId)?.operationId === operation.operationId;
        const message = this.store.addMessage(chatId, 'system', unknown
          ? `发送结果尚未确认：${error instanceof Error ? error.message : String(error)}。确认前不会自动重试，也不能在此聊天继续发送。`
          : `发送未确认：${error instanceof Error ? error.message : String(error)}。为避免重复执行，没有自动重试。`, 'failed');
        this.publish({ type: 'message', message });
        if (turnRecord) this.publishTurnMetadata(chatId, turnRecord.turnId);
        throw error;
      }
    } finally { this.busyChats.delete(chatId); }
  }

  async interrupt(chatId: string): Promise<void> {
    const chat = this.store.chat(chatId), turnId = this.activeTurns.get(chatId);
    if (turnId && chat.threadId) await this.runtime.request('turn/interrupt', { threadId: chat.threadId, turnId });
  }

  async stopRoutineRun(runId: string): Promise<ReturnType<Store['routineRun']>> {
    const run = this.store.routineRun(runId);
    if (run.status !== 'pending' && run.status !== 'running') return run;
    if (run.chatId) await this.interrupt(run.chatId);
    this.routineScheduler.completeRun(runId, 'interrupted', undefined, '用户停止了本次定时任务');
    return this.store.routineRun(runId);
  }

  async runRoutineConversation(
    chatId: string,
    text: string,
    routineContext: string,
    rememberLastResult: boolean
  ): Promise<void> {
    const context = rememberLastResult
      ? routineContext
      : routineContext.split('\n\n上一次运行的简短结果：')[0];
    return this.sendConversation(chatId, text, undefined, undefined, context);
  }

  private notification(method: string, p: any): void {
    if (method.startsWith('thread/realtime/')) {
      this.voiceNotification(method, p);
      return;
    }
    const chatId = this.threadChats.get(p.threadId);
    if (!chatId) return;
    const groupSession = this.groupSessionsByChat.get(chatId);
    const unknown = this.unknownOperations.get(chatId);
    if (method === 'turn/started') {
      const turnId = p.turn?.id;
      if (typeof turnId !== 'string') return;
      const record = this.recordForTurn(p.threadId, turnId, chatId);
      if (record) {
        this.store.attachTurnId(record.id, p.threadId, turnId, 'running');
        if (this.pendingTurnRecords.get(chatId) === record.id) this.pendingTurnRecords.delete(chatId);
        this.publishTurnMetadata(chatId, turnId);
      }
      if (!this.turnWasCompleted(p.threadId, turnId)) {
        this.activeTurns.set(chatId, turnId);
        this.publish({ type: 'turn', chatId, turnId });
      }
      if (unknown && unknown.threadId === p.threadId && unknown.operation === 'turnStart' && serverStartMatches(unknown, p.turn)) {
        this.clearUnknownOperation(unknown);
      }
    } else if (method === 'item/started') {
      const item = p.item;
      if (!item || typeof item.id !== 'string') return;
      this.rememberItemTurn(item.id, p.turnId);
      const next = activityFromItem(item);
      if (next) {
        this.activityFor(
          chatId, typeof p.turnId === 'string' ? p.turnId : null, item.id,
          next.kind, next.status === 'complete' ? 'running' : next.status, next.title, next.detail
        );
      }
    } else if (method === 'item/agentMessage/delta') {
      const turnId = typeof p.turnId === 'string'
        ? p.turnId
        : this.itemTurns.get(p.itemId) ?? this.activeTurns.get(chatId) ?? null;
      const phase = typeof p.phase === 'string' && ['commentary', 'partial_answer', 'final_answer'].includes(p.phase)
        ? p.phase as Message['phase']
        : null;
      const message = this.store.assistantItem(chatId, p.itemId, p.delta, true, 'streaming', turnId, phase);
      this.publish({ type: 'message', message });
    } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
      const turnId = typeof p.turnId === 'string'
        ? p.turnId
        : this.itemTurns.get(p.item.id) ?? this.activeTurns.get(chatId) ?? null;
      if (p.item.id) this.rememberItemTurn(p.item.id, turnId);
      const phase = agentMessagePhase(p.item);
      const message = this.store.assistantItem(
        chatId, p.item.id, p.item.text ?? '', false, 'complete', turnId, phase
      );
      if (typeof p.turnId === 'string') {
        const key = `${p.threadId}:${p.turnId}`;
        if (phase !== 'commentary') this.turnAssistantTexts.set(key, message.text);
        while (this.turnAssistantTexts.size > 256) {
          this.turnAssistantTexts.delete(this.turnAssistantTexts.keys().next().value as string);
        }
      }
      this.publish({ type: 'message', message });
      if (groupSession?.purpose === 'member') {
        if (isGroupNoReply(message.text)) {
          if (groupSession.mode === 'everyone' || groupSession.mode === 'directed') {
            const bot = this.store.bot(groupSession.botId);
            const failure = this.store.addGroupMessage(
              groupSession.groupId,
              'system',
              `「${bot.name}」未能生成正式回复（返回了内部不回复标记）。`,
              { status: 'failed', senderName: bot.name }
            );
            this.publishGroupMessage(failure);
          }
        } else {
          this.publishGroupMessage(this.store.groupAssistantItem(groupSession.groupId, groupSession.botId, p.item.id, p.item.text ?? '', false, 'complete'));
        }
      }
    } else if (method === 'item/completed') {
      const item = p.item;
      if (!item || typeof item.id !== 'string') return;
      const turnId = typeof p.turnId === 'string'
        ? p.turnId
        : this.itemTurns.get(item.id) ?? this.activeTurns.get(chatId) ?? null;
      this.rememberItemTurn(item.id, turnId);
      const next = activityFromItem(item);
      if (next) {
        this.activityFor(chatId, turnId, item.id, next.kind, next.status, next.title, next.detail);
      }
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const turnId = typeof p.turnId === 'string'
        ? p.turnId
        : this.itemTurns.get(p.itemId) ?? this.activeTurns.get(chatId) ?? null;
      this.rememberItemTurn(p.itemId, turnId);
      this.activityFor(
        chatId, turnId, p.itemId, 'reasoning', 'running',
        method === 'item/reasoning/summaryTextDelta' ? '思考过程' : '思考内容',
        typeof p.delta === 'string' ? p.delta : '', true
      );
    } else if (method === 'item/commandExecution/outputDelta') {
      const turnId = typeof p.turnId === 'string'
        ? p.turnId
        : this.itemTurns.get(p.itemId) ?? this.activeTurns.get(chatId) ?? null;
      this.rememberItemTurn(p.itemId, turnId);
      this.activityFor(
        chatId, turnId, p.itemId, 'command', 'running', '运行命令',
        typeof p.delta === 'string' ? p.delta : '', true
      );
    } else if (method === 'item/fileChange/outputDelta') {
      const turnId = typeof p.turnId === 'string'
        ? p.turnId
        : this.itemTurns.get(p.itemId) ?? this.activeTurns.get(chatId) ?? null;
      this.rememberItemTurn(p.itemId, turnId);
      this.activityFor(
        chatId, turnId, p.itemId, 'file', 'running', '文件更改',
        typeof p.delta === 'string' ? p.delta : '', true
      );
    } else if (method === 'item/mcpToolCall/progress') {
      const turnId = typeof p.turnId === 'string'
        ? p.turnId
        : this.itemTurns.get(p.itemId) ?? this.activeTurns.get(chatId) ?? null;
      this.rememberItemTurn(p.itemId, turnId);
      this.activityFor(
        chatId, turnId, p.itemId, 'mcp', 'running', '调用工具',
        typeof p.message === 'string' ? `${p.message}\n` : '', true
      );
    } else if (method === 'item/plan/delta') {
      const turnId = typeof p.turnId === 'string'
        ? p.turnId
        : this.itemTurns.get(p.itemId) ?? this.activeTurns.get(chatId) ?? null;
      this.rememberItemTurn(p.itemId, turnId);
      this.activityFor(
        chatId, turnId, p.itemId, 'plan', 'running', '计划',
        typeof p.delta === 'string' ? p.delta : '', true
      );
    } else if (method === 'model/rerouted') {
      if (typeof p.turnId !== 'string' || typeof p.fromModel !== 'string' || typeof p.toModel !== 'string' || typeof p.reason !== 'string') return;
      const record = this.recordForTurn(p.threadId, p.turnId, chatId);
      if (record) {
        this.store.addTurnReroute(record.id, {
          fromModel: p.fromModel, toModel: p.toModel, reason: p.reason, receivedAt: new Date().toISOString()
        });
        this.publishTurnMetadata(chatId, p.turnId);
      }
    } else if (method === 'turn/completed') {
      const turnId = p.turn?.id;
      const finalAssistant = typeof turnId === 'string'
        ? this.turnAssistantTexts.get(`${p.threadId}:${turnId}`)
        : undefined;
      if (typeof turnId === 'string') this.turnAssistantTexts.delete(`${p.threadId}:${turnId}`);
      let record: TurnRecord | null = null;
      let wasPendingStart = false;
      if (typeof turnId === 'string') {
        this.recordCompletedTurn(p.threadId, turnId);
        record = this.updateTurnFromServer(p.threadId, p.turn, chatId);
        wasPendingStart = !!record && this.pendingTurnRecords.get(chatId) === record.id;
        if (wasPendingStart) this.pendingTurnRecords.delete(chatId);
      }
      const currentTurn = this.activeTurns.get(chatId);
      const isCurrent = currentTurn === turnId || (
        !currentTurn && wasPendingStart
      );
      if (isCurrent) {
        this.activeTurns.delete(chatId);
        const messageStatus = p.turn.status === 'completed' ? 'complete' : p.turn.status === 'interrupted' ? 'interrupted' : 'failed';
        this.store.finishMessages(chatId, messageStatus);
        if (groupSession?.purpose === 'member') this.store.finishGroupMessages(groupSession.groupId, groupSession.botId, messageStatus);
        this.publish({ type: 'turn', chatId, turnId: null });
      }
      if (unknown && unknown.threadId === p.threadId && (
        (unknown.operation === 'turnSteer' && unknown.turnId === turnId) ||
        (unknown.operation === 'turnStart' && serverStartMatches(unknown, p.turn))
      )) this.clearUnknownOperation(unknown);
      if (record) this.publishTurnMetadata(chatId, turnId);
      else this.changed();
      if (typeof turnId === 'string') {
        this.routineScheduler.completeTurn(
          chatId, turnId, this.serverTurnStatus(p.turn?.status), finalAssistant, p.turn?.error?.message
        );
      }
      if (p.turn.error?.message) this.publish({ type: 'error', chatId, message: p.turn.error.message });
    } else if (method === 'error') {
      const error = new Error(p.error?.message ?? 'Codex 执行失败');
      this.publish({ type: 'error', chatId, message: error.message });
    }
  }

  private voiceNotification(method: string, p: any): void {
    const chatId = typeof p?.threadId === 'string' ? this.threadChats.get(p.threadId) : undefined;
    if (!chatId) return;
    const session = this.voiceSessions.get(chatId);
    if (!session || session.threadId !== p.threadId) return;

    if (method === 'thread/realtime/started') {
      if (typeof p.realtimeSessionId === 'string') session.realtimeSessionId = p.realtimeSessionId;
      session.state = 'connecting';
      this.publish({
        type: 'voiceState',
        session: {
          chatId, state: 'connecting',
          realtimeSessionId: session.realtimeSessionId, error: null
        }
      });
      return;
    }
    if (method === 'thread/realtime/sdp') {
      if (typeof p.sdp !== 'string' || !p.sdp) return;
      const waiter = this.voiceStartWaiters.get(chatId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.voiceStartWaiters.delete(chatId);
        session.state = 'live';
        this.publish({
          type: 'voiceState',
          session: {
            chatId, state: 'live',
            realtimeSessionId: session.realtimeSessionId, error: null
          }
        });
        waiter.resolve({ chatId, threadId: session.threadId });
      }
      this.publish({ type: 'voiceSdp', chatId, sdp: p.sdp });
      return;
    }
    if (method === 'thread/realtime/transcript/delta') {
      if (typeof p.delta !== 'string' || !p.delta) return;
      const role = p.role === 'assistant' ? 'assistant' : 'user';
      this.publish({
        type: 'voiceTranscript',
        transcript: { chatId, role, text: p.delta, itemId: null, done: false }
      });
      return;
    }
    if (method === 'thread/realtime/transcript/done') {
      if (typeof p.text !== 'string' || !p.text.trim()) return;
      const role = p.role === 'assistant' ? 'assistant' : 'user';
      const message = this.store.addMessage(chatId, role, p.text.trim());
      this.publish({ type: 'message', message });
      this.publish({
        type: 'voiceTranscript',
        transcript: { chatId, role, text: p.text.trim(), itemId: message.id, done: true }
      });
      this.changed();
      return;
    }
    if (method === 'thread/realtime/error') {
      const message = p.error?.message ?? p.message ?? '实时语音发生错误';
      session.state = 'error';
      session.error = String(message);
      this.publish({
        type: 'voiceState',
        session: {
          chatId, state: 'error',
          realtimeSessionId: session.realtimeSessionId, error: session.error
        }
      });
      this.publish({ type: 'voiceEndRequested', chatId, reason: session.error });
      this.voiceSessions.delete(chatId);
      return;
    }
    if (method === 'thread/realtime/closed') {
      const waiter = this.voiceStartWaiters.get(chatId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.voiceStartWaiters.delete(chatId);
        waiter.reject(new Error(`语音会话在连接前关闭：${p.reason ?? 'unknown'}`));
      }
      if (p.reason !== 'requested' || session.state === 'error') {
        this.publish({ type: 'voiceEndRequested', chatId, reason: `语音连接已关闭：${p.reason ?? 'unknown'}` });
      }
      this.publish({
        type: 'voiceState',
        session: {
          chatId, state: 'error',
          realtimeSessionId: session.realtimeSessionId,
          error: `语音连接已关闭：${p.reason ?? 'unknown'}`
        }
      });
      this.voiceSessions.delete(chatId);
    }
  }

  async account(): Promise<AccountState> {
    await this.runtime.start();
    const result = await this.runtime.request('account/read', { refreshToken: false });
    return { type: result.account?.type ?? null, email: result.account?.email ?? null, requiresLogin: !result.account };
  }
  async login(): Promise<string | null> {
    await this.runtime.start();
    const result = await this.runtime.request('account/login/start', { type: 'chatgpt' });
    return result.authUrl ?? null;
  }
  async models(): Promise<ModelOption[]> {
    await this.runtime.start();
    return (await this.modelCatalog(false)).filter(m => typeof m.model === 'string').map((m: any) => ({
      id: m.model, label: typeof m.displayName === 'string' ? m.displayName : m.model, isDefault: m.isDefault === true
    }));
  }
}
