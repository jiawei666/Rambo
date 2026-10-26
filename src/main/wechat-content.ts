import { zstdDecompressSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';

export type WechatMessageContentType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'quote'
  | 'link'
  | 'card'
  | 'sticker'
  | 'location'
  | 'forward'
  | 'note'
  | 'group_notice'
  | 'transfer'
  | 'red_packet'
  | 'call'
  | 'recall'
  | 'join'
  | 'leave'
  | 'renamed'
  | 'system'
  | 'unknown';

export interface WechatMessageMediaDescriptor {
  kind: 'image' | 'voice' | 'video' | 'file' | 'sticker';
  name: string | null;
  storedAs: string | null;
  md5: string | null;
  size: number | null;
  extension: string | null;
  durationMs: number | null;
  durationSeconds: number | null;
  transcription: string | null;
  url: string | null;
}

export interface ParsedWechatMessageContent {
  /** Semantic kind for mapping into the reader's stable protocol. */
  type: WechatMessageContentType;
  /** The high 32-bit app subtype, or null when the row has none. */
  subtype: number | null;
  /** WeChat's original local_type, retained without semantic remapping. */
  localType: number;
  text: string | null;
  quoteMessageId: string | null;
  card: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  unknownPayload: Record<string, unknown> | null;
  mediaDescriptors: WechatMessageMediaDescriptor[];
  diagnostics: string[];
}

const ZSTD_COMPRESSION_TYPE = 4;

/**
 * Decode a message_content value returned by SQLite. WCDB compression type
 * 4 denotes a zstd frame; uncompressed text and unknown compression markers
 * are returned as UTF-8 without guessing another encoding.
 */
export function decodeWechatMessageContent(content: unknown, compressionType?: unknown): string {
  if (typeof content === 'string') {
    if (asInteger(compressionType) !== ZSTD_COMPRESSION_TYPE) return content;
    try {
      return zstdDecompressSync(Buffer.from(content, 'utf8')).toString('utf8');
    } catch {
      return content;
    }
  }

  const bytes = asBytes(content);
  if (!bytes) return '';
  if (asInteger(compressionType) === ZSTD_COMPRESSION_TYPE) {
    try {
      return zstdDecompressSync(bytes).toString('utf8');
    } catch {
      return Buffer.from(bytes).toString('utf8');
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Parse one WeChat row's local_type, XML/text content, and packed protobuf. */
export function parseWechatMessageContent(
  localType: number,
  content: string,
  packedInfo?: Uint8Array
): ParsedWechatMessageContent {
  const local = Number.isFinite(localType) ? Math.trunc(localType) : 0;
  const bits = BigInt.asUintN(64, BigInt(local));
  const rawType = Number(bits & 0xffff_ffffn);
  let subtype = Number((bits >> 32n) & 0xffff_ffffn);
  const body = stripGroupSenderPrefix(content);
  const base = (type: WechatMessageContentType, extras: Partial<ParsedWechatMessageContent> = {}): ParsedWechatMessageContent => ({
    type,
    subtype: subtype || null,
    localType: local,
    text: null,
    quoteMessageId: null,
    card: null,
    details: null,
    unknownPayload: null,
    mediaDescriptors: [],
    diagnostics: [],
    ...extras
  });
  const unknown = (diagnostic?: string): ParsedWechatMessageContent => base('unknown', {
    unknownPayload: { localType: local, rawContent: content, body },
    diagnostics: diagnostic ? [diagnostic] : []
  });

  if (rawType === 1) return base('text', { text: body });

  if (rawType === 10000 || rawType === 10002) {
    return parseSystemMessage(base, unknown, body, content, local, rawType);
  }

  if (rawType === 3 || rawType === 34 || rawType === 43 || rawType === 47) {
    const mediaKind = rawType === 3 ? 'image' : rawType === 34 ? 'voice' : rawType === 43 ? 'video' : 'sticker';
    const descriptor = parseMessageMedia(mediaKind, body, packedInfo);
    return base(mediaKind, {
      mediaDescriptors: [descriptor],
      diagnostics: isXml(body) ? [] : ['media_xml_unreadable']
    });
  }

  if (rawType === 42) {
    const xml = parseXml(body);
    if (!xml.root) return unknown(xml.diagnostics[0] ?? 'card_xml_unreadable');
    const contactId = attr(xml.root, 'username');
    const displayName = attr(xml.root, 'nickname');
    if (!contactId && !displayName) return unknown('card_fields_missing');
    return base('card', {
      card: { kind: 'contact', contactId, displayName, alias: attr(xml.root, 'alias') },
      diagnostics: xml.diagnostics
    });
  }

  if (rawType === 48) {
    const xml = parseXml(body);
    if (!xml.root) return unknown(xml.diagnostics[0] ?? 'location_xml_unreadable');
    const node = findElement(xml.root, 'location');
    if (!node) return unknown('location_element_missing');
    const latitude = finiteNumber(attr(node, 'x'));
    const longitude = finiteNumber(attr(node, 'y'));
    return base('location', {
      details: {
        latitude,
        longitude,
        name: attr(node, 'poiname'),
        address: attr(node, 'label')
      },
      diagnostics: xml.diagnostics
    });
  }

  if (rawType === 50) {
    const xml = parseXml(body);
    if (!xml.root) return unknown(xml.diagnostics[0] ?? 'call_xml_unreadable');
    const voip = firstElement(xml.root, 'voipmsg');
    const bubble = voip && firstElement(voip, 'VoIPBubbleMsg');
    if (!bubble) return unknown('call_bubble_missing');
    const shown = elementText(firstElement(bubble, 'msg'));
    const shownText = shown ?? '';
    const ended = callEndState(shownText);
    const seconds = ended ? null : callSeconds(shownText) ?? positiveInteger(elementText(firstElement(bubble, 'duration')));
    const roomType = elementText(firstElement(bubble, 'room_type'));
    return base('call', {
      text: shown,
      details: {
        medium: roomType === '0' ? 'video' : roomType === '1' ? 'voice' : null,
        state: ended ?? (seconds !== null ? 'connected' : null),
        seconds
      },
      diagnostics: xml.diagnostics
    });
  }

  if (rawType !== 49) return unknown('unsupported_local_type');

  const xml = parseXml(body);
  if (!xml.root) return unknown(xml.diagnostics[0] ?? 'app_xml_unreadable');
  const app = findElement(xml.root, 'appmsg');
  if (!app) return unknown('appmsg_element_missing');
  if (!subtype) subtype = positiveInteger(elementText(firstElement(app, 'type'))) ?? 0;

  const appBase = (type: WechatMessageContentType, extras: Partial<ParsedWechatMessageContent> = {}) =>
    base(type, { subtype: subtype || null, diagnostics: xml.diagnostics, ...extras });

  if (subtype === 6) {
    const descriptor = parseMessageMedia('file', body, packedInfo);
    return appBase('file', { mediaDescriptors: [descriptor] });
  }
  if (subtype === 8) {
    const descriptor = parseMessageMedia('sticker', body, packedInfo);
    return appBase('sticker', { mediaDescriptors: [descriptor] });
  }
  if (subtype === 57) {
    const referenced = firstElement(app, 'refermsg');
    const quotedId = nonZeroId(elementText(firstElement(referenced, 'svrid')));
    const quotedType = elementText(firstElement(referenced, 'type'));
    const excerpt = quotedType === '1' ? elementText(firstElement(referenced, 'content')) : null;
    const title = elementText(firstElement(app, 'title')) ?? '';
    const quoted = {
      senderId: elementText(firstElement(referenced, 'chatusr')) ?? elementText(firstElement(referenced, 'fromusr')),
      senderDisplayName: elementText(firstElement(referenced, 'displayname')),
      excerpt
    };
    return appBase('quote', {
      text: title,
      quoteMessageId: quotedId,
      card: { kind: 'quote', title, quoted, messageId: quotedId },
      details: { quoted }
    });
  }
  if (subtype === 2000 || subtype === 2001) {
    const pay = firstElement(app, 'wcpayinfo');
    if (!pay) return unknown('payment_info_missing');
    const shownAmount = elementText(firstElement(pay, 'feedesc'));
    const memo = subtype === 2000
      ? elementText(firstElement(pay, 'pay_memo'))
      : elementText(firstElement(pay, 'sendertitle')) ?? elementText(firstElement(pay, 'receivertitle'));
    if (subtype === 2000) {
      const paySubtype = elementText(firstElement(pay, 'paysubtype'));
      const state = paySubtype === '1' ? 'sent' : paySubtype === '3' ? 'received' : paySubtype === '4' ? 'returned' : null;
      return appBase('transfer', {
        text: memo,
        details: { amountFen: amountFen(shownAmount), state, memo }
      });
    }
    return appBase('red_packet', {
      text: memo,
      details: { amountFen: amountFen(shownAmount), state: null, memo }
    });
  }
  if (subtype === 87) {
    const notice = elementText(firstElement(app, 'textannouncement'));
    const announcement = elementText(firstElement(app, 'announcement'));
    const posterId = elementText(firstElement(xml.root, 'fromusername'));
    return appBase('group_notice', {
      text: notice ?? announcement,
      details: { text: notice ?? announcement ?? '', posterId, rawContent: body }
    });
  }
  if (subtype === 19) {
    const title = elementText(firstElement(app, 'title')) ?? '';
    return appBase('forward', { text: title, card: { kind: 'forward', title }, details: { rawContent: body } });
  }
  if (subtype === 24) {
    const title = elementText(firstElement(app, 'title')) ?? '';
    return appBase('note', { text: title, card: { kind: 'note', title }, details: { rawContent: body } });
  }
  if (subtype === 3 || subtype === 4 || subtype === 5 || subtype === 33 || subtype === 36 || subtype === 51 || subtype === 63) {
    const feed = firstElement(app, 'finderFeed') ?? firstElement(app, 'finderLive');
    const title = elementText(firstElement(feed, 'desc'))
      ?? elementText(firstElement(feed, 'nickname'))
      ?? elementText(firstElement(app, 'title'));
    const summary = elementText(firstElement(feed, 'nickname'))
      ?? elementText(firstElement(app, 'des'));
    const source = elementText(firstElement(app, 'sourcedisplayname'))
      ?? elementText(firstElement(firstElement(app, 'weappinfo'), 'appname'));
    const url = elementText(firstElement(app, 'url'));
    const category = subtype === 3 ? 'music'
      : subtype === 4 ? 'video'
        : subtype === 5 ? 'web_page'
          : subtype === 33 || subtype === 36 ? 'mini_program'
            : subtype === 51 ? 'channels_feed' : 'channels_live';
    const card = { kind: category, title: title ?? '', summary, url, source };
    return appBase('link', { text: title ?? null, card, details: { category, ...card } });
  }

  return unknown('unsupported_app_subtype');
}

function parseSystemMessage(
  base: (type: WechatMessageContentType, extras?: Partial<ParsedWechatMessageContent>) => ParsedWechatMessageContent,
  unknown: (diagnostic?: string) => ParsedWechatMessageContent,
  body: string,
  rawContent: string,
  localType: number,
  rawType: number
): ParsedWechatMessageContent {
  if (!body.trimStart().startsWith('<')) {
    const recall = parsePlainRecall(body);
    if (recall) return base('recall', { text: body, details: recall });
    return base(body.trim() ? 'system' : 'unknown', {
      text: body.trim() ? body : null,
      unknownPayload: body.trim() ? null : { localType, rawContent, body }
    });
  }
  const xml = parseXml(body);
  if (!xml.root) return unknown(xml.diagnostics[0] ?? 'system_xml_unreadable');
  const rootType = attr(xml.root, 'type');
  if (rootType === 'revokemsg') {
    const revoke = firstElement(xml.root, 'revokemsg');
    const text = elementText(firstElement(revoke, 'content')) ?? elementText(firstElement(revoke, 'replacemsg'));
    if (!text) return unknown('recall_notice_missing');
    const recalledMessageId = nonZeroId(elementText(firstElement(revoke, 'newmsgid')));
    return base('recall', {
      text,
      details: { text, recalledMessageId },
      diagnostics: xml.diagnostics
    });
  }
  if (rootType === 'sysmsgtemplate') {
    const templateNode = firstElement(xml.root, 'content_template');
    const parsed = parseSystemTemplate(templateNode);
    if (parsed) return base(parsed.type, { text: parsed.text, details: parsed.details, diagnostics: xml.diagnostics });
  }
  return base(rawType === 10000 ? 'system' : 'unknown', {
    text: elementText(xml.root),
    unknownPayload: { localType, rawContent, body },
    diagnostics: [...xml.diagnostics, 'unsupported_system_xml']
  });
}

function parsePlainRecall(text: string): Record<string, unknown> | null {
  const notice = text.trim().replace(/[.。]+$/u, '').trim();
  const ending = notice.endsWith('撤回了一条消息') ? '撤回了一条消息'
    : notice.endsWith('recalled a message') ? 'recalled a message' : null;
  if (!ending) return null;
  const by = notice.slice(0, -ending.length).trim();
  return { text, by: by || null, recalledMessageId: null };
}

function parseSystemTemplate(templateNode: Element | null): {
  type: WechatMessageContentType;
  text: string;
  details: Record<string, unknown>;
} | null {
  if (!templateNode) return null;
  const template = elementText(firstElement(templateNode, 'template'));
  if (!template) return null;
  const links = firstElement(templateNode, 'link_list');
  const slots = links ? childElements(links, 'link').map(link => {
    const name = attr(link, 'name');
    const memberList = firstElement(link, 'memberlist');
    const members = memberList ? childElements(memberList, 'member').map(member => ({
      id: elementText(firstElement(member, 'username')) ?? '',
      displayName: elementText(firstElement(member, 'nickname')) ?? ''
    })).filter(member => member.id || member.displayName) : [];
    const separator = elementText(firstElement(link, 'separator')) ?? '、';
    const plain = elementText(firstElement(link, 'plain')) ?? '';
    const shown = members.length ? members.map(member => member.displayName).join(separator) : plain;
    return { name, members, shown };
  }).filter(slot => slot.name) : [];
  const text = slots.reduce((notice, slot) => notice.replaceAll(`$${slot.name}$`, slot.shown), template);
  const findSlot = (name: string) => slots.find(slot => slot.name === name);
  const renamed = template.includes('修改群名') || template.includes('群名改为') || template.includes('群名修改');
  const joined = template.includes('加入') || template.includes('进群');
  const left = template.includes('移出') || template.includes('退出') || template.includes('退群');
  let type: WechatMessageContentType = renamed ? 'renamed' : joined ? 'join' : left ? 'leave' : 'system';
  const changedName = findSlot('remark')?.shown || null;
  if (renamed && !changedName) type = 'system';
  const people = slots.flatMap(slot => slot.members.map(member => ({ ...member, slot: slot.name })));
  return {
    type,
    text,
    details: {
      template,
      text,
      name: changedName,
      people: people.map(({ id, displayName }) => ({ id, displayName }))
    }
  };
}

function parseMessageMedia(
  kind: WechatMessageMediaDescriptor['kind'],
  content: string,
  packedInfo?: Uint8Array
): WechatMessageMediaDescriptor {
  const xml = parseXml(content);
  const root = xml.root;
  const app = root && firstElement(root, 'appmsg');
  const attach = app && firstElement(app, 'appattach');
  if (kind === 'image') {
    const img = root && firstElement(root, 'img');
    return emptyMessageMedia(kind, {
      name: protoText(packedInfo, [3, 4]),
      md5: attr(img, 'md5')
    });
  }
  if (kind === 'video') {
    const video = root && firstElement(root, 'videomsg');
    return emptyMessageMedia(kind, {
      name: protoText(packedInfo, [4, 8]),
      md5: attr(video, 'md5'),
      durationSeconds: positiveInteger(attr(video, 'playlength'))
    });
  }
  if (kind === 'voice') {
    const voice = root && firstElement(root, 'voicemsg');
    const state = protoVarint(packedInfo, [5, 1]);
    const transcription = state === 2 ? protoText(packedInfo, [5, 2]) : null;
    return emptyMessageMedia(kind, {
      durationMs: positiveInteger(attr(voice, 'voicelength')),
      transcription
    });
  }
  if (kind === 'file') {
    const title = elementText(firstElement(app, 'title'));
    return emptyMessageMedia(kind, {
      name: title,
      storedAs: protoText(packedInfo, [7, 2]) ?? title,
      size: positiveInteger(elementText(firstElement(attach, 'totallen'))),
      extension: elementText(firstElement(attach, 'fileext'))
    });
  }
  const emoji = root && firstElement(root, 'emoji');
  const md5 = attr(emoji, 'md5') ?? elementText(firstElement(attach, 'emoticonmd5'));
  let url = attr(emoji, 'cdnurl');
  if (!url) {
    const encoded = elementText(firstElement(attach, 'emojiinfo'));
    const bytes = decodeBase64(encoded);
    url = bytes ? protoText(bytes, [2]) : null;
  }
  return emptyMessageMedia(kind, { md5: md5?.toLowerCase() ?? null, url });
}

function emptyMessageMedia(
  kind: WechatMessageMediaDescriptor['kind'],
  fields: Partial<Omit<WechatMessageMediaDescriptor, 'kind'>> = {}
): WechatMessageMediaDescriptor {
  return {
    kind,
    name: null,
    storedAs: null,
    md5: null,
    size: null,
    extension: null,
    durationMs: null,
    durationSeconds: null,
    transcription: null,
    url: null,
    ...fields
  };
}

function directChildFields(node: Element): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const child of childElements(node)) {
    const name = tagName(child);
    const value = elementText(child);
    const attributes: Record<string, string> = {};
    for (let index = 0; index < child.attributes.length; index += 1) {
      const attribute = child.attributes.item(index);
      if (attribute) attributes[attribute.name] = attribute.value;
    }
    fields[name] = Object.keys(attributes).length ? { value, attributes } : value;
  }
  return fields;
}

function parseXml(source: string): { root: Element | null; diagnostics: string[] } {
  if (!source.trim()) return { root: null, diagnostics: ['xml_empty'] };
  const diagnostics: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: () => diagnostics.push('xml_parse_failed'),
      fatalError: () => diagnostics.push('xml_parse_failed')
    }
  }).parseFromString(source, 'application/xml');
  const root = document.documentElement;
  if (!root || tagName(root) === 'parsererror') {
    if (!diagnostics.includes('xml_parse_failed')) diagnostics.push('xml_parse_failed');
    return { root: null, diagnostics };
  }
  return { root, diagnostics: [...new Set(diagnostics)] };
}

