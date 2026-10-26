import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/wechat-content.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText.replaceAll(
  "'@xmldom/xmldom'",
  JSON.stringify(import.meta.resolve('@xmldom/xmldom'))
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
  decodeWechatMessageContent,
  parseWechatMessageContent
} = await import(moduleUrl);

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function bytesField(number, value) {
  const body = Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(body.length), body]);
}

function varintField(number, value) {
  return Buffer.concat([varint(number * 8), varint(value)]);
}

function appType(subtype) {
  return 49 + subtype * 2 ** 32;
}

function sysmsgTemplate(template, slots) {
  const links = Object.entries(slots).map(([name, members]) =>
    `<link name="${name}"><memberlist>${members.map(({ id, name: displayName }) =>
      `<member><username>${id}</username><nickname>${displayName}</nickname></member>`
    ).join('')}</memberlist><plain>${members.length ? '' : name}</plain></link>`
  ).join('');
  return `<sysmsg type="sysmsgtemplate"><sysmsgtemplate><content_template><template>${template}</template><link_list>${links}</link_list></content_template></sysmsgtemplate></sysmsg>`;
}

test('message content decoding handles plain SQLite text, byte values, and WCDB zstd type 4', () => {
  const text = '<msg><appmsg><title>你好</title></appmsg></msg>';
  assert.equal(decodeWechatMessageContent(text), text);
  assert.equal(decodeWechatMessageContent(Buffer.from(text)), text);
  assert.equal(decodeWechatMessageContent(zstdCompressSync(Buffer.from(text)), 4), text);
  assert.equal(decodeWechatMessageContent(Buffer.from(text), 3), text);
  assert.equal(decodeWechatMessageContent(null), '');
});

test('group sender prefixes are removed while preserving text and XML bodies', () => {
  const text = parseWechatMessageContent(1, 'wxid_sender:\r\n正文仍然保留');
  assert.equal(text.text, '正文仍然保留');
  const image = parseWechatMessageContent(3, '张三:\n<msg><img md5="abcd"/></msg>');
  assert.equal(image.type, 'image');
  assert.equal(image.mediaDescriptors[0].md5, 'abcd');
});

test('image, voice, video, and file descriptors use XML and packed protobuf fields', () => {
  const imagePacked = bytesField(3, bytesField(4, Buffer.from('image-cache-name')));
  const image = parseWechatMessageContent(3, '<msg><img md5="ab12"/></msg>', imagePacked);
  assert.deepEqual(image.mediaDescriptors[0], {
    kind: 'image', name: 'image-cache-name', storedAs: null, md5: 'ab12', size: null,
    extension: null, durationMs: null, durationSeconds: null, transcription: null, url: null
  });

  const voiceInfo = Buffer.concat([varintField(1, 2), bytesField(2, Buffer.from('  周六见  '))]);
  const voice = parseWechatMessageContent(34, '<msg><voicemsg voicelength="3200"/></msg>', bytesField(5, voiceInfo));
  assert.equal(voice.mediaDescriptors[0].durationMs, 3200);
  assert.equal(voice.mediaDescriptors[0].transcription, '周六见');
  const unconvertedVoice = parseWechatMessageContent(34, '<msg><voicemsg/></msg>', bytesField(5, bytesField(2, Buffer.from('不应输出'))));
  assert.equal(unconvertedVoice.mediaDescriptors[0].transcription, null);

  const video = parseWechatMessageContent(43, '<msg><videomsg playlength="12" md5="m2"/></msg>', bytesField(4, bytesField(8, Buffer.from('video-name'))));
  assert.equal(video.mediaDescriptors[0].name, 'video-name');
  assert.equal(video.mediaDescriptors[0].durationSeconds, 12);
  assert.equal(video.mediaDescriptors[0].md5, 'm2');

  const fileXml = '<msg><appmsg><title>report.pdf</title><type>6</type><appattach><totallen>2048</totallen><fileext>pdf</fileext></appattach></appmsg></msg>';
  const file = parseWechatMessageContent(appType(6), fileXml, bytesField(7, bytesField(2, Buffer.from('report-1.pdf'))));
  assert.equal(file.type, 'file');
  assert.equal(file.mediaDescriptors[0].name, 'report.pdf');
  assert.equal(file.mediaDescriptors[0].storedAs, 'report-1.pdf');
  assert.equal(file.mediaDescriptors[0].size, 2048);
  assert.equal(file.mediaDescriptors[0].extension, 'pdf');
});

