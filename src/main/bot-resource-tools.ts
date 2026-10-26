import type { BotResource, Message } from '../shared/contracts';
import type { Store } from './store';

export const BOT_RESOURCE_TOOL_NAMESPACE = 'rambo_resources';

export const BOT_RESOURCE_TOOLS = {
  type: 'namespace',
  name: BOT_RESOURCE_TOOL_NAMESPACE,
  description: '管理本机 Skills、MCP、Apps 与 Plugins 的全局可选目录、新建 Bot 默认开关，以及当前 Bot 自己的开关。用户明确要求时直接执行；Bot 主动建议全局变更时必须先取得用户同意。不能修改其他 Bot 的开关，不能归档或删除 Bot。',
  tools: [{
    type: 'function',
    name: 'manage_resource',
    description: '把已发现资源加入或移出全局可选目录、设置新建 Bot 默认开关，或开启/关闭当前 Bot 自己的资源。resource_id 必须来自当前发现目录。改变全局作用域前，用户必须已在当前对话明确要求；若只是 Bot 主动建议，先征得用户同意再调用。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['install_global', 'remove_global', 'set_global_default', 'set_current_bot'],
          description: 'install_global 把已发现资源加入全局可选目录；remove_global 移出所有 Bot 可见范围；set_global_default 只控制之后新建 Bot 的初值；set_current_bot 只切换当前 Bot 的开关。'
        },
        resource_id: {
          type: 'string',
          minLength: 1,
          maxLength: 240,
          description: '当前发现目录中的稳定资源 ID，例如 skill:documents 或 mcp:playwright。'
        },
        enabled: {
          type: 'boolean',
          description: 'set_global_default 或 set_current_bot 必填；其他动作省略。'
        }
      },
      required: ['action', 'resource_id'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'import_local_skill',
    description: '当用户明确给出一个包含 SKILL.md 的本地 Skill 文件夹并要求全局安装时调用。宿主会校验并复制到 Rambo 管理的共享技能库，再加入全局可选目录；默认不替任何已有 Bot 开启。',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          description: '用户明确提供的本地 Skill 文件夹绝对路径；根目录必须包含 SKILL.md。'
        }
      },
      required: ['directory'],
      additionalProperties: false
    }
  }, {
    type: 'function',
    name: 'add_direct_mcp',
    description: '当用户明确要求新增并全局安装一个直连 MCP Server 时调用。宿主会校验定义、把 headers/env 使用应用本地密钥加密保存，并加入全局可选目录；已有 Bot 默认关闭。不会下载或安装任何服务器软件。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string', minLength: 1, maxLength: 100,
          description: 'MCP Server 名称，只能包含字母、数字、点、下划线和短横线。'
        },
        description: { type: 'string', maxLength: 240 },
        transport: { type: 'string', enum: ['stdio', 'http'] },
        command: { type: 'string', maxLength: 4096, description: 'stdio MCP 的可执行命令；不记录到系统提醒。' },
        args: {
          type: 'array', maxItems: 100,
          items: { type: 'string', maxLength: 4096 },
          description: 'stdio MCP 参数；不记录到系统提醒。'
        },
        cwd: { type: 'string', maxLength: 4096 },
        url: { type: 'string', maxLength: 4096, description: 'http MCP URL；URL 内不得嵌入账号密码。' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string', maxLength: 65536 },
          description: 'http MCP 请求头。值只加密保存，不进入快照或系统提醒。'
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string', maxLength: 65536 },
          description: 'stdio MCP 环境变量。值只加密保存，不进入快照或系统提醒。'
        },
        enabled: {
          type: 'boolean',
          description: '仅用于新建 Bot 的默认开关，默认 false；不会替已有 Bot 开启。'
        }
      },
      required: ['name', 'transport'],
      additionalProperties: false
    }
  }]
} as const;

export interface BotResourceToolResult {
  success: boolean;
  text: string;
  notice?: string;
}

export interface BotResourceToolInput {
  botId: string;
  chatId: string;
  resources: readonly BotResource[];
  action: unknown;
  resourceId: unknown;
  enabled: unknown;
}

function resourceLabel(resource: BotResource): string {
  return `${resource.name}（${resource.kind === 'skill' ? 'Skill' : resource.kind === 'mcp' ? 'MCP' : resource.kind === 'app' ? 'App' : 'Plugin'}）`;
}

export function botResourceNotice(message: Message | null): string | null {
  return message?.role === 'system' ? message.text : null;
}

export function executeBotResourceTool(
  store: Store,
  input: BotResourceToolInput
): BotResourceToolResult {
  const action = typeof input.action === 'string' ? input.action : '';
  if (!['install_global', 'remove_global', 'set_global_default', 'set_current_bot'].includes(action)) {
    return { success: false, text: '不支持的资源管理动作。' };
  }
  if (typeof input.resourceId !== 'string' || !input.resourceId.trim()) {
    return { success: false, text: '请提供发现目录中的 resource_id。' };
  }
  const resourceId = input.resourceId.trim().toLocaleLowerCase();
  const resource = input.resources.find(item => item.id.toLocaleLowerCase() === resourceId);
  if (!resource) return { success: false, text: '资源不在当前发现目录中，未修改任何配置。' };
  if (action === 'remove_global' && resource.id === 'mcp:playwright') {
    return { success: false, text: 'Playwright 是受管预设，不能从全局可选目录移出。' };
  }
  if (action === 'set_current_bot') {
    if (typeof input.enabled !== 'boolean') {
      return { success: false, text: '开启或关闭当前 Bot 的资源时必须提供 enabled；不能通过本次调用修改其他 Bot。' };
    }
    try {
      store.setBotResource(input.botId, resource.id, input.enabled);
    } catch (error) {
      return {
        success: false,
        text: error instanceof Error ? error.message : '无法修改当前 Bot 的资源开关。'
      };
    }
    const notice = `已将 ${resourceLabel(resource)} ${input.enabled ? '开启' : '关闭'}为当前 Bot 资源`;
    return { success: true, text: `${notice}。`, notice };
  }
  if (typeof input.enabled !== 'undefined' && action !== 'set_global_default') {
    return { success: false, text: '该资源动作不接受 enabled 参数。' };
  }
  try {
    if (action === 'install_global') {
      store.setGlobalResourceIncluded(resource.id, true);
      const notice = `已将 ${resourceLabel(resource)} 加入全局可选目录；已有 Bot 默认关闭`;
      return { success: true, text: `${notice}。`, notice };
    }
    if (action === 'remove_global') {
      store.setGlobalResourceIncluded(resource.id, false);
      const notice = `已将 ${resourceLabel(resource)} 移出全局可选目录；所有 Bot 不再可用`;
      return { success: true, text: `${notice}。`, notice };
    }
    if (typeof input.enabled !== 'boolean') {
      return { success: false, text: '设置全局新建 Bot 默认开关时必须提供 enabled。' };
    }
    store.setGlobalResourceDefault(resource.id, input.enabled);
    const notice = `已将 ${resourceLabel(resource)} 设为新建 Bot ${input.enabled ? '默认开启' : '默认关闭'}`;
    return { success: true, text: `${notice}。`, notice };
  } catch (error) {
    return {
      success: false,
      text: error instanceof Error ? error.message : '无法修改全局资源目录。'
    };
  }
}
