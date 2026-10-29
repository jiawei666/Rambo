import { createElectronTest, expect } from './fixtures/electron-app.mjs';

const test = createElectronTest('playwright-avatar-picker');

async function headFollowTransform(avatar) {
  return avatar.evaluate(root =>
    root.shadowRoot?.getElementById('headFollow')?.getAttribute('transform') ?? ''
  );
}

async function expectFollowsPointer(page, avatar, region) {
  const box = await region.boundingBox();
  if (!box) throw new Error('找不到头像跟随区域');
  await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 4 });
  await expect.poll(() => headFollowTransform(avatar), { timeout: 2_000 }).not.toBe('');
  const leftTransform = await headFollowTransform(avatar);
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 4 });
  await expect.poll(() => headFollowTransform(avatar), { timeout: 2_000 }).not.toBe(leftTransform);
  const rightTransform = await headFollowTransform(avatar);
  expect(leftTransform).not.toBe(rightTransform);
}

test('新建和修改 Bot 时头像直接使用当前眼型并跟随鼠标', async ({ electron }) => {
  const page = electron.page;
  await page.getByLabel('创建 Bot').click();
  const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
  const preview = dialog.locator('.avatar-preview agent-robot-avatar');

  await expect(preview).toHaveCount(1);
  const happyEye = dialog.locator('.avatar-eye-cell[aria-label="开心"]');
  await happyEye.click();
  await expect(happyEye).toHaveAttribute('aria-pressed', 'true');
  const eyeStyle = '开心';
  const eyeStates = { 待机: 'idle', 开心: 'happy', 难过: 'sad', 生气: 'angry', 困倦: 'sleepy', 闭眼: 'sleep', 惊讶: 'surprise' };
  await expect.poll(() => preview.evaluate(root => root._state)).toBe(eyeStates[eyeStyle]);
  await expectFollowsPointer(page, preview, dialog.locator('.avatar-preview-stage'));

  await page.evaluate(() => {
    const root = document.querySelector('.avatar-preview agent-robot-avatar');
    if (!root) throw new Error('找不到新建 Bot 预览头像');
    const states = [];
    Object.defineProperty(root, '_state', {
      configurable: true,
      get: () => states.at(-1) ?? 'idle',
      set: value => states.push(value)
    });
    window.__avatarPreviewStates = states;
  });

  await dialog.getByRole('button', { name: '绿色', exact: true }).click();

  await expect(dialog.getByRole('button', { name: '绿色', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => preview.evaluate(root => root._state)).toBe(eyeStates[eyeStyle]);
  const states = await page.evaluate(() => window.__avatarPreviewStates);
  expect(states[0]).toBe(eyeStates[eyeStyle]);
  expect(states).not.toContain('idle');

  await page.getByLabel('Bot 名称').fill('Avatar Motion Pilot');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('button', { name: '打开 Avatar Motion Pilot 设置' }).click();
  const settingsAvatar = page.locator('.bot-settings-page .settings-page-heading .avatar-large');
  const settingsPreview = page.locator('.settings-avatar-preview-stage .avatar-preview');
  await expect(settingsAvatar).toHaveAttribute('data-avatar-color', 'green');

  await page.getByRole('tab', { name: '基础资料' }).click();
  const settingsPicker = page.locator('.settings-avatar-picker');
  await settingsPicker.getByRole('button', { name: '开心', exact: true }).click();
  await settingsPicker.getByRole('button', { name: '紫色', exact: true }).click();
  await expect(settingsAvatar).toHaveAttribute('data-avatar-color', 'violet');
  await expect(settingsPreview).toHaveAttribute('data-avatar-color', 'violet');
  expect(await settingsPreview.evaluate(root =>
    root.querySelector('agent-robot-avatar')?._state
  )).toBe('happy');
  await expectFollowsPointer(
    page,
    settingsPreview.locator('agent-robot-avatar'),
    page.locator('.settings-avatar-preview-stage')
  );
});

test('暗色模式下黑色头像直接显示为白色并保留颜色标识', async ({ electron }) => {
  const page = electron.page;
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByLabel('创建 Bot').click();
  const dialog = page.getByRole('dialog', { name: '创建新 Bot' });
  const black = dialog.getByRole('button', { name: '黑色', exact: true });
  await black.click();
  await expect(black).toHaveAttribute('aria-pressed', 'true');
  expect(await black.locator('.avatar-color-swatch').evaluate(element =>
    getComputedStyle(element).backgroundColor
  )).toBe('rgb(255, 255, 255)');
  await expect(dialog.locator('.avatar-preview')).toHaveAttribute('data-avatar-color', 'black');
  const previewAppearance = await dialog.locator('.avatar-preview agent-robot-avatar').evaluate(element => ({
    ink: getComputedStyle(element).getPropertyValue('--avatar-ink-black').trim(),
    filter: getComputedStyle(element).filter,
    headFill: element.shadowRoot?.getElementById('head')?.getAttribute('fill') ?? ''
  }));
  expect(previewAppearance.ink).toBe('#000000');
  expect(previewAppearance.filter).toContain('invert(1)');
  expect(previewAppearance.headFill).toContain('--avatar-ink-black');
  const eyeCells = dialog.locator('.avatar-eye-cell');
  await expect(eyeCells).toHaveCount(7);
  for (const eyeCell of await eyeCells.all()) {
    expect(await eyeCell.locator('agent-robot-avatar').evaluate(element =>
      getComputedStyle(element).getPropertyValue('--avatar-ink-black').trim()
    )).toBe('#000000');
    expect(await eyeCell.locator('agent-robot-avatar').evaluate(element =>
      getComputedStyle(element).filter
    )).toContain('invert(1)');
  }
  await page.getByLabel('Bot 名称').fill('Dark Black Pilot');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('button', { name: '打开 Dark Black Pilot 设置' }).click();
  const settingsAvatar = page.locator('.bot-settings-page .settings-page-heading .avatar-large');
  await expect(settingsAvatar).toHaveAttribute('data-avatar-color', 'black');
  const settingsBlack = page.locator('.settings-avatar-picker')
    .getByRole('button', { name: '黑色', exact: true });
  await expect(settingsBlack).toHaveAttribute('aria-pressed', 'true');
  expect(await settingsBlack.locator('.avatar-color-swatch').evaluate(element =>
    getComputedStyle(element).backgroundColor
  )).toBe('rgb(255, 255, 255)');
});
