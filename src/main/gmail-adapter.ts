import { randomUUID } from 'node:crypto';
import type { ConnectorConnection } from '../shared/contracts';
import type { ConnectorCredentialPayload } from './connector-credentials';
import type { GmailOAuthToken } from './gmail-oauth';
import { normalizeToken } from './gmail-oauth';
import {
  type MailAdapter,
  type MailAttachmentInput,
  type MailAttachmentResult,
  type MailDraftInput,
  type MailDraftResult,
  type MailMessage,
  type MailReplyInput,
  type MailSearchInput,
  type MailSendInput,
  type MailSendResult,
  type MailSummary,
  MAIL_ADAPTER_MAX_ATTACHMENT_BYTES
} from './mail-adapter';

type GmailCredential = Extract<ConnectorCredentialPayload, { kind: 'oauth-token' }>;

type GmailAdapterDependencies = {
  fetch: typeof fetch;
  saveToken: (connectionId: string, token: ConnectorCredentialPayload) => void;
  now: () => number;
};

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_SEARCH_LIMIT = 50;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export class GmailApiAdapter implements MailAdapter {
  readonly providerId = 'gmail';
  private credential: GmailCredential;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly connection: ConnectorConnection,
    credential: ConnectorCredentialPayload,
    private readonly dependencies: Partial<GmailAdapterDependencies>
  ) {
    if (credential.kind !== 'oauth-token') throw new Error('Gmail 凭证类型无效');
    if (credential.email.toLowerCase() !== connection.accountLabel.toLowerCase()) {
      throw new Error('Gmail 凭证与连接账号不匹配');
    }
    this.credential = credential;
  }

  async verify(_connection: ConnectorConnection): Promise<void> {
    const profile = await this.api<{ emailAddress?: unknown }>('/profile');
    if (typeof profile.emailAddress !== 'string' || !profile.emailAddress.includes('@')) {
      throw new Error('Gmail 账号验证失败：Google 未返回有效邮箱');
    }
    if (profile.emailAddress.toLowerCase() !== this.connection.accountLabel.toLowerCase()) {
      throw new Error('Gmail 授权账号与连接账号不一致');
    }
  }

  async search(_connection: ConnectorConnection, input: MailSearchInput): Promise<MailSummary[]> {
    const limit = clampLimit(input.limit);
    const q = searchQuery(input);
    const response = await this.api<{ messages?: Array<{ id: string }> }>('/messages', {
      q,
      maxResults: String(limit)
    });
    const ids = (response.messages ?? []).map(message => message.id).filter(Boolean).slice(0, limit);
    const messages: MailSummary[] = [];
    for (const id of ids) {
      const full = await this.api<GmailMessage>(`/messages/${encodeURIComponent(id)}`, {
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date', 'Message-ID']
      });
      messages.push(toSummary(full));
    }
    return messages.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  }

  async read(_connection: ConnectorConnection, id: string): Promise<MailMessage> {
    const messageId = parseMailId(id);
    const message = await this.api<GmailMessage>(`/messages/${encodeURIComponent(messageId)}`, {
      format: 'full'
    });
    const headers = headerMap(message.payload?.headers);
    const attachments = collectAttachments(message.payload);
    const text = messageText(message.payload);
    return {
      id: mailId(message.id),
      ...(message.threadId ? { threadId: message.threadId } : {}),
      subject: decodeHeader(headers.get('subject')) || '(无主题)',
      from: decodeHeader(headers.get('from')),
      to: splitAddresses(headers.get('to')),
      cc: splitAddresses(headers.get('cc')),
      date: messageDate(message, headers),
      snippet: plainText(message.snippet ?? text).slice(0, 180),
      text: truncateText(plainText(text)),
      unread: Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD'),
      hasAttachments: attachments.length > 0,
      ...(headers.get('message-id') ? { messageId: headers.get('message-id') } : {}),
      ...(headers.get('references') ? { references: splitReferences(headers.get('references')!) } : {}),
      attachments
    };
  }

  async getAttachment(
    _connection: ConnectorConnection,
    input: MailAttachmentInput
  ): Promise<MailAttachmentResult> {
    const messageId = parseMailId(input.id);
    if (!input.attachmentId || input.attachmentId.length > 2_000) throw new Error('附件 ID 无效');
    const message = await this.api<GmailMessage>(`/messages/${encodeURIComponent(messageId)}`, {
      format: 'full'
    });
    const attachment = collectAttachments(message.payload)
      .find(item => item.attachmentId === input.attachmentId || item.id === input.attachmentId);
    if (!attachment?.attachmentId) throw new Error('附件不存在或没有可下载内容');
    if (attachment.size > MAIL_ADAPTER_MAX_ATTACHMENT_BYTES) throw new Error('附件超过 8 MiB 上限');
    const payload = await this.api<{ data?: unknown; size?: unknown }>(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`
    );
    if (typeof payload.data !== 'string' || !payload.data) throw new Error('Gmail 没有返回附件内容');
    const data = Buffer.from(payload.data, 'base64url');
    if (data.length > MAIL_ADAPTER_MAX_ATTACHMENT_BYTES) throw new Error('附件超过 8 MiB 上限');
    return {
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: data.length,
      dataBase64: data.toString('base64')
    };
  }

  async createDraft(_connection: ConnectorConnection, input: MailDraftInput): Promise<MailDraftResult> {
    const raw = buildRawMessage(this.connection.accountLabel, input);
    const encoded = Buffer.from(raw).toString('base64url');
    const response = await this.api<{ id?: unknown; message?: { id?: unknown } }>('/drafts', undefined, {
      method: 'POST',
      body: JSON.stringify({
        message: {
          raw: encoded,
          ...(input.threadId ? { threadId: input.threadId } : {})
        }
      })
    });
    if (typeof response.id !== 'string' || !response.id) throw new Error('Gmail 没有返回草稿 ID');
    return {
      draftId: `gmail-draft:${response.id}`,
      ...(typeof response.message?.id === 'string' && response.message.id
        ? { messageId: `gmail:${response.message.id}` }
        : {})
    };
  }

  async reply(_connection: ConnectorConnection, input: MailReplyInput): Promise<MailSendResult> {
    const original = await this.read(_connection, input.id);
    const recipients = replyRecipients(original, input.replyAll === true)
      .filter(value => value.toLowerCase() !== this.connection.accountLabel.toLowerCase());
    if (!recipients.length) throw new Error('原邮件没有可回复的发件人');
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const references = [...new Set([
      ...(original.references ?? []),
      ...(original.messageId ? [original.messageId] : [])
    ])];
    return this.send(_connection, {
      to: recipients,
      subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      ...(original.messageId ? { inReplyTo: original.messageId } : {}),
      ...(references.length ? { references } : {}),
      ...(original.threadId ? { threadId: original.threadId } : {})
    });
  }

  async send(_connection: ConnectorConnection, input: MailSendInput): Promise<MailSendResult> {
    const raw = buildRawMessage(this.connection.accountLabel, input);
    const encoded = Buffer.from(raw).toString('base64url');
    const response = await this.api<{ id?: unknown; threadId?: unknown }>('/messages/send', undefined, {
      method: 'POST',
      body: JSON.stringify({
        raw: encoded,
        ...(input.threadId ? { threadId: input.threadId } : {})
      })
    });
    return {
      messageId: typeof response.id === 'string' && response.id ? `gmail:${response.id}` : `gmail:${randomUUID()}`,
      accepted: input.to
    };
  }

  private async api<T>(
    path: string,
    query?: Record<string, string | string[]>,
    init: { method?: 'GET' | 'POST'; body?: string } = {}
  ): Promise<T> {
    await this.ensureFreshAccessToken();
    const url = new URL(`${GMAIL_API}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, value);
    }
    let response = await this.request(url, init);
    if (response.status === 401) {
      await this.refreshAccessToken(true);
      response = await this.request(url, init);
    }
    if (!response.ok) throw new Error(await apiError(response));
    try { return await response.json() as T; }
    catch { throw new Error('Gmail 返回了无法解析的数据'); }
  }

  private request(url: URL, init: { method?: 'GET' | 'POST'; body?: string }): Promise<Response> {
    return (this.dependencies.fetch ?? fetch)(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.credential.accessToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {})
      },
      ...(init.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(30_000)
    });
  }

  private async ensureFreshAccessToken(): Promise<void> {
    const expiresAt = this.credential.expiresAt ? Date.parse(this.credential.expiresAt) : Number.NaN;
    if (Number.isNaN(expiresAt) || expiresAt <= (this.dependencies.now ?? Date.now)() + TOKEN_REFRESH_SKEW_MS) {
      await this.refreshAccessToken(false);
    }
  }

  private async refreshAccessToken(force: boolean): Promise<void> {
    if (!force && this.refreshPromise) return this.refreshPromise;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private async performRefresh(): Promise<void> {
    const clientId = this.credential.oauthClientId;
    const clientSecret = this.credential.oauthClientSecret;
    if (!clientId || !clientSecret) {
      throw new Error('Gmail OAuth 客户端配置不可用，请重新连接并填写 OAuth 凭据');
    }
    if (!this.credential.refreshToken) throw new Error('Gmail 授权已过期，请重新连接');
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: this.credential.refreshToken,
      grant_type: 'refresh_token'
    });
    const response = await (this.dependencies.fetch ?? fetch)(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error('Gmail 授权已失效，请重新连接');
    let payload: any;
    try { payload = await response.json(); }
    catch { throw new Error('Gmail 刷新令牌返回格式无效'); }
    const token = normalizeToken(payload, this.dependencies.now ?? Date.now, this.credential.refreshToken);
    this.credential = toCredential(this.connection.accountLabel, token, this.credential);
    const saveToken = this.dependencies.saveToken;
    saveToken?.(this.connection.id, this.credential);
  }
}

