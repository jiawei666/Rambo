import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const app = process.env.RAMBO_APP_PATH
  ? resolve(process.env.RAMBO_APP_PATH)
  : join(root, 'dist/mac-arm64/Rambo.app');
const sourceRuntime = join(root, 'runtime/codex/0.163.0');
const bundledRuntime = join(
  app,
  'Contents/Resources/runtime/codex/0.163.0'
);
const files = [
  'bin/codex-app-server',
  'bin/codex-code-mode-host',
  'codex-path/rg',
  'codex-package.json',
  'rambo-runtime.json'
];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(path, args) {
  const result = execFileSync(path, args, {
    encoding: 'utf8',
    timeout: 5_000
  });
  return `${result.stdout ?? result}`.trim();
}

function signatureIdentity(path) {
  return execFileSync(
    '/bin/zsh',
    ['-c', 'codesign "$1" -dv --verbose=4 2>&1', 'code-signature', path],
    { encoding: 'utf8', timeout: 5_000 }
  );
}

function requireCandidate() {
  assert.ok(existsSync(app), `候选应用不存在：${app}`);
  assert.ok(existsSync(bundledRuntime), `候选运行时不存在：${bundledRuntime}`);
}

test('候选应用包含固定版本的 Codex 运行时和全部必要配套文件', () => {
  requireCandidate();
  for (const relativePath of files) {
    const packaged = join(bundledRuntime, relativePath);
    assert.ok(existsSync(packaged), `候选包缺少运行时文件：${relativePath}`);
    assert.equal(lstatSync(packaged).isFile(), true, `${relativePath} 必须是普通文件`);
    assert.equal(lstatSync(packaged).isSymbolicLink(), false, `${relativePath} 不能是符号链接`);
    if (relativePath.endsWith('.json')) {
      assert.equal(
        sha256(packaged),
        sha256(join(sourceRuntime, relativePath)),
        `${relativePath} 与源码运行时哈希不一致`
      );
    }
  }
  for (const relativePath of files.filter(path => !path.endsWith('.json'))) {
    assert.notEqual(
      lstatSync(join(bundledRuntime, relativePath)).mode & 0o111,
      0,
      `${relativePath} 缺少可执行权限`
    );
  }
});

test('候选运行时清单、固定来源和二进制版本互相一致', () => {
  requireCandidate();
  const packageManifest = JSON.parse(
    readFileSync(join(bundledRuntime, 'codex-package.json'), 'utf8')
  );
  const runtimeManifest = JSON.parse(
    readFileSync(join(bundledRuntime, 'rambo-runtime.json'), 'utf8')
  );
  const server = join(bundledRuntime, 'bin/codex-app-server');
  const host = join(bundledRuntime, 'bin/codex-code-mode-host');
  const rg = join(bundledRuntime, 'codex-path/rg');

  assert.equal(packageManifest.version, '0.163.0');
  assert.equal(packageManifest.target, 'aarch64-apple-darwin');
  assert.equal(packageManifest.variant, 'codex-app-server');
  assert.equal(packageManifest.entrypoint, 'bin/codex-app-server');
  assert.equal(packageManifest.resourcesDir, 'codex-resources');
  assert.equal(packageManifest.pathDir, 'codex-path');
  assert.equal(runtimeManifest.version, '0.163.0');
  assert.equal(runtimeManifest.source, 'openai/codex rust-v0.163.0');
  assert.equal(runtimeManifest.sessionSource, 'app-server');
  assert.match(run(server, ['--version']), /(?:\b|-)0\.163\.0\b/);
  assert.match(run(rg, ['--version']), /^ripgrep 15\.2\.0/m);
  assert.match(run(host, ['--help']), /stdio/);
});

test('候选 Codex 二进制是 arm64 且保留有效签名', () => {
  requireCandidate();
  for (const [relativePath, identifier] of [
    ['bin/codex-app-server', /Identifier=codex-app-server/],
    ['bin/codex-code-mode-host', /Identifier=codex-code-mode-host/],
    ['codex-path/rg', /Identifier=rg/]
  ]) {
    const packaged = join(bundledRuntime, relativePath);
    const identity = signatureIdentity(packaged);
    assert.match(identity, identifier);
    assert.match(identity, /Authority=Apple Development:/);
    assert.equal(
      run('/usr/bin/lipo', ['-archs', packaged]),
      'arm64',
      `${relativePath} 不是 arm64`
    );
    execFileSync('codesign', ['--verify', '--strict', packaged], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }
});
