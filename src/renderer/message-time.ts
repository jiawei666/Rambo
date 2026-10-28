const TIME_DIVIDER_GAP_MS = 15 * 60 * 1000;

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shouldShowMessageDivider(
  previousCreatedAt: string | null | undefined,
  currentCreatedAt: string
): boolean {
  const current = validDate(currentCreatedAt);
  if (!current) return false;
  const previous = validDate(previousCreatedAt);
  if (!previous) return true;
  if (previous.toDateString() !== current.toDateString()) return true;
  return current.getTime() - previous.getTime() >= TIME_DIVIDER_GAP_MS;
}

export function shouldShowMessageTimeDivider<T extends {
  role: string;
  createdAt: string;
}>(messages: readonly T[], index: number): boolean {
  const current = messages[index];
  if (!current || current.role === 'system') return false;

  let previousCreatedAt: string | null = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role !== 'system') {
      previousCreatedAt = messages[cursor].createdAt;
      break;
    }
  }
  return shouldShowMessageDivider(previousCreatedAt, current.createdAt);
}

function chineseWeekday(date: Date): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()] ?? '';
}

export function formatMessageDivider(value: string): string {
  const date = validDate(value);
  if (!date) return value;
  return `${date.getMonth() + 1}月${date.getDate()}日${chineseWeekday(date)} ` +
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatMessageHoverTime(value: string): string {
  const date = validDate(value);
  if (!date) return value;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${chineseWeekday(date)} ` +
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
