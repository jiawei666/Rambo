import { createElectronTest, expect } from './fixtures/electron-app.mjs';

const test = createElectronTest('playwright-group');

test.describe.configure({ mode: 'serial' });

test('真实 Electron 群聊与单聊共用入口样式并使用组合头像', async ({ electron }) => {
    const page = electron.page;

    for (const name of ['Group Alpha', 'Group Beta']) {
      await page.getByLabel('创建 Bot').click();
      const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
      await page.getByLabel('Bot 名称').fill(name);
      await dialog.getByRole('button', { name: '创建', exact: true }).click();
      await expect(page.getByRole('button', { name: new RegExp(name) }).first()).toBeVisible();
    }
    const before = await page.evaluate(() => window.rambo.snapshot());
    const ids = before.bots.map(bot => bot.id);
    await page.getByRole('button', { name: /Group Alpha/ }).first().click();
    await page.getByRole('button', { name: /新建群聊/ }).click();
    await expect(page.getByRole('heading', { name: '创建群聊' })).toBeVisible();
    await page.getByLabel('群聊名称').fill('Group E2E');
    for (const name of ['Group Alpha', 'Group Beta']) {
      await page.getByRole('checkbox', { name: new RegExp(name) }).check();
    }
    await page.waitForTimeout(250);
    const memberCheckboxStyle = await page.getByRole('checkbox', { name: /Group Alpha/ })
      .evaluate(element => {
        const style = getComputedStyle(element);
        const checkStyle = getComputedStyle(element, '::after');
        return {
          width: style.width,
          height: style.height,
          borderRadius: style.borderRadius,
          background: style.backgroundColor,
          checkOpacity: checkStyle.opacity
        };
      });
    expect(memberCheckboxStyle.width).toBe('16px');
    expect(memberCheckboxStyle.height).toBe('16px');
    expect(memberCheckboxStyle.borderRadius).toBe('5px');
    expect(memberCheckboxStyle.background).not.toMatch(/rgba?\([^)]*,\s*0\)/u);
    expect(memberCheckboxStyle.checkOpacity).toBe('1');
    await page.getByRole('button', { name: '创建群聊', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '群聊消息输入框' })).toBeVisible();
    await expect(page.getByRole('img', { name: '群聊成员头像：Group Alpha、Group Beta' }).first()).toBeVisible();
    await expect(page.getByText('开始群聊', { exact: true })).toBeVisible();
    await expect(page.getByLabel('会话列表').getByText('Group E2E')).toBeVisible();
    const afterCreate = await page.evaluate(() => window.rambo.snapshot());
    const createdGroup = afterCreate.groups.find(item => item.title === 'Group E2E');
    expect(createdGroup?.memberIds.sort()).toEqual(ids.slice().sort());
    const createdMemberChats = await page.evaluate(
      groupId => window.rambo.groupMemberChats(groupId), createdGroup.id
    );
    const memberChat = createdMemberChats[0];
    expect(memberChat).toBeTruthy();
    expect(await page.evaluate(() => typeof window.rambo.updateChat)).toBe('undefined');
    const afterRejectedUpdate = await page.evaluate(
      groupId => window.rambo.groupMemberChats(groupId), createdGroup.id
    );
    expect(afterRejectedUpdate.find(item => item.id === memberChat.id))
      .toMatchObject({ model: null, permission: null });
    const groupComposer = page.getByRole('combobox', { name: '群聊消息输入框' });
    await groupComposer.fill('@');
    const mentionMenu = page.getByRole('listbox', { name: '选择要提及的群聊成员' });
    await expect(mentionMenu).toBeVisible();
    await expect(mentionMenu.getByRole('option', { name: /@Group Alpha/ })).toBeVisible();
    await expect(mentionMenu.getByRole('option', { name: /@Group Beta/ })).toBeVisible();
    await expect(mentionMenu.getByRole('option', { name: /@everyone/ })).toBeVisible();
    const menuBox = await mentionMenu.boundingBox();
    const composerBox = await page.locator('.composer').boundingBox();
    if (!menuBox || !composerBox) throw new Error('找不到群聊输入框或 @ 候选菜单');
    expect(menuBox.width).toBeLessThan(composerBox.width * 0.55);
    const initiallySelected = await mentionMenu.getByRole('option')
      .evaluateAll(options => options.findIndex(option => option.getAttribute('aria-selected') === 'true'));
    expect(initiallySelected).toBeGreaterThanOrEqual(0);
    await groupComposer.press('ArrowDown');
    const nextSelected = await mentionMenu.getByRole('option')
      .evaluateAll(options => options.findIndex(option => option.getAttribute('aria-selected') === 'true'));
    expect(nextSelected).not.toBe(initiallySelected);
    await groupComposer.press('Enter');
    await expect(groupComposer).toHaveValue(/^@(?:Group Alpha|Group Beta|everyone) $/);
    await groupComposer.fill('@');
    await expect(mentionMenu).toBeVisible();
    await groupComposer.press('Escape');
    await expect(mentionMenu).toHaveCount(0);
    await expect(groupComposer).toHaveValue('@');
    await groupComposer.fill('@G');
    await groupComposer.press('Backspace');
    await expect(mentionMenu).toBeVisible();
    await mentionMenu.getByRole('option', { name: /@Group Alpha/ }).click();
    await expect(groupComposer).toHaveValue('@Group Alpha ');
    await groupComposer.pressSequentially('群聊作者名检查');
    await page.evaluate(() => {
      window.__ramboGroupMessageAnimations = [];
      document.addEventListener('animationstart', event => {
        if (event.animationName === 'message-enter') {
          window.__ramboGroupMessageAnimations.push({
            target: event.target?.className ?? '',
            row: event.target?.closest?.('.message-row')?.className ?? ''
          });
        }
      });
    });
    await groupComposer.press('Enter');
    await expect(groupComposer).toHaveValue('');
    await expect(page.locator('.composer-flight-message')).toHaveCount(0);
    await expect(page.locator('.message-text').filter({ hasText: '@Group Alpha 群聊作者名检查' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__ramboGroupMessageAnimations.length)).toBeGreaterThan(0);
    await expect.poll(async () => {
      const memberChats = await page.evaluate(
        groupId => window.rambo.groupMemberChats(groupId), createdGroup.id
      );
      const alpha = afterCreate.bots.find(bot => bot.name === 'Group Alpha');
      return memberChats.find(chat => chat.botId === alpha.id)?.threadId ?? null;
    }).toBeTruthy();
    const memberChats = await page.evaluate(
      groupId => window.rambo.groupMemberChats(groupId), createdGroup.id
    );
    const alpha = afterCreate.bots.find(bot => bot.name === 'Group Alpha');
    const alphaChat = memberChats.find(chat => chat.botId === alpha.id);
    await page.evaluate(({ threadId }) => window.rambo.injectAcceptanceEvent({
      type: 'acceptanceNotification',
      method: 'item/completed',
      params: {
        threadId,
        turnId: null,
        item: {
          id: 'group-alpha-author-check',
          type: 'agentMessage',
          text: '这是 Group Alpha 的确定性验收回复。',
          phase: 'final_answer'
        }
      }
    }), { threadId: alphaChat.threadId });
    const assistantMessage = page.locator('.message-assistant').last();
    await expect(assistantMessage.locator('.message-author')).toHaveText('Group Alpha', {
      timeout: 20_000
    });
    await expect.poll(() => page.evaluate(() => window.__ramboGroupMessageAnimations
      .some(animation => animation.row.includes('message-assistant')))).toBe(true);
    const groupAssistantAnimation = await page.evaluate(() => window.__ramboGroupMessageAnimations
      .find(animation => animation.row.includes('message-assistant')));
    expect(groupAssistantAnimation.target).toContain('message-content');
    await expect(assistantMessage).not.toHaveClass(/message-entering/, { timeout: 1500 });
    await expect(assistantMessage.locator('.message-avatar .bot-avatar')).toBeVisible();
    await expect(assistantMessage.locator('.message-avatar')).toHaveCount(1);
    await expect(page.getByText('聊天', { exact: true })).toHaveCount(0);
    await expect(page.getByText('分组', { exact: true })).toHaveCount(0);

    const after = await page.evaluate(() => window.rambo.snapshot());
    expect(after.chats.filter(chat =>
      ids.includes(chat.botId) && !chat.groupChatId && !chat.archived
    )).toHaveLength(2);
});

