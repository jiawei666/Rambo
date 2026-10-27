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
      writeFileSync(join(run, 'run.json'), JSON.stringify({
        schema: 'rambo.acceptance.run.v1',
        runId,
        project: root
      }));
      const env = { ...process.env, RAMBO_ACCEPTANCE_RUN: run };
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
