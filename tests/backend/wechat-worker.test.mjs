import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const contentSource = readFileSync(new URL('../../src/main/wechat-content.ts', import.meta.url), 'utf8');
const imageKeySource = readFileSync(new URL('../../src/main/wechat-image-key.ts', import.meta.url), 'utf8');
const sqlcipherSource = readFileSync(new URL('../../src/main/wechat-sqlcipher.ts', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../../src/main/wechat-worker.ts', import.meta.url), 'utf8');

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions }).outputText).toString('base64')}`;
const contentCompiled = ts.transpileModule(contentSource, { compilerOptions }).outputText.replaceAll(
  "'@xmldom/xmldom'",
  JSON.stringify(import.meta.resolve('@xmldom/xmldom'))
);
const contentUrl = `data:text/javascript;base64,${Buffer.from(contentCompiled).toString('base64')}`;
const imageKeyUrl = dataUrl(imageKeySource);
const sqlcipherUrl = dataUrl(sqlcipherSource);
const compiledWorker = ts.transpileModule(workerSource, { compilerOptions }).outputText
  .replace("from './wechat-content'", `from '${contentUrl}'`)
  .replace("from './wechat-image-key'", `from '${imageKeyUrl}'`)
  .replace("from './wechat-sqlcipher'", `from '${sqlcipherUrl}'`);
const workerUrl = dataUrl(compiledWorker);
const {
  encryptWechatDatabaseFixture,
  encryptWechatWalFixture
} = await import(sqlcipherUrl);
const {
  handleWechatWorkerRequest,
  installWechatWorkerMessageHandler
} = await import(workerUrl);

/**
 * Electron 42 provides DatabaseSync.deserialize(), while the Node test
 * runtime does not. Keep the disk fixture entirely in this test module so a
 * missing deserialize() cannot reintroduce a plaintext fallback into product
 * code. The synthetic databases contain no user data.
 */
function openFixtureDatabase(plain) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-wechat-fixture-open-'));
  const path = join(directory, 'plain.sqlite');
  writeFileSync(path, plain, { mode: 0o600, flag: 'wx' });
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const close = db.close.bind(db);
    db.close = () => {
      try { close(); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    };
    return db;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

const handleWorker = value => handleWechatWorkerRequest(value, openFixtureDatabase);

const KEY = '11'.repeat(32);
const SALT = Buffer.from('0123456789abcdef');
const START = '2023-11-14T00:00:00.000Z';
const END = '2023-11-15T00:00:00.000Z';
const SESSION = 'wxid_alice';
const SESSION_HASH = createHash('md5').update(SESSION).digest('hex');
const BIG_VOICE_SERVER_ID = '7677621684784704714';

function field(number, value) {
  const bytes = Buffer.from(value);
  const out = [number << 3 | 2, bytes.length, ...bytes];
  return Buffer.from(out);
}

function packedImageName(name) {
  return field(3, field(4, name));
}

function packedVideoName(name) {
  return field(4, field(8, name));
}

function packedFileName(name) {
  return field(7, field(2, name));
}

function packedVoiceTranscription(text) {
  const voiceInfo = Buffer.concat([Buffer.from([0x08, 0x02]), field(2, text)]);
  return field(5, voiceInfo);
}

function appType(subtype) {
  return subtype * 2 ** 32 + 49;
}

function readSqliteVarint(buffer, offset) {
  let value = 0;
  for (let index = 0; index < 9; index += 1) {
    const byte = buffer[offset + index];
    if (index === 8) return { value: value * 256 + byte, length: 9 };
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return { value, length: index + 1 };
  }
  throw new Error('invalid SQLite varint');
}

// SQLCipher reserves 80 bytes at the end of every 4096-byte page. The stock
// node:sqlite writer used by this test does not expose SQLite's reserve-byte
// file control, so move the small synthetic b-tree cells into the usable page
// area before passing the database to the existing SQLCipher fixture helper.
function reserveSqlCipherPages(input) {
  assert.equal(input.length % 4096, 0);
  const output = Buffer.from(input);
  output[20] = 80;
  const pageCount = input.length / 4096;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageOffset = pageIndex * 4096;
    const headerOffset = pageIndex === 0 ? 100 : 0;
    const flags = input[pageOffset + headerOffset];
    if (![0x02, 0x05, 0x0a, 0x0d].includes(flags)) continue;
    const cellCount = input.readUInt16BE(pageOffset + headerOffset + 3);
    const cells = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      const cellOffset = input.readUInt16BE(pageOffset + headerOffset + 8 + cellIndex * 2);
      const absoluteOffset = pageOffset + cellOffset;
      let cellLength;
      if (flags === 0x0d || flags === 0x0a) {
        const payload = readSqliteVarint(input, absoluteOffset);
        const rowId = flags === 0x0d ? readSqliteVarint(input, absoluteOffset + payload.length) : null;
        cellLength = payload.length + (rowId?.length ?? 0) + payload.value;
      } else if (flags === 0x05) {
        cellLength = 4 + readSqliteVarint(input, absoluteOffset + 4).length;
      } else {
        const payload = readSqliteVarint(input, absoluteOffset + 4);
        cellLength = 4 + payload.length + payload.value;
      }
      assert.ok(cellOffset + cellLength <= 4096, `SQLite page ${pageIndex + 1} cell exceeds page`);
      cells.push({ bytes: Buffer.from(input.subarray(absoluteOffset, absoluteOffset + cellLength)) });
    }
    const totalCellBytes = cells.reduce((total, cell) => total + cell.bytes.length, 0);
    const contentStart = 4016 - totalCellBytes;
    assert.ok(contentStart >= headerOffset + 8 + cellCount * 2, `SQLite page ${pageIndex + 1} has no reserved-byte space`);
    output.fill(0, pageOffset + contentStart, pageOffset + 4016);
    let cursor = contentStart;
    for (const cell of cells) {
      cell.offset = cursor;
      cell.bytes.copy(output, pageOffset + cursor);
      cursor += cell.bytes.length;
    }
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      output.writeUInt16BE(cells[cellIndex].offset, pageOffset + headerOffset + 8 + cellIndex * 2);
    }
    output.writeUInt16BE(contentStart, pageOffset + headerOffset + 5);
    output.fill(0, pageOffset + 4016, pageOffset + 4096);
  }
  return output;
}

function makePlainDatabase(path, setup) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE;');
  setup(db);
  db.exec('VACUUM;');
  db.close();
  const reserved = reserveSqlCipherPages(readFileSync(path));
  writeFileSync(path, reserved, { mode: 0o600 });
  return reserved;
}

function encryptDatabase(root, relativePath, setup, key = KEY) {
  const plainPath = join(root, `plain-${relativePath.replaceAll('/', '-')}`);
  const target = join(root, 'db_storage', relativePath);
  mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
  const plain = makePlainDatabase(plainPath, setup);
  writeFileSync(target, encryptWechatDatabaseFixture(plain, key, SALT, page => Buffer.alloc(16, page & 0xff)), { mode: 0o600 });
  rmSync(plainPath, { force: true });
  return target;
}

function encryptDatabaseWithCommittedWal(root, relativePath, setup, update, key = KEY) {
  const plainPath = join(root, `plain-wal-${relativePath.replaceAll('/', '-')}`);
  const target = join(root, 'db_storage', relativePath);
  mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
  makePlainDatabase(plainPath, setup);
  const before = readFileSync(plainPath);
  const db = new DatabaseSync(plainPath);
  update(db);
  db.close();
  const after = reserveSqlCipherPages(readFileSync(plainPath));
  writeFileSync(plainPath, after, { mode: 0o600 });
  assert.equal(before.length, after.length);
  const encrypt = plain => encryptWechatDatabaseFixture(plain, key, SALT, page => Buffer.alloc(16, page & 0xff));
  const encryptedBefore = encrypt(before);
  const encryptedAfter = encrypt(after);
  const changed = [];
  for (let page = 1; page <= after.length / 4096; page += 1) {
    const offset = (page - 1) * 4096;
    if (!before.subarray(offset, offset + 4096).equals(after.subarray(offset, offset + 4096))) {
      changed.push({
        number: page,
        databasePages: after.length / 4096,
        page: encryptedAfter.subarray(offset, offset + 4096)
      });
    }
  }
  assert.ok(changed.length > 0);
  writeFileSync(target, encryptedBefore, { mode: 0o600 });
  writeFileSync(`${target}-wal`, encryptWechatWalFixture(changed, Buffer.from('abcdefgh')), { mode: 0o600 });
  rmSync(plainPath, { force: true });
  return target;
}

function request(root, operation, databases, query, extra = {}) {
  return {
    id: `${operation}-${Math.random().toString(16).slice(2)}`,
    operation,
    dataDirectory: root,
    databases,
    accountId: 'wxid_alice_1',
    query,
    ...extra
  };
}

function dbInput(relativePath, key = KEY) {
  return { path: `db_storage/${relativePath}`, key };
}

function createAccountFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rambo-wechat-worker-test-'));
  const databases = [];
  const stickerBytes = Buffer.from('GIF89a local-sticker');
  const stickerMd5 = createHash('md5').update(stickerBytes).digest('hex');
  databases.push(dbInput('contact/contact.db'));
  encryptDatabase(root, 'contact/contact.db', db => {
    db.exec('CREATE TABLE contact(username TEXT PRIMARY KEY, alias TEXT, nick_name TEXT, remark TEXT, description TEXT);');
    db.prepare('INSERT INTO contact VALUES(?,?,?,?,?)').run(SESSION, 'alice', 'Alice', '爱丽丝', '');
    db.prepare('INSERT INTO contact VALUES(?,?,?,?,?)').run('wxid_bob', 'bob', 'Bob', '', '');
  });

  databases.push(dbInput('session/session.db'));
  encryptDatabaseWithCommittedWal(root, 'session/session.db', db => {
    db.exec('CREATE TABLE SessionTable(username TEXT PRIMARY KEY,type INTEGER,unread_count INTEGER,summary TEXT,last_timestamp INTEGER,sort_timestamp INTEGER,last_msg_locald_id INTEGER,last_msg_type INTEGER,last_msg_sub_type INTEGER,last_msg_sender TEXT,last_sender_display_name TEXT);');
    db.prepare('INSERT INTO SessionTable VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(SESSION, 0, 1, 'old', 1700000000, 1700000000, 1, 1, 0, SESSION, 'Alice');
  }, db => {
    db.prepare('UPDATE SessionTable SET unread_count=?,summary=? WHERE username=?').run(7, 'new', SESSION);
  });

  const messageRows = [
    { path: 'message/message_0.db', serverId: '7677621684784704713', at: 1700000100, text: '第一条来自零号库' },
    { path: 'message/message_1.db', serverId: 200, at: 1700000200, text: '第二条来自一号库' }
  ];
  for (const item of messageRows) {
    databases.push(dbInput(item.path));
    encryptDatabase(root, item.path, db => {
      db.exec(`CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY,is_session INTEGER); CREATE TABLE "Msg_${SESSION_HASH}"(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content BLOB,WCDB_CT_message_content INTEGER,packed_info_data BLOB);`);
      db.prepare('INSERT INTO Name2Id(user_name,is_session) VALUES(?,?)').run(SESSION, 1);
      db.prepare('INSERT INTO Name2Id(user_name,is_session) VALUES(?,?)').run('wxid_bob', 0);
      db.prepare(`INSERT INTO "Msg_${SESSION_HASH}"(server_id,local_type,sort_seq,real_sender_id,create_time,message_content,WCDB_CT_message_content,packed_info_data) VALUES(?,?,?,?,?,?,?,?)`)
        .run(item.serverId, 1, item.at * 100, 2, item.at, item.text, 0, Buffer.alloc(0));
    });
  }

  databases.push(dbInput('message/message_2.db'));
  encryptDatabase(root, 'message/message_2.db', db => {
    db.exec(`CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY,is_session INTEGER); CREATE TABLE "Msg_${SESSION_HASH}"(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content BLOB,WCDB_CT_message_content INTEGER,packed_info_data BLOB);`);
    db.prepare('INSERT INTO Name2Id(user_name,is_session) VALUES(?,?)').run(SESSION, 1);
    db.prepare('INSERT INTO Name2Id(user_name,is_session) VALUES(?,?)').run('wxid_bob', 0);
    const insert = db.prepare(`INSERT INTO "Msg_${SESSION_HASH}"(server_id,local_type,sort_seq,real_sender_id,create_time,message_content,WCDB_CT_message_content,packed_info_data) VALUES(?,?,?,?,?,?,?,?)`);
    insert.run(300, 3, 170000030000, 2, 1700000300, '<msg><img md5="img-md5"/></msg>', 0, packedImageName('image-1'));
    insert.run(301, 34, 170000031000, 2, 1700000310, '<msg><voicemsg voicelength="800"/></msg>', 0, packedVoiceTranscription('周六见'));
    insert.run(302, 43, 170000032000, 2, 1700000320, '<msg><videomsg md5="video-md5"/></msg>', 0, packedVideoName('video-1'));
    insert.run(303, appType(6), 170000033000, 2, 1700000330, '<msg><appmsg><title>report.pdf</title><type>6</type><appattach><totallen>11</totallen><fileext>pdf</fileext></appattach></appmsg></msg>', 0, packedFileName('report-1.pdf'));
    insert.run(304, 47, 170000034000, 2, 1700000340, `<msg><emoji md5="${stickerMd5}"/></msg>`, 0, Buffer.alloc(0));
    insert.run(305, 34, 170000035000, 2, 1700000350, '<msg><voicemsg voicelength="800"/></msg>', 0, Buffer.alloc(0));
    insert.run(BIG_VOICE_SERVER_ID, 34, 170000036000, 2, 1700000360, '<msg><voicemsg voicelength="1200"/></msg>', 0, Buffer.alloc(0));
  });

  databases.push(dbInput('message/media_0.db'));
  encryptDatabase(root, 'message/media_0.db', db => {
    db.exec('CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY); CREATE TABLE VoiceInfo(chat_name_id INTEGER,create_time INTEGER,local_id INTEGER,svr_id INTEGER,voice_data BLOB,data_index TEXT);');
    db.prepare('INSERT INTO Name2Id(rowid,user_name) VALUES(?,?)').run(1, SESSION);
    db.prepare('INSERT INTO VoiceInfo(chat_name_id,create_time,local_id,svr_id,voice_data,data_index) VALUES(?,?,?,?,?,?)')
      .run(1, 1700000310, 1, 301, Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b]), '0');
    db.prepare('INSERT INTO VoiceInfo(chat_name_id,create_time,local_id,svr_id,voice_data,data_index) VALUES(?,?,?,?,?,?)')
      .run(1, 1700000350, 2, 305, Buffer.from('RIFF----WAVE-local-wav'), '0');
    db.prepare('INSERT INTO VoiceInfo(chat_name_id,create_time,local_id,svr_id,voice_data,data_index) VALUES(?,?,?,?,?,?)')
      .run(1, 1700000360, 3, BIG_VOICE_SERVER_ID, Buffer.from([0x02, 0x23, 0x21, 0x42, 0x49, 0x47]), '0');
  });

  const imageDirectory = join(root, 'msg', 'attach', SESSION_HASH, '2023-11', 'Img');
  mkdirSync(imageDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(imageDirectory, 'image-1_h.dat'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]), { mode: 0o600 });

  const videoDirectory = join(root, 'msg', 'video', '2023-11');
  mkdirSync(videoDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(videoDirectory, 'video-1.mp4'), Buffer.from('0000ftypisom-local-video'), { mode: 0o600 });

  const fileDirectory = join(root, 'msg', 'file', '2023-11');
  mkdirSync(fileDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(fileDirectory, 'report-1.pdf'), Buffer.from('%PDF-local-file'), { mode: 0o600 });

  const stickerDirectory = join(root, 'msg', 'emoticon');
  mkdirSync(stickerDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(stickerDirectory, `${stickerMd5}.gif`), stickerBytes, { mode: 0o600 });

  return { root, databases, stickerMd5 };
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}

test('worker reads sessions from a committed SQLCipher WAL and merges messages from multiple databases', async () => {
  const fixture = createAccountFixture();
  try {
    const sessions = await handleWorker(request(fixture.root, 'sessions', fixture.databases, { limit: 20 }));
    assert.equal(sessions.ok, true);
    assert.equal(sessions.result.items[0].sessionId, SESSION);
    assert.equal(sessions.result.items[0].unreadCount, 7);

    const messages = await handleWorker(request(fixture.root, 'messages', fixture.databases, {
      sessionIds: [SESSION], start: START, end: END, limit: 20
    }));
    assert.equal(messages.ok, true);
    assert.deepEqual(messages.result.items.slice(0, 3).map(item => item.text), ['第一条来自零号库', '第二条来自一号库', null]);
    assert.deepEqual(messages.result.items.slice(0, 3).map(item => item.sourceDatabase), [
      'db_storage/message/message_0.db',
      'db_storage/message/message_1.db',
      'db_storage/message/message_2.db'
    ]);
    assert.equal(messages.result.items[0].serverId, '7677621684784704713');
    assert.equal(messages.result.items[2].media[0].status, 'available');
    assert.equal(messages.result.items[2].media[0].mimeType, 'image/jpeg');
    const handle = messages.result.items[2].media[0].resourceHandle;
    assert.match(handle, /^[a-f0-9]{32}$/u);

    const media = await handleWorker(request(fixture.root, 'media', fixture.databases, { resourceHandle: handle }));
    assert.equal(media.ok, true);
    assert.equal(media.result.mimeType, 'image/jpeg');
    assert.deepEqual([...media.result.bytes], [0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);

    const byServerId = new Map(messages.result.items.map(item => [item.serverId, item]));
    const voice = byServerId.get('301').media[0];
    assert.equal(voice.status, 'available');
    assert.equal(voice.mimeType, 'audio/silk');
    assert.equal(voice.transcription, '周六见');
    const voiceMedia = await handleWorker(request(fixture.root, 'media', fixture.databases, { resourceHandle: voice.resourceHandle }));
    assert.equal(voiceMedia.ok, true);
    assert.equal(voiceMedia.result.mimeType, 'audio/silk');
    assert.equal(voiceMedia.result.transcription, '周六见');
    assert.deepEqual([...voiceMedia.result.bytes], [0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b]);
    assert.match(voiceMedia.result.limitation, /SILK/u);

    const wavVoice = byServerId.get('305').media[0];
    assert.equal(wavVoice.status, 'available');
    assert.equal(wavVoice.mimeType, 'audio/silk');
    const wavMedia = await handleWorker(request(fixture.root, 'media', fixture.databases, { resourceHandle: wavVoice.resourceHandle }));
    assert.equal(wavMedia.ok, true);
    assert.equal(wavMedia.result.mimeType, 'audio/wav');
    assert.match(wavMedia.result.fileName, /\.wav$/u);
    assert.equal(wavMedia.result.limitation, undefined);

    const bigVoice = byServerId.get(BIG_VOICE_SERVER_ID).media[0];
    assert.equal(bigVoice.status, 'available');
    assert.equal(bigVoice.mimeType, 'audio/silk');
    const bigVoiceMedia = await handleWorker(request(fixture.root, 'media', fixture.databases, { resourceHandle: bigVoice.resourceHandle }));
    assert.equal(bigVoiceMedia.ok, true);
    assert.deepEqual(
      [...bigVoiceMedia.result.bytes],
      [0x02, 0x23, 0x21, 0x42, 0x49, 0x47]
    );

    const video = byServerId.get('302').media[0];
    assert.equal(video.status, 'available');
    assert.equal(video.mimeType, 'video/mp4');
    const videoMedia = await handleWorker(request(fixture.root, 'media', fixture.databases, { resourceHandle: video.resourceHandle }));
    assert.equal(videoMedia.ok, true);
    assert.equal(videoMedia.result.mimeType, 'video/mp4');
    assert.deepEqual([...videoMedia.result.bytes], [...Buffer.from('0000ftypisom-local-video')]);

    const file = byServerId.get('303').media[0];
    assert.equal(file.status, 'available');
    assert.equal(file.mimeType, 'application/pdf');
    const fileMedia = await handleWorker(request(fixture.root, 'media', fixture.databases, { resourceHandle: file.resourceHandle }));
    assert.equal(fileMedia.ok, true);
    assert.equal(fileMedia.result.mimeType, 'application/pdf');
    assert.deepEqual([...fileMedia.result.bytes], [...Buffer.from('%PDF-local-file')]);

    const sticker = byServerId.get('304').media[0];
    assert.equal(sticker.status, 'available');
    assert.equal(sticker.mimeType, 'image/gif');
    const stickerMedia = await handleWorker(request(fixture.root, 'media', fixture.databases, { resourceHandle: sticker.resourceHandle }));
    assert.equal(stickerMedia.ok, true);
    assert.equal(stickerMedia.result.mimeType, 'image/gif');
    assert.deepEqual([...stickerMedia.result.bytes], [...Buffer.from('GIF89a local-sticker')]);
  } finally {
    cleanup(fixture);
  }
});

test('worker decrypts V2 image DAT with kvcomm-derived AES and XOR keys', async () => {
  const fixture = createAccountFixture();
  const parent = mkdtempSync(join(tmpdir(), 'rambo-wechat-v2-key-'));
  const accountRoot = join(parent, 'Documents', 'xwechat_files', 'wxid_alice_abcd');
  const accountId = 'wxid_alice_abcd';
  try {
    mkdirSync(dirname(accountRoot), { recursive: true, mode: 0o700 });
    renameSync(fixture.root, accountRoot);

    const code = 0x1234;
    const aes = Buffer.from(
      createHash('md5').update(`${code}wxid_alice`).digest('hex').slice(0, 16),
      'ascii'
    );
    const xor = code & 0xff;
    const plain = Buffer.concat([
      Buffer.from('wxgf'),
      Buffer.alloc(20, 0),
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x40, 0x01]),
      Buffer.alloc(120, 0x11)
    ]);
    const raw = Buffer.from('v2-raw-section');
    const xorTail = Buffer.from('v2-xor-tail');
    const cipher = createCipheriv('aes-128-ecb', aes, null);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const header = Buffer.alloc(15);
    Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]).copy(header);
    header.writeUInt32LE(plain.length, 6);
    header.writeUInt32LE(xorTail.length, 10);
    const dat = Buffer.concat([
      header,
      encrypted,
      raw,
      Buffer.from(xorTail.map(value => value ^ xor))
    ]);
    writeFileSync(
      join(accountRoot, 'msg', 'attach', SESSION_HASH, '2023-11', 'Img', 'image-1_h.dat'),
      dat,
      { mode: 0o600 }
    );
    const kvcomm = join(parent, 'Documents', 'app_data', 'net', 'kvcomm');
    mkdirSync(kvcomm, { recursive: true, mode: 0o700 });
    writeFileSync(join(kvcomm, `key_${code}_fixture.statistic`), Buffer.alloc(0), { mode: 0o600 });

    const messages = await handleWorker(request(accountRoot, 'messages', fixture.databases, {
      sessionIds: [SESSION], start: START, end: END, limit: 20
    }, { accountId }));
    assert.equal(messages.ok, true);
    const image = messages.result.items.find(item => item.media.some(media => media.kind === 'image'));
    assert.ok(image);
    const ref = image.media.find(media => media.kind === 'image');
    assert.equal(ref.status, 'available');
    assert.equal(ref.mimeType, 'image/wxgf');

    const media = await handleWorker(request(accountRoot, 'media', fixture.databases, {
      resourceHandle: ref.resourceHandle
    }, { accountId }));
    assert.equal(media.ok, true);
    assert.equal(media.result.mimeType, 'image/wxgf');
    assert.deepEqual([...media.result.bytes], [...plain, ...raw, ...xorTail]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    cleanup(fixture);
  }
});

test('worker reads the verified base database and marks coverage when a WeChat 4.2 WAL cannot be replayed', async () => {
  const fixture = createAccountFixture();
  try {
    writeFileSync(
      join(fixture.root, 'db_storage/message/media_0.db-wal'),
      Buffer.alloc(32),
      { mode: 0o600 }
    );
    let rejectedVoiceSnapshot = false;
    const opener = plain => {
      const database = openFixtureDatabase(plain);
      let hasVoiceTable = false;
      try {
        hasVoiceTable = Boolean(database.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='VoiceInfo'"
        ).get());
      } catch { /* let the worker report the real open failure */ }
      if (hasVoiceTable && !rejectedVoiceSnapshot) {
        rejectedVoiceSnapshot = true;
        database.close();
        throw Object.assign(new Error('database disk image is malformed'), {
          code: 'ERR_SQLITE_ERROR'
        });
      }
      return database;
    };

    const messages = await handleWechatWorkerRequest(
      request(fixture.root, 'messages', fixture.databases, {
        sessionIds: [SESSION], start: START, end: END, limit: 20
      }),
      opener
    );
    assert.equal(messages.ok, true);
    assert.equal(messages.result.coverage.complete, false);
    assert.match(
      messages.result.coverage.notes.join('\n'),
      /WAL 回放结果不可用.*可能不包含最新提交/u
    );
    const voice = messages.result.items
      .find(item => item.serverId === '301')?.media[0];
    assert.equal(voice?.status, 'available');
    assert.equal(voice?.mimeType, 'audio/silk');
    const media = await handleWorker(request(
      fixture.root,
      'media',
      fixture.databases,
      { resourceHandle: voice.resourceHandle }
    ));
    assert.equal(media.ok, true);
    assert.deepEqual(
      [...media.result.bytes],
      [0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b]
    );
  } finally {
    cleanup(fixture);
  }
});

test('worker marks a paginated session result incomplete even when every database opened', async () => {
  const fixture = createAccountFixture();
  try {
    let databaseIndex = 0;
    const fakeOpener = plain => {
      databaseIndex += 1;
      if (databaseIndex === 1) return openFixtureDatabase(plain);
      return {
        prepare(sql) {
          if (sql.includes('sqlite_master')) return { get: () => ({ 1: 1 }) };
          return {
            all: () => Array.from({ length: 101 }, (_, index) => ({
              username: `wxid_other_${index}`,
              type: 0,
              unread_count: 0,
              last_timestamp: 1700000000 - index,
              sort_timestamp: 1700000000 - index
            }))
          };
        },
        close() {}
      };
    };
    const sessions = await handleWechatWorkerRequest(
      request(fixture.root, 'sessions', fixture.databases, {}), fakeOpener
    );
    assert.equal(sessions.ok, true);
    assert.equal(sessions.result.items.length, 100);
    assert.equal(sessions.result.hasMore, true);
    assert.equal(sessions.result.coverage.complete, false);
    assert.deepEqual(sessions.result.coverage.skippedDatabases, []);
  } finally {
    cleanup(fixture);
  }
});

test('worker reports permission denied for an unreadable session database without exposing the OS path', async () => {
  const fixture = createAccountFixture();
  let databaseIndex = 0;
  try {
    const opener = plain => {
      databaseIndex += 1;
      if (databaseIndex === 2) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return openFixtureDatabase(plain);
    };
    const sessions = await handleWechatWorkerRequest(
      request(fixture.root, 'sessions', fixture.databases, {}), opener
    );
    assert.equal(sessions.ok, true);
    assert.deepEqual(sessions.result.coverage.skippedDatabases, [
      { path: 'db_storage/session/session.db', reason: 'access_denied' }
    ]);
  } finally {
    cleanup(fixture);
  }
});

test('worker reports an incompatible message schema without exposing SQLite internals', async () => {
  const fixture = createAccountFixture();
  try {
    const sessions = await handleWorker(request(fixture.root, 'sessions', fixture.databases, { limit: 20 }));
    assert.equal(sessions.ok, true);
    let targetOpened = false;
    const opener = plain => {
      const database = openFixtureDatabase(plain);
      const hasMessageTable = Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
      ).get(`Msg_${SESSION_HASH}`));
      if (!hasMessageTable || targetOpened) return database;
      targetOpened = true;
      return {
        prepare(sql) {
          if (sql.includes('sqlite_master')) return database.prepare(sql);
          if (sql.startsWith('SELECT m.local_id')) {
            const statement = database.prepare(sql);
            statement.setReadBigInts = () => statement;
            statement.all = () => {
              throw Object.assign(new Error('no such column: server_id'), {
                code: 'SQLITE_ERROR'
              });
            };
            return statement;
          }
          return database.prepare(sql);
        },
        close: () => database.close()
      };
    };
    const messages = await handleWechatWorkerRequest(
      request(fixture.root, 'messages', fixture.databases, {
        sessionIds: [SESSION], start: START, end: END, limit: 20
      }),
      opener
    );
    assert.equal(messages.ok, true);
    assert.deepEqual(messages.result.coverage.skippedDatabases, [
      { path: 'db_storage/message/message_0.db', reason: 'message_column_missing' }
    ]);
    assert.doesNotMatch(JSON.stringify(messages.result), /has no column/u);
  } finally {
    cleanup(fixture);
  }
});

test('worker searches parsed chat message content', async () => {
  const fixture = createAccountFixture();
  try {
    const search = await handleWorker(request(fixture.root, 'search', fixture.databases, {
      query: '一号库', sessionIds: [SESSION], start: START, end: END, limit: 20
    }));
    assert.equal(search.ok, true);
    assert.equal(search.result.items.length, 1);
    assert.equal(search.result.items[0].text, '第二条来自一号库');
    assert.ok(search.result.coverage.notes.includes('content_scan_used'));

  } finally {
    cleanup(fixture);
  }
});

test('worker rejects traversal and symlink escapes before reading outside the fixed account directory', async () => {
  const fixture = createAccountFixture();
  const outside = join(fixture.root, '..', 'outside-wechat.db');
  try {
    writeFileSync(outside, 'not a database', { mode: 0o600 });
    const traversal = await handleWorker(request(fixture.root, 'sessions', [{ path: '../outside-wechat.db', key: KEY }], {}));
    assert.equal(traversal.ok, false);
    assert.equal(traversal.error.code, 'INVALID_PATH');

    const link = join(fixture.root, 'db_storage', 'session', 'link.db');
    symlinkSync(outside, link);
    const symlink = await handleWorker(request(fixture.root, 'sessions', [{ path: 'db_storage/session/link.db', key: KEY }], {}));
    assert.equal(symlink.ok, false);
    assert.equal(symlink.error.code, 'PATH_ESCAPE');
  } finally {
    rmSync(outside, { force: true });
    cleanup(fixture);
  }
});

test('worker message entry returns the same request/response protocol', async () => {
  const fixture = createAccountFixture();
  try {
    let listener;
    const responses = [];
    installWechatWorkerMessageHandler({
      on: (_event, callback) => { listener = callback; },
      postMessage: response => responses.push(response)
    }, openFixtureDatabase);
    listener({ data: request(fixture.root, 'sessions', fixture.databases, { limit: 1 }) });
    for (let attempt = 0; attempt < 20 && responses.length === 0; attempt += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].result.items.length, 1);
  } finally {
    cleanup(fixture);
  }
});