test('真实 Electron 群聊成员阶段覆盖同一气泡并在新用户消息后迁移', async ({ electron }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Stage Alpha');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Stage Beta');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();

  const snapshot = await page.evaluate(() => window.rambo.snapshot());
  const bots = snapshot.bots.filter(bot => ['Stage Alpha', 'Stage Beta'].includes(bot.name));
  const alpha = bots.find(bot => bot.name === 'Stage Alpha');
  const group = await page.evaluate(ids =>
    window.rambo.createGroup({ title: 'Group Stage E2E', botIds: ids }), bots.map(bot => bot.id));
  await page.getByLabel('会话列表').getByRole('button', { name: /Group Stage E2E/ }).click();

  const memberChats = await page.evaluate(groupId =>
    window.rambo.groupMemberChats(groupId), group.id);
  const alphaChat = memberChats.find(chat => chat.botId === alpha.id);
  const stageOne = {
    id: 'group-stage-commentary',
    groupId: group.id,
    role: 'assistant',
    senderBotId: alpha.id,
    senderName: alpha.name,
    text: '正在核对文档差异',
    status: 'streaming',
    itemId: 'group-stage-commentary',
    createdAt: new Date().toISOString(),
    turnId: 'group-stage-turn',
    phase: 'commentary'
  };
  await page.evaluate(({ groupId, memberChats }) => {
    const runtime = {
      groupId,
      runId: 'group-stage-runtime',
      members: memberChats.map(chat => ({
        botId: chat.botId,
        chatId: chat.id,
        phase: 'working',
        enteredAt: new Date().toISOString(),
        activityKind: 'other',
        activityUpdatedAt: new Date().toISOString()
      }))
    };
    return window.rambo.injectAcceptanceEvent({ type: 'groupRuntime', groupId, runtime });
  }, { groupId: group.id, memberChats });
  await page.evaluate(message =>
    window.rambo.injectAcceptanceEvent({ type: 'groupMessage', groupId: message.groupId, message }),
  stageOne);

  const assistantBubble = page.locator('.message-assistant');
  const runningLabel = page.locator('.agent-running-shimmer');
  await expect(assistantBubble).toHaveCount(1);
  await expect(assistantBubble).toContainText('正在核对文档差异');
  await expect(assistantBubble.locator('.message-author')).toHaveText('Stage Alpha');
  await expect(runningLabel).not.toContainText('正在核对文档差异');
  await page.evaluate(message =>
    window.rambo.injectAcceptanceEvent({ type: 'groupMessage', groupId: message.groupId, message }),
  {
    ...stageOne,
    text: '差异集中在文档开头。',
    phase: 'partial_answer',
    createdAt: new Date(Date.now() + 100).toISOString()
  });
  await expect(assistantBubble).toContainText('差异集中在文档开头。');

  await page.evaluate(({ groupId, chatId, botId }) => window.rambo.injectAcceptanceEvent({
    type: 'groupRuntime',
    groupId,
    runtime: {
      groupId,
      runId: 'group-stage-runtime',
      members: [{
        botId,
        chatId,
        phase: 'working',
        enteredAt: new Date().toISOString(),
        activityKind: 'web',
        activityUpdatedAt: new Date(Date.now() + 2_000).toISOString()
      }]
    }
  }), { groupId: group.id, chatId: alphaChat.id, botId: alpha.id });
  await expect(runningLabel).toHaveText('正在搜索网页');
  await expect(runningLabel).not.toContainText('正在核对文档差异');
  await expect(assistantBubble).toContainText('差异集中在文档开头。');

  const secondText = '@Stage Alpha 再看一下最新消息。';
  await page.evaluate(({ groupId, text }) => {
    window.rambo.injectAcceptanceEvent({
      type: 'groupMessage',
      groupId,
      message: {
        id: 'group-stage-second-user',
        groupId,
        role: 'user',
        senderBotId: null,
        senderName: null,
        text,
        status: 'complete',
        itemId: null,
        createdAt: new Date().toISOString(),
        turnId: null,
        phase: null
      }
    });
  }, { groupId: group.id, text: secondText });
  await expect(page.locator('.message-user').last())
    .toContainText(secondText);
  await page.evaluate(({ groupId }) => window.rambo.injectAcceptanceEvent({
    type: 'groupMessageRemoved',
    groupId,
    messageId: 'group-stage-commentary'
  }), { groupId: group.id });
  await page.evaluate(message =>
    window.rambo.injectAcceptanceEvent({ type: 'groupMessage', groupId: message.groupId, message }),
  {
    ...stageOne,
    id: 'group-stage-partial-next',
    text: '已经看到最新消息。',
    phase: 'partial_answer',
    createdAt: new Date(Date.now() + 1000).toISOString()
  });
  await expect(page.locator('.message-assistant')).toHaveCount(1);
  await expect(page.locator('.message-assistant')).toContainText('已经看到最新消息。');
  const groupPositions = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.message-row[data-message-id]')];
    const userIndex = rows.findLastIndex(row =>
      row.classList.contains('message-user') &&
      row.textContent?.includes('@Stage Alpha 再看一下最新消息。')
    );
    const assistantIndex = rows.findLastIndex(row => row.classList.contains('message-assistant'));
    return { userIndex, assistantIndex };
  });
  expect(groupPositions.assistantIndex).toBeGreaterThan(groupPositions.userIndex);
  await expect.poll(() => page.evaluate(() => {
    const transcript = document.querySelector('.transcript-scroll');
    if (!transcript) return Number.POSITIVE_INFINITY;
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  })).toBeLessThanOrEqual(1);

  await page.evaluate(({ groupId }) => window.rambo.injectAcceptanceEvent({
    type: 'groupRuntime', groupId, runtime: null
  }), { groupId: group.id });
  await expect(page.locator('.agent-running-row')).toHaveClass(/agent-running-row-hidden/);
  await expect(page.locator('.agent-running-row')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.message-assistant')).toHaveCount(1);
  await expect(page.locator('.message-assistant')).toContainText('已经看到最新消息。');
});

