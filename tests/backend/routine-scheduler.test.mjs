import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const storeSource = readFileSync(new URL('../../src/main/store.ts', import.meta.url), 'utf8');
const contractsSource = readFileSync(new URL('../../src/shared/contracts.ts', import.meta.url), 'utf8');
const robotAvatarSource = readFileSync(new URL('../../src/shared/robot-avatar.ts', import.meta.url), 'utf8');
const scheduleSource = readFileSync(new URL('../../src/main/routine-schedule.ts', import.meta.url), 'utf8');
const schedulerSource = readFileSync(new URL('../../src/main/routine-scheduler.ts', import.meta.url), 'utf8');

async function withModules(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-routine-scheduler-test-'));
  writeFileSync(
    join(directory, 'routine-schedule.mjs'),
    ts.transpileModule(scheduleSource, { compilerOptions }).outputText,
    { mode: 0o600 }
  );
  writeFileSync(
    join(directory, 'store.mjs'),
    ts.transpileModule(storeSource, { compilerOptions }).outputText
      .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'")
      .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
      .replaceAll("from '../shared/robot-avatar'", "from './robot-avatar.mjs'"),
    { mode: 0o600 }
  );
  writeFileSync(join(directory, 'contracts.mjs'),
    ts.transpileModule(contractsSource, { compilerOptions }).outputText, { mode: 0o600 });
  writeFileSync(join(directory, 'robot-avatar.mjs'),
    ts.transpileModule(robotAvatarSource, { compilerOptions }).outputText, { mode: 0o600 });
  writeFileSync(
    join(directory, 'routine-scheduler.mjs'),
    ts.transpileModule(schedulerSource, { compilerOptions }).outputText,
    { mode: 0o600 }
  );
  try {
    const [{ Store }, { RoutineScheduler }] = await Promise.all([
      import(`${pathToFileURL(join(directory, 'store.mjs')).href}?${Date.now()}`),
      import(`${pathToFileURL(join(directory, 'routine-scheduler.mjs')).href}?${Date.now()}`)
    ]);
    const store = new Store(directory);
    store.setSetting('defaultBotModel', 'test-model');
    store.setSetting('defaultBotPermission', 'fullAccess');
    try { await run({ Store, RoutineScheduler, store, directory }); }
    finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('local scheduler executes one-time and recurring routines and records independent runs', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Scheduler Bot', 'a');
    const now = new Date('2026-10-22T01:00:00.000Z');
    const once = store.createRoutine({
      botId: bot.id, title: 'One-time', instruction: '生成一次性报告',
      schedule: '一次性', time: '09:30', kind: 'once', runDate: '2026-10-22',
      sourceCallId: 'once', now
    });
    const recurring = store.createRoutine({
      botId: bot.id, title: 'Daily', instruction: '生成每日报告',
      schedule: '每天', time: '09:30', kind: 'recurring', frequency: 'daily',
      sourceCallId: 'daily', now
    });
    const calls = [];
    const events = [];
    const scheduler = new RoutineScheduler(store, event => events.push(event), {
      autoStart: false, now: () => now
    });
    scheduler.setDispatcher({ run: async (runId, routine) => calls.push([runId, routine.id]) });
    await scheduler.tick(new Date('2026-10-22T01:30:00.000Z'));

    assert.deepEqual(calls.map(call => call[1]).sort(), [once.id, recurring.id].sort());
    const runs = store.routineRuns();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map(run => run.status).sort(), ['running', 'running']);
    assert.equal(store.routine(once.id).nextRunAt, null);
    assert.ok(store.routine(recurring.id).nextRunAt);
  });
});

test('one recurring Routine accepts ordered arbitrary trigger times in one day', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Multi-time Bot', 'a');
    const now = new Date('2026-10-25T00:10:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id,
      title: 'Three daily checks',
      instruction: 'Check the inbox.',
      schedule: '每天',
      triggerTimes: ['04:50', '00:00', '01:30', '01:30'],
      sourceCallId: 'multi-time',
      now,
      timezone: 'Asia/Shanghai'
    });

    assert.equal(routine.definition.kind, 'recurring');
    assert.deepEqual(routine.definition.times, ['00:00', '01:30', '04:50']);
    assert.equal(routine.definition.time, '00:00');
    assert.equal(routine.nextRunAt, '2026-10-25T16:00:00.000Z');

    store.markRoutineScheduled(routine.id, routine.nextRunAt, new Date('2026-10-25T16:00:01.000Z'));
    assert.equal(store.routine(routine.id).nextRunAt, '2026-10-25T17:30:00.000Z');
  });
});

