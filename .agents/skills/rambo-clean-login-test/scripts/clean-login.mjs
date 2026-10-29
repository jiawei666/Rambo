#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const SESSION_SCHEMA = 'rambo.clean-login-test.v1';
const RUN_PREFIX = 'rambo-clean-login-';
const projectRoot = resolve(import.meta.dirname, '../../../..');
const defaultBase = realpathSync('/private/tmp');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    app: { type: 'string' },
    session: { type: 'string' }
  }
});

const command = positionals[0];
if (!['start', 'status', 'cleanup', 'cleanup-all'].includes(command)) {
  usage();
}

if (command === 'start') {
  await start();
} else if (command === 'status') {
  await status(requiredSession());
} else if (command === 'cleanup') {
  await cleanup(requiredSession());
} else {
  await cleanupAll();
}

function usage() {
  console.error(`用法：
  node ${process.argv[1]} start [--app <Rambo.app>]
  node ${process.argv[1]} status --session <临时目录>
  node ${process.argv[1]} cleanup --session <临时目录>
  node ${process.argv[1]} cleanup-all`);
  process.exit(2);
}

function requiredSession() {
  if (!values.session) {
    throw new Error('缺少 --session；先查看 start 输出中的 session 路径');
  }
  return resolve(values.session);
}

async function start() {
  if (process.platform !== 'darwin') throw new Error('此启动器只支持 macOS');

  const appPath = realpathSync(resolve(values.app ?? join(projectRoot, 'dist/mac-arm64/Rambo.app')));
  const info = appInfo(appPath);
  if (!info.packagedRuntimeVersions.length) {
    throw new Error('候选应用没有内置 App Server 运行时；这不是干净新用户的候选包');
  }
  verifyApp(appPath);

  const base = process.env.RAMBO_CLEAN_LOGIN_BASE
    ? realpathSync(resolve(process.env.RAMBO_CLEAN_LOGIN_BASE))
    : defaultBase;
  if (!statSync(base).isDirectory()) throw new Error(`临时目录根不是目录：${base}`);

  const root = realpathSync(mkdtempSync(join(base, RUN_PREFIX)));
  const profile = join(root, 'profile');
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  const sessionPath = join(root, 'session.json');
  for (const directory of [profile, home, temp]) mkdirSync(directory);

  const createdAt = new Date().toISOString();
  const session = {
    schema: SESSION_SCHEMA,
    root,
    projectRoot,
    createdAt,
    appPath,
    appVersion: info.version,
    bundleId: info.bundleId,
    executable: info.executable,
    profile,
    home,
    codexHome: join(home, '.codex'),
    temp,
    stdoutPath,
    stderrPath,
    appPid: null,
    appServerPid: null,
    appServerVersion: info.packagedRuntimeVersions.at(-1) ?? null,
    launchMethod: 'LaunchServices (/usr/bin/open -n -F)'
  };
  writeSession(sessionPath, session);

  const openResult = spawnSync('/usr/bin/open', [
    '-n',
    '-F',
    appPath,
    '--env', `HOME=${home}`,
    '--env', `CODEX_HOME=${join(home, '.codex')}`,
    '--env', `TMPDIR=${temp}/`,
    '--env', 'NODE_OPTIONS',
    '--env', 'ELECTRON_RUN_AS_NODE',
    '--env', 'OPENAI_API_KEY',
    '--env', 'CODEX_API_KEY',
    '--stdout', stdoutPath,
    '--stderr', stderrPath,
    '--args', `--user-data-dir=${profile}`
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (openResult.status !== 0) {
    throw new Error(`LaunchServices 启动失败：${(openResult.stderr || openResult.stdout).trim()}`);
  }

  const appPid = await waitForProfilePid(profile);
  const appCommand = processCommand(appPid);
  if (!appCommand?.includes(`--user-data-dir=${profile}`)) {
    throw new Error(`临时 profile 的 PID ${appPid} 未指向本次 user-data-dir`);
  }
  if (!commandUsesExecutable(appCommand, info.executablePath)) {
    throw new Error(`临时 profile 的 PID ${appPid} 未指向候选应用：${appCommand}`);
  }

  const appServer = await waitForAppServer(appPid, info.executablePath);
  session.appPid = appPid;
  session.appServerPid = appServer.pid;
  session.appServerVersion = appServer.version;
  session.appServerCommand = appServer.command;
  session.startedAt = new Date().toISOString();
  writeSession(sessionPath, session);

  const activation = activateWindow(appPid);
  console.log(JSON.stringify({
    status: 'ready',
    session: root,
    appPath,
    appVersion: info.version,
    bundleId: info.bundleId,
    appPid,
    appServerPid: appServer.pid,
    appServerVersion: appServer.version,
    profile,
    codexHome: session.codexHome,
    stderrPath,
    window: activation
  }, null, 2));
}

async function status(requestedRoot) {
  const session = readSession(requestedRoot);
  const appAlive = pidMatches(session.appPid, command =>
    commandUsesExecutable(command, join(session.appPath, 'Contents/MacOS', session.executable)) &&
    command.includes(`--user-data-dir=${session.profile}`)
  );
  const appServerAlive = pidMatches(session.appServerPid, command =>
    command.includes('/bin/codex-app-server') &&
    command.includes('--session-source app-server') &&
    command.includes(session.profile)
  );
  const stderr = readTail(session.stderrPath);
  const effective = appAlive && appServerAlive ? 'ready' : 'not-running';
  console.log(JSON.stringify({
    status: effective,
    session: session.root,
    appVersion: session.appVersion,
    bundleId: session.bundleId,
    appPid: session.appPid,
    appAlive,
    appServerPid: session.appServerPid,
    appServerVersion: session.appServerVersion,
    appServerAlive,
    stderrTail: stderr
  }, null, 2));
  if (effective !== 'ready') process.exitCode = 1;
}

async function cleanup(requestedRoot, options = {}) {
  const session = readSession(requestedRoot);
  await stopOwnedProcess(session);
  rmSync(session.root, { recursive: true, force: false, maxRetries: 3, retryDelay: 200 });
  if (!options.quiet) console.log(`已删除干净登录测试环境：${session.root}`);
}

async function cleanupAll() {
  const base = process.env.RAMBO_CLEAN_LOGIN_BASE
    ? realpathSync(resolve(process.env.RAMBO_CLEAN_LOGIN_BASE))
    : defaultBase;
  const candidates = readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(RUN_PREFIX))
    .map(entry => join(base, entry.name));
  const results = [];
  for (const candidate of candidates) {
    try {
      await cleanup(candidate, { quiet: true });
      results.push({ session: candidate, cleaned: true });
    } catch (error) {
      results.push({
        session: candidate,
        cleaned: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  console.log(JSON.stringify({ base, results }, null, 2));
  if (results.some(result => !result.cleaned)) process.exitCode = 1;
}

function appInfo(appPath) {
  if (!statSync(appPath).isDirectory()) throw new Error(`候选应用不存在或不是目录：${appPath}`);
  const plist = join(appPath, 'Contents/Info.plist');
  const executable = plistValue(plist, 'CFBundleExecutable');
  const executablePath = join(appPath, 'Contents/MacOS', executable);
  if (!executable || !existsSync(executablePath)) throw new Error(`候选应用可执行文件缺失：${executablePath}`);

  const runtimeRoot = join(appPath, 'Contents/Resources/runtime/codex');
  const packagedRuntimeVersions = existsSync(runtimeRoot)
    ? readdirSync(runtimeRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort(compareVersions)
    : [];
  return {
    version: plistValue(plist, 'CFBundleShortVersionString'),
    bundleId: plistValue(plist, 'CFBundleIdentifier'),
    executable,
    executablePath,
    packagedRuntimeVersions
  };
}

function verifyApp(appPath) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch (error) {
    const stderr = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`候选应用签名校验失败：${stderr}`);
  }
}

function plistValue(plist, key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
    encoding: 'utf8'
  }).trim();
}

function compareVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

async function waitForProfilePid(profile) {
  const lock = join(profile, 'SingletonLock');
  const deadline = Date.now() + 20_000;
  let last = 'SingletonLock 尚未创建';
  while (Date.now() < deadline) {
    try {
      const info = lstatSync(lock);
      if (!info.isSymbolicLink()) throw new Error('SingletonLock 不是符号链接');
      const pid = Number(/-(\d+)$/u.exec(readlinkSync(lock))?.[1]);
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('SingletonLock 未包含有效 PID');
      if (processCommand(pid)) return pid;
      last = 'SingletonLock 指向的进程已退出';
    } catch (error) {
      if (error?.code !== 'ENOENT') last = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
  }
  throw new Error(`启动后未确认隔离 profile 的产品进程：${last}`);
}

async function waitForAppServer(appPid, executablePath) {
  const deadline = Date.now() + 25_000;
  const runtimeHint = `${dirname(dirname(executablePath))}/Resources/runtime/codex/`;
  let last = '尚无 codex-app-server 子进程';
  while (Date.now() < deadline) {
    const table = processTable();
    const descendants = table.filter(process => isDescendant(process.pid, appPid, table));
    const server = descendants.find(process =>
      process.command.includes('/bin/codex-app-server') &&
      process.command.includes('--session-source app-server') &&
      (process.command.includes(runtimeHint) ||
        process.command.includes('/runtime/codex/') && process.command.includes('/codex-home'))
    );
    if (server) {
      const version = /\/runtime\/codex\/([^/]+)\/bin\/codex-app-server/u.exec(server.command)?.[1] ?? null;
      return { ...server, version };
    }
    last = descendants.length
      ? `已发现 ${descendants.length} 个子进程，但尚未出现 App Server`
      : '产品进程尚无可识别子进程';
    await delay(200);
  }
  throw new Error(`启动后未确认 App Server 子进程：${last}`);
}

function activateWindow(pid) {
  const script = `
set wantedPid to ${pid}
tell application "System Events"
  repeat with candidate in application processes
    if (unix id of candidate) is wantedPid then
      set frontmost of candidate to true
      return name of candidate
    end if
  end repeat
end tell
return "not-found"
`;
  try {
    return execFileSync('/usr/bin/osascript', ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8_000
    }).trim();
  } catch (error) {
    return `activation-failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function stopOwnedProcess(session) {
  const appCommand = processCommand(session.appPid);
  if (appCommand && (
    !commandUsesExecutable(appCommand, join(session.appPath, 'Contents/MacOS', session.executable)) ||
    !appCommand.includes(`--user-data-dir=${session.profile}`)
  )) {
    throw new Error(`PID ${session.appPid} 已被其他程序复用，拒绝停止或删除`);
  }
  if (appCommand) {
    process.kill(session.appPid, 'SIGTERM');
    if (!await waitForExit(session.appPid, 10_000)) {
      process.kill(session.appPid, 'SIGKILL');
      if (!await waitForExit(session.appPid, 3_000)) {
        throw new Error(`无法停止测试应用 PID ${session.appPid}`);
      }
    }
  }

  const serverCommand = processCommand(session.appServerPid);
  if (serverCommand) {
    if (!serverCommand.includes('/bin/codex-app-server') ||
        !serverCommand.includes('--session-source app-server') ||
        !serverCommand.includes(session.profile)) {
      throw new Error(`PID ${session.appServerPid} 已被其他程序复用，拒绝停止或删除`);
    }
    process.kill(session.appServerPid, 'SIGTERM');
    if (!await waitForExit(session.appServerPid, 5_000)) {
      process.kill(session.appServerPid, 'SIGKILL');
    }
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processCommand(pid)) return true;
    await delay(150);
  }
  return !processCommand(pid);
}

function writeSession(path, session) {
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

function readSession(requestedRoot) {
  const root = realpathSync(requestedRoot);
  const base = process.env.RAMBO_CLEAN_LOGIN_BASE
    ? realpathSync(resolve(process.env.RAMBO_CLEAN_LOGIN_BASE))
    : defaultBase;
  if (dirname(root) !== base || !basename(root).startsWith(RUN_PREFIX)) {
    throw new Error(`拒绝操作非本 Skill 临时目录：${root}`);
  }
  const sessionPath = join(root, 'session.json');
  if (lstatSync(sessionPath).isSymbolicLink()) throw new Error('session.json 不能是符号链接');
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  if (session.schema !== SESSION_SCHEMA || realpathSync(session.root) !== root ||
      realpathSync(session.projectRoot) !== projectRoot) {
    throw new Error(`无效的 clean-login session：${sessionPath}`);
  }
  for (const key of ['profile', 'home', 'temp']) {
    const target = realpathSync(session[key]);
    if (target !== session[key] || dirname(target) !== root) {
      throw new Error(`session.${key} 不在本次临时根目录：${session[key]}`);
    }
  }
  return session;
}

function processCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch (error) {
    if (error?.status === 1) return null;
    throw error;
  }
}

function processTable() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8'
  }).split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

function isDescendant(pid, ancestorPid, table = processTable()) {
  const parents = new Map(table.map(process => [process.pid, process.ppid]));
  let current = parents.get(pid);
  const visited = new Set();
  while (current && current > 1 && !visited.has(current)) {
    if (current === ancestorPid) return true;
    visited.add(current);
    current = parents.get(current);
  }
  return false;
}

function commandUsesExecutable(command, executablePath) {
  return command === executablePath ||
    command.startsWith(`${executablePath} `) ||
    command.startsWith(`${executablePath}\t`);
}

function pidMatches(pid, predicate) {
  const command = processCommand(pid);
  return Boolean(command && predicate(command));
}

function readTail(path) {
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').split('\n');
  return lines.slice(-30).join('\n').trim();
}
