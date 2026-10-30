import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const storeSource = readFileSync(new URL('../../src/main/store.ts', import.meta.url), 'utf8');
const scheduleSource = readFileSync(new URL('../../src/main/routine-schedule.ts', import.meta.url), 'utf8');
const contractsSource = readFileSync(new URL('../../src/shared/contracts.ts', import.meta.url), 'utf8');
const robotAvatarSource = readFileSync(new URL('../../src/shared/robot-avatar.ts', import.meta.url), 'utf8');
const loginItemSource = readFileSync(new URL('../../src/main/login-item.ts', import.meta.url), 'utf8');
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };

async function withModules(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-login-item-test-'));
  const storePath = join(directory, 'store.mjs');
  const loginItemPath = join(directory, 'login-item.mjs');
  writeFileSync(join(directory, 'routine-schedule.mjs'),
    ts.transpileModule(scheduleSource, { compilerOptions }).outputText, { mode: 0o600 });
  writeFileSync(join(directory, 'contracts.mjs'),
    ts.transpileModule(contractsSource, { compilerOptions }).outputText, { mode: 0o600 });
  writeFileSync(join(directory, 'robot-avatar.mjs'),
    ts.transpileModule(robotAvatarSource, { compilerOptions }).outputText, { mode: 0o600 });
  writeFileSync(storePath, ts.transpileModule(storeSource, { compilerOptions }).outputText
    .replaceAll("from './routine-schedule'", "from './routine-schedule.mjs'")
    .replaceAll("from '../shared/contracts'", "from './contracts.mjs'")
    .replaceAll("from '../shared/robot-avatar'", "from './robot-avatar.mjs'"), { mode: 0o600 });
  const compiledLoginItem = ts.transpileModule(loginItemSource, { compilerOptions }).outputText
    .replaceAll("from './store'", "from './store.mjs'");
  writeFileSync(loginItemPath, compiledLoginItem, { mode: 0o600 });
  try {
    const [{ Store }, loginItem] = await Promise.all([
      import(`${pathToFileURL(storePath).href}?${Date.now()}-${Math.random()}`),
      import(`${pathToFileURL(loginItemPath).href}?${Date.now()}-${Math.random()}`)
    ]);
    await run({ Store, loginItem, directory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fakeAdapter(initial) {
  const calls = [];
  return {
    calls,
    adapter: {
      readOpenAtLogin: () => initial,
      setOpenAtLogin: enabled => calls.push(enabled)
    }
  };
}

test('login at startup defaults to true and applies the preference on startup', async () => {
  await withModules(async ({ Store, loginItem, directory }) => {
    const store = new Store(directory);
    const fake = fakeAdapter(false);
    try {
      const controller = new loginItem.LoginItemController(store, fake.adapter);
      assert.equal(loginItem.readLoginAtStartup(store), true);
      controller.applyStoredPreference();
      assert.deepEqual(fake.calls, [true]);
    } finally { store.close(); }
  });
});

test('turning login at startup off persists false and survives a Store reopen', async () => {
  await withModules(async ({ Store, loginItem, directory }) => {
    const first = new Store(directory);
    const firstAdapter = fakeAdapter(true);
    try {
      const controller = new loginItem.LoginItemController(first, firstAdapter.adapter);
      controller.setEnabled(false);
      assert.deepEqual(firstAdapter.calls, [false]);
      assert.equal(first.settings().launchAtLogin, 'false');
    } finally { first.close(); }

    const reopened = new Store(directory);
    const reopenAdapter = fakeAdapter(true);
    try {
      assert.equal(loginItem.readLoginAtStartup(reopened), false);
      new loginItem.LoginItemController(reopened, reopenAdapter.adapter).applyStoredPreference();
      assert.deepEqual(reopenAdapter.calls, [false]);
      assert.equal(reopened.settings().launchAtLogin, 'false');
    } finally { reopened.close(); }
  });
});

test('the Electron adapter only changes the system login item outside acceptance runs', async () => {
  await withModules(async ({ loginItem }) => {
    const systemCalls = [];
    const systemApp = {
      isPackaged: true,
      platform: 'darwin',
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: settings => systemCalls.push(settings)
    };
    const packaged = loginItem.createElectronLoginItemAdapter(systemApp);
    assert.equal(packaged.readOpenAtLogin(), false);
    packaged.setOpenAtLogin(true);
    assert.deepEqual(systemCalls, [{ openAtLogin: true }]);

    const devCalls = [];
    const development = loginItem.createElectronLoginItemAdapter({
      ...systemApp,
      isPackaged: false,
      getLoginItemSettings: () => { devCalls.push('read'); return { openAtLogin: true }; },
      setLoginItemSettings: settings => devCalls.push(settings)
    });
    assert.equal(development.readOpenAtLogin(), false);
    development.setOpenAtLogin(true);
    assert.deepEqual(devCalls, []);

    const acceptanceCalls = [];
    const acceptance = loginItem.createElectronLoginItemAdapter({
      ...systemApp,
      getLoginItemSettings: () => { acceptanceCalls.push('read'); return { openAtLogin: true }; },
      setLoginItemSettings: settings => acceptanceCalls.push(settings)
    }, { allowSystemChanges: false });
    assert.equal(acceptance.readOpenAtLogin(), false);
    acceptance.setOpenAtLogin(true);
    assert.deepEqual(acceptanceCalls, []);
  });
});

test('the packaged Windows adapter registers the executable with a hidden startup argument', async () => {
  await withModules(async ({ loginItem }) => {
    const calls = [];
    const systemApp = {
      isPackaged: true,
      platform: 'win32',
      getPath: name => name === 'exe' ? 'C:\\Program Files\\Rambo\\Rambo.exe' : '',
      getLoginItemSettings: settings => {
        calls.push({ operation: 'read', settings });
        return { openAtLogin: false };
      },
      setLoginItemSettings: settings => calls.push({ operation: 'write', settings })
    };
    const adapter = loginItem.createElectronLoginItemAdapter(systemApp);
    assert.equal(adapter.readOpenAtLogin(), false);
    adapter.setOpenAtLogin(true);
    const expected = {
      path: 'C:\\Program Files\\Rambo\\Rambo.exe',
      args: ['--hidden']
    };
    assert.deepEqual(calls, [
      { operation: 'read', settings: expected },
      { operation: 'write', settings: { openAtLogin: true, ...expected } }
    ]);
  });
});
