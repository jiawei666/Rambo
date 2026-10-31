import type {
  ConnectorCapabilityStatus,
  ConnectorConnection,
  ConnectorGrant,
  ConnectorProvider
} from '../shared/contracts';
import type {
  WechatCredential,
  WechatMediaRef,
  WechatMessage,
  WechatMessageQuery,
  WechatPage,
  WechatSearchQuery,
  WechatSession
} from './wechat-adapter';
import {
  assertValidCursor,
  parseWechatTimeRange
} from './wechat-adapter';
import type {
  WechatMediaContentItem,
  WechatMediaDelivery,
  WechatMediaSource
} from './wechat-media-content';

type WechatDynamicToolContentItem = WechatMediaContentItem;

export const WECHAT_TOOL_NAMESPACE = 'rambo_wechat';

const connectionIdSchema = {
  type: 'string',
  description: '当前 Bot 连接目录中的微信连接 ID。'
} as const;

const timeProperties = {
  start: { type: 'string', description: '明确起始时间，ISO 8601 含时区。' },
  end: { type: 'string', description: '明确结束时间，ISO 8601 含时区。' },
  relative_minutes: {
    type: 'integer',
    minimum: 1,
    maximum: 527040,
    description: '相对当前时刻向前查询的分钟数；不能与 start/end 同时使用。'
  },
  cursor: { type: 'string', description: '上一页返回的短期分页游标。' }
} as const;

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
}

export const WECHAT_TOOLS = {
  type: 'namespace',
  name: WECHAT_TOOL_NAMESPACE,
  description: '读取当前 Bot 获授权的本机微信聊天。只读，不监听新消息，不发送微信，不联网补取。',
  tools: [{
    type: 'function',
    name: 'wechat_sessions',
    description: '列出或按名称筛选当前固定微信账号的会话目录，返回稳定 session_id。查消息前先用它定位会话。',
    inputSchema: objectSchema({
      connection_id: connectionIdSchema,
      query: { type: 'string', description: '可选会话名称筛选。' },
      cursor: timeProperties.cursor
    }, ['connection_id'])
  }, {
    type: 'function',
    name: 'wechat_messages',
    description: '按一个或多个稳定 session_id 和明确时间范围读取结构化聊天消息。',
    inputSchema: objectSchema({
      connection_id: connectionIdSchema,
      session_ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 50
      },
      start: timeProperties.start,
      end: timeProperties.end,
      relative_minutes: timeProperties.relative_minutes,
      cursor: timeProperties.cursor
    }, ['connection_id', 'session_ids'])
  }, {
    type: 'function',
    name: 'wechat_search',
    description: '按关键词搜索当前固定微信账号的本机消息，可限定会话、明确时间和消息类型。',
    inputSchema: objectSchema({
      connection_id: connectionIdSchema,
      query: { type: 'string', minLength: 1, maxLength: 500 },
      session_ids: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 50
      },
      message_types: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 30
      },
      start: timeProperties.start,
      end: timeProperties.end,
      relative_minutes: timeProperties.relative_minutes,
      cursor: timeProperties.cursor
    }, ['connection_id', 'query'])
  }, {
    type: 'function',
    name: 'wechat_media',
    description: '读取前一次聊天结果中的本机微信媒体。图片和语音直接交给当前 Agent；视频、普通文件和贴纸通过短期资源句柄返回本机可读取资源。只读本机已保存内容，不联网补取，不暴露内部路径。',
    inputSchema: objectSchema({
      connection_id: connectionIdSchema,
      resource_handle: {
        type: 'string',
        pattern: '^[a-f0-9]{32}$',
        description: '微信消息中 media.resourceHandle 的字符串。'
      }
    }, ['connection_id', 'resource_handle'])
  }]
} as const;

export type WechatConnectionDirectoryEntry = {
  connection_id: string;
  provider: 'wechat';
  display_name: string;
  account: string;
  capability_status: Record<string, ConnectorCapabilityStatus>;
};

const TOOL_CAPABILITY: Record<string, string> = {
  wechat_sessions: 'wechat.sessions',
  wechat_messages: 'wechat.messages',
  wechat_search: 'wechat.search',
  wechat_media: 'wechat.media'
};

export function wechatConnectionDirectory(
  connections: ConnectorConnection[],
  grants: ConnectorGrant[],
  botId: string
): WechatConnectionDirectoryEntry[] {
  const allowed = new Set(
    grants.filter(grant => grant.botId === botId).map(grant => grant.connectionId)
  );
  return connections
    .filter(connection =>
      connection.providerId === 'wechat' &&
      allowed.has(connection.id) &&
      connection.status === 'ready')
    .map(connection => ({
      connection_id: connection.id,
      provider: 'wechat',
      display_name: connection.displayName,
      account: connection.accountLabel,
      capability_status: connection.capabilities ?? {}
    }));
}

