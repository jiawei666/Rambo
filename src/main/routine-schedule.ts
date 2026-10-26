import type { RoutineDefinition, RoutineFrequency, RoutineKind } from '../shared/contracts';

const weekdayMap: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
};

function localParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    weekday: 'short'
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second)
  };
}

function zonedLocalToIso(year: number, month: number, day: number, hour: number, minute: number, timezone: string): string {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = localParts(new Date(guess), timezone);
  const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return new Date(guess - (actual - guess)).toISOString();
}

function addLocalDays(year: number, month: number, day: number, addDays: number) {
  const cursor = new Date(Date.UTC(year, month - 1, day + addDays, 12));
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() };
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

export interface RoutineScheduleInput {
  schedule: string;
  triggerTime: string;
  triggerTimes?: string[] | null;
  kind?: RoutineKind;
  frequency?: RoutineFrequency | null;
  weekday?: number | null;
  dayOfMonth?: number | null;
  runDate?: string | null;
  timezone?: string;
  catchUp?: boolean;
  rememberLastResult?: boolean;
  successNotification?: boolean;
  now?: Date;
}

export interface ParsedRoutineSchedule {
  kind: RoutineKind;
  frequency: RoutineFrequency | null;
  weekday: number | null;
  dayOfMonth: number | null;
  times: string[];
  time: string;
  timezone: string;
  runAt: string | null;
  nextRunAt: string;
  catchUp: boolean;
  rememberLastResult: boolean;
  successNotification: boolean;
  display: string;
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INTERVAL_EXPRESSION = /每\s*\d+\s*(?:分钟|小时)|every\s+\d+\s*(?:minutes?|hours?)/iu;
export const MAX_DAILY_TRIGGER_TIMES = 24 * 60;

export function isUnsupportedIntervalSchedule(schedule: string): boolean {
  return INTERVAL_EXPRESSION.test(schedule);
}

function normalizeTriggerTimes(times: string[]): string[] {
  if (times.length > MAX_DAILY_TRIGGER_TIMES) {
    throw new Error(`每日触发时刻不能超过 ${MAX_DAILY_TRIGGER_TIMES} 个。`);
  }
  const normalized = times.map(value => {
    const time = value.trim();
    if (!TIME_PATTERN.test(time)) throw new Error(`触发时刻“${value}”须为 HH:mm。`);
    return time;
  });
  const unique = [...new Set(normalized)].sort();
  if (!unique.length) throw new Error('周期任务至少需要一个明确的一天内触发时刻。');
  return unique;
}

function inferFrequency(schedule: string): Pick<ParsedRoutineSchedule, 'frequency' | 'weekday' | 'dayOfMonth'> {
  const normalized = schedule.trim().toLowerCase();
  if (INTERVAL_EXPRESSION.test(normalized)) {
    throw new Error('当前不支持“每 N 分钟”这类间隔表达。请把一天内的全部 HH:mm 触发时刻放进 triggerTimes；系统会作为同一条 Routine 执行，不会拆成多条任务。');
  }
  const weekly = normalized.match(/每(?:周|星期)([一二三四五六日天])/) ??
    normalized.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/) ??
    normalized.match(/weekly\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (weekly) return { frequency: 'weekly', weekday: weekdayMap[weekly[1].toLowerCase()] ?? 1, dayOfMonth: null };
  if (/工作日|weekday/.test(normalized)) return { frequency: 'weekdays', weekday: null, dayOfMonth: null };
  if (/每月|monthly/.test(normalized)) return { frequency: 'monthly', weekday: null, dayOfMonth: null };
  if (/每天|每日|daily|every\s+day/.test(normalized)) {
    return { frequency: 'daily', weekday: null, dayOfMonth: null };
  }
  throw new Error('无法识别周期表达。请明确为每天、工作日、每周某天或每月某日；不会自动降级为每天。');
}

export function parseRoutineSchedule(input: RoutineScheduleInput): ParsedRoutineSchedule {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? 'Asia/Shanghai';
  if (!TIME_PATTERN.test(input.triggerTime)) {
    throw new Error('缺少明确的一天内触发时刻。请先向用户追问具体时间；收到 HH:mm 格式的明确答复后再创建任务。');
  }
  const kind = input.kind ?? (input.runDate ? 'once' : /一次|提醒我|at\s+\d{4}/i.test(input.schedule) ? 'once' : 'recurring');
  const inferred = kind === 'once'
    ? { frequency: null, weekday: null, dayOfMonth: null }
    : inferFrequency(input.schedule);
  const frequency = kind === 'once' ? null : input.frequency ?? inferred.frequency;
  const weekday = frequency === 'weekly' ? input.weekday ?? inferred.weekday ?? 1 : null;
  const dayOfMonth = frequency === 'monthly'
    ? input.dayOfMonth ?? (kind === 'once' ? null : localParts(now, timezone).day)
    : null;
  const times = kind === 'once'
    ? [input.triggerTime]
    : normalizeTriggerTimes(input.triggerTimes ?? [input.triggerTime]);
  if (kind === 'once' && !input.runDate) {
    throw new Error('一次性任务缺少执行日期。请先向用户追问具体日期。');
  }
  if (input.runDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.runDate)) throw new Error('一次性任务日期须为 YYYY-MM-DD。');
    const [hour, minute] = input.triggerTime.split(':').map(Number);
    const [year, month, day] = input.runDate.split('-').map(Number);
    const runAt = zonedLocalToIso(year, month, day, hour, minute, timezone);
    if (Date.parse(runAt) <= now.getTime()) {
      return {
        kind, frequency: null, weekday: null, dayOfMonth: null, timezone, times,
        time: input.triggerTime, runAt, nextRunAt: runAt,
        catchUp: input.catchUp ?? true, rememberLastResult: input.rememberLastResult ?? false,
        successNotification: input.successNotification ?? false,
        display: input.schedule.trim()
      };
    }
    return {
      kind, frequency: null, weekday: null, dayOfMonth: null, timezone,
      times, time: input.triggerTime, runAt, nextRunAt: runAt,
      catchUp: input.catchUp ?? true, rememberLastResult: input.rememberLastResult ?? false,
      successNotification: input.successNotification ?? false,
      display: input.schedule.trim()
    };
  }

  const today = localParts(now, timezone);
  let earliest: string | null = null;
  for (let offset = 0; offset < 370; offset += 1) {
    const next = addLocalDays(today.year, today.month, today.day, offset);
    const dayOfWeek = weekdayOf(next.year, next.month, next.day);
    const matches =
      frequency === 'daily' ||
      (frequency === 'weekdays' && dayOfWeek >= 1 && dayOfWeek <= 5) ||
      (frequency === 'weekly' && dayOfWeek === weekday) ||
      (frequency === 'monthly' && next.day === dayOfMonth);
    if (!matches) continue;
    for (const time of times) {
      const [hour, minute] = time.split(':').map(Number);
      const nextRunAt = zonedLocalToIso(next.year, next.month, next.day, hour, minute, timezone);
      if (Date.parse(nextRunAt) > now.getTime()) {
        earliest = nextRunAt;
        break;
      }
    }
    if (earliest) break;
  }
  if (earliest) {
    return {
      ...inferred, kind, frequency, weekday, dayOfMonth, timezone, times, time: times[0],
      runAt: null, nextRunAt: earliest, catchUp: input.catchUp ?? true,
      rememberLastResult: input.rememberLastResult ?? false,
      successNotification: input.successNotification ?? false,
      display: input.schedule.trim()
    };
  }
  throw new Error('无法计算下一次执行时间');
}

export function followingRun(definition: Pick<RoutineDefinition,
  'kind' | 'frequency' | 'weekday' | 'dayOfMonth' | 'times' | 'time' | 'timezone'>, after: Date): string | null {
  if (definition.kind === 'once' || !definition.frequency) return null;
  const parsed = parseRoutineSchedule({
    schedule: definition.frequency, triggerTime: definition.time, kind: 'recurring',
    triggerTimes: definition.times,
    frequency: definition.frequency, weekday: definition.weekday, dayOfMonth: definition.dayOfMonth,
    timezone: definition.timezone, now: after
  });
  return parsed.nextRunAt;
}

export function missedWindow(now: Date, scheduledFor: string): 'catchUp' | 'missed' {
  return now.getTime() - Date.parse(scheduledFor) <= 12 * 60 * 60 * 1000 ? 'catchUp' : 'missed';
}
