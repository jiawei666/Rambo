export const RUNTIME_PROXY_SCOPE_ORDER = ['model', 'gmail'] as const;

export type RuntimeProxyScope = (typeof RUNTIME_PROXY_SCOPE_ORDER)[number];

export type RuntimeProxySettings = {
  proxy: string;
  scopes: RuntimeProxyScope[];
};

const runtimeProxyScopeSet = new Set<string>(RUNTIME_PROXY_SCOPE_ORDER);

/** Normalizes an optional HTTP(S) proxy address and rejects unsupported URL shapes. */
export function normalizeRuntimeProxyAddress(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return '';
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('代理地址格式无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('代理地址必须使用 http:// 或 https://');
  }
  if (!url.hostname) throw new Error('代理地址缺少主机名');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('代理地址不能包含路径、参数或片段');
  }
  return url.toString();
}

export function runtimeProxyAddressIsValid(value: unknown): boolean {
  try {
    return Boolean(normalizeRuntimeProxyAddress(value));
  } catch {
    return false;
  }
}

export function normalizeRuntimeProxyScopes(value: unknown): RuntimeProxyScope[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const selected = new Set(source.map(item => String(item).trim().toLowerCase()));
  return RUNTIME_PROXY_SCOPE_ORDER.filter(scope => selected.has(scope));
}

export function runtimeProxyScopesFromInput(value: unknown): RuntimeProxyScope[] {
  if (!Array.isArray(value)) throw new Error('无效的代理适用范围');
  if (value.some(item => typeof item !== 'string' || !runtimeProxyScopeSet.has(item))) {
    throw new Error('无效的代理适用范围');
  }
  return normalizeRuntimeProxyScopes(value);
}

export function runtimeProxyScopesFromSetting(value: unknown): RuntimeProxyScope[] {
  return normalizeRuntimeProxyScopes(value);
}

export function serializeRuntimeProxyScopes(scopes: readonly RuntimeProxyScope[]): string {
  return normalizeRuntimeProxyScopes([...scopes]).join(',');
}

/** Existing non-empty proxies retain their behavior by opting into both supported scopes once. */
export function migrateRuntimeProxyScopes(proxy: unknown, storedScopes: unknown): RuntimeProxyScope[] {
  if (storedScopes !== undefined && storedScopes !== null) {
    return runtimeProxyScopesFromSetting(storedScopes);
  }
  return runtimeProxyAddressIsValid(proxy) ? ['model', 'gmail'] : [];
}
