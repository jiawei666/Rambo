import { test as base, expect, _electron as electron } from '@playwright/test';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../../..');

export { expect };

const externalApps = ['Finder', 'TextEdit', 'Preview', 'Pages', 'Numbers', 'Keynote'];
const appExecutables = {
  TextEdit: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
  Preview: '/System/Applications/Preview.app/Contents/MacOS/Preview',
  Pages: '/Applications/Pages.app/Contents/MacOS/Pages',
  Numbers: '/Applications/Numbers.app/Contents/MacOS/Numbers',
  Keynote: '/Applications/Keynote.app/Contents/MacOS/Keynote'
};

function installAcceptanceRuntime(profile) {
  const runtimeRoot = join(profile, 'runtime/codex/0.165.0');
  mkdirSync(join(runtimeRoot, 'bin'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'codex-path'), { recursive: true });
  writeFileSync(join(runtimeRoot, 'bin/codex-app-server'), `#!/usr/bin/env node
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const turns = new Map();
const autoCompletes = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function notify(method, params) {
  send({ method, params });
}

function completeTurn(threadId, turnId, status = 'completed', delay = 30) {
  setTimeout(() => {
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, status, error: null }
    });
  }, delay).unref();
}

function clearAutoComplete(threadId, turnId) {
  const key = threadId + ':' + turnId;
  const timer = autoCompletes.get(key);
  if (timer) clearTimeout(timer);
  autoCompletes.delete(key);
}

function resultFor(method, params) {
  if (method === 'initialize') {
    return {
      userAgent: 'codex_cli_rs/0.165.0',
      platformFamily: 'unix',
      platformOs: 'macos'
    };
  }
  if (method === 'config/read') {
    return {
      config: {
        model: 'fixture-model',
        mcp_servers: {},
        features: { apps: false, plugins: false }
      }
    };
  }
  if (method === 'model/list') {
    return {
      data: [{
        id: 'fixture-model',
        model: 'fixture-model',
        displayName: 'Fixture Model',
        isDefault: true
      }, {
        id: 'fixture-model-alt',
        model: 'fixture-model-alt',
        displayName: 'Fixture Model Alt',
        isDefault: false
      }],
      nextCursor: null
    };
  }
  if (method === 'account/read') {
    return { account: { type: 'chatgpt', email: 'fixture@example.com' } };
  }
  if (method === 'account/login/start') {
    return { authUrl: 'https://example.com/rambo-fixture-login' };
  }
  if (method === 'skills/extraRoots/set') return {};
  if (method === 'skills/list') {
    return {
      data: (params?.cwds ?? ['/tmp']).map(cwd => ({ cwd, skills: [], errors: [] }))
    };
  }
  if (method === 'thread/start') {
    const threadId = randomUUID();
    turns.set(threadId, []);
    return { thread: { id: threadId }, model: 'fixture-model', modelProvider: 'openai' };
  }
  if (method === 'thread/resume') {
    const threadId = typeof params?.threadId === 'string' ? params.threadId : randomUUID();
    if (!turns.has(threadId)) turns.set(threadId, []);
    return { thread: { id: threadId }, model: 'fixture-model', modelProvider: 'openai' };
  }
  if (method === 'thread/delete') {
    turns.delete(params?.threadId);
    return {};
  }
  if (method === 'thread/turns/list') {
    return { data: [...(turns.get(params?.threadId) ?? [])] };
  }
  if (method === 'turn/start') {
    const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
    const turnId = randomUUID();
    const text = Array.isArray(params?.input)
      ? params.input.map(item => item?.text ?? '').join('\\n')
      : '';
    const entry = { id: turnId, status: 'inProgress', items: [] };
    const list = turns.get(threadId) ?? [];
    list.push(entry);
    turns.set(threadId, list);
    if (text.includes('隐藏问候 seed') || !text.trim()) {
      const delay = text.trim() ? 2500 : 40;
      const timer = setTimeout(() => {
        autoCompletes.delete(threadId + ':' + turnId);
        entry.status = 'completed';
        notify('turn/started', { threadId, turn: entry });
        completeTurn(threadId, turnId, 'completed', 40);
      }, delay);
      timer.unref();
      autoCompletes.set(threadId + ':' + turnId, timer);
    }
    return { turn: entry };
  }
  if (method === 'turn/steer') {
    clearAutoComplete(params?.threadId, params?.expectedTurnId);
    return { turnId: params?.expectedTurnId };
  }
  if (method === 'turn/interrupt') {
    clearAutoComplete(params?.threadId, params?.turnId);
    const entry = (turns.get(params?.threadId) ?? [])
      .find(turn => turn.id === params?.turnId);
    if (entry) entry.status = 'interrupted';
    if (entry) completeTurn(params.threadId, entry.id, 'interrupted', 20);
    return {};
  }
  if (method === 'thread/realtime/start') {
    return { realtimeSessionId: randomUUID() };
  }
  return {};
}

input.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || !message.method) return;
  try {
    send({ id: message.id, result: resultFor(message.method, message.params) });
  } catch (error) {
    send({
      id: message.id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
    });
  }
});

setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
  writeFileSync(join(runtimeRoot, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version: '0.165.0',
    target: 'aarch64-apple-darwin',
    variant: 'codex-app-server',
    entrypoint: 'bin/codex-app-server',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path'
  }));
  writeFileSync(join(runtimeRoot, 'rambo-runtime.json'), JSON.stringify({
    version: '0.165.0',
    updateChannel: 'manual',
    sessionSource: 'app-server'
  }));
}

function installConfiguredNativeCodexHome(home) {
  const nativeHome = join(home, '.codex');
  mkdirSync(nativeHome, { recursive: true });
  writeFileSync(join(nativeHome, 'config.toml'), 'model = "local-fixture-model"\n');
  writeFileSync(join(nativeHome, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'fixture-not-a-real-token' }
  }));
  const computerUseManifest = join(
    nativeHome,
    'plugins/cache/openai-bundled/computer-use/1.0.0/.codex-plugin'
  );
  mkdirSync(computerUseManifest, { recursive: true });
  writeFileSync(join(computerUseManifest, 'plugin.json'), JSON.stringify({
    name: 'computer-use',
    description: 'Deterministic Computer Use plugin fixture.',
    interface: {
      displayName: 'Computer Use',
      shortDescription: '操作本机应用与桌面的确定性验收插件。'
    }
  }));
  return nativeHome;
}

function osascript(script) {
  return execFileSync('osascript', ['-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 8_000
  }).trim();
}

function externalSnapshot() {
  const rawFinderWindows = osascript(`
    tell application "Finder"
      set outputText to ""
      repeat with candidate in every window
        try
          set windowId to id of candidate
          set targetText to target of candidate as text
          set outputText to outputText & windowId & tab & targetText & linefeed
        end try
      end repeat
      return outputText
    end tell
  `);
  const finderWindows = rawFinderWindows
    .split('\n')
    .map(line => line.split('\t'))
    .filter(([id, target]) => Number.isFinite(Number(id)) && target)
    .map(([id, target]) => ({ id: Number(id), target }));
  return {
    finderWindows,
    processes: new Map(externalApps.map(appName => [appName, processIds(appName)]))
  };
}

function finderWindowIds() {
  const raw = osascript('tell application "Finder" to get id of every window');
  return raw.split(',').map(value => Number(value.trim())).filter(Number.isFinite);
}

function processIds(appName) {
  try {
    const pattern = appExecutables[appName];
    const command = pattern ? ['-f', pattern] : ['-x', appName];
    return execFileSync('pgrep', command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
      .map(value => Number(value))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

function escapeAppleScript(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function closeTestDocumentWindows(run) {
  const pathPrefixes = [run, pathToFileURL(`${run}/`).href].map(escapeAppleScript);
  const matchesTestPath = pathPrefixes
    .map(prefix => `documentUrl starts with "${prefix}"`)
    .join(' or ');
  for (const appName of externalApps) {
    if (appName === 'Finder' || processIds(appName).length === 0) continue;
    try {
      osascript(`
        tell application "System Events"
          tell process "${appName}"
            repeat with candidate in every window
              try
                set documentUrl to value of attribute "AXDocument" of candidate
                if documentUrl is not missing value then
                  if ${matchesTestPath} then click button 1 of candidate
                end if
              end try
            end repeat
          end tell
        end tell
      `);
    } catch {
      // Some applications expose no AXDocument or cannot be closed through AX.
    }
  }
}

function closeTestFinderWindows(run) {
  try {
    const targetPrefix = escapeAppleScript(run);
    const runsTarget = escapeAppleScript(resolve(run, '..'));
    osascript(`
      tell application "Finder"
        repeat with candidate in every window
          try
            set targetText to target of candidate as text
            if targetText starts with "${targetPrefix}" or targetText is "${runsTarget}" then close candidate
          end try
        end repeat
      end tell
    `);
  } catch {
    // Finder cleanup is best effort and must not mask the product test result.
  }
}

function closeFinderWindows(ids) {
  for (const windowId of ids) {
    try {
      osascript(`tell application "Finder" to close window id ${windowId}`);
    } catch {
      // Finder may have already closed this test-owned window.
    }
  }
}

function terminateProcess(processId) {
  try {
    process.kill(processId, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(processId, 0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    } catch {
      return;
    }
  }
  try {
    process.kill(processId, 'SIGKILL');
  } catch {
    // The process exited while the kill deadline was being checked.
  }
}

function processRows() {
  try {
    return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map(match => ({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3]
      }));
  } catch {
    return [];
  }
}

function referencesRun(command, run) {
  let index = command.indexOf(run);
  while (index >= 0) {
    const before = command[index - 1] ?? '';
    const after = command[index + run.length] ?? '';
    if ((!before || /[\s"'=]/u.test(before)) && (!after || /[/\s"']/u.test(after))) {
      return true;
    }
    index = command.indexOf(run, index + 1);
  }
  return false;
}

function processWorkingDirectories() {
  try {
    const output = execFileSync('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn'], {
      encoding: 'utf8'
    });
    const directories = new Map();
    let processId = null;
    for (const line of output.split('\n')) {
      if (line.startsWith('p')) processId = Number(line.slice(1));
      else if (line.startsWith('n') && Number.isInteger(processId)) {
        directories.set(processId, line.slice(1));
      }
    }
    return directories;
  } catch {
    return new Map();
  }
}

function isWithinRun(path, run) {
  if (!path) return false;
  return path === run || path.startsWith(`${run}/`);
}

export function cleanupRunProcesses(run) {
  const marker = resolve(run);
  const workingDirectories = processWorkingDirectories();
  const pids = processRows()
    .filter(row => row.pid !== process.pid &&
      (referencesRun(row.command, marker) ||
        isWithinRun(workingDirectories.get(row.pid), marker)))
    .map(row => row.pid);
  for (const processId of pids) terminateProcess(processId);
  return pids;
}

export function acquireElectronFixtureLease(runs) {
  const path = join(runs, '.electron-fixture-active');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx');
      writeSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`);
      closeSync(descriptor);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = readFileSync(path, 'utf8').trim().replaceAll('\n', ' ');
      const ownerPid = Number(owner.split(' ')[0]);
      if (ownerPid === process.pid) {
        return () => rmSync(path, { force: true });
      }
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
        } catch {
          rmSync(path, { force: true });
          continue;
        }
      }
      throw new Error(`已有 Electron 验收实例正在使用桌面：${owner || path}`);
    }
  }
  throw new Error('无法取得 Electron 验收实例锁');
}

