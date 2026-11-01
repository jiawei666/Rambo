import { createElectronTest, expect } from './fixtures/electron-app.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const test = createElectronTest('playwright-voice-wake');

function readWakePcm() {
  const wav = readFileSync(join(
    process.cwd(),
    'tests/fixtures/voice-wake/rambo.wav'
  ));
  const samples = [];
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    samples.push(wav.readInt16LE(offset) / 32_768);
  }
  return samples;
}

test('fixed Rambo wake opens the configured Bot and starts the existing Live path', async ({
  electron
}) => {
  test.setTimeout(60_000);
  const app = electron.app;
  let { page } = electron;
  const pcm = readWakePcm();
  const created = await page.evaluate(async () => {
    const first = await window.rambo.createBot({ name: 'Wake Target A', avatar: 'a' });
    const second = await window.rambo.createBot({ name: 'Current Page B', avatar: 'b' });
    return [first.bot, second.bot];
  });

  await expect.poll(() => page.evaluate(() =>
    window.rambo.snapshot().then(snapshot => snapshot.bots.map(bot => bot.name))
  )).toEqual(expect.arrayContaining(['Wake Target A', 'Current Page B']));

  await page.getByRole('button', { name: /Current Page B/ }).first().click();
  await expect(page.locator('.current-bot-name')).toHaveText('Current Page B');

  await page.evaluate(phrase => {
    window.__wakePhrase = phrase;
    window.__wakeMicRequests = 0;
    window.__voiceCuePlays = [];
    HTMLMediaElement.prototype.play = function play() {
      window.__voiceCuePlays.push({
        source: new URL(this.src).pathname.split('/').at(-1),
        muted: this.muted
      });
      setTimeout(() => this.dispatchEvent(new Event('ended')), 0);
      return Promise.resolve();
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const request = window.__wakeMicRequests += 1;
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      if (request === 1) {
        const phrase = window.__wakePhrase;
        const samples = new Float32Array(phrase.length + 12_800);
        samples.set(phrase);
        const buffer = context.createBuffer(1, samples.length, 16_000);
        buffer.copyToChannel(samples, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(destination);
        source.start();
      } else {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 220;
        oscillator.connect(destination);
        oscillator.start();
      }
      return destination.stream;
    };
  }, pcm);

  await page.getByRole('button', { name: '打开 Current Page B 设置' }).click();
  await page.getByRole('button', { name: '设为唤醒目标', exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    window.rambo.snapshot().then(snapshot => ({
      enabled: snapshot.settings.voiceWakeEnabled,
      botId: snapshot.settings.voiceWakeBotId
    }))
  )).toEqual({ enabled: 'false', botId: created[1].id });

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '语音与唤醒', exact: true }).click();
  await expect(page.getByText('固定使用“Rambo”；如果英文发音不顺口，也可以说“兰博”“软博”或“然博”', { exact: false }))
    .toBeVisible();
  await page.getByLabel('唤醒后接听的 Bot').selectOption(created[0].id);
  await page.getByRole('checkbox', { name: '后台等待唤醒' }).check();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.hide();
  });
  await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.isVisible()
  )).toBe(false);
  await expect(page.getByRole('checkbox', { name: '后台等待唤醒' })).toBeChecked();
  await expect(page.locator('.voice-wake-status')).toContainText('正在监听', {
    timeout: 10_000
  });

  await expect(page.locator('.current-bot-name')).toHaveText('Wake Target A', {
    timeout: 8_000
  });
  await expect.poll(() => page.evaluate(() => window.__wakeMicRequests), {
    message: '唤醒命中后没有进入现有 Live 的麦克风启动路径'
  }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.isVisible()
  )).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__voiceCuePlays
    .filter(play => !play.muted)
    .map(play => play.source)))
    .toContain('wake.mp3');
  const verified = await page.evaluate(async () => {
    const snapshot = await window.rambo.snapshot();
    const target = snapshot.bots.find(bot => bot.name === 'Wake Target A');
    const chat = snapshot.chats.find(item => item.botId === target?.id && !item.groupChatId);
    return {
      settings: {
        enabled: snapshot.settings.voiceWakeEnabled,
        botId: snapshot.settings.voiceWakeBotId
      },
      targetId: target?.id ?? null,
      targetChatId: chat?.id ?? null,
      selectedPill: document.querySelector('.current-bot-name')?.textContent
    };
  });
  expect(verified).toMatchObject({
    settings: { enabled: 'true', botId: created[0].id },
    targetId: created[0].id,
    selectedPill: 'Wake Target A'
  });
  expect(verified.targetChatId).toBeTruthy();

  page = await electron.restart();
  await expect.poll(() => page.evaluate(() => window.rambo.snapshot())
    .then(snapshot => ({
      enabled: snapshot.settings.voiceWakeEnabled,
      botId: snapshot.settings.voiceWakeBotId
    }))).toEqual({ enabled: 'true', botId: created[0].id });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '语音与唤醒', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '后台等待唤醒' })).toBeChecked();
  await expect(page.getByLabel('唤醒后接听的 Bot')).toHaveValue(created[0].id);

  await page.getByRole('checkbox', { name: '后台等待唤醒' }).click();
  await expect.poll(() => page.evaluate(() =>
    window.rambo.snapshot().then(snapshot => ({
      enabled: snapshot.settings.voiceWakeEnabled,
      botId: snapshot.settings.voiceWakeBotId
    }))
  )).toEqual({ enabled: 'false', botId: created[0].id });

  await page.getByRole('button', { name: /Current Page B/ }).first().click();
  await expect(page.locator('.current-bot-name')).toHaveText('Current Page B');
  await page.evaluate(samples => {
    window.rambo.sendVoiceWakeAudio(new Float32Array(samples));
  }, pcm);
  await page.waitForTimeout(600);
  await expect(page.locator('.current-bot-name')).toHaveText('Current Page B');

  await page.evaluate(botId => window.rambo.setBotArchived(botId, true), created[0].id);
  await expect.poll(() => page.evaluate(() =>
    window.rambo.snapshot().then(snapshot => ({
      enabled: snapshot.settings.voiceWakeEnabled,
      botId: snapshot.settings.voiceWakeBotId
    }))
  )).toEqual({ enabled: 'false', botId: '' });
});
