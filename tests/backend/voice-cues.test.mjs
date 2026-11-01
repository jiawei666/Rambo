import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const cueSource = readFileSync(new URL('../../src/renderer/voice-cues.ts', import.meta.url), 'utf8');
const cueModuleUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(cueSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext
  }
}).outputText).toString('base64')}`;
const { playVoiceCue, warmVoiceCues } = await import(cueModuleUrl);

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('wake, connected and ended cues load distinct bundled media and finish after playback', async () => {
  const instances = [];
  class FakeAudio {
    preload = '';
    volume = 1;
    muted = false;
    currentTime = 0;
    ended = false;
    paused = true;
    listeners = new Map();

    constructor(src) {
      this.src = src;
      instances.push(this);
    }

    load() {}

    pause() {
      this.paused = true;
    }

    async play() {
      this.paused = false;
      setTimeout(() => {
        this.ended = true;
        for (const listener of this.listeners.get('ended') ?? []) listener();
      }, 1);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
    }
  }
  const previousAudio = globalThis.Audio;
  globalThis.Audio = FakeAudio;
  try {
    warmVoiceCues();
    await playVoiceCue('wake');
    await playVoiceCue('connected');
    await playVoiceCue('ended');
    assert.deepEqual(
      instances.map(item => item.src).sort(),
      [
        './voice-cues/scifi/connected.mp3?v=2969330ad97291b5d4552b7a3815bd2758cfa19aed4132611421e337ddef68f8',
        './voice-cues/scifi/ended.mp3?v=315595d577a5050640c3616d504bce74e35c11410c42b0d7191d8ef7d68366f7',
        './voice-cues/scifi/wake.mp3?v=f21ee21d214e03d6c167295216e5805c328ca8f457412a131d4b6a52ecc4fbdd'
      ]
    );
    assert.ok(instances.every(item => item.volume === 0.75));
  } finally {
    if (previousAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = previousAudio;
  }
});

test('bundled cue assets match the documented Sci-fi source, derivation, license, and hashes', () => {
  const directory = new URL('../../src/renderer/public/voice-cues/scifi/', import.meta.url);
  const hashes = {
    wake: sha256(new URL('wake.mp3', directory)),
    connected: sha256(new URL('connected.mp3', directory)),
    ended: sha256(new URL('ended.mp3', directory))
  };
  assert.deepEqual(hashes, {
    wake: 'f21ee21d214e03d6c167295216e5805c328ca8f457412a131d4b6a52ecc4fbdd',
    connected: '2969330ad97291b5d4552b7a3815bd2758cfa19aed4132611421e337ddef68f8',
    ended: '315595d577a5050640c3616d504bce74e35c11410c42b0d7191d8ef7d68366f7'
  });
  assert.equal(new Set(Object.values(hashes)).size, 3);
  const upstream = readFileSync(new URL('UPSTREAM.md', directory), 'utf8');
  const license = readFileSync(new URL('LICENSE-AUDIO', directory), 'utf8');
  assert.match(upstream, /github\.com\/romainsimon\/uisfx/u);
  assert.match(upstream, /9950fe66f993a6660dab9c2651dcbcd899ffd83b/u);
  assert.match(upstream, /connected\s+and ended cues are derived variants of that source/u);
  assert.match(upstream, /played directly when local wake-word detection succeeds/u);
  assert.match(upstream, /\+2 semitones/u);
  assert.match(upstream, /-5 semitones/u);
  assert.match(license, /CC0 1\.0 Universal/u);
  assert.match(cueSource, /wake\.mp3/u);
});
