import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const constantsSource = [
  "export interface ConnectorProvider {}",
  "export type ConnectorCapabilityStatus = 'ready' | 'unavailable';",
  "export interface ConnectorConnection {",
  "  id: string; providerId: string; displayName: string; accountLabel: string;",
  "  authKind: 'local-key-capture'; status: 'ready'; createdAt: string; updatedAt: string;",
  "  capabilities?: Record<string, ConnectorCapabilityStatus>;",
  "}",
  "export interface ConnectorGrant { id: string; botId: string; connectionId: string; createdAt: string }"
].join('\n');
const adapterSource = readFileSync(new URL('../../src/main/wechat-adapter.ts', import.meta.url), 'utf8');
const toolsSource = readFileSync(new URL('../../src/main/wechat-tools.ts', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../../src/main/wechat-content.ts', import.meta.url), 'utf8');
const sqlcipherSource = readFileSync(new URL('../../src/main/wechat-sqlcipher.ts', import.meta.url), 'utf8');
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const runtimeUrl = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions
}).outputText).toString('base64')}`;
const contractsUrl = runtimeUrl(constantsSource);
const contentUrl = runtimeUrl(contentSource);
const sqlcipherUrl = runtimeUrl(sqlcipherSource);
const adapter = ts.transpileModule(adapterSource, { compilerOptions }).outputText
  .replace("from '../shared/contracts'", `from '${contractsUrl}'`)
  .replace("from './connector-credentials'", "from 'data:text/javascript;base64,'")
  .replace("from './wechat-content'", `from '${contentUrl}'`)
  .replace("from './wechat-sqlcipher'", `from '${sqlcipherUrl}'`);
const tools = ts.transpileModule(toolsSource, { compilerOptions }).outputText
  .replace("from '../shared/contracts'", `from '${contractsUrl}'`)
  .replace("from './wechat-adapter'", `from '${runtimeUrl(adapter)}'`);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(tools).toString('base64')}`;
const {
  WECHAT_TOOLS,
  executeWechatTool,
  safeWechatResult,
  wechatConnectionDirectory
} = await import(moduleUrl);

function connection(overrides = {}) {
  return {
    id: '1b72665d-e842-43ef-8d95-81022d343a80',
    providerId: 'wechat',
    displayName: '本机微信',
    accountLabel: 'wxid_example',
    authKind: 'local-key-capture',
    status: 'ready',
    capabilities: {
      'wechat.sessions': 'ready',
      'wechat.messages': 'ready',
      'wechat.search': 'ready',
      'wechat.media': 'unavailable'
    },
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    ...overrides
  };
}

const credential = {
  kind: 'wechat-sqlcipher',
  accountId: 'wxid_example',
  keys: {
    'session/session.db': { encKey: 'ab'.repeat(32), salt: 'cd'.repeat(16) }
  },
  dataDirectory: '/tmp/wechat-profile',
  wechatVersion: '4.1.15',
  wechatBuild: '270135'
};

function hostFor(target, calls = [], mediaResponse = {
  bytes: Buffer.from([0xff, 0xd8, 0xff]),
  mimeType: 'image/jpeg',
  fileName: 'image.jpg',
  kind: 'image',
  status: 'available'
}, processMedia) {
  return {
    connection: (_botId, connectionId) => {
      assert.equal(connectionId, target.id);
      return target;
    },
    credential: () => credential,
    reader: () => ({
      sessions: async (_connection, _credential, query) => {
        calls.push(['sessions', query]);
        return {
          items: [{ sessionId: 'session-a', displayName: 'Alice', type: 'private',
            latestMessageAt: '2026-10-25T10:00:00.000Z', unreadCount: 2 }],
          nextCursor: null,
          hasMore: false,
          returnedCount: 1,
          knownTotal: 1,
          coverage: { start: '1970-01-01T00:00:00.000Z', end: '2026-10-25T12:00:00.000Z',
            localOnly: true, complete: true, notes: [] },
          truncation: null,
          readAt: '2026-10-25T12:00:00.000Z'
        };
      },
      messages: async (_connection, _credential, query) => {
        calls.push(['messages', query]);
        return {
          items: [{
            messageId: 'message-a', localId: '1', serverId: 'server-a',
            sessionId: 'session-a', senderId: 'wxid_alice', senderDisplayName: 'Alice',
            sentAt: '2026-10-25T10:00:00.000Z', sequence: 1, type: 'text',
            subtype: null, text: 'hello', quoteMessageId: null, card: null,
            media: [{ mediaId: 'media-a', kind: 'image', status: 'available',
              mimeType: 'image/png', size: 10, resourceHandle: 'ab'.repeat(16) }],
            unknownPayload: null
          }],
          nextCursor: null,
          hasMore: false,
          returnedCount: 1,
          knownTotal: 1,
          coverage: { start: query.start, end: query.end,
            localOnly: true, complete: true, notes: [] },
          truncation: null,
          readAt: '2026-10-25T12:00:00.000Z'
        };
      },
      search: async (_connection, _credential, query) => {
        calls.push(['search', query]);
        return {
          items: [], nextCursor: null, hasMore: false, returnedCount: 0,
          knownTotal: 0,
          coverage: { start: query.start, end: query.end,
            localOnly: true, complete: true, notes: [] },
          truncation: null, readAt: '2026-10-25T12:00:00.000Z'
        };
      },
      readMedia: async (_connection, _credential, resourceHandle) => {
        calls.push(['media', resourceHandle]);
        return mediaResponse;
      }
    }),
    ...(processMedia ? { processMedia } : {}),
    providers: () => []
  };
}

