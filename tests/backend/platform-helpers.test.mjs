import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/shared/platform.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const platform = await import(moduleUrl);

test('desktop path redaction removes both macOS and Windows user names', () => {
  const text = [
    'macOS: /Users/alice/Library/Application Support/Rambo',
    'Windows: C:\\Users\\bob\\AppData\\Roaming\\Rambo',
    'Windows slash: C:/Users/carol/AppData/Local/Rambo'
  ].join('\n');
  const redacted = platform.redactDesktopPaths(text);
  assert.doesNotMatch(redacted, /alice|bob|carol/u);
  assert.match(redacted, /macOS: ~\/Library/u);
  assert.match(redacted, /C:\\Users\\~\\AppData/u);
  assert.match(redacted, /C:\/Users\/~\/AppData/u);
  assert.doesNotMatch(redacted, /C:~\//u);
});

test('native executable names are generated through one platform helper', () => {
  assert.equal(platform.nativeExecutableName('ffmpeg', 'darwin'), 'ffmpeg');
  assert.equal(platform.nativeExecutableName('ffmpeg', 'win32'), 'ffmpeg.exe');
});
