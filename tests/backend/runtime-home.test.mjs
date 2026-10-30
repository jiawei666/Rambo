import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'rambo-home-test-'));
  const native = join(root, 'native');
  const store = join(root, 'store');
  await mkdir(native);
  await mkdir(store);
  const compiled = ts.transpileModule(
    await readFile(new URL('../../src/main/runtime-home.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
  ).outputText.replace("from './platform/fs'", "from './platform/fs.mjs'");
  const compiledPlatformFs = ts.transpileModule(
    await readFile(new URL('../../src/main/platform/fs.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
  ).outputText;
  const modulePath = join(root, 'home.mjs');
  await mkdir(join(root, 'platform'));
  await writeFile(join(root, 'platform', 'fs.mjs'), compiledPlatformFs);
  await writeFile(modulePath, compiled);
  const module = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
  try {
    await run(module.RuntimeHomeManager, native, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('follow mode copies an independent whitelist and excludes sessions and state databases', async () => {
  await fixture(async (RuntimeHomeManager, native, store) => {
    await writeFile(join(native, 'config.toml'), 'model="fixture-model"');
    await writeFile(join(native, 'auth.json'), 'fixture-auth');
    await writeFile(join(native, 'AGENTS.md'), '# local instructions');
    await mkdir(join(native, 'skills'));
    await writeFile(join(native, 'skills', 'local.md'), 'skill body');
    await mkdir(join(native, 'sessions', '2026'), { recursive: true });
    await writeFile(join(native, 'sessions', '2026', 'rollout.jsonl'), 'private history');
    await writeFile(join(native, 'state_5.sqlite'), 'private state');

    const manager = new RuntimeHomeManager(native, store, () => [], { watch: false });
    try {
      const home = await manager.prepare();
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="fixture-model"');
      assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), 'fixture-auth');
      assert.equal(await readFile(join(home, 'skills', 'local.md'), 'utf8'), 'skill body');
      assert.equal((await lstat(join(home, 'config.toml'))).isSymbolicLink(), false);
      assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '# local instructions');
      await assert.rejects(readFile(join(home, 'sessions', '2026', 'rollout.jsonl')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(home, 'state_5.sqlite')), { code: 'ENOENT' });
      assert.equal(manager.snapshot().mode, 'follow');
      assert.equal(manager.snapshot().sourceDetected, true);
      assert.ok(manager.snapshot().lastSyncedAt);

      await writeFile(join(native, 'config.toml'), 'model="changed-native"');
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="fixture-model"');
      await writeFile(join(home, 'config.toml'), 'model="changed-rambo"');
      assert.equal(await readFile(join(native, 'config.toml'), 'utf8'), 'model="changed-native"');
    } finally {
      manager.dispose();
    }
  });
});

test('independent mode stops following and follow mode applies a new snapshot', async () => {
  await fixture(async (RuntimeHomeManager, native, store) => {
    await writeFile(join(native, 'config.toml'), 'model="first"');
    const manager = new RuntimeHomeManager(native, store, () => [], { watch: false });
    try {
      const home = await manager.prepare();
      await manager.setMode('independent');
      await writeFile(join(native, 'config.toml'), 'model="second"');
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="first"');
      assert.equal(manager.snapshot().mode, 'independent');

      await manager.setMode('follow');
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="second"');
      assert.equal(manager.snapshot().mode, 'follow');
    } finally {
      manager.dispose();
    }
  });
});

test('an existing Rambo profile is never overwritten silently when native Codex appears', async () => {
  await fixture(async (RuntimeHomeManager, native, store) => {
    const home = join(store, 'codex-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.toml'), 'model="rambo-existing"');
    await writeFile(join(native, 'config.toml'), 'model="native-existing"');

    const manager = new RuntimeHomeManager(native, store, () => [], { watch: false });
    try {
      await manager.prepare();
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="rambo-existing"');
      assert.equal(manager.snapshot().mode, 'independent');
      assert.equal(manager.snapshot().decisionRequired, true);
      await manager.setMode('follow');
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="native-existing"');
      assert.equal(manager.snapshot().decisionRequired, false);
    } finally {
      manager.dispose();
    }
  });
});

test('native Codex appearing after an independent Rambo login requires an explicit sync choice', async () => {
  await fixture(async (RuntimeHomeManager, native, store) => {
    await rm(native, { recursive: true, force: true });
    const home = join(store, 'codex-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'auth.json'), '{"auth_mode":"chatgpt","rambo":true}');
    await writeFile(join(home, 'config.toml'), 'model="rambo-login"');

    const manager = new RuntimeHomeManager(native, store, () => [], { watch: false });
    try {
      await manager.prepare();
      assert.equal(manager.snapshot().sourceDetected, false);
      assert.equal(manager.snapshot().mode, 'independent');
      assert.equal(manager.snapshot().decisionRequired, false);

      await mkdir(native, { recursive: true });
      await writeFile(join(native, 'auth.json'), '{"auth_mode":"chatgpt","native":true}');
      await writeFile(join(native, 'config.toml'), 'model="native-late"');
      await manager.pollSource();

      assert.equal(manager.snapshot().sourceDetected, true);
      assert.equal(manager.snapshot().mode, 'independent');
      assert.equal(manager.snapshot().decisionRequired, true);
      assert.equal(manager.snapshot().pending, true);
      assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), '{"auth_mode":"chatgpt","rambo":true}');
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="rambo-login"');

      await manager.setMode('follow');
      assert.equal(manager.snapshot().decisionRequired, false);
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="native-late"');
    } finally {
      manager.dispose();
    }
  });
});

test('system credential-store authentication is reported without pretending to copy auth.json', async () => {
  await fixture(async (RuntimeHomeManager, native, store) => {
    await writeFile(join(native, 'config.toml'), 'cli_auth_credentials_store = "keyring"');
    const manager = new RuntimeHomeManager(native, store, () => [], { watch: false });
    try {
      const home = await manager.prepare();
      await assert.rejects(readFile(join(home, 'auth.json')), { code: 'ENOENT' });
      assert.match(manager.snapshot().warning, /系统凭证库\/auto/);
      assert.match(manager.snapshot().warning, /独立登录/);
    } finally {
      manager.dispose();
    }
  });
});

test('migration imports only owned rollouts and preserves originals', async () => {
  await fixture(async (RuntimeHomeManager, native, store) => {
    const owned = '00000000-0000-0000-0000-000000000001';
    const unrelated = '00000000-0000-0000-0000-000000000002';
    const paths = [];
    for (const section of ['sessions', 'archived_sessions']) {
      await mkdir(join(native, section, '2026'), { recursive: true });
      for (const id of [owned, unrelated]) {
        const relative = join(section, '2026', `rollout-2026-01-01-${id}.jsonl`);
        await writeFile(join(native, relative), id);
        if (id === owned) paths.push(relative);
      }
    }
    const manager = new RuntimeHomeManager(native, store, () => [owned], { watch: false });
    try {
      const home = await manager.prepare();
      for (const relative of paths) {
        assert.equal(await readFile(join(home, relative), 'utf8'), owned);
        assert.equal(await readFile(join(native, relative), 'utf8'), owned);
        await assert.rejects(readFile(join(home, relative.replace(owned, unrelated))), { code: 'ENOENT' });
      }
      await writeFile(join(home, paths[0]), 'newer isolated history');
      await manager.prepare();
      assert.equal(await readFile(join(home, paths[0]), 'utf8'), 'newer isolated history');
      await rm(join(home, paths[0]));
      await manager.prepare();
      await assert.rejects(readFile(join(home, paths[0])), { code: 'ENOENT' });
    } finally {
      manager.dispose();
    }
  });
});

test('Rambo home cannot be a symbolic link', async () => {
  await fixture(async (RuntimeHomeManager, native, store) => {
    await symlink(native, join(store, 'codex-home'));
    const manager = new RuntimeHomeManager(native, store, () => [], { watch: false });
    try {
      await assert.rejects(manager.prepare(), /不能是符号链接/);
    } finally {
      manager.dispose();
    }
  });
});
