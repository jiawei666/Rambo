import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

function reopenedRoutineId(snapshot, botId, title) {
  const routine = snapshot.routines.find(item => item.botId === botId && item.title === title);
  if (!routine) throw new Error(`找不到 ${botId} 的 Routine ${title}`);
  return routine.id;
}

function processExists(pid) {
  try {
    execFileSync('/bin/ps', ['-p', String(pid)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitForRuntimeProcess(appPid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8'
    }).split('\n');
    const runtime = processes.find(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match?.[2] === String(appPid) &&
        match[3].includes('/bin/codex-app-server');
    })?.trim().match(/^(\d+)/)?.[1];
    if (runtime) return Number(runtime);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Electron ${appPid} 没有启动直接管理的 App Server`);
}

test('真实 Electron 从空白状态创建 Bot 并直接进入唯一私聊', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-smoke-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  const chromium = join(run, 'chromium');
  mkdirSync(profile);
  mkdirSync(chromium);
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  try {
    const env = {
      ...process.env,
      RAMBO_ACCEPTANCE_RUN: run
    };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const stderr = [];
    app.process().stderr?.on('data', chunk => stderr.push(chunk.toString()));
    const page = await app.firstWindow();
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    expect(userData).toBe(profile);
    await expect(page).toHaveTitle('Rambo').catch(error => {
      throw new Error(`${error.message}\nElectron stderr:\n${stderr.join('')}`);
    });
    await expect(page.getByLabel('创建 Bot')).toBeVisible();
    await page.getByLabel('创建 Bot').click();
    const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
    await expect(dialog).toBeVisible();
    await dialog.locator('form').evaluate(form => form.requestSubmit());
    await expect(page.getByText('请输入 Bot 名称。')).toBeVisible();
    await expect(dialog).toBeVisible();
    await page.getByLabel('Bot 名称').fill('E2E Pilot');
    await dialog.getByRole('button', { name: '云朵', exact: true }).click();
    await dialog.getByRole('button', { name: '蓝色', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '云朵', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: '蓝色', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByText('唯一私聊')).toBeVisible();
    await expect(page.getByRole('button', { name: /E2E Pilot/ }).first()).toBeVisible();
    await expect(page.getByPlaceholder('发消息给 Bot')).toBeVisible();
    await expect(page.getByLabel('会话列表').getByText('E2E Pilot')).toBeVisible();
    await expect(page.getByText('欢迎', { exact: false })).toHaveCount(0);
    await expect(page.getByText('示例任务', { exact: false })).toHaveCount(0);
    await expect(page.locator('.message-row')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toHaveCount(0);

    const snapshot = await page.evaluate(() => window.rambo.snapshot());
    expect(snapshot.bots.filter(bot => bot.name === 'E2E Pilot')).toHaveLength(1);
    expect(snapshot.bots.find(bot => bot.name === 'E2E Pilot')?.avatar).toBe('grok-avatar:v1:cloud:blue');
    expect(snapshot.chats.filter(chat =>
      chat.botId === snapshot.bots[0].id && !chat.groupChatId && !chat.archived
    )).toHaveLength(1);
    expect(snapshot.chats.filter(chat => !chat.groupChatId && !chat.archived)).toHaveLength(1);

    const originalChatId = snapshot.chats.find(chat => chat.botId === snapshot.bots[0].id)?.id;
    await app.close();
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const reopenedPage = await app.firstWindow();
    await expect(reopenedPage.getByRole('button', { name: /E2E Pilot/ }).first()).toBeVisible();
    await expect(reopenedPage.getByPlaceholder('发消息给 Bot')).toBeVisible();
    await expect(reopenedPage.getByLabel('会话列表').getByText('E2E Pilot')).toBeVisible();
    const reopened = await reopenedPage.evaluate(() => window.rambo.snapshot());
    expect(reopened.bots.filter(bot => bot.name === 'E2E Pilot')).toHaveLength(1);
    expect(reopened.bots.find(bot => bot.name === 'E2E Pilot')?.avatar).toBe('grok-avatar:v1:cloud:blue');
    expect(reopened.chats.filter(chat => !chat.groupChatId && !chat.archived)).toHaveLength(1);
    expect(reopened.chats.find(chat => chat.botId === reopened.bots[0].id)?.id).toBe(originalChatId);
    await expect(reopenedPage.getByText('聊天', { exact: true })).toHaveCount(0);
    await expect(reopenedPage.locator('.message-row')).toHaveCount(0);
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('账号设置只复用本机 Codex 登录且没有产品注册或同步入口', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-account-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await page.getByLabel('设置', { exact: true }).click();
    await expect(page.getByRole('heading', { name: '账号' })).toBeVisible();
    await expect(page.getByText('Rambo 使用本机 Codex 登录状态。')).toBeVisible();
    await expect(page.getByText('账号状态来自本机 Codex')).toBeVisible();
    const launchAtLogin = page.getByRole('checkbox', { name: '登录时启动' });
    await expect(launchAtLogin).toBeChecked();
    await launchAtLogin.uncheck();
    await expect(launchAtLogin).not.toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: '已关闭登录时启动' })).toBeVisible();
    await page.reload();
    await page.getByLabel('设置', { exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '登录时启动' })).not.toBeChecked();
    await expect(page.getByText(/注册|同步到其他设备|跨设备同步/)).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.rambo.snapshot());
    expect(snapshot.settings.launchAtLogin).toBe('false');
    expect(snapshot.settings).not.toHaveProperty('account');
    expect(snapshot.settings).not.toHaveProperty('sync');
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('Bot 设置显示自己的任务且左侧总览在重启后保留全部归属', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-routines-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  const waitForSnapshot = async (page, predicate, message) => {
    let snapshot;
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return predicate(snapshot);
    }, { message }).toBe(true);
    return snapshot;
  };
  const createRoutineThroughAcceptanceHost = async (page, bot, routine) => {
    const chat = await page.evaluate(botId => window.rambo.ensureBotChat(botId), bot.id);
    await page.evaluate(chatId => window.rambo.send(chatId, '创建一个明确时间的周期任务。'), chat.id);
    const withThread = await waitForSnapshot(
      page,
      snapshot => Boolean(snapshot.chats.find(item => item.id === chat.id)?.threadId),
      'Bot 私聊没有建立真实 thread'
    );
    const threadId = withThread.chats.find(item => item.id === chat.id).threadId;
    const created = await page.evaluate(({ threadId, callId, arguments: args }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'routineTool',
        method: 'item/tool/call',
        params: {
          threadId,
          turnId: callId,
          callId,
          namespace: 'rambo_routines',
          tool: 'create_routine',
          arguments: args
        }
      }), { threadId, callId: routine.callId, arguments: routine.arguments });
    expect(created.result.success, created.result.contentItems?.[0]?.text).toBe(true);
    const afterCreate = await waitForSnapshot(
      page,
      snapshot => snapshot.routines.some(item =>
        item.botId === bot.id && item.title === routine.arguments.title
      ),
      '真实 Routine 工具调用后没有持久化任务'
    );
    const saved = afterCreate.routines.find(item =>
      item.botId === bot.id && item.title === routine.arguments.title
    );
    if (routine.pause) {
      const paused = await page.evaluate(({ threadId, callId, id }) =>
        window.rambo.injectAcceptanceEvent({
          type: 'routineTool',
          method: 'item/tool/call',
          params: {
            threadId,
            turnId: callId,
            callId,
            namespace: 'rambo_routines',
            tool: 'set_routine_status',
            arguments: { id, status: 'paused' }
          }
        }), { threadId, callId: `${routine.callId}-pause`, id: saved.id });
      expect(paused.result.success, paused.result.contentItems?.[0]?.text).toBe(true);
    }
    await waitForSnapshot(
      page,
      snapshot => snapshot.routines.some(item =>
        item.id === saved.id && item.status === (routine.pause ? 'paused' : 'active')
      ),
      'Routine 工具调用后的状态没有持久化'
    );
  };
  const assertDetails = async (page, bots) => {
    await page.getByLabel('设置 Routine Alpha').click();
    const alphaDetails = page.getByLabel('Routine Alpha 管理的定时任务');
    await expect(alphaDetails.getByText('Alpha planning')).toBeVisible();
    await expect(alphaDetails.getByText(/只整理 Alpha 自己的工作清单/)).toBeVisible();
    await expect(alphaDetails.getByText(/每个工作日 09:00/)).toBeVisible();
    await expect(alphaDetails.getByText(/下次 /)).toBeVisible();
    await expect(alphaDetails.getByText('Beta summary')).toHaveCount(0);
    await expect(alphaDetails.getByText(bots.beta.name)).toHaveCount(0);

    await page.getByLabel('设置 Routine Beta').click();
    const betaDetails = page.getByLabel('Routine Beta 管理的定时任务');
    await expect(betaDetails.getByText('Beta summary')).toBeVisible();
    await expect(betaDetails.getByText(/只汇总 Beta 的项目进展/)).toBeVisible();
    await expect(betaDetails.getByText(/每周五 18:00/)).toBeVisible();
    await expect(betaDetails.getByText('已暂停')).toBeVisible();
    await expect(betaDetails.getByText('Alpha planning')).toHaveCount(0);
    await expect(betaDetails.getByText(bots.alpha.name)).toHaveCount(0);
  };
  const assertOverview = async (page, bots) => {
    await page.getByRole('button', { name: /全部定时任务/ }).click();
    const overview = page.getByLabel('所有 Bot 的定时任务');
    await expect(overview.getByText('Alpha planning')).toBeVisible();
    await expect(overview.getByText(/Routine Alpha.*每个工作日 09:00/)).toBeVisible();
    await expect(overview.getByText('Beta summary')).toBeVisible();
    await expect(overview.getByText(/Routine Beta.*每周五 18:00/)).toBeVisible();
    await expect(overview.getByText(/下次 /)).toBeVisible();
    await expect(overview.getByText('已暂停')).toBeVisible();
    await expect(overview.getByText(bots.alpha.name)).toBeVisible();
    await expect(overview.getByText(bots.beta.name)).toBeVisible();
  };
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = () => electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    app = await launch();
    const page = await app.firstWindow();
    for (const [name, role] of [['Routine Alpha', '整理工作清单'], ['Routine Beta', '汇总项目进展']]) {
      await page.getByLabel('创建 Bot').click();
      const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
      await page.getByLabel('Bot 名称').fill(name);
      await dialog.getByRole('button', { name: '创建', exact: true }).click();
      await page.getByLabel(`设置 ${name}`).click();
      await page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox').fill(role);
      await page.getByRole('button', { name: '保存资料' }).click();
      await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    }

    const created = await page.evaluate(() => window.rambo.snapshot());
    const alpha = created.bots.find(bot => bot.name === 'Routine Alpha');
    const beta = created.bots.find(bot => bot.name === 'Routine Beta');
    expect(alpha).toBeTruthy();
    expect(beta).toBeTruthy();
    await createRoutineThroughAcceptanceHost(page, alpha, {
      callId: 'b12-alpha-create',
      arguments: {
        title: 'Alpha planning',
        instruction: '只整理 Alpha 自己的工作清单',
        schedule: '每个工作日',
        triggerTime: '09:00', kind: 'recurring'
      }
    });
    await createRoutineThroughAcceptanceHost(page, beta, {
      callId: 'b12-beta-create',
      arguments: {
        title: 'Beta summary',
        instruction: '只汇总 Beta 的项目进展',
        schedule: '每周五',
        triggerTime: '18:00', kind: 'recurring'
      },
      pause: true
    });
    await assertDetails(page, { alpha, beta });
    await assertOverview(page, { alpha, beta });

    await page.getByLabel('设置 Routine Alpha').click();
    const alphaDetails = page.getByLabel('Routine Alpha 管理的定时任务');
    await alphaDetails.getByRole('button', { name: '立即运行' }).click();
    const running = await waitForSnapshot(
      page,
      snapshot => {
        const run = snapshot.routineRuns.find(item =>
          item.routineId === reopenedRoutineId(snapshot, alpha.id, 'Alpha planning')
        );
        return run?.trigger === 'manual' &&
          Boolean(run.chatId) &&
          Boolean(run.turnId) &&
          (run.status === 'running' || run.status === 'succeeded');
      },
      '立即运行没有开始并产生与 Routine 关联的运行记录'
    );
    const alphaRoutineId = reopenedRoutineId(running, alpha.id, 'Alpha planning');
    const manualRun = running.routineRuns.find(item =>
      item.routineId === alphaRoutineId && item.trigger === 'manual'
    );
    expect(manualRun).toBeTruthy();
    if (manualRun.status === 'running') {
      expect(manualRun.turnId).toBeTruthy();
      const executionTurns = await page.evaluate(
        chatId => window.rambo.turns(chatId), manualRun.chatId
      );
      const executionTurn = executionTurns.find(item => item.turnId === manualRun.turnId);
      expect(executionTurn).toBeTruthy();
      const threadId = executionTurn.threadId;
      await page.evaluate(({ threadId, chatId, turnId }) =>
        window.rambo.injectAcceptanceEvent({
          type: 'acceptanceNotification',
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: {
              id: 'routine-alpha-manual-result',
              type: 'agentMessage',
              text: 'Alpha 手动运行完成，已整理工作清单。'
            }
          }
        }), { threadId, chatId: manualRun.chatId, turnId: manualRun.turnId });
      await page.evaluate(({ threadId, turnId }) =>
        window.rambo.injectAcceptanceEvent({
          type: 'acceptanceNotification',
          method: 'turn/completed',
          params: {
            threadId,
            turn: { id: turnId, status: 'completed', error: null }
          }
        }), { threadId, turnId: manualRun.turnId });
    }
    const completed = await waitForSnapshot(
      page,
      snapshot => snapshot.routineRuns.some(item =>
        item.id === manualRun.id &&
        item.status === 'succeeded' &&
        item.summary === 'Alpha 手动运行完成，已整理工作清单。'
      ),
      '立即运行完成后没有保存精确结果与成功状态'
    );
    expect(completed.routineRuns.find(item => item.id === manualRun.id)).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
      chatId: manualRun.chatId,
      turnId: manualRun.turnId
    });

    await app.close();
    app = await launch();
    const reopenedPage = await app.firstWindow();
    await expect(reopenedPage.getByRole('button', { name: /Routine Alpha/ }).first()).toBeVisible();
    const reopened = await waitForSnapshot(
      reopenedPage,
      snapshot => snapshot.routines.length === 2,
      '重启后 Routine 没有从同一 profile 持久化回读'
    );
    expect(reopened.routines.find(item => item.botId === alpha.id)).toMatchObject({
      title: 'Alpha planning', status: 'active',
      definition: { instruction: '只整理 Alpha 自己的工作清单', schedule: '每个工作日 09:00' }
    });
    expect(reopened.routines.find(item => item.botId === beta.id)).toMatchObject({
      title: 'Beta summary', status: 'paused',
      definition: { instruction: '只汇总 Beta 的项目进展', schedule: '每周五 18:00' }
    });
    await assertDetails(reopenedPage, { alpha, beta });
    await assertOverview(reopenedPage, { alpha, beta });
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('真实 Electron 关窗后后台服务继续且显式退出停止本机运行时', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-lifecycle-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  mkdirSync(join(run, 'chromium'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Background Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Bot')).toBeVisible();
    const initial = await page.evaluate(() => window.rambo.snapshot());
    const bot = initial.bots.find(item => item.name === 'Background Pilot');
    const chat = initial.chats.find(item => item.botId === bot.id);
    await page.evaluate(chatId => window.rambo.send(chatId, '准备真实 Routine。'), chat.id);
    await expect.poll(async () => {
      const current = await page.evaluate(() => window.rambo.snapshot());
      return Boolean(current.chats.find(item => item.id === chat.id)?.threadId);
    }).toBe(true);
    const withThread = await page.evaluate(() => window.rambo.snapshot());
    const threadId = withThread.chats.find(item => item.id === chat.id).threadId;
    const created = await page.evaluate(({ threadId, chatId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'routineTool',
        method: 'item/tool/call',
        params: {
          threadId,
          turnId: 'background-setup-turn',
          callId: 'background-setup-call',
          namespace: 'rambo_routines',
          tool: 'create_routine',
          arguments: {
            title: 'Background routine',
            instruction: '只在后台生成验收结果',
            schedule: '每天',
            triggerTime: '00:00',
            kind: 'recurring',
            catchUp: true
          }
        }
      }), { threadId, chatId: chat.id });
    expect(created.result.success, created.result.contentItems?.[0]?.text).toBe(true);
    await page.evaluate(({ threadId }) => window.rambo.injectAcceptanceEvent({
      type: 'acceptanceNotification',
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: 'background-setup-turn', status: 'completed', error: null }
      }
    }), { threadId });

    const electronPid = app.process().pid;
    const runtimePid = await waitForRuntimeProcess(electronPid);
    expect(processExists(runtimePid)).toBe(true);

    const beforeClose = await page.evaluate(() => window.rambo.snapshot());
    const routine = beforeClose.routines.find(item => item.botId === bot.id);
    expect(routine).toBeTruthy();
    await page.evaluate(routineId =>
      window.rambo.advanceRoutineScheduleForAcceptance(routineId), routine.id);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isVisible()
    )).toBe(false);
    expect(processExists(electronPid)).toBe(true);
    expect(processExists(runtimePid)).toBe(true);
    const shown = await app.evaluate(({ Menu }) => {
      const find = items => {
        for (const item of items) {
          if (item.label === '显示 Rambo') return item;
          const nested = find(item.submenu?.items ?? []);
          if (nested) return nested;
        }
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      item?.click();
      return Boolean(item);
    });
    expect(shown).toBe(true);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isVisible()
    )).toBe(true);
    const visiblePage = await app.firstWindow();
    let triggered;
    await expect.poll(async () => {
      const current = await visiblePage.evaluate(() => window.rambo.snapshot());
      triggered = current.routineRuns.find(item =>
        item.routineId === routine.id && item.trigger === 'schedule'
      );
      return Boolean(triggered?.chatId && triggered?.turnId);
    }, { timeout: 25000, message: '关窗期间后台调度器没有开始 Routine' }).toBe(true);
    expect(triggered.status).toBe('running');
    expect(triggered.sourceChatId).toBe(chat.id);
    expect(triggered.chatId).not.toBe(chat.id);
    const executionTurns = await visiblePage.evaluate(
      chatId => window.rambo.turns(chatId), triggered.chatId
    );
    const executionTurn = executionTurns.find(item => item.turnId === triggered.turnId);
    expect(executionTurn).toBeTruthy();
    const executionThreadId = executionTurn.threadId;
    await visiblePage.evaluate(({ threadId, turnId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: {
            id: 'background-routine-result',
            type: 'agentMessage',
            text: '后台 Routine 在窗口关闭期间产生的结果。'
          }
        }
      }), { threadId: executionThreadId, turnId: triggered.turnId });
    await visiblePage.evaluate(({ threadId, turnId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'turn/completed',
        params: {
          threadId,
          turn: { id: turnId, status: 'completed', error: null }
        }
      }), { threadId: executionThreadId, turnId: triggered.turnId });
    await expect.poll(async () => {
      const current = await visiblePage.evaluate(() => window.rambo.snapshot());
      return current.routineRuns.find(item => item.id === triggered.id)?.status;
    }).toBe('succeeded');
    const messages = await visiblePage.evaluate(chatId => window.rambo.messages(chatId), chat.id);
    expect(messages.some(message =>
      message.role === 'system' &&
      message.text.includes('后台 Routine 在窗口关闭期间产生的结果。')
    )).toBe(true);

    await app.close();
    app = null;
    await expect.poll(() => processExists(runtimePid)).toBe(false);
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('真实 Electron 显示一次性 Routine 的成功、失败和错过状态', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-routine-once-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  mkdirSync(join(run, 'chromium'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  const waitForSnapshot = async (page, predicate, message) => {
    let snapshot;
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return predicate(snapshot);
    }, { message }).toBe(true);
    return snapshot;
  };
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Once Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Bot')).toBeVisible();
    let snapshot = await page.evaluate(() => window.rambo.snapshot());
    const bot = snapshot.bots.find(item => item.name === 'Once Pilot');
    const chat = snapshot.chats.find(item => item.botId === bot.id);
    await page.evaluate(chatId => window.rambo.send(chatId, '准备一次性 Routine。'), chat.id);
    snapshot = await waitForSnapshot(
      page,
      current => Boolean(current.chats.find(item => item.id === chat.id)?.threadId),
      '一次性 Routine 测试未建立 thread'
    );
    const threadId = snapshot.chats.find(item => item.id === chat.id).threadId;
    const createOnce = async (title, callId) => {
      const result = await page.evaluate(({ threadId, title, callId }) =>
        window.rambo.injectAcceptanceEvent({
          type: 'routineTool',
          method: 'item/tool/call',
          params: {
            threadId,
            turnId: callId,
            callId,
            namespace: 'rambo_routines',
            tool: 'create_routine',
            arguments: {
              title,
              instruction: `${title} 的执行内容`,
              schedule: '一次性',
              triggerTime: '00:00',
              runDate: '2026-10-23',
              kind: 'once'
            }
          }
        }), { threadId, title, callId });
      expect(result.result.success, result.result.contentItems?.[0]?.text).toBe(true);
    };
    await createOnce('Once success', 'once-success-call');
    await createOnce('Once failed', 'once-failed-call');
    await createOnce('Once missed', 'once-missed-call');
    snapshot = await waitForSnapshot(
      page,
      current => current.routines.filter(item => item.botId === bot.id).length === 3,
      '三条一次性 Routine 没有全部保存'
    );
    const byTitle = title => snapshot.routines.find(item =>
      item.botId === bot.id && item.title === title
    );
    const success = byTitle('Once success');
    const failed = byTitle('Once failed');
    const missed = byTitle('Once missed');

    const successRun = await page.evaluate(
      routineId => window.rambo.runRoutineNow(routineId),
      success.id
    );
    expect(successRun.status).toBe('running');
    expect(successRun.sourceChatId).toBe(chat.id);
    expect(successRun.chatId).not.toBe(chat.id);
    expect(successRun.turnId).toBeTruthy();
    const successTurns = await page.evaluate(
      chatId => window.rambo.turns(chatId), successRun.chatId
    );
    const successTurn = successTurns.find(item => item.turnId === successRun.turnId);
    expect(successTurn).toBeTruthy();
    const successThreadId = successTurn.threadId;
    await page.evaluate(({ threadId, turnId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: { id: 'once-success-result', type: 'agentMessage', text: '一次性成功结果' }
        }
      }), { threadId: successThreadId, turnId: successRun.turnId });
    await page.evaluate(({ threadId, turnId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed', error: null } }
      }), { threadId: successThreadId, turnId: successRun.turnId });
    snapshot = await waitForSnapshot(
      page,
      current => current.routineRuns.filter(item =>
        item.routineId === success.id && item.status === 'succeeded'
      ).length === 1,
      '成功一次性 Routine 没有进入成功状态'
    );
    const failedRun = await page.evaluate(
      routineId => window.rambo.runRoutineNow(routineId), failed.id
    );
    expect(failedRun.status).toBe('running');
    expect(failedRun.sourceChatId).toBe(chat.id);
    expect(failedRun.chatId).not.toBe(chat.id);
    expect(failedRun.turnId).toBeTruthy();
    expect(failedRun.id).toBeTruthy();
    const failedTurns = await page.evaluate(
      chatId => window.rambo.turns(chatId), failedRun.chatId
    );
    const failedTurn = failedTurns.find(item => item.turnId === failedRun.turnId);
    expect(failedTurn).toBeTruthy();
    await page.evaluate(({ threadId, turnId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: 'failed',
            error: { message: '受控验收失败：模拟 Codex 执行错误' }
          }
        }
      }), { threadId: failedTurn.threadId, turnId: failedRun.turnId });
    snapshot = await waitForSnapshot(
      page,
      current => current.routineRuns.some(item =>
        item.id === failedRun.id &&
        item.status === 'failed' &&
        item.error === '受控验收失败：模拟 Codex 执行错误'
      ),
      '失败的一次性 Routine 没有保存明确失败状态和错误'
    );

    await page.evaluate(routineId =>
      window.rambo.advanceRoutineScheduleForAcceptance(routineId), missed.id);
    await page.evaluate(() => window.rambo.injectAcceptanceEvent({
      type: 'acceptanceRoutineTick'
    }));
    await waitForSnapshot(
      page,
      current => current.routineRuns.some(item =>
        item.routineId === missed.id && item.status === 'missed'
      ),
      '错过的一次性 Routine 没有标记为已错过'
    );
    snapshot = await page.evaluate(() => window.rambo.snapshot());
    expect(snapshot.routines.find(item => item.id === success.id).lastRun.status).toBe('succeeded');
    expect(snapshot.routines.find(item => item.id === failed.id).lastRun.status).toBe('failed');
    expect(snapshot.routines.find(item => item.id === missed.id).lastRun.status).toBe('missed');

    await page.getByLabel('设置 Once Pilot').click();
    const details = page.getByLabel('Once Pilot 管理的定时任务');
    await expect(details.locator('.routine-list-item').filter({ hasText: 'Once success' }))
      .toContainText('已完成');
    await expect(details.locator('.routine-list-item').filter({ hasText: 'Once failed' }))
      .toContainText('执行失败');
    await expect(details.locator('.routine-list-item').filter({ hasText: 'Once missed' }))
      .toContainText('已错过');
    await page.getByRole('button', { name: /全部定时任务/ }).click();
    const overview = page.getByLabel('所有 Bot 的定时任务');
    await expect(overview.locator('.routine-list-item').filter({ hasText: 'Once success' }))
      .toContainText('已完成');
    await expect(overview.locator('.routine-list-item').filter({ hasText: 'Once failed' }))
      .toContainText('执行失败');
    await expect(overview.locator('.routine-list-item').filter({ hasText: 'Once missed' }))
      .toContainText('已错过');

    await page.getByLabel('设置 Once Pilot').click();
    const successEntry = details.locator('.routine-list-item')
      .filter({ hasText: 'Once success' }).locator('.routine-run-entry');
    await successEntry.locator('summary').click();
    await expect(successEntry).toContainText('一次性成功结果');
    await expect(successEntry).toContainText('手动');
    const failedEntry = details.locator('.routine-list-item')
      .filter({ hasText: 'Once failed' }).locator('.routine-run-entry');
    await failedEntry.locator('summary').click();
    await expect(failedEntry).toContainText('受控验收失败：模拟 Codex 执行错误');
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('真实 Electron 用户停止本次并暂停后停止独立 Routine 运行', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-routine-stop-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  mkdirSync(join(run, 'chromium'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  const waitForSnapshot = async (page, predicate, message) => {
    let snapshot;
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return predicate(snapshot);
    }, { message }).toBe(true);
    return snapshot;
  };
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('R13 Stop Bot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Bot')).toBeVisible();

    let snapshot = await page.evaluate(() => window.rambo.snapshot());
    const bot = snapshot.bots.find(item => item.name === 'R13 Stop Bot');
    const sourceChat = snapshot.chats.find(item => item.botId === bot.id);
    await page.evaluate(chatId => window.rambo.send(chatId, '准备 R13 停止路径。'), sourceChat.id);
    snapshot = await waitForSnapshot(
      page,
      current => Boolean(current.chats.find(item => item.id === sourceChat.id)?.threadId),
      'R13 UI 停止测试未建立来源私聊 thread'
    );
    const sourceThreadId = snapshot.chats.find(item => item.id === sourceChat.id).threadId;

    for (const routine of [
      { callId: 'r13-ui-stop-first', title: 'Stop current run' },
      { callId: 'r13-ui-stop-second', title: 'Pause and stop run' }
    ]) {
      const created = await page.evaluate(({ threadId, callId, title }) =>
        window.rambo.injectAcceptanceEvent({
          type: 'routineTool',
          method: 'item/tool/call',
          params: {
            threadId,
            turnId: callId,
            callId,
            namespace: 'rambo_routines',
            tool: 'create_routine',
            arguments: {
              title,
              instruction: `${title} 的独立执行内容`,
              schedule: '每天',
              triggerTime: '00:00',
              kind: 'recurring'
            }
          }
        }), { threadId: sourceThreadId, callId: routine.callId, title: routine.title });
      expect(created.result.success, created.result.contentItems?.[0]?.text).toBe(true);
    }
    snapshot = await waitForSnapshot(
      page,
      current => current.routines.filter(item => item.botId === bot.id).length === 2,
      '两条 R13 UI 测试 Routine 没有全部保存'
    );
    const firstRoutine = snapshot.routines.find(item => item.title === 'Stop current run');
    const secondRoutine = snapshot.routines.find(item => item.title === 'Pause and stop run');

    await page.getByLabel('设置 R13 Stop Bot').click();
    const details = page.getByLabel('R13 Stop Bot 管理的定时任务');
    const firstItem = details.locator('.routine-list-item').filter({ hasText: firstRoutine.title });
    const secondItem = details.locator('.routine-list-item').filter({ hasText: secondRoutine.title });
    await firstItem.getByRole('button', { name: '立即运行' }).click();
    snapshot = await waitForSnapshot(
      page,
      current => current.routineRuns.some(item =>
        item.routineId === firstRoutine.id && item.status === 'running'
      ),
      '第一条 Routine 没有通过 UI 开始运行'
    );
    await secondItem.getByRole('button', { name: '立即运行' }).click();
    snapshot = await waitForSnapshot(
      page,
      current => current.routineRuns.some(item =>
        item.routineId === firstRoutine.id && item.status === 'running' &&
        Boolean(item.chatId) && Boolean(item.turnId)
      ) && current.routineRuns.some(item =>
        item.routineId === secondRoutine.id && item.status === 'running' &&
        Boolean(item.chatId) && Boolean(item.turnId)
      ),
      '两条独立 Routine 没有同时处于运行状态'
    );
    const firstRun = snapshot.routineRuns.find(item => item.routineId === firstRoutine.id);
    const secondRun = snapshot.routineRuns.find(item => item.routineId === secondRoutine.id);
    expect(firstRun.chatId).not.toBe(sourceChat.id);
    expect(secondRun.chatId).not.toBe(sourceChat.id);
    expect(firstRun.chatId).not.toBe(secondRun.chatId);
    expect(firstRun.turnId).toBeTruthy();
    expect(secondRun.turnId).toBeTruthy();

    await firstItem.getByRole('button', { name: '停止本次', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '本次执行已停止' })).toBeVisible();
    snapshot = await waitForSnapshot(
      page,
      current => current.routineRuns.find(item => item.id === firstRun.id)?.status === 'interrupted' &&
        current.routineRuns.find(item => item.id === secondRun.id)?.status === 'running',
      '停止第一条 Routine 时没有只中断目标运行'
    );
    expect(snapshot.routineRuns.find(item => item.id === firstRun.id)).toMatchObject({
      status: 'interrupted',
      trigger: 'manual',
      chatId: firstRun.chatId,
      turnId: firstRun.turnId
    });
    expect(snapshot.routineRuns.find(item => item.id === secondRun.id).status).toBe('running');
    await expect(firstItem).toContainText('已中断');
    const sourceMessages = await page.evaluate(chatId => window.rambo.messages(chatId), sourceChat.id);
    expect(sourceMessages.some(message =>
      message.role === 'system' &&
      message.text.includes(firstRoutine.title) &&
      message.text.includes('已中断')
    )).toBe(true);

    await secondItem.getByRole('button', { name: '暂停并停止本次', exact: true }).click();
    await expect(page.getByRole('status').filter({
      hasText: '定时计划已暂停，本次执行已停止'
    })).toBeVisible();
    snapshot = await waitForSnapshot(
      page,
      current => current.routines.find(item => item.id === secondRoutine.id)?.status === 'paused' &&
        current.routineRuns.find(item => item.id === secondRun.id)?.status === 'interrupted',
      '暂停并停止没有同时更新计划与目标运行'
    );
    expect(snapshot.routines.find(item => item.id === firstRoutine.id).status).toBe('active');
    expect(snapshot.routines.find(item => item.id === secondRoutine.id).status).toBe('paused');
    expect(snapshot.routineRuns.find(item => item.id === firstRun.id).status).toBe('interrupted');
    expect(snapshot.routineRuns.find(item => item.id === secondRun.id)).toMatchObject({
      status: 'interrupted',
      chatId: secondRun.chatId,
      turnId: secondRun.turnId
    });
    await expect(secondItem).toContainText('已暂停');
    await expect(secondItem).toContainText('已中断');
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('真实 Electron 验收模式禁止修改系统登录项', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-login-boundary-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  mkdirSync(join(run, 'chromium'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    expect(await page.evaluate(() => window.rambo.loginItemSystemChangesAllowed()))
      .toBe(false);
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('真实 Electron 运行中继续输入时保留发送并显示独立停止', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-steering-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  mkdirSync(join(run, 'chromium'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const page = await app.firstWindow();
    await page.getByLabel('创建 Bot').click();
    const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
    await page.getByLabel('Bot 名称').fill('Steering Pilot');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Bot')).toBeVisible();

    const snapshot = await page.evaluate(() => window.rambo.snapshot());
    const chat = snapshot.chats.find(item => item.botId === snapshot.bots[0].id);
    expect(chat).toBeTruthy();
    await page.evaluate(async chatId => {
      await window.rambo.injectAcceptanceEvent({
        type: 'turn', chatId, turnId: 'turn-e2e-steering'
      });
      await window.rambo.injectAcceptanceEvent({
        type: 'message',
        message: {
          id: 'message-e2e-user',
          chatId,
          role: 'user',
          text: '开始一个长任务',
          status: 'complete',
          createdAt: new Date().toISOString()
        }
      });
    }, chat.id);

    await expect(page.getByRole('button', { name: '停止任务' })).toBeVisible();
    const composer = page.getByPlaceholder('发消息给 Bot');
    await expect(composer).toBeEnabled();
    await composer.fill('补充修改要求');
    await expect(page.getByRole('button', { name: '发送' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '停止任务' })).toBeVisible();
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('真实 Electron 用户修改职责与长期指令后重启仍保留', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-profile-b05-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  mkdirSync(join(run, 'chromium'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  const role = '负责整理项目资料';
  const instructions = '先给出结论，再列出重要依据；不要修改共享资料。';
  let app;
  try {
    const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = () => electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });

    app = await launch();
    let page = await app.firstWindow();
    await page.getByLabel('创建 Bot').click();
    const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
    await page.getByLabel('Bot 名称').fill('Profile Pilot');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByLabel('设置 Profile Pilot').click();
    await page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox').fill(role);
    await page.getByText('长期指令', { exact: true }).locator('..').getByRole('textbox').fill(instructions);
    await page.getByRole('button', { name: '保存资料' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    let snapshot = await page.evaluate(() => window.rambo.snapshot());
    const botId = snapshot.bots.find(bot => bot.name === 'Profile Pilot')?.id;
    expect(botId).toBeTruthy();
    expect(snapshot.bots.find(bot => bot.id === botId)?.role).toBe(role);
    expect(snapshot.bots.find(bot => bot.id === botId)?.instructions).toBe(instructions);
    expect(await page.evaluate(() => window.rambo.memories(null))).toHaveLength(0);
    expect(await page.evaluate(id => window.rambo.memories(id), botId)).toHaveLength(0);

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByLabel('设置 Profile Pilot').click();
    await expect(page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox'))
      .toHaveValue(role);
    await expect(page.getByText('长期指令', { exact: true }).locator('..').getByRole('textbox'))
      .toHaveValue(instructions);
    snapshot = await page.evaluate(() => window.rambo.snapshot());
    expect(snapshot.bots.find(bot => bot.id === botId)?.role).toBe(role);
    expect(snapshot.bots.find(bot => bot.id === botId)?.instructions).toBe(instructions);
    expect(await page.evaluate(() => window.rambo.memories(null))).toHaveLength(0);
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('真实 Electron Bot 自管理写入后界面与重启回读一致', async () => {
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'playwright-self-manage-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  mkdirSync(join(run, 'chromium'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1',
    runId,
    project: root
  }));

  let app;
  const launch = () => electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [root, `--user-data-dir=${profile}`],
    cwd: root,
    env: (() => {
      const value = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
      delete value.NODE_OPTIONS;
      delete value.ELECTRON_RUN_AS_NODE;
      return value;
    })()
  });
  const callTool = async (page, threadId, namespace, tool, argumentsValue, callId) =>
    page.evaluate(({ threadId, namespace, tool, argumentsValue, callId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceTool',
        method: 'item/tool/call',
        params: { threadId, turnId: callId, callId, namespace, tool, arguments: argumentsValue }
      }), { threadId, namespace, tool, argumentsValue, callId });
  try {
    app = await launch();
    let page = await app.firstWindow();
    for (const name of ['Self Pilot', 'Untouched Pilot']) {
      await page.getByLabel('创建 Bot').click();
      await page.getByLabel('Bot 名称').fill(name);
      await page.getByRole('dialog', { name: '创建新 Bot' })
        .getByRole('button', { name: '创建', exact: true }).click();
    }
    let snapshot = await page.evaluate(() => window.rambo.snapshot());
    const self = snapshot.bots.find(bot => bot.name === 'Self Pilot');
    const untouched = snapshot.bots.find(bot => bot.name === 'Untouched Pilot');
    const chat = snapshot.chats.find(item => item.botId === self.id);
    expect(chat).toBeTruthy();
    await page.evaluate(chatId => window.rambo.send(
      chatId, '准备测试 Bot 自管理写入。'
    ), chat.id);
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return Boolean(snapshot.chats.find(item => item.id === chat.id)?.threadId);
    }).toBe(true);
    const threadId = snapshot.chats.find(item => item.id === chat.id).threadId;

    const profileUpdate = await callTool(page, threadId, 'rambo_bot', 'update_profile', {
      name: 'Self Managed', avatar: 'grok-avatar:v1:cloud:blue',
      role: '自主维护资料', instructions: '回答时先给结论。'
    }, 'b13-profile');
    expect(profileUpdate.result.success, profileUpdate.result.contentItems?.[0]?.text).toBe(true);
    const configUpdate = await callTool(page, threadId, 'rambo_bot', 'update_config', {
      model: 'gpt-5.6-luna', permission: 'workspaceWrite',
      chatModel: 'gpt-5.6-luna', chatPermission: 'readOnly'
    }, 'b13-config');
    expect(configUpdate.result.success, configUpdate.result.contentItems?.[0]?.text).toBe(true);
    const memorySave = await callTool(page, threadId, 'rambo_memories', 'save_memory', {
      scope: 'bot', text: 'B13 自主记忆标记'
    }, 'b13-memory');
    expect(memorySave.result.success, memorySave.result.contentItems?.[0]?.text).toBe(true);
    const routineCreate = await callTool(page, threadId, 'rambo_routines', 'create_routine', {
      title: 'Self managed routine retained', instruction: '生成状态摘要',
      schedule: '每个工作日', triggerTime: '09:00', kind: 'recurring'
    }, 'b13-routine');
    expect(routineCreate.result.success, routineCreate.result.contentItems?.[0]?.text).toBe(true);
    await expect.poll(async () => {
      const current = await page.evaluate(() => window.rambo.snapshot());
      return Boolean(current.routines.find(item => item.title === 'Self managed routine retained'));
    }).toBe(true);
    snapshot = await page.evaluate(() => window.rambo.snapshot());
    const routine = snapshot.routines.find(item => item.title === 'Self managed routine retained');
    const routinePause = await callTool(page, threadId, 'rambo_routines', 'set_routine_status', {
      id: routine.id, status: 'paused'
    }, 'b13-routine-pause');
    expect(routinePause.result.success, routinePause.result.contentItems?.[0]?.text).toBe(true);
    const transientCreate = await callTool(page, threadId, 'rambo_routines', 'create_routine', {
      title: 'Self managed transient', instruction: '只用于生命周期检查',
      schedule: '每天', triggerTime: '10:30', kind: 'recurring'
    }, 'b13-transient-create');
    expect(transientCreate.result.success, transientCreate.result.contentItems?.[0]?.text).toBe(true);
    await expect.poll(async () => {
      const current = await page.evaluate(() => window.rambo.snapshot());
      return Boolean(current.routines.find(item => item.title === 'Self managed transient'));
    }).toBe(true);
    snapshot = await page.evaluate(() => window.rambo.snapshot());
    const transient = snapshot.routines.find(item => item.title === 'Self managed transient');
    for (const [callId, tool, argumentsValue] of [
      ['b13-transient-update', 'update_routine', {
        id: transient.id, title: 'Self managed updated', schedule: '每周一 11:00'
      }],
      ['b13-transient-pause', 'set_routine_status', { id: transient.id, status: 'paused' }],
      ['b13-transient-resume', 'set_routine_status', { id: transient.id, status: 'active' }],
      ['b13-transient-delete', 'delete_routine', { id: transient.id }]
    ]) {
      const result = await callTool(
        page, threadId, 'rambo_routines', tool, argumentsValue, callId
      );
      expect(result.result.success, result.result.contentItems?.[0]?.text).toBe(true);
    }
    await expect.poll(async () => {
      const current = await page.evaluate(() => window.rambo.snapshot());
      return current.routines.some(item => item.id === transient.id);
    }).toBe(false);

    snapshot = await page.evaluate(() => window.rambo.snapshot());
    const managed = snapshot.bots.find(bot => bot.id === self.id);
    expect(managed).toMatchObject({
      name: 'Self Managed', avatar: 'grok-avatar:v1:cloud:blue',
      role: '自主维护资料', instructions: '回答时先给结论。',
      model: 'gpt-5.6-luna', permission: 'workspaceWrite'
    });
    expect(snapshot.chats.find(item => item.id === chat.id)).toMatchObject({
      model: 'gpt-5.6-luna', permission: 'readOnly'
    });
    expect(await page.evaluate(id => window.rambo.memories(id), self.id))
      .toHaveLength(1);
    const memory = (await page.evaluate(id => window.rambo.memories(id), self.id))[0];
    expect(snapshot.routines.find(item => item.id === routine.id)).toMatchObject({
      botId: self.id, status: 'paused'
    });
    expect(snapshot.bots.find(bot => bot.id === untouched.id)).toMatchObject({
      name: 'Untouched Pilot', role: '', model: null, permission: 'fullAccess'
    });
    await expect(page.getByRole('button', { name: /Self Managed/ }).first()).toBeVisible();
    await page.getByLabel('设置 Self Managed').click();
    await expect(page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox'))
      .toHaveValue('自主维护资料');
    await expect(page.getByText('长期指令', { exact: true }).locator('..').getByRole('textbox'))
      .toHaveValue('回答时先给结论。');
    await expect(page.getByLabel('Bot 专属长期记忆条目').getByText('B13 自主记忆标记'))
      .toBeVisible();
    await expect(page.getByLabel('Self Managed 管理的定时任务')
      .getByText('Self managed routine retained')).toBeVisible();
    await expect(page.getByLabel('Self Managed 管理的定时任务')
      .getByText('已暂停')).toBeVisible();
    await expect(page.getByLabel('Self Managed 管理的定时任务')
      .getByText('Self managed transient')).toHaveCount(0);

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: /Self Managed/ }).first()).toBeVisible();
    await page.getByLabel('设置 Self Managed').click();
    await expect(page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox'))
      .toHaveValue('自主维护资料');
    await expect(page.getByLabel('Bot 专属长期记忆条目').getByText('B13 自主记忆标记'))
      .toBeVisible();
    const memoryDelete = await callTool(page, threadId, 'rambo_memories', 'delete_memory', {
      id: memory.id
    }, 'b13-memory-delete');
    expect(memoryDelete.result.success, memoryDelete.result.contentItems?.[0]?.text).toBe(true);
    await expect(page.getByLabel('Bot 专属长期记忆条目').getByText('B13 自主记忆标记'))
      .toHaveCount(0);
    expect(await page.evaluate(id => window.rambo.memories(id), self.id)).toHaveLength(0);
    await page.getByRole('button', { name: /全部定时任务/ }).click();
    const overview = page.getByLabel('所有 Bot 的定时任务');
    await expect(overview.getByText('Self managed routine retained')).toBeVisible();
    await expect(overview.getByText(/Self Managed.*每个工作日 09:00/)).toBeVisible();
    await expect(overview.getByText('已暂停')).toBeVisible();
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('真实 Electron 模型与权限覆盖可回读并在重启后保持', async () => {
  const run = realpathSync(mkdtempSync(join(root, 'acceptance-runs', 'playwright-model-overrides-')));
  const runId = run.slice(run.lastIndexOf('/') + 1);
  const profile = join(run, 'profile');
  mkdirSync(profile);
  mkdirSync(join(run, 'chromium'));
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    schema: 'rambo.acceptance.run.v1', runId, project: root
  }));
  let app;
  const launch = () => electron.launch({
    executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [root, `--user-data-dir=${profile}`], cwd: root,
    env: (() => {
      const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
      delete env.NODE_OPTIONS;
      delete env.ELECTRON_RUN_AS_NODE;
      return env;
    })()
  });
  try {
    app = await launch();
    let page = await app.firstWindow();
    for (const name of ['Model Pilot', 'Model Peer']) {
      await page.getByLabel('创建 Bot').click();
      await page.getByLabel('Bot 名称').fill(name);
      await page.getByRole('dialog', { name: '创建新 Bot' })
        .getByRole('button', { name: '创建', exact: true }).click();
    }
    let snapshot = await page.evaluate(() => window.rambo.snapshot());
    const pilot = snapshot.bots.find(bot => bot.name === 'Model Pilot');
    const peer = snapshot.bots.find(bot => bot.name === 'Model Peer');
    const models = await page.evaluate(() => window.rambo.models());
    expect(models.length, '真实模型目录为空，无法验证模型覆盖').toBeGreaterThan(0);
    const selectedModel = models.find(option => option.isDefault) ?? models[0];
    await page.getByLabel('设置 Model Pilot').click();
    const botModel = page.getByText('默认模型', { exact: true })
      .locator('..').getByRole('combobox');
    await botModel.selectOption(selectedModel.id);
    await expect(botModel).toHaveValue(selectedModel.id);
    await page.getByText('只读', { exact: true }).click();
    await page.getByRole('button', { name: '保存资料' }).click();
    await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();

    await page.getByRole('button', { name: /Model Pilot/ }).first().click();
    const chatModel = page.getByLabel('当前聊天模型');
    await chatModel.selectOption(selectedModel.id);
    await expect(chatModel).toHaveValue(selectedModel.id);
    const permission = page.getByLabel('当前聊天权限');
    await permission.selectOption('workspaceWrite');
    await expect(permission).toHaveValue('workspaceWrite');
    await expect(permission).toHaveAttribute('title', '仅此聊天的权限覆盖');
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return snapshot.chats.find(chat => chat.botId === pilot.id)?.permission;
    }).toBe('workspaceWrite');
    expect(snapshot.bots.find(bot => bot.id === pilot.id)?.model).toBe(selectedModel.id);
    expect(snapshot.chats.find(chat => chat.botId === pilot.id)?.model).toBe(selectedModel.id);
    expect(snapshot.bots.find(bot => bot.id === pilot.id)?.permission).toBe('readOnly');
    expect(snapshot.bots.find(bot => bot.id === peer.id)?.model).toBeNull();
    expect(snapshot.chats.find(chat => chat.botId === peer.id)?.model).toBeNull();
    expect(snapshot.chats.find(chat => chat.botId === peer.id)?.permission).toBeNull();
    expect(snapshot.bots.find(bot => bot.id === peer.id)?.permission).toBe('fullAccess');

    await page.evaluate(chatId => window.rambo.injectAcceptanceEvent({
      type: 'turn', chatId, turnId: null
    }), snapshot.chats.find(chat => chat.botId === pilot.id).id);
    await page.getByRole('button', { name: /Model Pilot/ }).first().click();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByLabel('设置 Model Pilot').click();
    await expect(page.getByText('默认模型', { exact: true })
      .locator('..').getByRole('combobox')).toHaveValue(selectedModel.id);
    await expect(page.getByRole('radio', { name: /只读/ })).toBeChecked();
    await page.getByRole('button', { name: /Model Pilot/ }).first().click();
    await expect(page.getByLabel('当前聊天模型')).toHaveValue(selectedModel.id);
    await expect(page.getByLabel('当前聊天权限')).toHaveValue('workspaceWrite');
    snapshot = await page.evaluate(() => window.rambo.snapshot());
    expect(snapshot.bots.find(bot => bot.id === pilot.id)?.model).toBe(selectedModel.id);
    expect(snapshot.chats.find(chat => chat.botId === pilot.id)?.model).toBe(selectedModel.id);
    expect(snapshot.bots.find(bot => bot.id === pilot.id)?.permission).toBe('readOnly');
    expect(snapshot.chats.find(chat => chat.botId === pilot.id)?.permission).toBe('workspaceWrite');
    expect(snapshot.chats.find(chat => chat.botId === peer.id)?.permission).toBeNull();
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});
