import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
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
const moduleSources = [
  ['platform/paths', 'platform/paths'],
  ['platform/fs', 'platform/fs'],
  ['wechat-platform-types', 'wechat-platform-types'],
  ['wechat-image-key', 'wechat-image-key'],
  ['wechat-connector-common', 'wechat-connector-common'],
  ['wechat-connector-macos', 'wechat-connector-macos'],
  ['wechat-connector-windows', 'wechat-connector-windows'],
  ['wechat-connector-wizard', 'wechat-connector-wizard'],
  ['wechat-sqlcipher', 'wechat-sqlcipher']
];
const compiledModules = new Map(await Promise.all(moduleSources.map(async ([name, sourceName]) => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL(`../../src/main/${sourceName}.ts`, import.meta.url), 'utf8')
  );
  const output = ts.transpileModule(source, { compilerOptions }).outputText
    .replaceAll(/from '(\.\/wechat-[^']+)'/gu, "from '$1.mjs'")
    .replaceAll("from './platform/paths'", "from './platform/paths.mjs'")
    .replaceAll("from './platform/fs'", "from './platform/fs.mjs'")
    .replaceAll("from '@xmldom/xmldom'", `from '${xmldomEntry}'`);
  return [name, output];
})));

async function withWizard(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-wechat-wizard-test-'));
  mkdirSync(join(directory, 'platform'));
  for (const [name, output] of compiledModules) {
    writeFileSync(join(directory, `${name}.mjs`), output, { mode: 0o600 });
  }
  try {
    const imported = {};
    for (const [name] of moduleSources) {
      imported[name] = await import(
        `${pathToFileURL(join(directory, `${name}.mjs`)).href}?${Date.now()}-${name}`
      );
    }
    await run({
      wizard: imported['wechat-connector-wizard'],
      mac: imported['wechat-connector-macos'],
      windows: imported['wechat-connector-windows'],
      sqlCipher: imported['wechat-sqlcipher'],
      directory
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createCaptureFixture(
  sqlCipher,
  directory,
  key,
  keyForDatabase = () => key,
  version = '4.1.15',
  build = '270135'
) {
  const home = join(directory, 'fixture-home');
  const userData = join(directory, 'fixture-user-data');
  const sourceApp = join(home, 'Applications', 'WeChat.app');
  const info = `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>com.tencent.xinWeChat</string>
    <key>CFBundleShortVersionString</key><string>${version}</string>
    <key>CFBundleVersion</key><string>${build}</string>
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

function createWindowsCaptureFixture(sqlCipher, directory, key) {
  const appData = join(directory, 'windows-app-data');
  const documents = join(directory, 'windows-documents');
  const xwechatRoot = join(documents, 'xwechat_files');
  const accountDirectory = join(xwechatRoot, 'wxid_windows');
  const databasePaths = [
    'contact/contact.db',
    'session/session.db',
    'message/message_0.db',
    'message/media_0.db'
  ];
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const encrypted = sqlCipher.encryptWechatDatabaseFixture(
    Buffer.alloc(sqlCipher.WECHAT_PAGE_SIZE),
    key,
    salt
  );
  for (const path of databasePaths) {
    const target = join(accountDirectory, 'db_storage', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, encrypted, { mode: 0o600 });
  }
  const configDirectory = join(appData, 'Tencent', 'xwechat', 'config');
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, 'account.ini'), documents, { mode: 0o600 });
  const scannerPath = join(directory, 'rambo-wechat-key-scanner.exe');
  writeFileSync(scannerPath, '', { mode: 0o700 });
  return {
    appData,
    documents,
    xwechatRoot,
    accountDirectory,
    scannerPath,
    key,
    salt: salt.toString('hex')
  };
}

function writeV2ImageFixture(accountDirectory, accountId, code) {
  const aesKey = createHash('md5')
    .update(`${code}${accountId}`)
    .digest('hex')
    .slice(0, 16);
  const xorKey = code & 0xff;
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const raw = Buffer.from('legacy-raw');
  const tail = Buffer.from('xor-tail');
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii'), null);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const header = Buffer.alloc(15);
  Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]).copy(header);
  header.writeUInt32LE(plain.length, 6);
  header.writeUInt32LE(tail.length, 10);
  const directory = join(accountDirectory, 'msg', 'attach', 'session-hash', '2026-10', 'Img');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'sample_h.dat'), Buffer.concat([
    header,
    encrypted,
    raw,
    Buffer.from(tail.map(value => value ^ xorKey))
  ]), { mode: 0o600 });
  return { aesKey, xorKey };
}

function captureRuntime({
  sourceApp,
  info,
  accountDirectory,
  key,
  roundKeys = [[key]],
  uvPath,
  pythonPath,
  failCopy = false,
  originalRunning = false,
  managedClone = false,
  officialSession = false,
  officialAttachable = false,
  captureKind = 'aes-key',
  officialAttachFailure = false,
  imageCodes = []
}) {
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
  let directCaptureArgs = [];
  let captureHook = '';
  let captureDriver = '';
  let copyCalled = false;
  let resignCalled = false;
  let uvCalled = false;
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
        send({ type: 'key', kind: captureKind, value, keyCount: sentKeys.size });
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
      send({ type: 'image-codes', values: imageCodes });
      if (officialAttachFailure) {
        send({ type: 'status', phase: 'attaching', keyCount: 0 });
        send({ type: 'status', phase: 'failed', keyCount: 0, error: 'PermissionDeniedError' });
        terminal = true;
        socket.end();
        return;
      }
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
    directCaptureArgs: () => directCaptureArgs,
    captureHook: () => captureHook,
    captureDriver: () => captureDriver,
    copyCalled: () => copyCalled,
    resignCalled: () => resignCalled,
    uvCalled: () => uvCalled,
    runtime: {
      platform: 'darwin',
      runFile: async (file, args, options = {}) => {
        if (file === uvPath) {
          uvCalled = true;
          return { stdout: JSON.stringify({ python: pythonPath, version: '16.7.19' }), stderr: '' };
        }
        if (file === '/usr/bin/plutil') return { stdout: info, stderr: '' };
        if (file === '/usr/bin/codesign') {
          if (args.includes('--force')) resignCalled = true;
          if (args[0] === '-d' && args.includes('--verbose=4')) {
            return { stdout: 'Authority=Developer ID Application: Tencent Developer\nTeamIdentifier=AB12CD34EF', stderr: '' };
          }
          if (args[0] === '-d' && args.includes('--entitlements')) {
            entitlementReadCount += 1;
            const value = managedClone || officialAttachable || entitlementReadCount > 1
              ? '<true/>'
              : '<false/>';
            return {
              stdout: `<plist><dict><key>com.apple.security.get-task-allow</key>${value}</dict></plist>`,
              stderr: ''
            };
          }
          return { stdout: '', stderr: '' };
        }
        if (file === '/bin/cp') {
          copyCalled = true;
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
        if (officialSession && file === pythonPath) {
          directCaptureArgs = args;
          captureCommand = args.join(' ');
          osascriptTimeout = options.timeout ?? null;
          captureHook = readFileSync(args[2], 'utf8');
          captureDriver = readFileSync(args[1], 'utf8');
          return runFakeCaptureDriver(Number(args[4]), args[5]);
        }
        throw new Error(`Unexpected command in test: ${file}`);
      },
      spawn: executable => {
        if (executable === '/usr/bin/open') reopened = true;
        spawnedExecutable = executable;
        return { pid: 777, unref() {} };
      },
      processIds: async () => {
        if (officialSession) return [777];
        if (!originalRunning) return [];
        return processCheckCount++ === 0 ? [101] : [];
      },
      processCommand: async () => officialSession
        ? join(sourceApp, 'Contents', 'MacOS', 'WeChat')
        : spawnedExecutable,
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
    const match = /^已捕获 (\d+) 个/u.exec(state.message);
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
  await withWizard(async ({ mac }) => {
    const original = `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>com.apple.application-identifier</key><string>TEAM.com.tencent.xinWeChat</string>
      <key>com.apple.security.get-task-allow</key><false/>
    </dict></plist>`;
    const changed = mac.withGetTaskAllow(original);
    assert.match(changed, /com\.apple\.application-identifier/u);
    assert.match(changed, /TEAM\.com\.tencent\.xinWeChat/u);
    assert.match(changed, /<true\s*\/>/u);
    assert.doesNotMatch(changed, /<false\s*\/>/u);
    assert.equal((changed.match(/com\.apple\.security\.get-task-allow/gu) ?? []).length, 1);
  });
});

test('WeChat Info.plist string fields are parsed with xmldom sibling nodes', async () => {
  await withWizard(async ({ mac }) => {
    const plist = '<plist><dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.tencent.xinWeChat</string>\n</dict></plist>';
    assert.equal(mac.parsePlistString(plist, 'CFBundleIdentifier'), 'com.tencent.xinWeChat');
  });
});

test('post-signing entitlement verification recognizes get-task-allow', async () => {
  await withWizard(async ({ mac }) => {
    const plist = '<plist><dict>\n  <key>com.apple.security.get-task-allow</key>\n  <true/>\n</dict></plist>';
    assert.equal(mac.hasGetTaskAllow(plist), true);
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
      backend: 'managed-clone',
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
    assert.ok(progress.includes('已捕获 1 个候选密钥；内容只在本机内存中处理。'));
    assert.doesNotMatch(JSON.stringify(progress), new RegExp(key, 'u'));
    assert.deepEqual([...new Set(phases)], ['checking', 'closing', 'selecting-account', 'copying', 'signing', 'launching', 'capturing', 'verifying']);
    assert.equal(fake.stoppedClone()?.pid, 777);
    assert.equal(fake.quitCalled(), true);
    assert.equal(fake.reopened(), true);
    assert.ok(fake.stoppedClone()?.captureRoot.includes('managed-wechat-capture'));
    assert.equal(existsSync(fake.stoppedClone()?.captureRoot), false);
  });
});

test('capture accepts a verified WeChat 4.2 source with a fresh managed clone', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const key = '4a'.repeat(32);
    const fixture = createCaptureFixture(
      sqlCipher,
      directory,
      key,
      () => key,
      '4.2.0',
      '270348'
    );
    const image = writeV2ImageFixture(fixture.accountDirectory, 'wxid_test', 0x1234);
    const fake = captureRuntime({
      ...fixture,
      key,
      originalRunning: true,
      imageCodes: [0, 0x1234]
    });
    const progress = [];
    const instance = new wizard.WechatConnectorWizard(
      fixture.userData,
      {
        confirmCloseWechat: async () => true,
        chooseAccountDirectory: async () => fixture.accountDirectory
      },
      fixture.home,
      fake.runtime,
      { backend: 'managed-clone', captureSeconds: 300 }
    );

    const captured = await captureWithAutomaticRoundControls(
      instance,
      'wechat-4-2-connection',
      state => progress.push(state.message)
    );

    assert.equal(captured.wechatVersion, '4.2.0');
    assert.equal(captured.wechatBuild, '270348');
    assert.deepEqual(captured.imageKey, image);
    assert.equal(fake.copyCalled(), true);
    assert.equal(fake.resignCalled(), true);
    assert.ok(progress.some(message => message.includes('4.1.x/4.2.x')));
    assert.doesNotMatch(JSON.stringify(progress), new RegExp(key, 'u'));
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
      backend: 'managed-clone',
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
      backend: 'managed-clone',
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
    const instance = new wizard.WechatConnectorWizard(fixture.userData, prompts, fixture.home, fake.runtime, {
      backend: 'managed-clone'
    });

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

test('Windows memory backend scans raw AES keys without copying, signing, or fallback', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const key = '7a'.repeat(32);
    const fixture = createWindowsCaptureFixture(sqlCipher, directory, key);
    const calls = [];
    const prompts = {
      confirmCloseWechat: async () => {
        throw new Error('Windows backend must not close WeChat');
      },
      chooseAccountDirectory: async () => {
        throw new Error('a single detected Windows account should be selected automatically');
      }
    };
    const instance = new wizard.WechatConnectorWizard(
      join(directory, 'windows-user-data'),
      prompts,
      fixture.documents,
      {
        platform: 'win32',
        environment: {
          APPDATA: fixture.appData,
          USERPROFILE: fixture.documents
        },
        windowsAppDataDirectory: fixture.appData,
        windowsDocumentsDirectory: fixture.documents,
        windowsScannerPath: fixture.scannerPath,
        windowsWechatVersionInfo: {
          version: '4.1.15',
          build: '270135'
        },
        runFile: async (file, args) => {
          calls.push({ file, args });
          assert.equal(file, fixture.scannerPath);
          return {
            stdout: [
              JSON.stringify({ type: 'status', phase: 'scanning', candidateCount: 0 }),
              JSON.stringify({
                type: 'candidate',
                key: fixture.key,
                salt: fixture.salt
              }),
              JSON.stringify({ type: 'status', phase: 'complete', candidateCount: 1 })
            ].join('\n'),
            stderr: ''
          };
        }
      }
    );
    const phases = [];
    const messages = [];
    const captured = await instance.capture('windows-memory', state => {
      phases.push(state.phase);
      messages.push(state.message);
    });

    assert.equal(instance.backend, 'windows-memory');
    assert.equal(captured.accountId, 'wxid_windows');
    assert.equal(captured.wechatVersion, '4.1.15');
    assert.equal(captured.wechatBuild, '270135');
    assert.equal(Object.keys(captured.keys).length, 4);
    assert.ok(Object.values(captured.keys).every(value => value.encKey === key));
    assert.deepEqual(
      [...new Set(phases)],
      ['checking', 'capturing', 'verifying', 'complete']
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 2), ['--timeout-ms', '75000']);
    assert.doesNotMatch(JSON.stringify(messages), new RegExp(key, 'u'));
    assert.ok(messages.some(message => message.includes('不会复制、重签或修改微信')));
  });
});

test('Windows scanner timeout is surfaced through the capture flow', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const key = '5f'.repeat(32);
    const fixture = createWindowsCaptureFixture(sqlCipher, directory, key);
    const messages = [];
    const instance = new wizard.WechatConnectorWizard(
      join(directory, 'windows-user-data'),
      {
        confirmCloseWechat: async () => true,
        chooseAccountDirectory: async () => fixture.accountDirectory
      },
      fixture.documents,
      {
        platform: 'win32',
        windowsAppDataDirectory: fixture.appData,
        windowsDocumentsDirectory: fixture.documents,
        windowsScannerPath: fixture.scannerPath,
        runFile: async () => ({
          stdout: JSON.stringify({
            type: 'status',
            phase: 'timeout',
            candidateCount: 0
          }),
          stderr: ''
        })
      }
    );

    await assert.rejects(
      instance.capture('windows-timeout', state => messages.push(state.message)),
      /Windows 微信内存扫描超时/u
    );
    assert.ok(messages.some(message => message.includes('不会复制、重签或修改微信')));
    assert.doesNotMatch(JSON.stringify(messages), new RegExp(key, 'u'));
  });
});

test('Windows account selection accepts a db_storage directory for a multi-account root', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const key = '6d'.repeat(32);
    const fixture = createWindowsCaptureFixture(sqlCipher, directory, key);
    const secondAccount = join(fixture.xwechatRoot, 'wxid_second');
    cpSync(join(fixture.accountDirectory, 'db_storage'), join(secondAccount, 'db_storage'), {
      recursive: true
    });
    const prompts = {
      confirmCloseWechat: async () => {
        throw new Error('Windows backend must not close WeChat');
      },
      chooseAccountDirectory: async () => join(secondAccount, 'db_storage')
    };
    const instance = new wizard.WechatConnectorWizard(
      join(directory, 'windows-user-data'),
      prompts,
      fixture.documents,
      {
        platform: 'win32',
        windowsAppDataDirectory: fixture.appData,
        windowsDocumentsDirectory: fixture.documents,
        windowsScannerPath: fixture.scannerPath,
        windowsWechatVersionInfo: {
          version: '4.1.15',
          build: '270135'
        },
        runFile: async () => ({
          stdout: [
            JSON.stringify({ type: 'candidate', key: fixture.key, salt: fixture.salt }),
            JSON.stringify({ type: 'status', phase: 'complete', candidateCount: 1 })
          ].join('\n'),
          stderr: ''
        })
      }
    );

    const captured = await instance.capture('windows-multi-account', () => {});
    assert.equal(captured.accountId, 'wxid_second');
    assert.equal(captured.dataDirectory, realpathSync(secondAccount));
    assert.equal(Object.keys(captured.keys).length, 4);
  });
});

test('Windows scanner failures redact keys and give an elevation hint', async () => {
  await withWizard(async ({ wizard, sqlCipher, directory }) => {
    const key = '8b'.repeat(32);
    const fixture = createWindowsCaptureFixture(sqlCipher, directory, key);
    const instance = new wizard.WechatConnectorWizard(
      join(directory, 'windows-user-data'),
      {
        confirmCloseWechat: async () => true,
        chooseAccountDirectory: async () => fixture.accountDirectory
      },
      fixture.documents,
      {
        platform: 'win32',
        windowsAppDataDirectory: fixture.appData,
        windowsDocumentsDirectory: fixture.documents,
        windowsScannerPath: fixture.scannerPath,
        runFile: async () => {
          throw Object.assign(new Error('scanner failed'), {
            code: 'EACCES',
            stderr: `OpenProcess failed ${key} C:\\Users\\tester\\Weixin.exe`
          });
        }
      }
    );

    await assert.rejects(
      instance.capture('windows-scan-failure', () => {}),
      error => {
        assert.match(error.message, /管理员身份运行 Rambo/u);
        assert.match(error.message, /<用户目录>/u);
        assert.doesNotMatch(error.message, new RegExp(key, 'u'));
        assert.doesNotMatch(error.message, /C:\\Users\\tester/u);
        return true;
      }
    );
  });
});

test('Windows account root parser accepts MyDocument and absolute paths', async () => {
  await withWizard(async ({ windows }) => {
    const documents = join(tmpdir(), 'rambo-windows-documents');
    assert.equal(
      windows.parseWindowsWechatDataRoot('MyDocument:\\\r\n', documents),
      documents
    );
    assert.equal(
      windows.parseWindowsWechatDataRoot('D:\\WeChatFiles', documents),
      'D:\\WeChatFiles'
    );
    assert.equal(windows.parseWindowsWechatDataRoot('relative/path', documents), null);
  });
});

test('Windows scanner output parser keeps only bounded valid candidates', async () => {
  await withWizard(async ({ windows }) => {
    const key = '9c'.repeat(32);
    const salt = 'de'.repeat(16);
    const parsed = windows.parseWindowsScannerOutput([
      JSON.stringify({ type: 'candidate', key: key.toUpperCase(), salt }),
      JSON.stringify({ type: 'candidate', key, salt }),
      JSON.stringify({ type: 'candidate', key: 'short', salt }),
      JSON.stringify({ type: 'status', candidateCount: 2 }),
      'not json'
    ].join('\n'));
    assert.deepEqual(parsed, {
      candidates: [{ key, salt }],
      reportedCount: 2,
      timedOut: false
    });
  });
});

test('Windows scanner output parser surfaces an explicit timeout', async () => {
  await withWizard(async ({ windows }) => {
    const parsed = windows.parseWindowsScannerOutput(
      JSON.stringify({ type: 'status', phase: 'timeout', candidateCount: 0 })
    );
    assert.deepEqual(parsed, {
      candidates: [],
      reportedCount: 0,
      timedOut: true
    });
  });
});

test('explicit backend cannot override the current platform adapter', async () => {
  await withWizard(async ({ wizard }) => {
    assert.throws(
      () => new wizard.WechatConnectorWizard(
        join(tmpdir(), 'rambo-platform-mismatch'),
        {
          confirmCloseWechat: async () => true,
          chooseAccountDirectory: async () => null
        },
        tmpdir(),
        { platform: 'win32' },
        { backend: 'managed-clone' }
      ),
      /后端与当前操作系统不匹配/u
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
