import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'rambo-home-test-'));
  const native = join(root, 'native');
  const store = join(root, 'store');
  await mkdir(native); await mkdir(store);
  const compiled = ts.transpileModule(await readFile(new URL('../../src/main/runtime-home.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  await writeFile(join(root, 'home.mjs'), compiled);
  const { prepareRuntimeHome } = await import(join(root, 'home.mjs'));
  try { await run(prepareRuntimeHome, native, store); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('home links the same auth/config/resources while keeping sessions and SQLite independent', async () => {
  await fixture(async (prepare, native, store) => {
    await writeFile(join(native, 'auth.json'), 'fixture-auth-1');
    await writeFile(join(native, 'config.toml'), 'model="fixture-model"');
    await mkdir(join(native, 'skills'));
    const home = await prepare(native, store);
    assert.equal(await readlink(join(home, 'auth.json')), join(native, 'auth.json'));
    assert.equal(await readlink(join(home, 'config.toml')), join(native, 'config.toml'));
    assert.equal(await readlink(join(home, 'skills')), join(native, 'skills'));
    await writeFile(join(native, 'auth.json'), 'fixture-auth-2');
    assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), 'fixture-auth-2');
    await writeFile(join(home, 'auth.json'), 'fixture-auth-3');
    assert.equal(await readFile(join(native, 'auth.json'), 'utf8'), 'fixture-auth-3');
    await assert.rejects(readlink(join(home, 'sessions')), { code: 'EINVAL' });
    await assert.rejects(readlink(join(home, 'state_5.sqlite')), { code: 'ENOENT' });
    assert.equal(await prepare(native, store), home);
  });
});

test('home links future first login to native auth and refuses conflicts or a keyring backend', async () => {
  await fixture(async (prepare, native, store) => {
    const home = await prepare(native, store);
    await writeFile(join(home, 'auth.json'), 'fixture-first-login');
    assert.equal(await readFile(join(native, 'auth.json'), 'utf8'), 'fixture-first-login');
    await rm(join(home, 'config.toml'));
    await writeFile(join(home, 'config.toml'), 'local-conflict');
    await assert.rejects(prepare(native, store), /共享资源路径冲突/);
    await rm(join(home, 'config.toml'));
    await writeFile(join(native, 'config.toml'), 'cli_auth_credentials_store="keyring"');
    await assert.rejects(prepare(native, store), /Keychain/);
  });
});

test('migration imports owned active and archived rollouts only, preserves originals and never resurrects deleted copies', async () => {
  await fixture(async (prepare, native, store) => {
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
    const home = await prepare(native, store, [owned]);
    for (const relative of paths) {
      assert.equal(await readFile(join(home, relative), 'utf8'), owned);
      assert.equal(await readFile(join(native, relative), 'utf8'), owned);
      await assert.rejects(readFile(join(home, relative.replace(owned, unrelated))), { code: 'ENOENT' });
    }
    await writeFile(join(home, paths[0]), 'newer isolated history');
    await prepare(native, store, [owned]);
    assert.equal(await readFile(join(home, paths[0]), 'utf8'), 'newer isolated history');
    await rm(join(home, paths[0]));
    await prepare(native, store, [owned]);
    await assert.rejects(readFile(join(home, paths[0])), { code: 'ENOENT' });
    const compressed = join('archived_sessions', `rollout-2026-02-02-${owned}.jsonl.zst`);
    await writeFile(join(native, compressed), 'fixture-compressed-rollout');
    await prepare(native, store, [owned]);
    await assert.rejects(readFile(join(home, compressed)), { code: 'ENOENT' });
  });
});

test('home cannot resolve to native storage through a symlink', async () => {
  await fixture(async (prepare, native, store) => {
    await symlink(native, join(store, 'codex-home'));
    await assert.rejects(prepare(native, store), /不能与本机 Codex 目录相同/);
  });
});