test('真实 Electron 群聊上翻后阶段迁移不强制拉回底部', async ({ electron }) => {
  const page = electron.page;
  for (const name of ['Scroll Alpha', 'Scroll Beta']) {
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill(name);
    await page.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
  }
  const snapshot = await page.evaluate(() => window.rambo.snapshot());
  const bots = snapshot.bots.filter(bot => ['Scroll Alpha', 'Scroll Beta'].includes(bot.name));
  const group = await page.evaluate(ids =>
    window.rambo.createGroup({ title: 'Group Scroll E2E', botIds: ids }), bots.map(bot => bot.id));
  await page.getByLabel('会话列表').getByRole('button', { name: /Group Scroll E2E/ }).click();
  const groupComposer = page.getByRole('combobox', { name: '群聊消息输入框' });
  const memberChats = await page.evaluate(groupId =>
    window.rambo.groupMemberChats(groupId), group.id);
  const alphaChat = memberChats.find(chat => chat.botId === bots[0].id);
  const scrollBase = Date.now();
  const scrollStage = {
    id: 'group-scroll-old-stage',
    groupId: group.id,
    role: 'assistant',
    senderBotId: bots[0].id,
    senderName: bots[0].name,
    text: '迁移前的阶段内容。',
    status: 'streaming',
    itemId: 'group-scroll-old-stage',
    createdAt: new Date(scrollBase + 100).toISOString(),
    turnId: 'group-scroll-turn',
    phase: 'commentary'
  };
  await page.evaluate(async ({ groupId, bots, scrollBase }) => {
    for (let index = 0; index < 18; index += 1) {
      await window.rambo.injectAcceptanceEvent({
        type: 'groupMessage',
        groupId,
        message: {
          id: `group-scroll-history-${index + 1}`,
          groupId,
          role: 'assistant',
          senderBotId: bots[0].id,
          senderName: bots[0].name,
          text: `历史消息 ${index + 1} ${'内容'.repeat(16)}`,
          status: 'complete',
          itemId: `group-scroll-history-${index + 1}`,
          turnId: `group-scroll-history-turn-${index + 1}`,
          phase: 'final_answer',
          createdAt: new Date(scrollBase + index).toISOString()
        }
      });
    }
  }, { groupId: group.id, bots, scrollBase });
  await page.evaluate(message =>
    window.rambo.injectAcceptanceEvent({ type: 'groupMessage', groupId: message.groupId, message }),
  scrollStage);
  await page.evaluate(({ groupId, text, createdAt }) => {
    window.rambo.injectAcceptanceEvent({
      type: 'groupMessage',
      groupId,
      message: {
        id: 'group-scroll-new-user',
        groupId,
        role: 'user',
        senderBotId: null,
        senderName: null,
        text,
        status: 'complete',
        itemId: null,
        createdAt,
        turnId: null,
        phase: null
      }
    });
  }, {
    groupId: group.id,
    text: '@Scroll Alpha 新的用户消息。',
    createdAt: new Date(scrollBase + 200).toISOString()
  });
  await expect(page.locator('.message-user').last()).toContainText('@Scroll Alpha 新的用户消息。');
  const transcript = page.locator('.transcript-scroll');
  await expect.poll(() => transcript.evaluate(element =>
    element.scrollHeight > element.clientHeight + 180
  )).toBe(true);
  const oldStage = page.locator('.message-assistant')
    .filter({ hasText: '迁移前的阶段内容。' });
  await expect(oldStage).toContainText('迁移前的阶段内容。');
  await page.evaluate(({ groupId, text, createdAt }) => {
    window.rambo.injectAcceptanceEvent({
      type: 'groupMessage',
      groupId,
      message: {
        id: 'group-scroll-second-user',
        groupId,
        role: 'user',
        senderBotId: null,
        senderName: null,
        text,
        status: 'complete',
        itemId: null,
        createdAt,
        turnId: null,
        phase: null
      }
    });
  }, {
    groupId: group.id,
    text: '@Scroll Alpha 检查上翻后的阶段迁移。',
    createdAt: new Date(scrollBase + 300).toISOString()
  });
  await expect(page.locator('.message-user').last())
    .toContainText('@Scroll Alpha 检查上翻后的阶段迁移。');
  await transcript.evaluate(element => {
    element.scrollTop = Math.max(0, Math.round((element.scrollHeight - element.clientHeight) / 3));
  });
  const before = await transcript.evaluate(element => element.scrollTop);
  expect(before).toBeGreaterThan(40);
  await page.evaluate(({ groupId }) => window.rambo.injectAcceptanceEvent({
    type: 'groupMessageRemoved',
    groupId,
    messageId: 'group-scroll-old-stage'
  }), { groupId: group.id });
  await page.evaluate(message =>
    window.rambo.injectAcceptanceEvent({ type: 'groupMessage', groupId: message.groupId, message }),
  {
    ...scrollStage,
    id: 'group-scroll-new-stage',
    text: '上翻后迁移的新阶段内容。',
    phase: 'partial_answer',
    createdAt: new Date(scrollBase + 400).toISOString()
  });
  await expect(page.locator('.message-assistant')
    .filter({ hasText: '迁移前的阶段内容。' })).toHaveCount(0);
  await expect(page.locator('.message-assistant')
    .filter({ hasText: '上翻后迁移的新阶段内容。' })).toHaveCount(1);
  const positions = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.message-row[data-message-id]')];
    const userIndex = rows.findLastIndex(row =>
      row.classList.contains('message-user') &&
      row.textContent?.includes('@Scroll Alpha 检查上翻后的阶段迁移。')
    );
    const assistantIndex = rows.findIndex(row =>
      row.getAttribute('data-message-id') === 'group-scroll-new-stage'
    );
    return { userIndex, assistantIndex };
  });
  expect(positions.assistantIndex).toBeGreaterThan(positions.userIndex);
  const after = await transcript.evaluate(element => element.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
});

