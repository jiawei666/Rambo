import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { run: { type: 'string' }, app: { type: 'string' }, mode: { type: 'string' } },
  strict: true
});
if (!values.run) throw new Error('用法：node launch.mjs --run acceptance-runs/<run-id> [--mode app|dev]');
if (process.platform !== 'darwin') throw new Error('此启动器针对 macOS');
const root = realpathSync(resolve(values.run));
if (root !== resolve(values.run)) throw new Error('验收目录不能包含符号链接');
const markerPath = join(root, 'run.json');
if (lstatSync(markerPath).isSymbolicLink()) throw new Error('验收标记不能是符号链接');
const run = JSON.parse(readFileSync(markerPath, 'utf8'));
if (run.schema !== 'rambo.acceptance.run.v1' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(run.runId) ||
    typeof run.project !== 'string' || join(realpathSync(run.project), 'acceptance-runs', run.runId) !== root) throw new Error('验收标记无效');
const mode = values.mode ?? run.buildMode ?? 'app';
if (!['app', 'dev'].includes(mode)) throw new Error(`未知运行模式：${mode}`);
if (run.buildMode && mode !== run.buildMode) throw new Error('启动模式与run登记构建模式不一致，请先登记新构建');
const projectPath = realpathSync(run.project);
let appPath = null;
let executablePath;
if (mode === 'app') {
  appPath = realpathSync(resolve(values.app ?? run.appPath));
  if (appPath !== realpathSync(run.appPath)) throw new Error('应用路径与台账不一致，请先登记构建');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(appPath, 'Contents/Resources/app.asar'))) hash.update(chunk);
  if (hash.digest('hex') !== run.buildHash) throw new Error('应用构建已变化，请先运行台账 build 命令');
  const executableName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (!executableName || executableName.includes('/') || executableName.includes('..')) throw new Error('应用可执行文件名称无效');
  executablePath = join(appPath, 'Contents/MacOS', executableName);
} else {
  if (values.app) throw new Error('dev模式不接受 --app');
  const buildRoot = realpathSync(resolve(run.buildRoot ?? projectPath));
  if (buildRoot !== projectPath) throw new Error('开发构建根目录与project不一致');
  const check = execFileSync('python3', [
    join(projectPath, '.agents/skills/rambo-acceptance/scripts/ledger.py'),
    'check-build', '--run', root
  ], { cwd: projectPath, encoding: 'utf8' });
  const build = JSON.parse(check);
  if (build.mode !== 'dev' || build.buildHash !== run.buildHash) throw new Error('开发模式指纹与台账不一致');
  executablePath = join(projectPath, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  if (!lstatSync(executablePath).isFile()) throw new Error('找不到本项目 Electron 开发运行时');
}
for (const directory of ['profile', 'fixtures', 'evidence']) {
  const path = join(root, directory);
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error(`验收目录无效：${directory}`);
}

function processCommand(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch (error) {
    if (error?.status === 1) return null;
    throw error;
  }
}

function commandMatchesExecutable(command) {
  return command === executablePath || command.startsWith(`${executablePath} `) || command.startsWith(`${executablePath}\t`);
}

function profileInstance() {
  const lockPath = join(root, 'profile', 'SingletonLock');
  let info;
  try { info = lstatSync(lockPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    throw error;
  }
  if (!info.isSymbolicLink()) throw new Error('本轮 SingletonLock 不是符号链接；为保护验收 profile，拒绝启动');

  let target;
  try { target = readlinkSync(lockPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    throw error;
  }
  const match = /-(\d+)$/.exec(target);
  const pid = Number(match?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('本轮 SingletonLock 未包含有效 PID；为保护验收 profile，拒绝启动');

  const command = processCommand(pid);
  if (!command) return { state: 'stale', pid };
  return commandMatchesExecutable(command) ? { state: 'active', pid } : { state: 'foreign', pid };
}

const beforeLaunch = profileInstance();
if (beforeLaunch.state === 'active') {
  throw new Error(`本轮验收 profile 已有 Rambo 活动进程 PID ${beforeLaunch.pid}；拒绝重复启动`);
}
if (beforeLaunch.state === 'foreign') {
  throw new Error(`本轮 SingletonLock 指向仍运行的其他可执行文件 PID ${beforeLaunch.pid}；为保护验收 profile，拒绝启动`);
}

const requestedAt = new Date().toISOString();
const cdpPort = 19222;
const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

async function reserveAndReleaseCdpPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(cdpPort, '127.0.0.1', resolveListen);
  }).catch(error => {
    throw new Error(`验收调试端口 ${cdpPort} 已被占用；请停止占用它的进程后重试`, { cause: error });
  });
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
}

async function waitForCdpPage() {
  const deadline = Date.now() + 20_000;
  let lastError = '尚无 Electron 页面 target';
  while (Date.now() < deadline) {
    try {
      const version = await fetch(`${cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (!version.ok) throw new Error(`CDP /json/version 返回 ${version.status}`);
      const response = await fetch(`${cdpEndpoint}/json/list`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) throw new Error(`CDP /json/list 返回 ${response.status}`);
      const targets = await response.json();
      const page = targets.find(target => target.type === 'page' &&
        typeof target.title === 'string' && typeof target.url === 'string' &&
        (target.title === 'Rambo' || target.title.startsWith('Rambo · 验收 ')) &&
        /^(https?:|file:)/.test(target.url));
      if (page) return { targetId: page.id, title: page.title, url: page.url };
      lastError = 'CDP 已响应，但尚未发现标题为 Rambo 的应用页面';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`未能在 ${cdpEndpoint} 确认 Electron 页面：${lastError}`);
}

await reserveAndReleaseCdpPort();
if (mode === 'app') {
  const stderrName = `startup-stderr-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.txt`;
  const stderrPath = join(root, 'evidence', stderrName);
  const stderrFd = openSync(stderrPath, 'wx', 0o600);
  const openArgs = [
    '-n', '-a', appPath,
    '--env', `RAMBO_ACCEPTANCE_RUN=${root}`,
    '--env', `RAMBO_ACCEPTANCE_CDP_PORT=${cdpPort}`,
    '--stderr', stderrPath
  ];
  let launcher;
  try {
    launcher = spawn('/usr/bin/open', openArgs, { cwd: root, stdio: ['ignore', 'ignore', stderrFd] });
  } finally {
    closeSync(stderrFd);
  }
  await new Promise((resolveRequest, rejectRequest) => {
    launcher.once('error', rejectRequest);
    launcher.once('close', code => code === 0
      ? resolveRequest()
      : rejectRequest(new Error(`LaunchServices 启动请求失败（exit ${code}）；检查 ${stderrPath}`)));
  });

  const deadline = Date.now() + 20_000;
  let productPid = null;
  while (Date.now() < deadline) {
    const instance = profileInstance();
    if (instance.state === 'active') {
      productPid = instance.pid;
      break;
    }
    if (instance.state === 'foreign') {
      throw new Error(`启动请求后本轮SingletonLock指向其他可执行文件PID ${instance.pid}；拒绝登记错误进程`);
    }
    await delay(200);
  }
  if (!productPid) throw new Error(`LaunchServices已返回，但未能从本轮SingletonLock和ps确认产品PID；检查 ${stderrPath}`);
  const cdpTarget = await waitForCdpPage();

  writeFileSync(join(root, 'launch.json'), JSON.stringify({
    mode,
    pid: productPid,
    appPath,
    buildHash: run.buildHash,
    profile: join(root, 'profile'),
    runId: run.runId,
    cdpEndpoint,
    cdpPort,
    cdpTarget,
    stderrPath,
    requestedAt,
    launchMethod: 'LaunchServices (/usr/bin/open -n -a)',
    pidSource: 'profile/SingletonLock + ps executable path'
  }, null, 2));
  console.log(`已确认验收应用PID ${productPid}、隔离profile及CDP页面 ${cdpEndpoint}（${cdpTarget.url}）。Playwright MCP 可直接连接；窗口就绪状态以页面实际内容为准。`);
} else {
  const dev = spawn('npm', ['run', 'dev'], {
    cwd: projectPath,
    env: { ...process.env, RAMBO_ACCEPTANCE_RUN: root, RAMBO_ACCEPTANCE_CDP_PORT: String(cdpPort) },
    stdio: 'inherit'
  });
  let childResult = null;
  let resolveChildExit;
  const childExit = new Promise(resolve => { resolveChildExit = resolve; });
  dev.once('error', error => { childResult = { code: 1, signal: null, error }; resolveChildExit(childResult); });
  dev.once('exit', (code, signal) => {
    childResult = { code, signal, error: null };
    resolveChildExit(childResult);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => dev.kill(signal));

  const deadline = Date.now() + 20_000;
  let productPid = null;
  while (Date.now() < deadline && !childResult) {
    const instance = profileInstance();
    if (instance.state === 'active') {
      productPid = instance.pid;
      break;
    }
    if (instance.state === 'foreign') {
      dev.kill('SIGTERM');
      throw new Error(`启动后本轮SingletonLock指向其他可执行文件PID ${instance.pid}；拒绝登记错误进程`);
    }
    await delay(200);
  }
  if (!productPid) {
    dev.kill('SIGTERM');
    await childExit;
    throw new Error(childResult?.error?.message ?? '开发模式启动后20秒内未能从本轮SingletonLock和ps确认产品PID');
  }
  let cdpTarget;
  try {
    cdpTarget = await waitForCdpPage();
  } catch (error) {
    dev.kill('SIGTERM');
    await childExit;
    throw error;
  }

  writeFileSync(join(root, 'launch.json'), JSON.stringify({
    mode,
    pid: productPid,
    projectPath,
    devCommand: 'npm run dev',
    buildHash: run.buildHash,
    profile: join(root, 'profile'),
    runId: run.runId,
    cdpEndpoint,
    cdpPort,
    cdpTarget,
    requestedAt,
    launchMethod: 'npm run dev with RAMBO_ACCEPTANCE_RUN',
    pidSource: 'profile/SingletonLock + ps executable path'
  }, null, 2));
  console.log(`已确认开发模式产品进程PID ${productPid}、隔离profile及CDP页面 ${cdpEndpoint}（${cdpTarget.url}）。Playwright MCP 可直接连接。按Ctrl-C可停止开发服务器。`);
  const result = await childExit;
  if (result.error) throw result.error;
  process.exitCode = result.signal ? 1 : (result.code ?? 1);
}
