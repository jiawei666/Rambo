import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const source = await import('node:fs').then(fs => fs.readFileSync(
  new URL('../../src/main/platform/archive.ts', import.meta.url),
  'utf8'
));
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const archive = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('Windows archive commands prefer the system tar.exe and fall back predictably', () => {
  assert.equal(
    archive.systemTarCommand({
      platform: 'win32',
      environment: { SystemRoot: 'D:\\Windows' },
      exists: path => path === 'D:\\Windows\\System32\\tar.exe'
    }),
    'D:\\Windows\\System32\\tar.exe'
  );
  assert.equal(
    archive.systemTarCommand({
      platform: 'win32',
      environment: { WINDIR: 'C:\\Windows' },
      exists: () => false
    }),
    'tar.exe'
  );
  assert.equal(archive.systemTarCommand({ platform: 'darwin' }), 'tar');
});

test('tar failures include an actionable Windows system-tool diagnostic', () => {
  assert.throws(
    () => archive.listTarGzEntries('C:\\missing\\runtime.tar.gz', {
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows' },
      exists: () => false
    }),
    /Windows 10\/11 应自带 System32\\tar\.exe/u
  );
});
