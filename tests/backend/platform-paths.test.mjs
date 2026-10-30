import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(
  new URL('../../src/main/platform/paths.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const paths = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('Windows path identity is case-insensitive and ignores trailing separators', () => {
  assert.equal(
    paths.pathKey('C:\\Users\\Carol\\Rambo\\', 'win32'),
    'c:\\users\\carol\\rambo'
  );
  assert.equal(
    paths.samePath('C:\\Users\\Carol', 'c:/users/carol/', 'win32'),
    true
  );
  assert.equal(
    paths.samePath('/Users/Carol', '/users/carol', 'darwin'),
    false
  );
});

test('Windows containment checks handle drives, siblings and traversal', () => {
  assert.equal(paths.isPathInside('C:\\Rambo', 'C:\\Rambo\\data\\file.db', 'win32'), true);
  assert.equal(paths.isPathInside('C:\\Rambo', 'C:\\Rambo\\..\\other', 'win32'), false);
  assert.equal(paths.isPathInside('C:\\Rambo', 'C:\\RamboOther', 'win32'), false);
  assert.equal(paths.isPathInside('C:\\Rambo', 'D:\\Rambo\\data', 'win32'), false);
  assert.equal(paths.isPathInsideOrEqual('C:\\Rambo', 'c:/rambo', 'win32'), true);
});

test('POSIX containment remains case-sensitive and rejects prefix collisions', () => {
  assert.equal(paths.isPathInside('/Users/carol/Rambo', '/Users/carol/Rambo/a', 'darwin'), true);
  assert.equal(paths.isPathInside('/Users/carol/Rambo', '/Users/carol/RamboOther/a', 'darwin'), false);
  assert.equal(paths.isPathInside('/Users/carol/Rambo', '/users/carol/Rambo/a', 'darwin'), false);
});
