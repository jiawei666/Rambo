import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const source = (await import('node:fs/promises')).readFile(
  new URL('../../src/main/wechat-image-key.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(await source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
  decryptWechatV2ImageDat,
  deriveWechatImageKeyCandidates,
  findVerifiedWechatImageKey,
  normalizeWechatAccountId,
  wechatWxgfEmbeddedImage,
  wechatWxgfHevcCandidates
} = await import(moduleUrl);

function fixture(code) {
  const aesKey = createHash('md5')
    .update(`${code}wxid_alice`)
    .digest('hex')
    .slice(0, 16);
  const xorKey = code & 0xff;
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const raw = Buffer.from('v2-raw-section');
  const tail = Buffer.from('v2-xor-tail');
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii'), null);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const header = Buffer.alloc(15);
  Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]).copy(header);
  header.writeUInt32LE(plain.length, 6);
  header.writeUInt32LE(tail.length, 10);
  return {
    aesKey,
    xorKey,
    expected: Buffer.concat([plain, raw, tail]),
    dat: Buffer.concat([
      header,
      encrypted,
      raw,
      Buffer.from(tail.map(value => value ^ xorKey))
    ])
  };
}

test('WeChat image key normalization handles account directory suffixes', () => {
  assert.equal(normalizeWechatAccountId('wxid_alice_abcd'), 'wxid_alice');
  assert.equal(normalizeWechatAccountId('wxid_alice'), 'wxid_alice');
});

test('WeChat V2 image DAT decrypts with independently derived AES and XOR keys', () => {
  const item = fixture(0x1234);
  const candidates = deriveWechatImageKeyCandidates(
    [0x1234],
    'wxid_alice_abcd'
  );
  const matching = candidates.find(candidate => candidate.aesKey === item.aesKey);
  assert.ok(matching);
  const decoded = decryptWechatV2ImageDat(item.dat, matching);
  assert.equal(decoded?.mimeType, 'image/jpeg');
  assert.deepEqual([...decoded.bytes], [...item.expected]);
});

test('WeChat WXGF is recognized, exposes embedded rasters, and extracts HEVC by VPS group', () => {
  const nalu = (type, size, marker) => {
    const value = Buffer.alloc(size, marker);
    value[0] = type << 1;
    value[1] = 1;
    return value;
  };
  const groupOne = [
    nalu(32, 110, 0x11),
    nalu(33, 40, 0x12),
    nalu(19, 120, 0x13)
  ];
  const groupTwo = [
    nalu(32, 130, 0x21),
    nalu(33, 50, 0x22),
    nalu(19, 180, 0x23)
  ];
  const withNalus = Buffer.concat([
    Buffer.from('wxgf'),
    Buffer.alloc(20, 0),
    ...groupOne.flatMap(unit => [Buffer.from([0, 0, 0, 1]), unit]),
    ...groupTwo.flatMap(unit => [Buffer.from([0, 0, 0, 1]), unit])
  ]);
  const candidates = wechatWxgfHevcCandidates(withNalus);
  assert.equal(candidates[0]?.name, 'group_1');
  assert.ok(candidates[0].bytes.includes(nalu(32, 130, 0x21)));
  assert.equal(wechatWxgfHevcCandidates(Buffer.from('not-wxgf')).length, 0);

  const embedded = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
  const withEmbedded = Buffer.concat([Buffer.from('wxgf'), Buffer.alloc(20, 0), embedded]);
  assert.deepEqual(wechatWxgfEmbeddedImage(withEmbedded), embedded);
});

test('WeChat image key verification scans existing V2 DAT files and returns only a matching key', () => {
  const root = mkdtempSync(join(tmpdir(), 'rambo-wechat-image-key-'));
  try {
    const item = fixture(0x1234);
    const directory = join(root, 'msg', 'attach', 'session-hash', '2026-10', 'Img');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'sample_h.dat'), item.dat);
    assert.deepEqual(
      findVerifiedWechatImageKey(root, 'wxid_alice_abcd', [0, 0x1234]),
      { aesKey: item.aesKey, xorKey: item.xorKey }
    );
    assert.equal(findVerifiedWechatImageKey(root, 'wxid_alice_abcd', [0]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
