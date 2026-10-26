import type { ConnectorConnection } from '../shared/contracts';
import type {
  ConnectorCredentialPayload
} from './connector-credentials';

export const BOT_CREDENTIAL_TOOL_NAMESPACE = 'rambo_credentials';

export const BOT_CREDENTIAL_TOOLS = {
  type: 'namespace',
  name: BOT_CREDENTIAL_TOOL_NAMESPACE,
  description: '保存或更新用户主动提供的受支持连接凭证。凭证只交给宿主使用应用本地密钥加密保存；不得把正文复述到回复、记忆、文件或后续工具参数。用户明确要求时直接执行，Bot 主动建议凭证变更时必须先取得用户同意。不代填系统密码、验证码、Face ID 或 Codex 登录密码。',
  tools: [{
    type: 'function',
    name: 'save_credential',
    description: '保存 QQ 邮箱 IMAP 授权码，或 Gmail 应用专用密码。仅在用户已在当前对话明确提供凭证并要求保存时调用。省略 connection_id 会新建连接；提供 connection_id 只更新该连接且账号必须一致。保存成功后宿主会验证连接，并在当前 Bot 唯一私聊写入不含秘密的系统提醒；不会自动授权给其他 Bot。',
    inputSchema: {
      type: 'object',
      properties: {
        connection_id: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: '可选。更新已有 QQ 或 Gmail 连接时提供当前连接目录中的 ID；新建时省略。'
        },
        provider_id: {
          type: 'string',
          enum: ['qqmail', 'gmail'],
          description: '新建连接时必填；更新时如提供必须与已有连接一致。'
        },
        display_name: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: '新建连接时必填；更新时可省略。'
        },
        email: {
          type: 'string',
          minLength: 3,
          maxLength: 320,
          description: '连接账号的完整邮箱地址。更新时必须与已有连接账号一致。'
        },
        secret: {
          type: 'string',
          minLength: 1,
          maxLength: 16384,
          description: 'QQ 邮箱填写 IMAP/SMTP 授权码；Gmail 填写 Google 应用专用密码。不要使用账号登录密码。'
        }
      },
      required: ['email'],
      additionalProperties: false
    }
  }]
} as const;

export interface NormalizedBotCredential {
  connectionId: string | null;
  providerId: 'qqmail' | 'gmail';
  displayName: string | null;
  email: string;
  payload: ConnectorCredentialPayload;
}

export class BotCredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotCredentialInputError';
  }
}

export function normalizeBotCredentialInput(
  value: unknown,
  existing: ConnectorConnection | null = null
): NormalizedBotCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BotCredentialInputError('凭证参数格式无效。');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'connection_id', 'provider_id', 'display_name', 'email', 'secret'
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new BotCredentialInputError(`不支持凭证字段：${key}`);
  }
  const email = boundedText(input.email, 320, '邮箱地址').toLocaleLowerCase();
  if (!email.includes('@')) throw new BotCredentialInputError('请输入有效的邮箱地址。');
  const connectionId = optionalText(input.connection_id, 120, '连接 ID');
  const requestedProvider = optionalText(input.provider_id, 80, '连接应用');
  const displayName = optionalText(input.display_name, 120, '连接名称');

  if (existing && connectionId !== existing.id) {
    throw new BotCredentialInputError('连接 ID 与已有连接不匹配。');
  }
  if (existing && email !== existing.accountLabel.toLocaleLowerCase()) {
    throw new BotCredentialInputError('更新凭证时邮箱账号必须与已有连接一致；不同账号请新建连接。');
  }
  const providerId = existing?.providerId ?? requestedProvider;
  if (providerId !== 'qqmail' && providerId !== 'gmail') {
    throw new BotCredentialInputError('当前只支持保存 QQ 邮箱或 Gmail 连接凭证。');
  }
  if (existing && existing.providerId !== providerId) {
    throw new BotCredentialInputError('连接应用与已有连接不一致。');
  }
  if (!existing && !displayName) {
    throw new BotCredentialInputError('新建连接时请提供连接名称。');
  }

  const credentialName = providerId === 'gmail' ? 'Gmail 应用专用密码' : 'QQ 邮箱授权码';
  const rawPassword = boundedText(input.secret, 16_384, credentialName);
  const password = providerId === 'gmail' ? rawPassword.replace(/\s+/gu, '') : rawPassword;
  if (!password) throw new BotCredentialInputError(`${credentialName}不能为空。`);
  return {
    connectionId,
    providerId,
    displayName,
    email,
    payload: { kind: 'imap-password', email, password }
  };
}

export function botCredentialNotice(
  connection: ConnectorConnection,
  action: 'saved' | 'updated'
): string {
  const provider = connection.providerId === 'qqmail' ? 'QQ 邮箱' :
    connection.providerId === 'gmail' ? 'Gmail' : connection.providerId;
  return `已${action === 'saved' ? '保存' : '更新'} ${provider}连接凭证：${connection.accountLabel}（已验证）`;
}

export function redactCredentialError(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[已隐藏]');
  }
  message = message
    .replace(
      /\b(?:access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*\S+/giu,
      '[已隐藏]'
    )
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
  return message || '连接验证失败，请检查凭证后重试。';
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BotCredentialInputError(`请提供${label}。`);
  }
  const text = value.trim();
  if (text.length > max) throw new BotCredentialInputError(`${label}超过长度限制。`);
  return text;
}

function optionalText(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new BotCredentialInputError(`${label}格式无效。`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new BotCredentialInputError(`${label}超过长度限制。`);
  return text;
}
