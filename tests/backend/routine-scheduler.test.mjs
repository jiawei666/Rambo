import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const storeSource = readFileSync(new URL('../../src/main/store.ts', import.meta.url), 'utf8');
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
      .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'"),
    { mode: 0o600 }
  );
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
    const scheduler = new RoutineScheduler(store, () => {}, { autoStart: false, now: () => now });
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
    const scheduler = new RoutineScheduler(store, () => {}, { autoStart: false, now: () => now });
    let calls = 0;
    scheduler.setDispatcher({ run: async () => { calls += 1; } });
    await scheduler.tick(new Date('2026-10-22T01:30:00.000Z'));
    assert.equal(calls, 0);
    const runs = store.routineRuns(routine.id);
    assert.equal(runs.filter(run => run.status === 'skipped').length, 1);
    assert.match(runs.find(run => run.status === 'skipped').process, /上一轮尚未结束/);
  });
});

test('one-time misses stay visible, do not automatically repeat, and can be manually run with preserved history', async () => {
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
    scheduler.setDispatcher({ run: async () => {} });
    await scheduler.tick(new Date('2026-10-22T01:05:00.000Z'));
    assert.equal(store.routine(routine.id).nextRunAt, null);
    assert.equal(store.routineRuns(routine.id)[0].status, 'missed');
    await scheduler.runNow(routine.id);
    assert.equal(store.routine(routine.id).id, routine.id);
    assert.equal(store.routineRuns(routine.id).length, 2);
    assert.equal(store.routineRuns(routine.id).some(run => run.trigger === 'manual'), true);
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
