import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { BotResource } from '../shared/contracts';

export interface BotResourceDiscovery {
  resources: BotResource[];
  errors: string[];
}

/**
 * Metadata extracted from Codex `config/read`. Callers must pass only the
 * server name and optional display description; the server configuration is
 * deliberately not part of the discovery input.
 */
export interface KnownMcpServer {
  name: string;
  description?: string;
}

const DEFAULT_SKILLS = [
  ['documents', '处理 Word 和 Google Docs 文档。'],
  ['pdf', '读取、创建、检查和渲染 PDF。'],
  ['spreadsheets', '创建、修改、分析电子表格。'],
  ['presentations', '创建和编辑演示文稿。'],
  ['visualize', '在对话中创建可视化和交互工具。'],
  ['imagegen', '生成或编辑位图图片。'],
  ['openai-docs', '查询 OpenAI 与 Codex 官方资料。'],
  ['skill-creator', '创建和更新 Codex Skill。'],
  ['ui-ux-pro-max', 'UI/UX 设计、审查与实现。'],
  ['code-review', '审查代码质量与需求一致性。'],
  ['codebase-design', '设计模块边界和可测试接口。'],
  ['diagnosing-bugs', '诊断困难缺陷和性能回归。'],
  ['domain-modeling', '梳理项目术语和领域模型。'],
  ['prototype', '构建验证设计问题的原型。'],
  ['research', '使用高可信一手来源研究问题。'],
  ['tdd', '以测试驱动开发和修复。'],
  ['wizard', '生成需要人工执行的交互式配置向导。'],
  ['writing-for-agents', '编写面向 Agent 的说明和 Skill。'],
  ['resolving-merge-conflicts', '处理进行中的合并或变基冲突。'],
  ['reverse-engineer-anything', '分析本机二进制、包或运行产物。']
] as const;

export interface BotResourceDiscoveryOptions {
  /** Override the account home. Intended for tests and isolated discovery. */
  home?: string;
  /** Override individual roots while retaining the standard source labels. */
  skillRoots?: Array<{ path: string; source: string; bundled?: boolean }>;
  /** Rambo-owned imported Skills. They must stay separate from the linked native Codex Skills root. */
  managedSkillRoots?: Array<{ path: string; source: string; bundled?: boolean }>;
  pluginRoot?: string;
  /**
   * MCP metadata from Codex `config/read`. A record form is accepted for
   * direct handoff from `config.mcp_servers`; only each key and an optional
   * `description` field are inspected.
   */
  mcpServers?: ReadonlyArray<KnownMcpServer> | Readonly<Record<string, unknown>>;
  /** Alias for callers that want to make the metadata-only boundary explicit. */
  knownMcpServers?: ReadonlyArray<KnownMcpServer> | Readonly<Record<string, unknown>>;
  directMcpServers?: ReadonlyArray<KnownMcpServer>;
}

function accountHome(): string {
  return process.env.HOME || homedir();
}

function resourceRoots(home: string): Array<{ path: string; source: string; bundled?: boolean }> {
  return [
    { path: join(home, '.codex', 'skills'), source: 'Codex Skills' },
    { path: join(home, '.agents', 'skills'), source: 'Agent Skills' }
  ];
}

function normalizedDiscoveryRoots(options: BotResourceDiscoveryOptions = {}): {
  skillRoots: Array<{ path: string; source: string; bundled: boolean }>;
  pluginRoot: string;
} {
  const home = resolve(options.home ?? accountHome());
  return {
    skillRoots: (options.skillRoots ?? resourceRoots(home)).map(root => ({
      path: resolve(root.path),
      source: root.source,
      bundled: root.bundled ?? false
    })).concat((options.managedSkillRoots ?? []).map(root => ({
      path: resolve(root.path),
      source: root.source,
      bundled: root.bundled ?? false
    }))),
    pluginRoot: resolve(options.pluginRoot ?? join(home, '.codex', 'plugins', 'cache'))
  };
}

