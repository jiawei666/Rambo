import type { Bot, Chat, GroupChat } from '../shared/contracts';

export type SidebarConversationItem =
  | { kind: 'bot'; bot: Bot; createdAt: string; pinnedAt: string | null }
  | { kind: 'group'; group: GroupChat; createdAt: string; pinnedAt: string | null };

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
