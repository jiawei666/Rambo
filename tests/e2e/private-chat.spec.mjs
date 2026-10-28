import { createElectronTest, expect } from './fixtures/electron-app.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const test = createElectronTest('playwright-private');
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test.describe.configure({ mode: 'serial' });

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

async function waitForBoundTurn(page, chatId) {
  let observed = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const turn = await page.evaluate(async id => {
      const snapshot = await window.rambo.snapshot();
      const chat = snapshot.chats.find(item => item.id === id);
      const active = snapshot.activeTurns[id] ?? null;
      const records = await window.rambo.turns(id);
      return {
        chatThreadId: chat?.threadId ?? null,
        activeTurnId: active,
        turnIds: records.map(record => record.turnId).filter(Boolean),
        bound: Boolean(active) && records.some(record =>
          record.turnId === active && record.threadId === chat?.threadId
        )
      };
    }, chatId);
    observed = turn;
    if (turn.bound) return { turnId: turn.activeTurnId, threadId: turn.chatThreadId };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`发送回合没有绑定到当前 thread：${JSON.stringify(observed)}`);
}

async function settleInitialBotTurn(page, botId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastInterruptAt = 0;
  let observed = [];
  while (Date.now() < deadline) {
    observed = await page.evaluate(async id => {
      const snapshot = await window.rambo.snapshot();
      const chats = snapshot.chats.filter(chat => chat.botId === id && !chat.groupChatId);
      return Promise.all(chats.map(async chat => {
        const [turns, messages] = await Promise.all([
          window.rambo.turns(chat.id),
          window.rambo.messages(chat.id)
        ]);
        return {
          chatId: chat.id,
          activeTurnId: snapshot.activeTurns[chat.id] ?? null,
          starting: snapshot.startingTurns[chat.id] === true,
          turnCount: turns.length,
          unsettledTurn: turns.some(turn =>
            turn.status === 'starting' || turn.status === 'running'
          ),
          greetingFailed: messages.some(message =>
            message.role === 'system' && message.status === 'failed'
          )
        };
      }));
    }, botId);
    const activeChat = observed.find(chat =>
      chat.activeTurnId && !chat.starting
    );
    if (activeChat && Date.now() - lastInterruptAt >= 1_000) {
      try {
        await page.evaluate(chatId => window.rambo.interrupt(chatId), activeChat.chatId);
      } catch {
        // The greeting may finish between the snapshot and the interrupt request.
      }
      lastInterruptAt = Date.now();
    }
    const pending = observed.some(chat =>
      chat.activeTurnId || chat.starting || chat.unsettledTurn
    );
    const settled = !pending && observed.some(chat =>
      chat.turnCount > 0 || chat.greetingFailed
    );
    if (settled) {
      // Let sendConversation's finally block release its internal busy marker.
      await page.waitForTimeout(100);
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Bot 的创建问候回合未在限定时间内结束：${JSON.stringify(observed)}`);
}

async function computedColorAsRgb(locator) {
  return locator.evaluate(element => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法创建颜色采样画布');
    context.fillStyle = '#010203';
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  });
}

async function expectVoiceErrorToFit(locator) {
  const presentation = await locator.evaluate(shell => {
    const title = shell.querySelector('.current-bot-voice-error-title');
    const detail = shell.querySelector('.current-bot-voice-error-detail');
    const pill = shell.querySelector('.current-bot-pill-voice');
    const retry = shell.querySelector('.current-bot-voice-retry');
    const titleRect = title.getBoundingClientRect();
    const detailRect = detail.getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    const retryRect = retry.getBoundingClientRect();
    return {
      titleClipped: title.scrollWidth > title.clientWidth + 1 ||
        title.scrollHeight > title.clientHeight + 1,
      detailFitsTwoLines: detailRect.height <=
        Number.parseFloat(getComputedStyle(detail).lineHeight) * 2 + 1,
      detailOverlapsTitle: detailRect.top < titleRect.bottom - 1,
      titleInsidePill: titleRect.left >= pillRect.left && titleRect.right <= pillRect.right,
      detailInsidePill: detailRect.left >= pillRect.left && detailRect.right <= pillRect.right,
      retryVisible: retryRect.width === 34 && retryRect.height === 34,
      retryAfterPill: retryRect.x >= pillRect.right,
      pillInsideViewport: pillRect.left >= 0 &&
        pillRect.right <= document.documentElement.clientWidth,
      retryInsideViewport: retryRect.left >= 0 &&
        retryRect.right <= document.documentElement.clientWidth
    };
  });
  expect(presentation).toEqual({
    titleClipped: false,
    detailFitsTwoLines: true,
    detailOverlapsTitle: false,
    titleInsidePill: true,
    detailInsidePill: true,
    retryVisible: true,
    retryAfterPill: true,
    pillInsideViewport: true,
    retryInsideViewport: true
  });
}

async function waitForRuntimeProcess(appPid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8'
    }).split('\n');
    const runtime = processes.find(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match?.[2] === String(appPid) &&
        /(?:^|\s)(?:\S*\/)?codex(?:-app-server)?\s+app-server\s+--listen\s+stdio:\/\//u.test(match[3]);
    })?.trim().match(/^(\d+)/)?.[1];
    if (runtime) return Number(runtime);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Electron ${appPid} 没有启动直接管理的 App Server`);
}

async function openBotSettings(page, botName) {
  await page.getByRole('button', { name: new RegExp(botName) }).first().click();
  await page.getByRole('button', { name: `打开 ${botName} 设置` }).click();
}

async function openSystemSettings(page, tabName) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const tab = page.getByRole('tab', { name: tabName, exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
}

async function openConnectors(page) {
  await page.getByRole('button', { name: '连接应用', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接应用', exact: true })).toBeVisible();
}

async function expectUnframedConnectorLogo(icon) {
  const logo = icon.locator('img.connector-provider-logo');
  await expect(logo).toBeVisible();
  const presentation = await icon.evaluate(element => {
    const style = getComputedStyle(element);
    const image = element.querySelector('img');
    const imageStyle = image ? getComputedStyle(image) : null;
    return {
      naturalWidth: image?.naturalWidth ?? 0,
      width: style.width,
      height: style.height,
      borderWidth: style.borderTopWidth,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      boxShadow: style.boxShadow,
      imageWidth: imageStyle?.width,
      imageHeight: imageStyle?.height
    };
  });
  expect(presentation).toEqual({
    naturalWidth: expect.any(Number),
    width: '40px',
    height: '40px',
    borderWidth: '0px',
    borderRadius: '0px',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    boxShadow: 'none',
    imageWidth: '40px',
    imageHeight: '40px'
  });
  expect(presentation.naturalWidth).toBeGreaterThan(0);
}

async function sampleOpacityTransition(page, action, duration = 500) {
  await action();
  return page.locator('.chat-scrollbar').evaluate(async (element, sampleDuration) => {
    const samples = [];
    const startedAt = performance.now();
    while (performance.now() - startedAt <= sampleDuration) {
      samples.push(Number.parseFloat(getComputedStyle(element).opacity));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    samples.push(Number.parseFloat(getComputedStyle(element).opacity));
    return samples;
  }, duration);
}

test('真实 Electron 从空白状态创建 Bot 并直接进入唯一私聊', async ({ electron, acceptanceRun }) => {
    const app = electron.app;
    const stderr = [];
    app.process().stderr?.on('data', chunk => stderr.push(chunk.toString()));
    const page = electron.page;
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    expect(userData).toBe(acceptanceRun.profile);
    await expect(page).toHaveTitle('Rambo').catch(error => {
      throw new Error(`${error.message}\nElectron stderr:\n${stderr.join('')}`);
    });
    await page.getByLabel('创建 Bot').click();
    const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
    await expect(dialog).toBeVisible();
    await dialog.locator('form').evaluate(form => form.requestSubmit());
    await expect(page.getByText('请输入 Bot 名称。')).toBeVisible();
    await expect(dialog).toBeVisible();
    await page.getByLabel('Bot 名称').fill('E2E Pilot');
    await dialog.getByRole('button', { name: '蓝色', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '蓝色', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByText('开始聊天')).toBeVisible();
    await expect(page.getByRole('button', { name: /E2E Pilot/ }).first()).toBeVisible();
    await expect(page.getByPlaceholder('发消息给 E2E Pilot')).toBeVisible();
    await expect(page.getByRole('button', { name: '打开 E2E Pilot 设置' })).toBeVisible();
    await page.getByRole('button', { name: '打开 E2E Pilot 设置' }).click();
    await expect(page.getByRole('tab', { name: '基础资料' })).toHaveAttribute('aria-selected', 'true');
    for (const tab of ['模型与权限', '长期记忆', '定时任务', 'Bot 管理']) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    }
    await page.getByRole('tab', { name: '定时任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '当前 Bot 的定时任务' })).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: '定时任务' }).getByText('暂无定时任务')).toBeVisible();
    await page.getByRole('button', { name: /返回聊天/ }).click();
    await expect(page.getByPlaceholder('发消息给 E2E Pilot')).toBeVisible();
    await expect(page.getByLabel('会话列表').getByText('E2E Pilot')).toBeVisible();
    await expect(page.getByText('欢迎', { exact: false })).toHaveCount(0);
    await expect(page.getByText('示例任务', { exact: false })).toHaveCount(0);
    await expect(page.locator('.message-row')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /E2E Pilot/ }).first().click();
    await expect(page.locator('.messages-loading')).toHaveCount(0);
    await expect(page.getByPlaceholder('发消息给 E2E Pilot')).toBeVisible();

    const snapshot = await page.evaluate(() => window.rambo.snapshot());
    expect(snapshot.bots.filter(bot => bot.name === 'E2E Pilot')).toHaveLength(1);
    const pilot = snapshot.bots.find(bot => bot.name === 'E2E Pilot');
    expect(pilot?.avatar).toMatch(/^agent-robot:v2:100:blue:[a-z]+$/);
    expect(snapshot.chats.filter(chat =>
      chat.botId === pilot.id && !chat.groupChatId && !chat.archived
    )).toHaveLength(1);
    acceptanceRun.evidence.pilot = {
      id: pilot.id,
      avatar: pilot.avatar,
      chatId: snapshot.chats.find(chat => chat.botId === pilot.id)?.id
    };
});

test('真实 Electron 系统设置保存新建 Bot 初值且不改已有 Bot', async ({ electron }) => {
  const page = electron.page;
  const footer = page.locator('.sidebar-footer');
  const footerButtons = footer.locator(':scope > button');
  await expect(footerButtons).toHaveCount(2);
  await expect(footerButtons.nth(0)).toHaveAttribute('aria-label', '设置');
  await expect(footerButtons.nth(1)).toHaveAttribute('aria-label', '连接应用');
  await expect(footer.locator('.runtime-mini')).toHaveCount(0);
  await page.getByRole('button', { name: '收起侧栏' }).click();
  const compactFooter = await page.evaluate(() => {
    const footer = document.querySelector('.sidebar-footer');
    const [account, connectors] = [...footer.querySelectorAll(':scope > button')]
      .map(button => button.getBoundingClientRect());
    const bounds = footer.getBoundingClientRect();
    return {
      accountX: account.x,
      accountY: account.y,
      connectorsX: connectors.x,
      connectorsY: connectors.y,
      connectorsRight: connectors.right,
      footerRight: bounds.right
    };
  });
  expect(compactFooter.connectorsX).toBeGreaterThan(compactFooter.accountX);
  expect(compactFooter.connectorsY).toBeCloseTo(compactFooter.accountY, 0);
  expect(compactFooter.connectorsRight).toBeLessThanOrEqual(compactFooter.footerRight);
  await page.getByRole('button', { name: '展开侧栏' }).click();

  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Autosave Pilot');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();

  let snapshot = await page.evaluate(() => window.rambo.snapshot());
  const initialBot = snapshot.bots.find(item => item.name === 'Autosave Pilot');
  expect(initialBot).toBeTruthy();
  const initialModel = initialBot.model;
  const initialPermission = initialBot.permission;
  const models = await page.evaluate(() => window.rambo.models());
  expect(models.length, '真实模型目录为空，无法验证新建 Bot 初值').toBeGreaterThan(0);
  const globalModelValue = models.find(option => option.isDefault) ?? models[0];
  const sessionModelValue = models.find(option => option.id !== globalModelValue.id) ?? globalModelValue;
  await openSystemSettings(page, '新建 Bot 初值');
  await expect(page.getByRole('tab', { name: '连接应用', exact: true })).toHaveCount(0);
  const globalModel = page.getByLabel('新建 Bot 模型');
  const settingsLayout = await page.evaluate(() => {
    const modelCard = document.querySelector('.global-model-card');
    const modelSelect = modelCard.querySelector('select');
    const modelChevron = modelCard.querySelector('.select-input-chevron');
    const permissionCard = document.querySelector('.global-permission-card');
    const permissionHeading = permissionCard.querySelector('.global-default-card-heading');
    const selectRect = modelSelect.getBoundingClientRect();
    const chevronRect = modelChevron.getBoundingClientRect();
    return {
      modelWidthRatio: selectRect.width / modelCard.clientWidth,
      modelChevronInset: selectRect.right - chevronRect.right,
      permissionHeadingInset: permissionHeading.getBoundingClientRect().top - permissionCard.getBoundingClientRect().top,
      cardGap: permissionCard.getBoundingClientRect().top - modelCard.getBoundingClientRect().bottom
    };
  });
  expect(settingsLayout.modelWidthRatio).toBeGreaterThan(0.9);
  expect(settingsLayout.modelChevronInset).toBeGreaterThan(20);
  expect(settingsLayout.permissionHeadingInset).toBeGreaterThan(10);
  expect(settingsLayout.cardGap).toBeGreaterThanOrEqual(14);
  await expect(page.getByRole('heading', { name: '新建 Bot 权限', exact: true })).toBeVisible();
  await expect(page.getByText('更改会自动保存', { exact: true })).toHaveCount(0);
  await expect(page.locator('.global-default-save-status')).toHaveCount(0);
  const currentModelId = await globalModel.inputValue();
  const availableModelIds = await globalModel.locator('option').evaluateAll(options =>
    options.map(option => option.value).filter(Boolean)
  );
  const nextModelId = availableModelIds.find(id => id !== currentModelId);
  const nextGlobalModel = models.find(option => option.id === nextModelId);
  expect(nextGlobalModel, '模型目录至少需要两个不同选项才能验证自动保存').toBeDefined();
  expect(nextGlobalModel.id).not.toBe(currentModelId);
  await globalModel.selectOption(nextGlobalModel.id);
  await expect(page.locator('.global-default-save-status')).toBeVisible();
  await expect(page.locator('.global-default-save-status .autosave-indicator'))
    .toHaveText(/正在自动保存…|已自动保存/);
  await expect.poll(async () => (await page.evaluate(() => window.rambo.snapshot())).settings.defaultBotModel)
    .toBe(nextGlobalModel.id);
  await page.getByRole('radio', { name: /只读/ }).click();
  await expect.poll(async () => (await page.evaluate(() => window.rambo.snapshot())).settings.defaultBotPermission)
    .toBe('readOnly');
  await expect(page.locator('.global-default-save-status'))
    .toHaveCount(0, { timeout: 3_000 });
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.bots.find(item => item.id === initialBot.id)).toMatchObject({
    model: initialModel,
    permission: initialPermission
  });

  await openBotSettings(page, 'Autosave Pilot');
  await expect(page.getByRole('tab', { name: '定时任务', exact: true })).toBeVisible();
  await expect(page.locator('.autosave-indicator')).toHaveCount(0);
  const role = '自动保存的 Bot 职责';
  await page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox').fill(role);
  await expect(page.locator('.autosave-indicator').filter({ hasText: '已自动保存' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存资料', exact: true })).toHaveCount(0);
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  const bot = snapshot.bots.find(item => item.name === 'Autosave Pilot');
  expect(bot?.role).toBe(role);

  await page.getByRole('tab', { name: '模型与权限' }).click();
  await expect(page.locator('.autosave-indicator')).toHaveCount(0);
  await expect(page.getByText('继承全局', { exact: false })).toHaveCount(0);
  const sessionModel = page.getByLabel('Bot 模型');
  await sessionModel.selectOption(sessionModelValue.id);
  await page.getByRole('radio', { name: /工作区写入/ }).click();
  await expect(page.locator('.autosave-indicator').filter({ hasText: '已自动保存' })).toBeVisible();
  const current = await page.evaluate(() => window.rambo.snapshot());
  const autosaveBot = current.bots.find(item => item.name === 'Autosave Pilot');
  const autosaveChat = current.chats.find(item => item.botId === autosaveBot.id);
  expect(current.settings.defaultBotModel).toBe(nextGlobalModel.id);
  expect(current.settings.defaultBotPermission).toBe('readOnly');
  expect(autosaveBot).toMatchObject({
    model: sessionModelValue.id,
    permission: 'workspaceWrite'
  });
  expect(autosaveChat).toMatchObject({ model: null, permission: null });
  await openConnectors(page);
  await openSystemSettings(page, '定时任务');
  await expect(page.getByLabel('所有 Bot 的定时任务')).toBeVisible();
});

test('密钥安全输入框只把正文交给宿主并清除界面状态', async ({ electron }) => {
  const page = electron.page;
  const snapshot = await page.evaluate(() => window.rambo.snapshot());
  const bot = snapshot.bots.find(item => item.name === 'E2E Pilot');
  const chat = snapshot.chats.find(item => item.botId === bot?.id && !item.groupChatId);
  if (!bot || !chat) throw new Error('密钥安全输入测试缺少 E2E Pilot 私聊');

  await page.evaluate(() => {
    window.__ramboSecretCaptureEvents = [];
    window.rambo.onEvent(event => {
      if (event.type === 'secretCapture' || event.type === 'secretCaptureResolved') {
        window.__ramboSecretCaptureEvents.push(event);
      }
    });
  });
  const requestId = 'e2e-secret-capture-save';
  const secret = 'e2e-secret-body-must-not-render';
  await page.evaluate(({ requestId, bot, chat }) => window.rambo.injectAcceptanceEvent({
    type: 'secretCapture',
    requestId,
    chatId: chat.id,
    botId: bot.id,
    botName: bot.name,
    operation: 'save',
    name: 'E2E 发布令牌',
    description: '仅用于验证本机安全输入闭环',
    scope: 'bot'
  }), { requestId, bot, chat });

  const dialog = page.getByRole('dialog', { name: '保存密钥' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('E2E Pilot · 仅当前 Bot 可用', { exact: true })).toBeVisible();
  const input = dialog.getByLabel('密钥正文');
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill(secret);
  await dialog.getByRole('button', { name: '安全保存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(secret);
  await expect.poll(() => page.evaluate(() =>
    window.__ramboSecretCaptureEvents.some(event =>
      event.type === 'secretCaptureResolved' && event.requestId === 'e2e-secret-capture-save'
    )
  )).toBe(true);
});

test('连接应用市场显示五个应用、品牌图标并适配明暗主题', async ({ electron }) => {
  const page = electron.page;
  await openConnectors(page);
  await expect(page.getByRole('heading', { name: '连接应用', exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(5);
  await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('article').filter({ hasText: 'Gmail' })).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: 'QQ 邮箱' })).toBeVisible();
  for (const name of ['Gmail', 'QQ 邮箱', '微信', '日历', 'GitHub']) {
    const card = page.getByRole('article').filter({ hasText: name });
    await expectUnframedConnectorLogo(card.locator('.connector-icon-has-logo'));
    if (name === '日历') {
      expect(await card.locator('img.connector-provider-logo').evaluate(image => image.naturalWidth)).toBe(256);
    }
  }
  const gmailConnectButton = page.getByRole('article').filter({ hasText: 'Gmail' })
    .getByRole('button', { name: '连接', exact: true });
  await expect(gmailConnectButton.locator('svg')).toHaveCount(0);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const contrast = await gmailConnectButton.evaluate(button => {
      const channels = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
      const luminance = value => channels(value).map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const style = getComputedStyle(button);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return {
        ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        foreground: style.color,
        background: style.backgroundColor,
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches
      };
    });
    expect(contrast.ratio,
      `${colorScheme} theme connect button contrast ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  for (const name of ['日历', 'GitHub']) {
    await expect(page.getByRole('article').filter({ hasText: name })
      .getByRole('button', { name: '即将推出' })).toBeDisabled();
  }
  for (const removedName of ['云盘', 'Notion', 'Slack']) {
    await expect(page.getByRole('article').filter({ hasText: removedName })).toHaveCount(0);
  }

  await page.getByLabel('搜索连接应用').fill('QQ');
  await expect(page.getByRole('article').filter({ hasText: 'QQ 邮箱' })).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: 'Gmail' })).toHaveCount(0);
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.getByRole('article').filter({ hasText: 'Gmail' })).toBeVisible();

  const qqCard = page.getByRole('article').filter({ hasText: 'QQ 邮箱' });
  await qqCard.getByRole('button', { name: '连接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'QQ 邮箱' });
  await expect(dialog).toBeVisible();
  await expectUnframedConnectorLogo(dialog.locator('.connector-icon-has-logo'));
  await expect(dialog.getByText('QQ 邮箱连接说明')).toBeVisible();
  await expect(dialog.getByText(/不是 QQ 登录密码/)).toBeVisible();
  await dialog.getByLabel('连接名称').fill('工作 QQ 邮箱');
  await dialog.getByLabel('QQ 邮箱地址').fill('connector-pilot@qq.com');
  await expect(dialog.getByLabel('邮箱授权码')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: '保存连接' })).toBeDisabled();

  const snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.connections.some(item => item.accountLabel === 'connector-pilot@qq.com')).toBe(false);
  expect(snapshot.connectorGrants).toEqual([]);
  expect(JSON.stringify(snapshot)).not.toContain('test-authorization-only');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'QQ 邮箱' })).toHaveCount(0);
});

test('全局资源目录增删同步，Bot 开关在创建后独立', async ({ electron }) => {
  const page = electron.page;
  const initial = await page.evaluate(() => window.rambo.snapshot());
  expect(initial.globalResourceIds).toContain('skill:documents');
  expect(initial.globalDefaultResourceIds).toContain('skill:documents');
  expect(initial.globalResourceIds).toContain('mcp:playwright');
  expect(initial.globalDefaultResourceIds).toContain('mcp:playwright');
  expect(initial.globalResourceIds).not.toContain('skill:research');
  expect(initial.globalDefaultResourceIds).not.toContain('skill:research');
  expect(initial.botResources.some(resource =>
    resource.id === 'mcp:cua_repl')).toBe(false);
  expect(initial.botResources.some(resource =>
    resource.kind === 'plugin' && resource.id === 'plugin:computer-use')).toBe(true);
  for (const resource of initial.botResources.filter(item =>
    item.kind === 'mcp' && item.id !== 'mcp:playwright'
  )) expect(initial.globalResourceIds).not.toContain(resource.id);

  for (const name of ['Resource Alpha', 'Resource Beta']) {
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill(name);
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 ' + name)).toBeVisible();
  }
  let snapshot = await page.evaluate(() => window.rambo.snapshot());
  const alpha = snapshot.bots.find(bot => bot.name === 'Resource Alpha');
  const beta = snapshot.bots.find(bot => bot.name === 'Resource Beta');
  expect(alpha.resourceIds).toContain('skill:documents');
  expect(beta.resourceIds).toContain('skill:documents');

  await openSystemSettings(page, '资源管理');
  const globalPanel = page.getByRole('tabpanel', { name: '资源管理' });
  for (const name of [/^技能/, /^MCP 服务/, /^插件/]) {
    await expect(globalPanel.getByRole('tab', { name })).toBeVisible();
  }
  const subtabPresentation = async colorScheme => {
    await page.emulateMedia({ colorScheme });
    await expect.poll(async () => globalPanel.locator('.resource-subtab.selected small')
      .evaluate(badge => getComputedStyle(badge).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    return globalPanel.locator('.resource-subtabs').evaluate(tablist => {
      const tabs = [...tablist.querySelectorAll('.resource-subtab')];
      const selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
      const badge = selected?.querySelector('small');
      return {
        count: tabs.length,
        minHeight: Math.min(...tabs.map(tab =>
          tab.getBoundingClientRect().height)),
        selectedBackground: selected ? getComputedStyle(selected).backgroundColor : '',
        selectedBackgroundImage: selected ? getComputedStyle(selected).backgroundImage : '',
        selectedColor: selected ? getComputedStyle(selected).color : '',
        badgeBackground: badge ? getComputedStyle(badge).backgroundColor : '',
        badgeColor: badge ? getComputedStyle(badge).color : ''
      };
    });
  };
  for (const colorScheme of ['light', 'dark']) {
    const presentation = await subtabPresentation(colorScheme);
    expect(presentation.count).toBe(3);
    expect(presentation.minHeight).toBeGreaterThanOrEqual(40);
    expect(
      presentation.selectedBackgroundImage !== 'none' ||
      !/rgba?\([^)]*,\s*0\)/u.test(presentation.selectedBackground),
      `${colorScheme} selected resource subtab has no visible background`
    ).toBe(true);
    for (const color of [
      presentation.selectedColor,
      presentation.badgeBackground,
      presentation.badgeColor
    ]) expect(color, `${colorScheme} ${JSON.stringify(presentation)}`).not.toMatch(/rgba?\([^)]*,\s*0\)/u);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await globalPanel.getByRole('tab', { name: /^MCP 服务/ }).click();
  await expect(globalPanel.locator('.resource-row[data-resource-id="mcp:cua_repl"]')).toHaveCount(0);
  await globalPanel.getByRole('tab', { name: /^插件/ }).click();
  await globalPanel.getByRole('button', { name: /发现目录/ }).click();
  await globalPanel.getByLabel('搜索资源').fill('Computer Use');
  const computerUseRow = globalPanel.locator(
    '.resource-row[data-resource-id="plugin:computer-use"]'
  );
  await expect(computerUseRow).toBeVisible();
  await expect(computerUseRow.getByText(/Plugin · openai-bundled/u)).toBeVisible();
  await globalPanel.getByRole('tab', { name: /^技能/ }).click();
  await globalPanel.getByLabel('搜索资源').fill('');
  await globalPanel.getByRole('button', { name: /发现目录/ }).click();
  const documents = page.getByLabel('启用 documents');
  await expect(documents).toBeChecked();
  await documents.click();
  await expect.poll(async () =>
    (await page.evaluate(() => window.rambo.snapshot())).globalDefaultResourceIds
  ).not.toContain('skill:documents');
  await expect(documents).not.toBeChecked();
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.bots.find(bot => bot.id === alpha.id).resourceIds).toContain('skill:documents');
  expect(snapshot.bots.find(bot => bot.id === beta.id).resourceIds).toContain('skill:documents');
  await globalPanel.getByRole('tab', { name: /^MCP 服务/ }).click();
  const playwrightRow = globalPanel.locator('.resource-row[data-resource-id="mcp:playwright"]');
  await expect(playwrightRow.getByRole('button', { name: '验证 Chrome 连接' })).toBeVisible();
  await expect(playwrightRow.getByRole('status')).toHaveText('尚未验证 Chrome 扩展连接');

  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Resource Gamma');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 Resource Gamma')).toBeVisible();
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  const gamma = snapshot.bots.find(bot => bot.name === 'Resource Gamma');
  expect(gamma.resourceIds).not.toContain('skill:documents');

  await openSystemSettings(page, '资源管理');
  await globalPanel.getByRole('tab', { name: /^技能/ }).click();
  await globalPanel.getByRole('button', { name: /发现目录/ }).click();
  await globalPanel.getByLabel('搜索资源').fill('research');
  const researchRow = globalPanel.locator('.resource-row[data-resource-id="skill:research"]');
  await expect(researchRow.getByRole('button', { name: '加入可选目录' })).toBeVisible();
  await researchRow.getByRole('button', { name: '加入可选目录' }).click();
  await expect.poll(async () =>
    (await page.evaluate(() => window.rambo.snapshot())).globalResourceIds
  ).toContain('skill:research');
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.globalDefaultResourceIds).not.toContain('skill:research');
  for (const bot of snapshot.bots.filter(item =>
    ['Resource Alpha', 'Resource Beta', 'Resource Gamma'].includes(item.name)
  )) expect(bot.resourceIds).not.toContain('skill:research');

  await openBotSettings(page, 'Resource Alpha');
  await page.getByRole('tab', { name: '资源管理' }).click();
  const botResourcePanel = page.getByRole('tabpanel', { name: '资源管理' });
  for (const name of [/^技能/, /^MCP 服务/, /^插件/]) {
    await expect(botResourcePanel.getByRole('tab', { name })).toBeVisible();
  }
  await expect(page.getByLabel('启用 documents')).toBeChecked();
  await expect(page.getByLabel('启用 research')).toBeVisible();
  await expect(page.getByLabel('启用 research')).not.toBeChecked();
  await openBotSettings(page, 'Resource Beta');
  await page.getByRole('tab', { name: '资源管理' }).click();
  const betaDocuments = page.getByLabel('启用 documents');
  await expect(betaDocuments).toBeChecked();
  await betaDocuments.click();
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.rambo.snapshot());
    return current.bots.find(bot => bot.id === beta.id).resourceIds;
  }).not.toContain('skill:documents');
  await page.getByLabel('启用 research').click();
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.rambo.snapshot());
    const currentBeta = current.bots.find(bot => bot.id === beta.id);
    return currentBeta.resourceIds.includes('skill:research');
  }).toBe(true);

  await openBotSettings(page, 'Resource Alpha');
  await page.getByRole('tab', { name: '资源管理' }).click();
  await page.getByLabel('启用 documents').click();
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.rambo.snapshot());
    return current.bots.find(bot => bot.id === alpha.id).resourceIds;
  }).not.toContain('skill:documents');
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.bots.find(bot => bot.id === beta.id).resourceIds).toContain('skill:research');
  expect(snapshot.globalDefaultResourceIds).not.toContain('skill:documents');

  await openSystemSettings(page, '资源管理');
  await globalPanel.getByRole('tab', { name: /^技能/ }).click();
  const documentsRow = globalPanel.locator('.resource-row[data-resource-id="skill:documents"]');
  await documentsRow.getByRole('button', { name: '移出可选' }).click();
  await expect.poll(async () =>
    (await page.evaluate(() => window.rambo.snapshot())).globalResourceIds
  ).not.toContain('skill:documents');
  await globalPanel.getByRole('button', { name: /发现目录/ }).click();
  await globalPanel.getByLabel('搜索资源').fill('documents');
  const discoveryRow = globalPanel.locator('.resource-row[data-resource-id="skill:documents"]');
  await expect(discoveryRow.getByRole('button', { name: '加入可选目录' })).toBeVisible();
  await discoveryRow.getByRole('button', { name: '加入可选目录' }).click();
  await expect.poll(async () =>
    (await page.evaluate(() => window.rambo.snapshot())).globalResourceIds
  ).toContain('skill:documents');
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.bots.find(bot => bot.id === alpha.id).resourceIds).not.toContain('skill:documents');
  expect(snapshot.bots.find(bot => bot.id === beta.id).resourceIds).not.toContain('skill:documents');
  expect(snapshot.bots.find(bot => bot.id === gamma.id).resourceIds).not.toContain('skill:documents');
});

test('真实 Electron 资源设置仅展示目录且新增 Skill/MCP 由 Bot 管理', async ({ electron }) => {
  const page = electron.page;
  await openSystemSettings(page, '资源管理');
  const panel = page.getByRole('tabpanel', { name: '资源管理' });
  const managementNote = panel.getByText(
    '导入技能或添加直连 MCP 由 Bot 管理，在私聊中明确说明需求即可。首次使用 Playwright 时，Chrome 扩展会请求一次标签页授权。',
    { exact: true }
  );
  await expect(managementNote).toBeVisible();
  await expect(panel.getByText('新增由 Bot 管理', { exact: true })).toHaveCount(0);

  await panel.getByRole('tab', { name: /^技能/ }).click();
  await expect(panel.getByRole('button', { name: '导入本地 Skill' })).toHaveCount(0);
  await panel.getByRole('tab', { name: /^MCP 服务/ }).click();
  await expect(managementNote).toBeVisible();
  await expect(panel.getByRole('button', { name: '添加直连 MCP' })).toHaveCount(0);
  await expect(panel.locator('.direct-mcp-form')).toHaveCount(0);
  await panel.getByRole('tab', { name: /^插件/ }).click();
  await expect(managementNote).toBeVisible();
  await expect(panel.getByRole('button', { name: /导入本地 Skill|添加直连 MCP/ })).toHaveCount(0);
  await panel.getByRole('tab', { name: /^技能/ }).click();
  await expect(panel.locator('.resource-row').first()).toBeVisible();

  const firstSwitch = panel.getByRole('checkbox').first();
  const initiallyChecked = await firstSwitch.isChecked();
  const readSwitchPresentation = element => {
    const style = getComputedStyle(element);
    const rowStyle = getComputedStyle(element.closest('.resource-row'));
    return {
      checked: element.checked,
      trackBackground: style.backgroundColor,
      trackBorder: style.borderColor,
      rowBackground: rowStyle.backgroundColor,
      rowBorder: rowStyle.borderColor,
      rowShadow: rowStyle.boxShadow
    };
  };
  const initialPresentation = await firstSwitch.evaluate(readSwitchPresentation);
  await firstSwitch.evaluate(element => {
    element.click();
  });
  await expect.poll(() => firstSwitch.isChecked()).toBe(!initiallyChecked);
  await page.waitForTimeout(250);
  const toggledPresentation = await firstSwitch.evaluate(readSwitchPresentation);
  expect(toggledPresentation.trackBackground)
    .not.toBe(initialPresentation.trackBackground);
  expect(toggledPresentation.trackBorder)
    .not.toBe(initialPresentation.trackBorder);
  expect(toggledPresentation.rowBackground)
    .toBe(initialPresentation.rowBackground);
  expect(toggledPresentation.rowBorder)
    .toBe(initialPresentation.rowBorder);
  expect(toggledPresentation.rowShadow)
    .toBe(initialPresentation.rowShadow);
  await firstSwitch.evaluate(element => {
    element.click();
  });
  await expect.poll(() => firstSwitch.isChecked()).toBe(initiallyChecked);

  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const presentation = await panel.evaluate(section => {
      const row = section.querySelector('.resource-row');
      const checkbox = row?.querySelector('input[type="checkbox"]');
      const checkboxStyle = checkbox ? getComputedStyle(checkbox) : null;
      const checkboxThumbStyle = checkbox ? getComputedStyle(checkbox, '::after') : null;
      const settingsPage = section.closest('.settings-page');
      const settingsScrollStyle = settingsPage ? getComputedStyle(settingsPage) : null;
      return {
        rowOverflows: row ? row.scrollWidth > row.clientWidth + 1 : false,
        sectionWidth: section.getBoundingClientRect().width,
        viewportWidth: document.documentElement.clientWidth,
        checkboxWidth: checkboxStyle?.width ?? '',
        checkboxHeight: checkboxStyle?.height ?? '',
        checkboxRadius: checkboxStyle?.borderRadius ?? '',
        checkboxThumbBackground: checkboxThumbStyle?.backgroundColor ?? '',
        checkboxThumbOpacity: checkboxThumbStyle?.opacity ?? '',
        scrollbarWidth: settingsScrollStyle?.scrollbarWidth ?? '',
        scrollbarColor: settingsScrollStyle?.scrollbarColor ?? ''
      };
    });
    expect(presentation.rowOverflows).toBe(false);
    expect(presentation.sectionWidth).toBeLessThanOrEqual(presentation.viewportWidth);
    expect(presentation.checkboxWidth).toBe('34px');
    expect(presentation.checkboxHeight).toBe('20px');
    expect(presentation.checkboxRadius).toBe('999px');
    expect(presentation.checkboxThumbBackground).not.toMatch(/rgba?\([^)]*,\s*0\)/u);
    expect(presentation.checkboxThumbOpacity).toBe('1');
    expect(presentation.scrollbarWidth).toBe('thin');
    expect(presentation.scrollbarColor).not.toBe('');
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 640, height: 700 });
  await expect.poll(async () => panel.evaluate(section => {
    const rows = [...section.querySelectorAll('.resource-row')];
    const subtabs = section.querySelector('.resource-subtabs');
    const subtabButtons = [...(subtabs?.querySelectorAll('.resource-subtab') ?? [])];
    return rows.every(row => row.scrollWidth <= row.clientWidth + 1) &&
      Boolean(subtabs) &&
      subtabs.scrollWidth <= subtabs.clientWidth + 1 &&
      subtabButtons.length === 3 &&
      subtabButtons.every(button => button.scrollWidth <= button.clientWidth + 1) &&
      section.scrollWidth <= section.clientWidth + 1;
  })).toBe(true);

  const snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.directMcpServers.some(server =>
    server.name === 'electron-fixture')).toBe(false);

  await page.evaluate(() => {
    window.__ramboMcpElicitationEvents = [];
    window.rambo.onEvent(event => {
      if (event.type === 'mcpElicitation' || event.type === 'mcpElicitationResolved') {
        window.__ramboMcpElicitationEvents.push(event);
      }
    });
  });
  await page.evaluate(() => window.rambo.injectAcceptanceEvent({
    type: 'mcpElicitation',
    requestId: 'e2e-cua-elicitation',
    serverName: 'cua_repl',
    threadId: 'e2e-cua-thread',
    turnId: 'e2e-cua-turn',
    message: 'Allow Computer Use to use "Google Chrome"?',
    detail: 'Computer Use 请求访问当前 Chrome 窗口。',
    toolName: 'js'
  }));
  const elicitation = page.getByRole('alertdialog', {
    name: 'Allow Computer Use to use "Google Chrome"?'
  });
  await expect(elicitation).toBeVisible();
  await expect(elicitation.getByText('cua_repl · js', { exact: true })).toBeVisible();
  await expect(elicitation.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(elicitation.getByRole('button', { name: '拒绝' })).toBeVisible();
  await expect(elicitation.getByRole('button', { name: '允许本次' })).toBeVisible();
  await elicitation.getByRole('button', { name: '拒绝' }).click();
  await expect(elicitation).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    window.__ramboMcpElicitationEvents.some(event =>
      event.type === 'mcpElicitationResolved' &&
      event.requestId === 'e2e-cua-elicitation'
    )
  )).toBe(true);
});

test('Gmail 使用应用专用密码并保持本机凭证连接流程', async ({ electron }) => {
  const page = electron.page;
  await openConnectors(page);
  const gmailCard = page.getByRole('article').filter({ hasText: 'Gmail' });
  await gmailCard.getByRole('button', { name: '连接', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Gmail' });
  await expect(dialog).toBeVisible();
  const dialogScrollStyle = await dialog.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      overflowY: style.overflowY,
      scrollbarWidth: style.scrollbarWidth,
      scrollbarGutter: style.scrollbarGutter
    };
  });
  expect(dialogScrollStyle).toEqual({
    overflowY: 'auto',
    scrollbarWidth: 'thin',
    scrollbarGutter: 'stable'
  });
  await expectUnframedConnectorLogo(dialog.locator('.connector-icon-has-logo'));
  await expect(dialog.getByText('Gmail 应用专用密码')).toBeVisible();
  await expect(dialog.getByText(/开启两步验证/u)).toBeVisible();
  await expect(dialog.getByText(/不是.*一次性验证码/u)).toBeVisible();
  await expect(dialog.getByText(/较不安全应用/u)).toBeVisible();
  await expect(dialog.getByLabel('连接名称')).toHaveValue('Gmail');
  await expect(dialog.getByLabel('Gmail 地址')).toBeVisible();
  await expect(dialog.getByLabel('应用专用密码')).toHaveAttribute('type', 'password');
  await expect(dialog.getByLabel('OAuth Client ID')).toHaveCount(0);
  await expect(dialog.getByLabel('OAuth Client Secret')).toHaveCount(0);
  const saveButton = dialog.getByRole('button', { name: '保存连接' });
  await expect(saveButton).toBeDisabled();
  await dialog.getByLabel('Gmail 地址').fill('fixture@gmail.com');
  await dialog.getByLabel('应用专用密码').fill('abcd efgh ijkl mnop');
  await expect(saveButton).toBeEnabled();
  const snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.connections.some(connection => connection.providerId === 'gmail')).toBe(false);

  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const afterCancel = await page.evaluate(() => window.rambo.snapshot());
  expect(afterCancel.connections.some(connection => connection.providerId === 'gmail')).toBe(false);
});

test('真实 Electron 侧栏 Bot 私聊和群聊右键可复制 ID、复制 Bot、归档和永久删除', async ({
  electron, acceptanceRun
}) => {
    const app = electron.app;
    const page = electron.page;
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Menu Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Menu Pilot')).toBeVisible();
    const snapshot = await page.evaluate(() => window.rambo.snapshot());
    const bot = snapshot.bots.find(item => item.name === 'Menu Pilot');
    const chat = snapshot.chats.find(item => item.botId === bot.id && !item.groupChatId);
    const row = page.locator('.bot-list-row').filter({
      has: page.getByText('Menu Pilot', { exact: true })
    });
    await page.evaluate(async botId => {
      await window.rambo.updateBot(botId, {
        role: '负责菜单流程验证',
        instructions: '复制时保留这段长期指令。'
      });
      await window.rambo.saveMemory({ botId, text: '复制后应保留这条私有记忆。' });
    }, bot.id);
    const sourceWorkspace = join(acceptanceRun.profile, 'bots', bot.id, 'workspace');
    mkdirSync(sourceWorkspace, { recursive: true });
    writeFileSync(join(sourceWorkspace, 'source-only.txt'), '只属于来源 Bot 的工作区文件');
    await settleInitialBotTurn(page, bot.id);

    await row.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Menu Pilot 会话菜单' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '置顶', exact: true })).toBeFocused();
    await menu.getByRole('menuitem', { name: '复制对话 ID' }).click();
    await expect(page.getByText('对话 ID 已复制')).toBeVisible();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(chat.id);

    await row.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: '复制 Bot' }).click();
    await expect(page.getByPlaceholder('发消息给 Menu Pilot 副本')).toBeVisible();
    await expect(page.getByText('已复制 Bot：Menu Pilot 副本')).toBeVisible();
    const copiedSnapshot = await page.evaluate(() => window.rambo.snapshot());
    const copiedBot = copiedSnapshot.bots.find(item => item.name === 'Menu Pilot 副本');
    const copiedChat = copiedSnapshot.chats.find(item =>
      item.botId === copiedBot.id && !item.groupChatId
    );
    expect(copiedBot.role).toBe('负责菜单流程验证');
    expect(copiedBot.instructions).toBe('复制时保留这段长期指令。');
    expect(copiedBot.avatar).toBe(bot.avatar);
    expect(copiedBot.model).toBe(bot.model);
    expect(copiedBot.permission).toBe(bot.permission);
    expect(copiedBot.resourceIds).toEqual(bot.resourceIds);
    expect(copiedChat.id).not.toBe(chat.id);
    expect(
      copiedChat.threadId === null || copiedChat.threadId !== chat.threadId,
      '副本不应复用来源 Bot 的 thread'
    ).toBe(true);
    expect(existsSync(join(
      acceptanceRun.profile, 'bots', copiedBot.id, 'workspace', 'source-only.txt'
    ))).toBe(false);
    expect(await page.evaluate(copiedBotId =>
      window.rambo.memories(copiedBotId), copiedBot.id
    )).toMatchObject([{ text: '复制后应保留这条私有记忆。' }]);

    await row.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: '归档 Bot' }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('region', { name: '已归档的 Bot' })).toContainText('Menu Pilot');

    await page.getByRole('region', { name: '已归档的 Bot' })
      .getByRole('button', { name: 'Menu Pilot', exact: true }).click();
    await page.getByRole('tab', { name: 'Bot 管理' }).click();
    await page.getByRole('button', { name: '恢复 Bot' }).click();
    await expect(row).toBeVisible();

    await row.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: /永久删除 Bot/ }).click();
    const dialog = page.getByRole('alertdialog', { name: '永久删除「Menu Pilot」？' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);

    const group = await page.evaluate(async () => {
      const first = await window.rambo.createBot({ name: 'Group Menu One', avatar: 'a' });
      const second = await window.rambo.createBot({ name: 'Group Menu Two', avatar: 'b' });
      return window.rambo.createGroup({
        title: 'Group Menu Room',
        purpose: 'Validate group menu actions.',
        botIds: [first.bot.id, second.bot.id]
      });
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const runtime = (await page.evaluate(() => window.rambo.snapshot())).groupRuntimes[group.id];
      if (runtime) await page.evaluate(groupId => window.rambo.interruptGroup(groupId), group.id);
      await page.waitForTimeout(500);
    }
    await expect.poll(async () => (await page.evaluate(() => window.rambo.snapshot()))
      .groupRuntimes[group.id] ?? null).toBeNull();
    const groupRow = page.locator('.bot-list-row').filter({ hasText: 'Group Menu Room' });
    await expect(groupRow).toBeVisible();
    await groupRow.click({ button: 'right' });
    const groupMenu = page.getByRole('menu', { name: 'Group Menu Room 会话菜单' });
    await expect(groupMenu).toBeVisible();
    await groupMenu.getByRole('menuitem', { name: '复制对话 ID' }).click();
    await expect(page.getByText('对话 ID 已复制')).toBeVisible();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(group.id);

    await groupRow.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: '归档群聊' }).click();
    await expect(groupRow).toHaveCount(0);
    const archivedGroups = page.getByRole('region', { name: '已归档的群聊' });
    await expect(archivedGroups).toContainText('Group Menu Room');
    await archivedGroups.getByRole('button', { name: '恢复群聊 Group Menu Room' }).click();
    await expect(groupRow).toBeVisible();

    await groupRow.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: '永久删除群聊…' }).click();
    const groupDialog = page.getByRole('alertdialog', { name: '永久删除群聊「Group Menu Room」？' });
    await expect(groupDialog).toBeVisible();
    await groupDialog.getByRole('button', { name: '永久删除群聊' }).click();
    await expect(groupDialog).toHaveCount(0);
    await expect(groupRow).toHaveCount(0);
    expect((await page.evaluate(() => window.rambo.snapshot())).groups.some(item => item.id === group.id)).toBe(false);
});

test('真实 Electron 会话置顶按创建时间混排并重启保持', async ({ electron }) => {
  const page = electron.page;
  for (const name of ['Pin First', 'Pin Second', 'Pin Third']) {
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill(name);
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder(`发消息给 ${name}`)).toBeVisible();
  }

  const group = await page.evaluate(async () => {
    const snapshot = await window.rambo.snapshot();
    const first = snapshot.bots.find(bot => bot.name === 'Pin First');
    const second = snapshot.bots.find(bot => bot.name === 'Pin Second');
    return window.rambo.createGroup({
      title: 'Pin Group',
      purpose: 'Validate pinned group ordering.',
      botIds: [first.id, second.id]
    });
  });
  await expect(page.getByLabel('会话列表').getByText('Pin Group')).toBeVisible();

  const conversationIds = () => page.evaluate(() => {
    return [...document.querySelectorAll('.bot-list-row')].map(row =>
      row.querySelector('.bot-row-name > span')?.textContent?.trim() ?? ''
    ).filter(Boolean);
  });
  const conversationRow = name => page.locator('.bot-list-row').filter({
    has: page.locator('.bot-row-name > span', { hasText: new RegExp(`^${name}$`, 'u') })
  });
  const createdOrder = await conversationIds();
  expect(createdOrder.slice(0, 4)).toEqual(['Pin Group', 'Pin Third', 'Pin Second', 'Pin First']);

  const firstRow = conversationRow('Pin First');
  await firstRow.click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: '置顶', exact: true }).click();
  await expect(page.getByText('已置顶 Pin First')).toBeVisible();
  await expect.poll(async () => (await conversationIds()).slice(0, 4))
    .toEqual(['Pin First', 'Pin Group', 'Pin Third', 'Pin Second']);
  await expect(conversationRow('Pin First')).toHaveAttribute('data-pinned', 'true');
  await expect(conversationRow('Pin First').locator('.bot-row-name svg')).toHaveCount(0);

  const secondRow = conversationRow('Pin Second');
  await secondRow.click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: '置顶', exact: true }).click();
  await expect(page.getByText('已置顶 Pin Second')).toBeVisible();
  await expect.poll(async () => (await conversationIds()).slice(0, 4))
    .toEqual(['Pin Second', 'Pin First', 'Pin Group', 'Pin Third']);

  const groupRow = conversationRow('Pin Group');
  await groupRow.click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: '置顶', exact: true }).click();
  await expect(page.getByText('已置顶群聊 Pin Group')).toBeVisible();
  await expect.poll(async () => (await conversationIds()).slice(0, 4))
    .toEqual(['Pin Group', 'Pin Second', 'Pin First', 'Pin Third']);
  await expect(page.getByLabel('拖到这里置顶')).toHaveCount(0);
  await expect(conversationRow('Pin First')).not.toHaveAttribute('draggable');

  const pinnedSnapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(pinnedSnapshot.groups.find(item => item.id === group.id)?.pinnedAt).toBeTruthy();
  expect(pinnedSnapshot.bots.find(item => item.name === 'Pin First')?.pinnedAt).toBeTruthy();
  expect(pinnedSnapshot.bots.find(item => item.name === 'Pin Second')?.pinnedAt).toBeTruthy();

  const reopenedPage = await electron.restart();
  await expect(reopenedPage.getByLabel('创建 Bot')).toBeVisible();
  await expect.poll(() => reopenedPage.evaluate(() =>
    [...document.querySelectorAll('.bot-list-row')].slice(0, 4).map(row =>
      row.querySelector('.bot-row-name > span')?.textContent?.trim() ?? ''
    )
  )).toEqual(['Pin Group', 'Pin Second', 'Pin First', 'Pin Third']);

  const reopenedGroupRow = reopenedPage.locator('.bot-list-row').filter({
    has: reopenedPage.locator('.bot-row-name > span', { hasText: /^Pin Group$/u })
  });
  await reopenedGroupRow.click({ button: 'right' });
  await reopenedPage.getByRole('menu').getByRole('menuitem', { name: '取消置顶', exact: true }).click();
  await expect(reopenedPage.getByText('已取消置顶群聊 Pin Group')).toBeVisible();
  await expect.poll(() => reopenedPage.evaluate(() =>
    [...document.querySelectorAll('.bot-list-row')].slice(0, 4).map(row =>
      row.querySelector('.bot-row-name > span')?.textContent?.trim() ?? ''
    )
  )).toEqual(['Pin Second', 'Pin First', 'Pin Group', 'Pin Third']);
});

test('真实 Electron 气泡悬停显示时间并按关键间隔插入分隔', async ({ electron }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Time Pilot');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 Time Pilot')).toBeVisible();
  const chat = await page.evaluate(() => {
    const snapshot = window.rambo.snapshot();
    return snapshot.then(value => {
      const bot = value.bots.find(item => item.name === 'Time Pilot');
      return value.chats.find(item => item.botId === bot.id && !item.groupChatId && !item.archived);
    });
  });

  const first = {
    id: 'time-first',
    chatId: chat.id,
    role: 'user',
    text: '第一条时间消息',
    status: 'complete',
    itemId: null,
    createdAt: '2026-10-23T00:06:00.000Z',
    turnId: null,
    phase: null,
    source: 'text'
  };
  const second = {
    ...first,
    id: 'time-second',
    text: '十五分钟后的消息',
    createdAt: '2026-10-23T00:21:00.000Z'
  };
  await page.evaluate(message => window.rambo.injectAcceptanceEvent({
    type: 'message',
    message
  }), first);
  await expect(page.locator('.message-row[data-message-id="time-first"]')).toBeVisible();
  await expect(page.locator('.message-time-divider')).toHaveCount(1);
  const divider = page.locator('.message-time-divider').first();
  await expect(divider).toBeVisible();
  const dividerText = await divider.textContent();
  expect(dividerText).toMatch(/^10月23日周[一二三四五六日] 08:06$/u);

  const bubble = page.locator('.message-row[data-message-id="time-first"] .message-content');
  const hoverTime = bubble.locator('.message-hover-time');
  await expect(hoverTime).toHaveText(/^10月23日 周[一二三四五六日] 08:06$/u);
  await expect(hoverTime).toHaveCSS('opacity', '0');
  await bubble.hover();
  await expect.poll(() => hoverTime.evaluate(element =>
    Number.parseFloat(getComputedStyle(element).opacity)
  )).toBeGreaterThan(0.8);
  await expect(hoverTime).toHaveCSS('pointer-events', 'none');
  const layout = await bubble.evaluate(element => ({
    position: getComputedStyle(element.querySelector('.message-hover-time')).position,
    messageTop: element.getBoundingClientRect().top,
    hoverTop: element.querySelector('.message-hover-time').getBoundingClientRect().top
  }));
  expect(layout.position).toBe('absolute');
  expect(layout.hoverTop).toBeGreaterThan(layout.messageTop);

  await page.evaluate(message => window.rambo.injectAcceptanceEvent({
    type: 'message',
    message
  }), second);
  await expect(page.locator('.message-row[data-message-id="time-second"]')).toBeVisible();
  await expect(page.locator('.message-time-divider')).toHaveCount(2);
});

test('真实 Electron 用宽幅实时频谱展示 Live 通话状态并结束后清除结束中状态', async ({ electron }) => {
    const page = electron.page;
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Voice Loading Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Voice Loading Pilot')).toBeVisible();
    const chat = await page.evaluate(async botName => {
      const snapshot = await window.rambo.snapshot();
      const bot = snapshot.bots.find(item => item.name === botName);
      return {
        chat: snapshot.chats.find(item => item.botId === bot.id && !item.groupChatId && !item.archived),
        avatar: bot.avatar
      };
    }, 'Voice Loading Pilot');
    const avatarColor = /^agent-robot:v2:\d+:([a-z]+):/u.exec(chat.avatar)?.[1];
    expect(avatarColor).toBeTruthy();

    const samplePill = () => {
      const pill = document.querySelector('.current-bot-pill-button');
      if (!pill) return null;
      const pillRect = pill.getBoundingClientRect();
      const avatarRect = pill.querySelector('.current-bot-avatar')?.getBoundingClientRect();
      return {
        state: pill.getAttribute('data-voice-state') ?? 'idle',
        width: pillRect.width,
        height: pillRect.height,
        left: pillRect.left,
        center: pillRect.left + pillRect.width / 2,
        avatarLeft: avatarRect?.left ?? 0,
        avatarCenter: avatarRect ? avatarRect.left + avatarRect.width / 2 : 0
      };
    };
    const injectAndSampleVoiceState = (state, error = null, duration = 480) =>
      page.evaluate(async ({ chatId, state, error, duration }) => {
        await window.rambo.injectAcceptanceEvent({
          type: 'voiceState',
          session: { chatId, state, error }
        });
        const samples = [];
        const startedAt = performance.now();
        while (performance.now() - startedAt <= duration) {
          const pill = document.querySelector('.current-bot-pill-button');
          if (pill) {
            const pillRect = pill.getBoundingClientRect();
            const avatarRect = pill.querySelector('.current-bot-avatar')?.getBoundingClientRect();
            samples.push({
              state: pill.getAttribute('data-voice-state') ?? 'idle',
              width: pillRect.width,
              height: pillRect.height,
              left: pillRect.left,
              center: pillRect.left + pillRect.width / 2,
              avatarLeft: avatarRect?.left ?? 0,
              avatarCenter: avatarRect ? avatarRect.left + avatarRect.width / 2 : 0
            });
          }
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        return samples;
      }, { chatId: chat.chat.id, state, error, duration });
    const injectVoiceState = (state, error = null) => page.evaluate(({ chatId, state, error }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'voiceState',
        session: { chatId, state, error }
      }), { chatId: chat.chat.id, state, error });
    const voicePill = page.locator('.current-bot-pill-voice');
    const idlePill = await page.locator('.current-bot-pill-button').evaluate(samplePill);
    expect(idlePill.state).toBe('idle');
    const idleNameGeometry = await page.locator('.current-bot-pill-button').evaluate(pill => {
      const name = pill.querySelector('.current-bot-name');
      if (!name) return null;
      const pillRect = pill.getBoundingClientRect();
      const nameRect = name.getBoundingClientRect();
      return {
        text: name.textContent,
        nameWidth: nameRect.width,
        nameScrollWidth: name.scrollWidth,
        pillRight: pillRect.right,
        nameRight: nameRect.right,
        clipped: name.scrollWidth > name.clientWidth + 1
      };
    });
    expect(idleNameGeometry.text).toBe('Voice Loading Pilot');
    expect(idleNameGeometry.nameWidth).toBeCloseTo(idleNameGeometry.nameScrollWidth, 0);
    expect(idleNameGeometry.nameRight).toBeLessThanOrEqual(idleNameGeometry.pillRight);
    expect(idleNameGeometry.clipped).toBe(false);
    const connectingSamples = await injectAndSampleVoiceState('connecting');
    const connectingPill = connectingSamples.at(-1);
    expect(connectingPill.state).toBe('connecting');
    expect(connectingPill.width).toBeCloseTo(44, 0);
    expect(connectingPill.height).toBeCloseTo(44, 0);
    expect(connectingSamples.some(sample =>
      sample.width >= 30 && sample.width <= idlePill.width - 1
    )).toBe(true);
    await expect(voicePill).toHaveAttribute('aria-label', '正在拨号');
    await expect(voicePill).toHaveAttribute('data-voice-state', 'connecting');
    await expect(voicePill.locator('.chat-voice-connect-loader')).toHaveCount(1);
    await expect(voicePill.locator('.chat-voice-connect-orbit')).toHaveCSS(
      'animation-name', 'chat-voice-connect-spin'
    );
    await expect(voicePill.locator('.chat-voice-connect-core')).toHaveCSS(
      'animation-name', 'chat-voice-connect-spin'
    );
    await expect(voicePill.locator('.current-bot-name')).toHaveCSS('opacity', '0');
    await expect(page.locator('.voice-panel')).toHaveCount(0);
    const callWave = page.locator('.voice-waveform-call');
    await expect(callWave).toHaveCount(0);
    await expect(page.locator('.agent-running-row[aria-label="正在拨号"]')).toHaveCount(0);
    await expect(page.locator('.chat-running-dock')).toHaveCount(1);
    await expect(page.locator('.chat-running-dock > .agent-running-row-hidden')).toHaveCount(1);

    const liveSamples = await injectAndSampleVoiceState('live');
    const livePill = liveSamples.at(-1);
    expect(livePill.state).toBe('live');
    expect(livePill.width).toBeCloseTo(184, 0);
    expect(liveSamples.some(sample =>
      sample.width > 49 && sample.width < 179
    )).toBe(true);
    expect(livePill.avatarLeft).toBeLessThan(connectingPill.avatarLeft - 45);
    await expect(voicePill).toHaveAttribute('aria-label', '正在聆听');
    await expect(voicePill).toHaveAttribute('data-voice-color', avatarColor);
    await expect(voicePill).toHaveAttribute('data-voice-state', 'live');
    await expect(callWave).toHaveAttribute('data-state', 'live');
    await expect(callWave.locator('.voice-waveform-bar')).toHaveCount(13);
    await expect(callWave).toHaveCSS('width', '128px');
    await expect(callWave).toHaveCSS('height', '40px');
    await expect(voicePill.locator('.current-bot-name')).toHaveCSS('opacity', '0');
    await expect(callWave.locator('.voice-waveform-bar').first())
      .toHaveCSS('animation-name', 'none');
    await expect(callWave.locator('.voice-waveform-bar').first())
      .toHaveCSS('transition-duration', '0s');
    await expect(callWave.locator('.voice-waveform-bar').first())
      .toHaveCSS('background-image', 'none');
    await expect(callWave.locator('.voice-waveform-bar').first())
      .toHaveCSS('box-shadow', 'none');
    await expect(callWave.locator('.voice-waveform-bar').first())
      .toHaveCSS('filter', 'none');
    const voiceEndButton = page.getByRole('button', { name: '结束当前语音通话', exact: true });
    await expect(voiceEndButton).toBeVisible();
    await expect(voiceEndButton).toHaveCSS('color', 'rgb(136, 62, 55)');
    await expect(voiceEndButton).toHaveCSS('border-radius', '50%');
    const endButtonBox = await voiceEndButton.boundingBox();
    const pillBox = await voicePill.boundingBox();
    const liveAvatarBox = await voicePill.locator('.current-bot-avatar').boundingBox();
    expect(endButtonBox?.width).toBeCloseTo(liveAvatarBox?.width ?? 0, 0);
    expect(endButtonBox?.height).toBeCloseTo(liveAvatarBox?.height ?? 0, 0);
    expect(endButtonBox?.x).toBeGreaterThan((pillBox?.x ?? 0) + (pillBox?.width ?? 0));
    expect((endButtonBox?.x ?? 0) - ((pillBox?.x ?? 0) + (pillBox?.width ?? 0)))
      .toBeCloseTo(8, 0);
    const liveWaveColorValue = await callWave.evaluate(element => getComputedStyle(element).color);
    const liveWaveColor = await computedColorAsRgb(callWave);
    const avatarColorRgb = await voicePill.evaluate((pill, color) => {
      const probe = document.createElement('span');
      probe.style.color = `var(--avatar-ink-${color}, #000)`;
      pill.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('无法创建颜色采样画布');
      context.fillStyle = '#010203';
      context.fillStyle = resolved;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    }, avatarColor);
    expect(liveWaveColor).toEqual(avatarColorRgb);
    expect(liveWaveColorValue).not.toBe('rgb(0, 0, 0)');
    const waveformSpread = await callWave.locator('.voice-waveform-bar').evaluateAll(elements => {
      const first = elements[0].getBoundingClientRect();
      const last = elements.at(-1).getBoundingClientRect();
      return last.left - first.left;
    });
    expect(waveformSpread).toBeGreaterThan(90);
    const idleBarHeights = await callWave.locator('.voice-waveform-bar').evaluateAll(elements =>
      elements.map(element => element.getBoundingClientRect().height));
    expect(new Set(idleBarHeights.map(height => height.toFixed(2))).size).toBe(1);
    expect(idleBarHeights[0]).toBeLessThan(3);
    const barWidths = await callWave.locator('.voice-waveform-bar').evaluateAll(elements =>
      elements.map(element => element.getBoundingClientRect().width));
    expect(new Set(barWidths.map(width => width.toFixed(2))).size).toBe(1);
    await callWave.locator('.voice-waveform-bar').evaluateAll(elements => {
      elements.forEach((element, index) => {
        element.style.transform = `scaleY(${(0.2 + index * 0.05).toFixed(2)})`;
      });
    });
    await injectVoiceState('stopping');
    await expect(voicePill).toHaveAttribute('aria-label', '正在结束语音');
    await expect(voicePill).toHaveAttribute('data-voice-state', 'stopping');
    await expect(callWave).toHaveAttribute('data-state', 'stopping');
    await expect(callWave.locator('.voice-waveform-bar').first())
      .toHaveCSS('animation-name', 'none');
    const stoppingBarHeights = await callWave.locator('.voice-waveform-bar').evaluateAll(elements =>
      elements.map(element => element.getBoundingClientRect().height));
    expect(new Set(stoppingBarHeights.map(height => height.toFixed(2))).size).toBe(1);
    expect(stoppingBarHeights[0]).toBeLessThan(3);
    const stoppingWaveColor = await computedColorAsRgb(callWave);
    expect(Math.max(...stoppingWaveColor) - Math.min(...stoppingWaveColor)).toBeLessThan(18);

    const stoppedSamples = await page.evaluate(async ({ chatId, duration }) => {
      await window.rambo.injectAcceptanceEvent({
        type: 'voiceStopFinished', chatId, error: null
      });
      const samples = [];
      const startedAt = performance.now();
      while (performance.now() - startedAt <= duration) {
        const pill = document.querySelector('.current-bot-pill-button');
        if (pill) {
          const rect = pill.getBoundingClientRect();
          samples.push({
            state: pill.getAttribute('data-voice-state') ?? 'idle',
            width: rect.width,
            height: rect.height
          });
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      return samples;
    }, { chatId: chat.chat.id, duration: 480 });
    expect(stoppedSamples.at(-1).state).toBe('idle');
    expect(stoppedSamples.at(-1).height).toBeCloseTo(idlePill.height, 0);
    expect(stoppedSamples.at(-1).width).toBeCloseTo(idlePill.width, 0);
    const stoppedWidthDistinct = new Set(stoppedSamples.map(sample =>
      sample.width.toFixed(1)
    )).size;
    expect(stoppedWidthDistinct, JSON.stringify({ idlePill, stoppedSamples }))
      .toBeGreaterThan(1);
    await expect(page.locator('.current-bot-pill-voice')).toHaveCount(0);
    await expect(page.getByLabel('打开 Voice Loading Pilot 设置')).toBeVisible();
    await expect(callWave).toHaveCount(0);

    await injectVoiceState('stopping');
    await page.evaluate(chatId => window.rambo.injectAcceptanceEvent({
      type: 'voiceStopFinished', chatId, error: '语音服务停止失败：服务暂不可用'
    }), chat.chat.id);
    await expect(page.locator('.current-bot-pill-voice')).toHaveAttribute(
      'aria-label', '语音结束失败：服务暂不可用'
    );
    await expect(page.locator('.current-bot-voice-error-title')).toHaveText('语音结束失败');
    await expect(page.locator('.current-bot-voice-error-detail')).toHaveText('服务暂不可用');
    const voiceErrorShell = page.locator('.current-bot-pill-shell');
    await expectVoiceErrorToFit(voiceErrorShell);
    const retryButton = page.getByRole('button', { name: '重新拨号', exact: true });
    await expect(retryButton).toBeVisible();
    await expect(retryButton).toBeEnabled();
    await retryButton.focus();
    await expect(retryButton).toBeFocused();
    await expect(page.getByLabel('正在结束语音')).toHaveCount(0);

    await injectVoiceState('connecting');
    await injectVoiceState('error', '语音连接已关闭：transport_closed');
    await expect(page.locator('.current-bot-pill-voice')).toHaveAttribute(
      'aria-label', '语音连接异常：语音连接已关闭：transport_closed'
    );
    await expect(page.locator('.current-bot-voice-error-title')).toHaveText('语音连接异常');
    await expect(page.locator('.current-bot-voice-error-detail'))
      .toHaveText('语音连接已关闭：transport_closed');
    await expectVoiceErrorToFit(voiceErrorShell);

    await page.setViewportSize({ width: 760, height: 560 });
    await injectVoiceState('error', '语音连接已关闭：transport_closed');
    await expectVoiceErrorToFit(voiceErrorShell);

    await injectVoiceState(
      'error',
      '语音媒体协商失败：远端音频参数无法应用，请检查当前输出设备与网络后重新拨号。'
    );
    await expect(page.locator('.current-bot-voice-error-detail'))
      .toContainText('请检查当前输出设备与网络后重新拨号');
    await expectVoiceErrorToFit(voiceErrorShell);
});

test('真实 Electron 对 Live 转写显示文字末尾光标、平滑追加文字并同步侧栏预览', async ({ electron }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Voice Transcript Pilot');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 Voice Transcript Pilot')).toBeVisible();
  const chat = await page.evaluate(async botName => {
    const snapshot = await window.rambo.snapshot();
    const bot = snapshot.bots.find(item => item.name === botName);
    return snapshot.chats.find(item => item.botId === bot.id && !item.groupChatId && !item.archived);
  }, 'Voice Transcript Pilot');
  const messageId = 'e2e-live-transcript-stream';
  const sendMessage = (text, status) => page.evaluate(({ chatId, messageId, text, status }) =>
    window.rambo.injectAcceptanceEvent({
      type: 'message',
      message: {
        id: messageId,
        chatId,
        role: 'assistant',
        text,
        status,
        itemId: 'e2e-live-transcript-item',
        createdAt: '2026-10-24T00:00:00.000Z',
        turnId: null,
        phase: null,
        source: 'voice'
      }
    }), { chatId: chat.id, messageId, text, status });

  await sendMessage('', 'streaming');
  const row = page.locator(`.message-row[data-message-id="${messageId}"]`);
  await expect(row).toBeVisible();
  const progress = row.locator('.message-content .voice-transcript-progress');
  await expect(progress).toBeVisible();
  await expect(progress.locator('.voice-transcript-caret')).toHaveCount(1);
  await expect(progress.locator('.voice-waveform')).toHaveCount(0);
  await expect(progress.locator('.voice-transcript-caret'))
    .toHaveCSS('animation-name', 'voice-transcript-caret');
  await expect(progress.locator('.voice-transcript-caret')).toHaveCSS('width', '1.5px');
  await expect(progress.locator('.voice-transcript-caret')).toHaveCSS('height', '14px');
  await expect(progress.locator('.voice-transcript-caret')).toHaveCSS('box-shadow', 'none');
  const caretAlignment = await row.locator('.message-content').evaluate(content => {
    const caret = content.querySelector('.voice-transcript-caret')?.getBoundingClientRect();
    const text = content.querySelector('.message-text');
    if (!caret || !text) return null;
    const fontSize = Number.parseFloat(getComputedStyle(text).fontSize);
    const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
    const textRect = text.getBoundingClientRect();
    return {
      caretHeight: caret.height,
      caretTop: caret.top,
      caretCenter: caret.top + caret.height / 2,
      fontSize,
      lineHeight,
      caretBottom: caret.bottom,
      textTop: textRect.top,
      textCenter: textRect.top + textRect.height / 2,
      textBottom: textRect.bottom
    };
  });
  expect(caretAlignment.caretHeight).toBeCloseTo(caretAlignment.fontSize, 0);
  expect(caretAlignment.caretTop).toBeGreaterThanOrEqual(caretAlignment.textTop);
  expect(caretAlignment.caretBottom).toBeLessThanOrEqual(caretAlignment.textBottom);
  expect(Math.abs(caretAlignment.caretCenter - caretAlignment.textCenter)).toBeLessThanOrEqual(1);
  await expect(row.locator('.voice-transcript-loading, .voice-transcript-pending-dots')).toHaveCount(0);
  await expect(row.locator('.message-content'))
    .toHaveAttribute('data-voice-streaming', 'true');
  await page.waitForTimeout(260);
  const emptyBubbleWidth = (await row.locator('.message-content').boundingBox())?.width ?? 0;
  expect(emptyBubbleWidth).toBeLessThan(80);

  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'e2e-narrow-voice-bubble';
    style.textContent = '.message-row[data-message-id="e2e-live-transcript-stream"] { max-width: 330px; }';
    document.head.append(style);
  });
  const multilineText = '这是一段用于检查换行时不会从气泡底部露出半截文字的实时语音转写内容，'.repeat(5);
  await page.evaluate(({ messageId }) => {
    window.__ramboVoiceCropSamples = [];
    const startedAt = performance.now();
    const sample = () => {
      const content = document.querySelector(
        `.message-row[data-message-id="${messageId}"] .message-content`
      );
      const text = content?.querySelector('.message-text');
      if (content && text) {
        window.__ramboVoiceCropSamples.push({
          contentHeight: content.getBoundingClientRect().height,
          textHeight: text.getBoundingClientRect().height,
          overflow: getComputedStyle(content).overflow
        });
      }
      if (performance.now() - startedAt < 420) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { messageId });
  await sendMessage(multilineText, 'streaming');
  await expect(row).toContainText(multilineText);
  await page.waitForTimeout(440);
  const cropSamples = await page.evaluate(() => window.__ramboVoiceCropSamples);
  expect(cropSamples.length).toBeGreaterThan(1);
  expect(cropSamples.every(sample => sample.contentHeight + 1 >= sample.textHeight)).toBe(true);
  await page.evaluate(() => document.querySelector('#e2e-narrow-voice-bubble')?.remove());

  await sendMessage('开始实时转写', 'streaming');
  await expect(row).toContainText('开始实时转写');
  const incrementalEvents = await page.evaluate(async ({ chatId, messageId }) => {
    const all = [];
    const fragments = [];
    let firstWidth = 0;
    let secondWidth = 0;
    const onAnimationStart = event => {
      const target = event.target;
      if (!(target instanceof HTMLElement) ||
          !target.classList.contains('voice-transcript-fragment') ||
          !target.closest(`.message-row[data-message-id="${messageId}"]`)) {
        return;
      }
      fragments.push({
        text: target.textContent ?? '',
        animationName: event.animationName,
        animationDuration: getComputedStyle(target).animationDuration
      });
    };
    document.addEventListener('animationstart', onAnimationStart);
    const stop = window.rambo.onEvent(event => {
      if (event.type === 'message' && event.message.id === messageId) {
        all.push({ text: event.message.text, status: event.message.status });
      }
    });
    const first = '实时语音片段一';
    const second = `${first}，片段二`;
    await window.rambo.injectAcceptanceEvent({
      type: 'message',
      message: {
        id: messageId, chatId, role: 'assistant', text: first,
        status: 'streaming', itemId: 'e2e-live-transcript-item',
        createdAt: '2026-10-24T00:00:02.000Z', turnId: null, phase: null, source: 'voice'
      }
    });
    await new Promise(resolve => setTimeout(resolve, 280));
    firstWidth = document.querySelector(
      `.message-row[data-message-id="${messageId}"] .message-content`
    )?.getBoundingClientRect().width ?? 0;
    await window.rambo.injectAcceptanceEvent({
      type: 'message',
      message: {
        id: messageId, chatId, role: 'assistant', text: second,
        status: 'streaming', itemId: 'e2e-live-transcript-item',
        createdAt: '2026-10-24T00:00:03.000Z', turnId: null, phase: null, source: 'voice'
      }
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    secondWidth = document.querySelector(
      `.message-row[data-message-id="${messageId}"] .message-content`
    )?.getBoundingClientRect().width ?? 0;
    document.removeEventListener('animationstart', onAnimationStart);
    stop();
    return { all, fragments, firstWidth, secondWidth };
  }, { chatId: chat.id, messageId });
  expect(incrementalEvents.all).toEqual([
    { text: '实时语音片段一', status: 'streaming' },
    { text: '实时语音片段一，片段二', status: 'streaming' }
  ]);
  expect(incrementalEvents.fragments).toEqual(expect.arrayContaining([
    {
      text: '实时语音片段一',
      animationName: 'voice-transcript-reveal',
      animationDuration: '0.22s'
    },
    {
      text: '，片段二',
      animationName: 'voice-transcript-reveal',
      animationDuration: '0.22s'
    }
  ]));
  expect(incrementalEvents.firstWidth).toBeGreaterThan(emptyBubbleWidth);
  expect(incrementalEvents.secondWidth).toBeGreaterThan(incrementalEvents.firstWidth);
  await expect(row.locator('.voice-transcript-text')).toContainText('实时语音片段一，片段二');
  await expect(progress).toBeVisible();
  const progressIsInline = await row.locator('.message-content').evaluate(content => {
    const contentBox = content.getBoundingClientRect();
    const textBox = content.querySelector('.voice-transcript-text')?.getBoundingClientRect();
    const progressBox = content.querySelector('.voice-transcript-progress')?.getBoundingClientRect();
    return {
      insideBubble: Boolean(progressBox) && progressBox.left >= contentBox.left && progressBox.right <= contentBox.right,
      afterText: Boolean(textBox && progressBox) && progressBox.left >= textBox.left
    };
  });
  expect(progressIsInline).toEqual({ insideBubble: true, afterText: true });
  await expect(page.getByRole('button', { name: /Voice Transcript Pilot/ }).locator('.bot-row-summary'))
    .toHaveText('实时语音片段一，片段二');

  await sendMessage('实时语音片段一，片段二，准备', 'streaming');
  await expect(row).toContainText('实时语音片段一，片段二，准备');
  await sendMessage('实时语音片段一，片段二，准备，好了。', 'streaming');
  await expect(row).toContainText('实时语音片段一，片段二，准备，好了。');
  const appendedBubbleWidth = (await row.locator('.message-content').boundingBox())?.width ?? 0;
  expect(appendedBubbleWidth).toBeGreaterThan(incrementalEvents.secondWidth);
  await sendMessage('实时语音片段一，片段二，准备，好了。', 'complete');
  await expect(progress).toHaveCount(0);
  await expect(row).toContainText('实时语音片段一，片段二，准备，好了。');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sendMessage('实时语音片段一，片段二，准备，好了。继续。', 'streaming');
  await expect(progress).toBeVisible();
  await expect(row.locator('.voice-transcript-fragment').last())
    .toHaveCSS('animation-name', 'none');
  await expect(progress.locator('.voice-transcript-caret')).toHaveCSS('animation-name', 'none');
  const reducedTransitionDuration = await row.locator('.message-content')
    .evaluate(element => getComputedStyle(element).transitionDuration);
  expect(reducedTransitionDuration.split(',').every(value => value.trim() === '0s')).toBe(true);
  await sendMessage('实时语音片段一，片段二，准备，好了。继续。', 'complete');
  await expect(progress).toHaveCount(0);

  const secondMessageId = 'e2e-live-transcript-follow-up';
  const sendFollowUp = (text, status) => page.evaluate(({ chatId, secondMessageId, text, status }) =>
    window.rambo.injectAcceptanceEvent({
      type: 'message',
      message: {
        id: secondMessageId,
        chatId,
        role: 'assistant',
        text,
        status,
        itemId: 'e2e-live-transcript-item-follow-up',
        createdAt: '2026-10-24T00:00:01.000Z',
        turnId: null,
        phase: null,
        source: 'voice'
      }
    }), { chatId: chat.id, secondMessageId, text, status });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await sendFollowUp('第二条', 'streaming');
  const secondRow = page.locator(`.message-row[data-message-id="${secondMessageId}"]`);
  const secondProgress = secondRow.locator('.message-content .voice-transcript-progress');
  await expect(secondProgress).toBeVisible();
  await expect(secondProgress.locator('.voice-transcript-caret')).toHaveCount(1);
  await expect(secondRow.locator('.voice-transcript-fragment').last()).toHaveCSS(
    'animation-name',
    'voice-transcript-reveal'
  );
  await expect(secondRow.locator('.voice-transcript-loading, .voice-transcript-pending-dots')).toHaveCount(0);
  await sendFollowUp('第二条', 'complete');
  await expect(secondProgress).toHaveCount(0);
});

test('真实 Electron 阶段回复覆盖同一气泡并在新用户消息后迁移到下方', async ({ electron, acceptanceRun }) => {
    const page = electron.page;
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Activity Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Activity Pilot')).toBeVisible();
    const chat = await page.evaluate(async botName => {
      const snapshot = await window.rambo.snapshot();
      const bot = snapshot.bots.find(item => item.name === botName);
      return snapshot.chats.find(item => item.botId === bot.id && !item.groupChatId && !item.archived);
    }, 'Activity Pilot');
    await page.evaluate(chatId => window.rambo.injectAcceptanceEvent({
      type: 'startingTurn', chatId, starting: true
    }), chat.id);
    await expect(page.getByLabel('正在读消息')).toBeVisible();
    await page.evaluate(chatId => window.rambo.injectAcceptanceEvent({
      type: 'startingTurn', chatId, starting: false
    }), chat.id);
    await expect(page.getByLabel('正在读消息')).toHaveCount(0);
    await page.evaluate(chatId => window.rambo.send(chatId, '检查项目结构。'), chat.id);
    await expect(page.getByLabel('正在思考')).toBeVisible();
    await expect.poll(async () => {
      const box = await page.getByLabel('正在思考').boundingBox();
      const transcript = await page.locator('.transcript-scroll').boundingBox();
      if (!box || !transcript) return false;
      return box.y >= transcript.y &&
        box.y + box.height <= transcript.y + transcript.height;
    }, { message: '发送后“正在思考”没有进入可视区底部' }).toBe(true);
    await page.mouse.move(2, 2);
    await expect(page.locator('.agent-running-ring')).toHaveCount(0);
    await expect(page.locator('.agent-running-dot')).toHaveCount(0);
    await expect(page.locator('.agent-running-avatar')).toHaveCount(1);
    await expect(page.locator('.agent-running-avatar .bot-avatar')).toHaveCount(1);
    const loadingAvatar = page.locator('.agent-running-avatar agent-robot-avatar');
    const loadingAvatarState = await loadingAvatar.evaluate(avatar => ({
      pointerFollow: avatar._pointerFollowEnabled,
      waiting: Boolean(avatar._waitingFx),
      motion: avatar.getAttribute('motion')
    }));
    expect(loadingAvatarState).toMatchObject({
      pointerFollow: false,
      waiting: true,
      motion: 'auto'
    });
    const loadingEyeOrbit = await loadingAvatar.evaluate(avatar => {
      const eyeTransform = () => avatar.shadowRoot?.getElementById('leftEye')?.getAttribute('transform') ?? '';
      return new Promise(resolve => {
        const first = eyeTransform();
        const startedAt = performance.now();
        const poll = () => {
          const next = eyeTransform();
          if (next !== first) resolve({ changed: true, first, next });
          else if (performance.now() - startedAt > 1500) resolve({ changed: false, first, next });
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
    });
    expect(loadingEyeOrbit.changed, JSON.stringify(loadingEyeOrbit)).toBe(true);
    await page.mouse.move(1700, 850);
    await expect(page.locator('.agent-running-shimmer')).toHaveText('正在思考');
    await expect(page.locator('.agent-running-row')).toHaveCSS('display', 'flex');
    const runningDockBox = await page.locator('.chat-running-dock').boundingBox();
    expect(runningDockBox).not.toBeNull();
    const runningAvatar = page.locator(
      '.bot-list-row[data-running="true"] .bot-avatar-wrap .robot-avatar'
    ).first();
    await expect(runningAvatar).toHaveCount(1);
    const runningBotRow = page.locator('.bot-list-row').filter({ hasText: 'Activity Pilot' });
    await expect(runningBotRow
      .locator('.bot-avatar-wrap')).toHaveCount(1);
    await runningBotRow.hover();
    const runningBotBox = await runningBotRow.boundingBox();
    if (!runningBotBox) throw new Error('找不到运行中的 Bot 行');
    await page.mouse.move(
      runningBotBox.x + 4,
      runningBotBox.y + 20
    );
    const animatedAvatarFrameA = await runningAvatar.screenshot();
    await page.waitForTimeout(650);
    const animatedAvatarFrameB = await runningAvatar.screenshot();
    expect(animatedAvatarFrameA.equals(animatedAvatarFrameB)).toBe(false);
    await expect(page.locator('.agent-running-meta')).toHaveCount(0);
    await expect(page.getByText('运行详情', { exact: false })).toHaveCount(0);
    const activeTurnId = await page.evaluate(chatId =>
      window.rambo.snapshot().then(snapshot => snapshot.activeTurns[chatId]), chat.id);
    expect(typeof activeTurnId).toBe('string');
    const threadId = await page.evaluate(chatId =>
      window.rambo.snapshot().then(snapshot => snapshot.chats.find(item => item.id === chatId)?.threadId),
      chat.id);
    expect(threadId).toBeTruthy();
    await page.getByRole('button', { name: '停止任务' }).click();
    await expect.poll(() => page.evaluate(chatId =>
      window.rambo.snapshot().then(snapshot => snapshot.activeTurns[chatId] ?? null),
      chat.id
    )).toBeNull();
    await expect.poll(async () => {
      const box = await page.locator('.chat-running-dock').boundingBox();
      return box && runningDockBox
        ? Math.abs(box.y - runningDockBox.y) <= 1 && Math.abs(box.height - runningDockBox.height) <= 1
        : false;
    }, { message: 'Loading 退出时底部状态锚点发生跳动' }).toBe(true);
    await expect(page.locator('.agent-running-row')).toHaveClass(/agent-running-row-hidden/);
    await page.evaluate(({ chatId, turnId }) => window.rambo.injectAcceptanceEvent({
      type: 'turn', chatId, turnId
    }), { chatId: chat.id, turnId: activeTurnId });

    await page.evaluate(({ chatId, turnId }) => window.rambo.injectAcceptanceEvent({
      type: 'activity',
      activity: {
        id: 'activity-command-1',
        chatId,
        turnId,
        itemId: 'command-1',
        kind: 'command',
        status: 'complete',
        title: 'rg --files src',
        detail: 'src/App.tsx',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }), { chatId: chat.id, turnId: activeTurnId });
    await expect(page.getByLabel('正在运行命令')).toBeVisible();
    await page.evaluate(({ chatId, turnId }) => window.rambo.injectAcceptanceEvent({
      type: 'turn', chatId, turnId
    }), { chatId: chat.id, turnId: activeTurnId });
    await page.evaluate(() => {
      window.__ramboStageAnimations = [];
      document.addEventListener('animationstart', event => {
        if (event.animationName === 'message-stage-transition') {
          window.__ramboStageAnimations.push({
            target: event.target?.className ?? '',
            row: event.target?.closest?.('.message-row')?.className ?? ''
          });
        }
      });
    });
    await page.evaluate(({ threadId, turnId }) => window.rambo.injectAcceptanceEvent({
      type: 'acceptanceNotification',
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          id: 'commentary-ui-1',
          type: 'agentMessage',
          text: '我先检查项目结构。',
          phase: 'commentary'
        }
      }
    }), { threadId, turnId: activeTurnId });
    const assistantBubble = page.locator('.message-assistant');
    await expect(assistantBubble).toHaveCount(1);
    await expect(assistantBubble).toContainText('我先检查项目结构。');
    await expect(page.locator('.agent-running-shimmer')).not.toHaveText('我先检查项目结构。');
    await page.evaluate(({ chatId, turnId, updatedAt }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'turn', chatId, turnId
      }), { chatId: chat.id, turnId: activeTurnId });
    await page.evaluate(({ chatId, turnId, updatedAt }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'activity',
        activity: {
          id: 'activity-web-after-stage',
          chatId,
          turnId,
          itemId: 'web-after-stage',
          kind: 'web',
          status: 'running',
          title: '搜索：真实事件顺序',
          detail: '',
          createdAt: updatedAt,
          updatedAt
        }
      }), {
      chatId: chat.id,
      turnId: activeTurnId,
      updatedAt: new Date(Date.now() + 50).toISOString()
    });
    await expect(page.getByLabel('正在搜索网页')).toBeVisible();
    await expect(assistantBubble).toContainText('我先检查项目结构。');
    await page.evaluate(({ threadId, turnId }) => window.rambo.injectAcceptanceEvent({
      type: 'acceptanceNotification',
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          id: 'partial-ui-1',
          type: 'agentMessage',
          text: '我已经找到相关入口。',
          phase: 'partial_answer'
        }
      }
    }), { threadId, turnId: activeTurnId });
    await expect(page.locator('.message-assistant')).toHaveCount(1);
    await expect(page.locator('.message-assistant')).toContainText('我已经找到相关入口。');
    await expect(page.locator('.message-assistant')).not.toContainText('我先检查项目结构。');
    await expect.poll(() => page.evaluate(() => window.__ramboStageAnimations
      .some(animation => animation.row.includes('message-assistant')))).toBe(true);
    await expect(page.locator('.message-activities, .message-activity-popover')).toHaveCount(0);
    await page.evaluate(chatId =>
      window.rambo.send(chatId, '补充一句：继续检查另一个入口。'), chat.id);
    await expect(page.locator('.message-user').last())
      .toContainText('补充一句：继续检查另一个入口。');
    await page.evaluate(({ threadId, turnId }) => window.rambo.injectAcceptanceEvent({
      type: 'acceptanceNotification',
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          id: 'partial-ui-2',
          type: 'agentMessage',
          text: '已经转到第二个入口。',
          phase: 'partial_answer'
        }
      }
    }), { threadId, turnId: activeTurnId });
    await expect(page.locator('.message-assistant')).toHaveCount(1);
    await expect(page.locator('.message-assistant')).toContainText('已经转到第二个入口。');
    const assistantAfterUser = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.message-row[data-message-id]')];
      const userIndex = rows.findLastIndex(row =>
        row.classList.contains('message-user') &&
        row.textContent?.includes('补充一句：继续检查另一个入口。')
      );
      const assistantIndex = rows.findLastIndex(row => row.classList.contains('message-assistant'));
      return { userIndex, assistantIndex };
    });
    expect(assistantAfterUser.assistantIndex).toBeGreaterThan(assistantAfterUser.userIndex);
    await expect.poll(() => page.evaluate(() => {
      const transcript = document.querySelector('.transcript-scroll');
      if (!transcript) return Number.POSITIVE_INFINITY;
      return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    })).toBeLessThanOrEqual(1);
    await page.evaluate(({ threadId, turnId }) => window.rambo.injectAcceptanceEvent({
      type: 'acceptanceNotification',
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          id: 'final-ui-1',
          type: 'agentMessage',
          text: '检查已经完成。',
          phase: 'final_answer'
        }
      }
    }), { threadId, turnId: activeTurnId });
    await expect.poll(() => page.evaluate(chatId =>
      window.rambo.snapshot().then(snapshot => snapshot.recentMessages[chatId] ?? null),
      chat.id
    )).toBe('检查已经完成。');
    await page.waitForTimeout(300);
    await expect(page.locator('.message-assistant')).toHaveCount(1);
    await expect(page.locator('.message-assistant')).toContainText('检查已经完成。');
    await expect(page.locator('.message-assistant')).not.toContainText('我先检查项目结构。');
    await expect(page.locator('.message-assistant')).not.toContainText('我已经找到相关入口。');
    await expect(page.locator('.message-assistant')).not.toContainText('已经转到第二个入口。');
    const settled = await page.evaluate(() => {
      const transcriptElement = document.querySelector('.transcript-scroll');
      const messageColumn = document.querySelector('.message-column');
      const runningRow = document.querySelector('.agent-running-row');
      if (!transcriptElement || !messageColumn || !runningRow) return null;
      const transcriptBox = transcriptElement.getBoundingClientRect();
      const columnBox = messageColumn.getBoundingClientRect();
      const runningBox = runningRow.getBoundingClientRect();
      return {
        overflow: transcriptElement.scrollHeight - transcriptElement.scrollTop -
          transcriptElement.clientHeight,
        columnLeft: columnBox.left,
        transcriptLeft: transcriptBox.left,
        runningLeft: runningBox.left,
        runningBottom: runningBox.bottom,
        transcriptBottom: transcriptBox.bottom
      };
    });
    expect(settled).not.toBeNull();
    expect(Math.abs(settled.overflow)).toBeLessThanOrEqual(1);
    expect(settled.columnLeft).toBeGreaterThan(settled.transcriptLeft);
    expect(settled.runningBottom).toBeLessThanOrEqual(settled.transcriptBottom + 1);
    await expect(page.locator('.bot-list-row').filter({ hasText: 'Activity Pilot' }).locator('.bot-row-summary'))
      .toHaveText('检查已经完成。');
    await expect(page.locator('.message-assistant .message-author')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '回到最新' })).toHaveCount(0);
    await expect(page.locator('.message-activities, .message-activity-popover')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看思考与操作' })).toHaveCount(0);
    await expect(page.getByText('rg --files src')).toHaveCount(0);
    await expect(page.getByText('src/App.tsx')).toHaveCount(0);
    await expect(page.getByText('运行详情', { exact: false })).toHaveCount(0);
});

test('真实 Electron 输入框上方空白可将滚轮交给聊天消息区', async ({ electron }) => {
    const page = electron.page;
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Scroll Gap Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Scroll Gap Pilot')).toBeVisible();
    const chat = await page.evaluate(async botName => {
      const snapshot = await window.rambo.snapshot();
      const bot = snapshot.bots.find(item => item.name === botName);
      return snapshot.chats.find(item => item.botId === bot.id && !item.groupChatId && !item.archived);
    }, 'Scroll Gap Pilot');
    for (let index = 0; index < 14; index += 1) {
      await page.evaluate(({ chatId, index }) => window.rambo.injectAcceptanceEvent({
        type: 'message',
        message: {
          id: `scroll-gap-message-${index + 1}`,
          chatId,
          role: index % 2 === 0 ? 'user' : 'assistant',
          text: `滚动空白区消息 ${index + 1}`,
          status: 'complete',
          itemId: `scroll-gap-item-${index + 1}`,
          createdAt: new Date(Date.now() + index).toISOString(),
          turnId: null,
          phase: null
        }
      }), { chatId: chat.id, index });
    }
    const transcript = page.locator('.transcript-scroll');
    await expect.poll(() => transcript.evaluate(element =>
      element.scrollHeight > element.clientHeight + 100
    )).toBe(true);
    await transcript.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const runningDock = page.locator('.chat-running-dock');
    await expect(runningDock.locator('.agent-running-row-hidden')).toHaveCount(1);
    await expect.poll(() => runningDock.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height };
    })).toEqual({ width: expect.any(Number), height: expect.any(Number) });
    const gap = await runningDock.boundingBox();
    if (!gap || gap.height === 0) throw new Error('输入框上方空白区没有可见几何范围');
    const scrollbar = page.locator('.chat-scrollbar');
    await expect(scrollbar).toHaveAttribute('data-overflow', 'true');
    await page.mouse.move(2, 2);
    await expect(scrollbar).toHaveCSS('opacity', '0');
    const fadeIn = await sampleOpacityTransition(page, () =>
      page.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2));
    expect(fadeIn.some(opacity => opacity > 0 && opacity < 1),
      `滚动条淡入没有连续透明度: ${fadeIn.join(', ')}`).toBe(true);
    await expect(scrollbar).toHaveCSS('opacity', '1');
    const before = await transcript.evaluate(element => element.scrollTop);
    await page.mouse.wheel(0, -420);
    await expect.poll(() => transcript.evaluate(element => element.scrollTop))
      .toBeLessThan(before - 100);
    const fadeOut = await sampleOpacityTransition(page, () => page.mouse.move(2, 2));
    expect(fadeOut.some(opacity => opacity > 0 && opacity < 1),
      `滚动条淡出没有连续透明度: ${fadeOut.join(', ')}`).toBe(true);
    await expect(scrollbar).toHaveCSS('opacity', '0');
});

