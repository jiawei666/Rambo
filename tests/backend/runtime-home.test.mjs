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
  const agentSkills = join(root, 'native-account', '.agents', 'skills');
  const store = join(root, 'store');
  await mkdir(native, { recursive: true });
  await mkdir(agentSkills, { recursive: true });
  await mkdir(store);
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const compiled = ts.transpileModule(
    await readFile(new URL('../../src/main/runtime-home.ts', import.meta.url), 'utf8'),
    { compilerOptions }
  ).outputText
    .replace("from './platform/fs'", "from './platform/fs.mjs'")
    .replace("from './managed-skills'", "from './managed-skills.mjs'");
  const compiledPlatformFs = ts.transpileModule(
    await readFile(new URL('../../src/main/platform/fs.ts', import.meta.url), 'utf8'),
    { compilerOptions }
  ).outputText;
  const compiledManagedSkills = ts.transpileModule(
    await readFile(new URL('../../src/main/managed-skills.ts', import.meta.url), 'utf8'),
    { compilerOptions }
  ).outputText;
  await mkdir(join(root, 'platform'));
  await writeFile(join(root, 'platform', 'fs.mjs'), compiledPlatformFs);
  await writeFile(join(root, 'managed-skills.mjs'), compiledManagedSkills);
  const modulePath = join(root, 'home.mjs');
  await writeFile(modulePath, compiled);
  const module = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
  try {
    await run(module.RuntimeHomeManager, native, store, agentSkills);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function skillText(name, body) {
  return `---\nname: ${name}\ndescription: fixture skill\n---\n${body}\n`;
}

test('first startup imports Codex config and both discovered Skill roots once into an independent Home', async () => {
  await fixture(async (RuntimeHomeManager, native, store, agentSkills) => {
    const config = 'model="native-model"\n[mcp_servers.fixture]\ncommand="/opt/local/bin/fixture-mcp"\n';
    await writeFile(join(native, 'config.toml'), config);
    await writeFile(join(native, 'auth.json'), '{"auth_mode":"chatgpt"}');
    await writeFile(join(native, 'mcp-auth.json'), '{"fixture":"granted"}');
    await mkdir(join(native, 'plugins', 'cache', 'vendor', 'fixture', '1.0.0'), { recursive: true });
    await writeFile(join(native, 'plugins', 'cache', 'vendor', 'fixture', '1.0.0', 'plugin.json'), '{}');
    await mkdir(join(native, 'skills', '.system', 'pdf'), { recursive: true });
    await writeFile(join(native, 'skills', '.system', 'pdf', 'SKILL.md'), skillText('pdf', 'pdf body'));
    await mkdir(join(native, 'skills', 'shared'), { recursive: true });
    await writeFile(join(native, 'skills', 'shared', 'SKILL.md'), skillText('shared-codex', 'codex version'));
    await mkdir(join(agentSkills, 'research'), { recursive: true });
    await writeFile(join(agentSkills, 'research', 'SKILL.md'), skillText('research', 'agent skill'));
    await mkdir(join(agentSkills, 'shared'), { recursive: true });
    await writeFile(join(agentSkills, 'shared', 'SKILL.md'), skillText('shared-agent', 'agent version'));
    await mkdir(join(native, 'sessions', '2026'), { recursive: true });
    await writeFile(join(native, 'sessions', '2026', 'rollout.jsonl'), 'native session');
    await writeFile(join(native, 'state_5.sqlite'), 'native state');

    const manager = new RuntimeHomeManager(native, store, () => [], {
      watch: true,
      nativeAgentSkillsRoot: agentSkills,
      now: () => new Date('2026-11-06T00:00:00.000Z')
    });
    try {
      const home = await manager.prepare();
      assert.equal(manager.snapshot().mode, 'independent');
      assert.equal(manager.snapshot().sourceDetected, true);
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config);
      assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), '{"auth_mode":"chatgpt"}');
      assert.equal(await readFile(join(home, 'mcp-auth.json'), 'utf8'), '{"fixture":"granted"}');
      assert.equal(await readFile(join(home, 'plugins', 'cache', 'vendor', 'fixture', '1.0.0', 'plugin.json'), 'utf8'), '{}');
      assert.equal(await readFile(join(home, 'skills', '.system', 'pdf', 'SKILL.md'), 'utf8'), skillText('pdf', 'pdf body'));
      assert.equal(await readFile(join(home, 'skills', 'research', 'SKILL.md'), 'utf8'), skillText('research', 'agent skill'));
      assert.equal(await readFile(join(home, 'skills', 'shared', 'SKILL.md'), 'utf8'), skillText('shared-codex', 'codex version'));
      assert.equal(await readFile(join(home, 'skills', 'shared--agents', 'SKILL.md'), 'utf8'), skillText('shared-agent', 'agent version'));
      assert.equal((await lstat(join(home, 'config.toml'))).isSymbolicLink(), false);
      await assert.rejects(readFile(join(home, 'sessions', '2026', 'rollout.jsonl')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(home, 'state_5.sqlite')), { code: 'ENOENT' });

      await writeFile(join(native, 'config.toml'), 'model="changed-native"');
      await writeFile(join(native, 'skills', '.system', 'pdf', 'SKILL.md'), 'changed source');
      await manager.prepare();
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config);
      assert.equal(await readFile(join(home, 'skills', '.system', 'pdf', 'SKILL.md'), 'utf8'), skillText('pdf', 'pdf body'));
      assert.equal(typeof manager.pollSource, 'undefined');
      assert.equal(typeof manager.setMode, 'undefined');
    } finally {
      manager.dispose();
    }
  });
});

