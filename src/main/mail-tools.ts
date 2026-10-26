import type { ConnectorConnection, ConnectorGrant, ConnectorProvider } from '../shared/contracts';

export const MAIL_TOOL_NAMESPACE = 'rambo_mail';

export const MAIL_TOOLS = {
  type: 'namespace',
  name: MAIL_TOOL_NAMESPACE,
  description: '当前 Bot 已获授权的邮件连接。每次调用必须传 connection_id；只能访问当前 Bot 获准使用的账号。',
  tools: [{
    type: 'function',
    name: 'mail_search',
    description: '搜索指定邮箱连接中的邮件，返回邮件 ID、主题、发件人、日期和摘要。需要读正文时再用 mail_read。',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string', description: '当前 Bot 目录中的连接 ID。' },
        query: { type: 'string', description: '全文关键字。' },
        from: { type: 'string', description: '发件人。' },
        subject: { type: 'string', description: '主题关键字。' },
        since: { type: 'string', description: '起始日期，ISO 8601。' },
        before: { type: 'string', description: '截止日期，ISO 8601。' },
        unread_only: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      },
      required: ['connection_id'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'mail_read',
    description: '读取指定邮箱连接中的一封邮件正文和附件清单。',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string' },
        message_id: { type: 'string', description: 'mail_search 返回的邮件 ID。' }
      },
      required: ['connection_id', 'message_id'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'mail_get_attachment',
    description: '下载指定邮件的单个附件，返回 base64 数据。附件最大 8 MiB。',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string' },
        message_id: { type: 'string' },
        attachment_id: { type: 'string', description: 'mail_read 返回的附件 ID。' }
      },
      required: ['connection_id', 'message_id', 'attachment_id'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'mail_create_draft',
    description: '起草一封指定邮箱连接的新邮件并保存到服务端草稿箱，不发送。',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string' },
        to: { type: 'array', items: { type: 'string' }, minItems: 1 },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        text: { type: 'string' },
        html: { type: 'string' }
      },
      required: ['connection_id', 'to', 'subject', 'text'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'mail_reply',
    description: '回复指定邮件。自动沿原邮件所属连接发送，并保留原邮件线程信息。',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
        html: { type: 'string' },
        reply_all: { type: 'boolean' }
      },
      required: ['connection_id', 'message_id', 'text'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'mail_send',
    description: '通过指定邮箱连接发送新邮件。',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: { type: 'string' },
        to: { type: 'array', items: { type: 'string' }, minItems: 1 },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        text: { type: 'string' },
        html: { type: 'string' }
      },
      required: ['connection_id', 'to', 'subject', 'text'],
      additionalProperties: false
    }
  }]
} as const;

export type MailConnectionDirectoryEntry = {
  connection_id: string;
  provider: string;
  provider_name: string;
  account: string;
  display_name: string;
  default_sender: boolean;
};

export type MailToolHost = {
  connection(botId: string, connectionId: string): ConnectorConnection;
  providers(): ConnectorProvider[];
  run<T>(
    connection: ConnectorConnection,
    action: (adapter: import('./mail-adapter').MailAdapter) => Promise<T>
  ): Promise<T>;
};

export function mailConnectionDirectory(
  connections: ConnectorConnection[],
  grants: ConnectorGrant[],
  botId: string,
  providerName: (providerId: string) => string
): MailConnectionDirectoryEntry[] {
  const allowed = new Set(grants.filter(grant => grant.botId === botId).map(grant => grant.connectionId));
  return connections
    .filter(connection => allowed.has(connection.id) && connection.status === 'ready')
    .map((connection, index) => ({
      connection_id: connection.id,
      provider: connection.providerId,
      provider_name: providerName(connection.providerId),
      account: connection.accountLabel,
      display_name: connection.displayName,
      default_sender: index === 0
    }));
}

export function mailToolsFor(connections: MailConnectionDirectoryEntry[]): Array<typeof MAIL_TOOLS> {
  return connections.length ? [MAIL_TOOLS] : [];
}

