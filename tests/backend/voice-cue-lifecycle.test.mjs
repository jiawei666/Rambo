import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/renderer/voice-cue-lifecycle.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { VoiceCueLifecycle } = await import(moduleUrl);

test('connected and ended cues fire once per Live session after it becomes live', () => {
  const lifecycle = new VoiceCueLifecycle();
  assert.equal(lifecycle.onVoiceState('chat-a', 'connecting'), null);
  assert.equal(lifecycle.onVoiceState('chat-a', 'live'), 'connected');
  assert.equal(lifecycle.onVoiceState('chat-a', 'live'), null);
  assert.equal(lifecycle.onVoiceState('chat-a', 'stopping'), null);
  assert.equal(lifecycle.onStopFinished('chat-a'), 'ended');
  assert.equal(lifecycle.onStopFinished('chat-a'), null);
});

test('a failed connected Live gets one ended cue and pre-live failures stay silent', () => {
  const lifecycle = new VoiceCueLifecycle();
  assert.equal(lifecycle.onVoiceState('chat-a', 'error'), null);
  assert.equal(lifecycle.onVoiceState('chat-a', 'live'), 'connected');
  assert.equal(lifecycle.onVoiceState('chat-a', 'error'), 'ended');
  assert.equal(lifecycle.onVoiceState('chat-a', 'error'), null);
  assert.equal(lifecycle.onStopFinished('chat-a'), null);
});
