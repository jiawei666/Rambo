import { useState } from 'react';
import type { Bot, Chat, ModelOption, PermissionMode } from '../shared/contracts';

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'fullAccess', label: '完全访问' },
  { value: 'workspaceWrite', label: '工作区写入' },
  { value: 'readOnly', label: '只读' }
];
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  fullAccess: '完全访问', workspaceWrite: '工作区写入', readOnly: '只读'
};

export function permissionAction(chatId: string, permission: PermissionMode | null): string {
  return JSON.stringify([chatId, permission]);
}

export function parsePermissionAction(value: string): { chatId: string; permission: PermissionMode | null } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' ||
        !(parsed[1] === null || PERMISSION_OPTIONS.some(option => option.value === parsed[1]))) return null;
    return { chatId: parsed[0], permission: parsed[1] as PermissionMode | null };
  } catch { return null; }
}

export function modelAction(chatId: string, model: string | null): string {
  return JSON.stringify([chatId, model]);
}

export function parseModelAction(value: string): { chatId: string; model: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' ||
        !(parsed[1] === null || typeof parsed[1] === 'string')) return null;
    return { chatId: parsed[0], model: parsed[1] };
  } catch { return null; }
}

export async function applyPermissionAction(
  value: string,
  onUpdateChat: (chatId: string, patch: { permission: PermissionMode | null }) => Promise<void>
): Promise<boolean> {
  const action = parsePermissionAction(value);
  if (!action) return false;
  await onUpdateChat(action.chatId, { permission: action.permission });
  return true;
}

export async function applyModelAction(
  value: string,
  onUpdateChat: (chatId: string, patch: { model: string | null }) => Promise<void>
): Promise<boolean> {
  const action = parseModelAction(value);
  if (!action) return false;
  await onUpdateChat(action.chatId, { model: action.model });
  return true;
}

export function GroupComposerSettings({
  groupId,
  bots,
  chats,
  models,
  disabled = false,
  onUpdateChat,
  onError
}: {
  groupId: string;
  bots: Bot[];
  chats: Chat[];
  models: ModelOption[];
  disabled?: boolean;
  onUpdateChat: (chatId: string, patch: { model?: string | null; permission?: PermissionMode | null }) => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const [updating, setUpdating] = useState(false);
  const groupChatForBot = (botId: string) => chats.find(chat => chat.botId === botId && chat.groupChatId === groupId);
  const updatePermission = async (value: string) => {
    if (!parsePermissionAction(value)) return;
    setUpdating(true);
    onError(null);
    try { await applyPermissionAction(value, onUpdateChat); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setUpdating(false); }
  };
  const updateModel = async (value: string) => {
    if (!parseModelAction(value)) return;
    setUpdating(true);
    onError(null);
    try { await applyModelAction(value, onUpdateChat); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setUpdating(false); }
  };
  const controlsDisabled = disabled || updating || bots.length === 0 || bots.some(bot => !groupChatForBot(bot.id));
  const placeholder = disabled && !bots.length ? '没有活跃成员' : '按成员分别设置本群覆盖';

  return <>
    <label className="composer-setting">
      <span>权限</span>
      <select aria-label="群聊成员权限覆盖" disabled={controlsDisabled} value=""
        title="只更改选中 Bot 在当前群聊中的权限覆盖；留空时继承该 Bot 默认"
        onChange={event => void updatePermission(event.target.value)}>
        <option value="">{placeholder}</option>
        {bots.map(bot => {
          const chat = groupChatForBot(bot.id);
          if (!chat) return null;
          return <optgroup key={bot.id} label={bot.name}>
            <option value={permissionAction(chat.id, null)}>
              继承 Bot · {PERMISSION_LABELS[bot.permission]}{chat.permission === null ? ' · 当前' : ''}
            </option>
            {PERMISSION_OPTIONS.map(option => (
              <option key={option.value} value={permissionAction(chat.id, option.value)}>
                {option.label}{chat.permission === option.value ? ' · 当前' : ''}
              </option>
            ))}
          </optgroup>;
        })}
      </select>
    </label>
    <label className="composer-setting model-setting">
      <span>模型</span>
      <select aria-label="群聊成员模型覆盖" disabled={controlsDisabled} value=""
        title="只更改选中 Bot 在当前群聊中的模型覆盖；留空时继承该 Bot 默认"
        onChange={event => void updateModel(event.target.value)}>
        <option value="">{placeholder}</option>
        {bots.map(bot => {
          const chat = groupChatForBot(bot.id);
          if (!chat) return null;
          const inherited = bot.model === null
            ? '本机配置'
            : models.find(option => option.id === bot.model)?.label ?? bot.model;
          return <optgroup key={bot.id} label={bot.name}>
            <option value={modelAction(chat.id, null)}>
              继承 · {inherited}{chat.model === null ? ' · 当前' : ''}
            </option>
            {chat.model && !models.some(option => option.id === chat.model) && (
              <option value={modelAction(chat.id, chat.model)}>{chat.model} · 当前</option>
            )}
            {models.map(option => (
              <option key={option.id} value={modelAction(chat.id, option.id)}>
                {option.label}{option.isDefault ? ' · 产品默认' : ''}{chat.model === option.id ? ' · 当前' : ''}
              </option>
            ))}
          </optgroup>;
        })}
      </select>
    </label>
    <span className="composer-setting-hint">仅作用于对应 Bot 在本群的会话</span>
  </>;
}