test('真实 Electron 拖入输入框的附件显示为卡片并发送绝对路径', async ({ electron, acceptanceRun }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Drop Attachment Pilot');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 Drop Attachment Pilot')).toBeVisible();

  const fixtures = join(acceptanceRun.run, 'drop-fixtures');
  mkdirSync(fixtures, { recursive: true });
  const textPath = join(fixtures, '拖入文件 示例.txt');
  const imagePath = join(fixtures, '拖入图片 示例.png');
  const textBytes = Buffer.from('附件卡片只引用路径，不改写原文件。', 'utf8');
  const imageBytes = ONE_PIXEL_PNG;
  writeFileSync(textPath, textBytes);
  writeFileSync(imagePath, imageBytes);

  const composer = page.getByRole('textbox', { name: '消息' });
  await composer.fill('请查看下面两个文件');
  const chatId = await page.evaluate(() => window.rambo.snapshot().then(snapshot => {
    const bot = snapshot.bots.find(item => item.name === 'Drop Attachment Pilot');
    return snapshot.chats.find(chat => chat.botId === bot?.id && !chat.groupChatId)?.id;
  }));
  expect(chatId).toBeTruthy();
  const composerBox = await page.locator('.composer').boundingBox();
  if (!composerBox) throw new Error('找不到聊天输入框');
  const cdp = await page.context().newCDPSession(page);
  const dragData = {
    items: [],
    files: [textPath, imagePath],
    dragOperationsMask: 1
  };
  await cdp.send('Input.dispatchDragEvent', {
    type: 'dragEnter',
    x: composerBox.x + composerBox.width / 2,
    y: composerBox.y + composerBox.height / 2,
    data: dragData
  });
  await expect(page.locator('.composer-drop-active')).toBeVisible();
  await cdp.send('Input.dispatchDragEvent', {
    type: 'drop',
    x: composerBox.x + composerBox.width / 2,
    y: composerBox.y + composerBox.height / 2,
    data: dragData
  });
  const attachmentRegion = page.getByLabel('附件区');
  await expect(composer).toHaveValue('请查看下面两个文件');
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(2);
  await expect(attachmentRegion).toContainText('拖入文件 示例.txt');
  await expect(attachmentRegion).toContainText(textPath);
  await expect(attachmentRegion).toContainText('拖入图片 示例.png');
  await expect(attachmentRegion).toContainText(imagePath);
  await expect.poll(() => attachmentRegion.locator('img').evaluate(image => image.naturalWidth))
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => document.querySelector('.composer-drop-active') === null)).toBe(true);
  expect(readFileSync(textPath)).toEqual(textBytes);
  expect(readFileSync(imagePath)).toEqual(imageBytes);

  await cdp.send('Input.dispatchDragEvent', {
    type: 'dragEnter',
    x: composerBox.x + composerBox.width / 2,
    y: composerBox.y + composerBox.height / 2,
    data: dragData
  });
  await cdp.send('Input.dispatchDragEvent', {
    type: 'drop',
    x: composerBox.x + composerBox.width / 2,
    y: composerBox.y + composerBox.height / 2,
    data: dragData
  });
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(2);

  await attachmentRegion.getByRole('button', { name: '移除附件 拖入文件 示例.txt' }).click();
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(1);
  await composer.fill('');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(attachmentRegion).toHaveCount(0);
  await expect.poll(() => page.evaluate(async id => {
    const messages = await window.rambo.messages(id);
    return messages.filter(message => message.role === 'user').at(-1)?.text ?? null;
  }, chatId)).toBe(imagePath);
  await (await electron.restart()).bringToFront();
});

