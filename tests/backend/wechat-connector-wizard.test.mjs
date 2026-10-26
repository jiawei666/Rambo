import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const projectRoot = new URL('../..', import.meta.url).pathname;
const require = createRequire(import.meta.url);
const xmldomEntry = pathToFileURL(require.resolve('@xmldom/xmldom')).href;
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const wizardSource = await import('node:fs/promises').then(fs =>
  fs.readFile(new URL('../../src/main/wechat-connector-wizard.ts', import.meta.url), 'utf8')
);
const sqlCipherSource = await import('node:fs/promises').then(fs =>
  fs.readFile(new URL('../../src/main/wechat-sqlcipher.ts', import.meta.url), 'utf8')
);
const compiledSqlCipher = ts.transpileModule(sqlCipherSource, { compilerOptions }).outputText;
const compiledWizard = ts.transpileModule(wizardSource, { compilerOptions }).outputText
  .replace('function parsePlistString(', 'export function parsePlistString(')
  .replace('function hasGetTaskAllow(', 'export function hasGetTaskAllow(')
  .replaceAll("from './wechat-sqlcipher'", "from './wechat-sqlcipher.mjs'")
  .replaceAll("from '@xmldom/xmldom'", `from '${xmldomEntry}'`);

async function withWizard(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-wechat-wizard-test-'));
  writeFileSync(join(directory, 'wechat-sqlcipher.mjs'), compiledSqlCipher, { mode: 0o600 });
  writeFileSync(join(directory, 'wechat-connector-wizard.mjs'), compiledWizard, { mode: 0o600 });
  try {
    const wizard = await import(`${pathToFileURL(join(directory, 'wechat-connector-wizard.mjs')).href}?${Date.now()}`);
    const sqlCipher = await import(`${pathToFileURL(join(directory, 'wechat-sqlcipher.mjs')).href}?${Date.now()}`);
    await run({ wizard, sqlCipher, directory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createCaptureFixture(sqlCipher, directory, key, keyForDatabase = () => key) {
  const home = join(directory, 'fixture-home');
  const userData = join(directory, 'fixture-user-data');
  const sourceApp = join(home, 'Applications', 'WeChat.app');
  const info = `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>com.tencent.xinWeChat</string>
    <key>CFBundleShortVersionString</key><string>4.1.15</string>
    <key>CFBundleVersion</key><string>270135</string>
    <key>CFBundleExecutable</key><string>WeChat</string>
  </dict></plist>`;
  mkdirSync(join(sourceApp, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(sourceApp, 'Contents', 'Info.plist'), info, { mode: 0o600 });
  writeFileSync(join(sourceApp, 'Contents', 'MacOS', 'WeChat'), '', { mode: 0o700 });

  const dataRoot = join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files');
  const accountDirectory = join(dataRoot, 'wxid_test');
  const databasePaths = [
    'contact/contact.db',
    'session/session.db',
    'sns/sns.db',
    'message/message_0.db',
    'message/media_0.db'
  ];
  const encrypted = sqlCipher.encryptWechatDatabaseFixture(
    Buffer.alloc(sqlCipher.WECHAT_PAGE_SIZE), key, Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  );
  for (const path of databasePaths) {
    const target = join(accountDirectory, 'db_storage', path);
    mkdirSync(dirname(target), { recursive: true });
    const databaseKey = keyForDatabase(path);
    const database = databaseKey === key
      ? encrypted
      : sqlCipher.encryptWechatDatabaseFixture(
          Buffer.alloc(sqlCipher.WECHAT_PAGE_SIZE),
          databaseKey,
          Buffer.from('00112233445566778899aabbccddeeff', 'hex')
        );
    writeFileSync(target, database, { mode: 0o600 });
  }
  const uvPath = join(home, '.local', 'bin', 'uv');
  mkdirSync(dirname(uvPath), { recursive: true });
  writeFileSync(uvPath, '', { mode: 0o700 });
  const pythonPath = join(home, '.local', 'capture-runtime', 'bin', 'python');
  mkdirSync(dirname(pythonPath), { recursive: true });
  writeFileSync(pythonPath, '', { mode: 0o700 });
  return { home, userData, sourceApp, accountDirectory, info, uvPath, pythonPath };
}

function captureRuntime({ sourceApp, info, accountDirectory, key, roundKeys = [[key]], uvPath, pythonPath, failCopy = false, originalRunning = false, managedClone = false }) {
  let entitlementReadCount = 0;
  let spawnedExecutable = '';
  let stoppedClone = null;
  let captureRootPath = '';
  let processCheckCount = 0;
  let quitCalled = false;
  let reopened = false;
  let captureCommand = '';
  let osascriptTimeout = null;
  let adminCaptureCount = 0;
  const runFakeCaptureDriver = (port, token) => new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let buffer = '';
    let round = 0;
    let terminal = false;
    const sentKeys = new Set();
    const send = message => socket.write(`${JSON.stringify(message)}\n`);
    const sendRoundKeys = () => {
      for (const value of roundKeys[round] ?? []) {
        if (sentKeys.has(value)) continue;
        sentKeys.add(value);
        send({ type: 'key', value, keyCount: sentKeys.size });
        send({ type: 'status', phase: 'key-count', keyCount: sentKeys.size });
      }
    };
    const fail = error => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      send({ type: 'hello', token });
      send({ type: 'status', phase: 'attaching', keyCount: 0 });
      send({ type: 'status', phase: 'attached', keyCount: 0 });
      send({ type: 'status', phase: 'hook-ready', keyCount: 0 });
      sendRoundKeys();
    });
    socket.once('close', () => {
      if (terminal) resolve({ stdout: '', stderr: '' });
    });
    socket.on('data', chunk => {
      buffer += String(chunk);
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let command;
        try { command = JSON.parse(line); }
        catch (error) { fail(error); return; }
        if (command.type === 'finish') {
          send({ type: 'status', phase: 'round-complete', keyCount: sentKeys.size, round: round + 1 });
        } else if (command.type === 'continue') {
          round += 1;
          send({ type: 'status', phase: 'round-start', keyCount: sentKeys.size, round: round + 1 });
          sendRoundKeys();
        } else if (command.type === 'complete') {
          terminal = true;
          send({ type: 'status', phase: 'complete', keyCount: sentKeys.size });
          socket.end();
        } else if (command.type === 'cancel') {
          terminal = true;
          send({ type: 'status', phase: 'cancelled', keyCount: sentKeys.size });
          socket.end();
        }
      }
    });
  });
  return {
    stoppedClone: () => stoppedClone,
    quitCalled: () => quitCalled,
    reopened: () => reopened,
    spawnedExecutable: () => spawnedExecutable,
    captureCommand: () => captureCommand,
    osascriptTimeout: () => osascriptTimeout,
    adminCaptureCount: () => adminCaptureCount,
    runtime: {
      runFile: async (file, args, options = {}) => {
        if (file === uvPath) {
          return { stdout: JSON.stringify({ python: pythonPath, version: '16.7.19' }), stderr: '' };
        }
        if (file === '/usr/bin/plutil') return { stdout: info, stderr: '' };
        if (file === '/usr/bin/codesign') {
          if (args[0] === '-d' && args.includes('--verbose=4')) {
            return { stdout: 'Authority=Developer ID Application: Tencent Developer\nTeamIdentifier=AB12CD34EF', stderr: '' };
          }
          if (args[0] === '-d' && args.includes('--entitlements')) {
            entitlementReadCount += 1;
            const value = managedClone || entitlementReadCount > 1 ? '<true/>' : '<false/>';
            return {
              stdout: `<plist><dict><key>com.apple.security.get-task-allow</key>${value}</dict></plist>`,
              stderr: ''
            };
          }
          return { stdout: '', stderr: '' };
        }
        if (file === '/bin/cp') {
          if (failCopy) {
            throw Object.assign(new Error('copy failed'), {
              stdout: '', stderr: `Permission denied /Users/tester/Library/tmp ${key}`, code: 'EACCES'
            });
          }
          cpSync(args[2], args[3], { recursive: true });
          captureRootPath = dirname(args[3]);
          return { stdout: '', stderr: '' };
        }
        if (file === '/usr/bin/osascript') {
          if (args[1].includes('to quit')) {
            quitCalled = true;
            return { stdout: '', stderr: '' };
          }
          assert.ok(args[1].includes(pythonPath));
          assert.match(args[1], /-B/u);
          captureCommand = args[1];
          osascriptTimeout = options.timeout ?? null;
          const match = /\s777\s+(\d+)\s+'([a-f0-9-]{36})'/iu.exec(args[1]);
          assert.ok(match, 'capture command should include the local socket and one-time token');
          adminCaptureCount += 1;
          return runFakeCaptureDriver(Number(match[1]), match[2]);
        }
        throw new Error(`Unexpected command in test: ${file}`);
      },
      spawn: executable => {
        if (executable === '/usr/bin/open') reopened = true;
        spawnedExecutable = executable;
        return { pid: 777, unref() {} };
      },
      processIds: async () => {
        if (!originalRunning) return [];
        return processCheckCount++ === 0 ? [101] : [];
      },
      processCommand: async () => spawnedExecutable,
      delay: async () => {},
      stopClone: async (pid, captureRoot) => { stoppedClone = { pid, captureRoot }; }
    },
    sourceApp,
    accountDirectory
  };
}

