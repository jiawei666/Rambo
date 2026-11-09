import { normalizeRuntimeProxyAddress } from '../shared/proxy-settings';

export type MailProxyResolver = (host: string, port: number) => Promise<string | null>;

/**
 * Converts Chromium's PAC result into a URL understood by ImapFlow and Nodemailer.
 * Electron returns entries in preference order, separated by semicolons.
 */
export function mailProxyUrlFromResolution(value: string): string | null {
  for (const entry of value.split(';')) {
    const [kindValue, endpoint] = entry.trim().split(/\s+/, 2);
    const kind = kindValue?.toUpperCase();
    if (!endpoint || kind === 'DIRECT') continue;
    const scheme = kind === 'PROXY' || kind === 'HTTP'
      ? 'http'
      : kind === 'HTTPS'
        ? 'https'
        : kind === 'SOCKS' || kind === 'SOCKS5'
          ? 'socks5'
          : kind === 'SOCKS4'
            ? 'socks4'
            : null;
    if (!scheme) continue;
    try {
      const url = new URL(`${scheme}://${endpoint}`);
      if (url.hostname && url.port) return url.toString();
    } catch {
      // Try the next proxy entry when a PAC provider returns a malformed endpoint.
    }
  }
  return null;
}

/** Validates the app-level HTTP(S) proxy before using it for an enabled scope. */
export function mailProxyUrlFromSetting(value: string | null | undefined): string | null {
  try {
    return normalizeRuntimeProxyAddress(value) || null;
  } catch {
    // Invalid persisted settings must not prevent direct mail connections.
  }
  return null;
}

export async function mailProxyUrlForHost(
  host: string,
  port: number,
  resolveProxy: (url: string) => Promise<string>,
  appProxy?: {
    enabled: boolean;
    value: string | null | undefined;
    label?: string;
  }
): Promise<string | null> {
  if (appProxy?.enabled) {
    const proxy = mailProxyUrlFromSetting(appProxy.value);
    if (!proxy) {
      throw new Error(`${appProxy.label ?? '邮件'}已启用应用代理，但代理地址为空或格式无效`);
    }
    return proxy;
  }
  const systemProxy = mailProxyUrlFromResolution(await resolveProxy(`https://${host}:${port}`));
  return systemProxy;
}