export async function executeMailTool(
  host: MailToolHost,
  botId: string,
  tool: string,
  value: unknown
): Promise<{ success: boolean; contentItems: Array<{ type: 'inputText'; text: string }> }> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('邮件工具参数格式无效');
    }
    const input = value as Record<string, unknown>;
    const connectionId = stringInput(input.connection_id, 'connection_id');
    const connection = host.connection(botId, connectionId);
    const result: unknown = await host.run<unknown>(connection, adapter => {
      if (tool === 'mail_search') {
        return adapter.search(connection, {
          ...(optionalString(input.query) !== undefined ? { query: optionalString(input.query)! } : {}),
          ...(optionalString(input.from) !== undefined ? { from: optionalString(input.from)! } : {}),
          ...(optionalString(input.subject) !== undefined ? { subject: optionalString(input.subject)! } : {}),
          ...(optionalString(input.since) !== undefined ? { since: optionalString(input.since)! } : {}),
          ...(optionalString(input.before) !== undefined ? { before: optionalString(input.before)! } : {}),
          ...(input.unread_only === true ? { unreadOnly: true } : {}),
          ...(input.limit === undefined ? {} : { limit: numberInput(input.limit, 'limit') })
        });
      }
      if (tool === 'mail_read') {
        return adapter.read(connection, stringInput(input.message_id, 'message_id'));
      }
      if (tool === 'mail_get_attachment') {
        return adapter.getAttachment(connection, {
          id: stringInput(input.message_id, 'message_id'),
          attachmentId: stringInput(input.attachment_id, 'attachment_id')
        });
      }
      if (tool === 'mail_create_draft') {
        return adapter.createDraft(connection, {
          to: stringArray(input.to, 'to'),
          ...(input.cc === undefined ? {} : { cc: stringArray(input.cc, 'cc') }),
          ...(input.bcc === undefined ? {} : { bcc: stringArray(input.bcc, 'bcc') }),
          subject: stringInput(input.subject, 'subject'),
          text: stringInput(input.text, 'text'),
          ...(optionalString(input.html) !== undefined ? { html: optionalString(input.html)! } : {})
        });
      }
      if (tool === 'mail_reply') {
        return adapter.reply(connection, {
          id: stringInput(input.message_id, 'message_id'),
          text: stringInput(input.text, 'text'),
          ...(optionalString(input.html) !== undefined ? { html: optionalString(input.html)! } : {}),
          ...(input.reply_all === true ? { replyAll: true } : {})
        });
      }
      if (tool === 'mail_send') {
        return adapter.send(connection, {
          to: stringArray(input.to, 'to'),
          ...(input.cc === undefined ? {} : { cc: stringArray(input.cc, 'cc') }),
          ...(input.bcc === undefined ? {} : { bcc: stringArray(input.bcc, 'bcc') }),
          subject: stringInput(input.subject, 'subject'),
          text: stringInput(input.text, 'text'),
          ...(optionalString(input.html) !== undefined ? { html: optionalString(input.html)! } : {})
        });
      }
      throw new Error(`不支持的邮件工具：${tool}`);
    });
    return {
      success: true,
      contentItems: [{
        type: 'inputText',
        text: JSON.stringify({
          connection_id: connection.id,
          provider: connection.providerId,
          provider_name: host.providers().find(provider => provider.id === connection.providerId)?.name ?? connection.providerId,
          account: connection.accountLabel,
          result
        })
      }]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '邮件操作失败';
    return {
      success: false,
      contentItems: [{
        type: 'inputText',
        text: safeToolError(message)
      }]
    };
  }
}

function safeToolError(message: string): string {
  return message
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300) || '邮件操作失败';
}

function stringInput(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200_000) {
    throw new Error(`邮件工具缺少有效字段：${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 200_000) throw new Error('邮件工具文字参数无效');
  return value.trim() || undefined;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 50 ||
      value.some(item => typeof item !== 'string' || !item.trim() || item.length > 320)) {
    throw new Error(`邮件工具字段 ${field} 必须是非空邮箱地址列表`);
  }
  return value.map(item => String(item).trim());
}

function numberInput(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`邮件工具字段 ${field} 必须是整数`);
  return value;
}