function captureWithAutomaticRoundControls(instance, connectionId, onProgress = () => {}) {
  let lastStoppedKeyCount = 0;
  return instance.capture(connectionId, state => {
    onProgress(state);
    const match = /^已捕获 (\d+) 个候选密钥/u.exec(state.message);
    const keyCount = match ? Number(match[1]) : 0;
    if (state.canFinishCapture && keyCount > lastStoppedKeyCount) {
      lastStoppedKeyCount = keyCount;
      assert.equal(instance.requestCaptureStop(connectionId), true);
    }
    if (state.phase === 'awaiting-recapture') {
      assert.equal(state.canContinueCapture, true);
      assert.equal(instance.requestCaptureContinue(connectionId), true);
    }
  });
}

test('temporary signing adds get-task-allow while preserving WeChat entitlements', async () => {
  await withWizard(async ({ wizard }) => {
    const original = `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>com.apple.application-identifier</key><string>TEAM.com.tencent.xinWeChat</string>
      <key>com.apple.security.get-task-allow</key><false/>
    </dict></plist>`;
    const changed = wizard.withGetTaskAllow(original);
    assert.match(changed, /com\.apple\.application-identifier/u);
    assert.match(changed, /TEAM\.com\.tencent\.xinWeChat/u);
    assert.match(changed, /<true\s*\/>/u);
    assert.doesNotMatch(changed, /<false\s*\/>/u);
    assert.equal((changed.match(/com\.apple\.security\.get-task-allow/gu) ?? []).length, 1);
  });
});

