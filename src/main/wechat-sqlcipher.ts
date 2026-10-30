import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

export const WECHAT_PAGE_SIZE = 4096;
export const WECHAT_PASSPHRASE_ITERATIONS = 256_000;
const RESERVE_SIZE = 80;
const SALT_SIZE = 16;
const IV_SIZE = 16;
const HMAC_SIZE = 64;
const BODY_END = WECHAT_PAGE_SIZE - RESERVE_SIZE;
const WAL_HEADER_SIZE = 32;
const WAL_FRAME_HEADER_SIZE = 24;
const WAL_FRAME_SIZE = WAL_FRAME_HEADER_SIZE + WECHAT_PAGE_SIZE;
const WAL_MAGIC = 0x377f0682;

export type WechatSqlCipherKey = Buffer | Uint8Array | string;

export class WechatSqlCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WechatSqlCipherError';
  }
}

interface WalFrame {
  number: number;
  databasePages: number;
  page: Buffer;
}

export function sqlCipherKeyBytes(value: WechatSqlCipherKey): Buffer {
  const bytes = typeof value === 'string'
    ? /^[a-f0-9]{64}$/iu.test(value)
      ? Buffer.from(value, 'hex')
      : Buffer.from(value, 'utf8')
    : Buffer.from(value);
  if (bytes.length !== 32) {
    throw new WechatSqlCipherError('微信数据库密钥必须为 32 字节');
  }
  return bytes;
}

/**
 * WeChat 4.1 derives each database key from an account-level 32-byte
 * passphrase and that database's 16-byte header salt.
 */
export function deriveWechatDatabaseKey(
  passphraseValue: WechatSqlCipherKey,
  saltValue: Buffer | Uint8Array
): Buffer {
  const passphrase = sqlCipherKeyBytes(passphraseValue);
  const salt = Buffer.from(saltValue);
  if (salt.length !== SALT_SIZE) {
    throw new WechatSqlCipherError('微信数据库 salt 必须为 16 字节');
  }
  return pbkdf2Sync(
    passphrase,
    salt,
    WECHAT_PASSPHRASE_ITERATIONS,
    32,
    'sha512'
  );
}

/**
 * Validate a candidate key before decrypting. The HMAC is computed over the
 * encrypted page body, IV, and little-endian page number.
 */
