import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const projectRoot = new URL('../..', import.meta.url).pathname;
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../src/main/wechat-media-content.ts', import.meta.url), 'utf8');
const imageKeyUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(
  readFileSync(new URL('../../src/main/wechat-image-key.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }
).outputText).toString('base64')}`;
const xmldomUrl = pathToFileURL(require.resolve('@xmldom/xmldom')).href;
const pdfjsUrl = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
const platformProcessUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(
  readFileSync(new URL('../../src/main/platform/process.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }
).outputText).toString('base64')}`;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText
  .replace("from '@xmldom/xmldom'", `from '${xmldomUrl}'`)
  .replace("from './platform/process'", `from '${platformProcessUrl}'`)
  .replace("from './wechat-image-key'", `from '${imageKeyUrl}'`)
  .replace("import('pdfjs-dist/legacy/build/pdf.mjs')", `import('${pdfjsUrl}')`);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { WechatMediaContentProcessor } = await import(moduleUrl);
const decoderPath = `${projectRoot}/native/wechat-silk-decoder/target/release/rambo-wechat-silk-decoder`;
const ffmpegPath = require('ffmpeg-static');
const tempDirectories = [];

after(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
});

function createProcessor(paths, run) {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'rambo-wechat-media-content-'));
  tempDirectories.push(tempDirectory);
  return new WechatMediaContentProcessor(paths, run, { tempDirectory });
}

