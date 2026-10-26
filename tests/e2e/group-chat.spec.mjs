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
