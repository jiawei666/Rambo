import { spawn, type ChildProcess } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';

export type WechatMediaContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: 'inputAudio'; audioUrl: string };

export interface WechatMediaSource {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  kind?: string;
  status?: string;
  limitation?: string;
}

export interface WechatMediaDelivery {
  delivery: 'inline_image' | 'inline_audio' | 'video_frames' | 'inline_text';
  contentItems: WechatMediaContentItem[];
  frameTimesSeconds?: number[];
  videoDurationSeconds?: number;
  extractedTextCharacters?: number;
  truncated?: boolean;
}

type ProcessRunner = (
  binary: string,
  args: string[],
  input: Buffer,
  maxOutputBytes: number,
  timeoutMs: number
) => Promise<Buffer>;

const MAX_MEDIA_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 160_000;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4_096;
const MAX_PDF_PAGES = 200;
const MAX_VIDEO_FRAMES = 12;

function runProcess(
  binary: string,
  args: string[],
  input: Buffer,
  maxOutputBytes: number,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('无法启动本机媒体处理器'));
      return;
    }
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, output?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('微信媒体处理超时'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new Error('微信媒体处理结果超过大小限制'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish(new Error('本机媒体处理器不可用')));
    child.on('close', code => {
      if (code !== 0) {
        finish(new Error(stderr.trim()
          ? '本机媒体处理失败，请确认文件内容有效。'
          : '本机媒体处理失败。'));
        return;
      }
      finish(undefined, Buffer.concat(chunks, outputBytes));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

function boundedText(value: string): { text: string; truncated: boolean } {
  const normalized = value.replaceAll('\u0000', '').trim();
  return normalized.length > MAX_TEXT_CHARACTERS
    ? { text: normalized.slice(0, MAX_TEXT_CHARACTERS), truncated: true }
    : { text: normalized, truncated: false };
}

function fileExtension(fileName: string): string {
  const leaf = fileName.split(/[\\/]/u).at(-1) ?? '';
  const dot = leaf.lastIndexOf('.');
  return dot < 0 ? '' : leaf.slice(dot + 1).toLowerCase();
}

function xmlDocument(value: Buffer | string): Document {
  let invalid = false;
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: () => { invalid = true; },
      fatalError: () => { invalid = true; }
    }
  }).parseFromString(typeof value === 'string' ? value : value.toString('utf8'), 'application/xml');
  if (invalid) throw new Error('微信文件中的文档结构无法读取');
  return document;
}

function allText(node: Element, tag: string): string {
  return Array.from(node.getElementsByTagName(tag))
    .map(item => item.textContent ?? '')
    .join('');
}

type ZipEntry = {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

function zipEntries(bytes: Buffer): ZipEntry[] {
  const minimum = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('微信文件不是可识别的 Office 文档');
  const count = bytes.readUInt16LE(end + 10);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (count > MAX_ZIP_ENTRIES || centralOffset >= bytes.length) {
    throw new Error('微信 Office 文档目录无效或过大');
  }
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('微信 Office 文档目录已损坏');
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.length) throw new Error('微信 Office 文档目录已损坏');
    entries.push({
      name: bytes.subarray(nameStart, nameStart + nameLength).toString('utf8'),
      compression: bytes.readUInt16LE(offset + 10),
      compressedSize: bytes.readUInt32LE(offset + 20),
      uncompressedSize: bytes.readUInt32LE(offset + 24),
      localOffset: bytes.readUInt32LE(offset + 42)
    });
    offset = next;
  }
  return entries;
}

function zipEntryBytes(bytes: Buffer, entries: ZipEntry[], entryName: string): Buffer | null {
  const entry = entries.find(item => item.name === entryName);
  if (!entry) return null;
  if (entry.uncompressedSize > MAX_XML_BYTES || entry.compressedSize > bytes.length) {
    throw new Error('微信 Office 文档中的 XML 超过安全上限');
  }
  const header = entry.localOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== 0x04034b50) {
    throw new Error('微信 Office 文档内容已损坏');
  }
  const nameLength = bytes.readUInt16LE(header + 26);
  const extraLength = bytes.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new Error('微信 Office 文档内容已损坏');
  const compressed = bytes.subarray(start, end);
  if (entry.compression === 0) return Buffer.from(compressed);
  if (entry.compression !== 8) throw new Error('微信 Office 文档使用了不支持的压缩方式');
  return inflateRawSync(compressed, { maxOutputLength: MAX_XML_BYTES });
}