function isXml(source: string): boolean {
  return Boolean(parseXml(source).root);
}

function firstElement(node: Element | null | undefined, name: string): Element | null {
  if (!node) return null;
  for (const child of childElements(node)) {
    if (tagName(child) === name) return child;
    const nested = firstElement(child, name);
    if (nested) return nested;
  }
  return null;
}

function findElement(node: Element, name: string): Element | null {
  if (tagName(node) === name) return node;
  return firstElement(node, name);
}

function childElements(node: Element, name?: string): Element[] {
  const children: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) {
      const element = child as Element;
      if (!name || tagName(element) === name) children.push(element);
    }
  }
  return children;
}

function tagName(node: Element): string {
  return node.localName || node.nodeName;
}

function elementText(node: Element | null | undefined): string | null {
  if (!node) return null;
  const value = node.textContent?.trim() ?? '';
  return value || null;
}

function attr(node: Element | null | undefined, name: string): string | null {
  if (!node) return null;
  const value = node.getAttribute(name);
  return value === null || value === '' ? null : value;
}

function stripGroupSenderPrefix(content: string): string {
  return content.replace(/^[^\r\n]{1,256}:\r?\n/u, '');
}

function asInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return null;
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function finiteNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonZeroId(value: string | null): string | null {
  return value && value !== '0' ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

function amountFen(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^[￥¥]\s*(\d{1,15})(?:\.(\d{0,2}))?$/u);
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const fen = Number(match[1]) * 100 + Number(fraction || 0);
  return Number.isSafeInteger(fen) ? fen : null;
}