export function gmailMailAdapterFactory(
  connection: ConnectorConnection,
  credential: ConnectorCredentialPayload,
  dependencies: Partial<GmailAdapterDependencies>
): MailAdapter {
  return new GmailApiAdapter(connection, credential, dependencies);
}

type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
};

function toCredential(email: string, token: GmailOAuthToken, previous: GmailCredential): GmailCredential {
  return {
    kind: 'oauth-token', email,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scope: token.scope,
    tokenType: token.tokenType,
    ...(previous.oauthClientId && previous.oauthClientSecret ? {
      oauthClientId: previous.oauthClientId,
      oauthClientSecret: previous.oauthClientSecret
    } : {})
  };
}

function toSummary(message: GmailMessage): MailSummary {
  const headers = headerMap(message.payload?.headers);
  const attachment = collectAttachments(message.payload);
  return {
    id: mailId(message.id),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    subject: decodeHeader(headers.get('subject')) || '(无主题)',
    from: decodeHeader(headers.get('from')),
    to: splitAddresses(headers.get('to')),
    date: messageDate(message, headers),
    snippet: plainText(message.snippet ?? '').slice(0, 180),
    unread: Array.isArray(message.labelIds) && message.labelIds.includes('UNREAD'),
    hasAttachments: attachment.length > 0
  };
}

