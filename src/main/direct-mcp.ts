import { randomUUID } from 'node:crypto';
import type { ConnectorCredentialStore } from './connector-credentials';
import type { Store } from './store';

export interface DirectMcpDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  credentialRef: string | null;
  headerKeys: string[];
  envKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DirectMcpInput {
  name: unknown;
  description?: unknown;
  enabled?: unknown;
  transport: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  url?: unknown;
  headers?: unknown;
  env?: unknown;
}

export class DirectMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectMcpError';
  }
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new DirectMcpError('MCP 名称格式无效。');
  const name = value.trim();
  if (!name || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
    throw new DirectMcpError('MCP 名称只能包含字母、数字、点、下划线和短横线，且最长 100 个字符。');
  }
  return name;
}

function optionalText(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) {
    throw new DirectMcpError(`${label}格式无效。`);
  }
  return value.trim() || null;
}

function stringArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100 ||
      value.some(item => typeof item !== 'string' || item.includes('\0') || item.length > 4_096)) {
    throw new DirectMcpError('MCP 参数必须是字符串数组，最多 100 项。');
  }
  return value as string[];
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DirectMcpError(`${label}必须是键值对象。`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/u.test(key) ||
        typeof item !== 'string' || item.includes('\0') || item.length > 65_536) {
      throw new DirectMcpError(`${label}字段格式无效。`);
    }
    result[key] = item;
  }
  return result;
}

function safeHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DirectMcpError('HTTP MCP 必须提供 URL。');
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new DirectMcpError('MCP URL 格式无效。'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DirectMcpError('MCP URL 只支持 http 或 https。');
  }
  if (url.username || url.password) throw new DirectMcpError('请勿在 MCP URL 中嵌入凭证。');
  return url.toString();
}

export function normalizeDirectMcpInput(input: DirectMcpInput): {
  name: string;
  description: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  headers: Record<string, string>;
  env: Record<string, string>;
} {
  const name = cleanName(input.name);
  const description = optionalText(input.description, 240, 'MCP 说明') ?? '';
  const enabled = input.enabled === undefined ? false : input.enabled;
  if (typeof enabled !== 'boolean') throw new DirectMcpError('MCP 启用状态必须是布尔值。');
  if (input.transport !== 'stdio' && input.transport !== 'http') {
    throw new DirectMcpError('MCP transport 只支持 stdio 或 http。');
  }
  const headers = stringRecord(input.headers, 'MCP headers');
  const env = stringRecord(input.env, 'MCP 环境变量');
  if (input.transport === 'stdio') {
    if (headers && Object.keys(headers).length) throw new DirectMcpError('stdio MCP 不接受 headers。');
    const command = optionalText(input.command, 4_096, 'MCP 命令');
    if (!command) throw new DirectMcpError('stdio MCP 必须提供 command。');
    return {
      name,
      description,
      enabled,
      transport: 'stdio',
      command,
      args: stringArgs(input.args),
      cwd: optionalText(input.cwd, 4_096, 'MCP 工作目录'),
      url: null,
      headers: {},
      env
    };
  }
  if (input.command !== undefined || input.args !== undefined || input.cwd !== undefined ||
      Object.keys(env).length) {
    throw new DirectMcpError('http MCP 不接受 command、args、cwd 或 env。');
  }
  return {
    name,
    description,
    enabled,
    transport: 'http',
    command: null,
    args: [],
    cwd: null,
    url: safeHttpUrl(input.url),
    headers,
    env: {}
  };
}

export class DirectMcpRegistry {
  constructor(
    readonly store: Store,
    readonly credentials: ConnectorCredentialStore | undefined
  ) {}

  list(): DirectMcpDefinition[] {
    return this.store.directMcpServers();
  }

  get(id: string): DirectMcpDefinition | null {
    return this.store.directMcpServer(id);
  }

  findByName(name: string): DirectMcpDefinition | null {
    const normalized = name.toLocaleLowerCase();
    return this.list().find(item => item.name.toLocaleLowerCase() === normalized) ?? null;
  }

