import type { Bot, PermissionMode } from './contracts';

const permissionModes = new Set<PermissionMode>(['fullAccess', 'workspaceWrite', 'readOnly']);

export function botExecutionConfigError(
  bot: Pick<Bot, 'name' | 'model' | 'permission'>
): string | null {
  if (!bot.model.trim()) {
    return `「${bot.name}」尚未配置模型，请在 Bot 设置的“模型与权限”中选择模型。`;
  }
  if (!permissionModes.has(bot.permission)) {
    return `「${bot.name}」的权限配置无效，请在 Bot 设置的“模型与权限”中重新选择。`;
  }
  return null;
}