function messageDate(message: GmailMessage, headers: Map<string, string>): string {
  const header = headers.get('date');
  const parsed = header ? Date.parse(header) : Number.NaN;
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  const internal = Number(message.internalDate);
  return new Date(Number.isFinite(internal) ? internal : Date.now()).toISOString();
}

function headerMap(headers: GmailPart['headers']): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of headers ?? []) {
    if (typeof item.name === 'string' && typeof item.value === 'string') {
      map.set(item.name.toLowerCase(), item.value);
    }
  }
  return map;
}

function collectAttachments(part: GmailPart | undefined): Array<{
  id: string; attachmentId: string; filename: string; contentType: string; size: number;
}> {
  if (!part) return [];
  const found: Array<{ id: string; attachmentId: string; filename: string; contentType: string; size: number }> = [];
  const visit = (current: GmailPart) => {
    const attachmentId = current.body?.attachmentId;
    if (attachmentId) {
      found.push({
        id: current.partId || attachmentId,
        attachmentId,
        filename: current.filename || `附件-${found.length + 1}`,
        contentType: current.mimeType || 'application/octet-stream',
        size: Number(current.body?.size ?? 0)
      });
    }
    for (const child of current.parts ?? []) visit(child);
  };
  visit(part);
  return found;
}

function messageText(part: GmailPart | undefined): string {
  if (!part) return '';
  let plain = '';
  let html = '';
  const visit = (current: GmailPart) => {
    const mime = String(current.mimeType ?? '').toLowerCase();
    if (!current.body?.attachmentId) {
      if (mime === 'text/plain' && current.body?.data) plain += decodeBody(current.body.data);
      else if (mime === 'text/html' && current.body?.data) html += decodeBody(current.body.data);
    }
    for (const child of current.parts ?? []) visit(child);
  };
  visit(part);
  if (plain.trim()) return plain;
  if (html.trim()) return stripHtml(html);
  const root = part.body?.data;
  return root ? decodeBody(root) : '';
}