function localMedia(result) {
  assert.equal(result.contentItems.length, 1);
  assert.equal(result.contentItems[0].type, 'inputText');
  assert.doesNotMatch(result.contentItems[0].text, /data:(?:image|audio)\//u);
  return JSON.parse(result.contentItems[0].text);
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(raw);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function onePagePdf(text) {
  const stream = `BT /F1 12 Tf 30 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body);
}

test('plain text, DOCX, and PDF files are delivered as extracted text', async () => {
  const processor = createProcessor({ ffmpegPath, silkDecoderPath: decoderPath });
  const plain = await processor.process({
    bytes: Buffer.from('line one\nline two'),
    mimeType: 'text/plain', fileName: 'notes.txt', kind: 'file', status: 'available'
  });
  assert.equal(plain.delivery, 'inline_text');
  assert.match(plain.contentItems[0].text, /line one\nline two/u);

  const docx = await processor.process({
    bytes: zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Rambo Word body</w:t></w:r></w:p></w:body></w:document>' }),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileName: 'brief.docx', kind: 'file', status: 'available'
  });
  assert.match(docx.contentItems[0].text, /Rambo Word body/u);

  const pdf = await processor.process({
    bytes: onePagePdf('PDF body text'),
    mimeType: 'application/pdf', fileName: 'brief.pdf', kind: 'file', status: 'available'
  });
  assert.match(pdf.contentItems[0].text, /PDF body text/u);
});

test('WeChat SILK is decoded in memory to a valid WAV Agent input', async () => {
  const processor = createProcessor({ ffmpegPath, silkDecoderPath: decoderPath });
  const silk = readFileSync(new URL('../../native/wechat-silk-decoder/tone.silk', import.meta.url));
  const result = await processor.process({
    bytes: silk,
    mimeType: 'audio/silk', fileName: 'voice.silk', kind: 'audio', status: 'available'
  });
  assert.equal(result.delivery, 'local_audio');
  assert.equal(result.fileName, 'voice.wav');
  const metadata = localMedia(result);
  assert.match(metadata.local_path, /\/wechat-media-\d+-[0-9a-f]{8}\.wav$/u);
  assert.equal(metadata.expires_in_days, 7);
  const wav = readFileSync(metadata.local_path);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
});

test('audio metadata uses the extension matching the processed MIME type', async () => {
  const processor = createProcessor({ ffmpegPath, silkDecoderPath: decoderPath });
  const result = await processor.process({
    bytes: Buffer.from('M4A'),
    mimeType: 'audio/mp4',
    fileName: 'voice.m4a',
    kind: 'audio',
    status: 'available'
  });
  assert.equal(result.delivery, 'local_audio');
  assert.equal(result.fileName, 'voice.m4a');
  const metadata = localMedia(result);
  assert.match(metadata.local_path, /\/wechat-media-\d+-[0-9a-f]{8}\.m4a$/u);
  assert.deepEqual(readFileSync(metadata.local_path), Buffer.from('M4A'));
});

test('WeChat WXGF images are expanded to a JPEG Agent input through FFmpeg', async () => {
  const nalu = (type, size, marker) => {
    const value = Buffer.alloc(size, marker);
    value[0] = type << 1;
    value[1] = 1;
    return value;
  };
  const wxgf = Buffer.concat([
    Buffer.from('wxgf'),
    Buffer.alloc(20, 0),
    Buffer.from([0, 0, 0, 1]), nalu(32, 110, 0x11),
    Buffer.from([0, 0, 0, 1]), nalu(33, 40, 0x12),
    Buffer.from([0, 0, 0, 1]), nalu(19, 120, 0x13)
  ]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
  let received = null;
  const processor = createProcessor(
    { ffmpegPath: '/fake/ffmpeg', silkDecoderPath: decoderPath },
    async (binary, args, input) => {
      received = { binary, args, input };
      return jpeg;
    }
  );
  const result = await processor.process({
    bytes: wxgf,
    mimeType: 'image/wxgf',
    fileName: 'sample.dat',
    kind: 'image',
    status: 'available'
  });
  assert.equal(result.delivery, 'local_image');
  const metadata = localMedia(result);
  assert.match(metadata.local_path, /\/wechat-media-\d+-[0-9a-f]{8}\.jpg$/u);
  assert.deepEqual(readFileSync(metadata.local_path), jpeg);
  assert.equal(received?.binary, '/fake/ffmpeg');
  assert.ok(received?.args.includes('hevc'));
});

test('WeChat WXGF embedded JPEG is returned without invoking FFmpeg', async () => {
  const embedded = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
  const wxgf = Buffer.concat([Buffer.from('wxgf'), Buffer.alloc(20, 0), embedded]);
  let invoked = false;
  const processor = createProcessor(
    { ffmpegPath: '/fake/ffmpeg', silkDecoderPath: decoderPath },
    async () => {
      invoked = true;
      return Buffer.alloc(0);
    }
  );
  const result = await processor.process({
    bytes: wxgf,
    mimeType: 'image/wxgf',
    fileName: 'sample.dat',
    kind: 'image',
    status: 'available'
  });
  const metadata = localMedia(result);
  assert.deepEqual(readFileSync(metadata.local_path), embedded);
  assert.equal(invoked, false);
});

test('videos are streamed through FFmpeg and delivered as ordered keyframe images', async () => {
  const generated = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=2:d=4',
    '-an', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'
  ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const processor = createProcessor({ ffmpegPath, silkDecoderPath: decoderPath });
  const result = await processor.process({
    bytes: generated.stdout,
    mimeType: 'video/mp4', fileName: 'clip.mp4', kind: 'video', status: 'available'
  });
  assert.equal(result.delivery, 'local_video');
  assert.ok(result.frameTimesSeconds?.length);
  const metadata = localMedia(result);
  assert.deepEqual(readFileSync(metadata.local_path), generated.stdout);
  assert.equal(metadata.frame_paths.length, result.frameTimesSeconds.length);
  for (const path of metadata.frame_paths) {
    assert.equal(readFileSync(path).subarray(0, 2).toString('hex'), 'ffd8');
  }
});

test('thumbnail-only media is explicitly delivered as an image without claiming to be the original', async () => {
  const processor = createProcessor({ ffmpegPath, silkDecoderPath: decoderPath });
  const result = await processor.process({
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    mimeType: 'image/jpeg', fileName: 'video_thumb.jpg', kind: 'thumbnail', status: 'thumbnailOnly'
  });
  assert.equal(result.delivery, 'local_image');
  const metadata = localMedia(result);
  assert.equal(metadata.status, 'thumbnailOnly');
  assert.deepEqual(readFileSync(metadata.local_path), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});
