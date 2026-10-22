import type { AppEvent, RoutineListItem, RoutineRun, TurnStatus } from '../shared/contracts';
import type { Host } from './host';
import type { Store } from './store';

const CATCH_UP_WINDOW_MS = 12 * 60 * 60 * 1000;
const ACTIVE_RUN_STATUSES = new Set<string>(['pending', 'running']);
const LAST_RESULT_LIMIT = 2_000;

export interface RoutineSchedulerOptions {
  now?: () => Date;
  intervalMs?: number;
  autoStart?: boolean;
}

export interface RoutineDispatcher {
  run(runId: string, routine: RoutineListItem, prompt: string): Promise<void>;
}

export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private readonly runsByTurn = new Map<string, string>();
  private dispatcher: RoutineDispatcher | null = null;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly publish: (event: AppEvent) => void;

  constructor(
    private readonly store: Store,
    publish: (event: AppEvent) => void,
    options: RoutineSchedulerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 15_000;
    this.publish = publish;
    for (const run of store.routineRuns()) {
      if (run.turnId && run.chatId && ACTIVE_RUN_STATUSES.has(run.status)) {
        this.runsByTurn.set(`${run.chatId}:${run.turnId}`, run.id);
      }
    }
    if (options.autoStart !== false) {
      this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  setDispatcher(dispatcher: RoutineDispatcher): void {
    this.dispatcher = dispatcher;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(at = this.now()): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.processDue(at).finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private activeRunFor(routineId: string): RoutineRun | null {
    return this.store.routineRuns(routineId)
      .find(run => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
  }

  private advancePastDue(routine: RoutineListItem, at: Date): RoutineListItem {
    let current = routine;
    while (current.definition.kind === 'recurring' && current.nextRunAt &&
        Date.parse(current.nextRunAt) <= at.getTime()) {
      current = this.store.markRoutineScheduled(current.id, current.nextRunAt, at);
    }
    return current;
  }

  private async processDue(at: Date): Promise<void> {
    const due = this.store.dueRoutines(at);
    for (const routine of due) {
      const scheduledFor = routine.nextRunAt;
      if (!scheduledFor) continue;
      const active = this.activeRunFor(routine.id);
      if (active) {
        const skipped = this.store.createRoutineRun({
          routineId: routine.id, scheduledFor, trigger: 'skip', status: 'skipped',
          process: '上一轮尚未结束，本轮跳过且不积压'
        });
        this.store.updateRoutineRun(skipped.id, {
          summary: '上一轮仍在执行、等待或停放中，本轮跳过',
          completedAt: at.toISOString()
        });
        this.advancePastDue(routine, at);
        this.publish({ type: 'changed' });
        continue;
      }

      const age = at.getTime() - Date.parse(scheduledFor);
      const oneTimeMissed = routine.definition.kind === 'once' && age > 60_000;
      const beyondWindow = age > CATCH_UP_WINDOW_MS;
      const catchUpDisabled = age > 60_000 && !routine.definition.catchUp;
      if (oneTimeMissed || beyondWindow || catchUpDisabled) {
        const missed = this.store.createRoutineRun({
          routineId: routine.id, scheduledFor,
          trigger: 'schedule', status: 'missed',
          process: oneTimeMissed
            ? '一次性任务已错过计划时间，需手动立即运行'
            : beyondWindow
              ? '错过超过 12 小时，标记错过且不自动补跑'
              : '该 Routine 已关闭补跑'
        });
        this.store.updateRoutineRun(missed.id, {
          summary: missed.process, completedAt: at.toISOString()
        });
        if (routine.definition.kind === 'once') this.store.clearRoutineNextRun(routine.id);
        else this.advancePastDue(routine, at);
        this.publish({ type: 'changed' });
        continue;
      }

      this.store.markRoutineScheduled(routine.id, scheduledFor, at);
      const run = this.store.createRoutineRun({
        routineId: routine.id, scheduledFor,
        trigger: age > 60_000 ? 'catchUp' : 'schedule',
        status: 'running', process: '本机后台调度已开始'
      });
      this.store.updateRoutineRun(run.id, { startedAt: at.toISOString() });
      this.publish({ type: 'changed' });
      await this.execute(run, routine);
    }
  }

  async runNow(routineId: string): Promise<RoutineRun> {
    const routine = this.store.routine(routineId);
    if (routine.status === 'paused') throw new Error('请先恢复这条定时任务');
    if (this.activeRunFor(routineId)) throw new Error('这条定时任务仍在执行，请等待当前运行结束');
    const run = this.store.createRoutineRun({
      routineId, scheduledFor: this.now().toISOString(), trigger: 'manual',
      status: 'running', process: '用户手动立即运行'
    });
    const started = this.store.updateRoutineRun(run.id, { startedAt: this.now().toISOString() });
    this.publish({ type: 'changed' });
    await this.execute(started, routine);
    return this.store.routineRun(run.id);
  }

  private async execute(run: RoutineRun, routine: RoutineListItem): Promise<void> {
    if (!this.dispatcher) {
      this.completeRun(run.id, 'failed', undefined, '后台执行器尚未就绪');
      return;
    }
    try {
      await this.dispatcher.run(run.id, routine, routine.definition.instruction);
    } catch (error) {
      const current = this.store.routineRun(run.id);
      if (current.status === 'running') {
        this.completeRun(run.id, 'failed', undefined,
          error instanceof Error ? error.message : String(error));
      }
      this.publish({ type: 'changed' });
    }
  }

  attachTurn(runId: string, chatId: string, turnId: string): void {
    this.store.updateRoutineRun(runId, { chatId, turnId });
    this.runsByTurn.set(`${chatId}:${turnId}`, runId);
    this.publish({ type: 'changed' });
  }

  completeTurn(chatId: string, turnId: string, status: TurnStatus, text?: string, error?: string): void {
    const runId = this.runsByTurn.get(`${chatId}:${turnId}`);
    if (!runId) return;
    this.runsByTurn.delete(`${chatId}:${turnId}`);
    this.completeRun(runId, status, text, error);
  }

  completeRun(runId: string, status: TurnStatus, text?: string, error?: string): void {
    const run = this.store.routineRun(runId);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) return;
    const summary = status === 'completed'
      ? (text ?? run.summary ?? run.routineTitle).trim().slice(0, 500)
      : null;
    this.store.updateRoutineRun(runId, {
      status: status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'interrupted' : 'failed',
      summary,
      error: status === 'completed' ? null : error ?? '任务执行未完成',
      completedAt: this.now().toISOString()
    });
    if (run.sourceChatId) {
      const label = status === 'completed' ? '已完成' : status === 'interrupted' ? '已中断' : '失败';
      try {
        this.store.addMessage(
          run.sourceChatId, 'system',
          `定时任务「${run.routineTitle}」${label}。${summary ? `结果：${summary.slice(0, 240)}` : ''}`,
          status === 'completed' ? 'complete' : status === 'interrupted' ? 'interrupted' : 'failed'
        );
      } catch { /* the source chat may have been permanently removed */ }
    }
    this.publish({ type: 'changed' });
  }

  stopPending(routineId: string, reason: string): void {
    for (const run of this.store.routineRuns(routineId)) {
      if (run.status !== 'pending') continue;
      this.store.updateRoutineRun(run.id, {
        status: 'interrupted', error: reason, completedAt: this.now().toISOString()
      });
    }
    this.publish({ type: 'changed' });
  }

  failRun(runId: string, reason: string, chatId?: string): void {
    if (chatId) this.store.updateRoutineRun(runId, { chatId });
    this.completeRun(runId, 'failed', undefined, reason);
  }
}

export function createRoutineDispatcher(host: Host, scheduler: RoutineScheduler): RoutineDispatcher {
  return {
    async run(runId, routine, prompt) {
      const chat = host.store.createRoutineExecutionChat(
        runId,
        routine.botId,
        `定时任务：${routine.title}`
      );
      const chatId = chat.id;
      const prefix = routine.definition.rememberLastResult && routine.lastRun?.summary
        ? `上一次运行的简短结果：${routine.lastRun.summary.slice(0, LAST_RESULT_LIMIT)}\n\n`
        : '';
      const routineContext = [
        `这是 Routine「${routine.title}」的独立后台运行。`,
        '使用当前 Bot 的长期职责、长期指令、配置和已保存记忆；不要把本次完整内部过程写回来源私聊。',
        prefix ? prefix.trim() : ''
      ].filter(Boolean).join('\n\n');
      await host.runRoutineConversation(
        chatId,
        prompt,
        routineContext,
        routine.definition.rememberLastResult
      );
      const activeTurnId = host.activeTurns.get(chatId);
      if (!activeTurnId) {
        scheduler.failRun(runId, 'Codex 没有返回可关联的 turn', chatId);
        return;
      }
      scheduler.attachTurn(runId, chatId, activeTurnId);
    }
  };
}