test('真实 Electron 粘贴剪贴板图片进入附件区并发送临时文件绝对路径', async ({ electron }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Paste Attachment Pilot');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 Paste Attachment Pilot')).toBeVisible();

  const composer = page.getByRole('textbox', { name: '消息' });
  await electron.app.evaluate(({ clipboard }) => clipboard.writeText('普通文字粘贴'));
  await composer.focus();
  await page.keyboard.press('Meta+V');
  await expect(composer).toHaveValue('普通文字粘贴');
  await composer.fill('');
  const dataUrl = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`;
  await composer.evaluate((element, imageDataUrl) => {
    const bytes = Uint8Array.from(atob(imageDataUrl.split(',')[1]), character =>
      character.charCodeAt(0)
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    element.dispatchEvent(event);
  }, dataUrl);

  const attachmentRegion = page.getByLabel('附件区');
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(1);
  const pastedPath = await attachmentRegion.locator('[data-composer-attachment]')
    .getAttribute('data-attachment-path');
  expect(pastedPath).toMatch(/\/composer-attachments\/pasted-image-.+\.png$/u);
  expect(readFileSync(pastedPath)).toEqual(ONE_PIXEL_PNG);
  await expect.poll(() => attachmentRegion.locator('img').evaluate(image => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(composer).toHaveValue('');

  const plainTransfer = await composer.evaluate(element => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', '普通文字粘贴');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    element.dispatchEvent(event);
    return true;
  });
  expect(plainTransfer).toBe(true);
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(1);
  await attachmentRegion.getByRole('button', { name: /移除附件 pasted-image-/ }).click();
  await expect(attachmentRegion).toHaveCount(0);

  await composer.evaluate((element, imageDataUrl) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', imageDataUrl);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    element.dispatchEvent(event);
  }, dataUrl);
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(1);
  const textPastedPath = await attachmentRegion.locator('[data-composer-attachment]')
    .getAttribute('data-attachment-path');
  expect(textPastedPath).toMatch(/\/composer-attachments\/pasted-image-.+\.png$/u);

  await composer.fill('请看这张图');
  const chatId = await page.evaluate(() => window.rambo.snapshot().then(snapshot => {
    const bot = snapshot.bots.find(item => item.name === 'Paste Attachment Pilot');
    return snapshot.chats.find(chat => chat.botId === bot?.id && !chat.groupChatId)?.id;
  }));
  expect(chatId).toBeTruthy();
  await page.getByRole('button', { name: '发送' }).click();
  await expect(attachmentRegion).toHaveCount(0);
  await expect.poll(() => page.evaluate(async id => {
    const messages = await window.rambo.messages(id);
    return messages.filter(message => message.role === 'user').at(-1)?.text ?? null;
  }, chatId)).toBe(`请看这张图\n${textPastedPath}`);
  await (await electron.restart()).bringToFront();
});

test('真实 Electron 临时附件按引用状态和草稿占用清理', async ({ electron, acceptanceRun }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Attachment Cleanup Pilot');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 Attachment Cleanup Pilot')).toBeVisible();

  const composer = page.getByRole('textbox', { name: '消息' });
  const dataUrl = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`;
  const pasteImage = async () => {
    await composer.evaluate((element, imageDataUrl) => {
      const bytes = Uint8Array.from(atob(imageDataUrl.split(',')[1]), character =>
        character.charCodeAt(0)
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'cleanup.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      element.dispatchEvent(event);
    }, dataUrl);
    const region = page.getByLabel('附件区');
    await expect(region.locator('[data-composer-attachment]')).toHaveCount(1);
    return region.locator('[data-composer-attachment]').getAttribute('data-attachment-path');
  };
  const backdate = path => {
    const timestamp = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    utimesSync(path, timestamp, timestamp);
  };
  const runCleanup = () => page.evaluate(() =>
    window.rambo.runComposerAttachmentCleanupForAcceptance()
  );

  const draftPath = await pasteImage();
  expect(draftPath).toMatch(/\/composer-attachments\/pasted-image-.+\.png$/u);
  backdate(draftPath);
  let cleanup = await runCleanup();
  expect(cleanup.draftProtectedPaths).toContain(draftPath);
  expect(existsSync(draftPath)).toBe(true);

  await page.getByRole('button', { name: /移除附件 pasted-image-/ }).click();
  await expect(page.getByLabel('附件区')).toHaveCount(0);
  await expect.poll(async () => {
    const result = await runCleanup();
    return result.deletedPaths.includes(draftPath) || !existsSync(draftPath);
  }, { timeout: 5_000 }).toBe(true);

  const referencedPath = await pasteImage();
  expect(referencedPath).toBeTruthy();
  backdate(referencedPath);
  await composer.fill('这张图片已被消息引用');
  const chatId = await page.evaluate(() => window.rambo.snapshot().then(snapshot => {
    const bot = snapshot.bots.find(item => item.name === 'Attachment Cleanup Pilot');
    return snapshot.chats.find(chat => chat.botId === bot?.id && !chat.groupChatId)?.id;
  }));
  expect(chatId).toBeTruthy();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => page.evaluate(async id => {
    const messages = await window.rambo.messages(id);
    return messages.filter(message => message.role === 'user').at(-1)?.text ?? null;
  }, chatId)).toContain(referencedPath);
  cleanup = await runCleanup();
  expect(cleanup.referencedPaths).toContain(referencedPath);
  expect(existsSync(referencedPath)).toBe(true);

  const referencedExpiredTimestamp = new Date(Date.now() - 31 * 24 * 60 * 60_000);
  utimesSync(referencedPath, referencedExpiredTimestamp, referencedExpiredTimestamp);
  cleanup = await runCleanup();
  expect(cleanup.deletedPaths).toContain(referencedPath);
  expect(existsSync(referencedPath)).toBe(false);

  const secondBot = await page.evaluate(() =>
    window.rambo.createBot({ name: 'Attachment Cleanup Switch', avatar: 'b' })
  );
  const switchBotButton = page.getByLabel('会话列表')
    .getByRole('button', { name: /Attachment Cleanup Switch/ });
  await expect(switchBotButton).toBeVisible();
  await switchBotButton.click();
  await expect(page.getByPlaceholder('发消息给 Attachment Cleanup Switch')).toBeVisible();
  const previousChatComposer = page.getByRole('textbox', { name: '消息' });
  const switchPath = await previousChatComposer.evaluate((element, imageDataUrl) => {
    const bytes = Uint8Array.from(atob(imageDataUrl.split(',')[1]), character =>
      character.charCodeAt(0)
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'switch.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    element.dispatchEvent(event);
    return true;
  }, dataUrl);
  expect(switchPath).toBe(true);
  const switchRegion = page.getByLabel('附件区');
  await expect(switchRegion.locator('[data-composer-attachment]')).toHaveCount(1);
  const switchedDraftPath = await switchRegion.locator('[data-composer-attachment]')
    .getAttribute('data-attachment-path');
  backdate(switchedDraftPath);
  await page.getByLabel('会话列表')
    .getByRole('button', { name: /Attachment Cleanup Pilot/ }).click();
  await expect(page.getByPlaceholder('发消息给 Attachment Cleanup Pilot')).toBeVisible();
  await expect.poll(async () => {
    const result = await runCleanup();
    return result.deletedPaths.includes(switchedDraftPath) || !existsSync(switchedDraftPath);
  }, { timeout: 5_000 }).toBe(true);

  const startupAttachments = join(acceptanceRun.profile, 'composer-attachments');
  mkdirSync(startupAttachments, { recursive: true });
  const startupExpired = join(
    startupAttachments,
    'pasted-image-1700000000099-99999999.png'
  );
  const startupUnrelated = join(startupAttachments, 'keep-me.png');
  writeFileSync(startupExpired, ONE_PIXEL_PNG);
  writeFileSync(startupUnrelated, ONE_PIXEL_PNG);
  const startupOldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60_000);
  utimesSync(startupExpired, startupOldTimestamp, startupOldTimestamp);
  utimesSync(startupUnrelated, startupOldTimestamp, startupOldTimestamp);
  await (await electron.restart()).bringToFront();
  await expect.poll(() => existsSync(startupExpired), { timeout: 5_000 }).toBe(false);
  expect(existsSync(startupUnrelated)).toBe(true);
  expect(secondBot.bot.name).toBe('Attachment Cleanup Switch');
});

