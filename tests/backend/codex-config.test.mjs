import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const modelSource = ts.transpileModule(
  await readFile(new URL('../../src/main/model-source.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    }
  }
).outputText;
const modelSourceUrl = `data:text/javascript;base64,${Buffer.from(modelSource).toString('base64')}`;
const configSource = ts.transpileModule(
  await readFile(new URL('../../src/main/codex-config.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    }
  }
).outputText.replace("from './model-source'", `from '${modelSourceUrl}'`);
const module = await import(
  `data:text/javascript;base64,${Buffer.from(configSource).toString('base64')}`
);

const config = {
  serviceName: '测试网关',
  baseUrl: 'https://api.example.com/v1',
  model: 'model-a'
};

test('manual provider config replaces only Rambo-owned TOML fields', () => {
  const input = [
    '# user config',
    'model = "local-model"',
    'model_provider = "workbuddy"',
    '',
    '[projects."/tmp/project"]',
    'trust_level = "trusted"',
    '',
    '[model_providers.rambo_manual]',
    'name = "old"',
    'base_url = "https://old.example.com"'
  ].join('\n');
  const output = module.mergeManualProviderConfig(input, config);
  assert.match(output, /^# user config\nmodel = "model-a"/u);
  assert.doesNotMatch(output, /model = "local-model"/u);
  assert.match(output, /model_provider = "rambo_manual"/u);
  assert.match(output, /\[projects\."\/tmp\/project"\]\ntrust_level = "trusted"/u);
  assert.match(output, /\[model_providers\.rambo_manual\]\nname = "测试网关"/u);
  assert.doesNotMatch(output, /model_provider = "workbuddy"/u);
  assert.doesNotMatch(output, /https:\/\/old\.example\.com/u);
  assert.match(output, /env_key = "RAMBO_MANUAL_API_KEY"/u);
  assert.doesNotMatch(output, /sk-/u);
});

test('manual provider config can be removed without changing unrelated config', () => {
  const input = [
    'model = "local-model"',
    'model_provider = "rambo_manual"',
    '',
    '[model_providers.rambo_manual]',
    'name = "Rambo"',
    '',
    '[projects."/tmp/project"]',
    'trust_level = "trusted"'
  ].join('\n');
  const output = module.removeManualProviderConfig(input);
  assert.equal(output, [
    'model = "local-model"',
    '',
    '[projects."/tmp/project"]',
    'trust_level = "trusted"',
    ''
  ].join('\n'));
});

test('file operations preserve the base config and restore it on clear', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rambo-codex-config-test-'));
  const configPath = join(root, 'codex-home', 'config.toml');
  const original = 'model = "local-model"\n';
  try {
    await mkdir(join(root, 'codex-home'));
    await writeFile(configPath, original);
    await module.applyManualProviderConfig(configPath, config);
    assert.match(await readFile(configPath, 'utf8'), /rambo_manual/u);
    await module.clearManualProviderConfig(configPath);
    assert.equal(await readFile(configPath, 'utf8'), original);
    await assert.rejects(readFile(`${configPath}.rambo-base`, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manual provider removes its generated config when no original file existed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rambo-codex-config-missing-test-'));
  const configPath = join(root, 'codex-home', 'config.toml');
  try {
    await module.applyManualProviderConfig(configPath, config);
    const generated = await readFile(configPath, 'utf8');
    assert.match(generated, /^model = "model-a"/u);
    assert.match(generated, /model_provider = "rambo_manual"/u);
    assert.doesNotMatch(generated, /sk-/u);
    await module.clearManualProviderConfig(configPath);
    await assert.rejects(readFile(configPath, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(`${configPath}.rambo-base`, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(
      readFile(`${configPath}.rambo-base-missing`, 'utf8'),
      { code: 'ENOENT' }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