test('scheduled occurrences are claimed once for the same routine and scheduled time', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Occurrence Bot', 'a');
    const now = new Date('2026-10-25T00:10:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id,
      title: 'One occurrence',
      instruction: 'Check once.',
      schedule: '每天',
      time: '09:00',
      sourceCallId: 'one-occurrence',
      now
    });
    store.db.prepare('UPDATE routines SET nextRunAt=? WHERE id=?')
      .run('2026-10-25T01:00:00.000Z', routine.id);
    const calls = [];
    const makeScheduler = () => {
      const scheduler = new RoutineScheduler(store, () => {}, {
        autoStart: false, now: () => now
      });
      scheduler.setDispatcher({
        run: async (runId, current) => calls.push({ runId, routineId: current.id })
      });
      return scheduler;
    };
    const first = makeScheduler();
    const second = makeScheduler();
    await first.tick(new Date('2026-10-25T01:00:01.000Z'));
    await second.tick(new Date('2026-10-25T01:00:01.000Z'));
    assert.equal(calls.length, 1);
    assert.equal(store.routineRuns(routine.id).filter(run =>
      run.scheduledFor === '2026-10-25T01:00:00.000Z' &&
      run.status !== 'skipped').length, 1);
    first.stop();
    second.stop();
  });
});

test('unknown recurring schedule and minute interval expressions fail closed without persistence', async () => {
  await withModules(async ({ store }) => {
    const { bot } = store.createBot('Strict schedule Bot', 'a');
    const base = {
      botId: bot.id,
      instruction: 'Do the work.',
      time: '09:00',
      kind: 'recurring',
      sourceCallId: 'strict-schedule'
    };

    assert.throws(() => store.createRoutine({
      ...base, title: 'Unknown', schedule: '隔天一次', sourceCallId: 'unknown-schedule'
    }), /无法识别周期表达.*不会自动降级为每天/u);
    assert.throws(() => store.createRoutine({
      ...base, title: 'Interval', schedule: '每天每 30 分钟', sourceCallId: 'interval-schedule'
    }), /不支持.*每 N 分钟.*triggerTimes/u);
    assert.throws(() => store.createRoutine({
      ...base,
      title: 'Too many',
      schedule: '每天',
      triggerTimes: Array.from({ length: 24 * 60 + 1 }, (_, index) => `${String(index % 24).padStart(2, '0')}:00`),
      sourceCallId: 'too-many-times'
    }), /不能超过 1440 个/u);
    assert.deepEqual(store.routines(), []);
  });
});

test('updating only triggerTimes or triggerTime replaces the ordered time list', async () => {
  await withModules(async ({ store }) => {
    const { bot } = store.createBot('Update times Bot', 'a');
    const now = new Date('2026-10-25T00:10:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id,
      title: 'Update times',
      instruction: 'Do the work.',
      schedule: '每天',
      triggerTimes: ['00:00', '01:30', '04:50'],
      sourceCallId: 'update-times',
      now,
      timezone: 'Asia/Shanghai'
    });

    const updatedList = store.updateRoutine(routine.id, {
      triggerTimes: ['22:00', '06:15'], now
    });
    assert.deepEqual(updatedList.definition.times, ['06:15', '22:00']);
    assert.equal(updatedList.definition.time, '06:15');

    const updatedSingle = store.updateRoutine(routine.id, {
      time: '23:45', now
    });
    assert.deepEqual(updatedSingle.definition.times, ['23:45']);
    assert.equal(updatedSingle.definition.time, '23:45');
  });
});

