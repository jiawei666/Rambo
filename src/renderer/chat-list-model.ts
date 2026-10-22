import type { Bot, Chat } from '../shared/contracts';

export function shouldShowReturnToChat(view: string): boolean {
  return view !== 'chat' && view !== 'group-chat';
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
