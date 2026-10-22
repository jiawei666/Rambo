import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const sourcePath = new URL('../../src/main/bot-data.ts', import.meta.url);
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

async function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-bot-data-test-'));
  const modulePath = join(directory, 'bot-data.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  try {
    const { removeManagedBotDirectory } = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    await run(removeManagedBotDirectory, directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('Bot cleanup removes only its managed directory and does not follow links to outside data', async () => {
  await withDirectory(async (removeManagedBotDirectory, root) => {
    const storeDirectory = join(root, 'app-data');
    const botsDirectory = join(storeDirectory, 'bots');
    const botDirectory = join(botsDirectory, 'bot-one');
    const outsideDirectory = join(root, 'outside');
    const siblingBotDirectory = join(botsDirectory, 'bot-two');
    mkdirSync(join(botDirectory, 'workspace'), { recursive: true });
    mkdirSync(outsideDirectory);
    mkdirSync(siblingBotDirectory);
    writeFileSync(join(botDirectory, 'workspace', 'owned.txt'), 'remove');
    writeFileSync(join(outsideDirectory, 'keep.txt'), 'keep');
    writeFileSync(join(siblingBotDirectory, 'keep.txt'), 'keep');
    symlinkSync(outsideDirectory, join(botDirectory, 'external-link'), 'dir');

    removeManagedBotDirectory(storeDirectory, 'bot-one');

    assert.equal(readFileSync(join(outsideDirectory, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(botsDirectory, 'bot-two', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(botDirectory), false);
  });
});

test('Bot cleanup rejects a Bot directory that is itself a symlink', async () => {
  await withDirectory(async (removeManagedBotDirectory, root) => {
    const storeDirectory = join(root, 'app-data');
    const botsDirectory = join(storeDirectory, 'bots');
    const outsideDirectory = join(root, 'outside');
    mkdirSync(botsDirectory, { recursive: true });
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, 'keep.txt'), 'keep');
    symlinkSync(outsideDirectory, join(botsDirectory, 'bot-one'), 'dir');

    assert.throws(() => removeManagedBotDirectory(storeDirectory, 'bot-one'), /不是受信任的应用目录/);
    assert.equal(readFileSync(join(outsideDirectory, 'keep.txt'), 'utf8'), 'keep');
  });
});

test('Bot identifiers cannot escape the app-managed Bot directory', async () => {
  await withDirectory(async (removeManagedBotDirectory, root) => {
    const storeDirectory = join(root, 'app-data');
    const outsideDirectory = join(root, 'outside');
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, 'keep.txt'), 'keep');

    assert.throws(() => removeManagedBotDirectory(storeDirectory, '../outside'), /不能用于定位/);
    assert.equal(readFileSync(join(outsideDirectory, 'keep.txt'), 'utf8'), 'keep');
  });
});