test('a claimed run keeps the complete plan snapshot after the routine is edited', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Snapshot Bot', 'a');
    const now = new Date('2026-10-25T00:10:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id,
      title: 'Plan snapshot',
      instruction: 'Run the original instruction.',
      schedule: '每天',
      triggerTimes: ['00:00', '01:30', '04:50'],
      sourceCallId: 'plan-snapshot',
      now,
      timezone: 'Asia/Shanghai',
      executionMode: 'script',
      executionTemplate: 'Run the original script.'
    });
    store.db.prepare('UPDATE routines SET nextRunAt=? WHERE id=?')
      .run('2026-10-25T01:00:00.000Z', routine.id);
    let claimed;
    const scheduler = new RoutineScheduler(store, () => {}, {
      autoStart: false,
      now: () => now
    });
    scheduler.setDispatcher({
      run: async runId => {
        claimed = store.routineRun(runId);
      }
    });
    await scheduler.tick(new Date('2026-10-25T01:00:01.000Z'));
    const originalVersion = claimed.definitionVersion;
    assert.deepEqual(claimed.definition.times, ['00:00', '01:30', '04:50']);
    assert.equal(claimed.definition.execution.mode, 'script');
    assert.equal(claimed.definition.execution.template, 'Run the original script.');

    const updated = store.updateRoutine(routine.id, {
      instruction: 'Run the replacement instruction.',
      triggerTimes: ['22:00'],
      executionMode: 'chat',
      executionTemplate: null,
      now
    });
    const historical = store.routineRun(claimed.id);
    assert.equal(historical.instruction, 'Run the original instruction.');
    assert.deepEqual(historical.definition.times, ['00:00', '01:30', '04:50']);
    assert.equal(historical.definition.execution.template, 'Run the original script.');
    assert.equal(historical.definitionVersion, originalVersion);
    assert.deepEqual(updated.definition.times, ['22:00']);
    assert.equal(updated.definition.execution.mode, 'chat');
  });
});

test('changing daily to weekly clears the old daily-only schedule data', async () => {
  await withModules(async ({ store }) => {
    const { bot } = store.createBot('Frequency update Bot', 'a');
    const now = new Date('2026-10-25T00:10:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id,
      title: 'Frequency update',
      instruction: 'Do the work.',
      schedule: '每天',
      time: '09:00',
      sourceCallId: 'frequency-update',
      now,
      timezone: 'Asia/Shanghai'
    });
    assert.equal(routine.definition.frequency, 'daily');

    const updated = store.updateRoutine(routine.id, {
      schedule: '每周一',
      now: new Date('2026-10-26T00:10:00.000Z')
    });
    assert.equal(updated.definition.frequency, 'weekly');
    assert.equal(updated.definition.weekday, 1);
    assert.equal(updated.definition.dayOfMonth, null);
    assert.ok(updated.nextRunAt);
  });
});

