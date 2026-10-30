import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeBase64Pcm16le,
  LivePcmPlayback,
  LIVE_PLAYBACK_GAIN
} from '../../src/renderer/voice-playback.ts';

function createParam(value = 0) {
  return { value };
}

test('Live PCM decoding preserves signed 16-bit little-endian stereo samples', () => {
  const bytes = Buffer.from([
    0x00, 0x00, 0xff, 0x7f,
    0x00, 0x80, 0x01, 0x00
  ]);
  const channels = decodeBase64Pcm16le(bytes.toString('base64'), 2);

  assert.deepEqual([...channels[0]], [0, -1]);
  assert.deepEqual([...channels[1]], [32767 / 32768, 1 / 32768]);
});

test('Live PCM playback schedules consecutive chunks through gain and limiter', () => {
  const started = [];
  const stopped = [];
  const buffers = [];
  const gain = {
    kind: 'gain',
    gain: createParam(),
    connect() {},
    disconnect() {}
  };
  const limiter = {
    kind: 'limiter',
    threshold: createParam(),
    knee: createParam(),
    ratio: createParam(),
    attack: createParam(),
    release: createParam(),
    connect() {},
    disconnect() {}
  };
  const context = {
    currentTime: 10,
    destination: { kind: 'destination' },
    createGain() { return gain; },
    createDynamicsCompressor() { return limiter; },
    createBuffer(channels, frames, sampleRate) {
      const buffer = {
        channels,
        frames,
        sampleRate,
        duration: frames / sampleRate,
        copied: [],
        copyToChannel(samples, channel) { this.copied[channel] = samples; }
      };
      buffers.push(buffer);
      return buffer;
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        connect(node) { assert.equal(node, gain); },
        disconnect() {},
        start(when) { started.push({ when, buffer: this.buffer }); },
        stop() { stopped.push(this); }
      };
      return source;
    }
  };
  const playback = new LivePcmPlayback(context);
  const pcm = Buffer.from([0x00, 0x00, 0x00, 0x40]).toString('base64');

  assert.equal(playback.enqueue({ data: pcm, sampleRate: 24_000, numChannels: 1 }), true);
  assert.equal(playback.enqueue({ data: pcm, sampleRate: 24_000, numChannels: 1 }), true);

  assert.equal(gain.gain.value, LIVE_PLAYBACK_GAIN);
  assert.deepEqual(
    {
      threshold: limiter.threshold.value,
      knee: limiter.knee.value,
      ratio: limiter.ratio.value,
      attack: limiter.attack.value,
      release: limiter.release.value
    },
    { threshold: -6, knee: 0, ratio: 12, attack: 0.003, release: 0.25 }
  );
  assert.equal(buffers.length, 2);
  assert.equal(started.length, 2);
  assert.equal(started[0].when, 10.06);
  assert.equal(started[1].when, 10.06 + 2 / 24_000);
  assert.deepEqual([...buffers[0].copied[0]], [0, 0.5]);

  playback.close();
  assert.equal(stopped.length, 2);
});