function officeText(bytes: Buffer, extension: string): string {
  const entries = zipEntries(bytes);
  if (extension === 'docx') {
    const document = zipEntryBytes(bytes, entries, 'word/document.xml');
    if (!document) throw new Error('Word 文档正文不存在');
    const xml = xmlDocument(document);
    const paragraphs = Array.from(xml.getElementsByTagName('w:p'))
      .map(paragraph => allText(paragraph, 'w:t'))
      .filter(Boolean);
    return paragraphs.join('\n');
  }
  if (extension === 'pptx') {
    const slides = entries.map(entry => entry.name)
      .map(name => ({ name, match: /^ppt\/slides\/slide(\d+)\.xml$/u.exec(name) }))
      .filter(item => item.match)
      .sort((a, b) => Number(a.match?.[1]) - Number(b.match?.[1]));
    return slides.map((slide, index) => {
      const document = zipEntryBytes(bytes, entries, slide.name);
      if (!document) return '';
      const xml = xmlDocument(document);
      const paragraphs = Array.from(xml.getElementsByTagName('a:p'))
        .map(paragraph => allText(paragraph, 'a:t'))
        .filter(Boolean);
      return paragraphs.length ? `第 ${index + 1} 页\n${paragraphs.join('\n')}` : '';
    }).filter(Boolean).join('\n\n');
  }
  if (extension === 'xlsx') {
    const sharedBytes = zipEntryBytes(bytes, entries, 'xl/sharedStrings.xml');
    const shared = sharedBytes
      ? Array.from(xmlDocument(sharedBytes).getElementsByTagName('si'))
        .map(item => allText(item, 't'))
      : [];
    const sheets = entries.map(entry => entry.name)
      .map(name => ({ name, match: /^xl\/worksheets\/sheet(\d+)\.xml$/u.exec(name) }))
      .filter(item => item.match)
      .sort((a, b) => Number(a.match?.[1]) - Number(b.match?.[1]));
    return sheets.map((sheet, sheetIndex) => {
      const sheetBytes = zipEntryBytes(bytes, entries, sheet.name);
      if (!sheetBytes) return '';
      const xml = xmlDocument(sheetBytes);
      const rows = Array.from(xml.getElementsByTagName('row')).map(row => {
        const values = new Map<number, string>();
        let width = 0;
        for (const cell of Array.from(row.getElementsByTagName('c'))) {
          const reference = cell.getAttribute('r') ?? '';
          const letters = /^([A-Z]+)/u.exec(reference)?.[1] ?? '';
          let column = 0;
          for (const char of letters) column = column * 26 + char.charCodeAt(0) - 64;
          column = Math.max(0, column - 1);
          const raw = cell.getElementsByTagName('v')[0]?.textContent ??
            allText(cell, 't');
          const value = cell.getAttribute('t') === 's'
            ? shared[Number(raw)] ?? ''
            : raw;
          values.set(column, value);
          width = Math.max(width, column + 1);
        }
        return Array.from({ length: width }, (_, column) => values.get(column) ?? '').join('\t');
      }).filter(Boolean);
      return rows.length ? `工作表 ${sheetIndex + 1}\n${rows.join('\n')}` : '';
    }).filter(Boolean).join('\n\n');
  }
  if (extension === 'odt') {
    const content = zipEntryBytes(bytes, entries, 'content.xml');
    if (!content) throw new Error('OpenDocument 文档正文不存在');
    const xml = xmlDocument(content);
    return [...Array.from(xml.getElementsByTagName('text:h')),
      ...Array.from(xml.getElementsByTagName('text:p'))]
      .map(item => item.textContent ?? '')
      .filter(Boolean)
      .join('\n');
  }
  throw new Error('该压缩文档格式当前不支持正文提取');
}

function rtfText(value: string): string {
  return value
    .replace(/\\'[0-9a-f]{2}/giu, value => String.fromCharCode(parseInt(value.slice(2), 16)))
    .replace(/\\u(-?\d+)\??/gu, (_whole, code: string) => String.fromCharCode(Number(code) & 0xffff))
    .replace(/\\(?:par|line)\b ?/giu, '\n')
    .replace(/\\tab\b ?/giu, '\t')
    .replace(/\\[a-z]+-?\d* ?/giu, '')
    .replace(/[{}]/gu, '')
    .replace(/\\([{}\\])/gu, '$1');
}

async function pdfText(bytes: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await loadingTask.promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, MAX_PDF_PAGES); pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => 'str' in item
        ? `${item.str}${item.hasEOL ? '\n' : ' '}`
        : '').join('').trim());
      page.cleanup();
      if (pages.join('\n').length >= MAX_TEXT_CHARACTERS) break;
    }
  } finally {
    await loadingTask.destroy();
  }
  if (document.numPages > MAX_PDF_PAGES) pages.push(`[仅提取前 ${MAX_PDF_PAGES} 页]`);
  return pages.filter(Boolean).join('\n\n');
}