test('existing Rambo config is preserved and suppresses initial import', async () => {
  await fixture(async (RuntimeHomeManager, native, store, agentSkills) => {
    const home = join(store, 'codex-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.toml'), 'model="rambo-existing"');
    await writeFile(join(native, 'config.toml'), 'model="native-existing"');
    await mkdir(join(native, 'plugins', 'cache', 'vendor', 'new-plugin'), { recursive: true });
    await writeFile(join(native, 'plugins', 'cache', 'vendor', 'new-plugin', 'plugin.json'), '{}');

    const manager = new RuntimeHomeManager(native, store, () => [], { nativeAgentSkillsRoot: agentSkills });
    try {
      await manager.prepare();
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="rambo-existing"');
      await assert.rejects(readFile(join(home, 'plugins', 'cache', 'vendor', 'new-plugin', 'plugin.json')), { code: 'ENOENT' });
      assert.equal(manager.snapshot().mode, 'independent');
    } finally {
      manager.dispose();
    }
  });
});

test('legacy follow state migrates to independent and can never resume following', async () => {
  await fixture(async (RuntimeHomeManager, native, store, agentSkills) => {
    const home = join(store, 'codex-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.toml'), 'model="already-copied"');
    await writeFile(join(native, 'config.toml'), 'model="new-native"');
    await writeFile(join(store, 'codex-home-sync.json'), JSON.stringify({
      schema: 'rambo.codex-home-sync.v1',
      mode: 'follow',
      lastSyncedAt: '2026-10-01T00:00:00.000Z',
      decisionRequired: false
    }));
    const manager = new RuntimeHomeManager(native, store, () => [], { nativeAgentSkillsRoot: agentSkills });
    try {
      await manager.prepare();
      assert.equal(manager.snapshot().mode, 'independent');
      assert.equal(manager.snapshot().pending, false);
      assert.equal(manager.snapshot().decisionRequired, false);
      assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), 'model="already-copied"');
      assert.equal(JSON.parse(await readFile(join(store, 'codex-home-sync.json'), 'utf8')).mode, 'independent');
      assert.equal(typeof manager.setMode, 'undefined');
    } finally {
      manager.dispose();
    }
  });
});

test('failed first import rolls back and retries successfully on the next prepare', async () => {
  await fixture(async (RuntimeHomeManager, native, store, agentSkills) => {
    await writeFile(join(native, 'config.toml'), 'model="retry-me"');
    await symlink(join(native, 'missing-plugin-cache'), join(native, 'plugins'));
    const manager = new RuntimeHomeManager(native, store, () => [], { nativeAgentSkillsRoot: agentSkills });
    try {
      await assert.rejects(manager.prepare());
      await assert.rejects(readFile(join(store, 'codex-home', 'config.toml')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(store, 'codex-home-initial-import.json')), { code: 'ENOENT' });

      await rm(join(native, 'plugins'));
      await mkdir(join(native, 'plugins', 'cache'), { recursive: true });
      await writeFile(join(native, 'plugins', 'cache', 'ready'), 'ok');
      await manager.prepare();
      assert.equal(await readFile(join(store, 'codex-home', 'config.toml'), 'utf8'), 'model="retry-me"');
      assert.equal(JSON.parse(await readFile(join(store, 'codex-home-initial-import.json'), 'utf8')).result, 'imported');
    } finally {
      manager.dispose();
    }
  });
});

test('missing native Home is not polled and does not import a later appearing config', async () => {
  await fixture(async (RuntimeHomeManager, native, store, agentSkills) => {
    await rm(native, { recursive: true, force: true });
    const manager = new RuntimeHomeManager(native, store, () => [], { nativeAgentSkillsRoot: agentSkills });
    try {
      await manager.prepare();
      assert.equal(manager.snapshot().sourceDetected, false);
      assert.equal(typeof manager.pollSource, 'undefined');
      await mkdir(native, { recursive: true });
      await writeFile(join(native, 'config.toml'), 'model="appeared-later"');
      await manager.prepare();
      await assert.rejects(readFile(join(store, 'codex-home', 'config.toml')), { code: 'ENOENT' });
    } finally {
      manager.dispose();
    }
  });
});

test('legacy follow migration imports only Rambo-owned rollout files once', async () => {
  await fixture(async (RuntimeHomeManager, native, store, agentSkills) => {
    const owned = '00000000-0000-0000-0000-000000000001';
    const unrelated = '00000000-0000-0000-0000-000000000002';
    const home = join(store, 'codex-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.toml'), 'model="existing"');
    await writeFile(join(store, 'codex-home-sync.json'), JSON.stringify({
      schema: 'rambo.codex-home-sync.v1', mode: 'follow',
      lastSyncedAt: '2026-10-01T00:00:00.000Z', decisionRequired: false
    }));
    for (const section of ['sessions', 'archived_sessions']) {
      await mkdir(join(native, section, '2026'), { recursive: true });
      await writeFile(join(native, section, '2026', `rollout-2026-01-01-${owned}.jsonl`), owned);
      await writeFile(join(native, section, '2026', `rollout-2026-01-01-${unrelated}.jsonl`), unrelated);
    }
    const manager = new RuntimeHomeManager(native, store, () => [owned], { nativeAgentSkillsRoot: agentSkills });
    try {
      await manager.prepare();
      for (const section of ['sessions', 'archived_sessions']) {
        assert.equal(await readFile(join(home, section, '2026', `rollout-2026-01-01-${owned}.jsonl`), 'utf8'), owned);
        await assert.rejects(readFile(join(home, section, '2026', `rollout-2026-01-01-${unrelated}.jsonl`)), { code: 'ENOENT' });
      }
      assert.equal(await readFile(join(native, 'sessions', '2026', `rollout-2026-01-01-${owned}.jsonl`), 'utf8'), owned);
    } finally {
      manager.dispose();
    }
  });
});
