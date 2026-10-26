import { join } from 'node:path';
import { test, expect } from '@playwright/test';

test('真实 Web Audio 分析链路区分静音、语音和停说回落', async ({ page }) => {
  await page.goto('about:blank');
  const result = await page.evaluate(async () => {
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    gain.gain.value = 0;
    oscillator.frequency.value = 660;
    oscillator.connect(gain);
    gain.connect(analyser);
    oscillator.start();
    await audioContext.resume();

    const samples = new Float32Array(analyser.frequencyBinCount);
    const read = () => {
      analyser.getFloatFrequencyData(samples);
      const speech = samples.some((value, index) => index > 0 && value >= -50);
      return { speech, peak: Math.max(...samples) };
    };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    const sampleUntil = async (predicate, timeout = 2_000) => {
      const samples = [];
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeout) {
        const sample = read();
        samples.push(sample);
        if (predicate(sample, samples)) return samples;
        await wait(16);
      }
      return samples;
    };

    const idleSamples = await sampleUntil(sample => !sample.speech, 500);
    const idle = idleSamples.at(-1);
    gain.gain.setTargetAtTime(0.7, audioContext.currentTime, 0.01);
    const activeSamples = await sampleUntil(sample => sample.speech, 2_000);
    const active = activeSamples.at(-1);
    const activeAfterSettleSamples = await sampleUntil((sample, samples) => {
      if (samples.length < 30) return false;
      const recent = samples.slice(-16);
      return Math.max(...recent.map(item => item.peak)) -
        Math.min(...recent.map(item => item.peak)) < 0.8;
    }, 800);
    const activeAfterSettle = activeAfterSettleSamples.at(-1);
    gain.gain.setTargetAtTime(0, audioContext.currentTime, 0.01);
    const stoppedAt = performance.now();
    const restingSamples = [];
    let restingAt = null;
    while (performance.now() - stoppedAt < 700) {
      const sample = read();
      restingSamples.push(sample);
      if (restingAt === null && !sample.speech) restingAt = performance.now() - stoppedAt;
      await wait(16);
    }
    const resting = restingSamples.at(-1);
    const releaseMs = restingAt;
    oscillator.stop();
    await audioContext.close();
    return { idle, active, activeAfterSettle, resting, releaseMs };
  });
  expect(result.idle.speech).toBe(false);
  expect(result.active.speech).toBe(true);
  expect(result.active.peak).toBeGreaterThan(result.idle.peak + 20);
  expect(result.activeAfterSettle.peak).toBeGreaterThan(result.idle.peak + 20);
  expect(result.resting.speech).toBe(false);
  expect(result.activeAfterSettle.peak - result.resting.peak).toBeGreaterThan(16);
  expect(result.releaseMs).toBeLessThan(500);
});

test('Hark 上游 VAD 忽略低频轰鸣并按历史窗口结束语音', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ path: join(process.cwd(), 'node_modules/hark/hark.bundle.js') });
  const result = await page.evaluate(async () => {
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.frequency.value = 50;
    gain.gain.value = 0.5;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    await audioContext.resume();

    const harker = window.hark(destination.stream, {
      audioContext,
      interval: 32,
      history: 4,
      threshold: -50
    });
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitForSpeech = async (expected, timeout = 1_500) => {
      const startedAt = performance.now();
      while (performance.now() - startedAt < timeout) {
        if (harker.speaking === expected) return performance.now() - startedAt;
        await wait(8);
      }
      return null;
    };

    const lowFrequencyStarted = await waitForSpeech(true, 450);
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    const speechStarted = await waitForSpeech(true);
    gain.gain.setTargetAtTime(0, audioContext.currentTime, 0.01);
    const stoppedAfterMs = await waitForSpeech(false);
    harker.stop();
    oscillator.stop();
    await audioContext.close();
    return { lowFrequencyStarted, speechStarted, stoppedAfterMs };
  });
  expect(result.lowFrequencyStarted).toBeNull();
  expect(result.speechStarted).not.toBeNull();
  expect(result.stoppedAfterMs).not.toBeNull();
  expect(result.stoppedAfterMs).toBeLessThan(350);
});
