import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assertNativeBuildTarget,
  executableSuffix,
  isSafeArchiveEntry,
  parseBuildTarget,
  pathDelimiter
} from '../../scripts/platform-target.mjs';

test('build targets distinguish the four supported desktop artifacts', () => {
  assert.deepEqual(parseBuildTarget('darwin-arm64'), {
    key: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64'
  });
  assert.equal(parseBuildTarget('win32-x64').platform, 'win32');
  assert.equal(parseBuildTarget('win32-arm64').arch, 'arm64');
  assert.throws(() => parseBuildTarget('linux-x64'), /不支持的构建目标/u);
});

test('native build guard rejects cross-platform resource mixing', () => {
  const target = parseBuildTarget(`${process.platform}-${process.arch}`);
  assert.doesNotThrow(() => assertNativeBuildTarget(target));
  const otherPlatform = process.platform === 'darwin' ? 'win32' : 'darwin';
  assert.throws(
    () => assertNativeBuildTarget(parseBuildTarget(`${otherPlatform}-${process.arch}`)),
    /必须在目标平台上/u
  );
});

test('native executable and PATH conventions are platform-specific', () => {
  assert.equal(executableSuffix('darwin'), '');
  assert.equal(executableSuffix('win32'), '.exe');
  assert.equal(pathDelimiter('darwin'), ':');
  assert.equal(pathDelimiter('win32'), ';');
});

test('Windows package arch is selected by the command, not pinned in builder config', () => {
  const packageJson = JSON.parse(readFileSync(
    new URL('../../package.json', import.meta.url),
    'utf8'
  ));
  assert.deepEqual(packageJson.build.win.target, ['nsis']);
  assert.equal(packageJson.scripts['package:win:arm64:dir'],
    'node scripts/package-desktop.mjs win32 arm64 dir');
});

test('runtime archive paths reject Windows absolute and drive-relative entries', () => {
  assert.equal(isSafeArchiveEntry('bin/codex-app-server.exe'), true);
  assert.equal(isSafeArchiveEntry('C:\\Windows\\System32\\evil.exe'), false);
  assert.equal(isSafeArchiveEntry('C:evil.exe'), false);
  assert.equal(isSafeArchiveEntry('..\\outside.exe'), false);
});