test('WeChat Info.plist string fields are parsed with xmldom sibling nodes', async () => {
  await withWizard(async ({ wizard }) => {
    const plist = '<plist><dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.tencent.xinWeChat</string>\n</dict></plist>';
    assert.equal(wizard.parsePlistString(plist, 'CFBundleIdentifier'), 'com.tencent.xinWeChat');
  });
});

test('post-signing entitlement verification recognizes get-task-allow', async () => {
  await withWizard(async ({ wizard }) => {
    const plist = '<plist><dict>\n  <key>com.apple.security.get-task-allow</key>\n  <true/>\n</dict></plist>';
    assert.equal(wizard.hasGetTaskAllow(plist), true);
  });
});

test('capture completes the isolated clone, signing, key capture, SQLCipher verification, and cleanup chain', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const key = 'cd'.repeat(32);
    const fixture = createCaptureFixture(sqlCipher, directory, key);
    const fake = captureRuntime({ ...fixture, key, originalRunning: true });
    const prompts = {
      confirmCloseWechat: async () => true,
      // The native folder picker can return a folder opened inside the account directory.
      chooseAccountDirectory: async () => join(fixture.accountDirectory, 'db_storage')
    };
    let beforeCaptureCalled = false;
    const instance = new wizard.WechatConnectorWizard(fixture.userData, prompts, fixture.home, fake.runtime, {
      captureSeconds: 300,
      beforeCapture: async () => { beforeCaptureCalled = true; }
    });
    const phases = [];
    const progress = [];
    const captured = await captureWithAutomaticRoundControls(instance, 'fixture-connection', state => {
      phases.push(state.phase);
      progress.push(state.message);
    });

    assert.equal(captured.accountId, 'wxid_test');
    assert.equal(captured.dataDirectory, realpathSync(fixture.accountDirectory));
    assert.equal(captured.wechatVersion, '4.1.15');
    assert.equal(captured.wechatBuild, '270135');
    assert.equal(Object.keys(captured.keys).length, 4);
    assert.ok(Object.values(captured.keys).every(value => value.encKey === key));
    assert.ok(progress.includes('Frida 已附加到微信副本，正在准备密钥捕获。'));
    assert.ok(progress.includes('临时微信副本已启动；请先完成登录，确认进入微信后再开始密钥捕获。'));
    assert.ok(progress.some(message => message.includes('采集最长 300 秒')));
    assert.equal(beforeCaptureCalled, true);
    assert.ok(progress.includes('已捕获 1 个候选密钥；密钥内容只在本机内存中处理。'));
    assert.doesNotMatch(JSON.stringify(progress), new RegExp(key, 'u'));
    assert.deepEqual([...new Set(phases)], ['checking', 'closing', 'selecting-account', 'copying', 'signing', 'launching', 'capturing', 'verifying']);
    assert.equal(fake.stoppedClone()?.pid, 777);
    assert.equal(fake.quitCalled(), true);
    assert.equal(fake.reopened(), true);
    assert.ok(fake.stoppedClone()?.captureRoot.includes('managed-wechat-capture'));
    assert.equal(existsSync(fake.stoppedClone()?.captureRoot), false);
  });
});