test('真实 Electron 选择本机附件显示为附件卡片且不改草稿', async ({ electron, acceptanceRun }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Select Attachment Pilot');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 Select Attachment Pilot')).toBeVisible();

  const fixtures = join(acceptanceRun.run, 'select-fixtures');
  mkdirSync(fixtures, { recursive: true });
  const textPath = join(fixtures, '选择文件 示例.txt');
  const imagePath = join(fixtures, '选择图片 示例.png');
  const textBytes = Buffer.from('选择后只展示附件卡片，不上传。', 'utf8');
  const imageBytes = ONE_PIXEL_PNG;
  writeFileSync(textPath, textBytes);
  writeFileSync(imagePath, imageBytes);

  const composer = page.getByRole('textbox', { name: '消息' });
  const selectButton = page.getByRole('button', { name: '添加附件' });
  await expect(selectButton).toBeEnabled();
  await composer.fill('请查看');
  const attachmentRegion = page.getByLabel('附件区');
  await electron.app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, [textPath, imagePath]);
  await selectButton.click();
  await expect(composer).toHaveValue('请查看');
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(2);
  await expect(attachmentRegion).toContainText(textPath);
  await expect(attachmentRegion).toContainText(imagePath);

  await electron.app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => new Promise(resolve => {
      setTimeout(() => resolve({ canceled: true, filePaths: [] }), 250);
    });
  });
  await selectButton.click();
  await expect(selectButton).toBeDisabled();
  await expect(selectButton).toBeEnabled();
  await expect(composer).toHaveValue('请查看');
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(2);

  await electron.app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('fixture dialog failure');
    };
  });
  await selectButton.click();
  await expect(selectButton).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('fixture dialog failure');
  await expect(composer).toHaveValue('请查看');
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(2);

  await electron.app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, [textPath, textPath, imagePath]);
  await selectButton.click();
  await expect(composer).toHaveValue('请查看');
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(2);
  await expect(selectButton).toBeEnabled();
  expect(readFileSync(textPath)).toEqual(textBytes);
  expect(readFileSync(imagePath)).toEqual(imageBytes);

  const groupBots = await page.evaluate(async () => Promise.all([
    window.rambo.createBot({ name: 'Group Select Alpha', avatar: 'a' }),
    window.rambo.createBot({ name: 'Group Select Beta', avatar: 'b' })
  ]));
  const group = await page.evaluate(({ title, botIds }) =>
    window.rambo.createGroup({ title, purpose: 'Validate group management menu actions.', botIds }), {
    title: 'Group Select E2E',
    botIds: groupBots.map(item => item.bot.id)
  });
  await page.getByLabel('会话列表').getByRole('button', { name: /Group Select E2E/ }).click();
  const groupComposer = page.getByRole('combobox', { name: '群聊消息输入框' });
  const groupSelectButton = page.getByRole('button', { name: '添加附件' });
  await expect(groupSelectButton).toBeEnabled();
  await electron.app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, [textPath]);
  await groupComposer.fill('群聊附件');
  await groupSelectButton.click();
  const groupAttachmentRegion = page.getByLabel('附件区');
  await expect(groupComposer).toHaveValue('群聊附件');
  await expect(groupAttachmentRegion.locator('[data-composer-attachment]')).toHaveCount(1);
  await expect(groupAttachmentRegion).toContainText(textPath);

  await page.evaluate(ids => Promise.all(ids.map(id => window.rambo.setBotArchived(id, true))),
    groupBots.map(item => item.bot.id));
  await expect(groupSelectButton).toBeDisabled();
  await expect(groupComposer).toHaveValue('群聊附件');
  await expect(groupAttachmentRegion.locator('[data-composer-attachment]')).toHaveCount(1);
});