function cleanupExternalApplications(before, launchedExternalProcesses, launchedFinderWindowIds, run) {
  closeTestDocumentWindows(run);
  closeTestFinderWindows(run);
  closeFinderWindows([...launchedFinderWindowIds]);
  for (const appName of externalApps) {
    const originalIds = new Set(before.processes.get(appName) ?? []);
    const launchedIds = new Set(launchedExternalProcesses.get(appName) ?? []);
    for (const processId of processIds(appName)) {
      if (!originalIds.has(processId)) launchedIds.add(processId);
    }
    for (const processId of launchedIds) {
      if (!appName || appName === 'Finder') continue;
      terminateProcess(processId);
    }
  }
}

export async function registerExternalProcessCleanup(acceptanceRun) {
  const before = acceptanceRun.externalBefore;
  if (!before) return;
  await delay(200);
  for (const appName of externalApps) {
    const originals = new Set(before.processes.get(appName) ?? []);
    const launched = acceptanceRun.launchedExternalProcesses.get(appName) ?? new Set();
    for (const processId of processIds(appName)) {
      if (!originals.has(processId)) launched.add(processId);
    }
    acceptanceRun.launchedExternalProcesses.set(appName, launched);
  }
  const originalFinderIds = new Set((before.finderWindows ?? []).map(window => window.id));
  const currentFinderIds = finderWindowIds();
  for (const windowId of currentFinderIds) {
    if (!originalFinderIds.has(windowId)) acceptanceRun.launchedFinderWindowIds.add(windowId);
  }
}