test('startup retries safe Routine runs at most once and parks ambiguous runs for the user', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Reconcile Bot', 'a');
    const now = new Date('2026-10-25T00:10:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id,
      title: 'Reconcile',
      instruction: 'Do the work.',
      schedule: '每天',
      time: '09:00',
      sourceCallId: 'reconcile',
      now
    });
    const pending = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-25T01:00:00.000Z',
      trigger: 'schedule', status: 'pending'
    });
    const recoverable = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-25T00:00:00.000Z',
      trigger: 'schedule', status: 'running'
    });
    const ambiguous = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-24T23:00:00.000Z',
      trigger: 'schedule', status: 'running'
    });

    const dispatched = [];
    const events = [];
    const scheduler = new RoutineScheduler(store, event => events.push(event), {
      autoStart: false, now: () => now
    });
    scheduler.setDispatcher({
      run: async runId => dispatched.push(runId),
      recover: async run => run.id === recoverable.id
        ? { state: 'retry' }
        : { state: 'needs_user', reason: '外部操作结果无法确认。' }
    });
    await scheduler.recoverAfterRestart();

    assert.equal(store.routineRun(pending.id).status, 'running');
    assert.equal(store.routineRun(pending.id).recoveryCount, 1);
    assert.equal(store.routineRun(recoverable.id).status, 'running');
    assert.equal(store.routineRun(recoverable.id).recoveryCount, 1);
    assert.equal(store.routineRun(ambiguous.id).status, 'needs_user');
    assert.equal(store.routineRun(ambiguous.id).needsUserReason, '外部操作结果无法确认。');
    assert.equal(
      events.filter(event => event.type === 'routineRunFinished' && event.runId === ambiguous.id).length,
      1
    );
    assert.deepEqual(dispatched.sort(), [pending.id, recoverable.id].sort());

    await scheduler.recoverAfterRestart();
    assert.equal(store.routineRun(pending.id).status, 'needs_user');
    assert.equal(store.routineRun(recoverable.id).status, 'needs_user');
    assert.equal(store.routineRun(recoverable.id).recoveryCount, 1);
    assert.equal(
      events.filter(event => event.type === 'routineRunFinished' && event.runId === pending.id).length,
      1
    );
    assert.equal(
      events.filter(event => event.type === 'routineRunFinished' && event.runId === recoverable.id).length,
      1
    );
    assert.deepEqual(dispatched.sort(), [pending.id, recoverable.id].sort());
    assert.equal(store.routine(routine.id).status, 'paused');

    assert.throws(() => store.setRoutineStatus(routine.id, 'active'), /先检查上次运行结果/u);
    const resumed = store.resolveRoutineRunAndResume(routine.id);
    assert.equal(resumed.status, 'active');
    assert.equal(store.routineRuns(routine.id).filter(run => run.status === 'needs_user').length, 0);
    assert.ok(store.routineRuns(routine.id).filter(run => run.status === 'interrupted')
      .every(run => run.process?.includes('用户检查后选择恢复计划')));
    scheduler.stop();
  });
});

test('legacy interval text is paused and cannot fire, while readable data is retained', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Legacy interval Bot', 'a');
    const created = store.createRoutine({
      botId: bot.id,
      title: 'Legacy intervals',
      instruction: 'Check the inbox.',
      schedule: '每天',
      time: '09:00',
      sourceCallId: 'legacy-interval',
      now: new Date('2026-10-25T00:10:00.000Z')
    });
    const invalidDefinition = JSON.parse(JSON.stringify(created.definition));
    invalidDefinition.schedule = '每天每 30 分钟 09:00';
    store.db.prepare('UPDATE routines SET definitionJson=? WHERE id=?')
      .run(JSON.stringify(invalidDefinition), created.id);
    assert.equal(store.routine(created.id).nextRunAt, null);

    const scheduler = new RoutineScheduler(store, () => {}, {
      autoStart: false, now: () => new Date('2026-10-25T01:10:00.000Z')
    });
    const legacy = store.routine(created.id);
    assert.equal(legacy.status, 'paused');
    assert.equal(legacy.definition.schedule, '每天每 30 分钟 09:00');
    assert.equal(legacy.nextRunAt, null);
    assert.match(legacy.statusReason, /旧周期.*每 N 分钟\/小时.*HH:mm/u);
    scheduler.stop();
  });
});

test('catch-up is limited to one run inside 12 hours and records misses outside the window', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Catch-up Bot', 'a');
    const createdAt = new Date('2026-10-22T01:00:00.000Z');
    const catchUp = store.createRoutine({
      botId: bot.id, title: 'Catch up', instruction: '补跑一次',
      schedule: '每天', time: '09:30', sourceCallId: 'catch-up',
      catchUp: true, now: createdAt
    });
    const disabled = store.createRoutine({
      botId: bot.id, title: 'No catch up', instruction: '不补跑',
      schedule: '每天', time: '09:30', sourceCallId: 'no-catch-up',
      catchUp: false, now: createdAt
    });
    store.db.prepare('UPDATE routines SET nextRunAt=? WHERE id=?')
      .run('2026-10-22T01:00:00.000Z', catchUp.id);
    store.db.prepare('UPDATE routines SET nextRunAt=? WHERE id=?')
      .run('2026-10-22T01:00:00.000Z', disabled.id);
    const calls = [];
    const scheduler = new RoutineScheduler(store, () => {}, { autoStart: false, now: () => createdAt });
    scheduler.setDispatcher({ run: async (runId, routine) => calls.push([runId, routine.id]) });
    const at = new Date('2026-10-22T07:00:00.000Z');
    await scheduler.tick(at);
    assert.deepEqual(calls.map(call => call[1]), [catchUp.id]);
    assert.equal(store.routineRuns(disabled.id).filter(run => run.status === 'missed').length, 1);
    assert.equal(store.routineRuns(catchUp.id).filter(run => run.trigger === 'catchUp').length, 1);
  });
});