test('真实 Electron 群聊运行中在发送旁显示独立停止按钮', async ({ electron }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Stop Alpha');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();
  await page.getByLabel('创建 Bot').click();
  await page.getByLabel('Bot 名称').fill('Stop Beta');
  await page.getByRole('dialog', { name: '创建新 Bot' })
    .getByRole('button', { name: '创建', exact: true }).click();

  const snapshot = await page.evaluate(() => window.rambo.snapshot());
  const memberIds = snapshot.bots
    .filter(bot => ['Stop Alpha', 'Stop Beta'].includes(bot.name))
    .map(bot => bot.id);
  const group = await page.evaluate(ids =>
    window.rambo.createGroup({ title: 'Group Stop E2E', botIds: ids }), memberIds);
  await page.getByLabel('会话列表').getByRole('button', { name: /Group Stop E2E/ }).click();

  await expect(page.getByRole('button', { name: '停止任务' })).toHaveCount(0);
  const memberChats = await page.evaluate(groupId =>
    window.rambo.groupMemberChats(groupId), group.id);
  await page.evaluate(({ groupId, memberChats }) => {
    const runtime = {
      groupId,
      runId: 'group-stop-runtime',
      members: memberChats.map(chat => ({
        botId: chat.botId,
        chatId: chat.id,
        phase: 'working',
        enteredAt: new Date().toISOString(),
        activityKind: null,
        activityUpdatedAt: null
      }))
    };
    return window.rambo.injectAcceptanceEvent({ type: 'groupRuntime', groupId, runtime });
  }, { groupId: group.id, memberChats });

  await expect(page.getByRole('button', { name: '停止任务' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
  await page.getByRole('button', { name: '停止任务' }).click();
  await page.evaluate(groupId =>
    window.rambo.injectAcceptanceEvent({ type: 'groupRuntime', groupId, runtime: null }), group.id);
  await expect(page.getByRole('button', { name: '停止任务' })).toHaveCount(0);
});

test('真实 Electron 群聊重启后保留成员、历史并允许添加成员', async ({ electron }) => {
    const page = await electron.restart();
    const reopenedPage = page;
    const groupEntry = reopenedPage.getByLabel('会话列表').getByRole('button', {
      name: /群聊成员头像：Group Alpha、Group Beta/
    });
    await expect(groupEntry).toBeVisible();
    const reopened = await reopenedPage.evaluate(() => window.rambo.snapshot());
    const reopenedGroup = reopened.groups.find(item => item.title === 'Group E2E');
    expect(reopenedGroup?.memberIds.slice().sort()).toEqual(
      reopened.bots.filter(bot => ['Group Alpha', 'Group Beta'].includes(bot.name))
        .map(bot => bot.id).sort()
    );

    await reopenedPage.getByLabel('创建 Bot').click();
    await reopenedPage.getByLabel('Bot 名称').fill('Group Gamma');
    await reopenedPage.getByRole('dialog', { name: '创建新 Bot' })
      .getByRole('button', { name: '创建', exact: true }).click();
    await groupEntry.click();
    await reopenedPage.getByRole('button', { name: '群聊成员设置' }).click();
    await expect(reopenedPage.getByRole('heading', { name: '群聊成员' })).toBeVisible();
    const gamma = reopenedPage.getByRole('checkbox', { name: /Group Gamma/ });
    await gamma.check();
    await reopenedPage.getByRole('button', { name: '添加到群聊' }).click();
    await expect(reopenedPage.getByRole('img', {
      name: '群聊成员头像：Group Alpha、Group Beta、Group Gamma'
    }).first()).toBeVisible();
    await expect(reopenedPage.locator('.message-text').filter({ hasText: '@Group Alpha 群聊作者名检查' }))
      .toBeVisible();
    let added = await reopenedPage.evaluate(() => window.rambo.snapshot());
    const expandedGroup = added.groups.find(item => item.id === reopenedGroup?.id);
    expect(expandedGroup?.memberIds).toHaveLength(3);
    expect(expandedGroup?.memberIds.slice(0, 2)).toEqual(reopenedGroup?.memberIds);
    expect(added.chats.filter(chat =>
      expandedGroup?.memberIds.includes(chat.botId) && !chat.groupChatId && !chat.archived
    )).toHaveLength(3);
    expect(added.chats.filter(chat => chat.groupChatId === reopenedGroup?.id)).toHaveLength(0);

    const expandedPage = await electron.restart();
    await expect(expandedPage.getByRole('img', {
      name: '群聊成员头像：Group Alpha、Group Beta、Group Gamma'
    }).first()).toBeVisible();
    added = await expandedPage.evaluate(() => window.rambo.snapshot());
    expect(added.groups.find(item => item.id === reopenedGroup?.id)?.memberIds)
      .toEqual(expandedGroup?.memberIds);
});

test('真实 Electron Bot 通过 Tool 创建群聊后自动打开', async ({ electron }) => {
    const page = electron.page;
    for (const name of ['Tool Alpha', 'Tool Beta']) {
      await page.getByLabel('创建 Bot').click();
      await page.getByLabel('Bot 名称').fill(name);
      await page.getByRole('dialog', { name: '创建新 Bot' })
        .getByRole('button', { name: '创建', exact: true }).click();
    }
    let snapshot = await page.evaluate(() => window.rambo.snapshot());
    const alpha = snapshot.bots.find(bot => bot.name === 'Tool Alpha');
    const beta = snapshot.bots.find(bot => bot.name === 'Tool Beta');
    const chat = snapshot.chats.find(item => item.botId === alpha.id);
    expect(chat).toBeTruthy();
    await page.evaluate(chatId => window.rambo.send(chatId, '准备通过 Tool 创建群聊。'), chat.id);
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return Boolean(snapshot.chats.find(item => item.id === chat.id)?.threadId);
    }).toBe(true);
    const threadId = snapshot.chats.find(item => item.id === chat.id).threadId;
    const result = await page.evaluate(({ threadId, botIds }) =>
      window.rambo.injectAcceptanceEvent({
        type: 'acceptanceTool',
        method: 'item/tool/call',
        params: {
          threadId,
          turnId: 'bot-group-tool',
          callId: 'bot-group-tool-call',
          namespace: 'rambo_groups',
          tool: 'create_group',
          arguments: { title: 'Tool Created Room', botIds }
        }
      }), { threadId, botIds: [beta.id] });
    expect(result.result.success, result.result.contentItems?.[0]?.text).toBe(true);
    await expect.poll(async () => {
      snapshot = await page.evaluate(() => window.rambo.snapshot());
      return snapshot.groups.some(item => item.title === 'Tool Created Room');
    }).toBe(true);
    const group = snapshot.groups.find(item => item.title === 'Tool Created Room');
    expect(group.memberIds).toEqual([alpha.id, beta.id]);
    const groupEntry = page.getByLabel('会话列表').getByRole('button', {
      name: /群聊成员头像：Tool Alpha、Tool Beta/
    });
    await expect(groupEntry).toBeVisible();
    await expect(page.getByRole('img', {
      name: '群聊成员头像：Tool Alpha、Tool Beta'
    }).first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: '群聊消息输入框' })).toBeVisible();
    await expect(page.getByText('开始群聊', { exact: true })).toBeVisible();
    await expect(page.getByLabel('群聊成员权限覆盖')).toHaveCount(0);
    await expect(page.getByLabel('群聊成员模型覆盖')).toHaveCount(0);
});
