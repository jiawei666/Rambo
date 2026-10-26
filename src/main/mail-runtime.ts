import type { ConnectorConnection } from '../shared/contracts';
import {
  type MailAdapterRegistry,
  type MailAdapter
} from './mail-adapter';
import type { ConnectorCredentialPayload } from './connector-credentials';

/**
 * Keeps one in-flight adapter per connection. Adapters open short-lived IMAP/SMTP
 * sessions, so concurrent calls are limited rather than sharing sockets.
 */
export class MailRuntime {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly adaptersByConnection = new Map<string, Promise<MailAdapter>>();

  constructor(private readonly adapters: MailAdapterRegistry) {}

  invalidate(connectionId: string): void {
    this.adaptersByConnection.delete(connectionId);
  }

  async withAdapter<T>(
    connection: ConnectorConnection,
    run: (adapter: MailAdapter) => Promise<T>
  ): Promise<T> {
    return this.runWithAdapter(connection, null, run);
  }

  async withCredentialAdapter<T>(
    connection: ConnectorConnection,
    credential: ConnectorCredentialPayload,
    run: (adapter: MailAdapter) => Promise<T>
  ): Promise<T> {
    return this.runWithAdapter(connection, credential, run);
  }

  private async runWithAdapter<T>(
    connection: ConnectorConnection,
    credential: ConnectorCredentialPayload | null,
    run: (adapter: MailAdapter) => Promise<T>
  ): Promise<T> {
    const previous = this.queues.get(connection.id);
    if (previous) await previous.catch(() => {});
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = Promise.resolve().then(() => current);
    this.queues.set(connection.id, queued);
    try {
      let pending = this.adaptersByConnection.get(connection.id);
      if (!pending) {
        // A caller-supplied credential is always ephemeral: validate it without
        // placing an adapter backed by the uncommitted secret into the cache.
        const adapter = credential
          ? await this.adapters.adapterForCredential(
              connection,
              credential,
              this.adapters.loadStoredCredential?.(connection)
            )
          : await this.adapters.adapter(connection);
        if (credential) return await run(adapter);
        pending = Promise.resolve(adapter);
        this.adaptersByConnection.set(connection.id, pending);
      }
      let adapter: MailAdapter;
      try { adapter = await pending; }
      catch (error) {
        this.adaptersByConnection.delete(connection.id);
        throw error;
      }
      return await run(adapter);
    } finally {
      release();
      if (this.queues.get(connection.id) === queued) this.queues.delete(connection.id);
    }
  }
}