test('a routine does not re-enter while its previous run is active and records the skip reason', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Non-reentrant Bot', 'a');
    const now = new Date('2026-10-22T01:00:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Non-reentrant', instruction: '不要叠加',
      schedule: '每天', time: '09:30', sourceCallId: 'non-reentrant', now
    });
    store.db.prepare('UPDATE routines SET nextRunAt=? WHERE id=?')
      .run('2026-10-22T01:00:00.000Z', routine.id);
    store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-21T01:00:00.000Z',
      trigger: 'schedule', status: 'running'
    });
    const scheduler = new RoutineScheduler(store, () => {}, {
      autoStart: false, now: () => now
    });
    let calls = 0;
    scheduler.setDispatcher({ run: async () => { calls += 1; } });
    await scheduler.tick(new Date('2026-10-22T01:30:00.000Z'));
    assert.equal(calls, 0);
    const runs = store.routineRuns(routine.id);
    assert.equal(runs.filter(run => run.status === 'skipped').length, 1);
    assert.match(runs.find(run => run.status === 'skipped').process, /上一轮尚未结束/);
  });
});

test('one-time misses stay visible, do not automatically repeat, and are consumed after a completed manual run', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('One-time Bot', 'a');
    const now = new Date('2026-10-22T01:00:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id, title: 'One-time miss', instruction: '一次性任务',
      schedule: '一次性', time: '09:30', kind: 'once', runDate: '2026-10-22',
      sourceCallId: 'once-miss', now
    });
    store.db.prepare('UPDATE routines SET nextRunAt=? WHERE id=?')
      .run('2026-10-22T01:00:00.000Z', routine.id);
    const scheduler = new RoutineScheduler(store, () => {}, { autoStart: false, now: () => now });
    scheduler.setDispatcher({
      run: async () => {},
      deliverResult: async runId => { scheduler.consumeOneTimeDefinition(runId); }
    });
    await scheduler.tick(new Date('2026-10-22T01:05:00.000Z'));
    assert.equal(store.routine(routine.id).nextRunAt, null);
    assert.equal(store.routineRuns(routine.id)[0].status, 'missed');
    const manualRun = await scheduler.runNow(routine.id);
    scheduler.completeRun(manualRun.id, 'completed', '错过后手动运行完成');
    await scheduler.waitForDeliveries();
    assert.equal(store.routineRuns(routine.id).length, 2);
    assert.equal(store.routineRuns(routine.id).some(run => run.trigger === 'manual'), true);
    assert.equal(store.routines().some(item => item.id === routine.id), false);
    assert.equal(store.routineRuns(routine.id).find(run => run.id === manualRun.id).status, 'succeeded');
  });
});

test('manually running a pending one-time routine clears its original schedule', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Manual One-time Bot', 'a');
    const now = new Date('2026-10-22T01:00:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Manual one-time', instruction: '手动执行一次',
      schedule: '一次性', time: '09:30', kind: 'once', runDate: '2026-10-23',
      sourceCallId: 'once-manual', now
    });
    const scheduler = new RoutineScheduler(store, () => {}, { autoStart: false, now: () => now });
    scheduler.setDispatcher({ run: async () => {} });
    assert.ok(store.routine(routine.id).nextRunAt);
    const run = await scheduler.runNow(routine.id);
    assert.equal(run.trigger, 'manual');
    assert.equal(store.routine(routine.id).nextRunAt, null);

    await scheduler.tick(new Date('2026-10-24T01:00:00.000Z'));
    const runs = store.routineRuns(routine.id);
    assert.equal(runs.some(item => item.status === 'missed'), false);
    assert.equal(runs.filter(item => item.trigger === 'manual').length, 1);
  });
});