function pluginManifest(directory: string): Record<string, unknown> | null {
  const candidates = [
    join(directory, '.codex-plugin', 'plugin.json'),
    join(directory, '.claude-plugin', 'plugin.json'),
    join(directory, 'plugin.json'),
    join(directory, 'manifest.json')
  ];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(readFileSync(candidate, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch { /* try the next manifest convention */ }
  }
  return null;
}

function pluginResources(root: string): BotResource[] {
  if (!existsSync(root)) return [];
  const found = new Map<string, BotResource>();
  let marketplaceEntries: string[] = [];
  try { marketplaceEntries = readdirSync(root); } catch { return []; }
  for (const marketplace of marketplaceEntries) {
    if (marketplace.startsWith('.')) continue;
    let pluginEntries: string[] = [];
    try { pluginEntries = readdirSync(join(root, marketplace)); } catch { continue; }
    for (const pluginName of pluginEntries) {
      if (pluginName.startsWith('.') || pluginName.startsWith('@')) continue;
      const pluginRoot = join(root, marketplace, pluginName);
      let manifest = pluginManifest(pluginRoot);
      if (!manifest) {
        let versions: string[] = [];
        try {
          versions = readdirSync(pluginRoot).filter(version => {
            try { return statSync(join(pluginRoot, version)).isDirectory(); } catch { return false; }
          });
        } catch { continue; }
        for (const version of versions.sort().reverse()) {
          if (version.startsWith('.')) continue;
          const versionRoot = join(pluginRoot, version);
          try {
            if (!statSync(versionRoot).isDirectory()) continue;
          } catch { continue; }
          manifest = pluginManifest(versionRoot);
          if (manifest) break;
        }
      }
      if (!manifest) continue;
      const manifestName = typeof manifest.name === 'string' && manifest.name.trim()
        ? manifest.name.trim()
        : pluginName;
      const id = `plugin:${manifestName.toLocaleLowerCase()}`;
      if (found.has(id)) continue;
      found.set(id, {
        id,
        kind: 'plugin',
        name: manifestName,
        description: typeof manifest.description === 'string'
          ? manifest.description.slice(0, 240)
          : '已安装的 Codex Plugin。',
        source: `Plugin · ${marketplace}`,
        bundled: marketplace.includes('bundled'),
        configKey: null
      });
    }
  }
  return [...found.values()];
}

function skillFrontMatter(path: string): { name: string; description: string } {
  try {
    const text = readFileSync(path, 'utf8').slice(0, 8_000);
    const frontMatter = /^---\s*\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? '';
    const fields = new Map<string, string>();
    for (const line of frontMatter.split(/\r?\n/u)) {
      const match = /^(name|description)\s*:\s*(.*)$/u.exec(line);
      if (!match || fields.has(match[1])) continue;
      fields.set(
        match[1],
        match[2].trim().replace(/^["']|["']$/gu, '')
      );
    }
    return {
      name: (fields.get('name') ?? '').slice(0, 120),
      description: (fields.get('description') ?? '').slice(0, 240)
    };
  } catch {
    return { name: '', description: '' };
  }
}

function walkSkillFiles(directory: string): string[] {
  const results: string[] = [];
  const visit = (current: string, depth: number) => {
    if (depth > 3) return;
    let names: string[];
    try { names = readdirSync(current); } catch { return; }
    for (const name of names) {
      if (name === '.git' || name === 'node_modules') continue;
      const path = join(current, name);
      try {
        const info = statSync(path);
        if (info.isDirectory()) visit(path, depth + 1);
        else if (name === 'SKILL.md') results.push(path);
      } catch { /* unreadable entries remain outside the selectable catalog */ }
    }
  };
  visit(directory, 0);
  return results;
}

function knownSkill(id: string, bundled: boolean, source: string): BotResource | null {
  const value = DEFAULT_SKILLS.find(item => item[0] === id.toLocaleLowerCase());
  if (!value) return null;
  return {
    id: `skill:${id.toLocaleLowerCase()}`,
    kind: 'skill',
    name: value[0],
    description: value[1],
    source,
    bundled,
    configKey: null
  };
}

type McpServerInput = ReadonlyArray<KnownMcpServer> | Readonly<Record<string, unknown>>;

function boundedDescription(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 240) : '';
}

function normalizedMcpServers(options: BotResourceDiscoveryOptions): KnownMcpServer[] {
  const found = new Map<string, KnownMcpServer>();
  const inputs: McpServerInput[] = [];
  if (options.mcpServers) inputs.push(options.mcpServers);
  if (options.knownMcpServers) inputs.push(options.knownMcpServers);
  if (options.directMcpServers) inputs.push(options.directMcpServers);

  for (const input of inputs) {
    const entries = Array.isArray(input)
      ? input.map(item => ({
        name: item?.name,
        description: item?.description
      }))
      : Object.entries(input).map(([name, value]) => ({
        name,
        // Read only display metadata. In particular, never stringify or
        // retain command/env/auth fields from the config response.
        description: value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>).description
          : undefined
      }));

    for (const entry of entries) {
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) continue;
      const description = boundedDescription(entry.description);
      const existing = found.get(name);
      if (!existing || (!existing.description && description)) {
        found.set(name, { name, ...(description ? { description } : {}) });
      }
    }
  }

  return [...found.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-CN') ||
    (a.description ?? '').localeCompare(b.description ?? '', 'zh-CN')
  );
}

function knownMcpResources(knownServers: KnownMcpServer[]): BotResource[] {
  return knownServers.map(server => ({
    id: `mcp:${server.name.toLocaleLowerCase()}`,
    kind: 'mcp' as const,
    name: server.name,
    description: server.description || '来自 Codex config/read 的 MCP Server。',
    source: 'Codex config',
    bundled: false,
    configKey: server.name
  }));
}

const cache = new Map<string, BotResourceDiscovery>();

