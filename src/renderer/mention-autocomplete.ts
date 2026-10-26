import type { Bot } from '../shared/contracts';

export interface MentionRange {
  start: number;
  end: number;
  query: string;
}

export interface MentionOption {
  key: string;
  kind: 'bot' | 'everyone';
  botId: string | null;
  name: string;
  detail: string;
}

export function mentionRange(value: string, caret: number | null): MentionRange | null {
  const end = Math.max(0, Math.min(caret ?? value.length, value.length));
  const beforeCaret = value.slice(0, end);
  const start = beforeCaret.lastIndexOf('@');
  if (start < 0) return null;
  if (start > 0 && !/[\s，。！？、；：,.!?;:]/u.test(beforeCaret[start - 1])) return null;

  const query = beforeCaret.slice(start + 1);
  if (query.includes('@') || query.includes('\n') || /\s$/u.test(query)) return null;
  if (query.length > 80) return null;
  return { start, end, query };
}

export function mentionOptions(bots: Bot[], query: string): MentionOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(normalized);
  const startsWith = (name: string) => name.toLocaleLowerCase().startsWith(normalized);
  const sortOptions = (left: MentionOption, right: MentionOption) => {
    const prefixOrder = Number(startsWith(right.name)) - Number(startsWith(left.name));
    return prefixOrder || left.name.localeCompare(right.name, 'zh-CN');
  };

  const members = bots
    .filter(bot => matches(bot.name))
    .map(bot => ({
      key: `bot:${bot.id}`,
      kind: 'bot' as const,
      botId: bot.id,
      name: bot.name,
      detail: bot.role.trim() || '群聊成员'
    }))
    .sort(sortOptions);
  const everyone = matches('everyone')
    ? [{
        key: 'everyone',
        kind: 'everyone' as const,
        botId: null,
        name: 'everyone',
        detail: '邀请所有活跃成员回复'
      }]
    : [];
  return [...members, ...everyone];
}

export function insertMention(
  value: string,
  range: MentionRange,
  name: string
): { value: string; caret: number } {
  const after = value.slice(range.end);
  const separator = /^\s/u.test(after) ? '' : ' ';
  const replacement = `@${name}${separator}`;
  return {
    value: value.slice(0, range.start) + replacement + after,
    caret: range.start + replacement.length
  };
}
