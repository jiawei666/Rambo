import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const sourcePath = new URL('../../src/renderer/management-actions.ts', import.meta.url);
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const testDirectory = mkdtempSync(join(tmpdir(), 'rambo-management-actions-'));
const modulePath = join(testDirectory, 'management-actions.mjs');
writeFileSync(modulePath, compiled, { mode: 0o600 });
const { runAfterExplicitConfirmation } = await import(pathToFileURL(modulePath).href);
after(() => rmSync(testDirectory, { recursive: true, force: true }));

test('cancelled confirmation never invokes the destructive action', async () => {
  let calls = 0;
  const result = await runAfterExplicitConfirmation(false, () => { calls += 1; });
  assert.equal(result, false);
  assert.equal(calls, 0);
});

test('confirmed destructive action runs once and completes before returning', async () => {
  let calls = 0;
  const result = await runAfterExplicitConfirmation(true, async () => { calls += 1; });
  assert.equal(result, true);
  assert.equal(calls, 1);
});
