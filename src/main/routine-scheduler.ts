import type { AppEvent, RoutineListItem, RoutineRun, TurnStatus } from '../shared/contracts';
import type { Host } from './host';
import type { Store } from './store';

const CATCH_UP_WINDOW_MS = 12 * 60 * 60 * 1000;
const EXECUTING_RUN_STATUSES = new Set<string>(['pending', 'running']);
const BLOCKING_RUN_STATUSES = new Set<string>(['pending', 'running', 'needs_user']);
const LAST_RESULT_LIMIT = 2_000;

export type RoutineRecoveryResolution =
  | { state: 'retry' }
  | { state: 'running' }
  | { state: 'completed'; text: string }
  | { state: 'needs_user'; reason: string };

export interface RoutineSchedulerOptions {
  now?: () => Date;
  intervalMs?: number;
  autoStart?: boolean;
}

export interface RoutineDispatcher {
  run(runId: string, routine: RoutineListItem, prompt: string): Promise<void>;
  recover?(run: RoutineRun): Promise<RoutineRecoveryResolution>;
  /** Resolve only after the source chat has completed its result handoff. */
  deliverResult?(runId: string): Promise<void> | void;
}

export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private readonly runsByTurn = new Map<string, string>();
  private dispatcher: RoutineDispatcher | null = null;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly publish: (event: AppEvent) => void;
  private readonly deliveryTasks = new Set<Promise<void>>();

  constructor(
    private readonly store: Store,
    publish: (event: AppEvent) => void,
    options: RoutineSchedulerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 15_000;
    this.publish = publish;
    for (const run of store.routineRuns()) {
      if (run.turnId && run.chatId && EXECUTING_RUN_STATUSES.has(run.status)) {
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
      .find(run => BLOCKING_RUN_STATUSES.has(run.status)) ?? null;
  }

  async recoverAfterRestart(): Promise<void> {
    if (!this.dispatcher) return;
    let changed = false;
    for (const run of this.store.routineRuns()) {
      if (!EXECUTING_RUN_STATUSES.has(run.status)) continue;
      let resolution: RoutineRecoveryResolution = run.status === 'pending'
        ? { state: 'retry' }
        : { state: 'needs_user', reason: '上次运行已经开始，但无法确认外部操作是否完成；请检查执行记录后再决定是否重新运行。' };
      if (run.status === 'running' && this.dispatcher.recover) {
        try {
          resolution = await this.dispatcher.recover(run);
        } catch (error) {
          resolution = {
            state: 'needs_user',
            reason: `无法核对上次运行状态：${error instanceof Error ? error.message : String(error)}`
          };
        }
      }
      if (resolution.state === 'running') continue;
      if (resolution.state === 'completed') {
        this.completeRun(run.id, 'completed', resolution.text);
        changed = true;
        continue;
      }
      if (resolution.state === 'needs_user') {
        this.markNeedsUser(run.id, resolution.reason);
        changed = true;
        continue;
      }
      const recovered = this.store.claimRoutineRunRecovery(run.id);
      if (!recovered) {
        this.markNeedsUser(
          run.id,
          '本次运行已达到一次自动恢复上限；请检查执行记录后再决定是否重新运行。'
        );
        changed = true;
        continue;
      }
      try {
        await this.execute(recovered, this.store.routine(recovered.routineId));
      } catch (error) {
        this.markNeedsUser(
          recovered.id,
          `自动恢复未能确认结果：${error instanceof Error ? error.message : String(error)}`
        );
      }
      changed = true;
    }
    const disabledLegacyIds = this.store.disableUnsupportedLegacyRoutines();
    if (changed || disabledLegacyIds.length) this.publish({ type: 'changed' });
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

      const trigger = age > 60_000 ? 'catchUp' : 'schedule';
      const dedupeKey = `routine:${routine.id}:scheduled:${scheduledFor}`;
      let run: RoutineRun;
      try {
        run = this.store.createRoutineRun({
          routineId: routine.id, scheduledFor, trigger,
          status: 'running', process: '本机后台调度已开始', dedupeKey
        });
      } catch (error) {
        if (!(error instanceof Error) || !/UNIQUE|constraint/i.test(error.message)) throw error;
        // Another scheduler instance already claimed this occurrence. Never
        // convert a stored run into success just because its insert collided.
        this.store.markRoutineScheduled(routine.id, scheduledFor, at);
        continue;
      }
      this.store.markRoutineScheduled(routine.id, scheduledFor, at);
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
    if (routine.definition.kind === 'once' && routine.nextRunAt) {
      this.store.clearRoutineNextRun(routine.id);
    }
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
        const detail = error instanceof Error ? error.message : String(error);
        if (error && typeof error === 'object' && 'outcomeUnknown' in error &&
            (error as { outcomeUnknown?: unknown }).outcomeUnknown === true) {
          this.markNeedsUser(run.id, `执行结果尚未确认：${detail}`);
          this.publish({ type: 'changed' });
        } else {
          this.completeRun(run.id, 'failed', undefined, detail);
        }
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
    if (!EXECUTING_RUN_STATUSES.has(run.status)) return;
    const summary = (text ?? run.summary ?? (status === 'completed' ? run.routineTitle : '')).trim() || null;
    this.store.updateRoutineRun(runId, {
      status: status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'interrupted' : 'failed',
      summary,
      error: status === 'completed' ? null : error ?? '任务执行未完成',
      completedAt: this.now().toISOString()
    });
    this.publish({ type: 'changed' });
    this.publish({ type: 'routineRunFinished', runId });
    if (run.sourceChatId && this.dispatcher?.deliverResult) {
      const delivery = Promise.resolve()
        .then(() => this.dispatcher?.deliverResult?.(runId))
        .then(() => {})
        .catch(() => {
          // The terminal run remains persisted; delivery failure must not rewrite its result.
        })
        .finally(() => { this.deliveryTasks.delete(delivery); });
      this.deliveryTasks.add(delivery);
    }
  }

  async waitForDeliveries(): Promise<void> {
    while (this.deliveryTasks.size) await Promise.all([...this.deliveryTasks]);
  }

  consumeOneTimeDefinition(runId: string): void {
    const run = this.store.routineRun(runId);
    if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'interrupted') return;
    const routine = this.store.routines().find(item => item.id === run.routineId);
    if (routine?.definition.kind !== 'once') return;
    this.store.deleteRoutine(routine.id);
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

  private markNeedsUser(runId: string, reason: string): void {
    const before = this.store.routineRun(runId).status;
    const run = this.store.markRoutineRunNeedsUser(runId, reason);
    if (before !== 'needs_user' && run.status === 'needs_user') {
      this.publish({ type: 'routineRunFinished', runId });
    }
  }
}

export function createRoutineDispatcher(host: Host, scheduler: RoutineScheduler): RoutineDispatcher {
  return {
    recover(run) {
      return host.recoverRoutineRun(run);
    },
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
        routine.definition.execution.mode === 'script'
          ? [
              '本次要求以脚本方式执行。先根据任务内容和执行模板编写可在当前工作区运行的脚本，再运行并核验结果。',
              '不得绕过当前 Codex 权限、审批或系统限制；需要审批时按正常工具流程处理。',
              routine.definition.execution.template
                ? `脚本执行模板：\n${routine.definition.execution.template}`
                : ''
            ].filter(Boolean).join('\n')
          : routine.definition.execution.mode === 'hybrid'
            ? [
                '本次要求结合对话判断与脚本执行：先完成需要模型判断或上下文处理的部分，再把适合确定执行的部分落实为脚本并运行。',
                '不得绕过当前 Codex 权限、审批或系统限制。',
                routine.definition.execution.template
                  ? `脚本执行模板：\n${routine.definition.execution.template}`
                  : ''
              ].filter(Boolean).join('\n')
            : '',
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
    },
    async deliverResult(runId) {
      await host.deliverRoutineResult(runId);
      // Consume a one-time definition only after its result handoff succeeds.
      // Run history, source-chat messages and generated artifacts remain.
      scheduler.consumeOneTimeDefinition(runId);
    }
  };
}
