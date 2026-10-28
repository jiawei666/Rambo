import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(
  new URL('../../src/shared/composer-attachments.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

async function loadModule() {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-composer-attachments-test-'));
  const modulePath = join(directory, 'composer-attachments.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  return {
    directory,
    module: await import(`${pathToFileURL(modulePath).href}?${Date.now()}`)
  };
}

test('composer attachments keep absolute paths, preserve order and deduplicate by path', async () => {
  const { directory, module } = await loadModule();
  try {
    const {
      composerAttachmentKind,
      composerAttachmentName,
      dedupeComposerAttachmentPaths,
      composeComposerMessage
    } = module;
    const textPath = '/tmp/rambo fixtures/说明 文件.txt';
    const imagePath = '/tmp/rambo fixtures/预览 图.PNG';

    assert.equal(composerAttachmentName(textPath), '说明 文件.txt');
    assert.equal(composerAttachmentName(imagePath), '预览 图.PNG');
    assert.equal(composerAttachmentKind(textPath), 'file');
    assert.equal(composerAttachmentKind(imagePath), 'image');
    assert.deepEqual(dedupeComposerAttachmentPaths([textPath, imagePath, textPath]), [
      textPath,
      imagePath
    ]);
    assert.equal(
      composeComposerMessage('请看附件  ', [textPath, imagePath, textPath]),
      `请看附件\n${textPath}\n${imagePath}`
    );
    assert.equal(composeComposerMessage('', [imagePath]), imagePath);
    assert.equal(composeComposerMessage('   ', []), '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pasted image data URLs accept supported raster images and reject other payloads', async () => {
  const { directory, module } = await loadModule();
  try {
    const { imageExtensionForMime, parseImageDataUrl } = module;
    assert.equal(imageExtensionForMime('image/jpeg'), 'jpg');
    assert.equal(imageExtensionForMime('image/svg+xml'), null);
    assert.deepEqual(parseImageDataUrl('data:image/png;base64,iVBORw0KGgo='), {
      mimeType: 'image/png',
      extension: 'png',
      base64: 'iVBORw0KGgo='
    });
    assert.deepEqual(
      parseImageDataUrl('data:image/jpeg;base64,/9j/4AAQ\nSkZJRg=='),
      {
        mimeType: 'image/jpeg',
        extension: 'jpg',
        base64: '/9j/4AAQSkZJRg=='
      }
    );
    assert.equal(parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz4='), null);
    assert.equal(parseImageDataUrl('data:text/plain;base64,aGVsbG8='), null);
    assert.equal(parseImageDataUrl('not-an-image'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
