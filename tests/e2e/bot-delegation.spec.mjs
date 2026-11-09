import { createElectronTest, expect } from './fixtures/electron-app.mjs';
const test = createElectronTest('playwright-bot-delegation');

test('Bot delegation source badge persists in worker ordinary chat after restart', async ({ electron }, testInfo) => {
  let page = electron.page;
  for (const name of ['Delegation Manager', 'Delegation Worker']) {
    await page.getByLabel('创建 Bot').click();
    await page.getByLabel('Bot 名称').fill(name);
    await page.getByRole('dialog', { name: '创建新 Bot' }).getByRole('button', { name: '创建', exact: true }).click();
  }
  await expect.poll(async () => page.evaluate(async () => {
    const state = await window.rambo.snapshot();
    return state.chats.filter(chat => chat.threadId).length;
  })).toBeGreaterThanOrEqual(2);
  const state = await page.evaluate(() => window.rambo.snapshot());
  const manager = state.bots.find(bot => bot.name === 'Delegation Manager');
  const worker = state.bots.find(bot => bot.name === 'Delegation Worker');
  const managerChat = state.chats.find(chat => chat.botId === manager.id);
  const workerChat = state.chats.find(chat => chat.botId === worker.id);
  await expect.poll(async () => page.evaluate(async () => {
    const s = await window.rambo.snapshot();
    return Object.keys(s.activeTurns).length;
  })).toBeGreaterThanOrEqual(1);
  await page.evaluate(async () => {
    const s = await window.rambo.snapshot();
    for (const [chatId, turnId] of Object.entries(s.activeTurns)) {
      await window.rambo.injectAcceptanceEvent({ type: 'acceptanceNotification', method: 'turn/completed',
        params: { threadId: s.chats.find(c => c.id === chatId).threadId, turn: { id: turnId, status: 'completed' } } });
    }
  });
  const result = await page.evaluate(({ managerChat, worker }) => window.rambo.injectAcceptanceEvent({
    type: 'acceptanceTool', method: 'item/tool/call', params: {
      threadId: managerChat.threadId, callId: 'delegation-ui-1', namespace: 'rambo_bot', tool: 'send_message',
      arguments: { botId: worker.id, text: '我们先讨论一下，需要准备哪些材料？' }
    }
  }), { managerChat, worker });
  expect(result.result.success, result.result.contentItems?.[0]?.text).toBe(true);
  await expect(page.locator('.message-delegation-source').filter({ hasText: '来自 Delegation Manager Bot' })).toBeVisible();
  await expect(page.locator('.message-delegation .message-text')).toContainText('我们先讨论一下');
  await expect.poll(async () => page.evaluate(async id => (await window.rambo.snapshot()).activeTurns[id], workerChat.id)).toBeTruthy();
  const before = await page.evaluate(async id => {
    const s = await window.rambo.snapshot();
    return { threadId: s.chats.find(c => c.id === id).threadId, turnId: s.activeTurns[id] };
  }, workerChat.id);
  expect(before.threadId).toBe(workerChat.threadId);
  await page.evaluate(async ({ threadId, turnId }) => {
    await window.rambo.injectAcceptanceEvent({ type: 'acceptanceNotification', method: 'item/completed', params: {
      threadId, turnId, item: { id: 'worker-ui-report', type: 'agentMessage', text: '建议先确认材料用途和受众。', phase: 'final_answer' }
    } });
    await window.rambo.injectAcceptanceEvent({ type: 'acceptanceNotification', method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed' } } });
  }, before);
  await expect(page.locator('.message-assistant').filter({ hasText: '建议先确认材料用途和受众。' })).toBeVisible();
  await expect(page.locator('.message-delegation.message-entering')).toHaveCount(0);
  await testInfo.attach('delegation-source-badge', { body: await page.screenshot(), contentType: 'image/png' });
  page = await electron.restart();
  await page.getByRole('button', { name: /Delegation Worker/ }).first().click();
  await expect(page.locator('.message-delegation-source').filter({ hasText: '来自 Delegation Manager Bot' })).toBeVisible();
  await expect(page.locator('.message-assistant').filter({ hasText: '建议先确认材料用途和受众。' })).toBeVisible();
});
