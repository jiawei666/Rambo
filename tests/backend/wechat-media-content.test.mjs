import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const projectRoot = new URL('../..', import.meta.url).pathname;
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../src/main/wechat-media-content.ts', import.meta.url), 'utf8');
const xmldomUrl = pathToFileURL(require.resolve('@xmldom/xmldom')).href;
const pdfjsUrl = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText
  .replace("from '@xmldom/xmldom'", `from '${xmldomUrl}'`)
  .replace("import('pdfjs-dist/legacy/build/pdf.mjs')", `import('${pdfjsUrl}')`);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { WechatMediaContentProcessor } = await import(moduleUrl);
const decoderPath = `${projectRoot}/native/wechat-silk-decoder/target/release/rambo-wechat-silk-decoder`;
const ffmpegPath = require('ffmpeg-static');

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
  const processor = new WechatMediaContentProcessor({ ffmpegPath, silkDecoderPath: decoderPath });
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
  const processor = new WechatMediaContentProcessor({ ffmpegPath, silkDecoderPath: decoderPath });
  const silk = readFileSync(new URL('../../native/wechat-silk-decoder/tone.silk', import.meta.url));
  const result = await processor.process({
    bytes: silk,
    mimeType: 'audio/silk', fileName: 'voice.silk', kind: 'audio', status: 'available'
  });
  assert.equal(result.delivery, 'inline_audio');
  assert.equal(result.contentItems[0].type, 'inputAudio');
  const encoded = result.contentItems[0].audioUrl;
  assert.match(encoded, /^data:audio\/wav;base64,/u);
  const wav = Buffer.from(encoded.slice(encoded.indexOf(',') + 1), 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
});

test('videos are streamed through FFmpeg and delivered as ordered keyframe images', async () => {
  const generated = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=2:d=4',
    '-an', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'
  ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const processor = new WechatMediaContentProcessor({ ffmpegPath, silkDecoderPath: decoderPath });
  const result = await processor.process({
    bytes: generated.stdout,
    mimeType: 'video/mp4', fileName: 'clip.mp4', kind: 'video', status: 'available'
  });
  assert.equal(result.delivery, 'video_frames');
  assert.ok(result.frameTimesSeconds?.length);
  assert.ok(result.contentItems.slice(1).every(item => item.type === 'inputImage'));
});

test('thumbnail-only media is explicitly delivered as an image without claiming to be the original', async () => {
  const processor = new WechatMediaContentProcessor({ ffmpegPath, silkDecoderPath: decoderPath });
  const result = await processor.process({
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    mimeType: 'image/jpeg', fileName: 'video_thumb.jpg', kind: 'thumbnail', status: 'thumbnailOnly'
  });
  assert.equal(result.delivery, 'inline_image');
  assert.equal(result.contentItems[0].type, 'inputImage');
});