export interface WechatToolHost {
  connection(botId: string, connectionId: string): ConnectorConnection;
  credential(connection: ConnectorConnection): WechatCredential;
  reader(): {
    sessions(
      connection: ConnectorConnection,
      credential: WechatCredential,
      query?: { query?: string; cursor?: string }
    ): Promise<WechatPage<WechatSession>>;
    messages(
      connection: ConnectorConnection,
      credential: WechatCredential,
      query: WechatMessageQuery
    ): Promise<WechatPage<WechatMessage>>;
    search(
      connection: ConnectorConnection,
      credential: WechatCredential,
      query: WechatSearchQuery
    ): Promise<WechatPage<WechatMessage>>;
    readMedia(
      connection: ConnectorConnection,
      credential: WechatCredential,
      resourceHandle: string
    ): Promise<{
      bytes: Buffer;
      mimeType: string;
      fileName: string;
      kind?: WechatMediaRef['kind'];
      status?: WechatMediaRef['status'];
      transcription?: string | null;
      limitation?: string;
    }>;
  };
  processMedia?(media: WechatMediaSource): Promise<WechatMediaDelivery>;
  providers(): ConnectorProvider[];
}

export async function executeWechatTool(
  host: WechatToolHost,
  botId: string,
  tool: string,
  value: unknown
): Promise<{
  success: boolean;
  contentItems: WechatDynamicToolContentItem[];
}> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('微信工具参数格式无效');
    }
    const input = value as Record<string, unknown>;
    const connection = host.connection(botId, requiredString(input.connection_id, 'connection_id'));
    const capability = TOOL_CAPABILITY[tool];
    if (!capability) throw new Error(`不支持的微信工具：${tool}`);
    if (connection.capabilities?.[capability] !== 'ready') {
      throw new Error('该微信连接当前不支持此查询能力');
    }
    const credential = host.credential(connection);
    const reader = host.reader();
    let result: unknown;
    if (tool === 'wechat_sessions') {
      const query = optionalString(input.query);
      const page = await reader.sessions(connection, credential, {
        ...(query ? { query } : {}),
        ...(assertValidCursor(input.cursor) ? { cursor: assertValidCursor(input.cursor)! } : {})
      });
      const sessions = page.items;
      result = {
        ...page,
        sessions,
        match: sessions.length === 0
          ? 'none'
          : sessions.length === 1 ? 'unique' : 'ambiguous',
        coverage: {
          ...page.coverage,
          notes: [...page.coverage.notes, '会话名称只用于定位稳定 session_id，不能代替 ID 查询。']
        }
      };
    } else if (tool === 'wechat_messages') {
      result = await reader.messages(connection, credential, {
        sessionIds: stringArray(input.session_ids, 'session_ids', 1, 50),
        ...parseWechatTimeRange({
          start: input.start,
          end: input.end,
          relativeMinutes: input.relative_minutes
        }),
        ...(assertValidCursor(input.cursor) ? { cursor: assertValidCursor(input.cursor)! } : {})
      });
    } else if (tool === 'wechat_search') {
      result = await reader.search(connection, credential, {
        query: requiredString(input.query, 'query'),
        ...(input.session_ids === undefined
          ? {}
          : { sessionIds: stringArray(input.session_ids, 'session_ids', 1, 50) }),
        ...(input.message_types === undefined
          ? {}
          : { messageTypes: stringArray(input.message_types, 'message_types', 1, 30) }),
        ...parseWechatTimeRange({
          start: input.start,
          end: input.end,
          relativeMinutes: input.relative_minutes
        }),
        ...(assertValidCursor(input.cursor) ? { cursor: assertValidCursor(input.cursor)! } : {})
      });
    } else if (tool === 'wechat_media') {
      const resourceHandle = requiredString(input.resource_handle, 'resource_handle');
      if (!/^[a-f0-9]{32}$/u.test(resourceHandle)) {
        throw new Error('微信媒体资源句柄无效');
      }
      const media = await reader.readMedia(connection, credential, resourceHandle);
      if (!media.bytes.length || media.bytes.length > 32 * 1024 * 1024) {
        throw new Error('微信媒体为空或超过单次读取上限');
      }
      if (host.processMedia) {
        const delivery = await host.processMedia(media);
        const contentItems: WechatDynamicToolContentItem[] = [
          {
            type: 'inputText',
            text: JSON.stringify({
              success: true,
              connection_id: connection.id,
              provider: 'wechat',
              account: connection.accountLabel,
              media: {
                resource_handle: resourceHandle,
                kind: media.kind ?? 'unknown',
                status: media.status ?? 'available',
                fileName: media.fileName,
                mimeType: media.mimeType,
                size: media.bytes.length,
                delivery: delivery.delivery,
                ...(delivery.localPath ? { local_path: delivery.localPath } : {}),
                ...(delivery.expiresInDays ? { expires_in_days: delivery.expiresInDays } : {}),
                ...(delivery.mimeType ? { processed_mime_type: delivery.mimeType } : {}),
                ...(delivery.fileName ? { processed_file_name: delivery.fileName } : {}),
                ...(media.transcription ? { transcription: media.transcription } : {}),
                ...(media.limitation ? { limitation: media.limitation } : {}),
                ...(delivery.frameTimesSeconds
                  ? { frame_times_seconds: delivery.frameTimesSeconds }
                  : {}),
                ...(delivery.videoDurationSeconds !== undefined
                  ? { video_duration_seconds: delivery.videoDurationSeconds }
                  : {}),
                ...(delivery.extractedTextCharacters !== undefined
                  ? { extracted_text_characters: delivery.extractedTextCharacters }
                  : {}),
                ...(delivery.truncated ? { text_truncated: true } : {})
              }
            })
          },
          ...delivery.contentItems
        ];
        const outputBytes = contentItems.reduce((sum, item) =>
          sum + Buffer.byteLength(JSON.stringify(item), 'utf8'), 0);
        if (outputBytes > 24 * 1024 * 1024) {
          throw new Error('微信媒体传给 Agent 的内容超过单次上限');
        }
        return { success: true, contentItems };
      }
      const isImage = media.mimeType.startsWith('image/');
      const isAudio = media.mimeType.startsWith('audio/');
      if (isImage || isAudio) {
        throw new Error('微信媒体临时目录未配置，不能安全地读取图片或语音');
      }
      if (!isImage && !isAudio) {
        return {
          success: true,
          contentItems: [{
            type: 'inputText',
            text: JSON.stringify({
              success: true,
              connection_id: connection.id,
              provider: 'wechat',
              account: connection.accountLabel,
              media: {
                resource_handle: resourceHandle,
                kind: media.kind ?? 'unknown',
                status: media.status ?? 'available',
                fileName: media.fileName,
                mimeType: media.mimeType,
                size: media.bytes.length,
                availableLocally: true,
                delivery: 'short_term_resource',
                ...(media.transcription ? { transcription: media.transcription } : {}),
                ...(media.limitation ? { limitation: media.limitation } : {})
              },
              instruction: '继续使用这个 resource_handle 调用 wechat_media；资源只在当前微信连接的短期有效期内可读。'
            })
          }]
        };
      }
    } else {
      throw new Error(`不支持的微信工具：${tool}`);
    }
    const output = JSON.stringify({
      connection_id: connection.id,
      provider: 'wechat',
      account: connection.accountLabel,
      result: safeWechatResult(result)
    });
    if (Buffer.byteLength(output, 'utf8') > 512 * 1024) {
      throw new Error('微信 Tool 结果超过协议上限，请缩小查询范围');
    }
    return { success: true, contentItems: [{ type: 'inputText', text: output }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : '微信查询失败';
    return {
      success: false,
      contentItems: [{
        type: 'inputText',
        text: JSON.stringify({
          success: false,
          error: sanitizeError(message)
        })
      }]
    };
  }
}

export function safeMediaRefs(items: WechatMediaRef[]): WechatMediaRef[] {
  return items.map(item => ({
    ...item,
    resourceHandle: item.resourceHandle
      ? /^[a-f0-9]{32}$/u.test(item.resourceHandle) ? item.resourceHandle : null
      : null
  }));
}

export function safeWechatResult<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => safeWechatResult(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'media' && Array.isArray(item)) return [key, safeMediaRefs(item as WechatMediaRef[])];
    return [key, safeWechatResult(item)];
  }));
  return result as T;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200_000) {
    throw new Error(`微信工具缺少有效字段：${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 500) {
    throw new Error('微信工具文字参数无效');
  }
  return value.trim() || undefined;
}

function stringArray(
  value: unknown,
  field: string,
  minItems: number,
  maxItems: number
): string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems ||
      value.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) {
    throw new Error(`微信工具字段 ${field} 无效`);
  }
  return [...new Set(value.map(item => String(item).trim()))];
}

function sanitizeError(message: string): string {
  return message
    .replace(/\s+/gu, ' ')
    .replace(/(?:\/[^\s:]+){2,}/gu, '[本机路径]')
    .trim()
    .slice(0, 500) || '微信查询失败';
}
