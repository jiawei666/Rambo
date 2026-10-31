import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const runtimeSourcePath = new URL('../../src/main/runtime.ts', import.meta.url);
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext
};
const runtimeTargetConfigUrl = new URL('../../config/runtime-targets.json', import.meta.url).href;

function compileTypeScriptModule(sourceUrl, { runtimeTarget = false } = {}) {
  let output = ts.transpileModule(readFileSync(sourceUrl, 'utf8'), { compilerOptions }).outputText;
  if (runtimeTarget) {
    output = output.replace(
      "'../../../config/runtime-targets.json'",
      JSON.stringify(runtimeTargetConfigUrl)
    );
  }
  return output.replace(
    /(from\s+['"])(\.[^'"]+)(['"])/gu,
    (match, prefix, specifier, suffix) =>
      specifier.endsWith('.mjs') ? match : `${prefix}${specifier}.mjs${suffix}`
  );
}

const compiledRuntime = compileTypeScriptModule(runtimeSourcePath);

async function withRuntime(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-runtime-test-'));
  const modulePath = join(directory, 'runtime.mjs');
  mkdirSync(join(directory, 'platform'), { recursive: true });
  writeFileSync(
    join(directory, 'runtime-home.mjs'),
    compileTypeScriptModule(new URL('../../src/main/runtime-home.ts', import.meta.url))
  );
  writeFileSync(
    join(directory, 'realtime-audio-bridge.mjs'),
    compileTypeScriptModule(new URL('../../src/main/realtime-audio-bridge.ts', import.meta.url))
  );
  for (const name of ['archive', 'fs', 'process']) {
    writeFileSync(
      join(directory, 'platform', `${name}.mjs`),
      compileTypeScriptModule(new URL(`../../src/main/platform/${name}.ts`, import.meta.url))
    );
  }
  writeFileSync(
    join(directory, 'platform', 'runtime-target.mjs'),
    compileTypeScriptModule(
      new URL('../../src/main/platform/runtime-target.ts', import.meta.url),
      { runtimeTarget: true }
    )
  );
  writeFileSync(modulePath, compiledRuntime, { mode: 0o600 });
  try {
    const { CodexRuntime, resolveRuntimeLayout } = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    await run(CodexRuntime, resolveRuntimeLayout, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met');
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

test('Runtime advertises form elicitation and forwards MCP approval requests', async () => {
  await withRuntime(async (CodexRuntime, _resolveRuntimeLayout, directory) => {
    const resourceRoot = join(directory, 'resource');
    const workingDirectory = join(directory, 'profile');
    const logPath = join(directory, 'rpc.log');
    mkdirSync(workingDirectory);
    const binary = installFixtureRuntime(join(resourceRoot, 'runtime/codex'), '0.163.0');
    writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(logPath)};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  fs.appendFileSync(log, line + '\\n');
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'initialized') {
    process.stdout.write(JSON.stringify({
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'cua_repl',
        threadId: 'thread-elicitation',
        turnId: null,
        mode: 'form',
        message: 'Allow Computer Use to use "Google Chrome"?',
        requestedSchema: {}
      }
    }) + '\\n');
  }
});
`, { mode: 0o755 });

    const runtime = new CodexRuntime(resourceRoot, workingDirectory, spawn, {
      homeDirectory: join(directory, 'home')
    });
    const serverRequests = [];
    runtime.on('serverRequest', request => serverRequests.push(request));
    try {
      await runtime.start();
      await waitFor(() => serverRequests.length === 1);
      const messages = () => readFileSync(logPath, 'utf8').trim().split('\n')
        .map(line => JSON.parse(line));
      const initialize = messages().find(message => message.method === 'initialize');
      assert.deepEqual(initialize.params.capabilities.extensions, {
        'openai/form': {}
      });
      assert.equal(serverRequests[0].method, 'mcpServer/elicitation/request');
      assert.equal(serverRequests[0].params.serverName, 'cua_repl');

      runtime.respondToServerRequest('elicitation-1', { action: 'decline' });
      await waitFor(() => messages().some(message =>
        message.id === 'elicitation-1' &&
        message.result?.action === 'decline'));
    } finally {
      await runtime.stop();
    }
  });
});

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
      assert.deepEqual(spawnCalls[0].args.slice(0, 6), [
        '--listen', 'stdio://', '--session-source', 'app-server',
        '-c', 'cli_auth_credentials_store="file"'
      ]);
      assert.ok(spawnCalls[0].args.includes(
        `sqlite_home=${JSON.stringify(join(workingDirectory, 'codex-home'))}`
      ));
      assert.ok(spawnCalls[0].args.some(argument =>
        /^experimental_realtime_ws_base_url="ws:\/\/127\.0\.0\.1:\d+\/v1\/[A-Za-z0-9_-]+"$/u
          .test(argument)
      ));
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

test('Runtime makes a Node/npm installation discoverable to Codex from a minimal macOS PATH', async () => {
  await withRuntime(async (CodexRuntime, _resolveRuntimeLayout, directory) => {
    let call;
    const resourceRoot = join(directory, 'resource');
    const workingDirectory = join(directory, 'profile');
    const home = join(directory, 'home');
    const npxDirectory = join(home, '.nvm/versions/node/current/bin');
    mkdirSync(workingDirectory);
    mkdirSync(npxDirectory, { recursive: true });
    writeFileSync(join(npxDirectory, 'npx'), '#!/bin/sh\n', { mode: 0o755 });
    symlinkSync(process.execPath, join(npxDirectory, 'node'));
    installFixtureRuntime(join(resourceRoot, 'runtime/codex'), '0.163.0');

    const previousPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const runtime = new CodexRuntime(resourceRoot, workingDirectory, (command, args, options) => {
      call = { command, args, options };
      return spawn(command, args, options);
    }, { homeDirectory: home });
    try {
      await runtime.start();
      const entries = call.options.env.PATH.split(':');
      assert.equal(entries[0], join(resourceRoot, 'runtime/codex/0.163.0/codex-path'));
      assert.equal(entries[1], npxDirectory);
      assert.ok(entries.includes('/usr/bin'));
    } finally {
      process.env.PATH = previousPath;
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

test('Runtime uses the newest managed package across bundled and separately updated copies', async () => {
  await withRuntime(async (_CodexRuntime, resolveRuntimeLayout, directory) => {
    const home = join(directory, 'home');
    installFixtureRuntime(join(home, '.codex/packages/app-server-daemon/releases'), '0.166.0');
    installFixtureRuntime(join(home, '.codex/packages/app-server-daemon/releases'), '0.163.0', 'bin/codex');
    const cacheRoot = join(directory, 'profile/runtime/codex');
    const packagedRoot = join(directory, 'resource/runtime/codex');
    installFixtureRuntime(cacheRoot, '0.164.0');
    installFixtureRuntime(packagedRoot, '0.165.0');
    const layout = await resolveRuntimeLayout(join(directory, 'resource'), join(directory, 'profile'), {
      homeDirectory: home
    });
    assert.equal(layout.source, 'packaged');
    assert.equal(layout.version, '0.165.0');
    assert.equal(layout.binary, join(packagedRoot, '0.165.0/bin/codex-app-server'));

    installFixtureRuntime(cacheRoot, '0.166.0');
    const updated = await resolveRuntimeLayout(join(directory, 'resource'), join(directory, 'profile'), {
      homeDirectory: home
    });
    assert.equal(updated.source, 'cache');
    assert.equal(updated.version, '0.166.0');
    assert.equal(updated.binary, join(cacheRoot, '0.166.0/bin/codex-app-server'));
  });
});

test('Rambo app updates do not replace a separately updated app server', async () => {
  await withRuntime(async (_CodexRuntime, resolveRuntimeLayout, directory) => {
    const cacheRoot = join(directory, 'profile/runtime/codex');
    const packagedRoot = join(directory, 'resource/runtime/codex');
    installFixtureRuntime(cacheRoot, '0.166.0');
    writeFileSync(join(cacheRoot, '0.166.0/rambo-runtime.json'), JSON.stringify({
      version: '0.166.0',
      updateChannel: 'manual',
      sessionSource: 'app-server'
    }));
    installFixtureRuntime(packagedRoot, '0.168.0');
    const layout = await resolveRuntimeLayout(
      join(directory, 'resource'),
      join(directory, 'profile'),
      { homeDirectory: join(directory, 'home') }
    );
    assert.equal(layout.source, 'cache');
    assert.equal(layout.version, '0.166.0');
    assert.equal(layout.binary, join(cacheRoot, '0.166.0/bin/codex-app-server'));
  });
});

test('Runtime never downloads implicitly when no managed app server exists', async () => {
  await withRuntime(async (_CodexRuntime, resolveRuntimeLayout, directory) => {
    await assert.rejects(
      resolveRuntimeLayout(join(directory, 'resource'), join(directory, 'profile'), {
        homeDirectory: join(directory, 'home')
      }),
      /未找到可用的 Codex App Server/
    );
  });
});

test('Runtime manually updates to a newer app server and reports real download progress', async () => {
  await withRuntime(async (CodexRuntime, _resolveRuntimeLayout, directory) => {
    const resourceRoot = join(directory, 'resource');
    const workingDirectory = join(directory, 'profile');
    const cacheRoot = join(workingDirectory, 'runtime/codex');
    mkdirSync(workingDirectory);
    installFixtureRuntime(join(resourceRoot, 'runtime/codex'), '0.165.0');
    const runtime = new CodexRuntime(resourceRoot, workingDirectory, spawn, {
      homeDirectory: join(directory, 'home'),
      latestRuntimeRelease: async () => ({
        version: '0.166.0',
        archiveUrl: 'https://example.invalid/runtime.tar.gz',
        sha256: 'a'.repeat(64),
        publishedAt: null
      }),
      downloadRuntime: async (version, destination, onProgress) => {
        onProgress?.({ phase: 'downloading', downloadedBytes: 0, totalBytes: 10 });
        onProgress?.({ phase: 'downloading', downloadedBytes: 5, totalBytes: 10 });
        onProgress?.({ phase: 'downloading', downloadedBytes: 10, totalBytes: 10 });
        installFixtureRuntime(cacheRoot, version);
        return destination;
      }
    });
    const progress = [];
    runtime.on('state', state => {
      if (state.progress?.phase === 'downloading') progress.push(state.progress);
    });
    try {
      await runtime.start();
      assert.equal(runtime.state.version, '0.165.0');
      assert.equal(runtime.state.source, 'packaged');
      const result = await runtime.updateRuntime();
      assert.deepEqual(progress, [
        { phase: 'downloading', downloadedBytes: 0, totalBytes: null },
        { phase: 'downloading', downloadedBytes: 0, totalBytes: 10 },
        { phase: 'downloading', downloadedBytes: 5, totalBytes: 10 },
        { phase: 'downloading', downloadedBytes: 10, totalBytes: 10 }
      ]);
      assert.deepEqual(result, {
        status: 'updated',
        previousVersion: '0.165.0',
        version: '0.166.0',
        source: 'cache'
      });
      assert.equal(runtime.state.status, 'ready');
      assert.equal(runtime.state.version, '0.166.0');
      assert.equal(runtime.state.source, 'cache');
      assert.equal(runtime.state.progress, null);
      const metadata = JSON.parse(readFileSync(
        join(cacheRoot, '0.166.0/rambo-runtime.json'),
        'utf8'
      ));
      assert.equal(metadata.updateChannel, 'manual');
    } finally {
      await runtime.stop();
    }
  });
});

test('Runtime does not trust a downloaded directory with the wrong package layout', async () => {
  await withRuntime(async (CodexRuntime, _resolveRuntimeLayout, directory) => {
    const resourceRoot = join(directory, 'resource');
    const profile = join(directory, 'profile');
    const cacheRoot = join(profile, 'runtime/codex');
    mkdirSync(profile);
    installFixtureRuntime(join(resourceRoot, 'runtime/codex'), '0.165.0');
    const runtime = new CodexRuntime(resourceRoot, profile, spawn, {
      homeDirectory: join(directory, 'home'),
      latestRuntimeRelease: async () => ({
        version: '0.166.0',
        archiveUrl: 'https://example.invalid/runtime.tar.gz',
        sha256: 'a'.repeat(64),
        publishedAt: null
      }),
      downloadRuntime: async (version, _destination) => {
        installFixtureRuntime(cacheRoot, version, 'bin/codex');
        return '';
      }
    });
    await runtime.start();
    await assert.rejects(
      runtime.updateRuntime(),
      /下载的 Codex App Server 布局无效/
    );
    assert.equal(runtime.state.status, 'ready');
    assert.equal(runtime.state.version, '0.165.0');
    await runtime.stop();
  });
});

test('Runtime propagates App Server update download failures without replacing the running process', async () => {
  await withRuntime(async (CodexRuntime, resolveRuntimeLayout, directory) => {
    const spawnCalls = [];
    const resourceRoot = join(directory, 'resource');
    const profile = join(directory, 'profile');
    mkdirSync(profile);
    installFixtureRuntime(join(resourceRoot, 'runtime/codex'), '0.165.0');
    const spawnProcess = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return spawn(command, args, options);
    };
    const runtime = new CodexRuntime(
      resourceRoot,
      profile,
      spawnProcess,
      {
        homeDirectory: join(directory, 'home'),
        latestRuntimeRelease: async () => ({
          version: '0.166.0',
          archiveUrl: 'https://example.invalid/runtime.tar.gz',
          sha256: 'a'.repeat(64),
          publishedAt: null
        }),
        downloadRuntime: async () => { throw new Error('Codex 运行时 SHA-256 不匹配'); }
      }
    );
    await runtime.start();
    const firstPid = spawnCalls.length;
    await assert.rejects(runtime.updateRuntime(), /SHA-256 不匹配/);
    assert.equal(spawnCalls.length, firstPid);
    assert.equal(runtime.state.status, 'ready');
    assert.equal(runtime.state.version, '0.165.0');
    await runtime.stop();
  });
});

test('Runtime reports a missing managed app server as an error without downloading', async () => {
  await withRuntime(async (CodexRuntime, _resolveRuntimeLayout, directory) => {
    const root = join(directory, 'resource');
    const home = join(directory, 'home');
    const storeDirectory = join(directory, 'store');
    mkdirSync(storeDirectory, { recursive: true });
    const runtime = new CodexRuntime(root, storeDirectory, spawn, {
      homeDirectory: home
    });
    await assert.rejects(runtime.start(), /未找到可用的 Codex App Server/);
    assert.equal(runtime.state.status, 'error');
    assert.match(runtime.state.error, /未找到可用的 Codex App Server/);
  });
});


test('Runtime copies native config into an independent home and keeps the app-server entrypoint', async () => {
  await withRuntime(async (CodexRuntime, _resolve, directory) => {
    const home = join(directory, 'native-user');
    const nativeHome = join(home, '.codex');
    mkdirSync(nativeHome, { recursive: true });
    writeFileSync(join(nativeHome, 'config.toml'), 'model="native-model"');
    writeFileSync(join(nativeHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
    const profile = join(directory, 'profile');
    mkdirSync(profile);
    installFixtureRuntime(join(profile, 'runtime/codex'), '0.164.0');
    let call;
    const runtime = new CodexRuntime(join(directory, 'resource'), profile, (command, args, options) => {
      call = { command, args, options };
      return spawn(command, args, options);
    }, { homeDirectory: home });
    try {
      await Promise.all([runtime.start(), runtime.start()]);
      assert.match(call.command, /profile\/runtime\/codex\/0\.164\.0\/bin\/codex-app-server$/);
      assert.deepEqual(call.args.slice(0, 4), ['--listen', 'stdio://', '--session-source', 'app-server']);
      assert.equal(call.options.env.CODEX_HOME, join(profile, 'codex-home'));
      assert.ok(call.args.includes(`sqlite_home=${JSON.stringify(join(profile, 'codex-home'))}`));
      assert.equal(readFileSync(join(profile, 'codex-home/config.toml'), 'utf8'), 'model="native-model"');
      assert.equal(readFileSync(join(profile, 'codex-home/auth.json'), 'utf8'), '{"auth_mode":"chatgpt"}');
      assert.equal(runtime.homeSyncState.mode, 'follow');
      assert.equal(runtime.homeSyncState.sourceDetected, true);
      assert.ok(runtime.homeSyncState.lastSyncedAt);
    } finally {
      await runtime.stop();
      runtime.dispose();
    }
  });
});

test('Runtime applies model-source overrides and injects the API key only into its Codex child', async () => {
  await withRuntime(async (CodexRuntime, _resolve, directory) => {
    const profile = join(directory, 'profile');
    mkdirSync(profile);
    installFixtureRuntime(join(profile, 'runtime/codex'), '0.164.0');
    let call;
    const runtime = new CodexRuntime(join(directory, 'resource'), profile, (command, args, options) => {
      call = { command, args, options };
      return spawn(command, args, options);
    }, { homeDirectory: join(directory, 'native-user') });
    try {
      runtime.setModelSourceConfig([
        '-c', 'model_provider="rambo_manual"',
        '-c', 'model_providers.rambo_manual={"wire_api":"responses"}'
      ], { RAMBO_MANUAL_API_KEY: 'sk-child-secret' });
      await runtime.start();
      assert.equal(runtime.state.status, 'ready');
      assert.ok(call.args.includes('model_provider="rambo_manual"'));
      assert.ok(call.args.includes('model_providers.rambo_manual={"wire_api":"responses"}'));
      assert.equal(call.options.env.RAMBO_MANUAL_API_KEY, 'sk-child-secret');
      assert.notEqual(process.env.RAMBO_MANUAL_API_KEY, 'sk-child-secret');
      await runtime.stop();
      runtime.setModelSourceConfig([], {});
      await runtime.start();
      assert.ok(!call.args.includes('model_provider="rambo_manual"'));
      assert.equal(call.options.env.RAMBO_MANUAL_API_KEY, undefined);
    } finally {
      await runtime.stop();
      runtime.dispose();
    }
  });
});