test('capture reuses the managed clone and leaves it running after SQLCipher verification', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const key = '98'.repeat(32);
    const fixture = createCaptureFixture(sqlCipher, directory, key);
    const managedClone = join(fixture.userData, 'managed-wechat', 'WeChat.app');
    mkdirSync(dirname(managedClone), { recursive: true });
    cpSync(fixture.sourceApp, managedClone, { recursive: true });
    const fake = captureRuntime({ ...fixture, key, managedClone: true });
    const prompts = {
      confirmCloseWechat: async () => { throw new Error('reusing the managed clone must not ask to close WeChat'); },
      chooseAccountDirectory: async () => fixture.accountDirectory
    };
    const instance = new wizard.WechatConnectorWizard(fixture.userData, prompts, fixture.home, fake.runtime, {
      captureSeconds: 300,
      manualStopOnly: true,
      reuseManagedClone: true,
      beforeCapture: async () => {}
    });
    const progress = [];
    const captured = await captureWithAutomaticRoundControls(
      instance,
      'managed-clone-connection',
      state => progress.push(state.message)
    );

    assert.equal(captured.accountId, 'wxid_test');
    assert.equal(Object.keys(captured.keys).length, 4);
    assert.equal(existsSync(managedClone), true);
    assert.match(fake.spawnedExecutable(), /managed-wechat/u);
    assert.equal(fake.stoppedClone(), null);
    assert.equal(fake.quitCalled(), false);
    assert.equal(fake.reopened(), false);
    assert.equal(fake.osascriptTimeout(), null);
    assert.match(fake.captureCommand(), /\s777\s+\d+\s/u);
    assert.ok(progress.includes('正在复用 Rambo 受管微信副本；如窗口已打开，将直接附加。'));
    assert.ok(progress.some(message => message.startsWith('密钥校验通过，正在清理本轮捕获文件；受管微信副本保持运行。')));
    assert.ok(progress.some(message => message.includes('捕获会一直运行，直到你结束本轮；如果数据库密钥不全，可继续补抓')));
    assert.doesNotMatch(JSON.stringify(progress), /正在清理临时副本并恢复微信/u);
  });
});

test('incomplete SQLCipher coverage continues in the same clone and privileged capture process', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const contactKey = '98'.repeat(32);
    const messageKey = 'ab'.repeat(32);
    const fixture = createCaptureFixture(sqlCipher, directory, contactKey, path =>
      path === 'contact/contact.db' || path === 'session/session.db' ? contactKey : messageKey
    );
    const managedClone = join(fixture.userData, 'managed-wechat', 'WeChat.app');
    mkdirSync(dirname(managedClone), { recursive: true });
    cpSync(fixture.sourceApp, managedClone, { recursive: true });
    const fake = captureRuntime({
      ...fixture,
      key: contactKey,
      roundKeys: [[contactKey], [messageKey]],
      managedClone: true
    });
    const prompts = {
      confirmCloseWechat: async () => { throw new Error('same managed clone should remain open'); },
      chooseAccountDirectory: async () => fixture.accountDirectory
    };
    const instance = new wizard.WechatConnectorWizard(fixture.userData, prompts, fixture.home, fake.runtime, {
      manualStopOnly: true,
      reuseManagedClone: true
    });
    const phases = [];
    const messages = [];
    const captured = await captureWithAutomaticRoundControls(instance, 'multi-round-connection', state => {
      phases.push(state.phase);
      messages.push(state.message);
    });

    assert.equal(Object.keys(captured.keys).length, 4);
    assert.equal(Object.values(captured.keys).filter(value => value.encKey === contactKey).length, 2);
    assert.equal(Object.values(captured.keys).filter(value => value.encKey === messageKey).length, 2);
    assert.ok(phases.includes('awaiting-recapture'));
    assert.ok(phases.includes('resuming-capture'));
    assert.ok(messages.some(message => message.includes('还缺 2 个数据库的密钥')));
    assert.equal(fake.adminCaptureCount(), 1, 'only one administrator process is started for both rounds');
    assert.equal(fake.spawnedExecutable().includes('managed-wechat'), true);
    assert.equal(existsSync(managedClone), true);
  });
});

