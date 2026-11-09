import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/managed-skills.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

async function withLibrary(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-managed-skill-test-'));
  const modulePath = join(directory, 'managed-skills.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  try {
    const module = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    await run(module, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createSkill(root, name, body = 'Use the bundled helper.') {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    'description: Synthetic local skill for tests.',
    '---',
    '',
    body
  ].join('\n'));
  writeFileSync(join(root, 'scripts', 'helper.sh'), '#!/bin/sh\necho helper\n');
}

test('managed skills copy a complete local folder without modifying the source', async () => {
  await withLibrary(async ({ ManagedSkillLibrary }, directory) => {
    const source = join(directory, 'source', 'local-helper');
    createSkill(source, 'Local Helper');
    const library = new ManagedSkillLibrary(join(directory, 'profile'));
    const imported = await library.import(source);

    assert.equal(imported.id, 'local-helper');
    assert.equal(imported.name, 'Local Helper');
    assert.equal(imported.description, 'Synthetic local skill for tests.');
    assert.equal(readFileSync(join(imported.directory, 'scripts', 'helper.sh'), 'utf8'),
      '#!/bin/sh\necho helper\n');
    assert.deepEqual((await library.list()).map(skill => skill.id), ['local-helper']);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8').includes('Local Helper'), true);
    await assert.rejects(library.import(source), /已有同名 Skill/u);
  });
});

test('managed skills reject a missing root SKILL.md and symbolic links', async () => {
  await withLibrary(async ({ ManagedSkillLibrary }, directory) => {
    const missing = join(directory, 'missing');
    mkdirSync(join(missing, 'references'), { recursive: true });
    writeFileSync(join(missing, 'references', 'note.md'), 'not a skill root');
    const linked = join(directory, 'linked');
    createSkill(linked, 'Linked Skill');
    symlinkSync(join(linked, 'scripts'), join(linked, 'linked-scripts'));
    const library = new ManagedSkillLibrary(join(directory, 'profile'));

    await assert.rejects(library.import(missing), /SKILL\.md/u);
    await assert.rejects(library.import(linked), /符号链接/u);
    assert.deepEqual(await library.list(), []);
  });
});

test('legacy Skill migration keeps the old resource ID when a Codex Skill has the same folder name', async () => {
  await withLibrary(async ({ ManagedSkillLibrary }, directory) => {
    const userData = join(directory, 'profile');
    const legacy = join(userData, 'skill-library', 'shared');
    const codex = join(userData, 'codex-home', 'skills', 'shared');
    createSkill(legacy, 'Legacy Shared Skill', 'The existing Rambo library version.');
    createSkill(codex, 'Codex Shared Skill', 'The imported Codex version.');

    const library = new ManagedSkillLibrary(userData);
    await library.migrateLegacyRoot();

    const skills = await library.list();
    assert.deepEqual(skills.map(skill => skill.id).sort(), ['shared', 'shared--codex']);
    assert.equal(readFileSync(join(library.root, 'shared', 'SKILL.md'), 'utf8')
      .includes('The existing Rambo library version.'), true);
    assert.equal(readFileSync(join(library.root, 'shared--codex', 'SKILL.md'), 'utf8')
      .includes('The imported Codex version.'), true);
    assert.equal(existsSync(join(userData, 'skill-library')), false);
  });
});

test('initial Codex Skill import retains existing resource IDs and keeps distinct contents', async () => {
  await withLibrary(async ({ ManagedSkillLibrary }, directory) => {
    const userData = join(directory, 'profile');
    const legacy = join(userData, 'skill-library', 'shared');
    const codex = join(directory, 'native', 'skills', 'shared');
    createSkill(legacy, 'Existing Rambo Skill', 'Existing Rambo authorized Skill.');
    createSkill(codex, 'Native Codex Skill', 'Imported Codex Skill.');
    const library = new ManagedSkillLibrary(userData);

    await library.migrateLegacyRoot();
    const imported = await library.importNativeRoots([{ path: join(directory, 'native', 'skills'), source: 'codex' }]);

    assert.equal(imported.length, 1);
    assert.equal(readFileSync(join(library.root, 'shared', 'SKILL.md'), 'utf8')
      .includes('Existing Rambo authorized Skill.'), true);
    assert.equal(readFileSync(join(library.root, 'shared--codex', 'SKILL.md'), 'utf8')
      .includes('Imported Codex Skill.'), true);
  });
});
