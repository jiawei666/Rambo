import type { ConnectorConnection } from '../shared/contracts';
import type { ConnectorCredentialPayload } from './connector-credentials';
import type { MailAdapter } from './mail-adapter';
import {
  GMAIL_MAIL_CONFIG,
  ImapSmtpMailAdapter,
  type ImapSmtpMailAdapterDependencies
} from './imap-smtp-mail-adapter';

export class GmailImapAdapter extends ImapSmtpMailAdapter {
  constructor(
    connection: ConnectorConnection,
    credential: ConnectorCredentialPayload,
    dependencies: ImapSmtpMailAdapterDependencies = {}
  ) {
    super(connection, credential, GMAIL_MAIL_CONFIG, dependencies);
  }
}

export function gmailImapAdapterFactory(
  connection: ConnectorConnection,
  credential: ConnectorCredentialPayload
): MailAdapter {
  return new GmailImapAdapter(connection, credential);
}
