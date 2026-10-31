import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const DAY = 24 * 60 * 60_000;
const source = readFileSync(
  new URL('../../src/main/composer-attachment-cleanup.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

async function loadModule() {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-composer-cleanup-test-'));
  const modulePath = join(directory, 'composer-attachment-cleanup.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  return {
    directory,
    module: await import(`${pathToFileURL(modulePath).href}?${Date.now()}`)
  };
}

function createFile(directory, name, ageMs, now, bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])) {
  const path = join(directory, name);
  writeFileSync(path, bytes);
  const timestamp = new Date(now - ageMs);
  utimesSync(path, timestamp, timestamp);
  return path;
}

const createImage = createFile;

test('cleans pasted images by referenced retention while protecting drafts', async () => {
  const { directory, module } = await loadModule();
  const attachments = join(directory, 'composer-attachments');
  mkdirSync(attachments);
  try {
    const now = Date.now();
    const unreferencedExpired = createImage(
      attachments, 'pasted-image-1700000000000-11111111.png', 7 * DAY + 1_000, now
    );
    const unreferencedBoundary = createImage(
      attachments, 'pasted-image-1700000000001-22222222.jpg', 7 * DAY, now
    );
    const unreferencedRecent = createImage(
      attachments, 'pasted-image-1700000000002-33333333.jpeg', 7 * DAY - 1_000, now
    );
    const referencedExpired = createImage(
      attachments, 'pasted-image-1700000000003-44444444.webp', 30 * DAY + 1_000, now
    );
    const referencedBoundary = createImage(
      attachments, 'pasted-image-1700000000004-55555555.gif', 30 * DAY, now
    );
    const referencedRecent = createImage(
      attachments, 'pasted-image-1700000000005-66666666.avif', 30 * DAY - 1_000, now
    );
    const draftExpired = createImage(
      attachments, 'pasted-image-1700000000006-77777777.bmp', 90 * DAY, now
    );
    const referenced = new Set([referencedExpired, referencedBoundary, referencedRecent]);

    const result = module.cleanupComposerAttachments({
      directory: attachments,
      now: () => now,
      draftPaths: () => [draftExpired],
      isReferenced: path => referenced.has(path)
    });

    assert.deepEqual(new Set(result.deletedPaths), new Set([
      unreferencedExpired,
      unreferencedBoundary,
      referencedExpired,
      referencedBoundary
    ]));
    assert.deepEqual(result.draftProtectedPaths, [draftExpired]);
    assert.deepEqual(new Set(result.referencedPaths), referenced);
    assert.deepEqual(result.errors, []);
    assert.doesNotThrow(() => readFileSync(unreferencedRecent));
    assert.doesNotThrow(() => readFileSync(referencedRecent));
    assert.doesNotThrow(() => readFileSync(draftExpired));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only removes generated pasted images and never follows links', async () => {
  const { directory, module } = await loadModule();
  const attachments = join(directory, 'composer-attachments');
  mkdirSync(attachments);
  try {
    const now = Date.now();
    const normalFile = createImage(
      attachments, 'pasted-image-1700000000001-22222222.png', 31 * DAY, now
    );
    const unrelatedImage = createImage(attachments, 'photo.png', 31 * DAY, now);
    const unsupportedName = createImage(
      attachments, 'pasted-image-1700000000002-33333333.svg', 31 * DAY, now
    );
    const malformedName = createImage(
      attachments, 'pasted-image-anything.png', 31 * DAY, now
    );
    const nestedDirectory = join(
      attachments, 'pasted-image-1700000000003-44444444.png'
    );
    mkdirSync(nestedDirectory);
    const outside = join(directory, 'outside.png');
    writeFileSync(outside, 'keep');
    const linked = join(
      attachments, 'pasted-image-1700000000004-55555555.png'
    );
    symlinkSync(outside, linked);

    const result = module.cleanupComposerAttachments({
      directory: attachments,
      now: () => now
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.deletedPaths, [normalFile]);
    assert.equal(readFileSync(unrelatedImage, 'utf8').length > 0, true);
    assert.equal(readFileSync(unsupportedName, 'utf8').length > 0, true);
    assert.equal(readFileSync(malformedName, 'utf8').length > 0, true);
    assert.equal(readFileSync(outside, 'utf8'), 'keep');
    assert.equal(readFileSync(linked, 'utf8'), 'keep');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cleans generated WeChat media files on the same retention schedule', async () => {
  const { directory, module } = await loadModule();
  const attachments = join(directory, 'composer-attachments');
  mkdirSync(attachments);
  try {
    const now = Date.now();
    const expiredImage = createFile(
      attachments, 'wechat-media-1700000000000-11111111.jpg', 7 * DAY + 1_000, now
    );
    const expiredAudio = createFile(
      attachments, 'wechat-media-1700000000001-22222222.wav', 7 * DAY, now
    );
    const expiredOpus = createFile(
      attachments, 'wechat-media-1700000000005-66666666.opus', 7 * DAY, now
    );
    const recentVideo = createFile(
      attachments, 'wechat-media-1700000000002-33333333.mp4', 7 * DAY - 1_000, now
    );
    const referencedExpired = createFile(
      attachments, 'wechat-media-1700000000003-44444444.silk', 30 * DAY + 1_000, now
    );
    const unsupported = createFile(
      attachments, 'wechat-media-1700000000004-55555555.exe', 90 * DAY, now
    );
    const referenced = new Set([referencedExpired]);

    const result = module.cleanupComposerAttachments({
      directory: attachments,
      now: () => now,
      isReferenced: path => referenced.has(path)
    });

    assert.deepEqual(new Set(result.deletedPaths), new Set([
      expiredImage,
      expiredAudio,
      expiredOpus,
      referencedExpired
    ]));
    assert.deepEqual(result.errors, []);
    assert.doesNotThrow(() => readFileSync(recentVideo));
    assert.doesNotThrow(() => readFileSync(unsupported));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not traverse a symlinked attachment directory', async () => {
  const { directory, module } = await loadModule();
  const target = join(directory, 'target');
  mkdirSync(target);
  const attachments = join(directory, 'composer-attachments');
  symlinkSync(target, attachments);
  try {
    const now = Date.now();
    const path = createImage(
      target, 'pasted-image-1700000000000-11111111.png', 31 * DAY, now
    );
    const result = module.cleanupComposerAttachments({
      directory: attachments,
      now: () => now
    });
    assert.deepEqual(result.deletedPaths, []);
    assert.equal(readFileSync(path, 'utf8').length > 0, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
