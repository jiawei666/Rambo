import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const source = readFileSync(new URL('../../src/main/voice-wake.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { VoiceWakeEngine } = await import(moduleUrl);
const modelDirectory = fileURLToPath(new URL('../../assets/voice-wake/', import.meta.url));

function fixture(name) {
  return new URL(`../fixtures/voice-wake/${name}.wav`, import.meta.url);
}

function detect(name) {
  const engine = new VoiceWakeEngine({
    modelDirectory,
    createSpotter: config => new sherpa.KeywordSpotter(config)
  });
  engine.start();
  try {
    const wave = sherpa.readWave(fileURLToPath(fixture(name)));
    const samples = new Float32Array(wave.samples.length + 8_000);
    samples.set(wave.samples);
    for (let offset = 0; offset < samples.length; offset += 1_600) {
      const keyword = engine.push(samples.subarray(offset, Math.min(samples.length, offset + 1_600)));
      if (keyword) return keyword;
    }
    return null;
  } finally {
    engine.close();
  }
}

test('local wake model accepts standard and Mandarin-accented Rambo pronunciations', () => {
  assert.equal(detect('rambo'), 'Rambo');
  assert.equal(detect('hello-rambo'), '你好_Rambo');
  assert.equal(detect('lanbo'), '兰博');
  assert.equal(detect('hello-lanbo'), '你好_兰博');
  assert.equal(detect('ruanbo'), '软博');
  assert.equal(detect('hello-ruanbo'), '你好_软博');
  assert.equal(detect('ranbo'), '然博');
  assert.equal(detect('hello-ranbo'), '你好_然博');
  assert.equal(detect('control'), null);
  assert.equal(detect('control-zh'), null);
});

test('local wake engine fails closed when a model file is missing', () => {
  const engine = new VoiceWakeEngine({
    modelDirectory: '/path/that/does/not/exist',
    createSpotter: config => new sherpa.KeywordSpotter(config)
  });
  assert.throws(() => engine.start(), /本机唤醒模型缺少 encoder 文件/u);
});
