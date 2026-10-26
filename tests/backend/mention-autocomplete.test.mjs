import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/renderer/mention-autocomplete.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText.replaceAll("from '../shared/contracts'", "from './contracts.mjs'");
const { insertMention, mentionOptions, mentionRange } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

const bots = [
  { id: 'a', name: 'Alpha', role: '研究资料', avatar: '', instructions: '', model: null, permission: 'fullAccess', archived: false, createdAt: '' },
  { id: 'b', name: 'Group Beta', role: '', avatar: '', instructions: '', model: null, permission: 'fullAccess', archived: false, createdAt: '' }
];

test('mention range follows the caret and ignores email-like or completed mentions', () => {
  assert.deepEqual(mentionRange('请 @Gr', 5), { start: 2, end: 5, query: 'Gr' });
  assert.deepEqual(mentionRange('@Group Beta 后续', 11), { start: 0, end: 11, query: 'Group Beta' });
  assert.equal(mentionRange('mail@example.com', 16), null);
  assert.equal(mentionRange('@Alpha ', 7), null);
  assert.deepEqual(mentionRange('上一行\n@Be', 7), { start: 4, end: 7, query: 'Be' });
});

test('mention options filter active members and everyone while preserving names with spaces', () => {
  assert.deepEqual(mentionOptions(bots, 'gr').map(option => option.name), ['Group Beta']);
  assert.deepEqual(mentionOptions(bots, 'every').map(option => option.name), ['everyone']);
  assert.deepEqual(mentionOptions(bots, '').map(option => option.name), ['Alpha', 'Group Beta', 'everyone']);
  assert.deepEqual(mentionOptions([], '').map(option => option.name), ['everyone']);
});

test('mention insertion replaces only the active query and keeps the suffix and one separator', () => {
  const range = mentionRange('请看 @Gr 后续', 6);
  assert.ok(range);
  assert.deepEqual(insertMention('请看 @Gr 后续', range, 'Group Beta'), {
    value: '请看 @Group Beta 后续',
    caret: 14
  });
  assert.deepEqual(insertMention('@Al', mentionRange('@Al', 3), 'Alpha'), {
    value: '@Alpha ',
    caret: 7
  });
});