function extractTextFromFile(bytes: Buffer, fileName: string, mimeType: string): Promise<string> {
  const extension = fileExtension(fileName);
  if (extension === 'pdf' || mimeType === 'application/pdf') return pdfText(bytes);
  if (['docx', 'xlsx', 'pptx', 'odt'].includes(extension)) return Promise.resolve(officeText(bytes, extension));
  if (['doc', 'xls', 'ppt', 'pages', 'numbers', 'key'].includes(extension)) {
    return Promise.reject(new Error('此旧版或专有 Office 格式无法在本机安全提取正文'));
  }
  const textExtensions = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm',
    'yaml', 'yml', 'toml', 'ini', 'log', 'eml', 'vcf', 'ics', 'rtf'
  ]);
  if (!textExtensions.has(extension) && !mimeType.startsWith('text/') &&
      !['application/json', 'application/xml', 'application/rtf'].includes(mimeType)) {
    return Promise.reject(new Error('此微信文件格式暂不能转换为 Agent 可读取的内容'));
  }
  const value = bytes.toString('utf8');
  if (value.includes('\u0000')) return Promise.reject(new Error('文件内容不是可读取的文本编码'));
  return Promise.resolve(extension === 'rtf' || mimeType === 'application/rtf' ? rtfText(value) : value);
}

function jpegFrames(bytes: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let start = -1;
  for (let index = 0; index + 1 < bytes.length; index++) {
    if (start < 0 && bytes[index] === 0xff && bytes[index + 1] === 0xd8) {
      start = index;
      index++;
      continue;
    }
    if (start >= 0 && bytes[index] === 0xff && bytes[index + 1] === 0xd9) {
      frames.push(bytes.subarray(start, index + 2));
      start = -1;
      if (frames.length === MAX_VIDEO_FRAMES) break;
      index++;
    }
  }
  return frames;
}

function findMp4Box(
  bytes: Buffer,
  rangeStart: number,
  rangeEnd: number,
  wanted: string
): { start: number; headerSize: number; size: number } | null {
  let offset = rangeStart;
  while (offset + 8 <= rangeEnd) {
    const size32 = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > rangeEnd) return null;
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) size = rangeEnd - offset;
    if (size < headerSize || offset + size > rangeEnd) return null;
    if (type === wanted) return { start: offset, headerSize, size };
    offset += size;
  }
  return null;
}

