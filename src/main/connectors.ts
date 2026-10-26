import type {
  ConnectorAuthChallenge,
  ConnectorAuthKind,
  ConnectorCategory,
  ConnectorProvider
} from '../shared/contracts';
import { randomUUID } from 'node:crypto';

type ProviderSeed = Omit<ConnectorProvider, 'available'>;

const seeds: Record<string, ProviderSeed> = {
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    description: '使用 Google 应用专用密码通过 IMAP/SMTP 搜索、阅读、发送和回复 Gmail 邮件。',
    category: 'email',
    authKind: 'credentials',
    capabilities: ['mail.search', 'mail.read', 'mail.getAttachment', 'mail.draft', 'mail.send', 'mail.reply'],
    brandColor: '#ea4335',
    monogram: 'M'
  },
  qqmail: {
    id: 'qqmail',
    name: 'QQ 邮箱',
    description: '通过 QQ 邮箱授权码收发、搜索和整理邮件。',
    category: 'email',
    authKind: 'credentials',
    capabilities: ['mail.search', 'mail.read', 'mail.getAttachment', 'mail.draft', 'mail.send', 'mail.reply'],
    brandColor: '#1296db',
    monogram: 'QQ'
  },
  wechat: {
    id: 'wechat',
    name: '微信',
    description: '读取本机微信已保存的聊天消息。',
    category: 'communication',
    authKind: 'local-key-capture',
    capabilities: [
      'wechat.sessions',
      'wechat.messages',
      'wechat.search',
      'wechat.media'
    ],
    brandColor: '#07c160',
    monogram: '微'
  },
  calendar: {
    id: 'calendar',
    name: '日历',
    description: '查看日历和安排日程。',
    category: 'calendar',
    authKind: 'oauth-desktop',
    capabilities: ['calendar.search', 'calendar.createEvent'],
    brandColor: '#34a853',
    monogram: '31'
  },
  github: {
    id: 'github',
    name: 'GitHub',
    description: '查看仓库、Issue 和 Pull Request。',
    category: 'developer',
    authKind: 'oauth-desktop',
    capabilities: ['repos.read', 'issues.read', 'pullRequests.read'],
    brandColor: '#24292f',
    monogram: 'GH'
  }
};

export function connectorProviders(): ConnectorProvider[] {
  return Object.values(seeds).map(provider => ({
    ...provider,
    capabilities: [...provider.capabilities],
    // The first connector release integrates email; Calendar and GitHub are catalog placeholders.
    available: provider.id === 'gmail' || provider.id === 'qqmail' || provider.id === 'wechat'
  }));
}

export function connectorProvider(id: string): ConnectorProvider {
  const provider = connectorProviders().find(item => item.id === id);
  if (!provider) throw new Error('未知的连接应用');
  return provider;
}

/**
 * The market is deliberately explicit about which protocols are integrated.
 * Future providers add an Adapter and flip `available`; the Host authorization
 * and grant flow stays unchanged.
 */
export function beginConnectorAuth(providerId: string, displayName?: string): ConnectorAuthChallenge {
  const provider = connectorProvider(providerId);
  if (!provider.available) throw new Error(`${provider.name} 尚未接入；应用目录只展示未来适配位置。`);
  const connectionId = `pending:${provider.id}:${randomUUID()}`;
  const label = displayName?.trim() || provider.name;
  if (provider.authKind === 'oauth-desktop') {
    const url = new URL('rambo-connector://oauth/callback');
    url.searchParams.set('provider', provider.id);
    url.searchParams.set('connection', connectionId);
    url.searchParams.set('displayName', label);
    return { connectionId, providerId: provider.id, authKind: provider.authKind, displayName: label, url: url.toString() };
  }
  return {
    connectionId,
    providerId: provider.id,
    authKind: provider.authKind,
    displayName: label,
    url: `rambo-connector://credentials?provider=${encodeURIComponent(provider.id)}&connection=${encodeURIComponent(connectionId)}`
  };
}

export const CONNECTOR_CATEGORIES: Array<{
  id: ConnectorCategory | 'all';
  label: string;
}> = [
  { id: 'all', label: '全部' },
  { id: 'email', label: '邮件' },
  { id: 'calendar', label: '日程' },
  { id: 'files', label: '文件' },
  { id: 'communication', label: '沟通' },
  { id: 'productivity', label: '效率' },
  { id: 'developer', label: '开发' },
  { id: 'data', label: '数据' },
  { id: 'other', label: '其他' }
];

export type ConnectorAdapterInfo = {
  providerId: string;
  authKind: ConnectorAuthKind;
};