function callEndState(shown: string): 'cancelled' | 'declined' | 'missed' | null {
  if (/取消|cancelled/iu.test(shown)) return 'cancelled';
  if (/拒绝|declined/iu.test(shown)) return 'declined';
  if (/无应答|未应答|未接听|忙线|missed/iu.test(shown)) return 'missed';
  return null;
}

function callSeconds(shown: string): number | null {
  const match = shown.trim().match(/^(?:通话时长\s*)?(\d{1,2}:\d{2}(?::\d{2})?)$/u);
  if (!match) return null;
  const parts = match[1].split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60)) return null;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

function decodeBase64(value: string | null): Uint8Array | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/gu, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) return null;
  return Buffer.from(normalized, 'base64');
}

function protoText(bytes: Uint8Array | undefined, path: number[]): string | null {
  const value = protoBytes(bytes, path);
  if (!value) return null;
  const text = Buffer.from(value).toString('utf8').trim();
  return text || null;
}

function protoVarint(bytes: Uint8Array | undefined, path: number[]): number | null {
  if (!bytes || !path.length) return null;
  const [field, ...rest] = path;
  const found = findProtoField(bytes, field);
  if (!found) return null;
  if (rest.length) return found.wireType === 2 && found.bytes ? protoVarint(found.bytes, rest) : null;
  if (found.wireType !== 0 || found.value === undefined) return null;
  return found.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(found.value) : null;
}