test('真实 Electron 发送失败恢复附件与原始正文', async ({ electron, acceptanceRun }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Attachment Retry Pilot');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 Attachment Retry Pilot')).toBeVisible();

  const fixtures = join(acceptanceRun.run, 'retry-fixtures');
  mkdirSync(fixtures, { recursive: true });
  const attachmentPath = join(fixtures, '发送失败 保留附件.txt');
  writeFileSync(attachmentPath, '发送失败后附件仍需保留。', 'utf8');
  await electron.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, attachmentPath);

  const composer = page.getByRole('textbox', { name: '消息' });
  await page.getByRole('button', { name: '添加附件' }).click();
  const attachmentRegion = page.getByLabel('附件区');
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(1);
  const originalDraft = `  ${'a'.repeat(200_001)}  `;
  await composer.fill(originalDraft);
  await page.getByRole('button', { name: '发送', exact: true }).click();

  await expect(page.getByRole('status')).toContainText('无效的文字参数');
  const restoredDraft = await composer.inputValue();
  expect(restoredDraft.length).toBe(originalDraft.length);
  expect(restoredDraft.startsWith('  a')).toBe(true);
  expect(restoredDraft.endsWith('a  ')).toBe(true);
  await expect(attachmentRegion.locator('[data-composer-attachment]')).toHaveCount(1);
  await expect(attachmentRegion).toContainText(attachmentPath);
  expect(readFileSync(attachmentPath, 'utf8')).toBe('发送失败后附件仍需保留。');
});