test('deleting a routine definition retains its run history', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('History Bot', 'a');
    const now = new Date('2026-10-22T01:00:00.000Z');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Retain history', instruction: '保留记录',
      schedule: '每天', time: '09:30', sourceCallId: 'history', now
    });
    const run = store.createRoutineRun({
      routineId: routine.id, scheduledFor: now.toISOString(), trigger: 'manual',
      status: 'succeeded'
    });
    store.updateRoutineRun(run.id, { summary: '完成结果', completedAt: now.toISOString() });
    store.deleteRoutine(routine.id);
    assert.equal(store.routines().some(item => item.id === routine.id), false);
    assert.equal(store.routineRuns(routine.id)[0].id, run.id);
    assert.equal(store.routineRuns(routine.id)[0].summary, '完成结果');
  });
});

test('routine runs use isolated execution chats and only copy the last short result when enabled', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Isolated Routine Bot', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Isolated context', instruction: '生成简短报告',
      schedule: '每天', time: '09:30', sourceCallId: 'isolated-context',
      rememberLastResult: true
    });
    const previous = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-21T01:30:00.000Z',
      trigger: 'schedule', status: 'succeeded'
    });
    store.updateRoutineRun(previous.id, {
      summary: '上一轮简报'.repeat(500),
      completedAt: '2026-10-21T01:31:00.000Z'
    });
    const scheduler = new RoutineScheduler(store, () => {}, { autoStart: false });
    let captured;
    scheduler.setDispatcher({
      run: async (runId, current, prompt) => {
        const run = store.routineRun(runId);
        captured = { runId, current, prompt, run };
      }
    });
    await scheduler.runNow(routine.id);

    assert.equal(captured.run.sourceChatId, routine.sourceChatId);
    assert.equal(captured.run.chatId, null);
    assert.equal(captured.prompt, '生成简短报告');
    assert.equal(captured.current.definition.rememberLastResult, true);
    assert.equal(store.chats().some(chat => chat.routineRunId === captured.runId), false);
    const executionChat = store.createRoutineExecutionChat(
      captured.runId, bot.id, '定时任务：Isolated context'
    );
    assert.notEqual(executionChat.id, routine.sourceChatId);
    assert.equal(executionChat.routineRunId, captured.runId);
    assert.equal(store.chats().some(chat => chat.id === executionChat.id), false);
    assert.equal(store.ensureBotChat(bot.id).id, routine.sourceChatId);
  });
});

test('pausing or deleting a routine cancels pending runs but leaves running work intact', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Pending Boundary Bot', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Pending boundary', instruction: '等待执行',
      schedule: '每天', time: '09:30', sourceCallId: 'pending-boundary'
    });
    const pending = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-22T01:30:00.000Z',
      trigger: 'schedule', status: 'pending'
    });
    const running = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-22T01:00:00.000Z',
      trigger: 'schedule', status: 'running'
    });
    const scheduler = new RoutineScheduler(store, () => {}, {
      autoStart: false, now: () => new Date('2026-10-22T02:00:00.000Z')
    });
    scheduler.stopPending(routine.id, '暂停');
    assert.equal(store.routineRun(pending.id).status, 'interrupted');
    assert.equal(store.routineRun(pending.id).error, '暂停');
    assert.equal(store.routineRun(running.id).status, 'running');
    assert.equal(store.routineRun(running.id).completedAt, null);
  });
});