  add(input: DirectMcpInput): DirectMcpDefinition {
    const normalized = normalizeDirectMcpInput(input);
    if (this.findByName(normalized.name)) throw new DirectMcpError('已有同名 MCP Server。');
    if (!this.credentials && (Object.keys(normalized.headers).length || Object.keys(normalized.env).length)) {
      throw new DirectMcpError('本机凭证存储不可用，未保存 MCP 凭证。');
    }
    let credentialRef: string | null = null;
    if (Object.keys(normalized.headers).length > 0 || Object.keys(normalized.env).length > 0) {
      credentialRef = this.credentials!.save(randomUUID(), {
        kind: 'mcp-secrets',
        serverName: normalized.name,
        headers: normalized.headers,
        env: normalized.env
      });
    }
    try {
      return this.store.createDirectMcpServer({
        ...normalized,
        credentialRef
      });
    } catch (error) {
      if (credentialRef) this.credentials?.delete(credentialRef);
      throw error;
    }
  }

  update(id: string, input: DirectMcpInput): DirectMcpDefinition {
    const current = this.get(id);
    if (!current) throw new DirectMcpError('MCP Server 不存在。');
    const normalized = normalizeDirectMcpInput(input);
    const duplicate = this.findByName(normalized.name);
    if (duplicate && duplicate.id !== id) throw new DirectMcpError('已有同名 MCP Server。');
    const providedHeaders = input.headers !== undefined;
    const providedEnv = input.env !== undefined;
    const hasSecrets = Object.keys(normalized.headers).length > 0 || Object.keys(normalized.env).length > 0;
    let nextRef = current.credentialRef;
    if (hasSecrets && !this.credentials) {
      throw new DirectMcpError('本机凭证存储不可用，未保存 MCP 凭证。');
    }
    const previous = current.credentialRef && this.credentials
      ? this.credentials.load(current.credentialRef)
      : null;
    const nextHeaders = providedHeaders
      ? normalized.headers
      : previous?.kind === 'mcp-secrets' ? previous.headers : {};
    const nextEnv = providedEnv
      ? normalized.env
      : previous?.kind === 'mcp-secrets' ? previous.env : {};
    if (Object.keys(nextHeaders).length > 0 || Object.keys(nextEnv).length > 0) {
      const payload = {
        kind: 'mcp-secrets' as const,
        serverName: normalized.name,
        headers: nextHeaders,
        env: nextEnv
      };
      if (nextRef) this.credentials!.replace(nextRef, payload);
      else nextRef = this.credentials!.save(randomUUID(), payload);
    } else if (nextRef) {
      this.credentials?.delete(nextRef);
      nextRef = null;
    }
    try {
      return this.store.updateDirectMcpServer(id, {
        ...normalized,
        headers: nextHeaders,
        env: nextEnv,
        credentialRef: nextRef
      });
    } catch (error) {
      throw error;
    }
  }

  setEnabled(id: string, enabled: boolean): DirectMcpDefinition {
    const current = this.get(id);
    if (!current) throw new DirectMcpError('MCP Server 不存在。');
    return this.store.updateDirectMcpServer(id, {
      name: current.name,
      description: current.description,
      enabled,
      transport: current.transport,
      command: current.command,
      args: current.args,
      cwd: current.cwd,
      url: current.url,
      credentialRef: current.credentialRef,
      // Omit secret fields so the stored credential remains untouched.
      headers: undefined,
      env: undefined
    });
  }

  remove(id: string): void {
    const current = this.get(id);
    if (!current) throw new DirectMcpError('MCP Server 不存在。');
    this.store.deleteDirectMcpServer(id);
    if (current.credentialRef) this.credentials?.delete(current.credentialRef);
  }

  runtimeConfig(definitions: readonly DirectMcpDefinition[]): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const definition of definitions) {
      const secrets = definition.credentialRef && this.credentials
        ? this.credentials.load(definition.credentialRef)
        : null;
      if (secrets && secrets.kind !== 'mcp-secrets') {
        throw new DirectMcpError('MCP 凭证类型不匹配，请重新保存。');
      }
      const headers = secrets?.kind === 'mcp-secrets' ? secrets.headers : {};
      const env = secrets?.kind === 'mcp-secrets' ? secrets.env : {};
      result[definition.name] = definition.transport === 'stdio'
        ? {
            command: definition.command,
            ...(definition.args.length ? { args: definition.args } : {}),
            ...(definition.cwd ? { cwd: definition.cwd } : {}),
            ...(Object.keys(env).length ? { env } : {}),
            enabled: true
          }
        : {
            url: definition.url,
            ...(Object.keys(headers).length ? { http_headers: headers } : {}),
            enabled: true
          };
    }
    return result;
  }
}