test('真实 Electron 侧栏未读徽标显示并在打开对应私聊后清除', async ({ electron }) => {
    const page = electron.page;
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Unread Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Unread Pilot')).toBeVisible();
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Other Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    const firstChat = await page.evaluate(() =>
      window.rambo.snapshot().then(snapshot => snapshot.chats.find(chat => chat.botId ===
        snapshot.bots.find(bot => bot.name === 'Unread Pilot').id)));
    await page.evaluate(chatId => window.rambo.injectAcceptanceEvent({
      type: 'message',
      message: {
        id: 'unread-assistant-1',
        chatId,
        role: 'assistant',
        text: '后台完成了',
        status: 'complete',
        itemId: 'unread-item-1',
        createdAt: new Date().toISOString(),
        turnId: null,
        phase: null
      }
    }), firstChat.id);
    const row = page.locator('.bot-list-row').filter({ hasText: 'Unread Pilot' });
    await expect(row.locator('.unread-badge')).toHaveText('1');
    await row.locator('.bot-select').click();
    await expect(row.locator('.unread-badge')).toHaveCount(0);

    await page.evaluate(chatId => window.rambo.send(chatId, '检查当前会话未读。'), firstChat.id);
    await expect.poll(() => page.evaluate(chatId =>
      window.rambo.snapshot().then(snapshot => snapshot.activeTurns[chatId] ?? null),
      firstChat.id
    )).toBeTruthy();
    const turnId = await page.evaluate(chatId =>
      window.rambo.snapshot().then(snapshot => snapshot.activeTurns[chatId]),
      firstChat.id
    );
    const threadId = await page.evaluate(chatId =>
      window.rambo.snapshot().then(snapshot => snapshot.chats.find(chat => chat.id === chatId)?.threadId),
      firstChat.id
    );
    expect(threadId).toBeTruthy();
    await page.evaluate(({ threadId, turnId }) => window.rambo.injectAcceptanceEvent({
      type: 'acceptanceNotification',
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          id: 'unread-current-final',
          type: 'agentMessage',
          text: '当前会话已经看到这条回复。'
        }
      }
    }), { threadId, turnId });
    await page.evaluate(({ threadId, turnId }) => window.rambo.injectAcceptanceEvent({
      type: 'acceptanceNotification',
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, status: 'completed', error: null }
      }
    }), { threadId, turnId });
    await expect(page.getByRole('main').getByText('当前会话已经看到这条回复。')).toBeVisible();
    await expect(row.locator('.unread-badge')).toHaveCount(0);
    await expect.poll(() => page.evaluate(chatId =>
      window.rambo.snapshot().then(snapshot => snapshot.unreadCounts[chatId] ?? 0),
      firstChat.id
    )).toBe(0);
});

test('真实 Electron 新消息提醒只在当前私聊不可见时触发且遵循逐 Bot 开关', async ({ electron }) => {
  const page = electron.page;
  for (const name of ['Notify First', 'Notify Second']) {
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill(name);
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder(`发消息给 ${name}`)).toBeVisible();
  }
  const snapshot = await page.evaluate(() => window.rambo.snapshot());
  const firstBot = snapshot.bots.find(bot => bot.name === 'Notify First');
  const secondBot = snapshot.bots.find(bot => bot.name === 'Notify Second');
  const firstChat = snapshot.chats.find(chat => chat.botId === firstBot.id);
  const secondChat = snapshot.chats.find(chat => chat.botId === secondBot.id);

  await page.evaluate(() => window.rambo.setVisibleChat(null));
  await page.locator('.bot-list-row').filter({ hasText: 'Notify First' })
    .locator('.bot-select').click();
  await expect(page.getByPlaceholder('发消息给 Notify First')).toBeVisible();
  await page.evaluate(() => window.rambo.injectAcceptanceEvent({
    type: 'visibilityFocus', focused: true
  }));
  await page.evaluate(chatId => window.rambo.setVisibleChat(chatId), firstChat.id);
  await page.evaluate(chatId => window.rambo.send(chatId, '当前会话通知抑制'), firstChat.id);
  const { turnId: firstTurn, threadId: firstThread } = await waitForBoundTurn(page, firstChat.id);
  await page.evaluate(({ threadId, firstTurn }) => window.rambo.injectAcceptanceEvent({
    type: 'acceptanceNotification',
    method: 'item/completed',
    params: {
      threadId,
      turnId: firstTurn,
      item: { id: 'notify-visible-reply', type: 'agentMessage', text: '当前私聊可见回复' }
    }
  }), { threadId: firstThread, firstTurn });
  await page.evaluate(({ threadId, firstTurn }) => window.rambo.injectAcceptanceEvent({
    type: 'acceptanceNotification',
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: firstTurn, status: 'completed', error: null }
    }
  }), { threadId: firstThread, firstTurn });
  await expect.poll(() => page.evaluate(({ chatId, turnId }) =>
    window.rambo.snapshot().then(value => value.notifications.recentBotReplies.find(
      item => item.chatId === chatId && item.notificationId === `turn:${turnId}`)?.decision),
    { chatId: firstChat.id, turnId: firstTurn })).toBe('visible');
  await expect.poll(() => page.evaluate(chatId =>
    window.rambo.snapshot().then(value => value.activeTurns[chatId] ?? null),
    firstChat.id)).toBeNull();

  await page.locator('.bot-list-row').filter({ hasText: 'Notify Second' })
    .locator('.bot-select').click();
  await expect(page.getByPlaceholder('发消息给 Notify Second')).toBeVisible();
  await page.evaluate(() => window.rambo.setVisibleChat(null));
  await page.evaluate(() => window.rambo.injectAcceptanceEvent({
    type: 'visibilityFocus', focused: true
  }));
  const secondSend = page.evaluate(
    chatId => window.rambo.send(chatId, '查看其他 Bot 时提醒'),
    secondChat.id
  );
  await secondSend;
  const {
    turnId: secondNotificationTurn,
    threadId: secondNotificationThread
  } = await waitForBoundTurn(page, secondChat.id);
  await page.evaluate(({ threadId, turnId }) => window.rambo.injectAcceptanceEvent({
    type: 'acceptanceNotification',
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { id: 'notify-other-bot-reply', type: 'agentMessage', text: '查看其他 Bot 时应提醒' }
    }
  }), { threadId: secondNotificationThread, turnId: secondNotificationTurn });
  await page.evaluate(({ threadId, turnId }) => window.rambo.injectAcceptanceEvent({
    type: 'acceptanceNotification',
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed', error: null }
    }
  }), { threadId: secondNotificationThread, turnId: secondNotificationTurn });
  await expect.poll(() => page.evaluate(({ chatId, notificationId }) =>
    window.rambo.snapshot().then(value => value.notifications.recentBotReplies.find(
      item => item.chatId === chatId && item.notificationId === `turn:${notificationId}`)?.decision),
    { chatId: secondChat.id, notificationId: secondNotificationTurn })).toBe('enabled');
  await expect.poll(() => page.evaluate(chatId =>
    window.rambo.snapshot().then(value => value.activeTurns[chatId] ?? null),
    secondChat.id)).toBeNull();
});

test('账号设置独立承载登录、模型来源与连接测试，常规保留关于我', async ({ electron }) => {
    const page = electron.page;
    await page.getByLabel('设置', { exact: true }).click();
    await expect(page.getByRole('tab', { name: '账号', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '关于我' })).toBeVisible();
    await expect(page.getByText('Rambo 使用本机 Codex 登录状态。')).toHaveCount(0);
    for (const name of ['常规', '账号', '新建 Bot 初值', '资源管理', '定时任务']) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    }
    await page.getByRole('tab', { name: '账号', exact: true }).click();
    await expect(page.getByRole('heading', { name: '账号状态' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '模型来源' })).toBeVisible();
    await expect(page.getByText(/登录方式：|账号状态来自本机 Codex/).first()).toBeVisible();
    await expect(page.getByRole('radio', { name: /本机 Codex 配置/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /ChatGPT 登录/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /手动配置 API/ })).toBeVisible();
    await page.getByRole('radio', { name: /手动配置 API/ }).click();
    await expect(page.getByRole('heading', { name: '手动 API 配置' })).toBeVisible();
    await expect(page.getByLabel('Base URL')).toBeVisible();
    await expect(page.getByLabel('模型 ID')).toBeVisible();
    await expect(page.getByLabel('API Key')).toHaveAttribute('type', 'password');
    await expect(page.getByText(/不承诺第三方服务完整支持/u)).toBeVisible();
    await expect(page.getByRole('radio', { name: /手动配置 API/ })).toBeChecked();
    await expect(page.getByRole('button', { name: '测试连接与延迟', exact: true })).toBeVisible();
    await expect(page.getByText(/注册|同步到其他设备|跨设备同步/)).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.rambo.snapshot());
    expect(snapshot.settings).not.toHaveProperty('account');
    expect(snapshot.settings).not.toHaveProperty('sync');
    expect(snapshot.modelSource.kind).toBe('local');
    expect(snapshot.modelSource.hasApiKey).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
});

test('手动 API 来源保存加密凭证、测试真实 Responses 连接并可切回本机配置', async ({
  electron, acceptanceRun
}) => {
  test.setTimeout(60_000);
  const page = electron.page;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'resp_e2e', output_text: 'OK' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地 Responses fixture 没有监听端口');
  const secret = 'sk-e2e-manual-secret';
  try {
    await openSystemSettings(page, '账号');
    await page.getByRole('radio', { name: /手动配置 API/ }).click();
    await page.getByLabel('服务名称').fill('E2E Responses');
    await page.getByLabel('Base URL').fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel('模型 ID').fill('fixture-model');
    await page.getByLabel('API Key').fill(secret);
    await page.getByRole('button', { name: '保存并测试', exact: true }).click();

    await expect(page.getByRole('status').filter({ hasText: '连接可用 · 首响应' }))
      .toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => window.rambo.snapshot()))
      .toMatchObject({
        modelSource: {
          kind: 'local',
          manual: {
            serviceName: 'E2E Responses',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            model: 'fixture-model'
          },
          hasApiKey: true
        }
      });
    await expect(page.getByRole('button', { name: '切换为当前来源', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '切换为当前来源', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.rambo.snapshot().then(value => value.modelSource.kind)))
      .toBe('manualApi');
    const snapshot = await page.evaluate(() => window.rambo.snapshot());
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/v1/responses',
        authorization: `Bearer ${secret}`
      })
    ]);
    const credentialDatabase = readFileSync(
      join(acceptanceRun.profile, 'connector-credentials', 'credentials.sqlite'),
      'utf8'
    );
    expect(credentialDatabase).not.toContain(secret);

    await page.getByRole('radio', { name: /本机 Codex 配置/ }).click();
    await expect.poll(() => page.evaluate(() => window.rambo.snapshot().then(value => value.modelSource.kind)))
      .toBe('local');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('手动 API 保存后连接失败不提供启用入口且保留原来源', async ({ electron }) => {
  test.setTimeout(60_000);
  const page = electron.page;
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地 Responses fixture 没有监听端口');
  try {
    await openSystemSettings(page, '账号');
    await page.getByRole('radio', { name: /手动配置 API/ }).click();
    await expect(page.getByLabel('服务名称')).toBeEditable({ timeout: 30_000 });
    await page.getByLabel('服务名称').fill('E2E Rejected');
    await page.getByLabel('Base URL').fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel('模型 ID').fill('fixture-model');
    await page.getByLabel('API Key').fill('sk-e2e-invalid-secret');
    await page.getByRole('button', { name: '保存并测试', exact: true }).click();

    await expect(page.getByRole('status').filter({ hasText: '连接失败 · 首响应' }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('status').filter({ hasText: 'HTTP 401' })).toBeVisible();
    await expect(page.getByRole('button', { name: '切换为当前来源', exact: true }))
      .toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存配置', exact: true }))
      .toBeEnabled();
    await expect(page.getByRole('radio', { name: /手动配置 API/ })).toBeChecked();
    await expect(page.getByText('当前生效', { exact: true })).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.rambo.snapshot().then(value => value.modelSource.kind)))
      .toBe('local');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('系统设置按 Bot 分组管理全部任务并在重启后保留归属', async ({ electron, acceptanceRun }) => {
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
    await openBotSettings(page, 'Routine Alpha');
    await page.getByRole('tab', { name: '定时任务', exact: true }).click();
    const alphaDetails = page.getByRole('tabpanel', { name: '定时任务' });
    await expect(alphaDetails.getByText('Alpha planning')).toBeVisible();
    await expect(alphaDetails.getByText(/只整理 Alpha 自己的工作清单/)).toBeVisible();
    await expect(alphaDetails.getByText(/每个工作日.*09:00/)).toBeVisible();
    await expect(alphaDetails.locator('.routine-execution-mode')).toHaveText('脚本执行');
    await expect(alphaDetails.getByText(/下次 /)).toBeVisible();
    await expect(alphaDetails.getByText('Beta summary')).toHaveCount(0);
    await expect(alphaDetails.getByText(bots.beta.name)).toHaveCount(0);
    await expect(alphaDetails.getByRole('button')).toHaveCount(0);

    await openBotSettings(page, 'Routine Beta');
    await page.getByRole('tab', { name: '定时任务', exact: true }).click();
    const betaDetails = page.getByRole('tabpanel', { name: '定时任务' });
    await expect(betaDetails.getByText('Beta summary')).toBeVisible();
    await expect(betaDetails.getByText(/只汇总 Beta 的项目进展/)).toBeVisible();
    await expect(betaDetails.getByText(/每周五.*18:00/)).toBeVisible();
    await expect(betaDetails.locator('.routine-execution-mode')).toHaveText('对话执行');
    await expect(betaDetails.getByText('已暂停')).toBeVisible();
    await expect(betaDetails.getByText('Alpha planning')).toHaveCount(0);
    await expect(betaDetails.getByText(bots.alpha.name)).toHaveCount(0);
  };
  const assertOverview = async (page, bots) => {
    await openSystemSettings(page, '定时任务');
    const overview = page.getByLabel('所有 Bot 的定时任务');
    await expect(overview.locator('.routine-bot-group')).toHaveCount(2);
    const alphaGroup = overview.locator(`.routine-bot-group[data-bot-id="${bots.alpha.id}"]`);
    const betaGroup = overview.locator(`.routine-bot-group[data-bot-id="${bots.beta.id}"]`);
    await expect(alphaGroup.getByRole('heading', { name: bots.alpha.name })).toBeVisible();
    await expect(betaGroup.getByRole('heading', { name: bots.beta.name })).toBeVisible();
    await expect(alphaGroup.locator('.routine-bot-group-heading .bot-avatar')).toHaveCount(1);
    await expect(betaGroup.locator('.routine-bot-group-heading .bot-avatar')).toHaveCount(1);
    await expect(alphaGroup.locator('.routine-bot-group-count')).toHaveText('1 个任务');
    await expect(betaGroup.locator('.routine-bot-group-count')).toHaveText('1 个任务');
    await expect(alphaGroup.locator('.routine-list-item')).toHaveCount(1);
    await expect(betaGroup.locator('.routine-list-item')).toHaveCount(1);
    const alphaRoutine = alphaGroup.locator('.routine-list-item').filter({ hasText: 'Alpha planning' });
    const betaRoutine = betaGroup.locator('.routine-list-item').filter({ hasText: 'Beta summary' });
    await expect(alphaRoutine).toContainText('只整理 Alpha 自己的工作清单');
    await expect(betaRoutine).toContainText('只汇总 Beta 的项目进展');
    await expect(alphaRoutine.getByText(/每个工作日.*09:00/)).toBeVisible();
    await expect(betaRoutine.getByText(/每周五.*18:00/)).toBeVisible();
    await expect(alphaRoutine.locator('.routine-execution-mode')).toHaveText('脚本执行');
    await expect(betaRoutine.locator('.routine-execution-mode')).toHaveText('对话执行');
    await expect(alphaRoutine).toContainText('下次 ');
    await expect(betaRoutine).toContainText('已暂停');
    await expect(alphaRoutine.getByText(bots.alpha.name, { exact: true })).toHaveCount(0);
    await expect(betaRoutine.getByText(bots.beta.name, { exact: true })).toHaveCount(0);
  };
    const page = electron.page;
    for (const [name, role] of [['Routine Alpha', '整理工作清单'], ['Routine Beta', '汇总项目进展']]) {
      await page.getByLabel('创建 Bot').click();
      const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
      await page.getByLabel('Bot 名称').fill(name);
      await dialog.getByRole('button', { name: '创建', exact: true }).click();
      await openBotSettings(page, name);
      await page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox').fill(role);
      await expect(page.locator('.autosave-indicator').filter({ hasText: '已自动保存' })).toBeVisible();
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
        triggerTime: '09:00',
        kind: 'recurring',
        executionMode: 'script',
        executionTemplate: '列出 Alpha 当前工作区中的工作项并按优先级整理。'
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

    await openBotSettings(page, 'Routine Alpha');
    await openSystemSettings(page, '定时任务');
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
    expect(manualRun.sourceChatId).toBeTruthy();
    await expect.poll(async () => {
      const turns = await page.evaluate(
        chatId => window.rambo.turns(chatId), manualRun.sourceChatId
      );
      return turns.some(turn => turn.status === 'running');
    }, { message: 'Routine 结果没有交回 Bot 原私聊' }).toBe(true);
    const handedOffMessages = await page.evaluate(
      chatId => window.rambo.messages(chatId), manualRun.sourceChatId
    );
    expect(handedOffMessages.filter(message => message.role === 'system')
      .map(message => message.text)).toEqual([
        '已创建周期任务：Alpha planning'
      ]);

    await openSystemSettings(page, '定时任务');
    const overview = page.getByLabel('所有 Bot 的定时任务');
    const alphaGroup = overview.locator(`.routine-bot-group[data-bot-id="${alpha.id}"]`);
    const alphaCard = alphaGroup.locator('.routine-list-item').filter({ hasText: 'Alpha planning' });
    const completedSummary = completed.routineRuns.find(item => item.id === manualRun.id)?.summary;
    expect(completedSummary).toBeTruthy();
    await expect(alphaCard.locator('.routine-run-entry')).toContainText(completedSummary);

    acceptanceRun.evidence.routine = {
      alphaId: alpha.id,
      betaId: beta.id,
      alphaName: alpha.name,
      betaName: beta.name
    };
});

test('真实模型根据相对时间和任务性质创建一次性脚本 Routine 且不提前给出结果', async ({ electron, acceptanceRun }) => {
  test.setTimeout(90_000);
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Routine Smoke');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  const chat = await page.evaluate(async botName => {
    const snapshot = await window.rambo.snapshot();
    const bot = snapshot.bots.find(item => item.name === botName);
    return snapshot.chats.find(item => item.botId === bot.id && !item.groupChatId && !item.archived);
  }, 'Routine Smoke');

  await page.evaluate(chatId => window.rambo.send(
    chatId,
    '2分钟后帮我计算5×6的结果。请创建一次性定时任务，到时间再交回结果。'
  ), chat.id);
  let snapshot;
  try {
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      const active = Boolean(snapshot.activeTurns[chat.id] || snapshot.startingTurns[chat.id]);
      const created = snapshot.routines.some(item => item.botId === snapshot.bots.find(bot =>
        bot.name === 'Routine Smoke')?.id);
      return created || !active;
    }, { message: '真实模型回合没有结束', timeout: 60_000, intervals: [250, 500, 1_000] }).toBe(true);
  } catch (error) {
    snapshot = await page.evaluate(() => window.rambo.snapshot());
    const diagnostics = {
      chat: snapshot.chats.find(item => item.id === chat.id),
      activeTurn: snapshot.activeTurns[chat.id] ?? null,
      startingTurn: snapshot.startingTurns[chat.id] ?? null,
      messages: await page.evaluate(chatId => window.rambo.messages(chatId), chat.id),
      turns: await page.evaluate(chatId => window.rambo.turns(chatId), chat.id),
      runtime: snapshot.runtime
    };
    test.skip(true, `真实模型回合在 60 秒内未结束，等待不计为规则失败：${JSON.stringify(diagnostics)}`);
    return;
  }
  if (snapshot.activeTurns[chat.id] || snapshot.startingTurns[chat.id]) {
    test.skip(true, '真实模型仍在处理，未得到可用于判断的完成回复');
    return;
  }

  const bot = snapshot.bots.find(item => item.name === 'Routine Smoke');
  const routine = snapshot.routines.find(item => item.botId === bot.id);
  const messages = await page.evaluate(chatId => window.rambo.messages(chatId), chat.id);
  const assistantText = messages
    .filter(message => message.role === 'assistant')
    .map(message => message.text)
    .join('\n');
  acceptanceRun.evidence.routineSmoke = {
    botId: bot.id,
    chatId: chat.id,
    routine,
    assistantText,
    systemText: messages.filter(message => message.role === 'system').map(message => message.text)
  };
  expect(routine, `真实模型回合已完成但未创建 Routine：${assistantText}`).toBeTruthy();
  expect(routine.definition.kind).toBe('once');
  expect(routine.definition.execution.mode).toBe('script');
  expect(routine.definition.execution.template).toMatch(/脚本|执行|核验|计算/);
  expect(assistantText).not.toMatch(/(?:结果|答案)[^\n]{0,15}\b30\b|5\s*[×*]\s*6\s*=\s*30/u);
});