function decodeBody(value: string): string {
  try { return Buffer.from(value, 'base64url').toString('utf8'); }
  catch { return ''; }
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function plainText(value: string): string {
  return value.replace(/\u00a0/gu, ' ').replace(/[ \t]+/gu, ' ').trim();
}

function truncateText(value: string): string {
  return value.length > 120_000 ? `${value.slice(0, 120_000)}\n\n[邮件正文已截断]` : value;
}

function splitAddresses(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(item => decodeHeader(item.trim())).filter(Boolean);
}

function splitReferences(value: string): string[] {
  return [...value.matchAll(/<[^<>]+>/gu)].map(match => match[0]);
}

function decodeHeader(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/gu, (_whole, charset, encoding, encoded) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? Buffer.from(String(encoded), 'base64')
        : Buffer.from(String(encoded).replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_match, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16))), 'binary');
      return bytes.toString(String(charset).toLowerCase() === 'utf-8' ? 'utf8' : 'latin1');
    } catch { return _whole; }
  }).replace(/\?=\s+=\?/gu, '?==?');
}

function searchQuery(input: MailSearchInput): string {
  const terms: string[] = [];
  if (input.query?.trim()) terms.push(input.query.trim());
  if (input.from?.trim()) terms.push(`from:${quoteGmail(input.from.trim())}`);
  if (input.subject?.trim()) terms.push(`subject:${quoteGmail(input.subject.trim())}`);
  if (input.since) terms.push(`after:${gmailDate(input.since, 'since')}`);
  if (input.before) terms.push(`before:${gmailDate(input.before, 'before')}`);
  if (input.unreadOnly) terms.push('is:unread');
  return terms.join(' ');
}

function quoteGmail(value: string): string {
  return /[\s:()]/u.test(value) ? `"${value.replace(/["\\]/gu, '\\$&')}"` : value;
}

function gmailDate(value: string, field: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf())) throw new Error(`${field} 日期无效`);
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
}

function parseMailId(value: string): string {
  if (!/^gmail:[A-Za-z0-9_-]{1,200}$/u.test(value)) throw new Error('邮件 ID 无效');
  return value.slice('gmail:'.length);
}

function mailId(value: string): string { return `gmail:${value}`; }

function clampLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SEARCH_LIMIT) {
    throw new Error(`邮件数量必须是 1–${MAX_SEARCH_LIMIT} 的整数`);
  }
  return value;
}

function replyRecipients(original: MailMessage, all: boolean): string[] {
  const values = all ? [original.from, ...original.to, ...original.cc] : [original.from];
  const seen = new Set<string>();
  return values.map(bareAddress).filter(Boolean).filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function bareAddress(value: string): string {
  const match = value.match(/<([^<>]+)>/u);
  return (match?.[1] ?? value).trim();
}

function buildRawMessage(from: string, input: MailSendInput): string {
  const lines = [
    `From: ${from}`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references?.length ? [`References: ${input.references.join(' ')}`] : [])
  ];
  if (input.html) {
    const boundary = `rambo-${randomUUID()}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '', `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      wrapBase64(Buffer.from(input.text, 'utf8').toString('base64')), `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      wrapBase64(Buffer.from(input.html, 'utf8').toString('base64')), `--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      wrapBase64(Buffer.from(input.text, 'utf8').toString('base64')));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/u.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/gu)?.join('\r\n') ?? '';
}

async function apiError(response: Response): Promise<string> {
  let detail = '';
  try {
    const payload: any = await response.json();
    const message = payload?.error?.message ?? payload?.error;
    if (typeof message === 'string') detail = message.slice(0, 160);
  } catch { /* no response body */ }
  if (response.status === 401) return 'Gmail 授权已失效，请重新连接';
  if (response.status === 403) return `Gmail 拒绝了本次操作${detail ? `：${detail}` : ''}`;
  if (response.status === 404) return 'Gmail 邮件或附件不存在';
  return `Gmail 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`;
}

export type { GmailPart };
