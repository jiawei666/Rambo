import type { ConnectorConnection } from '../shared/contracts';
import type { Store } from './store';
import {
  CloakBrowserRuntime,
  type CloakBrowserProgress,
  type CloakBrowserRuntimeInfo
} from './cloakbrowser-runtime';
import { CloakBrowserMcpProxy } from './cloakbrowser-proxy';

export interface ManagedMcpProvider {
  hasAccess(botId: string): boolean;
  threadConfig(botId: string): Promise<Record<string, unknown> | null>;
  revokeBot(botId: string): void;
}

export interface CloakBrowserConnectorDeps {
  runtime?: CloakBrowserRuntime;
}

export interface CloakBrowserInstallResult {
  info: CloakBrowserRuntimeInfo;
  connection: ConnectorConnection;
}

export class CloakBrowserConnector implements ManagedMcpProvider {
  readonly runtime: CloakBrowserRuntime;
  private proxy: CloakBrowserMcpProxy | null = null;
  private proxyStart: Promise<CloakBrowserMcpProxy> | null = null;
  private installPromise: Promise<CloakBrowserInstallResult> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    userDataDirectory: string,
    deps: CloakBrowserConnectorDeps = {}
  ) {
    this.runtime = deps.runtime ?? new CloakBrowserRuntime(userDataDirectory);
  }

  activeConnection(): ConnectorConnection | null {
    return this.store.connectorConnections().find(connection =>
      connection.providerId === 'cloakbrowser' &&
      connection.status === 'ready'
    ) ?? null;
  }

  hasAccess(botId: string): boolean {
    const connection = this.activeConnection();
    return Boolean(connection && this.store.connectorGrants().some(grant =>
      grant.botId === botId && grant.connectionId === connection.id
    ));
  }

  async install(
    connectionId: string,
    displayName: string,
    onProgress: (progress: CloakBrowserProgress) => void,
    signal?: AbortSignal
  ): Promise<CloakBrowserInstallResult> {
    if (this.installPromise) throw new Error('CloakBrowser 正在安装，请等待当前安装完成。');
    if (this.store.connectorConnections().some(connection =>
      connection.providerId === 'cloakbrowser'
    )) {
      throw new Error('已存在 CloakBrowser 共享连接；请先管理或断开现有连接。');
    }
    const pending = this.installInternal(connectionId, displayName, onProgress, signal);
    this.installPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.installPromise === pending) this.installPromise = null;
    }
  }

  async threadConfig(botId: string): Promise<Record<string, unknown> | null> {
    if (!this.hasAccess(botId)) return null;
    const connection = this.activeConnection();
    if (!connection) return null;
    await this.runtime.ensureStarted();
    const proxy = await this.ensureProxy();
    const token = this.runtime.issueToken(botId);
    return {
      url: proxy.endpoint,
      http_headers: { Authorization: `Bearer ${token}` },
      enabled: true
    };
  }

  revokeBot(botId: string): void {
    this.proxy?.revokeBot(botId);
    this.runtime.revokeBot(botId);
  }

  async connectionStatusChanged(): Promise<void> {
    if (this.activeConnection()) return;
    await this.stop();
  }

  async removeConnection(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const pending = this.stopInternal();
    this.stopPromise = pending;
    try {
      await pending;
    } finally {
      if (this.stopPromise === pending) this.stopPromise = null;
    }
  }

  private async stopInternal(): Promise<void> {
    this.runtime.clearTokens();
    const proxy = this.proxy;
    this.proxy = null;
    this.proxyStart = null;
    await proxy?.stop();
    await this.runtime.stop();
  }

  private async ensureProxy(): Promise<CloakBrowserMcpProxy> {
    if (this.proxy) return this.proxy;
    if (this.proxyStart) return this.proxyStart;
    const pending = (async () => {
      const proxy = new CloakBrowserMcpProxy(this.runtime, {
        authorizeToken: token => this.runtime.botForToken(token),
        authorizeBot: botId => this.hasAccess(botId)
      });
      await proxy.start();
      this.proxy = proxy;
      return proxy;
    })();
    this.proxyStart = pending;
    try {
      return await pending;
    } finally {
      if (this.proxyStart === pending) this.proxyStart = null;
    }
  }

  private async installInternal(
    connectionId: string,
    displayName: string,
    onProgress: (progress: CloakBrowserProgress) => void,
    signal?: AbortSignal
  ): Promise<CloakBrowserInstallResult> {
    let created = false;
    try {
      const info = await this.runtime.ensureStarted(onProgress, signal);
      if (signal?.aborted) throw new Error('CloakBrowser 安装已取消。');
      const capabilities = Object.fromEntries(
        ['browser.navigate', 'browser.snapshot', 'browser.interact']
          .map(capability => [capability, 'ready' as const])
      );
      const connection = this.store.createConnectorConnection({
        id: connectionId,
        providerId: 'cloakbrowser',
        displayName: displayName.trim() || 'CloakBrowser',
        accountLabel: info.browserVersion
          ? `共享 profile · Chromium ${info.browserVersion}`
          : '共享 profile',
        authKind: 'local-install',
        credentialRef: `local:${connectionId}`,
        capabilities
      });
      created = true;
      this.store.setConnectorConnectionCapabilities(connectionId, capabilities);
      return { info, connection };
    } catch (error) {
      if (created) {
        try { this.store.deleteConnectorConnection(connectionId); } catch { /* already absent */ }
      }
      await this.stop();
      throw error;
    }
  }
}
