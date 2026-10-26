import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const runtimeSourcePath = new URL('../../src/main/runtime.ts', import.meta.url);
const compiledRuntime = ts.transpileModule(readFileSync(runtimeSourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText.replace("from './runtime-home'", "from './runtime-home.mjs'");

async function withRuntime(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-runtime-test-'));
  const modulePath = join(directory, 'runtime.mjs');
  writeFileSync(join(directory, 'runtime-home.mjs'), ts.transpileModule(readFileSync(new URL('../../src/main/runtime-home.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  writeFileSync(modulePath, compiledRuntime, { mode: 0o600 });
  try {
    const { CodexRuntime, resolveRuntimeLayout } = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    await run(CodexRuntime, resolveRuntimeLayout, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function installFixtureRuntime(root, version = '0.163.0', entrypoint = 'bin/codex-app-server') {
  const directory = join(root, version);
  const binary = join(directory, entrypoint);
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, `#!/usr/bin/env node
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  }
});
`, { mode: 0o755 });
  writeFileSync(join(directory, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version,
    target: 'aarch64-apple-darwin',
    variant: entrypoint.endsWith('codex-app-server') ? 'codex-app-server' : 'codex',
    entrypoint,
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path'
  }));
  mkdirSync(join(directory, 'codex-path'), { recursive: true });
  return binary;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('Runtime launches its own Codex child with the isolated session source and stops only that process', async () => {
  await withRuntime(async (CodexRuntime, resolveRuntimeLayout, directory) => {
    const spawnCalls = [];
    const children = [];
    const spawnReal = (command, args, options) => {
      const child = spawn(command, args, options);
      spawnCalls.push({ command, args: [...args], options });
      children.push(child);
      return child;
    };
    const resourceRoot = join(directory, 'resource');
    const workingDirectory = join(directory, 'profile');
    installFixtureRuntime(join(resourceRoot, 'runtime/codex'), '0.163.0');
    mkdirSync(workingDirectory);

    const runtime = new CodexRuntime(resourceRoot, workingDirectory, spawnReal, { homeDirectory: join(directory, 'home') });
    try {
      await runtime.start();
      assert.equal(runtime.state.status, 'ready');
      assert.equal(spawnCalls.length, 1);
      assert.match(spawnCalls[0].command, /runtime\/codex\/0\.163\.0\/bin\/codex-app-server$/);
      assert.deepEqual(spawnCalls[0].args, ['--listen', 'stdio://', '--session-source', 'app-server', '-c', 'cli_auth_credentials_store="file"', '-c', `sqlite_home=${JSON.stringify(join(workingDirectory, 'codex-home'))}`]);
      assert.equal(spawnCalls[0].options.env.CODEX_HOME, join(workingDirectory, 'codex-home'));
      assert.equal(spawnCalls[0].options.env.CODEX_SQLITE_HOME, join(workingDirectory, 'codex-home'));
      assert.equal(spawnCalls[0].options.cwd, workingDirectory);
      assert.equal(spawnCalls[0].options.stdio[0], 'pipe');
      assert.ok(Number.isInteger(children[0].pid));
      assert.equal(processExists(children[0].pid), true);

      const pid = children[0].pid;
      await runtime.stop();
      assert.equal(runtime.state.status, 'stopped');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(processExists(pid), false);
      assert.equal(children.filter(child => processExists(child.pid)).length, 0);
    } finally {
      await runtime.stop();
    }
  });
});

test('Runtime forwards a configured proxy only to its Codex child and keeps loopback direct', async () => {
  await withRuntime(async (CodexRuntime, _resolveRuntimeLayout, directory) => {
    let call;
    const resourceRoot = join(directory, 'resource');
    const workingDirectory = join(directory, 'profile');
    mkdirSync(workingDirectory);
    installFixtureRuntime(join(resourceRoot, 'runtime/codex'), '0.163.0');
    const runtime = new CodexRuntime(resourceRoot, workingDirectory, (command, args, options) => {
      call = { command, args, options };
      return spawn(command, args, options);
    }, {
      homeDirectory: join(directory, 'home'),
      proxyUrl: 'http://127.0.0.1:10808'
    });
    try {
      await runtime.start();
      assert.equal(call.options.env.HTTPS_PROXY, 'http://127.0.0.1:10808');
      assert.equal(call.options.env.HTTP_PROXY, 'http://127.0.0.1:10808');
      assert.equal(call.options.env.ALL_PROXY, 'http://127.0.0.1:10808');
      assert.equal(call.options.env.https_proxy, 'http://127.0.0.1:10808');
      assert.equal(call.options.env.http_proxy, 'http://127.0.0.1:10808');
      assert.equal(call.options.env.all_proxy, 'http://127.0.0.1:10808');
      assert.equal(call.options.env.NO_PROXY, '127.0.0.1,localhost');
      assert.equal(call.options.env.no_proxy, '127.0.0.1,localhost');
    } finally {
      await runtime.stop();
    }
  });
});

test('Runtime resolves a locally installed standalone app server before cache or download', async () => {
  await withRuntime(async (_CodexRuntime, resolveRuntimeLayout, directory) => {
    const home = join(directory, 'home');
    const nativeRoot = join(home, '.codex/packages/app-server-daemon/releases');
    installFixtureRuntime(nativeRoot, '0.164.0');
    installFixtureRuntime(nativeRoot, '0.163.0');
    const cacheRoot = join(directory, 'profile/runtime/codex');
    installFixtureRuntime(cacheRoot, '0.165.0');
    let downloads = 0;
    const layout = await resolveRuntimeLayout(join(directory, 'resource'), join(directory, 'profile'), {
      homeDirectory: home,
      download: async () => { downloads += 1; return ''; }
    });
    assert.equal(layout.source, 'native');
    assert.equal(layout.version, '0.164.0');
    assert.equal(layout.binary, join(nativeRoot, '0.164.0/bin/codex-app-server'));
    assert.equal(downloads, 0);
  });
});

test('Runtime reuses the native bin/codex before a cached standalone app server', async () => {
  await withRuntime(async (_CodexRuntime, resolveRuntimeLayout, directory) => {
    const home = join(directory, 'home');
    const nativeRoot = join(home, '.codex/packages/app-server-daemon/releases');
    installFixtureRuntime(nativeRoot, '0.164.0', 'bin/codex');
    const cacheRoot = join(directory, 'profile/runtime/codex');
    installFixtureRuntime(cacheRoot, '0.163.0');
    let downloads = 0;
    const layout = await resolveRuntimeLayout(join(directory, 'resource'), join(directory, 'profile'), {
      homeDirectory: home,
      download: async () => { downloads += 1; return ''; }
    });
    assert.equal(layout.source, 'native');
    assert.equal(layout.version, '0.164.0');
    assert.equal(layout.binary, join(nativeRoot, '0.164.0/bin/codex'));
    assert.equal(downloads, 0);
  });
});

test('Runtime downloads the pinned standalone app server when neither native nor cache exists', async () => {
  await withRuntime(async (_CodexRuntime, resolveRuntimeLayout, directory) => {
    const cacheRoot = join(directory, 'profile/runtime/codex');
    let requested = '';
    const layout = await resolveRuntimeLayout(join(directory, 'resource'), join(directory, 'profile'), {
      homeDirectory: join(directory, 'home'),
      download: async (version, destination) => {
        requested = `${version}:${destination}`;
        installFixtureRuntime(cacheRoot, version);
        return destination;
      }
    });
    assert.equal(requested, `0.164.0:${join(cacheRoot, '0.164.0')}`);
    assert.equal(layout.source, 'cache');
    assert.equal(layout.version, '0.164.0');
    assert.equal(layout.binary, join(cacheRoot, '0.164.0/bin/codex-app-server'));
  });
});

test('Runtime does not trust a downloaded directory with the wrong package layout', async () => {
  await withRuntime(async (_CodexRuntime, resolveRuntimeLayout, directory) => {
    const cacheRoot = join(directory, 'profile/runtime/codex');
    await assert.rejects(
      resolveRuntimeLayout(join(directory, 'resource'), join(directory, 'profile'), {
        homeDirectory: join(directory, 'home'),
        download: async version => {
          installFixtureRuntime(cacheRoot, version, 'bin/codex');
          return '';
        }
      }),
      /下载的 Codex 运行时布局无效/
    );
  });
});

test('Runtime propagates runtime download and checksum failures without spawning', async () => {
  await withRuntime(async (CodexRuntime, resolveRuntimeLayout, directory) => {
    const spawnCalls = [];
    const spawnProcess = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      throw new Error('spawn must not run');
    };
    await assert.rejects(
      resolveRuntimeLayout(join(directory, 'resource'), join(directory, 'profile'), {
        homeDirectory: join(directory, 'home'),
        download: async () => { throw new Error('Codex 运行时 SHA-256 不匹配'); }
      }),
      /SHA-256 不匹配/
    );
    const runtime = new CodexRuntime(
      join(directory, 'resource'),
      join(directory, 'profile'),
      spawnProcess,
      {
        homeDirectory: join(directory, 'home'),
        download: async () => { throw new Error('Codex 运行时 SHA-256 不匹配'); }
      }
    );
    await assert.rejects(runtime.start(), /SHA-256 不匹配/);
    assert.equal(spawnCalls.length, 0);
  });
});

test('Runtime exposes download failures as an error state', async () => {
  await withRuntime(async (CodexRuntime, _resolveRuntimeLayout, directory) => {
    const root = join(directory, 'resource');
    const home = join(directory, 'home');
    const storeDirectory = join(directory, 'store');
    mkdirSync(storeDirectory, { recursive: true });
    const runtime = new CodexRuntime(root, storeDirectory, spawn, {
      homeDirectory: home,
      exists: path => path === storeDirectory ? true : false,
      download: async () => { throw new Error('网络不可用'); }
    });
    await assert.rejects(runtime.start(), /网络不可用/);
    assert.equal(runtime.state.status, 'error');
    assert.equal(runtime.state.error, '网络不可用');
  });
});


test('Runtime launches the exact native CLI with an independent home and explicit SQLite override', async () => {
  await withRuntime(async (CodexRuntime, _resolve, directory) => {
    const home = join(directory, 'native-user');
    const binary = installFixtureRuntime(join(home, '.codex/packages/app-server-daemon/releases'), '0.164.0', 'bin/codex');
    const profile = join(directory, 'profile');
    mkdirSync(profile);
    let call;
    const runtime = new CodexRuntime(join(directory, 'resource'), profile, (command, args, options) => {
      call = { command, args, options };
      return spawn(command, args, options);
    }, { homeDirectory: home });
    try {
      await Promise.all([runtime.start(), runtime.start()]);
      assert.equal(call.command, binary);
      assert.deepEqual(call.args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
      assert.ok(!call.args.includes('--session-source'));
      assert.equal(call.options.env.CODEX_HOME, join(profile, 'codex-home'));
      assert.ok(call.args.includes(`sqlite_home=${JSON.stringify(join(profile, 'codex-home'))}`));
      await runtime.stop();
      const updatedBinary = installFixtureRuntime(join(home, '.codex/packages/app-server-daemon/releases'), '0.165.0', 'bin/codex');
      await runtime.start();
      assert.equal(runtime.state.status, 'ready');
      assert.equal(call.command, updatedBinary);
    } finally { await runtime.stop(); }
  });
});
