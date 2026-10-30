import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/wechat-sqlcipher.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
  WECHAT_PAGE_SIZE,
  WechatSqlCipherError,
  decryptWechatDatabase,
  deriveWechatDatabaseKey,
  encryptWechatDatabaseFixture,
  encryptWechatWalFixture,
  opensWechatDatabase
} = await import(moduleUrl);

const PAGE_SIZE = WECHAT_PAGE_SIZE;
const RESERVED_SIZE = 80;
const KEY = Buffer.alloc(32, 0x5a);
const WRONG_KEY = Buffer.alloc(32, 0xa5);
const DATABASE_SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const WAL_SALT = Buffer.from('1020304050607080', 'hex');
const ivForPage = pageNumber => Buffer.alloc(16, 0x60 + pageNumber);

test('derives a database key from the account passphrase and page salt', () => {
  const derived = deriveWechatDatabaseKey(KEY, DATABASE_SALT);
  assert.equal(
    derived.toString('hex'),
    '682ac2e4317b74916c92809021a67a9271ceaea58aeb838be855e9e81c1a6608'
  );
  assert.throws(
    () => deriveWechatDatabaseKey(KEY, Buffer.alloc(15)),
    /salt 必须为 16 字节/u
  );
});

function sqliteLikeDatabase(pageCount) {
  const database = Buffer.alloc(PAGE_SIZE * pageCount);
  for (let page = 0; page < pageCount; page++) {
    database.fill(0x30 + page, page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }
  Buffer.from('SQLite format 3\0', 'ascii').copy(database, 0);
  database.writeUInt16BE(PAGE_SIZE, 16);
  database[18] = 1;
  database[19] = 1;
  database.writeUInt32BE(pageCount, 28);
  return database;
}

function encryptDatabase(database) {
  return encryptWechatDatabaseFixture(database, KEY, DATABASE_SALT, ivForPage);
}

function encryptedPage(database, pageNumber) {
  const encrypted = encryptDatabase(database);
  const start = (pageNumber - 1) * PAGE_SIZE;
  return Buffer.from(encrypted.subarray(start, start + PAGE_SIZE));
}

function expectedPlainDatabase(database, pageCount = database.length / PAGE_SIZE) {
  const expected = Buffer.from(database);
  for (let page = 0; page < expected.length / PAGE_SIZE; page++) {
    const end = (page + 1) * PAGE_SIZE;
    expected.fill(0, end - RESERVED_SIZE, end);
  }
  expected[18] = 1;
  expected[19] = 1;
  expected.writeUInt32BE(pageCount, 28);
  return expected.subarray(0, pageCount * PAGE_SIZE);
}

function onePageWalFrame(database, { number = 2, databasePages = 2 } = {}) {
  return encryptWechatWalFixture([{
    number,
    databasePages,
    page: encryptedPage(database, number)
  }], WAL_SALT);
}

test('SQLCipher fixture round-trips a single page', () => {
  const plain = sqliteLikeDatabase(1);
  const encrypted = encryptDatabase(plain);

  assert.equal(encrypted.length, PAGE_SIZE);
  assert.equal(opensWechatDatabase(KEY, encrypted), true);
  assert.deepEqual(decryptWechatDatabase(KEY, encrypted), expectedPlainDatabase(plain));
});

test('SQLCipher fixture round-trips multiple pages independently', () => {
  const plain = sqliteLikeDatabase(3);
  const encrypted = encryptDatabase(plain);

  assert.equal(encrypted.length, PAGE_SIZE * 3);
  assert.deepEqual(decryptWechatDatabase(KEY, encrypted), expectedPlainDatabase(plain));
  assert.notDeepEqual(
    encrypted.subarray(0, PAGE_SIZE),
    encrypted.subarray(PAGE_SIZE, PAGE_SIZE * 2)
  );
});

test('rejects a wrong key and a database page with a damaged HMAC', () => {
  const encrypted = encryptDatabase(sqliteLikeDatabase(1));
  assert.equal(opensWechatDatabase(WRONG_KEY, encrypted), false);
  assert.throws(
    () => decryptWechatDatabase(WRONG_KEY, encrypted),
    WechatSqlCipherError
  );

  const damaged = Buffer.from(encrypted);
  damaged[PAGE_SIZE - 1] ^= 0x01;
  assert.equal(opensWechatDatabase(KEY, damaged), false);
  assert.throws(() => decryptWechatDatabase(KEY, damaged), /HMAC/u);
});

test('rejects short and non-page-aligned encrypted database input', () => {
  const short = Buffer.alloc(PAGE_SIZE - 1);
  assert.equal(opensWechatDatabase(KEY, short), false);
  assert.throws(() => decryptWechatDatabase(KEY, short), /完整的 4096 字节页/u);
  assert.throws(
    () => decryptWechatDatabase(KEY, Buffer.alloc(PAGE_SIZE + 1)),
    /完整的 4096 字节页/u
  );
  assert.throws(() => encryptWechatDatabaseFixture(short, KEY), /完整的 4096 字节页/u);
});

test('overlays a committed WAL frame onto its matching database page', () => {
  const base = sqliteLikeDatabase(2);
  const updated = Buffer.from(base);
  updated.fill(0x7c, PAGE_SIZE, PAGE_SIZE * 2);
  const encrypted = encryptDatabase(base);
  const wal = onePageWalFrame(updated);

  assert.deepEqual(
    decryptWechatDatabase(KEY, encrypted, wal),
    expectedPlainDatabase(updated)
  );
});

test('uncommitted WAL frames do not replace database or committed page contents', () => {
  const base = sqliteLikeDatabase(2);
  const committed = Buffer.from(base);
  committed.fill(0x62, PAGE_SIZE, PAGE_SIZE * 2);
  const uncommitted = Buffer.from(base);
  uncommitted.fill(0xe4, PAGE_SIZE, PAGE_SIZE * 2);
  const encrypted = encryptDatabase(base);

  const uncommittedOnly = encryptWechatWalFixture([{
    number: 2,
    databasePages: 0,
    page: encryptedPage(uncommitted, 2)
  }], WAL_SALT);
  assert.deepEqual(
    decryptWechatDatabase(KEY, encrypted, uncommittedOnly),
    expectedPlainDatabase(base)
  );

  const committedThenUncommitted = encryptWechatWalFixture([
    { number: 2, databasePages: 2, page: encryptedPage(committed, 2) },
    { number: 2, databasePages: 0, page: encryptedPage(uncommitted, 2) }
  ], WAL_SALT);
  assert.deepEqual(
    decryptWechatDatabase(KEY, encrypted, committedThenUncommitted),
    expectedPlainDatabase(committed)
  );
});

test('ignores WAL with an invalid header, header checksum, or frame checksum', () => {
  const base = sqliteLikeDatabase(2);
  const updated = Buffer.from(base);
  updated.fill(0x91, PAGE_SIZE, PAGE_SIZE * 2);
  const encrypted = encryptDatabase(base);
  const validWal = onePageWalFrame(updated);

  const badMagic = Buffer.from(validWal);
  badMagic.writeUInt32BE(0, 0);
  const badHeaderChecksum = Buffer.from(validWal);
  badHeaderChecksum[24] ^= 0x01;
  const badFrameChecksum = Buffer.from(validWal);
  badFrameChecksum[32 + 16] ^= 0x01;

  for (const wal of [badMagic, badHeaderChecksum, badFrameChecksum]) {
    assert.deepEqual(
      decryptWechatDatabase(KEY, encrypted, wal),
      expectedPlainDatabase(base)
    );
  }
});

test('uses the committed database page count to update the SQLite header and truncate output', () => {
  const base = sqliteLikeDatabase(2);
  const updated = Buffer.from(base);
  updated.fill(0xb3, PAGE_SIZE, PAGE_SIZE * 2);
  const encrypted = encryptDatabase(base);
  const wal = onePageWalFrame(updated, { number: 2, databasePages: 1 });
  const decrypted = decryptWechatDatabase(KEY, encrypted, wal);

  assert.equal(decrypted.length, PAGE_SIZE);
  assert.equal(decrypted.readUInt32BE(28), 1);
  assert.deepEqual(decrypted, expectedPlainDatabase(updated, 1));
});

test('allows a committed WAL transaction to grow the database page count', () => {
  const base = sqliteLikeDatabase(1);
  const expanded = sqliteLikeDatabase(2);
  expanded.fill(0xd8, PAGE_SIZE, PAGE_SIZE * 2);
  const encrypted = encryptDatabase(base);
  const wal = onePageWalFrame(expanded, { number: 2, databasePages: 2 });
  const decrypted = decryptWechatDatabase(KEY, encrypted, wal);

  assert.equal(decrypted.length, PAGE_SIZE * 2);
  assert.equal(decrypted.readUInt32BE(28), 2);
  assert.deepEqual(decrypted, expectedPlainDatabase(expanded));
});
