import type { ConnectorConnection } from '../shared/contracts';
import type {
  ConnectorCredentialPayload,
  ConnectorCredentialStore
} from './connector-credentials';

export type MailAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  partId?: string;
};

export type MailSummary = {
  id: string;
  threadId?: string;
  subject: string;
  from: string;
  to: string[];
  date: string;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
};

export type MailMessage = MailSummary & {
  cc: string[];
  text: string;
  messageId?: string;
  references?: string[];
  attachments: MailAttachment[];
};

export type MailSearchInput = {
  query?: string;
  from?: string;
  subject?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  limit?: number;
};

export type MailReplyInput = {
  id: string;
  text: string;
  html?: string;
  replyAll?: boolean;
};

export type MailSendInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
};

export type MailDraftInput = MailSendInput;

export type MailDraftResult = {
  draftId: string;
  messageId?: string;
};

export type MailAttachmentInput = {
  id: string;
  attachmentId: string;
};

export type MailAttachmentResult = {
  filename: string;
  contentType: string;
  size: number;
  dataBase64: string;
};

export type MailSendResult = {
  messageId: string;
  accepted: string[];
};

export interface MailAdapter {
  readonly providerId: string;
  /** Verifies the account credentials without changing mail state. */
  verify(connection: ConnectorConnection): Promise<void>;
  search(connection: ConnectorConnection, input: MailSearchInput): Promise<MailSummary[]>;
  read(connection: ConnectorConnection, id: string): Promise<MailMessage>;
  getAttachment(connection: ConnectorConnection, input: MailAttachmentInput): Promise<MailAttachmentResult>;
  createDraft(connection: ConnectorConnection, input: MailDraftInput): Promise<MailDraftResult>;
  reply(connection: ConnectorConnection, input: MailReplyInput): Promise<MailSendResult>;
  send(connection: ConnectorConnection, input: MailSendInput): Promise<MailSendResult>;
}

export type MailAdapterFactory = (
  connection: ConnectorConnection,
  credentials: ConnectorCredentialPayload
) => MailAdapter;

export type MailAdapterRegistry = {
  adapter(connection: ConnectorConnection): Promise<MailAdapter>;
  loadStoredCredential?(connection: ConnectorConnection): ConnectorCredentialPayload | null;
  adapterForCredential(
    connection: ConnectorConnection,
    credentials: ConnectorCredentialPayload,
    storedCredentials?: ConnectorCredentialPayload | null
  ): Promise<MailAdapter>;
};

export const MAIL_ADAPTER_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * Resolves a connection's opaque credential reference through the secure store,
 * then asks the provider-specific factory for a normalized mail adapter.
 */
export class SecureMailAdapterRegistry implements MailAdapterRegistry {
  constructor(
    private readonly credentials: ConnectorCredentialStore,
    private readonly credentialReference: (connectionId: string) => string,
    private readonly factories: Record<string, MailAdapterFactory>
  ) {}

  async adapter(connection: ConnectorConnection): Promise<MailAdapter> {
    const reference = this.credentialReference(connection.id);
    const credential = this.credentials.load(reference);
    return this.adapterForCredential(connection, credential);
  }

  async adapterForCredential(
    connection: ConnectorConnection,
    credential: ConnectorCredentialPayload,
    storedCredential?: ConnectorCredentialPayload | null
  ): Promise<MailAdapter> {
    const factory = this.factories[connection.providerId];
    if (!factory) throw new Error(`连接应用「${connection.providerId}」没有邮件适配器`);
    return factory(connection, mergeMailCredential(connection, credential, storedCredential));
  }

  loadStoredCredential(connection: ConnectorConnection): ConnectorCredentialPayload {
    return this.credentials.load(this.credentialReference(connection.id));
  }
}

function mergeMailCredential(
  connection: ConnectorConnection,
  credential: ConnectorCredentialPayload,
  storedCredential?: ConnectorCredentialPayload | null
): ConnectorCredentialPayload {
  if (connection.providerId !== 'gmail' ||
      credential.kind !== 'oauth-token' ||
      storedCredential?.kind !== 'oauth-token') {
    return credential;
  }
  return {
    ...credential,
    ...(!credential.oauthClientId && storedCredential.oauthClientId
      ? { oauthClientId: storedCredential.oauthClientId }
      : {}),
    ...(!credential.oauthClientSecret && storedCredential.oauthClientSecret
      ? { oauthClientSecret: storedCredential.oauthClientSecret }
      : {})
  };
}