export function createElectronTest(prefix) {
  return base.extend({
    acceptanceRun: [async ({}, use) => {
      let before = { finderWindows: [], processes: new Map() };
      try {
        before = externalSnapshot();
      } catch {
        // System Events can be unavailable in headless or concurrently used macOS sessions.
      }
      const runs = join(root, 'acceptance-runs');
      mkdirSync(runs, { recursive: true });
      const run = realpathSync(mkdtempSync(join(runs, `${prefix}-`)));
      const runId = run.slice(run.lastIndexOf('/') + 1);
      const profile = join(run, 'profile');
      mkdirSync(profile);
      mkdirSync(join(run, 'chromium'));
      const home = join(run, 'home');
      mkdirSync(home);
      installAcceptanceRuntime(profile);
      const nativeCodexHome = installConfiguredNativeCodexHome(home);
      writeFileSync(join(run, 'run.json'), JSON.stringify({
        schema: 'rambo.acceptance.run.v1',
        runId,
        project: root
      }));
      const env = {
        ...process.env,
        RAMBO_ACCEPTANCE_RUN: run,
        HOME: home,
        CODEX_HOME: nativeCodexHome
      };
      delete env.NODE_OPTIONS;
      delete env.ELECTRON_RUN_AS_NODE;
      const evidence = {};
      const launchedExternalProcesses = new Map();
      const launchedFinderWindowIds = new Set();
      try {
        await use({
          run,
          runId,
          profile,
          home,
          nativeCodexHome,
          env,
          evidence,
          externalBefore: before,
          launchedExternalProcesses,
          launchedFinderWindowIds
        });
      } finally {
        cleanupExternalApplications(before, launchedExternalProcesses, launchedFinderWindowIds, run);
        for (const windowId of finderWindowIds()) {
          if (!before.finderWindows.some(window => window.id === windowId)) {
            closeFinderWindows([windowId]);
          }
        }
        cleanupRunProcesses(run);
        rmSync(run, { recursive: true, force: true });
      }
    }, { scope: 'worker' }],

    electron: [async ({ acceptanceRun }, use) => {
      let currentApp = null;
      let currentPage = null;
      let launchCount = 0;

      const launch = async () => {
        launchCount += 1;
        currentApp = await electron.launch({
          executablePath: resolve(
            root,
            'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
          ),
          args: [root, `--user-data-dir=${acceptanceRun.profile}`],
          cwd: root,
          env: acceptanceRun.env
        });
        currentPage = await currentApp.firstWindow();
        const windowCount = await currentApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().length
        );
        expect(windowCount, `Electron 启动时出现了 ${windowCount} 个窗口`).toBe(1);
        await expect(currentPage).toHaveTitle('Rambo');
        await expect(currentPage.getByLabel('创建 Bot')).toBeVisible();
        let modelWaitCount = 0;
        await expect.poll(async () => {
          modelWaitCount += 1;
          const snapshot = await currentPage.evaluate(() => window.rambo.snapshot());
          return Boolean(snapshot.settings.defaultBotModel?.trim()) ||
            modelWaitCount >= 80;
        }, { timeout: 10_000 }).toBe(true);
        return currentPage;
      };

      const close = async () => {
        const app = currentApp;
        currentApp = null;
        currentPage = null;
        if (app) await app.close();
      };

      await launch();
      await use({
        get app() {
          if (!currentApp) throw new Error('Electron 已关闭；请先 restart()');
          return currentApp;
        },
        get page() {
          if (!currentPage) throw new Error('Electron 已关闭；请先 restart()');
          return currentPage;
        },
        get launchCount() {
          return launchCount;
        },
        async restart() {
          await close();
          return launch();
        },
        close
      });
      await close();
    }, { scope: 'worker' }]
  });
}
