import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  centerVoiceFrequencyBands,
  createVoiceFrequencyBands,
  createVoiceWaveformSmoother,
  normalizeVoiceDb,
  voiceFrequencyBinRange
} from '../../src/renderer/voice-waveform-model.ts';

function frequenciesWithBands(bands) {
  return new Float32Array(bands);
}

test('LiveKit dB normalization preserves silence and boosts quiet speech', () => {
  assert.equal(normalizeVoiceDb(-Infinity), 0);
  assert.ok(normalizeVoiceDb(-100) < 0.01);
  assert.ok(normalizeVoiceDb(-50) > normalizeVoiceDb(-90));
  assert.ok(normalizeVoiceDb(-20) > normalizeVoiceDb(-50));
  assert.ok(normalizeVoiceDb(0) < 1);
  assert.equal(normalizeVoiceDb(0), normalizeVoiceDb(-10));
});

test('LiveKit multiband aggregation splits real dB bins equally', () => {
  const frequencies = frequenciesWithBands([
    -100, -90, -80, -70, -60, -50, -40, -30, -20, -10
  ]);
  const bands = createVoiceFrequencyBands(frequencies, {
    barCount: 5,
    loBin: 0,
    hiBin: 10
  });
  assert.equal(bands.length, 5);
  assert.ok(bands.every((value, index) => index === 0 || value >= bands[index - 1]));
  assert.ok(bands[4] > bands[0]);
});

test('voice bin range follows the actual sample rate and FFT size', () => {
  const range = voiceFrequencyBinRange(48_000, 2048);
  assert.equal(range.loBin, 3);
  assert.equal(range.hiBin, 171);
});

test('voice bands form a centered envelope while each side keeps independent texture', () => {
  const centered = centerVoiceFrequencyBands([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]);
  assert.equal(centered[3], 0.9);
  assert.ok(centered[3] > centered[2]);
  assert.ok(centered[3] > centered[4]);
  assert.ok(centered[2] > centered[1]);
  assert.ok(centered[4] > centered[5]);
  assert.notEqual(centered[2], centered[4]);
});

test('real speech texture lifts the center before either edge', () => {
  const smoother = createVoiceWaveformSmoother(13);
  const voiced = [0.88, 0.18, 0.31, 0.12, 0.22, 0.09, 0.16, 0.11, 0.2, 0.08, 0.27, 0.1, 0.19];
  const centered = centerVoiceFrequencyBands(voiced);
  const first = smoother.next(centered, true, 16);
  assert.ok(first.levels[6] > first.levels[5]);
  assert.ok(first.levels[6] > first.levels[7]);
  assert.ok(first.levels[6] > first.levels[0]);
  assert.ok(first.levels[6] > first.levels[12]);
});

test('idle speech detector never responds to a quiet noise floor', () => {
  const smoother = createVoiceWaveformSmoother(13);
  let frame;
  for (let index = 0; index < 180; index += 1) {
    frame = smoother.next(Array(13).fill(0), false, 16);
  }
  assert.equal(frame.activity, 'idle');
  assert.equal(new Set(frame.levels).size, 1);
  assert.ok(Math.max(...frame.levels) < 0.08);
});

test('a low-frequency noise peak cannot lift any bar while Hark reports silence', () => {
  const smoother = createVoiceWaveformSmoother(13);
  const lowNoise = Array(13).fill(0);
  lowNoise[6] = 1;
  let frame;
  for (let index = 0; index < 180; index += 1) {
    frame = smoother.next(lowNoise, false, 32);
  }
  assert.equal(frame.activity, 'idle');
  assert.equal(new Set(frame.levels).size, 1);
  assert.ok(Math.max(...frame.levels) < 0.08);
});

test('speech starts from center, keeps distinct sides, and returns to the short baseline', () => {
  const smoother = createVoiceWaveformSmoother(13);
  const bands = Array.from({ length: 13 }, (_, index) => {
    if (index === 6) return 0.95;
    if (index === 5) return 0.72;
    if (index === 2) return 0.28;
    return 0.08;
  });
  let frame;
  for (let index = 0; index < 120; index += 1) frame = smoother.next(bands, true, 16);
  assert.equal(frame.activity, 'speaking');
  assert.ok(frame.levels[6] > 0.9);
  assert.ok(frame.levels[5] > frame.levels[2]);
  assert.ok(frame.levels[6] > frame.levels[0]);

  for (let index = 0; index < 140; index += 1) {
    frame = smoother.next(Array(13).fill(0), false, 16);
  }
  assert.equal(frame.activity, 'idle');
  assert.equal(new Set(frame.levels).size, 1);
  assert.ok(Math.max(...frame.levels) < 0.08);
});

test('speech rise is gradual instead of jumping directly to the sampled peak', () => {
  const smoother = createVoiceWaveformSmoother(13);
  const loud = Array(13).fill(0.9);
  const first = smoother.next(loud, true, 16);
  assert.ok(first.levels[6] > 0.075);
  assert.ok(first.levels[6] < 0.35);
  let previous = first.levels[6];
  const samples = [first.levels[6]];
  for (let index = 0; index < 12; index += 1) {
    const frame = smoother.next(loud, true, 16);
    assert.ok(frame.levels[6] >= previous - 0.000001);
    previous = frame.levels[6];
    samples.push(previous);
  }
  assert.ok(samples[2] < samples[6]);
  assert.ok(samples[6] < samples[12]);
});

test('Hark release produces a smooth monotonic fall instead of a one-frame snap', () => {
  const smoother = createVoiceWaveformSmoother(13);
  const loud = Array(13).fill(0.82);
  loud[6] = 0.96;
  for (let index = 0; index < 30; index += 1) smoother.next(loud, true, 16);
  const afterPause = smoother.next(Array(13).fill(0), false, 16);
  assert.equal(afterPause.activity, 'idle');
  assert.ok(afterPause.levels[6] > 0.65);
  assert.ok(Math.min(...afterPause.levels) >= 0.075);
  let previous = afterPause.levels[6];
  for (let index = 0; index < 5; index += 1) {
    const frame = smoother.next(Array(13).fill(0), false, 16);
    assert.ok(frame.levels[6] <= previous + 0.000001);
    assert.ok(frame.levels[6] < previous);
    previous = frame.levels[6];
  }
  let settled;
  for (let index = 0; index < 150; index += 1) {
    settled = smoother.next(Array(13).fill(0), false, 16);
  }
  assert.equal(new Set(settled.levels).size, 1);
  assert.ok(Math.max(...settled.levels) < 0.08);
});

test('rapid analyser jitter is damped without flattening the live band shape', () => {
  const smoother = createVoiceWaveformSmoother(13);
  const quiet = Array.from({ length: 13 }, (_, index) => index % 2 ? 0.18 : 0.28);
  const loud = Array.from({ length: 13 }, (_, index) => index % 2 ? 0.58 : 0.92);
  let previous = Array(13).fill(0.075);
  let frame;
  for (let index = 0; index < 30; index += 1) {
    frame = smoother.next(index % 2 ? quiet : loud, true, 16);
    for (let bar = 0; bar < 13; bar += 1) {
      assert.ok(Math.abs(frame.levels[bar] - previous[bar]) < 0.2);
    }
    previous = frame.levels;
  }
  assert.equal(frame.activity, 'speaking');
  assert.ok(Math.max(...frame.levels) - Math.min(...frame.levels) > 0.25);
});
