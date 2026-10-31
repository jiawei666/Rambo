import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface WechatImageKey {
  /** 16 ASCII characters derived from MD5 for WeChat V2 image DAT files. */
  aesKey: string;
  /** Single-byte XOR key, stored as an unsigned byte. */
  xorKey: number;
}

export function normalizeWechatAccountId(accountId: string): string {
  const raw = accountId.trim();
  if (!raw) return raw;
  if (raw.startsWith('wxid_')) {
    const withoutPrefix = raw.slice('wxid_'.length);
    const head = withoutPrefix.split('_')[0] ?? withoutPrefix;
    return `wxid_${head}`;
  }
  const suffix = /_([a-f0-9]{4})$/iu.exec(raw);
  return suffix ? raw.slice(0, -suffix[0].length) : raw;
}

export function deriveWechatImageKeyCandidates(
  codes: Iterable<number>,
  accountId: string
): WechatImageKey[] {
  const wxids = [...new Set([normalizeWechatAccountId(accountId), accountId.trim()].filter(Boolean))];
  const seen = new Set<string>();
  const candidates: WechatImageKey[] = [];
  for (const code of codes) {
    if (!Number.isSafeInteger(code) || code < 0 || code > 0xffffffff) continue;
    for (const wxid of wxids) {
      const aesKey = createHash('md5')
        .update(`${code}${wxid}`)
        .digest('hex')
        .slice(0, 16);
      const xorKey = code & 0xff;
      const identity = `${aesKey}:${xorKey}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      candidates.push({ aesKey, xorKey });
    }
  }
  return candidates;
}

function imageFormat(bytes: Buffer): string | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'wxgf') {
    return 'image/wxgf';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return 'image/gif';
  }
  if (bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function isWechatWxgf(bytes: Buffer): boolean {
  return bytes.length >= 20 && bytes.subarray(0, 4).toString('ascii') === 'wxgf';
}

export function wechatWxgfEmbeddedImage(bytes: Buffer): Buffer | null {
  if (!isWechatWxgf(bytes)) return null;
  const limit = Math.min(bytes.length, 4_096);
  for (let offset = 4; offset + 4 <= limit; offset++) {
    if (bytes[offset] === 0xff && bytes[offset + 1] === 0xd8 && bytes[offset + 2] === 0xff) {
      return bytes.subarray(offset);
    }
    if (bytes[offset] === 0x89 && bytes[offset + 1] === 0x50 &&
        bytes[offset + 2] === 0x4e && bytes[offset + 3] === 0x47) {
      return bytes.subarray(offset);
    }
  }
  return null;
}

function mergeHevcNaluUnits(units: Buffer[]): Buffer {
  const merged: Buffer[] = [];
  for (const unit of units) {
    if (unit.length < 2) continue;
    merged.push(Buffer.from([0x00, 0x00, 0x00, 0x01]), unit);
  }
  return Buffer.concat(merged);
}

function extractHevcNaluUnits(bytes: Buffer): Buffer[] {
  const starts: Array<{ offset: number; prefixLength: number }> = [];
  for (let offset = 4; offset + 3 <= bytes.length;) {
    if (bytes[offset] === 0x00 && bytes[offset + 1] === 0x00 &&
        bytes[offset + 2] === 0x00 && bytes[offset + 3] === 0x01) {
      starts.push({ offset, prefixLength: 4 });
      offset += 4;
      continue;
    }
    if (bytes[offset] === 0x00 && bytes[offset + 1] === 0x00 && bytes[offset + 2] === 0x01) {
      starts.push({ offset, prefixLength: 3 });
      offset += 3;
      continue;
    }
    offset++;
  }
  const units: Buffer[] = [];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]!;
    const end = starts[index + 1]?.offset ?? bytes.length;
    const payload = bytes.subarray(start.offset + start.prefixLength, end);
    if (payload.length < 2 || (payload[0]! & 0x80) !== 0) continue;
    units.push(payload);
  }
  return units;
}

export function wechatWxgfHevcCandidates(
  bytes: Buffer
): Array<{ name: string; bytes: Buffer }> {
  if (!isWechatWxgf(bytes)) return [];
  const units = extractHevcNaluUnits(bytes);
  const candidates: Array<{ name: string; bytes: Buffer }> = [];
  const addCandidate = (name: string, data: Buffer | null | undefined) => {
    if (!data || data.length < 100 || candidates.some(item => item.bytes.equals(data))) return;
    candidates.push({ name, bytes: data });
  };

  const vpsStarts: number[] = [];
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]!;
    if (unit.length >= 2 && ((unit[0]! >> 1) & 0x3f) === 32) vpsStarts.push(index);
  }
  const groups: Array<{ index: number; bytes: Buffer; size: number }> = [];
  for (let index = 0; index < vpsStarts.length; index++) {
    const groupUnits = units.slice(vpsStarts[index]!, vpsStarts[index + 1] ?? units.length);
    const hasPicture = groupUnits.some(unit => {
      if (unit.length < 2) return false;
      const type = (unit[0]! >> 1) & 0x3f;
      return type === 19 || type === 20 || type === 1;
    });
    if (!hasPicture) continue;
    const merged = mergeHevcNaluUnits(groupUnits);
    groups.push({ index, bytes: merged, size: merged.length });
  }
  groups.sort((left, right) => right.size - left.size);
  for (const group of groups) addCandidate(`group_${group.index}`, group.bytes);

  addCandidate('scan_all_nalus', mergeHevcNaluUnits(units));
  addCandidate('raw_skip4', bytes.subarray(4));
  return candidates;
}

export function decryptWechatV2ImageDat(
  bytes: Buffer,
  key: WechatImageKey
): { bytes: Buffer; mimeType: string } | null {
  if (bytes.length < 15 ||
      bytes[0] !== 0x07 || bytes[1] !== 0x08 || bytes[2] !== 0x56 ||
      bytes[3] !== 0x32 || bytes[4] !== 0x08 || bytes[5] !== 0x07 ||
      !/^[a-f0-9]{16}$/iu.test(key.aesKey) ||
      !Number.isInteger(key.xorKey) || key.xorKey < 0 || key.xorKey > 0xff) {
    return null;
  }
  const aesSize = bytes.readUInt32LE(6);
  const xorSize = bytes.readUInt32LE(10);
  const body = bytes.subarray(15);
  const paddedSize = (Math.floor(aesSize / 16) + 1) * 16;
  if (paddedSize > body.length || xorSize > body.length - paddedSize) return null;
  let decrypted: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key.aesKey, 'ascii'), null);
    decipher.setAutoPadding(false);
    decrypted = Buffer.concat([
      decipher.update(body.subarray(0, paddedSize)),
      decipher.final()
    ]);
  } catch {
    return null;
  }
  const padding = decrypted.at(-1) ?? 0;
  if (padding < 1 || padding > 16 || padding > decrypted.length ||
      !decrypted.subarray(decrypted.length - padding).every(value => value === padding)) {
    return null;
  }
  const middleEnd = body.length - xorSize;
  const output = Buffer.concat([
    decrypted.subarray(0, decrypted.length - padding),
    body.subarray(paddedSize, middleEnd),
    Buffer.from(body.subarray(middleEnd).map(value => value ^ key.xorKey))
  ]);
  const mimeType = imageFormat(output);
  return mimeType ? { bytes: output, mimeType } : null;
}

/**
 * Tests derived candidates against already-cached V2 image DAT files. The
 * caller receives only a verified key; file contents and failures stay local.
 */
export function findVerifiedWechatImageKey(
  dataDirectory: string,
  accountId: string,
  codes: Iterable<number>
): WechatImageKey | null {
  const candidates = deriveWechatImageKeyCandidates(codes, accountId);
  if (!candidates.length) return null;
  const pending = [{ path: join(dataDirectory, 'msg', 'attach'), depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 4_096) {
    const current = pending.shift()!;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > 4_096) break;
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < 6) {
        pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.dat')) continue;
      try {
        if (statSync(path).size > 32 * 1024 * 1024) continue;
        const bytes = readFileSync(path);
        for (const candidate of candidates) {
          if (decryptWechatV2ImageDat(bytes, candidate)) return candidate;
        }
      } catch {
        // A locked or disappearing cache file is not a connection failure.
      }
    }
  }
  return null;
}