test('WeChat directory includes only ready connections granted to the current Bot', () => {
  const ready = connection();
  const noGrant = connection({ id: '1b72665d-e842-43ef-8d95-81022d343a81' });
  const expired = connection({ id: '1b72665d-e842-43ef-8d95-81022d343a82', status: 'expired' });
  assert.deepEqual(wechatConnectionDirectory(
    [ready, noGrant, expired],
    [{ id: 'g1', botId: 'bot-a', connectionId: ready.id, createdAt: ready.createdAt }],
    'bot-a'
  ).map(item => item.connection_id), [ready.id]);
  assert.deepEqual(wechatConnectionDirectory(
    [ready],
    [{ id: 'g1', botId: 'bot-a', connectionId: ready.id, createdAt: ready.createdAt }],
    'bot-b'
  ), []);
});

test('WeChat tools reject the removed Moments capability and enforce local capability status', async () => {
  const calls = [];
  assert.equal(WECHAT_TOOLS.tools.some(tool => tool.name === 'wechat_moments'), false);
  const unavailable = await executeWechatTool(hostFor(connection(), calls), 'bot-a',
    'wechat_moments', {
      connection_id: connection().id,
      relative_minutes: 60
    });
  assert.equal(unavailable.success, false);
  assert.match(unavailable.contentItems[0].text, /不支持的微信工具/u);
  assert.deepEqual(calls, []);

  const sessions = await executeWechatTool(hostFor(connection(), calls), 'bot-a',
    'wechat_sessions', {
      connection_id: connection().id,
      query: 'Ali'
    });
  assert.equal(sessions.success, true);
  const text = sessions.contentItems[0].text;
  assert.match(text, /"session_id"|"sessionId"/u);
  assert.equal(text.includes('/private/internal'), false);
  assert.equal(text.includes('ab'.repeat(32)), false);
});

test('WeChat messages require a stable session ID and explicit or relative time', async () => {
  const target = connection();
  const missingSession = await executeWechatTool(hostFor(target), 'bot-a', 'wechat_messages', {
    connection_id: target.id,
    relative_minutes: 60
  });
  assert.equal(missingSession.success, false);
  assert.match(missingSession.contentItems[0].text, /session_ids/u);
  const missingTime = await executeWechatTool(hostFor(target), 'bot-a', 'wechat_messages', {
    connection_id: target.id,
    session_ids: ['session-a']
  });
  assert.equal(missingTime.success, false);
  assert.match(missingTime.contentItems[0].text, /起止时间或相对时间/u);
  const success = await executeWechatTool(hostFor(target), 'bot-a', 'wechat_messages', {
    connection_id: target.id,
    session_ids: ['session-a'],
    relative_minutes: 60
  });
  assert.equal(success.success, true);
  assert.match(success.contentItems[0].text, /message-a/u);
});

test('WeChat results preserve valid media handles and remove non-handle paths', () => {
  const result = safeWechatResult({
    messages: [{
      messageId: 'message-a',
      media: [
        {
          mediaId: 'media-a', kind: 'image', status: 'available',
          mimeType: 'image/png', size: 4,
          resourceHandle: 'cd'.repeat(16)
        },
        {
          mediaId: 'media-b', kind: 'file', status: 'unavailable',
          mimeType: null, size: null,
          resourceHandle: '/private/internal/image.png'
        }
      ]
    }]
  });
  assert.equal(result.messages[0].media[0].mediaId, 'media-a');
  assert.equal(result.messages[0].media[0].resourceHandle, 'cd'.repeat(16));
  assert.equal(result.messages[0].media[1].resourceHandle, null);
  assert.equal(JSON.stringify(result).includes('/private/internal'), false);
});