function cacheKey(options: BotResourceDiscoveryOptions): string {
  const roots = normalizedDiscoveryRoots(options);
  return JSON.stringify({
    pluginRoot: roots.pluginRoot,
    skillRoots: roots.skillRoots.map(root => ({
      path: root.path,
      source: root.source,
      bundled: root.bundled
    })),
    mcpServers: normalizedMcpServers(options)
  });
}

export function clearBotResourceCache(): void {
  cache.clear();
}

export function discoverBotResources(
  refreshOrOptions: boolean | BotResourceDiscoveryOptions = false,
  explicitOptions: BotResourceDiscoveryOptions = {}
): BotResourceDiscovery {
  const refresh = typeof refreshOrOptions === 'boolean' ? refreshOrOptions : false;
  const options = typeof refreshOrOptions === 'boolean' ? explicitOptions : refreshOrOptions;
  const roots = normalizedDiscoveryRoots(options);
  const knownMcpServers = normalizedMcpServers(options);
  const key = cacheKey(options);
  const cached = cache.get(key);
  if (cached && !refresh) return {
    resources: cached.resources.map(resource => ({ ...resource })),
    errors: [...cached.errors]
  };
  const resources = new Map<string, BotResource>();
  const errors: string[] = [];
  for (const root of roots.skillRoots) {
    for (const path of walkSkillFiles(root.path)) {
      const id = basename(dirname(path)).toLocaleLowerCase();
      const bundled = root.bundled ||
        root.source === 'Codex Skills' && path.includes(`${sep}.codex${sep}skills${sep}.system${sep}`);
      if (resources.has(`skill:${id}`)) continue;
      const known = knownSkill(id, bundled, root.source);
      const metadata = known ? { name: known.name, description: known.description } : skillFrontMatter(path);
      const resource: BotResource = known ?? {
        id: `skill:${id}`,
        kind: 'skill',
        name: metadata.name || id,
        description: metadata.description,
        source: root.source,
        bundled,
        configKey: null
      };
      resources.set(`skill:${id}`, resource);
    }
  }
  for (const [id, description] of DEFAULT_SKILLS) {
    if (resources.has(`skill:${id}`)) continue;
    resources.set(`skill:${id}`, {
      id: `skill:${id}`, kind: 'skill', name: id, description,
      source: 'Codex Bundled', bundled: true, configKey: null
    });
  }
  const mcpResources: BotResource[] = [
    {
      id: 'mcp:playwright',
      kind: 'mcp',
      name: 'Playwright',
      description: '通过 Chrome Extension 操作当前浏览器标签页。',
      source: 'MCP',
      bundled: false,
      configKey: 'playwright'
    }
  ];
  for (const resource of mcpResources) resources.set(resource.id, resource);
  for (const resource of knownMcpResources(knownMcpServers)) {
    // The built-in entry is authoritative if config/read also reports the
    // same server name.
    if (!resources.has(resource.id)) resources.set(resource.id, resource);
  }
  const appResources: BotResource[] = [
    {
      id: 'app:chatgpt',
      kind: 'app',
      name: 'ChatGPT Apps',
      description: 'Codex 可发现的 ChatGPT 应用工具。',
      source: 'Apps',
      bundled: true,
      configKey: null
    }
  ];
  for (const resource of appResources) resources.set(resource.id, resource);
  for (const resource of pluginResources(roots.pluginRoot)) resources.set(resource.id, resource);
  const ordered = [...resources.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'zh-CN')
  );
  const result = { resources: ordered, errors };
  cache.set(key, result);
  return {
    resources: ordered.map(resource => ({ ...resource })),
    errors: [...errors]
  };
}

export function resourceIdsSetting(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const result = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (!value || value.length > 200) continue;
      const separator = value.indexOf(':');
      if (separator > 0) {
        const kind = value.slice(0, separator).toLocaleLowerCase();
        const rawName = value.slice(separator + 1).trim();
        const name = kind === 'mcp' ? rawName.toLocaleLowerCase() : rawName;
        if (!name || !['skill', 'mcp', 'app', 'plugin'].includes(kind)) continue;
        result.add(`${kind}:${kind === 'mcp' ? name : name.toLocaleLowerCase()}`);
      } else {
        result.add(`skill:${value.toLocaleLowerCase()}`);
      }
    }
    return [...result];
  } catch { return []; }
}

export function selectedResources(
  botId: string,
  store: {
    settings(): Record<string, string>;
    botResourceRecords(botId: string): Array<{ resourceId: string; enabled: boolean }>;
  }
): BotResource[] {
  const global = new Set(resourceIdsSetting(store.settings().globalResourceIds));
  const enabled = new Set(store.botResourceRecords(botId)
    .filter(record => record.enabled && global.has(record.resourceId))
    .map(record => record.resourceId));
  return discoverBotResources().resources.filter(resource => enabled.has(resourceSelectionKey(resource)));
}

export function resourceSelectionKey(resource: BotResource): string {
  return resource.id;
}
