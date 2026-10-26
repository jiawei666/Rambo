import type { ConnectorConnection } from '../shared/contracts';
import type { ConnectorCredentialPayload } from './connector-credentials';
import type { MailAdapter } from './mail-adapter';
import {
  ImapSmtpMailAdapter,
  QQ_MAIL_CONFIG,
  type ImapSmtpMailAdapterDependencies
} from './imap-smtp-mail-adapter';

export class QQMailAdapter extends ImapSmtpMailAdapter {
  constructor(
    connection: ConnectorConnection,
    credential: ConnectorCredentialPayload,
    dependencies: ImapSmtpMailAdapterDependencies = {}
  ) {
    super(connection, credential, QQ_MAIL_CONFIG, dependencies);
  }
}

export function qqMailAdapterFactory(
  connection: ConnectorConnection,
  credential: ConnectorCredentialPayload
): MailAdapter {
  return new QQMailAdapter(connection, credential);
}
