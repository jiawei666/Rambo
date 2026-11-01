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

export async function mailProxyUrlForHost(
  host: string,
  port: number,
  resolveProxy: (url: string) => Promise<string>
): Promise<string | null> {
  return mailProxyUrlFromResolution(await resolveProxy(`https://${host}:${port}`));
}
