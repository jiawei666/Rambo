import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(
  new URL('../../src/main/platform/fs.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const fs = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('Windows private paths grant only the current identity and remove inheritance', () => {
  assert.deepEqual(
    fs.windowsAclArguments('C:\\Rambo\\profile', true, 'DOMAIN\\Carol'),
    [
      'C:\\Rambo\\profile',
      '/inheritance:r',
      '/grant:r',
      'DOMAIN\\Carol:(OI)(CI)F'
    ]
  );
  assert.deepEqual(
    fs.windowsAclArguments('C:\\Rambo\\profile\\secret.txt', false, 'DOMAIN\\Carol'),
    [
      'C:\\Rambo\\profile\\secret.txt',
      '/inheritance:r',
      '/grant:r',
      'DOMAIN\\Carol:F'
    ]
  );
});
