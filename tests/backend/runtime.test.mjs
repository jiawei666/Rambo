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
}).outputText;

async function withRuntime(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-runtime-test-'));
  const modulePath = join(directory, 'runtime.mjs');
  writeFileSync(modulePath, compiledRuntime, { mode: 0o600 });
  try {
    const { CodexRuntime } = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    await run(CodexRuntime, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function installFixtureServer(resourceRoot) {
  const binary = join(resourceRoot, 'runtime/codex/0.163.0/bin/codex-app-server');
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
  await withRuntime(async (CodexRuntime, directory) => {
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
    mkdirSync(dirname(installFixtureServer(resourceRoot)), { recursive: true });
    mkdirSync(workingDirectory);

    const runtime = new CodexRuntime(resourceRoot, workingDirectory, spawnReal);
    try {
      await runtime.start();
      assert.equal(runtime.state.status, 'ready');
      assert.equal(spawnCalls.length, 1);
      assert.match(spawnCalls[0].command, /runtime\/codex\/0\.163\.0\/bin\/codex-app-server$/);
      assert.deepEqual(spawnCalls[0].args, ['--listen', 'stdio://', '--session-source', 'app-server']);
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

test('Runtime metadata declares the upstream app-server session source', () => {
  const root = new URL('../..', import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL('runtime/codex/0.163.0/rambo-runtime.json', root), 'utf8'));
  assert.equal(metadata.source, 'openai/codex rust-v0.163.0');
  assert.equal(metadata.sessionSource, 'app-server');
});