test('真实 Electron 一次性 Routine 失败后清理定义并保留失败记录', async ({ electron }) => {
  const waitForSnapshot = async (page, predicate, message) => {
    let snapshot;
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return predicate(snapshot);
    }, { message }).toBe(true);
    return snapshot;
  };
    const page = electron.page;
    const app = electron.app;
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Once Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Once Pilot')).toBeVisible();
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
    const handoffTurn = async (message) => {
      await expect.poll(async () => {
        const turns = await page.evaluate(chatId => window.rambo.turns(chatId), chat.id);
        return turns.some(turn => turn.status === 'running');
      }, { message }).toBe(true);
      const turns = await page.evaluate(chatId => window.rambo.turns(chatId), chat.id);
      const turn = turns.find(item => item.status === 'running');
      expect(turn).toBeTruthy();
      await page.evaluate(({ threadId, turnId }) =>
        window.rambo.injectAcceptanceEvent({
          type: 'acceptanceNotification',
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed', error: null } }
        }), { threadId: turn.threadId, turnId: turn.turnId });
    };
    await handoffTurn('Once success 的结果没有交回来源 Bot 私聊');
    await handoffTurn('Once failed 的结果没有交回来源 Bot 私聊');

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
    snapshot = await waitForSnapshot(
      page,
      current => !current.routines.some(item => item.id === success.id) &&
        !current.routines.some(item => item.id === failed.id),
      '成功和失败的一次性 Routine 终态交接后没有清理定义'
    );
    expect(snapshot.routines.find(item => item.id === missed.id)).toMatchObject({
      id: missed.id,
      definition: { kind: 'once' }
    });
    expect(snapshot.routineRuns.find(item => item.id === successRun.id)).toMatchObject({
      status: 'succeeded',
      summary: '一次性成功结果'
    });
    expect(snapshot.routineRuns.find(item => item.id === failedRun.id)).toMatchObject({
      status: 'failed',
      error: '受控验收失败：模拟 Codex 执行错误'
    });

    await openSystemSettings(page, '定时任务');
    const details = page.getByLabel('Once Pilot 管理的定时任务');
    await expect(details.locator('.routine-list-item').filter({ hasText: 'Once success' }))
      .toHaveCount(0);
    await expect(details.locator('.routine-list-item').filter({ hasText: 'Once failed' }))
      .toHaveCount(0);
    await expect(details.locator('.routine-list-item').filter({ hasText: 'Once missed' }))
      .toContainText('已错过');

    const missedRun = await page.evaluate(
      routineId => window.rambo.runRoutineNow(routineId),
      missed.id
    );
    const missedTurns = await page.evaluate(chatId => window.rambo.turns(chatId), missedRun.chatId);
    const missedTurn = missedTurns.find(item => item.turnId === missedRun.turnId);
    expect(missedTurn).toBeTruthy();
    await page.evaluate(({ threadId, turnId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: { id: 'once-missed-result', type: 'agentMessage', text: '错过后手动运行成功' }
        }
      }), { threadId: missedTurn.threadId, turnId: missedRun.turnId });
    await page.evaluate(({ threadId, turnId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed', error: null } }
      }), { threadId: missedTurn.threadId, turnId: missedRun.turnId });
    await expect.poll(async () => {
      const turns = await page.evaluate(chatId => window.rambo.turns(chatId), chat.id);
      return turns.some(turn => turn.status === 'running');
    }, { message: '错过任务手动完成后的结果没有交回来源 Bot 私聊' }).toBe(true);
    const missedHandoffTurns = await page.evaluate(chatId => window.rambo.turns(chatId), chat.id);
    const missedHandoff = missedHandoffTurns.find(turn => turn.status === 'running');
    expect(missedHandoff).toBeTruthy();
    await page.evaluate(({ threadId, turnId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed', error: null } }
      }), { threadId: missedHandoff.threadId, turnId: missedHandoff.turnId });
    snapshot = await waitForSnapshot(
      page,
      current => !current.routines.some(item => item.id === missed.id) &&
        current.routineRuns.find(item => item.id === missedRun.id)?.status === 'succeeded',
      '错过的一次性 Routine 手动完成后没有清理定义或保留运行记录'
    );
    expect(snapshot.routineRuns.find(item => item.id === successRun.id)).toMatchObject({
      status: 'succeeded',
      summary: '一次性成功结果'
    });
    await openSystemSettings(page, '定时任务');
    await expect(details.locator('.routine-list-item').filter({ hasText: 'Once missed' }))
      .toHaveCount(0);
});

test('真实 Electron 一条多时刻 Routine 在关窗后分别触发', async ({ electron }) => {
  const waitForSnapshot = async (page, predicate, message) => {
    let snapshot;
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return predicate(snapshot);
    }, { message }).toBe(true);
    return snapshot;
  };
  const completeRoutineTurn = async (page, runId) => {
    const current = await page.evaluate(() => window.rambo.snapshot());
    const run = current.routineRuns.find(item => item.id === runId);
    if (!run?.chatId || !run.turnId) throw new Error('Routine 没有关联可完成的执行 turn');
    const turns = await page.evaluate(chatId => window.rambo.turns(chatId), run.chatId);
    const turn = turns.find(item => item.turnId === run.turnId);
    if (!turn) throw new Error('找不到 Routine 执行 turn 记录');
    await page.evaluate(({ threadId, turnId, itemId, text }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'item/completed',
        params: { threadId, turnId, item: { id: itemId, type: 'agentMessage', text } }
      }), {
      threadId: turn.threadId,
      turnId: run.turnId,
      itemId: `${runId}-result`,
      text: `多时刻 Routine 结果 ${runId}`
    });
    await page.evaluate(({ threadId, turnId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceNotification',
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed', error: null } }
      }), { threadId: turn.threadId, turnId: run.turnId });
    await expect.poll(async () => {
      const latest = await page.evaluate(() => window.rambo.snapshot());
      return latest.routineRuns.find(item => item.id === runId)?.status;
    }).toBe('succeeded');
    // Finish the source-chat handoff so the next scheduled occurrence can be
    // evaluated in the same real Electron process.
    await expect.poll(async () => {
      const sourceTurns = await page.evaluate(chatId => window.rambo.turns(chatId), run.sourceChatId);
      return sourceTurns.some(item => item.status === 'running');
    }).toBe(true);
    const sourceTurns = await page.evaluate(chatId => window.rambo.turns(chatId), run.sourceChatId);
    for (const sourceTurn of sourceTurns.filter(item => item.status === 'running')) {
      await page.evaluate(({ threadId, turnId }) =>
        window.rambo.injectAcceptanceEvent({
          type: 'acceptanceNotification',
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed', error: null } }
        }), { threadId: sourceTurn.threadId, turnId: sourceTurn.turnId });
    }
  };

  const page = electron.page;
  const app = electron.app;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Multi-time Pilot');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByPlaceholder('发消息给 Multi-time Pilot')).toBeVisible();

  let snapshot = await page.evaluate(() => window.rambo.snapshot());
  const bot = snapshot.bots.find(item => item.name === 'Multi-time Pilot');
  const chat = snapshot.chats.find(item => item.botId === bot.id);
  await page.evaluate(chatId => window.rambo.send(chatId, '准备多时刻 Routine。'), chat.id);
  snapshot = await waitForSnapshot(
    page,
    current => Boolean(current.chats.find(item => item.id === chat.id)?.threadId),
    '多时刻 Routine 未建立来源私聊 thread'
  );
  const threadId = snapshot.chats.find(item => item.id === chat.id).threadId;
  const created = await page.evaluate(({ threadId }) =>
    window.rambo.injectAcceptanceEvent({
      type: 'routineTool',
      method: 'item/tool/call',
      params: {
        threadId,
        turnId: 'multi-time-setup-turn',
        callId: 'multi-time-create',
        namespace: 'rambo_routines',
        tool: 'create_routine',
        arguments: {
          title: 'Three daily checks',
          instruction: '检查当天需要关注的事项。',
          schedule: '每天',
          kind: 'recurring',
          triggerTimes: ['04:50', '00:00', '01:30', '01:30'],
          catchUp: true
        }
      }
    }), { threadId });
  expect(created.result.success, created.result.contentItems?.[0]?.text).toBe(true);
  expect(created.result.contentItems?.[0]?.text).toContain('00:00、01:30、04:50');
  snapshot = await waitForSnapshot(
    page,
    current => current.routines.filter(item => item.botId === bot.id).length === 1,
    '多时刻 Routine 没有保存为唯一任务'
  );
  const routine = snapshot.routines.find(item => item.botId === bot.id);
  expect(routine.definition.times).toEqual(['00:00', '01:30', '04:50']);

  await openSystemSettings(page, '定时任务');
  const details = page.getByLabel('Multi-time Pilot 管理的定时任务');
  await expect(details.locator('.routine-list-item')).toHaveCount(1);
  await expect(details.locator('.routine-list-item').first())
    .toContainText('00:00、01:30、04:50');

  await page.evaluate(routineId =>
    window.rambo.advanceRoutineScheduleForAcceptance(routineId), routine.id);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.isVisible()
  )).toBe(false);
  await page.evaluate(() => window.rambo.injectAcceptanceEvent({
    type: 'acceptanceRoutineTick'
  }));
  snapshot = await waitForSnapshot(
    page,
    current => current.routineRuns.filter(item =>
      item.routineId === routine.id && item.trigger === 'schedule'
    ).length === 1,
    '第一个多时刻 occurrence 没有触发'
  );
  const firstRun = snapshot.routineRuns.find(item =>
    item.routineId === routine.id && item.trigger === 'schedule'
  );
  expect(firstRun.status).toBe('running');
  expect(snapshot.routines.filter(item => item.botId === bot.id)).toHaveLength(1);
  await completeRoutineTurn(page, firstRun.id);

  await page.evaluate(routineId =>
    window.rambo.advanceRoutineScheduleForAcceptance(routineId), routine.id);
  await page.evaluate(() => window.rambo.injectAcceptanceEvent({
    type: 'acceptanceRoutineTick'
  }));
  snapshot = await waitForSnapshot(
    page,
    current => current.routineRuns.filter(item =>
      item.routineId === routine.id && item.trigger === 'schedule'
    ).length === 2,
    '第二个多时刻 occurrence 没有独立触发'
  );
  const scheduledRuns = snapshot.routineRuns.filter(item =>
    item.routineId === routine.id && item.trigger === 'schedule'
  );
  expect(new Set(scheduledRuns.map(item => item.scheduledFor)).size).toBe(2);
  expect(snapshot.routines.filter(item => item.botId === bot.id)).toHaveLength(1);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.show();
  });
});

test('真实 Electron 用户停止本次并暂停后停止独立 Routine 运行', async ({ electron }) => {
  const waitForSnapshot = async (page, predicate, message) => {
    let snapshot;
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return predicate(snapshot);
    }, { message }).toBe(true);
    return snapshot;
  };
    const page = electron.page;
    const app = electron.app;
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('R13 Stop Bot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 R13 Stop Bot')).toBeVisible();

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

    await openBotSettings(page, 'R13 Stop Bot');
    await openSystemSettings(page, '定时任务');
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
    await expect.poll(async () => {
      const turns = await page.evaluate(chatId => window.rambo.turns(chatId), sourceChat.id);
      return turns.some(turn => turn.status === 'running');
    }, { message: '中断结果没有交回 Bot 原私聊' }).toBe(true);
    const sourceMessages = await page.evaluate(chatId => window.rambo.messages(chatId), sourceChat.id);
    expect(sourceMessages.some(message =>
      message.role === 'system' &&
      (message.text.includes('Stop current run') && message.text.includes('已中断'))
    )).toBe(false);

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
});

test('真实 Electron 验收模式禁止修改系统登录项', async ({ electron }) => {
    const page = electron.page;
    const app = electron.app;
    expect(await page.evaluate(() => window.rambo.loginItemSystemChangesAllowed()))
      .toBe(false);
});

test('真实 Electron 运行中继续输入时保留发送并显示独立停止', async ({ electron }) => {
    const page = electron.page;
    await page.getByLabel('创建 Bot').click();
    const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
    await page.getByLabel('Bot 名称').fill('Steering Pilot');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Steering Pilot')).toBeVisible();

    const snapshot = await page.evaluate(() => window.rambo.snapshot());
    const pilot = snapshot.bots.find(bot => bot.name === 'Steering Pilot');
    const chat = snapshot.chats.find(item => item.botId === pilot.id);
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
    const composer = page.getByPlaceholder('发消息给 Steering Pilot');
    await expect(composer).toBeEnabled();
    await composer.fill('补充修改要求');
    await expect(page.getByRole('button', { name: '发送' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '停止任务' })).toBeVisible();
});

test('真实 Electron 用户和 Bot 气泡统一平滑入场且输入框立即清空', async ({ electron }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
  await page.getByLabel('Bot 名称').fill('Motion Pilot');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByLabel('会话列表').getByRole('button', {
    name: /Motion Pilot/
  })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => window.rambo.snapshot().then(
    snapshot => snapshot.bots.find(bot => bot.name === 'Motion Pilot')?.id ?? null
  ))).toBeTruthy();

  const snapshot = await page.evaluate(() => window.rambo.snapshot());
  const pilot = snapshot.bots.find(bot => bot.name === 'Motion Pilot');
  const chat = snapshot.chats.find(item =>
    item.botId === pilot.id && !item.groupChatId && !item.archived
  );
  expect(chat).toBeTruthy();
  await page.evaluate(chatId => window.rambo.injectAcceptanceEvent({
    type: 'turn', chatId, turnId: 'turn-e2e-motion'
  }), chat.id);

  const composer = page.getByRole('textbox', { name: '消息' });
  const message = '消息入场视觉检查';
  await page.evaluate(() => {
    window.__ramboMessageAnimations = [];
    document.addEventListener('animationstart', event => {
      if (event.animationName === 'message-enter') {
        window.__ramboMessageAnimations.push({
          animationName: event.animationName,
          target: event.target?.className ?? '',
          row: event.target?.closest?.('.message-row')?.className ?? ''
        });
      }
    });
  });
  await composer.fill(message);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(composer).toHaveValue('');
  await expect(page.locator('.composer-flight-message')).toHaveCount(0);
  const userMessage = page.locator('.message-user').filter({ hasText: message });
  await expect(userMessage).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__ramboMessageAnimations.length)).toBeGreaterThan(0);
  const animations = await page.evaluate(() => window.__ramboMessageAnimations);
  expect(animations[0].target).toContain('message-content');
  expect(animations[0].row).toContain('message-user');
  await expect(userMessage).not.toHaveClass(/message-entering/, { timeout: 1500 });
  await expect(userMessage).toBeVisible();

  await page.evaluate(({ chatId }) => window.rambo.injectAcceptanceEvent({
    type: 'message',
    message: {
      id: 'message-e2e-assistant-motion',
      chatId,
      role: 'assistant',
      text: 'Bot 气泡入场视觉检查',
      status: 'complete',
      itemId: 'item-assistant-motion',
      turnId: 'turn-e2e-motion',
      phase: 'final_answer',
      createdAt: new Date(Date.now() + 1).toISOString()
    }
  }), { chatId: chat.id });
  const assistantMessage = page.locator(
    '.message-assistant[data-message-id="message-e2e-assistant-motion"]'
  );
  await expect(assistantMessage).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__ramboMessageAnimations
    .some(animation => animation.row.includes('message-assistant')))).toBe(true);
  const assistantAnimation = await page.evaluate(() => window.__ramboMessageAnimations
    .find(animation => animation.row.includes('message-assistant')));
  expect(assistantAnimation.target).toContain('message-content');
  await expect(assistantMessage).not.toHaveClass(/message-entering/, { timeout: 1500 });

  const assistantAnimationCount = await page.evaluate(() => window.__ramboMessageAnimations
    .filter(animation => animation.row.includes('message-assistant')).length);
  await page.waitForTimeout(300);
  await page.evaluate(({ chatId }) => window.rambo.injectAcceptanceEvent({
    type: 'message',
    message: {
      id: 'message-e2e-assistant-motion',
      chatId,
      role: 'assistant',
      text: 'Bot 气泡流式更新视觉检查',
      status: 'streaming',
      itemId: 'item-assistant-motion',
      turnId: 'turn-e2e-motion',
      phase: 'final_answer',
      createdAt: new Date(Date.now() + 2).toISOString()
    }
  }), { chatId: chat.id });
  await expect(assistantMessage).toContainText('Bot 气泡流式更新视觉检查');
  await page.waitForTimeout(100);
  await expect.poll(() => page.evaluate(() => window.__ramboMessageAnimations
    .filter(animation => animation.row.includes('message-assistant')).length))
    .toBe(assistantAnimationCount);
});

