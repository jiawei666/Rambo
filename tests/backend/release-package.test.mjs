import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  detectBinaryArchitecture,
  parseReleaseTargets,
  releaseArtifactName,
  releasePackageCommand,
  verifyPackagedRuntime
} from '../../.agents/skills/rambo-release/scripts/release-utils.mjs';

function machOBuffer(cpuType) {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpuType, 4);
  return buffer;
}

function peBuffer(machine) {
  const buffer = Buffer.alloc(256);
  buffer[0] = 0x4d;
  buffer[1] = 0x5a;
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

test('release targets require both macOS and Windows and use platform-neutral metadata names', () => {
  assert.deepEqual(parseReleaseTargets('darwin-arm64,win32-x64'), ['darwin-arm64', 'win32-x64']);
  assert.throws(() => parseReleaseTargets('darwin-arm64'), /必须同时包含 macOS 与 Windows/u);
  assert.throws(() => parseReleaseTargets('darwin-arm64,darwin-x64'), /必须同时包含 macOS 与 Windows/u);
  assert.equal(
    releaseArtifactName('0.2.0', { platform: 'darwin', arch: 'arm64' }),
    'Rambo-v0.2.0-macOS-arm64.zip'
  );
  assert.equal(
    releaseArtifactName('0.2.0', { platform: 'win32', arch: 'x64' }),
    'Rambo-v0.2.0-Windows-x64.exe'
  );
  assert.deepEqual(
    releasePackageCommand({ platform: 'darwin', arch: 'arm64' }),
    ['run', 'package:mac:arm64']
  );
  assert.deepEqual(
    releasePackageCommand({ platform: 'win32', arch: 'x64' }),
    ['run', 'package:win']
  );
});

test('release binary checks distinguish target architectures', () => {
  assert.equal(detectBinaryArchitecture(machOBuffer(0x0100000c)), 'arm64');
  assert.equal(detectBinaryArchitecture(machOBuffer(0x01000007)), 'x64');
  assert.equal(detectBinaryArchitecture(peBuffer(0x8664)), 'x64');
  assert.equal(detectBinaryArchitecture(peBuffer(0xaa64)), 'arm64');
  assert.equal(detectBinaryArchitecture(Buffer.from('not a native executable')), null);
});

test('packaged runtime must match one fixed App Server target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rambo-release-runtime-'));
  try {
    const resources = join(root, 'resources');
    const versionRoot = join(resources, 'runtime', 'codex', '0.165.0');
    await mkdir(join(versionRoot, 'bin'), { recursive: true });
    await writeFile(join(versionRoot, 'bin', 'codex-app-server.exe'), peBuffer(0x8664));
    await writeFile(join(versionRoot, 'codex-package.json'), JSON.stringify({
      version: '0.165.0',
      variant: 'codex-app-server',
      target: 'x86_64-pc-windows-msvc',
      entrypoint: 'bin/codex-app-server.exe',
      pathDir: 'codex-path'
    }));
    await writeFile(join(versionRoot, 'rambo-runtime.json'), JSON.stringify({
      version: '0.165.0',
      target: 'x86_64-pc-windows-msvc',
      sha256: 'a'.repeat(64)
    }));
    const runtimeConfig = {
      version: '0.165.0',
      targets: {
        'win32-x64': {
          target: 'x86_64-pc-windows-msvc',
          sha256: 'a'.repeat(64),
          entrypoint: 'bin/codex-app-server.exe',
          pathDir: 'codex-path'
        }
      }
    };
    const runtime = await verifyPackagedRuntime({
      resourcesRoot: resources,
      targetKey: 'win32-x64',
      runtimeConfig,
      binaryVerifier: async () => 'x64'
    });
    assert.equal(runtime.target, 'x86_64-pc-windows-msvc');
    assert.equal(runtime.architecture, 'x64');

    await assert.rejects(
      verifyPackagedRuntime({
        resourcesRoot: resources,
        targetKey: 'win32-x64',
        runtimeConfig: {
          ...runtimeConfig,
          targets: {
            ...runtimeConfig.targets,
            'win32-x64': {
              ...runtimeConfig.targets['win32-x64'],
              target: 'aarch64-pc-windows-msvc'
            }
          }
        },
        binaryVerifier: async () => 'x64'
      }),
      /版本或目标不匹配/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
