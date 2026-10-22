import { test, expect, _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

test('真实 Electron 群聊与单聊共用入口样式并使用组合头像', async () => {
  const runs = join(root, 'acceptance-runs');
  mkdirSync(runs, { recursive: true });
  const run = realpathSync(mkdtempSync(join(runs, 'playwright-group-')));
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
    await expect(page).toHaveTitle('Rambo');

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
    await expect(page.getByRole('textbox', { name: '群聊消息输入框' })).toBeVisible();
    await expect(page.getByRole('img', { name: '群聊成员头像：Group Alpha、Group Beta' }).first()).toBeVisible();
    await expect(page.getByText('开始群聊', { exact: true })).toBeVisible();
    await expect(page.getByLabel('会话列表').getByText('Group E2E')).toBeVisible();
    await expect(page.getByText('聊天', { exact: true })).toHaveCount(0);
    await expect(page.getByText('分组', { exact: true })).toHaveCount(0);

    const after = await page.evaluate(() => window.rambo.snapshot());
    const createdGroup = after.groups.find(item => item.title === 'Group E2E');
    expect(createdGroup?.memberIds.sort()).toEqual(ids.slice().sort());
    expect(after.chats.filter(chat => !chat.groupChatId && !chat.archived)).toHaveLength(2);

    await app.close();
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const reopenedPage = await app.firstWindow();
    const groupEntry = reopenedPage.getByLabel('会话列表').getByRole('button', {
      name: /群聊成员头像：Group Alpha、Group Beta/
    });
    await expect(groupEntry).toBeVisible();
    const reopened = await reopenedPage.evaluate(() => window.rambo.snapshot());
    expect(reopened.groups.find(item => item.id === createdGroup?.id)?.memberIds.sort()).toEqual(ids.slice().sort());
    expect(reopened.chats.filter(chat => !chat.groupChatId && !chat.archived)).toHaveLength(2);

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
    await expect(reopenedPage.getByLabel('群聊消息').getByText('开始群聊', { exact: true }))
      .toBeVisible();
    let added = await reopenedPage.evaluate(() => window.rambo.snapshot());
    const expandedGroup = added.groups.find(item => item.id === createdGroup?.id);
    expect(expandedGroup?.memberIds).toHaveLength(3);
    expect(expandedGroup?.memberIds.slice(0, 2)).toEqual(ids);
    expect(added.chats.filter(chat => !chat.groupChatId && !chat.archived)).toHaveLength(3);
    expect(added.chats.filter(chat => chat.groupChatId === createdGroup?.id)).toHaveLength(0);

    await app.close();
    app = await electron.launch({
      executablePath: resolve(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env
    });
    const expandedPage = await app.firstWindow();
    await expect(expandedPage.getByRole('img', {
      name: '群聊成员头像：Group Alpha、Group Beta、Group Gamma'
    }).first()).toBeVisible();
    added = await expandedPage.evaluate(() => window.rambo.snapshot());
    expect(added.groups.find(item => item.id === createdGroup?.id)?.memberIds)
      .toEqual(expandedGroup?.memberIds);
  } finally {
    await app?.close();
    rmSync(run, { recursive: true, force: true });
  }
});
