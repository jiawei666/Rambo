import { randomUUID } from 'node:crypto';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createTransport } from 'nodemailer';
import type { ConnectorConnection } from '../shared/contracts';
import type { ConnectorCredentialPayload } from './connector-credentials';
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

type QQCredential = Extract<ConnectorCredentialPayload, { kind: 'imap-password' }>;

const QQ_IMAP = { host: 'imap.qq.com', port: 993, secure: true } as const;
const QQ_SMTP = { host: 'smtp.qq.com', port: 465, secure: true } as const;
const MAILBOX = 'INBOX';
const MAX_SEARCH_LIMIT = 50;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class QQMailAdapter implements MailAdapter {
  readonly providerId = 'qqmail';
  private readonly credential: QQCredential;

  constructor(
    connection: ConnectorConnection,
    credential: ConnectorCredentialPayload,
    private readonly dependencies: {
      imapClient?: (config: ImapFlowOptions) => ImapFlow;
    } = {}
  ) {
    if (credential.kind !== 'imap-password' || credential.email.toLowerCase() !== connection.accountLabel.toLowerCase()) {
      throw new Error('QQ 邮箱凭证与连接账号不匹配');
    }
    this.credential = credential;
  }

  async verify(_connection: ConnectorConnection): Promise<void> {
    await this.withImap(client => client.noop());
    const transport = this.transport();
    try { await transport.verify(); }
    finally { transport.close(); }
  }

  async search(_connection: ConnectorConnection, input: MailSearchInput): Promise<MailSummary[]> {
    const limit = clampLimit(input.limit);
    return this.withImap(async client => {
      const lock = await client.getMailboxLock(MAILBOX);
      try {
        const query = this.searchQuery(input);
        const sequence = await client.search(query, { uid: true });
        if (!Array.isArray(sequence) || !sequence.length) return [];
        const uids = sequence.slice(-limit);
        const summaries: MailSummary[] = [];
        for await (const message of client.fetch(uids, {
          uid: true, envelope: true, internalDate: true, flags: true, bodyStructure: true,
          bodyParts: ['1']
        }, { uid: true })) {
          summaries.push(toSummary(message, previewText(message.bodyParts?.get('1'))));
        }
        return summaries.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      } finally { lock.release(); }
    });
  }

  async read(_connection: ConnectorConnection, id: string): Promise<MailMessage> {
    const uid = parseMailId(id);
    return this.withImap(async client => {
      const lock = await client.getMailboxLock(MAILBOX);
      try {
        const source = await client.download(String(uid), undefined, { uid: true, maxBytes: MAX_BODY_BYTES });
        if (!source.content) throw new Error('邮件不存在或已被删除');
        const parsed = await simpleParser(source.content, {
          skipHtmlToText: true,
          skipTextToHtml: true,
          maxHeadSize: 1024 * 1024
        });
        const flags = await client.fetchOne(String(uid), { flags: true }, { uid: true });
        return {
          id: mailId(uid),
          subject: parsed.subject || '(无主题)',
          from: formatAddress(parsed.from),
          to: addressList(parsed.to),
          cc: addressList(parsed.cc),
          date: (parsed.date ?? new Date()).toISOString(),
          snippet: snippet(parsed.text || ''),
          text: truncateText(parsed.text || htmlAsText(parsed.html) || ''),
          unread: flags ? !(flags.flags instanceof Set) || !flags.flags.has('\\Seen') : true,
          hasAttachments: parsed.attachments.length > 0,
          messageId: parsed.messageId,
          references: parsed.references
            ? Array.isArray(parsed.references) ? parsed.references : [parsed.references]
            : undefined,
          attachments: parsed.attachments.map((attachment, index) => ({
            id: attachment.partId || String(index),
            filename: attachment.filename || `附件-${index + 1}`,
            contentType: attachment.contentType || 'application/octet-stream',
            size: attachment.size ?? attachment.content.length,
            ...(attachment.partId ? { partId: attachment.partId } : {})
          }))
        };
      } finally { lock.release(); }
    });
  }

  async getAttachment(_connection: ConnectorConnection, input: MailAttachmentInput): Promise<MailAttachmentResult> {
    const uid = parseMailId(input.id);
    return this.withImap(async client => {
      const lock = await client.getMailboxLock(MAILBOX);
      try {
        const download = await client.download(String(uid), input.attachmentId, {
          uid: true, maxBytes: MAIL_ADAPTER_MAX_ATTACHMENT_BYTES
        });
        if (!download.content) throw new Error('附件不存在或超过允许大小');
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of download.content) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += data.length;
          if (total > MAIL_ADAPTER_MAX_ATTACHMENT_BYTES) throw new Error('附件超过 8 MiB 上限');
          chunks.push(data);
        }
        return {
          filename: download.meta.filename || '附件',
          contentType: download.meta.contentType || 'application/octet-stream',
          size: total,
          dataBase64: Buffer.concat(chunks).toString('base64')
        };
      } finally { lock.release(); }
    });
  }

  async createDraft(_connection: ConnectorConnection, input: MailDraftInput): Promise<MailDraftResult> {
    const message = await createTransport({ streamTransport: true, buffer: true })
      .sendMail(this.outgoingMessage(input));
    const raw = Buffer.isBuffer(message.message) ? message.message : Buffer.from(message.message as any);
    return this.withImap(async client => {
      const lock = await client.getMailboxLock('Drafts');
      try {
        const result = await client.append('Drafts', raw, ['\\Draft']);
        if (!result) throw new Error('QQ 邮箱没有确认草稿保存结果');
        const draftId = Number((result as { uid?: unknown }).uid);
        if (!Number.isSafeInteger(draftId) || draftId < 1) {
          throw new Error('QQ 邮箱没有返回草稿 UID');
        }
        return { draftId: `qq-draft:${draftId}` };
      } finally { lock.release(); }
    });
  }

  async reply(_connection: ConnectorConnection, input: MailReplyInput): Promise<MailSendResult> {
    const original = await this.read(_connection, input.id);
    const recipients = replyRecipients(original, input.replyAll === true);
    if (!recipients.length) throw new Error('原邮件没有可回复的发件人');
    return this.send(_connection, {
      to: recipients,
      subject: /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`,
      text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(original.threadId ? { threadId: original.threadId } : {})
    }, original);
  }

  async send(
    _connection: ConnectorConnection,
    input: MailSendInput,
    original?: MailMessage
  ): Promise<MailSendResult> {
    const transport = this.transport();
    try {
      const info = await transport.sendMail({
        from: this.credential.email,
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        ...(input.bcc?.length ? { bcc: input.bcc } : {}),
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : original?.messageId ? { inReplyTo: original.messageId } : {}),
        ...(input.references?.length ? { references: input.references } : original?.references?.length ? { references: original.references } : {})
      });
      return {
        messageId: info.messageId || `smtp:${randomUUID()}`,
        accepted: Array.isArray(info.accepted)
          ? info.accepted.map(value => typeof value === 'string' ? value : String(value))
          : input.to
      };
    } catch (error) {
      throw new Error(`QQ 邮件发送失败：${safeMailError(error)}`);
    } finally { transport.close(); }
  }

  private searchQuery(input: MailSearchInput): Record<string, unknown> {
    const query: Record<string, unknown> = {};
    if (input.query?.trim()) query.text = input.query.trim();
    if (input.from?.trim()) query.from = input.from.trim();
    if (input.subject?.trim()) query.subject = input.subject.trim();
    if (input.since) query.since = validDate(input.since, 'since');
    if (input.before) query.before = validDate(input.before, 'before');
    if (input.unreadOnly) query.seen = false;
    return query;
  }

  private transport() {
    return createTransport({
      host: QQ_SMTP.host,
      port: QQ_SMTP.port,
      secure: QQ_SMTP.secure,
      auth: { user: this.credential.email, pass: this.credential.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000
    });
  }

  private outgoingMessage(input: MailSendInput) {
    return {
      from: this.credential.email,
      to: input.to,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      ...(input.bcc?.length ? { bcc: input.bcc } : {}),
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references?.length ? { references: input.references } : {})
    };
  }

  private async withImap<T>(run: (client: ImapFlow) => Promise<T>): Promise<T> {
    const config: ImapFlowOptions = {
      ...QQ_IMAP,
      auth: { user: this.credential.email, pass: this.credential.password },
      logger: false,
      clientInfo: { name: 'Rambo', version: '0.1.0' },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000
    };
    const client = this.dependencies.imapClient
      ? this.dependencies.imapClient(config)
      : new ImapFlow(config);
    try {
      await client.connect();
      return await run(client);
    } catch (error) {
      throw new Error(`QQ 邮箱连接失败：${safeMailError(error)}`);
    } finally {
      try { await client.logout(); } catch { /* socket may already be closed */ }
    }
  }
}

export function qqMailAdapterFactory(
  connection: ConnectorConnection,
  credential: ConnectorCredentialPayload
): MailAdapter {
  return new QQMailAdapter(connection, credential);
}

function parseMailId(value: string): number {
  if (!/^qq:[1-9]\d{0,15}$/.test(value)) throw new Error('邮件 ID 无效');
  const uid = Number(value.slice(3));
  if (!Number.isSafeInteger(uid)) throw new Error('邮件 ID 无效');
  return uid;
}

function mailId(uid: number): string { return `qq:${uid}`; }
function clampLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SEARCH_LIMIT) {
    throw new Error(`邮件数量必须是 1–${MAX_SEARCH_LIMIT} 的整数`);
  }
  return value;
}

function validDate(value: string, field: string): Date {
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf())) throw new Error(`${field} 日期无效`);
  return date;
}

function toSummary(message: any, preview: string): MailSummary {
  const envelope = message.envelope ?? {};
  const flags = message.flags instanceof Set ? message.flags : new Set<string>();
  return {
    id: mailId(message.uid),
    subject: envelope.subject || '(无主题)',
    from: formatAddress(envelope.from?.[0]),
    to: (envelope.to ?? []).map(formatAddress).filter(Boolean),
    date: new Date(message.internalDate ?? envelope.date ?? Date.now()).toISOString(),
    snippet: snippet(preview),
    unread: !flags.has('\\Seen'),
    hasAttachments: hasAttachments(message.bodyStructure)
  };
}

function hasAttachments(structure: any): boolean {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  return Array.isArray(structure.childNodes) && structure.childNodes.some(hasAttachments);
}

function formatAddress(address: any): string {
  if (!address) return '';
  if (typeof address === 'string') return address;
  const name = address.name ? String(address.name).trim() : '';
  const value = address.address ? String(address.address).trim() : '';
  return name && value ? `${name} <${value}>` : value || name;
}

function addressList(address: any): string[] {
  if (!address) return [];
  const values = Array.isArray(address.value) ? address.value : [];
  return values.map(formatAddress).filter(Boolean);
}

function replyRecipients(original: MailMessage, all: boolean): string[] {
  if (!all) return original.from ? [bareAddress(original.from)] : [];
  const seen = new Set<string>();
  return [original.from, ...original.to, ...original.cc]
    .filter(Boolean)
    .map(bareAddress)
    .filter(value => {
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

function previewText(value: unknown): string {
  if (!value) return '';
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
  return data.toString('utf8').replace(/\s+/gu, ' ').trim().slice(0, 500);
}

function snippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function truncateText(value: string): string {
  const max = 120_000;
  return value.length > max ? `${value.slice(0, max)}\n\n[邮件正文已截断]` : value;
}

function htmlAsText(value: string | false | undefined): string {
  if (!value) return '';
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function safeMailError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/AUTHENTICATIONFAILED[^\n]*/i, '授权码或账号验证失败')
    .replace(/LOGIN failed[^\n]*/i, '授权码或账号验证失败')
    .slice(0, 300);
}
