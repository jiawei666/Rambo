import type { Session } from 'electron';
import type { RuntimeProxyScope } from '../shared/contracts';
import { normalizeRuntimeProxyAddress } from '../shared/proxy-settings';

export type ScopedProxySettings = {
  proxy: string;
  scopes: RuntimeProxyScope[];
};

type SessionFactory = (scope: RuntimeProxyScope) => Session;

const LOOPBACK_BYPASS_RULES = '127.0.0.1,localhost,::1';

/**
 * Uses Electron sessions so HTTP(S) calls honor either the OS proxy or an
 * explicitly selected app proxy. Node's global fetch does not read the system
 * proxy configuration on its own.
 */
export class ScopedProxyFetch {
  private readonly sessions = new Map<RuntimeProxyScope, Session>();
  private readonly configuredProxy = new Map<RuntimeProxyScope, string>();
  private readonly configuring = new Map<RuntimeProxyScope, Promise<void>>();

  constructor(
    private readonly defaultSession: Session,
    private readonly createSession: SessionFactory,
    private readonly settings: () => ScopedProxySettings
  ) {}

  fetchFor(scope: RuntimeProxyScope): typeof fetch {
    return (input, init) => this.request(scope, input, init);
  }

  private async request(
    scope: RuntimeProxyScope,
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const target = input instanceof URL ? input.toString() : input;
    const current = this.settings();
    if (!current.scopes.includes(scope)) {
      return this.defaultSession.fetch(target, init) as Promise<Response>;
    }
    let proxy: string;
    try {
      proxy = normalizeRuntimeProxyAddress(current.proxy);
    } catch (error) {
      throw new Error(`${scopeLabel(scope)}代理地址无效：${
        error instanceof Error ? error.message : String(error)
      }`);
    }
    if (!proxy) throw new Error(`${scopeLabel(scope)}已启用应用代理，但代理地址为空`);
    const activeSession = await this.sessionFor(scope, proxy);
    return activeSession.fetch(target, init) as Promise<Response>;
  }

  private async sessionFor(scope: RuntimeProxyScope, proxy: string): Promise<Session> {
    let activeSession = this.sessions.get(scope);
    if (!activeSession) {
      activeSession = this.createSession(scope);
      this.sessions.set(scope, activeSession);
    }
    if (this.configuredProxy.get(scope) === proxy) return activeSession;

    const previous = this.configuring.get(scope) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (this.configuredProxy.get(scope) === proxy) return;
      await activeSession!.setProxy({
        mode: 'fixed_servers',
        proxyRules: proxy,
        proxyBypassRules: LOOPBACK_BYPASS_RULES
      });
      this.configuredProxy.set(scope, proxy);
    });
    this.configuring.set(scope, current);
    try {
      await current;
      return activeSession;
    } catch (error) {
      throw new Error(`${scopeLabel(scope)}代理设置失败：${
        error instanceof Error ? error.message : String(error)
      }`);
    } finally {
      if (this.configuring.get(scope) === current) this.configuring.delete(scope);
    }
  }
}

function scopeLabel(scope: RuntimeProxyScope): string {
  return scope === 'gmail' ? 'Gmail' : '大模型';
}