export function opensWechatDatabase(
  keyValue: WechatSqlCipherKey,
  encrypted: Buffer | Uint8Array
): boolean {
  const key = sqlCipherKeyBytes(keyValue);
  const bytes = Buffer.from(encrypted);
  if (bytes.length < WECHAT_PAGE_SIZE) return false;
  const page = bytes.subarray(0, WECHAT_PAGE_SIZE);
  const salt = page.subarray(0, SALT_SIZE);
  const expected = page.subarray(WECHAT_PAGE_SIZE - HMAC_SIZE);
  const actual = pageHmac(key, page, salt, SALT_SIZE, 1);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Decrypt SQLCipher pages and overlay only committed WAL frames. The result
 * is a rollback-journal SQLite database that can be opened fully in memory.
 */
export function decryptWechatDatabase(
  keyValue: WechatSqlCipherKey,
  encrypted: Buffer | Uint8Array,
  walValue: Buffer | Uint8Array = Buffer.alloc(0)
): Buffer {
  const key = sqlCipherKeyBytes(keyValue);
  const database = Buffer.from(encrypted);
  if (database.length < WECHAT_PAGE_SIZE || database.length % WECHAT_PAGE_SIZE !== 0) {
    throw new WechatSqlCipherError('微信数据库长度不是完整的 4096 字节页');
  }
  if (!opensWechatDatabase(key, database)) {
    throw new WechatSqlCipherError('密钥无法验证微信数据库首页 HMAC');
  }
  const pages = database.length / WECHAT_PAGE_SIZE;
  const frames = committedWalFrames(Buffer.from(walValue));
  const last = frames.at(-1);
  const finalPages = last?.databasePages ?? pages;
  if (finalPages < 1) {
    throw new WechatSqlCipherError('微信 WAL 提交后的数据库大小无效');
  }
  const output = Buffer.alloc(finalPages * WECHAT_PAGE_SIZE);
  for (let index = 0; index < Math.min(pages, finalPages); index++) {
    const page = database.subarray(index * WECHAT_PAGE_SIZE, (index + 1) * WECHAT_PAGE_SIZE);
    decryptPage(key, page, index + 1).copy(
      output,
      index * WECHAT_PAGE_SIZE
    );
  }
  for (const frame of frames) {
    const offset = (frame.number - 1) * WECHAT_PAGE_SIZE;
    if (frame.number < 1) {
      throw new WechatSqlCipherError('微信 WAL frame 超出数据库范围');
    }
    // A committed transaction may truncate the database. SQLite can retain
    // trailing frames for pages beyond that transaction's committed size.
    if (frame.number > finalPages) continue;
    decryptPage(key, frame.page, frame.number).copy(output, offset);
  }
  if (last) {
    output.subarray(28, 32).writeUInt32BE(last.databasePages);
    return output;
  }
  output[18] = 1;
  output[19] = 1;
  return output;
}

/**
 * Synthetic fixture helper for the same SQLCipher page format. Tests use it
 * to prove key validation, page decryption and WAL overlay without copying
 * any real WeChat database.
 */
export function encryptWechatDatabaseFixture(
  plain: Buffer | Uint8Array,
  keyValue: WechatSqlCipherKey,
  saltValue: Buffer | Uint8Array = randomBytes(SALT_SIZE),
  ivForPage: (pageNumber: number) => Buffer = pageNumber =>
    Buffer.alloc(IV_SIZE, pageNumber & 0xff)
): Buffer {
  const key = sqlCipherKeyBytes(keyValue);
  const salt = Buffer.from(saltValue);
  if (salt.length !== SALT_SIZE) throw new WechatSqlCipherError('salt 必须为 16 字节');
  const database = Buffer.from(plain);
  if (database.length < WECHAT_PAGE_SIZE || database.length % WECHAT_PAGE_SIZE !== 0) {
    throw new WechatSqlCipherError('测试数据库长度不是完整的 4096 字节页');
  }
  const output = Buffer.alloc(database.length);
  for (let index = 0; index < database.length / WECHAT_PAGE_SIZE; index++) {
    const number = index + 1;
    const page = Buffer.from(
      database.subarray(index * WECHAT_PAGE_SIZE, (index + 1) * WECHAT_PAGE_SIZE)
    );
    page.subarray(BODY_END).fill(0);
    const iv = ivForPage(number);
    if (iv.length !== IV_SIZE) throw new WechatSqlCipherError('IV 必须为 16 字节');
    const from = number === 1 ? SALT_SIZE : 0;
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(false);
    cipher.update(page.subarray(from, BODY_END)).copy(page, from);
    cipher.final();
    if (number === 1) salt.copy(page, 0);
    iv.copy(page, BODY_END);
    pageHmac(key, page, salt, from, number).copy(page, WECHAT_PAGE_SIZE - HMAC_SIZE);
    page.copy(output, index * WECHAT_PAGE_SIZE);
  }
  return output;
}

export function encryptWechatWalFixture(
  frames: Array<{ number: number; databasePages: number; page: Buffer | Uint8Array }>,
  saltValue: Buffer | Uint8Array = randomBytes(8),
  bigEndian = true
): Buffer {
  const salts = Buffer.from(saltValue);
  if (salts.length !== 8) throw new WechatSqlCipherError('WAL salt 必须为 8 字节');
  const header = Buffer.alloc(WAL_HEADER_SIZE);
  header.writeUInt32BE(WAL_MAGIC | (bigEndian ? 1 : 0), 0);
  header.writeUInt32BE(3_007_000, 4);
  header.writeUInt32BE(WECHAT_PAGE_SIZE, 8);
  salts.copy(header, 16);
  let sums = walChecksum(bigEndian, header.subarray(0, 24), [0, 0]);
  header.writeUInt32BE(sums[0], 24);
  header.writeUInt32BE(sums[1], 28);
  const chunks = [header];
  for (const frame of frames) {
    if (!Number.isInteger(frame.number) || frame.number < 1) {
      throw new WechatSqlCipherError('WAL frame 页号无效');
    }
    const page = Buffer.from(frame.page);
    if (page.length !== WECHAT_PAGE_SIZE) {
      throw new WechatSqlCipherError('WAL frame 必须包含完整 4096 字节页');
    }
    const frameHeader = Buffer.alloc(WAL_FRAME_HEADER_SIZE);
    frameHeader.writeUInt32BE(frame.number, 0);
    frameHeader.writeUInt32BE(frame.databasePages, 4);
    salts.copy(frameHeader, 8);
    sums = walChecksum(bigEndian, page, walChecksum(bigEndian, frameHeader.subarray(0, 8), sums));
    frameHeader.writeUInt32BE(sums[0], 16);
    frameHeader.writeUInt32BE(sums[1], 20);
    chunks.push(frameHeader, page);
  }
  return Buffer.concat(chunks);
}

function pageHmac(
  key: Buffer,
  page: Buffer,
  salt: Buffer,
  from: number,
  pageNumber: number
): Buffer {
  const macSalt = Buffer.from(salt);
  for (let index = 0; index < macSalt.length; index++) macSalt[index] ^= 0x3a;
  const macKey = pbkdf2Sync(key, macSalt, 2, 32, 'sha512');
  const number = Buffer.alloc(4);
  number.writeUInt32LE(pageNumber);
  return createHmac('sha512', macKey)
    .update(page.subarray(from, BODY_END + IV_SIZE))
    .update(number)
    .digest();
}

function decryptPage(key: Buffer, encrypted: Buffer, pageNumber: number): Buffer {
  const page = Buffer.alloc(WECHAT_PAGE_SIZE);
  page.subarray(0, BODY_END).set(encrypted.subarray(0, BODY_END));
  const iv = encrypted.subarray(BODY_END, BODY_END + IV_SIZE);
  const from = pageNumber === 1 ? SALT_SIZE : 0;
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  decipher.update(page.subarray(from, BODY_END)).copy(page, from);
  decipher.final();
  if (pageNumber === 1) Buffer.from('SQLite format 3\0').copy(page, 0);
  return page;
}

function committedWalFrames(wal: Buffer): WalFrame[] {
  if (wal.length < WAL_HEADER_SIZE) return [];
  const magic = wal.readUInt32BE(0);
  if ((magic & ~1) !== WAL_MAGIC || wal.readUInt32BE(8) !== WECHAT_PAGE_SIZE) return [];
  const bigEndian = (magic & 1) === 1;
  let sums = walChecksum(bigEndian, wal.subarray(0, 24), [0, 0]);
  if (sums[0] !== wal.readUInt32BE(24) || sums[1] !== wal.readUInt32BE(28)) return [];
  const saltA = wal.readUInt32BE(16);
  const saltB = wal.readUInt32BE(20);
  const frames: WalFrame[] = [];
  let committedLength = 0;
  for (let offset = WAL_HEADER_SIZE; offset + WAL_FRAME_SIZE <= wal.length; offset += WAL_FRAME_SIZE) {
    const header = wal.subarray(offset, offset + WAL_FRAME_HEADER_SIZE);
    const page = wal.subarray(offset + WAL_FRAME_HEADER_SIZE, offset + WAL_FRAME_SIZE);
    if (header.readUInt32BE(8) !== saltA || header.readUInt32BE(12) !== saltB) break;
    sums = walChecksum(bigEndian, page, walChecksum(bigEndian, header.subarray(0, 8), sums));
    if (sums[0] !== header.readUInt32BE(16) ||
        sums[1] !== header.readUInt32BE(20) ||
        header.readUInt32BE(0) === 0) break;
    const frame = {
      number: header.readUInt32BE(0),
      databasePages: header.readUInt32BE(4),
      page: Buffer.from(page)
    };
    frames.push(frame);
    if (frame.databasePages !== 0) committedLength = frames.length;
  }
  return frames.slice(0, committedLength);
}

function walChecksum(bigEndian: boolean, data: Buffer, initial: [number, number]): [number, number] {
  let [s0, s1] = initial;
  for (let offset = 0; offset + 8 <= data.length; offset += 8) {
    const x0 = bigEndian ? data.readUInt32BE(offset) : data.readUInt32LE(offset);
    const x1 = bigEndian ? data.readUInt32BE(offset + 4) : data.readUInt32LE(offset + 4);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}