test('routine completion persists the full result and delegates delivery instead of writing a system receipt', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const { bot } = store.createBot('Routine delivery Bot', 'a');
    const routine = store.createRoutine({
      botId: bot.id, title: 'Delivery result', instruction: '返回完整结果',
      schedule: '每天', time: '09:30', sourceCallId: 'delivery-result'
    });
    const run = store.createRoutineRun({
      routineId: routine.id, scheduledFor: '2026-10-22T01:00:00.000Z',
      trigger: 'manual', status: 'running'
    });
    const delivered = [];
    const scheduler = new RoutineScheduler(store, () => {}, { autoStart: false });
    scheduler.setDispatcher({
      run: async () => {},
      deliverResult: async runId => {
        delivered.push(runId);
        scheduler.consumeOneTimeDefinition(runId);
      }
    });
    const fullResult = `完整结果：${'详细内容'.repeat(500)}`;

    scheduler.completeRun(run.id, 'completed', fullResult);
    await new Promise(resolve => setImmediate(resolve));

    const completed = store.routineRun(run.id);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.summary, fullResult);
    assert.equal(completed.summary.length > 500, true);
    assert.deepEqual(delivered, [run.id]);
    assert.equal(store.messages(routine.sourceChatId).length, 0);
  });
});

test('a one-time Routine is consumed only for its own Bot after terminal result handoff', async () => {
  await withModules(async ({ RoutineScheduler, store }) => {
    const first = store.createBot('One-time owner', 'a').bot;
    const second = store.createBot('Other owner', 'b').bot;
    const oneTime = store.createRoutine({
      botId: first.id, title: 'Consume once', instruction: '只运行一次',
      schedule: '一次性', time: '09:30', kind: 'once', runDate: '2026-10-22',
      sourceCallId: 'consume-once'
    });
    const recurring = store.createRoutine({
      botId: first.id, title: 'Keep recurring', instruction: '每天运行',
      schedule: '每天', time: '09:30', sourceCallId: 'keep-recurring'
    });
    const other = store.createRoutine({
      botId: second.id, title: 'Other one-time', instruction: '其他 Bot 保留',
      schedule: '一次性', time: '10:30', kind: 'once', runDate: '2026-10-22',
      sourceCallId: 'keep-other-once'
    });
    const events = [];
    const delivered = [];
    const scheduler = new RoutineScheduler(store, event => events.push(event), { autoStart: false });
    scheduler.setDispatcher({
      run: async () => {},
      deliverResult: async runId => {
        delivered.push(runId);
        scheduler.consumeOneTimeDefinition(runId);
      }
    });

    const successful = store.createRoutineRun({
      routineId: oneTime.id, scheduledFor: '2026-10-22T01:30:00.000Z',
      trigger: 'manual', status: 'running'
    });
    scheduler.completeRun(successful.id, 'completed', '成功完整结果');
    await scheduler.waitForDeliveries();
    assert.deepEqual(delivered, [successful.id]);
    assert.equal(store.routines().some(item => item.id === oneTime.id), false);
    assert.equal(store.routineRuns(oneTime.id)[0].summary, '成功完整结果');
    assert.equal(store.routines().some(item => item.id === recurring.id), true);
    assert.equal(store.routines().some(item => item.id === other.id), true);
    assert.ok(events.some(event => event.type === 'changed'));

    const failed = store.createRoutineRun({
      routineId: other.id, scheduledFor: '2026-10-22T02:30:00.000Z',
      trigger: 'schedule', status: 'running'
    });
    scheduler.completeRun(failed.id, 'failed', undefined, '脚本退出码 1');
    await scheduler.waitForDeliveries();
    assert.equal(store.routines().some(item => item.id === other.id), false);
    assert.equal(store.routineRun(failed.id).status, 'failed');
    assert.equal(store.routineRun(failed.id).error, '脚本退出码 1');

    const interruptedRoutine = store.createRoutine({
      botId: first.id, title: 'Interrupted once', instruction: '中断后仍需交回结果',
      schedule: '一次性', time: '11:30', kind: 'once', runDate: '2026-10-22',
      sourceCallId: 'consume-interrupted'
    });
    const interrupted = store.createRoutineRun({
      routineId: interruptedRoutine.id, scheduledFor: '2026-10-22T03:30:00.000Z',
      trigger: 'manual', status: 'running'
    });
    scheduler.completeRun(interrupted.id, 'interrupted', undefined, '用户停止');
    await scheduler.waitForDeliveries();
    assert.equal(store.routines().some(item => item.id === interruptedRoutine.id), false);
    assert.equal(store.routineRun(interrupted.id).status, 'interrupted');
    assert.deepEqual(delivered, [successful.id, failed.id, interrupted.id]);
  });
});
