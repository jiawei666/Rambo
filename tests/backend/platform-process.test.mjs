import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(
  new URL('../../src/main/platform/process.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const processPlatform = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('Windows npx discovery preserves PATH order and uses Windows path semantics', () => {
  const checked = [];
  const found = processPlatform.findNpx({
    platform: 'win32',
    environment: {
      PATH: '"C:\\Tools with spaces";D:\\Node',
      PATHEXT: '.CMD;.EXE',
      USERPROFILE: 'C:\\Users\\Carol'
    },
    exists: path => {
      checked.push(path);
      return path === 'D:\\Node\\npx.cmd';
    }
  });
  assert.equal(found, 'D:\\Node\\npx.cmd');
  assert.equal(checked.includes('C:\\Tools with spaces\\npx.cmd'), true);
  assert.ok(checked.indexOf('C:\\Tools with spaces\\npx.cmd') <
    checked.indexOf('D:\\Node\\npx.cmd'));
  assert.equal(checked.some(path => path.includes('/')), false);
});

test('Windows npx discovery covers npm and Node.js install locations', () => {
  const environment = {
    PATH: '',
    PATHEXT: '.CMD;.EXE',
    USERPROFILE: 'C:\\Users\\Carol',
    APPDATA: 'C:\\Users\\Carol\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Carol\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files'
  };
  for (const expected of [
    'C:\\Users\\Carol\\AppData\\Roaming\\npm\\npx.cmd',
    'C:\\Program Files\\nodejs\\npx.cmd',
    'C:\\Users\\Carol\\AppData\\Local\\Programs\\nodejs\\npx.cmd',
    'C:\\Users\\Carol\\AppData\\Local\\Volta\\bin\\npx.cmd'
  ]) {
    assert.equal(processPlatform.findNpx({
      platform: 'win32',
      environment,
      exists: path => path === expected
    }), expected);
  }
});

test('Windows child environments preserve PATH and only inject selected secrets', () => {
  const environment = processPlatform.commandEnvironment({
    RAMBO_MANUAL_API_KEY: 'selected-secret'
  }, {
    platform: 'win32',
    environment: {
      PATH: 'C:\\First;C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.CMD',
      USERPROFILE: 'C:\\Users\\Carol',
      TEMP: 'C:\\Users\\Carol\\AppData\\Local\\Temp',
      OPENAI_API_KEY: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak'
    }
  });
  assert.equal(environment.PATH, 'C:\\First;C:\\Windows\\System32');
  assert.equal(environment.SystemRoot, 'C:\\Windows');
  assert.equal(environment.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(environment.PATHEXT, '.COM;.EXE;.CMD');
  assert.equal(environment.USERPROFILE, 'C:\\Users\\Carol');
  assert.equal(environment.HOME, 'C:\\Users\\Carol');
  assert.equal(environment.TEMP, 'C:\\Users\\Carol\\AppData\\Local\\Temp');
  assert.equal(environment.RAMBO_MANUAL_API_KEY, 'selected-secret');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
});

test('Windows .cmd shims are invoked through cmd.exe with escaped arguments', () => {
  const invocation = processPlatform.npxInvocation(
    'C:\\Program Files\\nodejs\\npx.cmd',
    ['-y', '@playwright/mcp@0.0.83', '--extension', 'a&b', '100%', 'x[y]'],
    {
      platform: 'win32',
      environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    }
  );
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(invocation.args[3], /^".*"$/u);
  assert.match(invocation.args[3], /C:\\Program\^ Files\\nodejs\\npx\.cmd/u);
  assert.match(invocation.args[3], /\^&/u);
  assert.match(invocation.args[3], /\^%/u);
  assert.match(invocation.args[3], /\^\[/u);
});

test('Windows bare command names resolve through cwd, PATH and PATHEXT before invocation', () => {
  const invocation = processPlatform.commandInvocation('npm', ['run', 'build'], {
    platform: 'win32',
    cwd: 'C:\\Project',
    environment: {
      PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      PATHEXT: '.COM;.EXE;.CMD',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe'
    },
    exists: path => path === 'C:\\Program Files\\nodejs\\npm.cmd'
  });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args[3], /C:\\Program\^ Files\\nodejs\\npm\.cmd/u);
});

test('native Windows executables are spawned directly without a shell wrapper', () => {
  const invocation = processPlatform.npxInvocation(
    'C:\\Program Files\\nodejs\\npx.exe',
    ['--version'],
    { platform: 'win32' }
  );
  assert.deepEqual(invocation, {
    command: 'C:\\Program Files\\nodejs\\npx.exe',
    args: ['--version']
  });
});

test('Windows node_modules cmd shims receive the cross-spawn double escaping', () => {
  const invocation = processPlatform.commandInvocation(
    'C:\\Project\\node_modules\\.bin\\tool.cmd',
    ['a&b'],
    { platform: 'win32' }
  );
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.match(invocation.args[3], /\^\^&/u);
});