test('真实 Electron 用户修改职责与长期指令后重启仍保留', async ({ electron, acceptanceRun }) => {
  const role = '负责整理项目资料';
  const instructions = '先给出结论，再列出重要依据；不要修改共享资料。';
    const page = electron.page;
    await page.getByLabel('创建 Bot').click();
    const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
    await page.getByLabel('Bot 名称').fill('Profile Pilot');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await openBotSettings(page, 'Profile Pilot');
    await page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox').fill(role);
    await page.getByText('长期指令', { exact: true }).locator('..').getByRole('textbox').fill(instructions);
    await expect(page.locator('.autosave-indicator').filter({ hasText: '已自动保存' })).toBeVisible();
    await expect.poll(async () => {
      const current = await page.evaluate(() => window.rambo.snapshot());
      const currentBot = current.bots.find(bot => bot.name === 'Profile Pilot');
      return currentBot && currentBot.role === role && currentBot.instructions === instructions;
    }, { message: 'Bot 资料没有等到两个防抖字段都完成自动保存' }).toBe(true);
    let snapshot = await page.evaluate(() => window.rambo.snapshot());
    const botId = snapshot.bots.find(bot => bot.name === 'Profile Pilot')?.id;
    expect(botId).toBeTruthy();
    expect(snapshot.bots.find(bot => bot.id === botId)?.role).toBe(role);
    expect(snapshot.bots.find(bot => bot.id === botId)?.instructions).toBe(instructions);
    expect(await page.evaluate(() => window.rambo.memories(null))).toHaveLength(0);
    expect(await page.evaluate(id => window.rambo.memories(id), botId)).toHaveLength(0);

    acceptanceRun.evidence.profile = { botId, role, instructions };
});

test('真实 Electron Bot 自管理写入后界面与重启回读一致', async ({ electron, acceptanceRun }) => {
  const page = electron.page;
  const resourceDirectory = join(acceptanceRun.run, 'self-managed-resource-skill');
  mkdirSync(resourceDirectory, { recursive: true });
  writeFileSync(join(resourceDirectory, 'SKILL.md'), [
    '---',
    'name: Self Managed Imported Skill',
    'description: Imported through the Bot resource tool.',
    '---',
    '',
    'Use the bundled reference during a later task.'
  ].join('\n'));
  writeFileSync(join(resourceDirectory, 'reference.txt'), 'synthetic reference\n');
  const callTool = async (page, threadId, namespace, tool, argumentsValue, callId) =>
    page.evaluate(({ threadId, namespace, tool, argumentsValue, callId }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceTool',
        method: 'item/tool/call',
        params: { threadId, turnId: callId, callId, namespace, tool, arguments: argumentsValue }
      }), { threadId, namespace, tool, argumentsValue, callId });

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
  const models = await page.evaluate(() => window.rambo.models());
  expect(models.length, '真实模型目录为空，无法验证 Bot 自管理模型').toBeGreaterThan(0);
  const managedModel = models.find(option => !option.isDefault) ?? models[0];
  await page.evaluate(chatId => window.rambo.send(
    chatId, '准备测试 Bot 自管理写入。'
  ), chat.id);
  await expect.poll(async () => {
    snapshot = await page.evaluate(() => window.rambo.snapshot());
    return Boolean(snapshot.chats.find(item => item.id === chat.id)?.threadId);
  }).toBe(true);
  const threadId = snapshot.chats.find(item => item.id === chat.id).threadId;

  const profileUpdate = await callTool(page, threadId, 'rambo_bot', 'update_profile', {
    name: 'Self Managed', avatar: 'agent-robot:v2:100:blue:idle',
    role: '自主维护资料', instructions: '回答时先给结论。'
  }, 'b13-profile');
  expect(profileUpdate.result.success, profileUpdate.result.contentItems?.[0]?.text).toBe(true);
  const configUpdate = await callTool(page, threadId, 'rambo_bot', 'update_config', {
    model: managedModel.id, permission: 'readOnly'
  }, 'b13-config');
  expect(configUpdate.result.success, configUpdate.result.contentItems?.[0]?.text).toBe(true);
  const importedResource = await callTool(page, threadId, 'rambo_resources', 'import_local_skill', {
    directory: resourceDirectory
  }, 'b13-resource-import');
  expect(importedResource.result.success, importedResource.result.contentItems?.[0]?.text).toBe(true);
  const resourceId = 'skill:self-managed-resource-skill';
  await page.getByRole('button', { name: /Self Managed/ }).first().click();
  await expect(page.getByPlaceholder('发消息给 Self Managed')).toBeVisible();
  await expect(page.locator('.chat-system-notice').filter({
    hasText: '已导入 Skill Self Managed Imported Skill 到全局可选目录'
  })).toBeVisible();
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.globalResourceIds).toContain(resourceId);
  expect(snapshot.bots.find(bot => bot.id === self.id).resourceIds).not.toContain(resourceId);
  expect(snapshot.bots.find(bot => bot.id === untouched.id).resourceIds).not.toContain(resourceId);
  const enabledResource = await callTool(page, threadId, 'rambo_resources', 'manage_resource', {
    action: 'set_current_bot', resource_id: resourceId, enabled: true
  }, 'b13-resource-enable');
  expect(enabledResource.result.success, enabledResource.result.contentItems?.[0]?.text).toBe(true);
  await expect(page.locator('.chat-system-notice').filter({
    hasText: '已将 Self Managed Imported Skill（Skill） 开启为当前 Bot 资源'
  })).toBeVisible();
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
  const selfBot = snapshot.bots.find(bot => bot.id === self.id);
  expect(selfBot).toMatchObject({
    name: 'Self Managed',
    role: '自主维护资料', instructions: '回答时先给结论。',
    model: managedModel.id, permission: 'readOnly'
  });
  expect(selfBot.resourceIds).toContain(resourceId);
  expect(selfBot?.avatar).toMatch(/^agent-robot:v2:100:blue:(idle|happy|sad|angry|sleepy|sleep|surprise)$/);
  expect(snapshot.chats.find(item => item.id === chat.id)).toMatchObject({
    model: null, permission: null
  });
  expect(await page.evaluate(id => window.rambo.memories(id), self.id)).toHaveLength(1);
  const memory = (await page.evaluate(id => window.rambo.memories(id), self.id))[0];
  expect(snapshot.routines.find(item => item.id === routine.id)).toMatchObject({
    botId: self.id, status: 'paused'
  });
  expect(snapshot.bots.find(bot => bot.id === untouched.id)).toMatchObject({
    name: 'Untouched Pilot',
    role: '',
    model: untouched.model,
    permission: untouched.permission
  });
  expect(snapshot.bots.find(bot => bot.id === untouched.id).resourceIds).not.toContain(resourceId);
  await expect(page.getByRole('button', { name: /Self Managed/ }).first()).toBeVisible();
  await openBotSettings(page, 'Self Managed');
  await expect(page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox'))
    .toHaveValue('自主维护资料');
  await expect(page.getByText('长期指令', { exact: true }).locator('..').getByRole('textbox'))
    .toHaveValue('回答时先给结论。');
  await page.getByRole('tab', { name: '长期记忆' }).click();
  await expect(page.getByLabel('Bot 专属长期记忆条目').getByText('B13 自主记忆标记'))
    .toBeVisible();
  await page.getByRole('tab', { name: '定时任务' }).click();
  const routineDetails = page.getByRole('tabpanel', { name: '定时任务' });
  await expect(routineDetails.getByText('Self managed routine retained')).toBeVisible();
  await expect(routineDetails.getByText('已暂停')).toBeVisible();
  await expect(routineDetails.getByText('Self managed transient')).toHaveCount(0);

  acceptanceRun.evidence.selfManaged = {
    botId: self.id,
    chatId: chat.id,
    threadId,
    routineId: routine.id,
    memoryId: memory.id,
    modelId: managedModel.id,
    permission: 'readOnly',
    resourceId
  };
});

test('真实 Electron 新建 Bot 初值复制后逐 Bot 独立并在重启后保持', async ({ electron, acceptanceRun }) => {
  const page = electron.page;
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
  expect(models.length, '真实模型目录为空，无法验证模型设置').toBeGreaterThan(0);
  const globalModel = models.find(option => option.isDefault) ?? models[0];
  const sessionModel = models.find(option => option.id !== globalModel.id) ?? globalModel;
  await openSystemSettings(page, '新建 Bot 初值');
  await page.getByLabel('新建 Bot 模型').selectOption(globalModel.id);
  await page.getByRole('radio', { name: /工作区写入/ }).click();
  await expect(page.locator('.autosave-indicator').filter({ hasText: '已自动保存' })).toBeVisible();

  await openBotSettings(page, 'Model Pilot');
  await page.getByRole('tab', { name: '模型与权限' }).click();
  await expect(page.getByText('继承全局', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '恢复全局默认', exact: true })).toHaveCount(0);
  const botModel = page.getByLabel('Bot 模型');
  await botModel.selectOption(sessionModel.id);
  await page.getByRole('radio', { name: /只读/ }).click();
  await expect(page.locator('.autosave-indicator').filter({ hasText: '已自动保存' })).toBeVisible();
  await expect(botModel).toHaveValue(sessionModel.id);

  snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.settings).toMatchObject({
    defaultBotModel: globalModel.id,
    defaultBotPermission: 'workspaceWrite'
  });
  expect(snapshot.bots.find(bot => bot.id === pilot.id)).toMatchObject({
    model: sessionModel.id, permission: 'readOnly'
  });
  expect(snapshot.chats.find(chat => chat.botId === pilot.id)).toMatchObject({
    model: null, permission: null
  });
  expect(snapshot.bots.find(bot => bot.id === peer.id)).toMatchObject({
    model: peer.model,
    permission: peer.permission
  });
  expect(snapshot.chats.find(chat => chat.botId === peer.id)).toMatchObject({
    model: null, permission: null
  });
  await page.getByRole('button', { name: /Model Pilot/ }).first().click();
  await page.evaluate(chatId => window.rambo.injectAcceptanceEvent({
    type: 'turn', chatId, turnId: null
  }), snapshot.chats.find(chat => chat.botId === pilot.id).id);
  acceptanceRun.evidence.model = {
    pilotId: pilot.id,
    peerId: peer.id,
    defaultBotModel: globalModel.id,
    pilotModel: sessionModel.id,
    defaultBotPermission: 'workspaceWrite',
    pilotPermission: 'readOnly',
    peerModel: peer.model,
    peerPermission: peer.permission
  };
});

test('真实 Electron 模型与权限初值独立复制且运行时重建后重载模型目录', async ({
  electron, acceptanceRun
}) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Readiness Alpha');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();

  let snapshot = await page.evaluate(() => window.rambo.snapshot());
  const alpha = snapshot.bots.find(bot => bot.name === 'Readiness Alpha');
  expect(alpha).toBeTruthy();
  const models = await page.evaluate(() => window.rambo.models());
  expect(models.length, '真实模型目录为空，无法验证初值复制').toBeGreaterThan(0);
  const nextModel = models.find(option => option.id !== alpha.model);
  expect(nextModel, '模型目录至少需要两个不同选项').toBeDefined();

  await openSystemSettings(page, '新建 Bot 初值');
  const defaultModel = page.getByLabel('新建 Bot 模型');
  const defaultModelOptions = await defaultModel.locator('option').evaluateAll(options =>
    options.map(option => ({
      value: option.value,
      disabled: option.disabled,
      label: option.textContent
    }))
  );
  expect(defaultModelOptions.some(option => option.value === '' && option.disabled))
    .toBe(false);
  await defaultModel.selectOption(nextModel.id);
  await page.getByRole('radio', { name: /只读/ }).click();
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.rambo.snapshot());
    return [
      current.settings.defaultBotModel,
      current.settings.defaultBotPermission
    ];
  }).toEqual([nextModel.id, 'readOnly']);
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.bots.find(bot => bot.id === alpha.id)).toMatchObject({
    model: alpha.model,
    permission: alpha.permission
  });

  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Readiness Beta');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  const beta = snapshot.bots.find(bot => bot.name === 'Readiness Beta');
  expect(beta).toMatchObject({ model: nextModel.id, permission: 'readOnly' });
  expect(snapshot.bots.find(bot => bot.id === alpha.id)).toMatchObject({
    model: alpha.model,
    permission: alpha.permission
  });
  expect(snapshot.chats.find(chat => chat.botId === beta.id)).toMatchObject({
    model: null,
    permission: null
  });

  await openBotSettings(page, 'Readiness Alpha');
  await page.getByRole('tab', { name: '模型与权限' }).click();
  const alphaModel = page.getByLabel('Bot 模型');
  const alphaModelOptions = await alphaModel.locator('option').evaluateAll(options =>
    options.map(option => ({ value: option.value, disabled: option.disabled }))
  );
  expect(alphaModelOptions.some(option => option.value === '' && option.disabled))
    .toBe(false);
  await alphaModel.selectOption(nextModel.id);
  await page.getByRole('radio', { name: /工作区写入/ }).click();
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.rambo.snapshot());
    const bot = current.bots.find(item => item.id === alpha.id);
    return [bot.model, bot.permission];
  }).toEqual([nextModel.id, 'workspaceWrite']);
  snapshot = await page.evaluate(() => window.rambo.snapshot());
  expect(snapshot.settings).toMatchObject({
    defaultBotModel: nextModel.id,
    defaultBotPermission: 'readOnly'
  });
  acceptanceRun.evidence.model.defaultBotModel = nextModel.id;
  acceptanceRun.evidence.model.defaultBotPermission = 'readOnly';
  expect(snapshot.bots.find(bot => bot.id === beta.id)).toMatchObject({
    model: nextModel.id,
    permission: 'readOnly'
  });

  await page.getByRole('button', { name: /返回聊天/ }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '常规', exact: true }).click();
  const restart = page.getByRole('button', { name: '重启运行时', exact: true });
  await expect(restart).toBeEnabled();
  await restart.click();
  await expect(page.getByText('Codex 已连接', { exact: true }))
    .toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await page.evaluate(() => window.rambo.snapshot()))
    .runtime.status, { timeout: 30_000 }).toBe('ready');

  await page.getByRole('tab', { name: '新建 Bot 初值', exact: true }).click();
  await expect(defaultModel).toBeEnabled();
  await expect.poll(() => defaultModel.locator('option').count()).toBeGreaterThan(0);
  await expect(defaultModel).toHaveValue(nextModel.id);
  const recoveredOptions = await defaultModel.locator('option').evaluateAll(options =>
    options.map(option => ({ value: option.value, disabled: option.disabled }))
  );
  expect(recoveredOptions.some(option => option.value === '' && option.disabled)).toBe(false);
  expect(recoveredOptions.map(option => option.value)).toContain(nextModel.id);
});

test('真实 Electron 集中重启后全部写入与主动切换相同私聊状态保持', async ({
  electron, acceptanceRun
}) => {
  const launchesBeforeRestart = electron.launchCount;
  const page = await electron.restart();
  expect(electron.launchCount).toBe(launchesBeforeRestart + 1);
  const evidence = acceptanceRun.evidence;

  await expect(page.getByRole('button', { name: /E2E Pilot/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Activity Pilot/ }).first()).toBeVisible();
  await expect(page.getByLabel('会话列表').getByText('E2E Pilot')).toBeVisible();

  await page.getByRole('button', { name: /E2E Pilot/ }).first().click();
  await expect(page.getByPlaceholder('发消息给 E2E Pilot')).toBeVisible();
  await page.getByRole('button', { name: /E2E Pilot/ }).first().click();
  await expect(page.locator('.messages-loading')).toHaveCount(0);

  const reopened = await page.evaluate(() => window.rambo.snapshot());
  expect(reopened.bots.filter(bot => bot.name === 'E2E Pilot')).toHaveLength(1);
  const reopenedPilot = reopened.bots.find(bot => bot.name === 'E2E Pilot');
  expect(reopenedPilot?.id).toBe(evidence.pilot?.id);
  expect(reopenedPilot?.avatar).toBe(evidence.pilot?.avatar);
  expect(reopened.chats.filter(chat =>
    chat.botId === evidence.pilot.id && !chat.groupChatId && !chat.archived
  )).toHaveLength(1);

  const alpha = evidence.routine;
  expect(reopened.routines.filter(item =>
    [alpha.alphaId, alpha.betaId].includes(item.botId)
  )).toHaveLength(2);
  expect(reopened.routines.find(item => item.botId === alpha.alphaId)).toMatchObject({
    title: 'Alpha planning', status: 'active',
    definition: {
      instruction: '只整理 Alpha 自己的工作清单',
      schedule: '每个工作日',
      times: ['09:00'],
      time: '09:00'
    }
  });
  expect(reopened.routines.find(item => item.botId === alpha.betaId)).toMatchObject({
    title: 'Beta summary', status: 'paused',
    definition: {
      instruction: '只汇总 Beta 的项目进展',
      schedule: '每周五',
      times: ['18:00'],
      time: '18:00'
    }
  });
  const assertBotRoutineDetails = async (botName, ownTitle, otherTitle, expectedStatus) => {
    await openBotSettings(page, botName);
    await page.getByRole('tab', { name: '定时任务', exact: true }).click();
    const details = page.getByRole('tabpanel', { name: '定时任务' });
    await expect(details.getByText(ownTitle, { exact: true })).toBeVisible();
    await expect(details.getByText(otherTitle, { exact: true })).toHaveCount(0);
    if (expectedStatus) await expect(details.getByText(expectedStatus, { exact: true })).toBeVisible();
    await expect(details.getByRole('button')).toHaveCount(0);
  };
  await assertBotRoutineDetails(alpha.alphaName, 'Alpha planning', 'Beta summary', null);
  await assertBotRoutineDetails(alpha.betaName, 'Beta summary', 'Alpha planning', '已暂停');

  const profile = evidence.profile;
  expect(reopened.bots.find(bot => bot.id === profile.botId)).toMatchObject({
    role: profile.role,
    instructions: profile.instructions
  });
  await openBotSettings(page, 'Profile Pilot');
  await expect(page.getByText('短职责', { exact: true }).locator('..').getByRole('textbox'))
    .toHaveValue(profile.role);
  await expect(page.getByText('长期指令', { exact: true }).locator('..').getByRole('textbox'))
    .toHaveValue(profile.instructions);

  const self = evidence.selfManaged;
  const selfBot = reopened.bots.find(bot => bot.id === self.botId);
  expect(selfBot).toMatchObject({
    name: 'Self Managed',
    role: '自主维护资料', instructions: '回答时先给结论。',
    model: self.modelId, permission: self.permission
  });
  expect(selfBot?.avatar).toMatch(/^agent-robot:v2:100:blue:(idle|happy|sad|angry|sleepy|sleep|surprise)$/);
  expect(reopened.chats.find(item => item.id === self.chatId)).toMatchObject({
    model: null, permission: null
  });
  expect(reopened.routines.find(item => item.id === self.routineId)).toMatchObject({
    botId: self.botId, status: 'paused'
  });
  expect(await page.evaluate(id => window.rambo.memories(id), self.botId)).toHaveLength(1);
  await openBotSettings(page, 'Self Managed');
  await expect(page.getByRole('tab', { name: '长期记忆' })).toBeVisible();
  await page.getByRole('tab', { name: '长期记忆' }).click();
  await expect(page.getByLabel('Bot 专属长期记忆条目').getByText('B13 自主记忆标记'))
    .toBeVisible();
  await page.getByRole('tab', { name: '定时任务' }).click();
  await expect(page.getByRole('tabpanel', { name: '定时任务' })
    .getByText('Self managed routine retained')).toBeVisible();
  await openSystemSettings(page, '定时任务');
  const overview = page.getByLabel('所有 Bot 的定时任务');
  const selfManagedGroup = overview.locator(`.routine-bot-group[data-bot-id="${self.botId}"]`);
  await expect(selfManagedGroup.getByText('Self managed routine retained')).toBeVisible();
  await expect(selfManagedGroup.getByText(/每个工作日.*09:00/)).toBeVisible();

  const model = evidence.model;
  expect(reopened.settings).toMatchObject({
    defaultBotModel: model.defaultBotModel,
    defaultBotPermission: model.defaultBotPermission
  });
  expect(reopened.bots.find(bot => bot.id === model.pilotId)).toMatchObject({
    model: model.pilotModel,
    permission: model.pilotPermission
  });
  expect(reopened.chats.find(chat => chat.botId === model.pilotId)).toMatchObject({
    model: null,
    permission: null
  });
  expect(reopened.bots.find(bot => bot.id === model.peerId)).toMatchObject({
    model: model.peerModel,
    permission: model.peerPermission
  });
  await page.getByRole('button', { name: /Model Pilot/ }).first().click();
  await page.getByRole('button', { name: '打开 Model Pilot 设置' }).click();
  await page.getByRole('tab', { name: '模型与权限' }).click();
  await expect(page.getByLabel('Bot 模型')).toHaveValue(model.pilotModel);
});

test('真实 Electron 关窗后后台服务继续且显式退出停止本机运行时', async ({ electron }) => {
    const page = electron.page;
    const app = electron.app;
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill('Background Pilot');
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByPlaceholder('发消息给 Background Pilot')).toBeVisible();
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
    await expect.poll(async () => {
      const handoffTurns = await visiblePage.evaluate(
        chatId => window.rambo.turns(chatId), chat.id
      );
      return handoffTurns.some(turn => turn.status === 'running');
    }, { message: 'Routine 结果没有交回 Bot 原私聊' }).toBe(true);
    const messages = await visiblePage.evaluate(chatId => window.rambo.messages(chatId), chat.id);
    expect(messages.some(message =>
      message.role === 'system' &&
      message.text.includes('后台 Routine 在窗口关闭期间产生的结果。')
    )).toBe(false);

    await electron.close();
    await expect.poll(() => processExists(runtimePid)).toBe(false);
});