test('WeChat media requires the temporary path processor and never returns inline base64', async () => {
  const handle = 'ef'.repeat(16);
  const target = connection({ capabilities: {
    'wechat.sessions': 'ready',
    'wechat.messages': 'ready',
    'wechat.search': 'ready',
    'wechat.media': 'ready'
  } });
  const calls = [];
  const image = await executeWechatTool(hostFor(target, calls), 'bot-a', 'wechat_media', {
    connection_id: target.id,
    resource_handle: handle
  });
  assert.equal(image.success, false);
  assert.match(image.contentItems[0].text, /临时目录未配置/u);

  const audio = await executeWechatTool(hostFor(target, calls, {
    bytes: Buffer.from([0x02, 0x23, 0x21, 0x53]),
    mimeType: 'audio/silk',
    fileName: 'voice.silk',
    kind: 'audio',
    status: 'available',
    limitation: '原始 SILK'
  }), 'bot-a', 'wechat_media', {
    connection_id: target.id,
    resource_handle: handle
  });
  assert.equal(audio.success, false);
  assert.match(audio.contentItems[0].text, /临时目录未配置/u);

  const transcribed = await executeWechatTool(hostFor(target, calls, {
    bytes: Buffer.from('RIFF----WAVE-local-wav'),
    mimeType: 'audio/wav',
    fileName: 'voice.wav',
    kind: 'audio',
    status: 'available',
    transcription: '周六见'
  }, async () => ({
    delivery: 'local_audio',
    localPath: '/tmp/composer-attachments/wechat-media-1700000000000-11111111.wav',
    mimeType: 'audio/wav',
    fileName: 'voice.wav',
    expiresInDays: 7,
    contentItems: [{
      type: 'inputText',
      text: JSON.stringify({
        local_path: '/tmp/composer-attachments/wechat-media-1700000000000-11111111.wav',
        transcription: '周六见'
      })
    }]
  })), 'bot-a', 'wechat_media', {
    connection_id: target.id,
    resource_handle: handle
  });
  assert.equal(transcribed.success, true);
  const transcribedInfo = JSON.parse(transcribed.contentItems[0].text);
  assert.equal(transcribedInfo.media.local_path,
    '/tmp/composer-attachments/wechat-media-1700000000000-11111111.wav');
  assert.equal(transcribedInfo.media.expires_in_days, 7);
  assert.match(transcribedInfo.media.transcription, /周六见/u);
  assert.doesNotMatch(JSON.stringify(transcribed), /data:(?:image|audio)\//u);

  const video = await executeWechatTool(hostFor(target, calls, {
    bytes: Buffer.from('0000ftypisom-video'),
    mimeType: 'video/mp4',
    fileName: 'clip.mp4',
    kind: 'video',
    status: 'available'
  }), 'bot-a', 'wechat_media', {
    connection_id: target.id,
    resource_handle: handle
  });
  assert.equal(video.success, true);
  assert.equal(video.contentItems.length, 1);
  assert.equal(video.contentItems[0].type, 'inputText');
  const videoInfo = JSON.parse(video.contentItems[0].text);
  assert.equal(videoInfo.media.resource_handle, handle);
  assert.equal(videoInfo.media.delivery, 'short_term_resource');
  assert.equal(videoInfo.media.mimeType, 'video/mp4');
  assert.match(videoInfo.instruction, /wechat_media/u);
  assert.equal(JSON.stringify(videoInfo).includes('/private/'), false);

  const silk = await executeWechatTool(hostFor(target, calls, {
    bytes: Buffer.from([0x02, 0x23, 0x21, 0x53]),
    mimeType: 'audio/silk',
    fileName: 'voice.silk',
    kind: 'audio',
    status: 'available',
    limitation: '原始 SILK'
  }), 'bot-a', 'wechat_media', {
    connection_id: target.id,
    resource_handle: handle
  });
  assert.equal(silk.success, false);
  assert.match(silk.contentItems[0].text, /临时目录未配置/u);
});

test('media processor delivery is mapped to the App Server text and image/audio content types', async () => {
  const handle = '12'.repeat(16);
  const target = connection({ capabilities: {
    'wechat.sessions': 'ready',
    'wechat.messages': 'ready',
    'wechat.search': 'ready',
    'wechat.media': 'ready'
  } });
  const video = await executeWechatTool(hostFor(target, [], {
    bytes: Buffer.from('video'), mimeType: 'video/mp4', fileName: 'clip.mp4',
    kind: 'video', status: 'available'
  }, async media => {
    assert.equal(media.kind, 'video');
    return {
      delivery: 'video_frames',
      frameTimesSeconds: [0, 2],
      videoDurationSeconds: 8,
      contentItems: [
        { type: 'inputText', text: '两帧视频摘要输入' },
        { type: 'inputImage', imageUrl: 'data:image/jpeg;base64,frame-a' },
        { type: 'inputImage', imageUrl: 'data:image/jpeg;base64,frame-b' }
      ]
    };
  }), 'bot-a', 'wechat_media', {
    connection_id: target.id, resource_handle: handle
  });
  assert.equal(video.success, true);
  assert.equal(video.contentItems.filter(item => item.type === 'inputImage').length, 2);
  assert.match(video.contentItems[0].text, /video_duration_seconds/u);
  assert.match(video.contentItems[0].text, /frame_times_seconds/u);

  const document = await executeWechatTool(hostFor(target, [], {
    bytes: Buffer.from('text'), mimeType: 'text/plain', fileName: 'note.txt',
    kind: 'file', status: 'available'
  }, async () => ({
    delivery: 'inline_text',
    extractedTextCharacters: 11,
    contentItems: [{ type: 'inputText', text: '只在本次调用交给 Agent 的正文' }]
  })), 'bot-a', 'wechat_media', {
    connection_id: target.id, resource_handle: handle
  });
  assert.equal(document.success, true);
  assert.match(document.contentItems[0].text, /inline_text/u);
  assert.match(document.contentItems[1].text, /正文/u);
});