function mp4DurationSeconds(bytes: Buffer): number | null {
  const moov = findMp4Box(bytes, 0, bytes.length, 'moov');
  if (!moov) return null;
  const moovContent = moov.start + moov.headerSize;
  const mvhd = findMp4Box(bytes, moovContent, moov.start + moov.size, 'mvhd');
  if (!mvhd) return null;
  const fullBox = mvhd.start + mvhd.headerSize;
  const version = bytes[fullBox];
  const timescaleOffset = version === 1 ? fullBox + 20 : fullBox + 12;
  const durationOffset = version === 1 ? fullBox + 24 : fullBox + 16;
  if (version !== 0 && version !== 1 || durationOffset + (version === 1 ? 8 : 4) > mvhd.start + mvhd.size) {
    return null;
  }
  const timescale = bytes.readUInt32BE(timescaleOffset);
  const duration = version === 1
    ? bytes.readBigUInt64BE(durationOffset)
    : BigInt(bytes.readUInt32BE(durationOffset));
  if (!timescale || !duration || duration > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const seconds = Number(duration) / timescale;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function imageItem(bytes: Buffer, mimeType: string): WechatMediaContentItem {
  return { type: 'inputImage', imageUrl: `data:${mimeType};base64,${bytes.toString('base64')}` };
}

export class WechatMediaContentProcessor {
  constructor(
    private readonly paths: { ffmpegPath: string | null; silkDecoderPath: string | null },
    private readonly run: ProcessRunner = runProcess
  ) {}

  async process(media: WechatMediaSource): Promise<WechatMediaDelivery> {
    if (!media.bytes.length || media.bytes.length > MAX_MEDIA_INPUT_BYTES) {
      throw new Error('微信媒体为空或超过本机处理上限');
    }
    if (media.status !== 'available' && media.status !== 'thumbnailOnly') {
      throw new Error(media.limitation ?? '微信媒体内容当前不可用');
    }
    const extension = fileExtension(media.fileName);
    const imageType = media.mimeType.startsWith('image/')
      ? media.mimeType
      : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
        : extension === 'png' ? 'image/png'
          : extension === 'gif' ? 'image/gif'
            : extension === 'webp' ? 'image/webp' : null;
    if (imageType) {
      return { delivery: 'inline_image', contentItems: [imageItem(media.bytes, imageType)] };
    }

    const audioType = media.mimeType.startsWith('audio/')
      ? media.mimeType
      : extension === 'mp3' ? 'audio/mpeg'
        : extension === 'wav' ? 'audio/wav'
          : extension === 'm4a' ? 'audio/mp4'
            : extension === 'ogg' ? 'audio/ogg' : null;
    if (audioType || media.kind === 'audio') {
      let bytes = media.bytes;
      let mimeType = audioType ?? 'audio/silk';
      if (mimeType === 'audio/silk') {
        if (!this.paths.silkDecoderPath) throw new Error('微信语音解码器未随应用安装');
        bytes = await this.run(this.paths.silkDecoderPath, [], bytes, MAX_MEDIA_OUTPUT_BYTES, 30_000);
        if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
            bytes.toString('ascii', 8, 12) !== 'WAVE') {
          throw new Error('本机 SILK 解码器返回了无效的 WAV 音频');
        }
        mimeType = 'audio/wav';
      }
      return {
        delivery: 'inline_audio',
        contentItems: [{ type: 'inputAudio', audioUrl: `data:${mimeType};base64,${bytes.toString('base64')}` }]
      };
    }

    const isVideo = media.mimeType.startsWith('video/') ||
      ['mp4', 'mov', 'm4v', 'webm', '3gp'].includes(extension) || media.kind === 'video';
    if (isVideo) {
      if (!this.paths.ffmpegPath) throw new Error('视频抽帧工具未随应用安装');
      const durationSeconds = ['mp4', 'mov', 'm4v', '3gp'].includes(extension)
        ? mp4DurationSeconds(media.bytes)
        : null;
      const intervalSeconds = durationSeconds
        ? Math.max(0.25, durationSeconds / (MAX_VIDEO_FRAMES - 1))
        : 2;
      const frameFilter = `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${intervalSeconds.toFixed(3)})',scale=w=min(960\\,iw):h=-2`;
      const output = await this.run(this.paths.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe,data',
        '-i', 'pipe:0', '-map', '0:v:0', '-an',
        '-vf', frameFilter, '-vsync', '0', '-frames:v', String(MAX_VIDEO_FRAMES), '-f', 'image2pipe',
        '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1'
      ], media.bytes, MAX_MEDIA_OUTPUT_BYTES, 45_000);
      const frames = jpegFrames(output);
      if (!frames.length) throw new Error('本机视频中没有可读取的画面');
      const frameTimesSeconds = frames.map((_frame, index) => index * intervalSeconds);
      return {
        delivery: 'video_frames',
        frameTimesSeconds,
        ...(durationSeconds ? { videoDurationSeconds: durationSeconds } : {}),
        contentItems: [
          {
            type: 'inputText',
            text: durationSeconds
              ? `视频时长约 ${durationSeconds.toFixed(1)} 秒；按约 ${intervalSeconds.toFixed(1)} 秒间隔从全片抽取 ${frames.length} 帧，按时间顺序排列。`
              : `视频时长无法从本机元数据确定；按约 ${intervalSeconds.toFixed(1)} 秒间隔抽取前段画面，共 ${frames.length} 帧，按时间顺序排列。`
          },
          ...frames.map(frame => imageItem(frame, 'image/jpeg'))
        ]
      };
    }

    const rawText = await extractTextFromFile(media.bytes, media.fileName, media.mimeType);
    if (!rawText.trim()) throw new Error('文件没有可提取的文字内容');
    const bounded = boundedText(rawText);
    return {
      delivery: 'inline_text',
      extractedTextCharacters: bounded.text.length,
      truncated: bounded.truncated,
      contentItems: [{
        type: 'inputText',
        text: [
          `文件正文（${media.fileName || '微信文件'}）：`,
          bounded.text,
          bounded.truncated ? `\n[正文超过 ${MAX_TEXT_CHARACTERS} 字，后续内容已截断]` : ''
        ].join('\n')
      }]
    };
  }
}
