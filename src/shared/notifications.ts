import type { RoutineRunStatus, TurnStatus } from './contracts';

export type NotificationDecisionReason =
  | 'enabled'
  | 'disabled'
  | 'visible'
  | 'ineligible';

export interface NotificationDecision {
  notify: boolean;
  reason: NotificationDecisionReason;
}

export type NotificationRuntimeState =
  | 'unknown'
  | 'not-determined'
  | 'denied'
  | 'authorized'
  | 'provisional';

export interface BotReplyNotificationRecord {
  chatId: string;
  botId: string;
  preview: string;
  notificationId: string;
  decision: NotificationDecisionReason;
  createdAt: string;
}

export function decideBotTurnFinishedNotification(input: {
  status: TurnStatus;
  text: string;
  enabled: boolean;
  archived: boolean;
  visibleAndFocused: boolean;
}): NotificationDecision {
  if (!input.enabled) return { notify: false, reason: 'disabled' };
  if (input.visibleAndFocused) return { notify: false, reason: 'visible' };
  if (input.archived) return { notify: false, reason: 'ineligible' };
  if (input.status === 'failed') return { notify: true, reason: 'enabled' };
  const terminalReply = (input.status === 'completed' || input.status === 'interrupted') &&
    input.text.trim().length > 0;
  return terminalReply
    ? { notify: true, reason: 'enabled' }
    : { notify: false, reason: 'ineligible' };
}

export function decideRoutineFinishedNotification(input: {
  status: RoutineRunStatus;
  successNotification: boolean;
  enabled: boolean;
  archived: boolean;
  visibleAndFocused: boolean;
}): NotificationDecision {
  if (!input.enabled) return { notify: false, reason: 'disabled' };
  if (input.visibleAndFocused) return { notify: false, reason: 'visible' };
  if (input.archived) return { notify: false, reason: 'ineligible' };
  if (input.status === 'succeeded') {
    return input.successNotification
      ? { notify: true, reason: 'enabled' }
      : { notify: false, reason: 'ineligible' };
  }
  const needsAttention = input.status === 'failed' ||
    input.status === 'interrupted' ||
    input.status === 'needs_user';
  return needsAttention
    ? { notify: true, reason: 'enabled' }
    : { notify: false, reason: 'ineligible' };
}

export function notificationUnavailableMessage(
  runtimeState: NotificationRuntimeState | null | undefined
): string | null {
  if (runtimeState === 'unknown') {
    return '开发运行时使用 Electron 的应用身份。系统通知请在打包后的 Rambo 中确认授权与显示。';
  }
  return null;
}