function protoBytes(bytes: Uint8Array | undefined, path: number[]): Uint8Array | null {
  if (!bytes || !path.length) return null;
  const [field, ...rest] = path;
  const found = findProtoField(bytes, field);
  if (!found || found.wireType !== 2 || !found.bytes) return null;
  return rest.length ? protoBytes(found.bytes, rest) : found.bytes;
}

function findProtoField(bytes: Uint8Array, wanted: number): { wireType: number; bytes?: Uint8Array; value?: bigint } | null {
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) return null;
    offset = tag.offset;
    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (!field) return null;
    let valueBytes: Uint8Array | undefined;
    let scalarValue: bigint | undefined;
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      if (!value) return null;
      scalarValue = value.value;
      offset = value.offset;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.value > BigInt(bytes.length)) return null;
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > bytes.length) return null;
      valueBytes = bytes.subarray(offset, end);
      offset = end;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      return null;
    }
    if (offset > bytes.length) return null;
    if (field === wanted) return {
      wireType,
      ...(valueBytes ? { bytes: valueBytes } : {}),
      ...(scalarValue !== undefined ? { value: scalarValue } : {})
    };
  }
  return null;
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; offset: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let offset = start; offset < bytes.length && shift < 70n; offset += 1) {
    const byte = bytes[offset];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: offset + 1 };
    shift += 7n;
  }
  return null;
}