test('quotes, links, contact cards, stickers, and locations remain structured', () => {
  const quote = parseWechatMessageContent(appType(57), '<msg><appmsg><title>回复内容</title><refermsg><type>1</type><svrid>987654</svrid><chatusr>wxid_sender</chatusr><displayname>小明</displayname><content>被引用文字</content></refermsg></appmsg></msg>');
  assert.equal(quote.type, 'quote');
  assert.equal(quote.quoteMessageId, '987654');
  assert.equal(quote.text, '回复内容');
  assert.equal(quote.card.quoted.senderId, 'wxid_sender');
  assert.equal(quote.card.quoted.excerpt, '被引用文字');

  const link = parseWechatMessageContent(appType(5), '<msg><appmsg><type>5</type><title>文章标题</title><des>摘要</des><url>https://example.test/a?x=1&amp;y=2</url><sourcedisplayname>公众号</sourcedisplayname></appmsg></msg>');
  assert.equal(link.type, 'link');
  assert.equal(link.card.url, 'https://example.test/a?x=1&y=2');
  assert.equal(link.card.source, '公众号');
  const xmlTypedLink = parseWechatMessageContent(49, '<msg><appmsg><type>5</type><title>XML 子类型</title><url>https://example.test/xml</url></appmsg></msg>');
  assert.equal(xmlTypedLink.subtype, 5);
  assert.equal(xmlTypedLink.type, 'link');

  const contact = parseWechatMessageContent(42, '<msg username="wxid_card" nickname="名片联系人"/>');
  assert.equal(contact.type, 'card');
  assert.equal(contact.card.contactId, 'wxid_card');

  const sticker = parseWechatMessageContent(47, '<msg><emoji md5="ABCD" cdnurl="https://cdn.test/sticker"/></msg>');
  assert.equal(sticker.type, 'sticker');
  assert.equal(sticker.mediaDescriptors[0].md5, 'abcd');
  assert.equal(sticker.mediaDescriptors[0].url, 'https://cdn.test/sticker');
  const appStickerInfo = bytesField(2, Buffer.from('https://cdn.test/app-sticker')).toString('base64');
  const appSticker = parseWechatMessageContent(appType(8), `<msg><appmsg><type>8</type><appattach><emoticonmd5>EF01</emoticonmd5><emojiinfo>${appStickerInfo}</emojiinfo></appattach></appmsg></msg>`);
  assert.equal(appSticker.mediaDescriptors[0].md5, 'ef01');
  assert.equal(appSticker.mediaDescriptors[0].url, 'https://cdn.test/app-sticker');

  const location = parseWechatMessageContent(48, '<msg><location x="31.2" y="121.5" poiname="外滩" label="上海"/></msg>');
  assert.deepEqual(location.details, { latitude: 31.2, longitude: 121.5, name: '外滩', address: '上海' });
});

test('system, recall, join, leave, rename, transfer, red packet, and calls are classified', () => {
  assert.equal(parseWechatMessageContent(10000, '系统通知').type, 'system');
  const plainRecall = parseWechatMessageContent(10000, '你撤回了一条消息');
  assert.equal(plainRecall.type, 'recall');
  assert.equal(plainRecall.details.by, '你');
  const xmlRecall = parseWechatMessageContent(10002, '<sysmsg type="revokemsg"><revokemsg><newmsgid>9001</newmsgid><replacemsg>你撤回了一条消息</replacemsg></revokemsg></sysmsg>');
  assert.equal(xmlRecall.type, 'recall');
  assert.equal(xmlRecall.details.recalledMessageId, '9001');

  const person = [{ id: 'wxid_new', name: '新成员' }];
  assert.equal(parseWechatMessageContent(10002, sysmsgTemplate('$username$加入了群聊', { username: person })).type, 'join');
  assert.equal(parseWechatMessageContent(10002, sysmsgTemplate('$username$退出了群聊', { username: person })).type, 'leave');
  const rename = parseWechatMessageContent(10002, sysmsgTemplate('修改群名为$remark$', { remark: [{ id: 'room', name: '周末徒步' }] }));
  assert.equal(rename.type, 'renamed');
  assert.equal(rename.details.name, '周末徒步');
  const groupNotice = parseWechatMessageContent(appType(87), '<msg><appmsg><type>87</type><textannouncement>周六集合</textannouncement></appmsg></msg>');
  assert.equal(groupNotice.type, 'group_notice');
  assert.equal(groupNotice.text, '周六集合');

  const transfer = parseWechatMessageContent(appType(2000), '<msg><appmsg><wcpayinfo><feedesc>￥12.30</feedesc><paysubtype>3</paysubtype><pay_memo>午饭</pay_memo></wcpayinfo></appmsg></msg>');
  assert.deepEqual(transfer.details, { amountFen: 1230, state: 'received', memo: '午饭' });
  const packet = parseWechatMessageContent(appType(2001), '<msg><appmsg><wcpayinfo><feedesc>¥0.88</feedesc><sendertitle>恭喜发财</sendertitle></wcpayinfo></appmsg></msg>');
  assert.equal(packet.type, 'red_packet');
  assert.equal(packet.details.amountFen, 88);

  const call = parseWechatMessageContent(50, '<msg><voipmsg><VoIPBubbleMsg><room_type>1</room_type><msg>通话时长 00:31</msg></VoIPBubbleMsg></voipmsg></msg>');
  assert.equal(call.type, 'call');
  assert.deepEqual(call.details, { medium: 'voice', state: 'connected', seconds: 31 });
  const missed = parseWechatMessageContent(50, '<msg><voipmsg><VoIPBubbleMsg><room_type>0</room_type><msg>对方无应答</msg></VoIPBubbleMsg></voipmsg></msg>');
  assert.equal(missed.details.state, 'missed');
});

test('unsupported and malformed messages retain their type and source payload', () => {
  const unsupported = parseWechatMessageContent(777, '<opaque>keep me</opaque>');
  assert.equal(unsupported.type, 'unknown');
  assert.equal(unsupported.localType, 777);
  assert.equal(unsupported.unknownPayload.rawContent, '<opaque>keep me</opaque>');
  const malformed = parseWechatMessageContent(appType(5), '<msg><appmsg>partial');
  assert.equal(malformed.type, 'unknown');
  assert.ok(malformed.unknownPayload.rawContent.includes('partial'));
  assert.ok(malformed.diagnostics.length > 0);
});
