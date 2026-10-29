import type {
  ActivityKind,
  Bot,
  Chat,
  GroupChat,
  GroupRuntimeMember,
  ModelSourceState,
  RoutineRun
} from '../shared/contracts';

export type SidebarConversationItem =
  | { kind: 'bot'; bot: Bot; createdAt: string; pinnedAt: string | null }
  | { kind: 'group'; group: GroupChat; createdAt: string; pinnedAt: string | null };

export type SidebarRunKind = 'conversation' | 'routine' | 'mixed';

export interface SidebarBotRunState {
  running: boolean;
  kind: SidebarRunKind | null;
  conversationRunning: boolean;
  routineRunCount: number;
  label: string;
}

export interface SidebarGroupRunState {
  running: boolean;
  label: string;
  activityKind: ActivityKind | null;
}

export type SidebarPrimaryActionKind = 'configure' | 'checking' | 'create';

export interface SidebarPrimaryAction {
  kind: SidebarPrimaryActionKind;
  label: string;
  description: string;
}

/**
 * The sidebar has one primary action. A fresh install must finish the Codex
 * runtime/account setup before offering Bot creation; an existing setup should
 * go straight to creating a Bot.
 */
export function sidebarPrimaryAction(input: {
  runtimeStatus: 'stopped' | 'starting' | 'ready' | 'error';
  executionDefaultsReady: boolean;
  modelSource: Pick<ModelSourceState, 'kind' | 'manual' | 'hasApiKey'>;
  accountReady: boolean | null;
}): SidebarPrimaryAction {
  const manualReady = input.modelSource.kind === 'manualApi' &&
    Boolean(
      input.modelSource.manual.baseUrl.trim() &&
      input.modelSource.manual.model.trim() &&
      input.modelSource.hasApiKey
    );
  const requiresAccount = input.modelSource.kind !== 'manualApi';
  if (input.runtimeStatus !== 'ready' || !input.executionDefaultsReady) {
    return {
      kind: 'configure',
      label: '配置 Codex',
      description: '先完成运行时和账号设置'
    };
  }
  if (requiresAccount && input.accountReady === null) {
    return {
      kind: 'checking',
      label: '正在检查配置',
      description: '正在读取 Codex 账号状态'
    };
  }
  if ((requiresAccount && !input.accountReady) ||
      (input.modelSource.kind === 'manualApi' && !manualReady)) {
    return {
      kind: 'configure',
      label: '配置 Codex',
      description: '连接账号或配置 API 后开始创建 Bot'
    };
  }
  return {
    kind: 'create',
    label: '创建 Bot',
    description: '开始和你的 Bot 对话'
  };
}

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  reasoning: '正在思考',
  command: '正在运行命令',
  file: '正在处理文件',
  web: '正在搜索网页',
  mcp: '正在调用工具',
  tool: '正在调用工具',
  plan: '正在整理计划',
  image: '正在生成图片',
  collab: '正在协作',
  other: '正在处理'
};

export function sidebarBotRunState(
  botId: string,
  chatId: string | null,
  activeTurns: Readonly<Record<string, string>>,
  startingTurns: Readonly<Record<string, boolean>>,
  routineRuns: ReadonlyArray<Pick<RoutineRun, 'botId' | 'status'>>
): SidebarBotRunState {
  const conversationRunning = Boolean(chatId && (
    activeTurns[chatId] || startingTurns[chatId]
  ));
  const routineRunCount = routineRuns.filter(run =>
    run.botId === botId && run.status === 'running'
  ).length;
  const kind: SidebarRunKind | null = conversationRunning && routineRunCount > 0
    ? 'mixed'
    : conversationRunning
      ? 'conversation'
      : routineRunCount > 0
        ? 'routine'
        : null;
  return {
    running: kind !== null,
    kind,
    conversationRunning,
    routineRunCount,
    label: kind === 'conversation'
      ? '对话运行中'
      : kind === 'routine'
        ? `${routineRunCount} 个任务运行中`
        : kind === 'mixed'
          ? `对话与 ${routineRunCount} 个任务运行中`
          : ''
  };
}

export function sidebarGroupRunState(
  members: ReadonlyArray<Pick<
    GroupRuntimeMember,
    'botId' | 'phase' | 'activityKind' | 'activityUpdatedAt'
  >>
): SidebarGroupRunState {
  const activeMembers = [...new Map(members.map(member => [member.botId, member])).values()];
  if (!activeMembers.length) return { running: false, label: '', activityKind: null };
  if (activeMembers.length > 1) {
    return {
      running: true,
      label: `${activeMembers.length} 位成员协作中`,
      activityKind: null
    };
  }
  const member = activeMembers[0];
  return {
    running: true,
    activityKind: member.phase === 'working' ? member.activityKind : null,
    label: member.phase === 'working' && member.activityKind
      ? ACTIVITY_LABELS[member.activityKind]
      : member.phase === 'starting'
        ? '正在读消息'
        : member.phase === 'judging'
          ? '正在判断'
          : '正在思考'
  };
}

export function shouldShowReturnToChat(view: string): boolean {
  return view !== 'chat' && view !== 'group-chat' && view !== 'connectors';
}

export function partitionBotChats(chats: Chat[], botId: string): { active: Chat[]; archived: Chat[] } {
  const sorted = chats
    .filter(chat => chat.botId === botId)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    active: sorted.filter(chat => !chat.archived),
    archived: sorted.filter(chat => chat.archived)
  };
}

export function privateChatForBot(chats: Chat[], botId: string): Chat | null {
  return partitionBotChats(chats, botId).active[0] ?? null;
}

export function selectedPrivateChat(chats: Chat[], chatId: string | null, botId: string | null): Chat | null {
  if (!chatId || !botId) return null;
  return chats.find(chat => chat.id === chatId && chat.botId === botId && !chat.archived) ?? null;
}

export function partitionBots(bots: Bot[]): { active: Bot[]; archived: Bot[] } {
  return {
    active: bots.filter(bot => !bot.archived),
    archived: bots.filter(bot => bot.archived)
  };
}

function compareSidebarConversations(
  left: SidebarConversationItem,
  right: SidebarConversationItem
): number {
  if (left.pinnedAt && right.pinnedAt) {
    const pinnedOrder = right.pinnedAt.localeCompare(left.pinnedAt);
    if (pinnedOrder) return pinnedOrder;
  } else if (left.pinnedAt) {
    return -1;
  } else if (right.pinnedAt) {
    return 1;
  }

  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);
  if (createdAtOrder) return createdAtOrder;
  const leftId = left.kind === 'bot' ? left.bot.id : left.group.id;
  const rightId = right.kind === 'bot' ? right.bot.id : right.group.id;
  return rightId.localeCompare(leftId);
}

export function sidebarConversations(bots: Bot[], groups: GroupChat[]): SidebarConversationItem[] {
  return [
    ...bots
      .filter(bot => !bot.archived)
      .map((bot): SidebarConversationItem => ({
        kind: 'bot',
        bot,
        createdAt: bot.createdAt,
        pinnedAt: bot.pinnedAt
      })),
    ...groups
      .filter(group => !group.archived)
      .map((group): SidebarConversationItem => ({
        kind: 'group',
        group,
        createdAt: group.createdAt,
        pinnedAt: group.pinnedAt
      }))
  ].sort(compareSidebarConversations);
}