test('capture reports the failing system step and redacts command diagnostics', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const key = 'ef'.repeat(32);
    const fixture = createCaptureFixture(sqlCipher, directory, key);
    const fake = captureRuntime({ ...fixture, key, failCopy: true });
    const prompts = { confirmCloseWechat: async () => false, chooseAccountDirectory: async () => fixture.accountDirectory };
    const instance = new wizard.WechatConnectorWizard(fixture.userData, prompts, fixture.home, fake.runtime);

    await assert.rejects(
      instance.capture('fixture-connection', () => {}),
      error => {
        assert.match(error.message, /创建临时微信副本/u);
        assert.match(error.message, /EACCES/u);
        assert.match(error.message, /Permission denied ~/u);
        assert.doesNotMatch(error.message, /\/Users\/tester/u);
        assert.doesNotMatch(error.message, new RegExp(key, 'u'));
        return true;
      }
    );
  });
});

test('captured keys are parsed, deduplicated, and matched against database HMACs', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const key = 'ab'.repeat(32);
    const output = [
      JSON.stringify({ ready: true }),
      JSON.stringify({ wxkey: key }),
      JSON.stringify({ wxkey: key.toUpperCase() }),
      'not json',
      JSON.stringify({ wxkey: 'short' })
    ].join('\n');
    assert.deepEqual(wizard.parseCapturedWechatKeys(output), [key]);
    const applescriptOutput = [
      JSON.stringify({ ready: true }),
      JSON.stringify({ wxkey: key }),
      JSON.stringify({ wxkey: key.toUpperCase() })
    ].join('\r');
    assert.deepEqual(wizard.parseCapturedWechatKeys(applescriptOutput), [key]);

    const account = join(directory, 'wxid_test');
    const storage = join(account, 'db_storage');
    const databasePaths = [
      'contact/contact.db',
      'session/session.db',
      'sns/sns.db',
      'message/message_0.db',
      'message/media_0.db'
    ];
    const encrypted = sqlCipher.encryptWechatDatabaseFixture(
      Buffer.alloc(sqlCipher.WECHAT_PAGE_SIZE), key, Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    );
    for (const path of databasePaths) {
      const target = join(storage, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, encrypted, { mode: 0o600 });
    }

    const mapped = wizard.mapWechatKeysToDatabases(account, [key]);
    assert.equal(mapped.databaseCount, databasePaths.length - 1);
    assert.equal(mapped.missingRequiredCount, 0);
    assert.deepEqual(Object.keys(mapped.keys).sort(), databasePaths
      .filter(path => path !== 'sns/sns.db')
      .map(path => `db_storage/${path}`).sort());
    assert.equal(mapped.keys['db_storage/session/session.db'].salt, '00112233445566778899aabbccddeeff');

    const missing = wizard.mapWechatKeysToDatabases(account, []);
    assert.equal(missing.missingRequiredCount, databasePaths.length - 1);
  });
});

test('capture status parser exposes only known stages and nonnegative key counts', async () => {
  await withWizard(async ({ wizard }) => {
    const key = 'aa'.repeat(32);
    const statuses = wizard.parseWechatCaptureStatuses([
      JSON.stringify({ phase: 'attaching', keyCount: 0 }),
      JSON.stringify({ phase: 'key-count', keyCount: 2, wxkey: key }),
      JSON.stringify({ phase: 'complete', keyCount: -4 }),
      JSON.stringify({ phase: 'unknown', keyCount: 99 }),
      'partial json'
    ].join('\n'));

    assert.deepEqual(statuses, [
      { phase: 'attaching', keyCount: 0 },
      { phase: 'key-count', keyCount: 2 },
      { phase: 'complete', keyCount: 0 }
    ]);
    assert.doesNotMatch(JSON.stringify(statuses), new RegExp(key, 'u'));
  });
});
