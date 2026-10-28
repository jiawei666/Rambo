import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import appAvatarUrl from '../../assets/branding/app-logo-source.png';
import calendarLogo from '../../assets/connectors/calendar.png';
import gmailLogo from '../../assets/connectors/gmail.png';
import githubLogo from '../../assets/connectors/github.png';
import qqMailLogo from '../../assets/connectors/qqmail.png';
import wechatLogo from '../../assets/connectors/wechat.svg';
import {
  RobotAvatar as Avatar,
  RobotAvatarPicker as AvatarPicker,
  createInitialRobotAvatar as createInitialAvatar,
  parseRobotAvatar
} from './robot-avatar';
import { runGroupCreateAction } from './group-create-actions';
import {
  partitionBots,
  privateChatForBot,
  selectedPrivateChat,
  shouldShowReturnToChat,
  sidebarConversations
} from './chat-list-model';
import { runAfterExplicitConfirmation } from './management-actions';
import { MessageContentView } from './message-content';
import {
  formatMessageDivider,
  formatMessageHoverTime,
  shouldShowMessageTimeDivider
} from './message-time';
import { insertMention, mentionOptions, mentionRange, type MentionOption } from './mention-autocomplete';
import {
  centerVoiceFrequencyBands,
  createVoiceFrequencyBands,
  createVoiceWaveformSmoother,
  voiceFrequencyBinRange
} from './voice-waveform-model';
import hark, { type Harker } from 'hark';
import type {
  AccountState,
  AppEvent,
  Bot,
  BotResource,
  Chat,
  ComposerAttachment,
  ConnectorAuthChallenge,
  ConnectorCategory,
  ConnectorConnection,
  ConnectorCredentialInput,
  ConnectorGrant,
  ConnectorProvider,
  DirectMcpServer,
  GroupChat,
  GroupMessage,
  GroupRuntimeMember,
  GroupRuntimeState,
  Memory,
  McpElicitationAction,
  McpElicitationPrompt,
  Message,
  ModelConnectionTestResult,
  ModelOption,
  ModelSourceKind,
  ModelSourceState,
  PermissionMode,
  PlaywrightVerificationResult,
  RoutineListItem,
  RoutineRun,
  RuntimeState,
  SecretCapturePrompt,
  Snapshot,
  TurnActivity,
  VoiceState
} from '../shared/contracts';
import {
  composeComposerMessage,
  dedupeComposerAttachments,
  parseImageDataUrl
} from '../shared/composer-attachments';
import { botExecutionConfigError } from '../shared/execution-config';
import { needsInitialSetup as shouldOpenInitialSetup } from '../main/model-source';

type View = 'chat' | 'settings' | 'connectors' | 'bot-settings' | 'group-create' | 'group-chat' | 'group-members';
type SystemSettingsTab = 'general' | 'account' | 'model' | 'resources' | 'routines';
type ResourceSection = 'skills' | 'mcp' | 'plugins';
type AutoSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
type LiveVoiceUi = {
  chatId: string;
  state: VoiceState;
  error: string | null;
};
type VoiceTranscriptFragment = { text: string; sequence: number };
type VoiceErrorPresentation = {
  title: string;
  detail: string;
};

const EMPTY_SNAPSHOT: Snapshot = {
  codexHome: '',
  runtimeProxy: '',
  modelSource: {
    kind: 'local',
    manual: { serviceName: '', baseUrl: '', model: '' },
    hasApiKey: false
  },
  bots: [],
  chats: [],
  connectorProviders: [],
  connections: [],
  connectorGrants: [],
  botResources: [],
  globalResourceIds: [],
  globalDefaultResourceIds: [],
  directMcpServers: [],
  groups: [],
  archivedGroups: [],
  routines: [],
  routineRuns: [],
  runtime: { status: 'stopped', version: '', error: null },
  activeTurns: {},
  startingTurns: {},
  groupRuntimes: {},
  settings: {},
  executionDefaults: {
    ready: false,
    model: '',
    permission: null,
    error: '尚未读取模型配置。'
  },
  recentMessages: {},
  unreadCounts: {},
  notifications: {
    runtimeState: 'unknown',
    unavailableMessage: null,
    recentBotReplies: []
  }
};

export function mergeRecentMessage(
  recentMessages: Record<string, string>,
  message: Message
): Record<string, string> {
  const previousUpdatedAt = recentMessages[`${message.chatId}:updatedAt`] ?? '';
  const previousArrival = Number(recentMessages[`${message.chatId}:arrival`] ?? 0);
  if (previousUpdatedAt > message.createdAt) return recentMessages;
  const arrival = Math.max(Date.now(), previousArrival + 1);
  return {
    ...recentMessages,
    [message.chatId]: message.text,
    [`${message.chatId}:updatedAt`]: message.createdAt,
    [`${message.chatId}:arrival`]: String(arrival)
  };
}

export function mergeUnreadCount(
  unreadCounts: Record<string, number>,
  message: Message,
  visibleAndFocused: boolean,
  seenItems: Set<string>
): Record<string, number> {
  if (message.role !== 'assistant' || visibleAndFocused) {
    if (message.itemId) seenItems.add(message.itemId);
    return unreadCounts;
  }
  if (message.itemId) {
    if (seenItems.has(message.itemId)) return unreadCounts;
    seenItems.add(message.itemId);
  }
  const previous = unreadCounts[message.chatId] ?? 0;
  return { ...unreadCounts, [message.chatId]: previous + 1 };
}

export function keepVisibleChatUnreadClear<T extends { unreadCounts: Record<string, number> }>(
  snapshot: T,
  visibleChatId: string | null,
  windowFocused: boolean
): T {
  if (!visibleChatId || !windowFocused || !snapshot.unreadCounts[visibleChatId]) return snapshot;
  return {
    ...snapshot,
    unreadCounts: { ...snapshot.unreadCounts, [visibleChatId]: 0 }
  };
}

function voiceAccentStyle(avatar: string): CSSProperties {
  const color = parseRobotAvatar(avatar).color;
  return {
    '--voice-accent': color === 'black'
      ? 'var(--avatar-swatch-black, #000)'
      : `var(--avatar-ink-${color}, var(--text-secondary))`
  } as CSSProperties;
}

function liveVoiceStatusLabel(voice: LiveVoiceUi): string {
  if (voice.state === 'connecting') return '正在拨号';
  if (voice.state === 'live') return '正在聆听';
  if (voice.state === 'stopping') return '正在结束语音';
  return voice.error?.startsWith('语音服务停止失败') ? '语音结束失败' : '语音连接异常';
}

function voiceErrorPresentation(voice: LiveVoiceUi): VoiceErrorPresentation | null {
  if (voice.state !== 'error') return null;
  const raw = voice.error?.trim() || '';
  if (raw.startsWith('语音服务停止失败')) {
    const detail = raw.replace(/^语音服务停止失败[：:]\s*/u, '').trim();
    return {
      title: '语音结束失败',
      detail: detail || '语音服务没有完成关闭，麦克风已停止使用。'
    };
  }
  return {
    title: '语音连接异常',
    detail: raw || '未能建立语音连接，请检查麦克风权限和网络。'
  };
}

function GroupAvatar({ group, bots, size = 'small' }: { group: GroupChat; bots: Bot[]; size?: 'small' | 'regular' }) {
  const members = group.memberIds.map(id => bots.find(bot => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
  const label = members.length ? `群聊成员头像：${members.map(bot => bot.name).join('、')}` : '空群聊';
  return (
    <span className={'group-avatar group-avatar-' + size} role="img" aria-label={label} title={label}>
      {members.slice(0, 3).map((bot, index) => (
        <span className="group-avatar-member" key={bot.id} style={{ left: `${index * (size === 'small' ? 8 : 10)}px`, zIndex: 4 - index }}>
          <Avatar value={bot.avatar} size="small" />
        </span>
      ))}
      {members.length > 3 && <span className="group-avatar-count">+{members.length - 3}</span>}
      {members.length === 0 && <Icon name="users" size={14} />}
    </span>
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="unread-badge" aria-label={`${count} 条未读`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

type IconName = 'plus' | 'paperclip' | 'settings' | 'chevron' | 'send' | 'stop' | 'close' | 'back' | 'check' | 'arrow' | 'panel' | 'search' | 'account' | 'users' | 'calendar' | 'more' | 'voice' | 'connectors' | 'copy' | 'archive' | 'trash';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const shapes: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    paperclip: <path d="m20.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.6-8.6" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3 .9v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3-.9l-.1.1a1.8 1.8 0 0 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-.9-3h-.2a1.8 1.8 0 0 1 0-3.6h.2a1.8 1.8 0 0 0 .9-3l-.1-.1a1.8 1.8 0 0 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3-.9v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3 .9l.1-.1a1.8 1.8 0 0 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 .9 3h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0-.9 3Z" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    send: <path d="M12 19V5m-7 7 7-7 7 7" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    back: <path d="m15 18-6-6 6-6M9 12h11" />,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M5 12h14m-7-7 7 7-7 7" />,
    panel: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M9 4v16" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4 4" /></>,
    account: <><circle cx="12" cy="8" r="3.2" /><path d="M5.5 20c.4-3.4 2.7-5.3 6.5-5.3s6.1 1.9 6.5 5.3" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.3-3.2 2.1-5 5.5-5s5.2 1.8 5.5 5M16 5.5a2.8 2.8 0 0 1 0 5.5m1 3c2.2.5 3.4 2.1 3.5 5" /></>,
    calendar: <><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M7.5 3v4M16.5 3v4M3.5 10h17M8 14h2m4 0h2m-8 3h2m4 0h2" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    voice: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-3 0h6" /></>,
    connectors: <><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="12" cy="18" r="3" /><path d="m8.3 8.2 2.2 7.2m5.2-7.2-2.2 7.2M9 6h6" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    archive: <><rect x="4" y="5" width="16" height="4" rx="1" /><path d="M6 9v10h12V9M9.5 13h5" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></>
  };

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {shapes[name]}
    </svg>
  );
}

function toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionLabel(fileName: string): string {
  const extension = /\.([^.]+)$/u.exec(fileName)?.[1];
  return extension ? extension.slice(0, 4).toUpperCase() : 'FILE';
}

function permissionModeFromSetting(value: string | undefined): PermissionMode | null {
  if (value === undefined || value === '') return 'fullAccess';
  return value === 'workspaceWrite' || value === 'readOnly' || value === 'fullAccess'
    ? value
    : null;
}

const CONNECTOR_CATEGORY_LABELS: Record<ConnectorCategory | 'all' | 'connected', string> = {
  all: '全部',
  connected: '已连接',
  email: '邮件',
  calendar: '日程',
  files: '文件',
  communication: '沟通',
  productivity: '效率',
  developer: '开发',
  data: '数据',
  other: '其他'
};

const CONNECTOR_FEATURED_ORDER = ['wechat', 'gmail', 'qqmail', 'calendar', 'github'];
const CONNECTOR_LOGOS: Record<string, string> = {
  wechat: wechatLogo,
  gmail: gmailLogo,
  qqmail: qqMailLogo,
  calendar: calendarLogo,
  github: githubLogo
};

function ConnectorProviderIcon({ provider, className }: {
  provider: ConnectorProvider;
  className: 'connector-card-icon' | 'connector-dialog-icon';
}) {
  const logo = CONNECTOR_LOGOS[provider.id];
  return (
    <div className={className + (logo ? ' connector-icon-has-logo' : '')}
      style={{ '--connector-brand': provider.brandColor } as CSSProperties} aria-hidden="true">
      {logo ? <img className="connector-provider-logo" src={logo} alt="" /> : <span>{provider.monogram}</span>}
    </div>
  );
}

class VoiceMediaSession {
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private channel: RTCDataChannel | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private harker: Harker | null = null;
  private frequencySamples: Float32Array<ArrayBuffer> | null = null;
  private voiceLowBin = 0;
  private voiceHighBin = 0;

  constructor(readonly chatId: string) {}

  async start(): Promise<string> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.stream = stream;
    this.startLevelMeter(stream);
    const peer = new RTCPeerConnection();
    this.peer = peer;
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    peer.addTransceiver('audio', { direction: 'recvonly' });

    const channel = peer.createDataChannel('oai-events', { ordered: true });
    this.channel = channel;
    this.audio = new Audio();
    this.audio.autoplay = true;
    peer.ontrack = event => {
      if (!this.audio) return;
      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.audio.play().catch(() => {
        // Chromium may defer playback until the next gesture; the Live UI exposes retry.
      });
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await this.waitForIceGathering(peer);
    return peer.localDescription?.sdp ?? offer.sdp ?? '';
  }

  async applyAnswer(sdp: string): Promise<void> {
    if (!this.peer) throw new Error('语音媒体连接已释放');
    await this.peer.setRemoteDescription({ type: 'answer', sdp });
  }

  readInputLevels(barCount: number): { levels: number[]; speech: boolean } | null {
    const analyser = this.analyser;
    const samples = this.frequencySamples;
    if (!analyser || !samples || this.audioContext?.state !== 'running') return null;
    analyser.getFloatFrequencyData(samples);
    const bands = createVoiceFrequencyBands(samples, {
      barCount,
      loBin: this.voiceLowBin,
      hiBin: this.voiceHighBin
    });
    return {
      levels: centerVoiceFrequencyBands(bands),
      speech: this.harker?.speaking ?? false
    };
  }

  async close(): Promise<void> {
    const peer = this.peer;
    this.peer = null;
    try { this.channel?.close(); } catch { /* already closed */ }
    this.channel = null;
    for (const track of this.stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    this.stream = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.harker?.stop();
    this.harker = null;
    this.frequencySamples = null;
    this.voiceLowBin = 0;
    this.voiceHighBin = 0;
    const audioContext = this.audioContext;
    this.audioContext = null;
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => {
        // The context may already be closing with the media session.
      });
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = null;
    }
    try { peer?.close(); } catch { /* already closed */ }
  }

  private startLevelMeter(stream: MediaStream): void {
    try {
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.45;
      analyser.minDecibels = -100;
      analyser.maxDecibels = -10;
      source.connect(analyser);
      // Hark is the MIT-licensed VAD used by this meter. Keep its upstream
      // three-frame attack/four-frame release state machine short enough for
      // conversational feedback while still rejecting isolated spikes.
      const harker = hark(stream, {
        audioContext,
        interval: 32,
        history: 4,
        threshold: -50
      });
      this.audioContext = audioContext;
      this.analyser = analyser;
      this.harker = harker;
      this.frequencySamples = new Float32Array(analyser.frequencyBinCount);
      const range = voiceFrequencyBinRange(audioContext.sampleRate, analyser.fftSize);
      this.voiceLowBin = range.loBin;
      this.voiceHighBin = Math.min(analyser.frequencyBinCount, range.hiBin);
      void audioContext.resume().catch(() => {
        // The meter falls back to its idle animation if audio is suspended.
      });
    } catch {
      // Media delivery must not fail just because an optional level meter is unavailable.
    }
  }

  private async waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        // A complete local description can still be submitted if gathering is slow.
        resolve();
      }, 8_000);
      const onState = () => {
        if (peer.iceGatheringState === 'complete') {
          cleanup();
          resolve();
        }
      };
      const onConnectionState = () => {
        if (peer.connectionState === 'failed') {
          cleanup();
          reject(new Error('语音媒体连接失败'));
        }
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        peer.removeEventListener('icegatheringstatechange', onState);
        peer.removeEventListener('connectionstatechange', onConnectionState);
      };
      peer.addEventListener('icegatheringstatechange', onState);
      peer.addEventListener('connectionstatechange', onConnectionState);
    });
  }
}

function sortChats(chats: Chat[], botId: string): Chat[] {
  const selected = privateChatForBot(chats, botId);
  return selected ? [selected] : [];
}

function upsertMessage(current: Message[], next: Message): Message[] {
  const index = current.findIndex(message => message.id === next.id);
  if (index < 0) return [...current, next].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const result = current.slice();
  result[index] = next;
  return result;
}

function mergeMessages(base: Message[], overlay: Message[]): Message[] {
  return overlay.reduce(upsertMessage, base);
}

type PendingMessageLoad = {
  requestId: number;
  streamed: Map<string, Message>;
  clearCurrent: boolean;
  showLoading: boolean;
};

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activities, setActivities] = useState<TurnActivity[]>([]);
  const [groupMessages, setGroupMessages] = useState<GroupMessage[]>([]);
  const [enteringMessageIds, setEnteringMessageIds] = useState<Set<string>>(() => new Set());
  const [loadingGroupMessages, setLoadingGroupMessages] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [view, setView] = useState<View>('chat');
  const [systemSettingsTab, setSystemSettingsTab] = useState<SystemSettingsTab>('general');
  const [groupCreateReturnView, setGroupCreateReturnView] = useState<View>('chat');
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [compactSidebar, setCompactSidebar] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBotId, setSearchBotId] = useState('all');
  const [searchResults, setSearchResults] = useState<Array<{ message: Message; chat: Chat; bot: Bot }>>([]);
  const [searching, setSearching] = useState(false);
  const [deletingBot, setDeletingBot] = useState<Bot | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<GroupChat | null>(null);
  const [mcpElicitations, setMcpElicitations] = useState<McpElicitationPrompt[]>([]);
  const [mcpElicitationBusy, setMcpElicitationBusy] = useState(false);
  const [secretCapture, setSecretCapture] = useState<SecretCapturePrompt | null>(null);
  const [sidebarMenu, setSidebarMenu] = useState<
    | { kind: 'bot'; bot: Bot; conversationId: string; x: number; y: number }
    | { kind: 'group'; group: GroupChat; conversationId: string; x: number; y: number }
    | null
  >(null);
  const [sidebarNotice, setSidebarNotice] = useState<string | null>(null);
  const [connectorDialog, setConnectorDialog] = useState<{
    mode: 'connect' | 'manage';
    provider: ConnectorProvider;
    connection: ConnectorConnection | null;
  } | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelOptionsError, setModelOptionsError] = useState<string | null>(null);
  const firstRunSettingsRef = useRef(false);
  const [voice, setVoice] = useState<LiveVoiceUi | null>(null);
  const botsRef = useRef<Bot[]>([]);
  const voiceRef = useRef<LiveVoiceUi | null>(null);
  const voiceSessionRef = useRef<VoiceMediaSession | null>(null);
  const selectedChatRef = useRef<string | null>(null);
  const selectedGroupRef = useRef<string | null>(null);
  const windowFocusedRef = useRef(document.hasFocus());
  const initializedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptFollowsLatestRef = useRef(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRequestRef = useRef(0);
  const messageLoadSequenceRef = useRef(0);
  const pendingMessageLoadsRef = useRef(new Map<string, PendingMessageLoad>());
  const pendingVoiceMessagesRef = useRef(new Map<string, Message>());
  const voiceMessageFrameRef = useRef<number | null>(null);
  const seenUnreadItemsRef = useRef(new Set<string>());
  const groupMessageLoadSequenceRef = useRef(0);
  const pendingGroupMessageLoadsRef = useRef(new Map<string, {
    requestId: number; streamed: Map<string, GroupMessage>; removed: Set<string>
  }>());
  const singleChatScrollPendingRef = useRef(false);
  const enteredMessageIdsRef = useRef(new Set<string>());
  const enteringMessageTimersRef = useRef(new Map<string, number>());

  const markMessageEntering = useCallback((id: string) => {
    if (enteredMessageIdsRef.current.has(id)) return;
    enteredMessageIdsRef.current.add(id);
    setEnteringMessageIds(current => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
    const previousTimer = enteringMessageTimersRef.current.get(id);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      enteringMessageTimersRef.current.delete(id);
      setEnteringMessageIds(current => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 260);
    enteringMessageTimersRef.current.set(id, timer);
  }, []);

  useEffect(() => {
    const timers = enteringMessageTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => () => {
    if (voiceMessageFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceMessageFrameRef.current);
      voiceMessageFrameRef.current = null;
    }
    pendingVoiceMessagesRef.current.clear();
  }, []);

  useEffect(() => {
    if (!sidebarMenu) return;
    const menu = document.querySelector<HTMLElement>('.sidebar-context-menu');
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const close = () => setSidebarMenu(null);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sidebarMenu]);

  useEffect(() => {
    if (!sidebarNotice) return;
    const timer = window.setTimeout(() => setSidebarNotice(null), 2_400);
    return () => window.clearTimeout(timer);
  }, [sidebarNotice]);

  const loadMessages = useCallback(async (
    chatId: string,
    options: { clearCurrent?: boolean; showLoading?: boolean; resetStreamBuffer?: boolean } = {}
  ) => {
    const previous = pendingMessageLoadsRef.current.get(chatId);
    const pending: PendingMessageLoad = {
      requestId: ++messageLoadSequenceRef.current,
      streamed: options.resetStreamBuffer ? new Map() : previous?.streamed ?? new Map(),
      clearCurrent: options.clearCurrent ?? previous?.clearCurrent ?? false,
      showLoading: options.showLoading ?? previous?.showLoading ?? false
    };
    pendingMessageLoadsRef.current.set(chatId, pending);
    try {
      const result = await window.rambo.messages(chatId);
      if (selectedChatRef.current === chatId && pendingMessageLoadsRef.current.get(chatId) === pending) {
        const streamed = [...pending.streamed.values()];
        setMessages(current => {
          const baseline = pending.clearCurrent ? result : mergeMessages(result, current);
          return mergeMessages(baseline, streamed);
        });
      }
    } catch (error) {
      if (selectedChatRef.current === chatId && pendingMessageLoadsRef.current.get(chatId) === pending) {
        setAppError(toError(error));
      }
    } finally {
      if (pendingMessageLoadsRef.current.get(chatId) === pending) {
        pendingMessageLoadsRef.current.delete(chatId);
        if (selectedChatRef.current === chatId && pending.showLoading) setLoadingMessages(false);
      }
    }
  }, []);

  const loadActivities = useCallback(async (chatId: string) => {
    try {
      const result = await window.rambo.activities(chatId);
      if (selectedChatRef.current === chatId) {
        setActivities(current => {
          const merged = new Map(result.map(activity => [activity.id, activity]));
          for (const activity of current) {
            if (activity.chatId === chatId) merged.set(activity.id, activity);
          }
          return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        });
      }
    } catch (error) {
      if (selectedChatRef.current === chatId) setAppError(toError(error));
    }
  }, []);

  const markChatRead = useCallback((chatId: string) => {
    const readAt = new Date().toISOString();
    setSnapshot(current => current ? {
      ...current,
      chats: current.chats.map(item => item.id === chatId
        ? { ...item, lastReadAt: readAt }
        : item),
      unreadCounts: { ...current.unreadCounts, [chatId]: 0 }
    } : current);
    void window.rambo.markChatRead(chatId).catch(error => setAppError(toError(error)));
  }, []);

  const keepVisibleChatRead = useCallback((next: Snapshot): Snapshot => {
    return keepVisibleChatUnreadClear(next, selectedChatRef.current, windowFocusedRef.current);
  }, []);
  const syncVisibleChat = useCallback((chatId: string | null, notifyMain = false) => {
    if (notifyMain) void window.rambo.setVisibleChat(null);
    void window.rambo.setVisibleChatFocus(document.hasFocus())
      .then(() => window.rambo.setVisibleChat(chatId))
      .catch(error => setAppError(toError(error)));
  }, []);

  const updateVoice = useCallback((next: LiveVoiceUi | null | ((current: LiveVoiceUi | null) => LiveVoiceUi | null)) => {
    setVoice(current => {
      const value = typeof next === 'function' ? next(current) : next;
      voiceRef.current = value;
      return value;
    });
  }, []);

  const readVoiceLevels = useCallback(
    (barCount: number) => voiceSessionRef.current?.readInputLevels(barCount) ?? null,
    []
  );

  const startVoice = useCallback(async (chat: Chat) => {
    if (voiceSessionRef.current || voiceRef.current?.state === 'connecting' || voiceRef.current?.state === 'live') return;
    setAppError(null);
    const media = new VoiceMediaSession(chat.id);
    voiceSessionRef.current = media;
    updateVoice({ chatId: chat.id, state: 'connecting', error: null });
    try {
      const offer = await media.start();
      await window.rambo.startVoice(chat.id, offer);
    } catch (error) {
      await media.close();
      if (voiceSessionRef.current === media) voiceSessionRef.current = null;
      updateVoice({ chatId: chat.id, state: 'error', error: toError(error) });
      setAppError(toError(error));
      throw error;
    }
  }, [updateVoice]);

  const stopVoice = useCallback(async (chatId: string, reason?: string) => {
    const active = voiceRef.current;
    if (active) updateVoice({ ...active, state: 'stopping' });
    await voiceSessionRef.current?.close();
    voiceSessionRef.current = null;
    try {
      await window.rambo.stopVoice(chatId, reason);
      updateVoice(null);
    } catch (error) {
      const message = toError(error);
      setAppError(message);
      updateVoice(current => current?.chatId === chatId
        ? { ...current, state: 'error', error: message }
        : current);
    }
  }, [updateVoice]);

  const loadGroupMessages = useCallback(async (groupId: string) => {
    const pending = {
      requestId: ++groupMessageLoadSequenceRef.current,
      streamed: new Map<string, GroupMessage>(),
      removed: new Set<string>()
    };
    pendingGroupMessageLoadsRef.current.set(groupId, pending);
    try {
      const result = await window.rambo.groupMessages(groupId);
      if (selectedGroupRef.current === groupId && pendingGroupMessageLoadsRef.current.get(groupId) === pending) {
        const merged = new Map(result.filter(message => !pending.removed.has(message.id)).map(message => [message.id, message]));
        for (const [id, message] of pending.streamed) {
          if (!pending.removed.has(id)) merged.set(id, message);
        }
        setGroupMessages([...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      }
    } catch (error) {
      if (selectedGroupRef.current === groupId && pendingGroupMessageLoadsRef.current.get(groupId) === pending) {
        setAppError(toError(error));
      }
    } finally {
      if (pendingGroupMessageLoadsRef.current.get(groupId) === pending) {
        pendingGroupMessageLoadsRef.current.delete(groupId);
        if (selectedGroupRef.current === groupId) setLoadingGroupMessages(false);
      }
    }
  }, []);

  const openChat = useCallback(async (chat: Chat) => {
    setSelectedGroupId(null);
    selectedGroupRef.current = null;
    selectedChatRef.current = chat.id;
    setSelectedChatId(chat.id);
    setSelectedBotId(chat.botId);
    setView('chat');
    setMessages([]);
    setActivities([]);
    setLoadingMessages(true);
    setGroupMessages([]);
    setAppError(null);
    transcriptFollowsLatestRef.current = true;
    markChatRead(chat.id);
    syncVisibleChat(chat.id, true);
    void loadActivities(chat.id);
    await loadMessages(chat.id, { clearCurrent: true, showLoading: true, resetStreamBuffer: true });
  }, [loadActivities, loadMessages, markChatRead, syncVisibleChat]);

  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      try {
        const next = await window.rambo.snapshot();
        if (!alive) return;
        setSnapshot(keepVisibleChatRead(next));
        if (!initializedRef.current) {
          initializedRef.current = true;
          if (!firstRunSettingsRef.current && shouldOpenInitialSetup({
            ...next.modelSource,
            runtimeReady: next.runtime.status === 'ready',
            executionDefaultsReady: next.executionDefaults.ready
          }) && next.settings.initialSetupPrompted !== 'true') {
            firstRunSettingsRef.current = true;
            await window.rambo.setSetting('initialSetupPrompted', 'true');
            setSystemSettingsTab('general');
            setView('settings');
          }
          const firstBot = next.bots.find(bot => !bot.archived);
          if (firstBot) {
            setSelectedBotId(firstBot.id);
            const firstChat = sortChats(next.chats, firstBot.id)[0];
            if (firstChat) void openChat(firstChat);
          }
        }
      } catch (error) {
        if (!alive) return;
        setAppError('无法读取本机数据：' + toError(error));
      } finally {
        if (alive) setLoading(false);
      }
    };

    const applyMessage = (message: Message) => {
      const pending = pendingMessageLoadsRef.current.get(message.chatId);
      pending?.streamed.set(message.id, message);
      if (message.role === 'user' || message.role === 'assistant') {
        const visibleAndFocused = selectedChatRef.current === message.chatId && windowFocusedRef.current;
        setSnapshot(current => current ? {
          ...current,
          ...(message.text.trim()
            ? {
                recentMessages: mergeRecentMessage(current.recentMessages, message),
                unreadCounts: mergeUnreadCount(
                  current.unreadCounts,
                  message,
                  visibleAndFocused,
                  seenUnreadItemsRef.current
                )
              }
            : {})
        } : current);
        if (visibleAndFocused && message.role === 'assistant' &&
            message.status !== 'streaming' && message.text.trim()) {
          markChatRead(message.chatId);
        }
      }
      if (selectedChatRef.current === message.chatId) {
        markMessageEntering(message.id);
        setMessages(current => upsertMessage(current, message));
      }
    };

    const flushPendingVoiceMessages = () => {
      if (voiceMessageFrameRef.current !== null) {
        window.cancelAnimationFrame(voiceMessageFrameRef.current);
        voiceMessageFrameRef.current = null;
      }
      const messages = [...pendingVoiceMessagesRef.current.values()];
      pendingVoiceMessagesRef.current.clear();
      for (const message of messages) applyMessage(message);
    };

    const cancelVoiceMessageFrameIfIdle = () => {
      if (pendingVoiceMessagesRef.current.size || voiceMessageFrameRef.current === null) return;
      window.cancelAnimationFrame(voiceMessageFrameRef.current);
      voiceMessageFrameRef.current = null;
    };

    const unsubscribe = window.rambo.onEvent((event: AppEvent) => {
      if (event.type === 'changed') {
        void refresh();
      } else if (event.type === 'message') {
        if (event.message.source === 'voice' && event.message.status === 'streaming') {
          pendingVoiceMessagesRef.current.set(event.message.id, event.message);
          if (voiceMessageFrameRef.current === null) {
            voiceMessageFrameRef.current = window.requestAnimationFrame(() => {
              voiceMessageFrameRef.current = null;
              const messages = [...pendingVoiceMessagesRef.current.values()];
              pendingVoiceMessagesRef.current.clear();
              for (const message of messages) applyMessage(message);
            });
          }
        } else {
          pendingVoiceMessagesRef.current.delete(event.message.id);
          cancelVoiceMessageFrameIfIdle();
          applyMessage(event.message);
        }
      } else if (event.type === 'messageRemoved') {
        pendingVoiceMessagesRef.current.delete(event.messageId);
        cancelVoiceMessageFrameIfIdle();
        pendingMessageLoadsRef.current.get(event.chatId)?.streamed.delete(event.messageId);
        if (selectedChatRef.current === event.chatId) {
          setMessages(current => current.filter(message => message.id !== event.messageId));
        }
      } else if (event.type === 'activity') {
        if (selectedChatRef.current === event.activity.chatId) {
          setActivities(current => {
            const index = current.findIndex(activity => activity.id === event.activity.id);
            if (index < 0) return [...current, event.activity];
            const next = current.slice();
            next[index] = event.activity;
            return next;
          });
        }
      } else if (event.type === 'groupRuntime') {
        setSnapshot(current => {
          if (!current) return current;
          const groupRuntimes = { ...current.groupRuntimes };
          if (event.runtime) groupRuntimes[event.groupId] = event.runtime;
          else delete groupRuntimes[event.groupId];
          return { ...current, groupRuntimes };
        });
      } else if (event.type === 'groupMessage') {
        const pending = pendingGroupMessageLoadsRef.current.get(event.groupId);
        pending?.removed.delete(event.message.id);
        pending?.streamed.set(event.message.id, event.message);
        if (selectedGroupRef.current === event.groupId) {
          markMessageEntering(event.message.id);
          setGroupMessages(current => {
            const next = new Map(current.map(message => [message.id, message]));
            next.set(event.message.id, event.message);
            return [...next.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          });
        }
      } else if (event.type === 'groupMessageRemoved') {
        const pending = pendingGroupMessageLoadsRef.current.get(event.groupId);
        pending?.streamed.delete(event.messageId);
        pending?.removed.add(event.messageId);
        if (selectedGroupRef.current === event.groupId) {
          setGroupMessages(current => current.filter(message => message.id !== event.messageId));
        }
      } else if (event.type === 'runtime') {
        setSnapshot(current => current ? { ...current, runtime: event.state } : current);
      } else if (event.type === 'focusBot') {
        const bot = botsRef.current.find(item => item.id === event.botId);
        if (bot) void chooseBot(bot);
      } else if (event.type === 'groupCreated') {
        setSnapshot(current => current ? {
          ...current,
          groups: [event.group, ...current.groups.filter(group => group.id !== event.group.id)]
        } : current);
        selectedChatRef.current = null;
        setSelectedChatId(null);
        selectedGroupRef.current = event.group.id;
        setSelectedGroupId(event.group.id);
        setGroupMessages([]);
        setLoadingGroupMessages(true);
        setView('group-chat');
        setAppError(null);
        void loadGroupMessages(event.group.id);
      } else if (event.type === 'turn') {
        setSnapshot(current => {
          if (!current) return current;
          const activeTurns = { ...current.activeTurns };
          if (event.turnId) activeTurns[event.chatId] = event.turnId;
          else delete activeTurns[event.chatId];
          return { ...current, activeTurns };
        });
        if (selectedChatRef.current === event.chatId) {
          void loadActivities(event.chatId);
          if (!event.turnId) void loadMessages(event.chatId, { clearCurrent: false, resetStreamBuffer: true });
        }
        if (!event.turnId && selectedChatRef.current === event.chatId && windowFocusedRef.current) {
          markChatRead(event.chatId);
        }
      } else if (event.type === 'startingTurn') {
        setSnapshot(current => {
          if (!current) return current;
          const startingTurns = { ...current.startingTurns };
          if (event.starting) startingTurns[event.chatId] = true;
          else delete startingTurns[event.chatId];
          return { ...current, startingTurns };
        });
      } else if (event.type === 'turnMetadata') {
        // Turn metadata remains persisted by the Host for routine/audit records.
      } else if (event.type === 'voiceState') {
        if (event.session.state === 'error') {
          void voiceSessionRef.current?.close();
          voiceSessionRef.current = null;
        }
        updateVoice({
          chatId: event.session.chatId,
          state: event.session.state,
          error: event.session.error
        });
      } else if (event.type === 'voiceStopFinished') {
        flushPendingVoiceMessages();
        const current = voiceRef.current;
        if (current?.chatId === event.chatId) {
          updateVoice(event.error
            ? { ...current, state: 'error', error: event.error }
            : null);
        }
      } else if (event.type === 'voiceSdp') {
        void (async () => {
          try {
            await voiceSessionRef.current?.applyAnswer(event.sdp);
          } catch (error) {
            const message = '语音媒体协商失败：' + toError(error);
            setAppError(message);
            updateVoice({
              chatId: event.chatId,
              state: 'error',
              error: message
            });
            void voiceSessionRef.current?.close();
            voiceSessionRef.current = null;
            void window.rambo.stopVoice(event.chatId, '媒体协商失败');
          }
        })();
      } else if (event.type === 'voiceEndRequested') {
        flushPendingVoiceMessages();
        if (voiceRef.current?.chatId === event.chatId) {
          updateVoice({ ...voiceRef.current, state: 'stopping' });
        }
        void voiceSessionRef.current?.close();
        voiceSessionRef.current = null;
        void loadMessages(event.chatId, { clearCurrent: false, resetStreamBuffer: true });
      } else if (event.type === 'mcpElicitation') {
        setMcpElicitations(current => current.some(item =>
          item.requestId === event.prompt.requestId)
          ? current
          : [...current, event.prompt]);
      } else if (event.type === 'mcpElicitationResolved') {
        setMcpElicitations(current =>
          current.filter(item => item.requestId !== event.requestId));
      } else if (event.type === 'secretCapture') {
        setSecretCapture(event.prompt);
      } else if (event.type === 'secretCaptureResolved') {
        setSecretCapture(current =>
          current?.requestId === event.requestId ? null : current);
      } else if (event.type === 'error') {
        if (!event.chatId || event.chatId === selectedChatRef.current) setAppError(event.message);
      }
    });

    void refresh();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [keepVisibleChatRead, loadActivities, loadMessages, markChatRead, openChat, updateVoice]);

  useEffect(() => {
    let active = true;
    const refreshModels = () => window.rambo.models().then(options => {
      if (active) {
        setModelOptions(options);
        setModelOptionsError(null);
      }
    }).catch(error => {
      if (active) setModelOptionsError(toError(error));
    });
    void refreshModels();
    const onRuntime = (event: AppEvent) => {
      if (event.type !== 'runtime') return;
      if (event.state.status !== 'ready') {
        setModelOptions([]);
        setModelOptionsError(event.state.error ?? 'App Server 尚未就绪');
        return;
      }
      void refreshModels();
      void window.rambo.snapshot().then(next => {
        if (active) setSnapshot(next);
      }).catch(issue => {
        if (active) setAppError(toError(issue));
      });
    };
    const unsubscribe = window.rambo.onEvent(onRuntime);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const updateFocus = () => {
      windowFocusedRef.current = document.hasFocus();
      void window.rambo.setVisibleChatFocus(windowFocusedRef.current)
        .catch(error => setAppError(toError(error)));
      if (!windowFocusedRef.current || !selectedChatRef.current) return;
      const chatId = selectedChatRef.current;
      markChatRead(chatId);
    };
    window.addEventListener('focus', updateFocus);
    window.addEventListener('blur', updateFocus);
    document.addEventListener('visibilitychange', updateFocus);
    return () => {
      window.removeEventListener('focus', updateFocus);
      window.removeEventListener('blur', updateFocus);
      document.removeEventListener('visibilitychange', updateFocus);
    };
  }, [markChatRead]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const requestId = ++searchRequestRef.current;
    const query = searchQuery.trim();
    if (!searchOpen || !query) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      void window.rambo.search(query, searchBotId === 'all' ? null : searchBotId).then(results => {
        if (searchRequestRef.current === requestId) setSearchResults(results);
      }).catch(() => {
        if (searchRequestRef.current === requestId) setSearchResults([]);
      }).finally(() => {
        if (searchRequestRef.current === requestId) setSearching(false);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [searchOpen, searchQuery, searchBotId]);

  useEffect(() => {
    const sync = () => {
      const visible = view === 'chat' && document.hasFocus() ? selectedChatRef.current : null;
      void window.rambo.setVisibleChatFocus(document.hasFocus())
        .then(() => window.rambo.setVisibleChat(visible))
        .catch(error => setAppError(toError(error)));
    };
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
      void window.rambo.setVisibleChat(null).catch(() => {});
    };
  }, [view, selectedChatId]);

  useEffect(() => {
    singleChatScrollPendingRef.current = true;
  }, [activities, messages, selectedChatId, snapshot?.activeTurns, snapshot?.startingTurns]);

  useLayoutEffect(() => {
    if (!singleChatScrollPendingRef.current) return;
    singleChatScrollPendingRef.current = false;
    const element = scrollRef.current;
    if (!element || !transcriptFollowsLatestRef.current) return;
    element.scrollTop = element.scrollHeight;
  });

  useEffect(() => () => {
    void voiceSessionRef.current?.close();
    voiceSessionRef.current = null;
  }, []);

  const currentSnapshot = snapshot ?? EMPTY_SNAPSHOT;
  botsRef.current = currentSnapshot.bots;
  const botSections = partitionBots(currentSnapshot.bots);
  const activeBots = botSections.active;
  const archivedBots = botSections.archived;
  const archivedGroups = currentSnapshot.archivedGroups ?? [];
  const visibleConversations = sidebarConversations(currentSnapshot.bots, currentSnapshot.groups);
  const currentBot = activeBots.find(bot => bot.id === selectedBotId) ?? null;
  const currentBotExecutionError = currentBot ? botExecutionConfigError(currentBot) : null;
  const settingsBot = currentSnapshot.bots.find(bot => bot.id === selectedBotId) ?? null;
  const currentChat = selectedPrivateChat(currentSnapshot.chats, selectedChatId, selectedBotId);
  const currentVoice = currentChat && voice?.chatId === currentChat.id ? voice : null;
  const currentVoiceLabel = currentVoice ? liveVoiceStatusLabel(currentVoice) : null;
  const currentVoiceError = currentVoice ? voiceErrorPresentation(currentVoice) : null;
  const headerPillRef = useRef<HTMLButtonElement>(null);
  const currentGroup = currentSnapshot.groups.find(group => group.id === selectedGroupId) ?? null;
  const isRunning = currentChat ? Boolean(currentSnapshot.activeTurns[currentChat.id]) : false;
  const isStartingTurn = currentChat ? Boolean(currentSnapshot.startingTurns[currentChat.id]) : false;

  const returnToChat = async () => {
    const target = currentSnapshot.bots.find(bot => bot.id === selectedBotId && !bot.archived)
      ?? currentSnapshot.bots.find(bot => !bot.archived);
    if (target) {
      await chooseBot(target);
      return;
    }
    selectedGroupRef.current = null;
    setSelectedGroupId(null);
    setView('chat');
    setSelectedBotId(null);
    clearSelectedChat();
  };

  const openGroup = (group: GroupChat) => {
    selectedChatRef.current = null;
    setSelectedChatId(null);
    selectedGroupRef.current = group.id;
    setSelectedGroupId(group.id);
    setGroupMessages([]);
    setLoadingGroupMessages(true);
    setView('group-chat');
    setAppError(null);
    void loadGroupMessages(group.id);
  };

  const createGroup = async (title: string, purpose: string, botIds: string[]) => {
    const group = await window.rambo.createGroup({ title, purpose, botIds });
    setSnapshot(current => current
      ? { ...current, groups: [group, ...current.groups.filter(item => item.id !== group.id)] }
      : current);
    selectedChatRef.current = null;
    setSelectedChatId(null);
    setSelectedGroupId(group.id);
    selectedGroupRef.current = group.id;
    setGroupMessages([]);
    setLoadingGroupMessages(true);
    setView('group-chat');
    setAppError(null);
    void loadGroupMessages(group.id);
    return group;
  };
  const addGroupMembers = async (groupId: string, botIds: string[]) => {
    const group = await window.rambo.addGroupMembers(groupId, botIds);
    setSnapshot(current => current
      ? { ...current, groups: current.groups.map(item => item.id === group.id ? group : item) }
      : current);
    setView('group-chat');
    setAppError(null);
    return group;
  };
  const updateGroupPurpose = async (groupId: string, purpose: string) => {
    const group = await window.rambo.updateGroupPurpose(groupId, purpose);
    setSnapshot(current => current
      ? { ...current, groups: current.groups.map(item => item.id === group.id ? group : item) }
      : current);
    setAppError(null);
    return group;
  };
  const removeGroupMembers = async (groupId: string, botIds: string[]) => {
    const group = await window.rambo.removeGroupMembers(groupId, botIds);
    setSnapshot(current => current
      ? { ...current, groups: current.groups.map(item => item.id === group.id ? group : item) }
      : current);
    setAppError(null);
    return group;
  };

  const createBot = async (name: string, avatar: string) => {
    setCreateBusy(true);
    setAppError(null);
    try {
      const result = await window.rambo.createBot({ name, avatar });
      setSnapshot(current => current
        ? {
            ...current,
            bots: current.bots.some(bot => bot.id === result.bot.id)
              ? current.bots.map(bot => bot.id === result.bot.id ? result.bot : bot)
              : [...current.bots, result.bot],
            chats: current.chats.some(chat => chat.id === result.chat.id)
              ? current.chats.map(chat => chat.id === result.chat.id ? result.chat : chat)
              : [result.chat, ...current.chats]
          }
        : current);
      setCreateOpen(false);
      setSelectedBotId(result.bot.id);
      await openChat(result.chat);
    } catch (error) {
      setAppError(toError(error));
      throw error;
    } finally {
      setCreateBusy(false);
    }
  };

  const chooseBot = async (bot: Bot) => {
    const existingChat = sortChats(currentSnapshot.chats, bot.id)[0];
    if (view === 'chat' && selectedBotId === bot.id && currentChat?.id === existingChat?.id) return;
    setSelectedGroupId(null);
    selectedGroupRef.current = null;
    setView('chat');
    setSelectedBotId(bot.id);
    setAppError(null);
    try {
      const chat = existingChat ?? await window.rambo.ensureBotChat(bot.id);
      setSnapshot(current => current
        ? { ...current, chats: [chat, ...current.chats.filter(item => item.id !== chat.id)] }
        : current);
      await openChat(chat);
    } catch (error) {
      setAppError(toError(error));
    }
  };

  const saveBot = async (id: string, patch: Partial<Pick<Bot, 'name' | 'avatar' | 'role' | 'instructions'>>) => {
    const updated = await window.rambo.updateBot(id, patch);
    setSnapshot(current => current
      ? { ...current, bots: current.bots.map(bot => bot.id === id ? updated : bot) }
      : current);
  };

  const openBotSettings = (bot: Bot) => {
    setSelectedGroupId(null);
    selectedGroupRef.current = null;
    setSelectedBotId(bot.id);
    setView('bot-settings');
    setAppError(null);
  };

  const openSettings = (tab: SystemSettingsTab = 'general') => {
    setSystemSettingsTab(tab);
    setView('settings');
    setAppError(null);
  };

  const openConnectors = () => {
    setView('connectors');
    setAppError(null);
  };

  const closeSearch = () => {
    searchRequestRef.current += 1;
    setSearchOpen(false);
    setSearchQuery('');
    setSearchBotId('all');
    setSearchResults([]);
  };

  const openSearch = () => {
    setSearchBotId(currentBot?.id ?? 'all');
    setSearchOpen(true);
  };

  const clearSelectedChat = () => {
    selectedChatRef.current = null;
    setSelectedChatId(null);
    setMessages([]);
    setActivities([]);
    setLoadingMessages(false);
    syncVisibleChat(null);
  };

  const setBotArchived = async (botId: string, archived: boolean) => {
    await window.rambo.setBotArchived(botId, archived);
    setSnapshot(await window.rambo.snapshot());
    if (archived) setSearchBotId(current => current === botId ? 'all' : current);
    setAppError(null);
  };

  const setConversationPinned = async (menu: NonNullable<typeof sidebarMenu>) => {
    setSidebarMenu(null);
    try {
      if (menu.kind === 'bot') {
        const pinned = !menu.bot.pinnedAt;
        await window.rambo.setBotPinned(menu.bot.id, pinned);
        setSnapshot(await window.rambo.snapshot());
        setSidebarNotice(pinned ? `已置顶 ${menu.bot.name}` : `已取消置顶 ${menu.bot.name}`);
      } else {
        const pinned = !menu.group.pinnedAt;
        await window.rambo.setGroupPinned(menu.group.id, pinned);
        setSnapshot(await window.rambo.snapshot());
        setSidebarNotice(pinned ? `已置顶群聊 ${menu.group.title}` : `已取消置顶群聊 ${menu.group.title}`);
      }
      setAppError(null);
    } catch (error) {
      setAppError(toError(error));
    }
  };

  const restoreBot = async (botId: string) => {
    try { await setBotArchived(botId, false); }
    catch (error) { setAppError(toError(error)); }
  };

  const updateBotExecutionConfig = async (id: string, patch: { model: string; permission: PermissionMode }) => {
    const bot = await window.rambo.updateBotExecutionConfig(id, patch);
    setSnapshot(current => current
      ? { ...current, bots: current.bots.map(item => item.id === bot.id ? bot : item) }
      : current);
  };

  const permanentlyDeleteBot = async () => {
    if (!deletingBot) return;
    const target = deletingBot;
    await window.rambo.deleteBot(target.id);
    const nextSnapshot = await window.rambo.snapshot();
    setSnapshot(nextSnapshot);
    setDeletingBot(null);
    if (selectedBotId === target.id) {
      const nextBot = nextSnapshot.bots.find(bot => !bot.archived);
      setSelectedGroupId(null);
      setView('chat');
      if (nextBot) {
        const nextChat = sortChats(nextSnapshot.chats, nextBot.id)[0];
        if (nextChat) void openChat(nextChat);
        else {
          setSelectedBotId(nextBot.id);
          clearSelectedChat();
        }
      } else {
        setSelectedBotId(null);
        clearSelectedChat();
      }
    }
  };

  const archiveGroupFromSidebar = async (group: GroupChat) => {
    setSidebarMenu(null);
    try {
      await window.rambo.setGroupArchived(group.id, true);
      const next = await window.rambo.snapshot();
      setSnapshot(next);
      setSidebarNotice(`已归档群聊 ${group.title}`);
      if (selectedGroupId === group.id) await returnToChat();
    } catch (error) { setAppError(toError(error)); }
  };

  const restoreGroup = async (groupId: string) => {
    try {
      await window.rambo.setGroupArchived(groupId, false);
      setSnapshot(await window.rambo.snapshot());
      setAppError(null);
    } catch (error) { setAppError(toError(error)); }
  };

  const permanentlyDeleteGroup = async () => {
    if (!deletingGroup) return;
    const target = deletingGroup;
    await window.rambo.deleteGroup(target.id);
    setSnapshot(await window.rambo.snapshot());
    setDeletingGroup(null);
    if (selectedGroupId === target.id) await returnToChat();
  };

  const openSidebarMenu = (
    event: React.MouseEvent,
    target: { kind: 'bot'; bot: Bot; chat: Chat | null } | { kind: 'group'; group: GroupChat }
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (target.kind === 'bot' && !target.chat) return;
    const width = 196;
    const height = target.kind === 'bot' ? 202 : 164;
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8));
    setSidebarNotice(null);
    setSidebarMenu(target.kind === 'bot'
      ? { kind: 'bot', bot: target.bot, conversationId: target.chat!.id, x, y }
      : { kind: 'group', group: target.group, conversationId: target.group.id, x, y });
  };

  const copySidebarChatId = async (conversationId: string) => {
    setSidebarMenu(null);
    try {
      await window.rambo.copyText(conversationId);
      setSidebarNotice('对话 ID 已复制');
    } catch (error) {
      setAppError(toError(error));
    }
  };

  const copyBotFromSidebar = async (menu: NonNullable<typeof sidebarMenu>) => {
    setSidebarMenu(null);
    if (menu.kind !== 'bot') return;
    try {
      const result = await window.rambo.copyBot(menu.bot.id);
      setSnapshot(current => current
        ? {
            ...current,
            bots: current.bots.some(bot => bot.id === result.bot.id)
              ? current.bots.map(bot => bot.id === result.bot.id ? result.bot : bot)
              : [...current.bots, result.bot],
            chats: current.chats.some(chat => chat.id === result.chat.id)
              ? current.chats.map(chat => chat.id === result.chat.id ? result.chat : chat)
              : [result.chat, ...current.chats]
          }
        : current);
      setSelectedGroupId(null);
      selectedGroupRef.current = null;
      setView('chat');
      setSelectedBotId(result.bot.id);
      await openChat(result.chat);
      setSidebarNotice(`已复制 Bot：${result.bot.name}`);
      setAppError(null);
    } catch (error) {
      setAppError(toError(error));
    }
  };

  const archiveFromSidebar = async (menu: NonNullable<typeof sidebarMenu>) => {
    setSidebarMenu(null);
    if (menu.kind === 'bot') {
      try {
        await setBotArchived(menu.bot.id, true);
        setSidebarNotice(`已归档 ${menu.bot.name}`);
      } catch (error) { setAppError(toError(error)); }
    } else await archiveGroupFromSidebar(menu.group);
  };

  const deleteFromSidebar = (menu: NonNullable<typeof sidebarMenu>) => {
    setSidebarMenu(null);
    if (menu.kind === 'bot') setDeletingBot(menu.bot);
    else setDeletingGroup(menu.group);
  };

  return (
    <div className={'app-shell' + (compactSidebar ? ' sidebar-compact' : '')}>
      <div className="app-content">
      <aside className="sidebar">
        <header className="sidebar-topbar">
          <div className="titlebar-safe-area" aria-hidden="true" />
          <div className="sidebar-topbar-actions">
            <button type="button" className="toolbar-button" aria-label={compactSidebar ? '展开侧栏' : '收起侧栏'}
              title={compactSidebar ? '展开侧栏' : '收起侧栏'} onClick={() => setCompactSidebar(value => !value)}>
              <Icon name="panel" size={17} />
            </button>
            <button type="button" className="toolbar-button" aria-label="搜索" title="搜索"
              onClick={openSearch}>
              <Icon name="search" size={17} />
            </button>
            <button type="button" className="toolbar-button" aria-label="创建 Bot" title="创建 Bot"
              onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={18} />
            </button>
            <button type="button" className="toolbar-button" aria-label="新建群聊" title="新建群聊"
              onClick={() => { setGroupCreateReturnView(view); setView('group-create'); setAppError(null); }}>
              <Icon name="users" size={17} />
            </button>
          </div>
        </header>
        <div className="sidebar-scroll">
          {loading ? (
            <div className="sidebar-hint">正在读取…</div>
          ) : (
            <>
              <div className="bot-list" aria-label="会话列表">
                {visibleConversations.map(item => {
                  if (item.kind === 'bot') {
                    const bot = item.bot;
                    const chat = privateChatForBot(currentSnapshot.chats, bot.id);
                    const running = Boolean(chat && (
                      currentSnapshot.activeTurns[chat.id] || currentSnapshot.startingTurns[chat.id]
                    ));
                    const preview = chat ? currentSnapshot.recentMessages[chat.id]?.trim() : '';
                    return (
                      <div
                        className="bot-group"
                        key={bot.id}
                      >
                        <div className={'bot-list-row' + (bot.pinnedAt ? ' pinned' : '') + (selectedBotId === bot.id && view === 'chat' ? ' selected' : '')}
                          data-pinned={bot.pinnedAt ? 'true' : undefined}
                          data-avatar-follow-region=""
                          data-running={running ? 'true' : undefined}
                          onContextMenu={event => openSidebarMenu(event, { kind: 'bot', bot, chat })}>
                          <button type="button" className="bot-select" onClick={() => void chooseBot(bot)}
                            aria-current={selectedBotId === bot.id && view === 'chat' ? 'true' : undefined}>
                            <span className="bot-avatar-wrap">
                              <Avatar value={bot.avatar} size="sidebar" followOnHover />
                              <UnreadBadge count={chat ? currentSnapshot.unreadCounts[chat.id] ?? 0 : 0} />
                            </span>
                            <span className="bot-card-copy">
                              <span className="bot-row-name"><span>{bot.name}</span></span>
                              <span className="bot-row-summary">{preview || bot.role.trim() || '开始聊天'}</span>
                            </span>
                          </button>
                        </div>
                      </div>
                    );
                  }
                  const group = item.group;
                  const members = group.memberIds.map(id => currentSnapshot.bots.find(bot => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
                  return (
                    <div
                      className="bot-group"
                      key={group.id}
                    >
                      <div className={'bot-list-row' + (group.pinnedAt ? ' pinned' : '') + (selectedGroupId === group.id && view === 'group-chat' ? ' selected' : '')}
                        data-pinned={group.pinnedAt ? 'true' : undefined}
                        onContextMenu={event => openSidebarMenu(event, { kind: 'group', group })}>
                        <button type="button" className="bot-select" onClick={() => openGroup(group)}
                          aria-current={selectedGroupId === group.id && view === 'group-chat' ? 'page' : undefined}>
                          <GroupAvatar group={group} bots={currentSnapshot.bots} />
                          <span className="bot-card-copy">
                            <span className="bot-row-name"><span>{group.title}</span></span>
                            <span className="bot-row-summary">{members.map(bot => bot.name).join('、') || '群聊'}</span>
                          </span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {archivedBots.length > 0 && (
                <section className="archived-bot-list" aria-label="已归档的 Bot">
                  <div className="archived-bot-heading">已归档的 Bot</div>
                  {archivedBots.map(bot => (
                    <div className="archived-bot-row" key={bot.id}>
                      <button type="button" className="archived-bot-select" onClick={() => openBotSettings(bot)}>
                        <Avatar value={bot.avatar} size="small" />
                        <span>{bot.name}</span>
                      </button>
                      <button type="button" className="restore-inline-button" aria-label={'恢复 ' + bot.name}
                        onClick={() => void restoreBot(bot.id)}>恢复</button>
                    </div>
                  ))}
                </section>
              )}
              {archivedGroups.length > 0 && (
                <section className="archived-bot-list" aria-label="已归档的群聊">
                  <div className="archived-bot-heading">已归档的群聊</div>
                  {archivedGroups.map(group => (
                    <div className="archived-bot-row" key={group.id}>
                      <div className="archived-bot-select archived-group-label">
                        <GroupAvatar group={group} bots={currentSnapshot.bots} />
                        <span>{group.title}</span>
                      </div>
                      <button type="button" className="restore-inline-button" aria-label={'恢复群聊 ' + group.title}
                        onClick={() => void restoreGroup(group.id)}>恢复</button>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>

        <div className="sidebar-footer">
          <button type="button" className={'account-button' + (view === 'settings' ? ' selected' : '')}
            aria-label="设置" title="设置" onClick={() => openSettings()}>
            <span className="account-dot"><img className="app-brand-avatar" src={appAvatarUrl} alt="Rambo" /></span>
          </button>
          <button type="button" className={'sidebar-connectors-button' + (view === 'connectors' ? ' selected' : '')}
            aria-label="连接应用" title="连接应用" aria-current={view === 'connectors' ? 'page' : undefined}
            onClick={openConnectors}>
            <Icon name="connectors" size={16} />
            <span>连接应用</span>
          </button>
        </div>
      </aside>

      <main className={'main-pane' + (view === 'chat' || view === 'group-chat' ? ' chat-surface' : '')}>
        <div className="main-titlebar-spacer" aria-hidden="true" />
        <header className="chat-header">
          {shouldShowReturnToChat(view) && (
            <button type="button" className="back-button" onClick={() => void returnToChat()}>
              <Icon name="back" size={16} />
              <span>返回聊天</span>
            </button>
          )}
          {view === 'chat' && currentBot && (
            <span
              className={'current-bot-pill-shell' + (currentVoiceError ? ' current-bot-pill-shell-error' : '')}
              role={currentVoiceError ? 'group' : undefined}
              aria-label={currentVoiceError ? `${currentVoiceError.title}：${currentVoiceError.detail}` : undefined}
            >
              <button type="button"
                ref={headerPillRef}
                className={'current-bot-pill current-bot-pill-button' +
                  (currentVoice ? ' current-bot-pill-voice' : '')}
                aria-label={currentVoiceError ? `${currentVoiceError.title}：${currentVoiceError.detail}` : currentVoiceLabel ?? `打开 ${currentBot.name} 设置`}
                aria-disabled={currentVoice ? 'true' : undefined}
                title={currentVoiceError ? `${currentVoiceError.title}：${currentVoiceError.detail}` : currentVoiceLabel ?? '打开 Bot 设置'}
                data-voice-state={currentVoice?.state}
                data-voice-color={currentVoice ? parseRobotAvatar(currentBot.avatar).color : undefined}
                style={currentVoice ? voiceAccentStyle(currentBot.avatar) : undefined}
                onClick={() => {
                  if (!currentVoice) openBotSettings(currentBot);
                }}>
                <span className="current-bot-avatar">
                  <Avatar value={currentBot.avatar} size="sidebar" animated={Boolean(currentVoice)} />
                  {currentVoice?.state === 'connecting' && (
                    <span className="chat-voice-connect-loader" aria-hidden="true">
                      <span className="chat-voice-connect-orbit" />
                      <span className="chat-voice-connect-core" />
                    </span>
                  )}
                </span>
                <span className="current-bot-name">{currentBot.name}</span>
                {(currentVoice?.state === 'live' || currentVoice?.state === 'stopping') && (
                  <VoiceWaveform
                    state={currentVoice.state}
                    levels={currentVoice.state === 'live' ? readVoiceLevels : undefined}
                  />
                )}
                {currentVoiceError && (
                  <span className="current-bot-voice-error">
                    <span className="current-bot-voice-error-title">{currentVoiceError.title}</span>
                    <span className="current-bot-voice-error-detail">{currentVoiceError.detail}</span>
                  </span>
                )}
                <span className="current-bot-pill-chevron"><Icon name="chevron" size={13} /></span>
              </button>
              {currentVoice?.state === 'live' && (
                <button type="button" className="chat-voice-end-button"
                  aria-label="结束当前语音通话" title="结束语音"
                  onClick={() => void stopVoice(currentVoice.chatId, '用户点击了结束语音')}>
                  <Icon name="close" size={15} />
                </button>
              )}
              {currentVoiceError && currentChat && (
                <button type="button" className="current-bot-voice-retry"
                  aria-label="重新拨号"
                  title="重新拨号"
                  onClick={() => void startVoice(currentChat)}>
                  <Icon name="voice" size={16} />
                </button>
              )}
            </span>
          )}
          {view === 'group-chat' && currentGroup && (
            <div className="current-bot-pill">
              <GroupAvatar group={currentGroup} bots={currentSnapshot.bots} size="regular" />
              <span>{currentGroup.title}</span>
              <button type="button" className="group-member-button" aria-label="群聊成员设置"
                onClick={() => { setView('group-members'); setAppError(null); }}>
                成员
              </button>
            </div>
          )}
        </header>

        {appError && (
          <div className="inline-error" role="status">
            <span>{appError}</span>
            <button type="button" aria-label="关闭错误提示" onClick={() => setAppError(null)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}

        {view === 'group-create' ? (
          <CreateGroupPage bots={activeBots} onCancel={() => setView(groupCreateReturnView)} onCreate={createGroup} />
        ) : view === 'group-members' && currentGroup ? (
          <AddGroupMembersPage
            group={currentGroup}
            bots={currentSnapshot.bots}
            onCancel={() => setView('group-chat')}
            onAdd={botIds => addGroupMembers(currentGroup.id, botIds)}
            onUpdatePurpose={purpose => updateGroupPurpose(currentGroup.id, purpose)}
            onRemove={botIds => removeGroupMembers(currentGroup.id, botIds)}
          />
        ) : view === 'group-chat' && currentGroup ? (
            <GroupChatPage key={currentGroup.id} group={currentGroup} bots={currentSnapshot.bots} messages={groupMessages}
            runtime={currentSnapshot.groupRuntimes[currentGroup.id] ?? null}
            enteringMessageIds={enteringMessageIds}
            loading={loadingGroupMessages}
            onError={error => setAppError(error)} onSend={async text => {
              setAppError(null);
              try { await window.rambo.sendGroup(currentGroup.id, text); }
              catch (error) { setAppError(toError(error)); throw error; }
            }} onStop={async () => {
              setAppError(null);
              try { await window.rambo.interruptGroup(currentGroup.id); }
              catch (error) { setAppError(toError(error)); }
            }} />
        ) : view === 'group-chat' ? (
          <div className="page-loading">找不到这个群聊</div>
        ) : view === 'settings' ? (
          <AccountSettingsPage
            activeTab={systemSettingsTab}
            onTabChange={setSystemSettingsTab}
            runtime={currentSnapshot.runtime}
            codexHome={currentSnapshot.codexHome}
            runtimeProxy={currentSnapshot.runtimeProxy}
            modelSource={currentSnapshot.modelSource}
            notificationUnavailable={currentSnapshot.notifications.unavailableMessage}
            launchAtLogin={currentSnapshot.settings.launchAtLogin !== 'false'}
            globalModel={currentSnapshot.settings.defaultBotModel ?? ''}
            globalPermission={permissionModeFromSetting(currentSnapshot.settings.defaultBotPermission)}
            executionDefaultsReady={currentSnapshot.executionDefaults.ready}
            executionDefaultsError={currentSnapshot.executionDefaults.error}
            resources={currentSnapshot.botResources}
            globalResourceIds={currentSnapshot.globalResourceIds}
            globalDefaultResourceIds={currentSnapshot.globalDefaultResourceIds}
            directMcpServers={currentSnapshot.directMcpServers}
            playwrightVerifiedAt={currentSnapshot.settings.playwrightVerifiedAt ?? ''}
            models={modelOptions}
            modelError={modelOptionsError}
            bots={currentSnapshot.bots}
            routines={currentSnapshot.routines}
            runs={currentSnapshot.routineRuns}
            onSetGlobalModel={value => window.rambo.setSetting('defaultBotModel', value)}
            onSetGlobalPermission={value => window.rambo.setSetting('defaultBotPermission', value)}
            onSetGlobalResource={async (resourceId, included) => {
              await window.rambo.setGlobalResource(resourceId, included);
              setSnapshot(await window.rambo.snapshot());
            }}
            onSetDirectMcpEnabled={async (id, enabled) => {
              const server = await window.rambo.setDirectMcpEnabled(id, enabled);
              setSnapshot(await window.rambo.snapshot());
              return server;
            }}
            onDeleteDirectMcp={async id => {
              await window.rambo.deleteDirectMcp(id);
              setSnapshot(await window.rambo.snapshot());
            }}
            onSetGlobalDefaultResource={async (resourceId, enabled) => {
              await window.rambo.setGlobalDefaultResource(resourceId, enabled);
              setSnapshot(await window.rambo.snapshot());
            }}
            onVerifyPlaywrightConnection={async () => {
              const result = await window.rambo.verifyPlaywrightConnection();
              setSnapshot(await window.rambo.snapshot());
              return result;
            }}
            onCancelPlaywrightVerification={() => window.rambo.cancelPlaywrightVerification()}
            onSetLaunchAtLogin={async enabled => {
              const previous = currentSnapshot.settings.launchAtLogin;
              setSnapshot(current => current
                ? { ...current, settings: { ...current.settings, launchAtLogin: String(enabled) } }
                : current);
              try {
                await window.rambo.setLaunchAtLogin(enabled);
              } catch (error) {
                setSnapshot(current => {
                  if (!current) return current;
                  const settings = { ...current.settings };
                  if (previous === undefined) delete settings.launchAtLogin;
                  else settings.launchAtLogin = previous;
                  return { ...current, settings };
                });
                throw error;
              }
            }}
            onSetRuntimeProxy={async value => {
              await window.rambo.setSetting('runtimeProxy', value);
              setSnapshot(await window.rambo.snapshot());
            }}
            onSetModelSource={async kind => {
              const source = await window.rambo.setModelSource(kind);
              setSnapshot(await window.rambo.snapshot());
              return source;
            }}
            onSaveManualModelSource={async input => {
              const source = await window.rambo.saveManualModelSource(input);
              setSnapshot(await window.rambo.snapshot());
              return source;
            }}
            onTestModelConnection={source => window.rambo.testModelConnection(source)}
            onSetRoutineStatus={async (routineId, status) => {
              await window.rambo.setRoutineStatus(routineId, status);
              setSnapshot(current => current ? {
                ...current,
                routines: current.routines.map(item => item.id === routineId ? { ...item, status } : item)
              } : current);
              setSnapshot(await window.rambo.snapshot());
            }}
            onRunRoutineNow={async routineId => {
              const run = await window.rambo.runRoutineNow(routineId);
              setSnapshot(await window.rambo.snapshot());
              return run;
            }}
            onStopRoutineRun={async routineId => {
              const run = await window.rambo.stopRoutineRun(routineId);
              setSnapshot(await window.rambo.snapshot());
              return run;
            }}
          />
        ) : view === 'connectors' ? (
          <ConnectorsPage providers={currentSnapshot.connectorProviders}
            connections={currentSnapshot.connections} grants={currentSnapshot.connectorGrants}
            currentBotId={selectedBotId}
            onConnect={provider => setConnectorDialog({ mode: 'connect', provider, connection: null })}
            onManage={(provider, connection) => setConnectorDialog({ mode: 'manage', provider, connection })} />
        ) : view === 'bot-settings' && settingsBot ? (
          <BotSettingsPage key={settingsBot.id} bot={settingsBot}
            models={modelOptions} modelError={modelOptionsError}
            resources={currentSnapshot.botResources.filter(resource =>
              currentSnapshot.globalResourceIds.includes(resource.id))}
            routines={currentSnapshot.routines.filter(routine => routine.botId === settingsBot.id)}
            runs={currentSnapshot.routineRuns}
            onSave={saveBot} onUpdateExecution={updateBotExecutionConfig}
            onSetResource={async (resourceId, enabled) => {
              const bot = await window.rambo.setBotResource(settingsBot.id, resourceId, enabled);
              setSnapshot(current => current
                ? { ...current, bots: current.bots.map(item => item.id === bot.id ? bot : item) }
                : current);
            }}
            onSetArchived={setBotArchived} onRequestDelete={() => setDeletingBot(settingsBot)} />
        ) : view === 'chat' && !loading && !currentBot ? (
          <div className="empty-chat-workspace" />
        ) : view === 'chat' && currentBot && !currentChat ? (
          <NoChatWorkspace bot={currentBot} onOpen={() => void chooseBot(currentBot)} />
        ) : view === 'chat' && currentBot ? (
          <div className="chat-workspace">
            <div className="transcript-scroll" ref={scrollRef}
              onScroll={event => {
                const element = event.currentTarget;
                const followsLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
                transcriptFollowsLatestRef.current = followsLatest;
              }}>
              {loadingMessages ? (
                <div className="messages-loading" aria-label="正在读取聊天" />
              ) : (
                <div className="message-column">
                  {messages.map((message, index) => (
                    <Fragment key={message.id}>
                      {shouldShowMessageTimeDivider(messages, index) && (
                        <MessageTimeDivider value={message.createdAt} />
                      )}
                      <MessageRow
                        message={message}
                        entering={enteringMessageIds.has(message.id)}
                      />
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
            <ChatScrollbar scrollRef={scrollRef} />
            <div className="chat-bottom-dock">
              {currentChat && currentBot && (
                <div className="chat-running-dock">
                  <AgentRunningRow
                    visible={isRunning || isStartingTurn}
                    bots={[currentBot]}
                    autoAnimate
                    label={(() => {
                      const latest = activities
                        .filter(activity =>
                          activity.chatId === currentChat.id &&
                          activity.turnId === currentSnapshot.activeTurns[currentChat.id]
                        )
                        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
                        .at(-1);
                      if (isStartingTurn) return '正在读消息';
                      return latest ? ACTIVITY_LABELS[latest.kind] : '正在思考';
                    })()} />
                </div>
              )}
              {currentChat && (
                <>
                  <Composer
                    key={currentChat.id}
                    busy={isRunning}
                    disabled={Boolean(currentBotExecutionError)}
                    disabledReason={currentBotExecutionError}
                    placeholder={`发消息给 ${currentBot?.name ?? '机器人'}`}
                    onSend={async text => {
                      setAppError(null);
                      try {
                        transcriptFollowsLatestRef.current = true;
                        await window.rambo.send(currentChat.id, text);
                      } catch (error) {
                        setAppError(toError(error));
                        throw error;
                      }
                    }}
                    onStop={async () => {
                      setAppError(null);
                      try { await window.rambo.interrupt(currentChat.id); }
                      catch (error) { setAppError(toError(error)); }
                    }}
                    voiceState={voice?.chatId === currentChat.id ? voice.state : null}
                    onStartVoice={() => void startVoice(currentChat)}
                    onStopVoice={() => void stopVoice(currentChat.id, '用户点击了结束语音')}
                  />
                  {currentBotExecutionError && (
                    <div className="form-error composer-readiness-error" role="status">
                      {currentBotExecutionError}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="page-loading">正在读取…</div>
        )}
      </main>
      </div>

      {searchOpen && (
        <div className="search-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeSearch(); }}>
          <section className="search-panel" aria-label="搜索对话">
            <div className="search-input-row">
              <Icon name="search" size={17} />
              <input ref={searchInputRef} value={searchQuery} type="search" placeholder="搜索对话内容"
                aria-label="搜索对话内容" onChange={event => setSearchQuery(event.target.value)}
                onKeyDown={event => { if (event.key === 'Escape') closeSearch(); }} />
              <button type="button" className="search-close" aria-label="关闭搜索" onClick={closeSearch}>
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="search-scope-row">
              <label htmlFor="search-bot-scope">范围</label>
              <select id="search-bot-scope" className="search-scope-select" aria-label="搜索范围"
                value={searchBotId} onChange={event => setSearchBotId(event.target.value)}>
                <option value="all">所有 Bot</option>
                {activeBots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
            </div>
            <div className="search-results">
              {searching ? <div className="search-hint">搜索中…</div> : searchQuery.trim() && searchResults.length === 0
                ? <div className="search-hint">没有匹配的消息</div>
                : !searchQuery.trim() ? <div className="search-hint">输入关键词搜索消息</div>
                : searchResults.map(result => (
                  <button type="button" className="search-result" key={result.message.id}
                    onClick={() => { closeSearch(); void openChat(result.chat); }}>
                    <Avatar value={result.bot.avatar} size="small" />
                    <span className="search-result-copy">
                      <strong>{result.bot.name}</strong>
                      <span>{result.message.text}</span>
                    </span>
                  </button>
                ))}
            </div>
          </section>
        </div>
      )}

      {createOpen && (
        <CreateBotDialog
          busy={createBusy}
          readinessError={currentSnapshot.executionDefaults.ready
            ? null
            : currentSnapshot.executionDefaults.error}
          onCancel={() => setCreateOpen(false)}
          onCreate={createBot}
        />
      )}
      {sidebarMenu && (
        <div className="sidebar-context-menu" role="menu"
          aria-label={`${sidebarMenu.kind === 'bot' ? sidebarMenu.bot.name : sidebarMenu.group.title} 会话菜单`}
          style={{ left: sidebarMenu.x, top: sidebarMenu.y }}
          onPointerDown={event => event.stopPropagation()}
          onContextMenu={event => event.preventDefault()}>
          <button type="button" role="menuitem"
            className="sidebar-context-menu-text-only"
            onClick={() => void setConversationPinned(sidebarMenu)}>
            <span>{(sidebarMenu.kind === 'bot' ? sidebarMenu.bot.pinnedAt : sidebarMenu.group.pinnedAt)
              ? '取消置顶'
              : '置顶'}</span>
          </button>
          <button type="button" role="menuitem"
            onClick={() => void copySidebarChatId(sidebarMenu.conversationId)}>
            <Icon name="copy" size={14} />
            <span>复制对话 ID</span>
          </button>
          {sidebarMenu.kind === 'bot' && (
            <button type="button" role="menuitem"
              onClick={() => void copyBotFromSidebar(sidebarMenu)}>
              <Icon name="copy" size={14} />
              <span>复制 Bot</span>
            </button>
          )}
          <button type="button" role="menuitem"
            onClick={() => void archiveFromSidebar(sidebarMenu)}>
            <Icon name="archive" size={14} />
            <span>{sidebarMenu.kind === 'bot' ? '归档 Bot' : '归档群聊'}</span>
          </button>
          <button type="button" role="menuitem" className="danger"
            onClick={() => deleteFromSidebar(sidebarMenu)}>
            <Icon name="trash" size={14} />
            <span>{sidebarMenu.kind === 'bot' ? '永久删除 Bot…' : '永久删除群聊…'}</span>
          </button>
        </div>
      )}
      {sidebarNotice && (
        <div className="sidebar-notice" role="status">{sidebarNotice}</div>
      )}
      {deletingBot && (
        <ConfirmationDialog
          title={`永久删除「${deletingBot.name}」？`}
          description="将删除该 Bot 在 Rambo 中的聊天、记忆、例程和专属工作区。只清理应用管理目录，不扫描或清理其他 Mac 路径。此操作不可撤销。"
          confirmLabel="永久删除 Bot"
          onCancel={() => setDeletingBot(null)}
          onConfirm={permanentlyDeleteBot}
        />
      )}
      {deletingGroup && (
        <ConfirmationDialog
          title={`永久删除群聊「${deletingGroup.title}」？`}
          description="将删除群聊消息、成员关系及该群聊专属的 Codex 会话线程。此操作不可撤销。"
          confirmLabel="永久删除群聊"
          onCancel={() => setDeletingGroup(null)}
          onConfirm={permanentlyDeleteGroup}
        />
      )}
      {mcpElicitations[0] && (
        <McpElicitationDialog
          prompt={mcpElicitations[0]}
          busy={mcpElicitationBusy}
          onAction={async action => {
            const prompt = mcpElicitations[0];
            setMcpElicitationBusy(true);
            setAppError(null);
            try {
              await window.rambo.respondMcpElicitation(prompt.requestId, action);
              setMcpElicitations(current =>
                current.filter(item => item.requestId !== prompt.requestId));
            } catch (error) {
              setAppError(toError(error));
            } finally {
              setMcpElicitationBusy(false);
            }
          }}
        />
      )}
      {secretCapture && (
        <SecretCaptureDialog
          prompt={secretCapture}
          onCancel={async () => {
            const requestId = secretCapture.requestId;
            setSecretCapture(current =>
              current?.requestId === requestId ? null : current);
            try {
              await window.rambo.cancelSecretCapture(requestId);
            } catch (error) {
              setAppError(toError(error));
            }
          }}
          onSave={async secret => {
            const requestId = secretCapture.requestId;
            await window.rambo.completeSecretCapture(requestId, secret);
            setSecretCapture(current =>
              current?.requestId === requestId ? null : current);
          }}
        />
      )}
      {connectorDialog && (
        <ConnectorDialog
          mode={connectorDialog.mode}
          provider={connectorDialog.provider}
          connection={connectorDialog.connection}
          grants={currentSnapshot.connectorGrants}
          bots={activeBots}
          onClose={() => setConnectorDialog(null)}
          onComplete={async input => {
            const connection = await window.rambo.completeConnectorAuth(input);
            setSnapshot(await window.rambo.snapshot());
            setConnectorDialog({ mode: 'manage', provider: connectorDialog.provider, connection });
          }}
          onOAuthComplete={async connection => {
            setSnapshot(await window.rambo.snapshot());
            setConnectorDialog({ mode: 'manage', provider: connectorDialog.provider, connection });
          }}
          onGrant={async (botId, connectionId, granted) => {
            await window.rambo.setConnectorGrant(botId, connectionId, granted);
            setSnapshot(await window.rambo.snapshot());
          }}
          onRemove={async connection => {
            await window.rambo.removeConnection(connection.id);
            setSnapshot(await window.rambo.snapshot());
            setConnectorDialog(null);
          }}
          onReconnect={async connection => {
            const status = connection.status === 'ready' ? 'needsReconnect' : 'ready';
            const updated = await window.rambo.setConnectionStatus(connection.id, status);
            setSnapshot(await window.rambo.snapshot());
            setConnectorDialog({ mode: 'manage', provider: connectorDialog.provider, connection: updated });
          }}
        />
      )}
    </div>
  );
}

function ConnectorsPage({
  providers,
  connections,
  grants,
  currentBotId,
  onConnect,
  onManage
}: {
  providers: ConnectorProvider[];
  connections: ConnectorConnection[];
  grants: ConnectorGrant[];
  currentBotId: string | null;
  onConnect: (provider: ConnectorProvider) => void;
  onManage: (provider: ConnectorProvider, connection: ConnectorConnection) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | 'all' | 'connected'>('all');
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const providerById = new Map(providers.map(provider => [provider.id, provider]));
  const connectionsByProvider = new Map<string, ConnectorConnection[]>();
  for (const connection of connections) {
    const own = connectionsByProvider.get(connection.providerId);
    if (own) own.push(connection);
    else connectionsByProvider.set(connection.providerId, [connection]);
  }
  const sortedProviders = [...providers].sort((left, right) => {
    const leftIndex = CONNECTOR_FEATURED_ORDER.indexOf(left.id);
    const rightIndex = CONNECTOR_FEATURED_ORDER.indexOf(right.id);
    return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
  });
  const filtered = sortedProviders.filter(provider => {
    const ownConnections = connectionsByProvider.get(provider.id) ?? [];
    if (category === 'connected' && !ownConnections.length) return false;
    if (category !== 'all' && category !== 'connected' && provider.category !== category) return false;
    if (!normalizedQuery) return true;
    return [provider.name, provider.description, provider.monogram, provider.category]
      .some(value => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  const isHomepage = category === 'all' && !normalizedQuery;
  const featured = isHomepage
    ? filtered.filter(provider => provider.id === 'gmail' || provider.id === 'qqmail')
    : [];
  const remaining = isHomepage ? filtered.filter(provider => !featured.includes(provider)) : filtered;
  const categoryOrder: ConnectorCategory[] = [
    'email', 'calendar', 'files', 'communication', 'productivity', 'developer', 'data', 'other'
  ];
  const providerCategories = new Set(providers.map(provider => provider.category));
  const availableCategories = categoryOrder.filter(key => providerCategories.has(key));
  const visibleCategories = availableCategories.slice(0, 5);
  const overflowCategories = availableCategories.slice(5);
  const remainingTitle = normalizedQuery
    ? '搜索结果'
    : category === 'connected'
      ? '已连接的应用'
      : category === 'all'
        ? '所有应用'
        : CONNECTOR_CATEGORY_LABELS[category];

  return (
    <section className="connectors-page" aria-label="连接应用">
      <div className="connectors-topbar">
        <div className="connectors-heading">
          <div className="eyebrow">RAMBO</div>
          <h1>连接应用</h1>
          <p>连接你的邮箱、日程与常用工具。应用账号授权一次，再按 Bot 分配访问权限。</p>
        </div>
        <label className="connector-search">
          <Icon name="search" size={18} />
          <span className="sr-only">搜索连接应用</span>
          <input type="search" value={query} placeholder="搜索应用"
            aria-label="搜索连接应用" onChange={event => setQuery(event.target.value)} />
          {query && (
            <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}>
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
      </div>

      <nav className="connector-category-pills" aria-label="连接应用分类">
        {(['all', 'connected'] as const).map(key => (
          <button type="button" key={key}
            className={'connector-category-pill' + (category === key ? ' selected' : '')}
            aria-pressed={category === key}
            onClick={() => setCategory(key)}>
            {CONNECTOR_CATEGORY_LABELS[key]}
          </button>
        ))}
        {visibleCategories.map(key => (
          <button type="button" key={key}
            className={'connector-category-pill' + (category === key ? ' selected' : '')}
            aria-pressed={category === key}
            onClick={() => setCategory(key)}>
            {CONNECTOR_CATEGORY_LABELS[key]}
          </button>
        ))}
        {overflowCategories.length > 0 && (
          <div className="connector-category-overflow"
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCategoryMenuOpen(false);
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') setCategoryMenuOpen(false);
            }}>
            <button type="button"
              className={'connector-category-pill connector-category-overflow-trigger' +
                (overflowCategories.includes(category as ConnectorCategory) ? ' selected' : '')}
              aria-haspopup="menu"
              aria-pressed={overflowCategories.includes(category as ConnectorCategory)}
              aria-expanded={categoryMenuOpen}
              onClick={() => setCategoryMenuOpen(open => !open)}>
              {overflowCategories.includes(category as ConnectorCategory)
                ? CONNECTOR_CATEGORY_LABELS[category as ConnectorCategory]
                : '更多'}
              <Icon name="chevron" size={13} />
            </button>
            {categoryMenuOpen && (
              <div className="connector-category-menu" role="menu" aria-label="更多应用分类">
                {overflowCategories.map(key => (
                  <button type="button" role="menuitemradio" aria-checked={category === key} key={key}
                    onClick={() => { setCategory(key); setCategoryMenuOpen(false); }}>
                    {CONNECTOR_CATEGORY_LABELS[key]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      {featured.length > 0 && (
        <ConnectorSection
          title="推荐"
          providers={featured}
          providerById={providerById}
          connectionsByProvider={connectionsByProvider}
          grants={grants}
          currentBotId={currentBotId}
          onConnect={onConnect}
          onManage={onManage}
        />
      )}

      {remaining.length > 0 ? (
        <ConnectorSection
          title={remainingTitle}
          providers={remaining}
          providerById={providerById}
          connectionsByProvider={connectionsByProvider}
          grants={grants}
          currentBotId={currentBotId}
          onConnect={onConnect}
          onManage={onManage}
        />
      ) : !featured.length ? (
        <p className="connector-empty-results">{normalizedQuery ? '没有匹配的应用。' : '还没有已连接的应用。'}</p>
      ) : null}
    </section>
  );
}

function ConnectorSection({
  title,
  providers,
  providerById,
  connectionsByProvider,
  grants,
  currentBotId,
  onConnect,
  onManage
}: {
  title: string;
  providers: ConnectorProvider[];
  providerById: Map<string, ConnectorProvider>;
  connectionsByProvider: Map<string, ConnectorConnection[]>;
  grants: ConnectorGrant[];
  currentBotId: string | null;
  onConnect: (provider: ConnectorProvider) => void;
  onManage: (provider: ConnectorProvider, connection: ConnectorConnection) => void;
}) {
  if (!providers.length) return null;
  return (
    <section className="connector-section" aria-label={title}>
      <div className="connector-section-heading">
        <h2>{title}</h2>
      </div>
      <div className="connector-card-list">
        {providers.map(provider => (
          <ConnectorCard
            key={provider.id}
            provider={providerById.get(provider.id) ?? provider}
            connections={connectionsByProvider.get(provider.id) ?? []}
            grants={grants}
            currentBotId={currentBotId}
            onConnect={onConnect}
            onManage={onManage}
          />
        ))}
      </div>
    </section>
  );
}

function ConnectorCard({
  provider,
  connections,
  grants,
  currentBotId,
  onConnect,
  onManage
}: {
  provider: ConnectorProvider;
  connections: ConnectorConnection[];
  grants: ConnectorGrant[];
  currentBotId: string | null;
  onConnect: (provider: ConnectorProvider) => void;
  onManage: (provider: ConnectorProvider, connection: ConnectorConnection) => void;
}) {
  const primaryConnection = connections[0] ?? null;
  const connectionGrants = primaryConnection
    ? grants.filter(grant => grant.connectionId === primaryConnection.id)
    : [];
  const grantCount = new Set(connectionGrants.map(grant => grant.botId)).size;
  const currentBotGranted = currentBotId !== null && connectionGrants.some(grant => grant.botId === currentBotId);
  const statusLabel = primaryConnection ? connectionStatusLabel(primaryConnection.status) : null;

  return (
    <article className={'connector-card' + (primaryConnection ? ' connected' : '')}>
      <ConnectorProviderIcon provider={provider} className="connector-card-icon" />
      <div className="connector-card-copy">
        <div className="connector-card-title-row">
          <h3>{provider.name}</h3>
          {primaryConnection && (
            <span className={'connector-status ' + primaryConnection.status}>
              <span className="connector-status-dot" />
              {statusLabel}
            </span>
          )}
        </div>
        <p>{primaryConnection
          ? `${primaryConnection.displayName} · ${primaryConnection.accountLabel}`
          : provider.description}</p>
        {primaryConnection && (
          <div className="connector-card-grant-summary">
            <span>{grantCount ? `已授权给 ${grantCount} 个 Bot` : '尚未授权 Bot'}</span>
            {currentBotId && !currentBotGranted && <span>当前 Bot 无访问权限</span>}
          </div>
        )}
      </div>
      <div className="connector-card-actions">
        {primaryConnection ? (
          <button type="button" className="connector-secondary-button"
            onClick={() => onManage(provider, primaryConnection)}>管理</button>
        ) : (
          <button type="button" className="connector-primary-button"
            disabled={!provider.available}
            onClick={() => onConnect(provider)}>
            {provider.available ? '连接' : '即将推出'}
          </button>
        )}
      </div>
    </article>
  );
}

interface ConnectorProgressEntry {
  phase: string;
  message: string;
  timestamp: number;
}

function appendConnectorProgress(
  entries: ConnectorProgressEntry[],
  entry: ConnectorProgressEntry
): ConnectorProgressEntry[] {
  const previous = entries[entries.length - 1];
  if (previous?.phase === entry.phase && previous.message === entry.message) return entries;
  return [...entries, entry].slice(-80);
}

function safeConnectorLogMessage(message: string): string {
  return message
    .replace(/\b[a-f0-9]{64}\b/giu, '<密钥已隐藏>')
    .replace(/\/Users\/[^/\s]+/gu, '~')
    .slice(0, 500);
}

function formatConnectorElapsed(startedAt: number | null, now: number): string {
  if (startedAt === null) return '';
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `已等待 ${minutes}:${seconds}`;
}

function ConnectorDialog({
  mode,
  provider,
  connection,
  grants,
  bots,
  onClose,
  onComplete,
  onOAuthComplete,
  onGrant,
  onRemove,
  onReconnect
}: {
  mode: 'connect' | 'manage';
  provider: ConnectorProvider;
  connection: ConnectorConnection | null;
  grants: ConnectorGrant[];
  bots: Bot[];
  onClose: () => void;
  onComplete: (input: ConnectorCredentialInput) => Promise<void>;
  onOAuthComplete: (connection: ConnectorConnection) => Promise<void>;
  onGrant: (botId: string, connectionId: string, granted: boolean) => Promise<void>;
  onRemove: (connection: ConnectorConnection) => Promise<void>;
  onReconnect: (connection: ConnectorConnection) => Promise<void>;
}) {
  const titleId = useId();
  const [grantedIds, setGrantedIds] = useState<Set<string>>(() => new Set(
    connection ? grants.filter(grant => grant.connectionId === connection.id).map(grant => grant.botId) : []
  ));
  const [challenge, setChallenge] = useState<ConnectorAuthChallenge | null>(null);
  const [displayName, setDisplayName] = useState(connection?.displayName ?? provider.name);
  const [email, setEmail] = useState(connection?.accountLabel ?? '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauthWaiting, setOauthWaiting] = useState(false);
  const [connectorProgress, setConnectorProgress] = useState<string | null>(null);
  const [connectorPhase, setConnectorPhase] = useState<string | null>(null);
  const [canFinishCapture, setCanFinishCapture] = useState(false);
  const [canContinueCapture, setCanContinueCapture] = useState(false);
  const [captureFinishing, setCaptureFinishing] = useState(false);
  const [connectorLog, setConnectorLog] = useState<ConnectorProgressEntry[]>([]);
  const [connectorClock, setConnectorClock] = useState(Date.now());
  const connectorStartedAtRef = useRef<number | null>(null);
  const captureFinishingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const isManage = mode === 'manage' && connection;
  useEffect(() => {
    if (!connection) return;
    setGrantedIds(new Set(
      grants.filter(grant => grant.connectionId === connection.id).map(grant => grant.botId)
    ));
  }, [connection?.id, grants]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !oauthWaiting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, oauthWaiting, onClose]);

  useEffect(() => () => {
    if (challenge?.providerId === 'wechat') {
      void window.rambo.cancelConnectorAuth(challenge).catch(() => {});
    }
  }, [challenge?.connectionId]);

  useEffect(() => window.rambo.onEvent(event => {
    if (event.type === 'connectorAuthProgress' && event.connectionId === challenge?.connectionId) {
      if (captureFinishingRef.current && event.phase === 'capturing' && connectorPhase !== 'resuming-capture') return;
      setConnectorPhase(event.phase);
      setCanFinishCapture(event.canFinishCapture === true);
      setCanContinueCapture(event.canContinueCapture === true);
      if (event.phase === 'finishing-capture' || event.phase === 'verifying') {
        captureFinishingRef.current = true;
        setCaptureFinishing(true);
      } else if (event.phase === 'resuming-capture') {
        captureFinishingRef.current = true;
        setCaptureFinishing(true);
      } else if (event.phase === 'awaiting-recapture' || event.phase === 'capturing') {
        captureFinishingRef.current = false;
        setCaptureFinishing(false);
      } else if (event.phase === 'complete' || event.phase === 'failed') {
        captureFinishingRef.current = false;
        setCaptureFinishing(false);
      }
      const message = safeConnectorLogMessage(event.message);
      setConnectorProgress(message);
      setConnectorLog(current => appendConnectorProgress(current, {
        phase: event.phase,
        message,
        timestamp: Date.now()
      }));
    }
  }), [challenge?.connectionId, connectorPhase]);

  useEffect(() => {
    if (!oauthWaiting || provider.id !== 'wechat') return;
    const timer = window.setInterval(() => setConnectorClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [oauthWaiting, provider.id]);

  useEffect(() => {
    if (mode !== 'connect') return;
    let alive = true;
    setBusy(true);
    window.rambo.beginConnectorAuth(provider.id, displayName.trim() || provider.name)
      .then(next => { if (alive) setChallenge(next.challenge); })
      .catch(issue => { if (alive) setError(toError(issue)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
    // The challenge is created once when the connection sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, provider.id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await onComplete({
        challenge,
        providerId: provider.id,
        displayName: displayName.trim(),
        email: email.trim(),
        secret
      });
      setSecret('');
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setBusy(false);
    }
  };

  const startWechatConnect = async () => {
    cancelledRef.current = false;
    captureFinishingRef.current = false;
    const startedAt = Date.now();
    connectorStartedAtRef.current = startedAt;
    setConnectorClock(startedAt);
    setBusy(true);
    setError(null);
    setConnectorPhase('starting');
    setCanFinishCapture(false);
    setCanContinueCapture(false);
    setCaptureFinishing(false);
    setConnectorProgress('正在准备本机微信连接…');
    setConnectorLog([{
      phase: 'starting',
      message: '正在准备本机微信连接…',
      timestamp: startedAt
    }]);
    try {
      let activeChallenge = challenge;
      if (!activeChallenge) {
        const started = await window.rambo.beginConnectorAuth(
          provider.id,
          displayName.trim() || provider.name
        );
        activeChallenge = started.challenge;
        setChallenge(activeChallenge);
      }
      setOauthWaiting(true);
      setBusy(false);
      const connection = await window.rambo.openConnectorAuth(activeChallenge);
      if (cancelledRef.current) return;
      setOauthWaiting(false);
      captureFinishingRef.current = false;
      setCaptureFinishing(false);
      setCanFinishCapture(false);
      setCanContinueCapture(false);
      setBusy(true);
      await onOAuthComplete(connection);
    } catch (issue) {
      if (cancelledRef.current) return;
      setOauthWaiting(false);
      captureFinishingRef.current = false;
      setConnectorPhase('failed');
      setCanFinishCapture(false);
      setCanContinueCapture(false);
      setCaptureFinishing(false);
      const message = toError(issue);
      setError(message);
      const safeMessage = safeConnectorLogMessage(`连接失败：${message}`);
      setConnectorProgress(safeMessage);
      setConnectorLog(current => appendConnectorProgress(current, {
        phase: 'failed',
        message: safeMessage,
        timestamp: Date.now()
      }));
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  };

  const finishWechatCapture = async () => {
    if (!challenge || !canFinishCapture || captureFinishingRef.current) return;
    captureFinishingRef.current = true;
    setCaptureFinishing(true);
    setCanFinishCapture(false);
    setCanContinueCapture(false);
    setConnectorPhase('finishing-capture');
    setError(null);
    const message = '收到完成信号，正在结束本轮并验证候选密钥…';
    setConnectorProgress(message);
    setConnectorLog(current => appendConnectorProgress(current, {
      phase: 'finishing-capture',
      message,
      timestamp: Date.now()
    }));
    try {
      const requested = await window.rambo.finishWechatCapture(challenge);
      if (!requested) throw new Error('密钥捕获尚未就绪，请等待“已就绪”状态后重试。');
    } catch (issue) {
      captureFinishingRef.current = false;
      setCaptureFinishing(false);
      setConnectorPhase('capturing');
      setCanFinishCapture(true);
      setError(toError(issue));
    }
  };

  const continueWechatCapture = async () => {
    if (!challenge || !canContinueCapture || captureFinishingRef.current) return;
    captureFinishingRef.current = true;
    setCaptureFinishing(true);
    setCanContinueCapture(false);
    setConnectorPhase('resuming-capture');
    setError(null);
    const message = '继续复用当前微信副本和管理员授权；请继续操作，完成后再结束本轮。';
    setConnectorProgress(message);
    setConnectorLog(current => appendConnectorProgress(current, {
      phase: 'resuming-capture',
      message,
      timestamp: Date.now()
    }));
    try {
      const requested = await window.rambo.continueWechatCapture(challenge);
      if (!requested) throw new Error('当前没有可继续的捕获轮次，请等待密钥校验完成。');
    } catch (issue) {
      captureFinishingRef.current = false;
      setCaptureFinishing(false);
      setConnectorPhase('awaiting-recapture');
      setCanContinueCapture(true);
      setError(toError(issue));
    }
  };

  const cancelOAuth = async () => {
    cancelledRef.current = true;
    captureFinishingRef.current = false;
    setOauthWaiting(false);
    setCanFinishCapture(false);
    setCanContinueCapture(false);
    setCaptureFinishing(false);
    setError(null);
    const cancelledAt = Date.now();
    setConnectorProgress('已取消微信连接。');
    setConnectorLog(current => appendConnectorProgress(current, {
      phase: 'cancelled',
      message: '已取消微信连接。',
      timestamp: cancelledAt
    }));
    if (challenge?.providerId === 'wechat') {
      await window.rambo.cancelConnectorAuth(challenge).catch(() => {});
    }
    setChallenge(null);
  };

  const verifyingWechat = provider.id === 'wechat' && oauthWaiting && (
    captureFinishing || connectorPhase === 'finishing-capture' ||
    connectorPhase === 'resuming-capture' || connectorPhase === 'verifying'
  );

  return (
    <div className="modal-backdrop connector-modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !busy && !oauthWaiting) onClose();
    }}>
      <section className="connector-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="connector-dialog-header">
          <ConnectorProviderIcon provider={provider} className="connector-dialog-icon" />
          <div>
            <h2 id={titleId}>{provider.name}</h2>
            <p>{isManage
              ? '管理连接账号与 Bot 访问权限。'
              : provider.description}</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" disabled={busy && !oauthWaiting}
            onClick={() => { if (oauthWaiting) void cancelOAuth(); onClose(); }}>
            <Icon name="close" size={18} />
          </button>
        </header>

        {isManage && connection ? (
          <>
            <div className="connector-dialog-account">
              <span className="connector-dialog-account-icon"><Icon name="account" size={18} /></span>
              <span>
                <strong>{connection.displayName}</strong>
                <small>{connection.accountLabel}</small>
              </span>
              <span className={'connector-status ' + connection.status}>
                <span className="connector-status-dot" />
                {connectionStatusLabel(connection.status)}
              </span>
            </div>
            <div className="connector-dialog-section">
              <div className="connector-dialog-section-heading">
                <h3>Bot 访问权限</h3>
                <p>授权以整条连接为单位。新建 Bot 不会自动继承。</p>
              </div>
              <div className="connector-dialog-bots">
                {bots.length ? bots.map(bot => {
                  const granted = grantedIds.has(bot.id);
                  return (
                    <label key={bot.id} className="connector-dialog-bot">
                      <span className="connector-dialog-bot-identity">
                        <Avatar value={bot.avatar} size="small" followOnHover={false} />
                        <span>
                          <strong>{bot.name}</strong>
                          <small>{bot.role.trim() || '个人助手'}</small>
                        </span>
                      </span>
                      <input type="checkbox" checked={granted} disabled={busy}
                        aria-label={`${bot.name} 可使用 ${provider.name}`}
                        onChange={event => {
                          const nextGranted = event.target.checked;
                          setGrantedIds(current => {
                            const next = new Set(current);
                            if (nextGranted) next.add(bot.id);
                            else next.delete(bot.id);
                            return next;
                          });
                          setBusy(true);
                          setError(null);
                          onGrant(bot.id, connection.id, nextGranted)
                            .catch(issue => {
                              setGrantedIds(current => {
                                const next = new Set(current);
                                if (nextGranted) next.delete(bot.id);
                                else next.add(bot.id);
                                return next;
                              });
                              setError(toError(issue));
                            })
                            .finally(() => setBusy(false));
                        }} />
                    </label>
                  );
                }) : <p className="connector-dialog-empty">还没有可授权的 Bot。</p>}
              </div>
            </div>
            {error && <div className="form-error" role="alert">{error}</div>}
            <footer className="connector-dialog-footer">
              <button type="button" className="danger-button" disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  onRemove(connection)
                    .catch(issue => setError(toError(issue)))
                    .finally(() => setBusy(false));
                }}>断开连接</button>
              <span className="connector-dialog-footer-spacer" />
              <button type="button" className="primary-button" disabled={busy} onClick={onClose}>完成</button>
            </footer>
          </>
        ) : provider.id === 'wechat' ? (
          <>
            <div className="connector-auth-note">
              <span className="connector-auth-note-icon"><Icon name="account" size={20} /></span>
              <div>
                <strong>读取本机微信</strong>
                <p>Rambo 将读取此 Mac 上微信已保存的聊天消息。主微信保持腾讯官方签名；首次连接需要创建临时受管副本完成密钥捕获，验证后删除副本。</p>
                <small>读取只在本机进行，不联网补取消息，不建立微信正文归档或媒体缓存。</small>
              </div>
            </div>
            <div className="connector-auth-note">
              <span className="connector-auth-note-icon"><Icon name="check" size={20} /></span>
              <div>
                <strong>连接步骤</strong>
                <p>Rambo 会检查微信 4.1.x 与官方签名，让你选择账号目录，然后在临时副本中捕获并验证数据库密钥。密钥不会交给 Bot，也不会写入日志。</p>
                <small>首次使用会出现 macOS 管理员授权提示。密钥监听启动后会保持同一个微信副本和授权进程；请在副本中登录并打开聊天、图片或语音，完成一轮后点“我已完成操作，验证密钥”。如果仍缺少密钥，先点“继续补抓密钥”，再回到副本打开聊天或媒体；完成后再次点验证，不必重启或重新登录。</small>
              </div>
            </div>
            {(oauthWaiting || connectorLog.length > 0) && (
              <section className="connector-progress-panel" aria-label="微信连接日志">
                <header className="connector-progress-heading" aria-busy={verifyingWechat}>
                  <div className="connector-progress-current" role="status" aria-live="polite">
                    {verifyingWechat && <span className="connector-progress-spinner" aria-hidden="true" />}
                    <strong>{connectorProgress ?? '连接日志'}</strong>
                  </div>
                  <span>{oauthWaiting
                    ? formatConnectorElapsed(connectorStartedAtRef.current, connectorClock)
                    : '本机诊断'}</span>
                </header>
                <ol className="connector-progress-log" role="log" aria-live="polite" aria-relevant="additions"
                  aria-label="微信连接阶段和诊断信息">
                  {connectorLog.map((entry, index) => (
                    <li key={`${entry.timestamp}-${index}`} data-phase={entry.phase}>
                      <time dateTime={new Date(entry.timestamp).toISOString()}>
                        {new Date(entry.timestamp).toLocaleTimeString('zh-CN', {
                          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                        })}
                      </time>
                      <span>{entry.message}</span>
                    </li>
                  ))}
                </ol>
                <small className="connector-progress-footnote">只显示阶段、等待时长和密钥数量，不显示密钥内容或聊天正文。</small>
              </section>
            )}
            {error && <div className="form-error" role="alert">{error}</div>}
            <footer className="connector-dialog-footer">
              <button type="button" className="secondary-button" disabled={busy && !oauthWaiting}
                onClick={() => { if (oauthWaiting) void cancelOAuth(); onClose(); }}>
                {oauthWaiting ? '取消连接' : '取消'}
              </button>
              <span className="connector-dialog-footer-spacer" />
              <button type="button" className="primary-button"
                disabled={busy || !challenge || (oauthWaiting && ((!canFinishCapture && !canContinueCapture) || captureFinishing))}
                onClick={() => {
                  if (oauthWaiting && canContinueCapture) void continueWechatCapture();
                  else if (oauthWaiting) void finishWechatCapture();
                  else void startWechatConnect();
                }}>
                {oauthWaiting
                  ? verifyingWechat
                    ? connectorPhase === 'resuming-capture' ? '正在继续捕获…' : '正在验证数据库…'
                    : canContinueCapture ? '继续补抓密钥'
                      : canFinishCapture ? '我已完成操作，验证密钥' : '正在准备捕获…'
                  : '连接微信'}
              </button>
            </footer>
          </>
        ) : (
          <form className="connector-auth-form" onSubmit={event => void submit(event)}>
            <div className="connector-auth-note">
              <span className="connector-auth-note-icon"><Icon name="account" size={20} /></span>
              <div>
                {provider.id === 'gmail' ? (
                  <>
                    <strong>Gmail 应用专用密码</strong>
                    <p>先为 Google 账号开启两步验证，再<a href="https://myaccount.google.com/apppasswords"
                      target="_blank" rel="noopener noreferrer">创建应用专用密码</a>并粘贴到这里。Rambo 使用 Gmail IMAP/SMTP 连接邮箱，不会打开 OAuth 授权页。</p>
                    <small>它不是 Google 登录密码或一次性验证码，而是可重复使用至撤销的专用密码。Google 将此方式定位为兼容较不安全应用的方案，并建议优先使用“使用 Google 账号登录”；部分工作/学校账号、安全密钥专用账号或高级保护账号可能无法创建。Google 账号主密码变更后，此密码会被撤销。凭证仅在本机加密保存。<a href="https://support.google.com/mail/answer/185833" target="_blank" rel="noopener noreferrer">Google 官方说明</a></small>
                  </>
                ) : (
                  <>
                    <strong>QQ 邮箱连接说明</strong>
                    <p>需要先在 QQ 邮箱网页版生成授权码：<a href="https://mail.qq.com" target="_blank" rel="noopener noreferrer">打开 QQ 邮箱 → 设置 → 账户 → 开启 IMAP/SMTP → 生成授权码</a>。</p>
                    <small>注意：这不是 QQ 登录密码；授权码会使用应用本地密钥加密保存，不进入聊天上下文或日志。</small>
                  </>
                )}
              </div>
            </div>
            <label className="settings-field">
              <span>连接名称</span>
              <input className="text-input" value={displayName} maxLength={120} disabled={busy}
                placeholder={provider.id === 'gmail' ? '例如：个人 Gmail' : '例如：工作邮箱'}
                onChange={event => setDisplayName(event.target.value)} />
            </label>
            <label className="settings-field">
              <span>{provider.id === 'gmail' ? 'Gmail 地址' : 'QQ 邮箱地址'}</span>
              <input className="text-input" type="email" value={email} maxLength={320} disabled={busy}
                autoComplete="email" placeholder={provider.id === 'gmail' ? 'name@gmail.com' : 'name@qq.com'}
                onChange={event => setEmail(event.target.value)} />
            </label>
            <label className="settings-field">
              <span>{provider.id === 'gmail' ? '应用专用密码' : '邮箱授权码'}</span>
              <input className="text-input" type="password" value={secret} maxLength={512} disabled={busy}
                autoComplete="new-password"
                placeholder={provider.id === 'gmail' ? '输入 Google 生成的应用专用密码' : '输入 QQ 邮箱生成的授权码'}
                onChange={event => setSecret(event.target.value)} />
              <small className="field-hint">保存前会验证邮箱 IMAP 与 SMTP；凭证会使用应用本地密钥加密保存。</small>
            </label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <footer className="connector-dialog-footer">
              <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
              <button type="submit" className="primary-button"
                disabled={busy || !challenge || !displayName.trim() || !email.trim() || !secret.trim()}>
                {busy ? '正在验证并保存…' : '保存连接'}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

function connectionStatusLabel(status: ConnectorConnection['status']): string {
  return {
    ready: '已连接',
    needsReconnect: '需要重新连接',
    expired: '授权已过期',
    disabled: '已停用'
  }[status];
}

function RoutineListPage({
  routines,
  runs,
  bots,
  onSetRoutineStatus,
  onRunRoutineNow,
  onStopRoutineRun
}: {
  routines: RoutineListItem[];
  runs: RoutineRun[];
  bots: Bot[];
  onSetRoutineStatus: (id: string, status: RoutineListItem['status']) => Promise<void>;
  onRunRoutineNow: (id: string) => Promise<RoutineRun>;
  onStopRoutineRun: (id: string) => Promise<RoutineRun>;
}) {
  const [routineBusy, setRoutineBusy] = useState<string | null>(null);
  const [routineMessage, setRoutineMessage] = useState<string | null>(null);
  const botsById = new Map(bots.map(bot => [bot.id, bot]));
  const routinesByBot = new Map<string, RoutineListItem[]>();
  for (const routine of routines) {
    const botRoutines = routinesByBot.get(routine.botId);
    if (botRoutines) botRoutines.push(routine);
    else routinesByBot.set(routine.botId, [routine]);
  }

  const changeRoutine = async (routine: RoutineListItem) => {
    setRoutineBusy(routine.id);
    setRoutineMessage(null);
    try {
      await onSetRoutineStatus(routine.id, routine.status === 'active' ? 'paused' : 'active');
      setRoutineMessage(routine.status === 'active'
        ? '定时计划已暂停'
        : routine.lastRun?.status === 'needs_user'
          ? '已检查上次运行记录，定时计划已恢复；该次仍保留为中断且结果未确认。'
          : '定时计划已恢复');
    } catch (issue) {
      setRoutineMessage(toError(issue));
    } finally {
      setRoutineBusy(null);
    }
  };

  const runRoutine = async (routine: RoutineListItem) => {
    setRoutineBusy(routine.id);
    setRoutineMessage(null);
    try {
      const run = await onRunRoutineNow(routine.id);
      setRoutineMessage(`已立即发起运行 · ${routineRunStatusLabel(run.status)}`);
    } catch (issue) {
      setRoutineMessage(toError(issue));
    } finally {
      setRoutineBusy(null);
    }
  };

  const stopRoutine = async (routine: RoutineListItem) => {
    const run = runs.find(item => item.routineId === routine.id &&
      (item.status === 'running' || item.status === 'pending'));
    if (!run) return;
    setRoutineBusy(routine.id);
    setRoutineMessage(null);
    try {
      const stopped = await onStopRoutineRun(run.id);
      setRoutineMessage(stopped.status === 'interrupted' ? '本次执行已停止' : '执行已经结束');
    } catch (issue) {
      setRoutineMessage(toError(issue));
    } finally {
      setRoutineBusy(null);
    }
  };

  const pauseAndStopRoutine = async (routine: RoutineListItem) => {
    const run = runs.find(item => item.routineId === routine.id &&
      (item.status === 'running' || item.status === 'pending'));
    setRoutineBusy(routine.id);
    setRoutineMessage(null);
    try {
      await onSetRoutineStatus(routine.id, 'paused');
      if (run) await onStopRoutineRun(run.id);
      setRoutineMessage('定时计划已暂停，本次执行已停止');
    } catch (issue) {
      setRoutineMessage(toError(issue));
    } finally {
      setRoutineBusy(null);
    }
  };

  return (
    <section className="settings-page routine-page" aria-label="所有 Bot 的定时任务">
      <div className="settings-page-heading">
        <div>
          <div className="eyebrow">自动化</div>
          <h1>定时任务</h1>
          <p>集中查看和管理所有 Bot 的计划与运行记录。</p>
        </div>
      </div>
      {routines.length === 0 ? (
        <div className="routine-empty-state" role="status">
          <span className="routine-empty-icon"><Icon name="calendar" size={21} /></span>
          <div>
            <h2>暂无定时任务</h2>
            <p>当对话明确表达周期委托意图时，Bot 可从上下文整理计划。任务由本机后台服务按计划触发。</p>
          </div>
        </div>
      ) : (
        <div className="routine-bot-groups" aria-label="按 Bot 分组的定时任务">
          {[...routinesByBot].map(([botId, botRoutines]) => {
            const bot = botsById.get(botId);
            const botName = bot?.name ?? 'Bot 已不存在';
            const configError = bot
              ? botExecutionConfigError(bot)
              : '定时任务所属 Bot 不存在。';
            return (
              <section className="routine-bot-group" key={botId} data-bot-id={botId}
                aria-label={`${botName} 的定时任务`}>
                <div className="routine-bot-group-heading">
                  <div className="routine-bot-group-identity">
                    {bot
                      ? <Avatar value={bot.avatar} size="small" />
                      : <span className="routine-bot-group-missing-avatar"><Icon name="account" size={13} /></span>}
                    <h2>{botName}</h2>
                  </div>
                  <span className="routine-bot-group-count">{botRoutines.length} 个任务</span>
                </div>
                  <ul className="routine-list" aria-label={`${botName} 管理的定时任务`}>
                  {botRoutines.map(routine => (
                    <li className="routine-list-item" key={routine.id}>
                      <div className="routine-list-copy">
                        <strong>{routine.title}</strong>
                        <div className="routine-list-meta">
                          <span>{routineScheduleLabel(routine)}</span>
                          <span className="routine-execution-mode">
                            {routineExecutionLabel(routine.definition.execution.mode)}
                          </span>
                        </div>
                        <p>{routine.definition.instruction}</p>
                        <RoutineRunSummary routine={routine} runs={runs} />
                      </div>
                        <div className="routine-actions">
                          <RoutineStatus routine={routine} />
                          {(routine.definition.kind === 'recurring' || routine.lastRun?.status === 'needs_user') && (
                            <button type="button" className="routine-action-button" disabled={routineBusy === routine.id}
                              onClick={() => void changeRoutine(routine)}>
                              {routineBusy === routine.id ? '处理中…' : routine.status === 'active' ? '暂停' :
                                routine.lastRun?.status === 'needs_user' ? '已检查，恢复计划' : '恢复'}
                            </button>
                          )}
                          {runs.some(item => item.routineId === routine.id &&
                            (item.status === 'running' || item.status === 'pending')) && (
                            <button type="button" className="routine-action-button"
                              disabled={routineBusy === routine.id}
                              onClick={() => void stopRoutine(routine)}>停止本次</button>
                          )}
                          {routine.definition.kind === 'recurring' && routine.status === 'active' &&
                            runs.some(item => item.routineId === routine.id &&
                              (item.status === 'running' || item.status === 'pending')) && (
                            <button type="button" className="routine-action-button"
                              disabled={routineBusy === routine.id}
                              onClick={() => void pauseAndStopRoutine(routine)}>暂停并停止本次</button>
                          )}
                          <button type="button" className="routine-action-button"
                            disabled={Boolean(configError) || routineBusy === routine.id || routine.status === 'paused' ||
                              routine.lastRun?.status === 'running' || routine.lastRun?.status === 'pending' ||
                              routine.lastRun?.status === 'needs_user'}
                            title={configError
                              ? configError
                              : routine.lastRun?.status === 'needs_user'
                                ? '请先检查上次运行结果并恢复计划'
                              : undefined}
                            onClick={() => void runRoutine(routine)}>立即运行</button>
                        </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {routineMessage && <div className="routine-message" role="status">{routineMessage}</div>}
    </section>
  );
}

function routineLabel(routine: RoutineListItem): string {
  if (routine.definition.kind === 'once') {
    const status = routine.lastRun?.status;
    if (status === 'succeeded') return '已完成';
    if (status === 'failed') return '执行失败';
    if (status === 'missed') return '已错过';
    if (status === 'interrupted') return '已中断';
    if (status === 'running' || status === 'pending') return '执行中';
    return routine.nextRunAt ? `等待执行 · ${timestampLabel(routine.nextRunAt)}` : '等待手动运行';
  }
  return routine.nextRunAt ? `下次 ${timestampLabel(routine.nextRunAt)}` : '等待触发';
}

function routineExecutionLabel(mode: RoutineListItem['definition']['execution']['mode']): string {
  if (mode === 'script') return '脚本执行';
  if (mode === 'hybrid') return '判断 + 脚本';
  return '对话执行';
}

function routineScheduleLabel(routine: RoutineListItem): string {
  const { definition } = routine;
  if (!definition.times.length) return definition.schedule;
  const times = definition.times.join('、');
  return definition.schedule.includes(times)
    ? definition.schedule
    : `${definition.schedule}｜${times}`;
}

function RoutineStatus({ routine }: { routine: RoutineListItem }) {
  return (
    <>
      <span className={'routine-status routine-status-' + routine.status}>
        {routine.status === 'active' ? routineLabel(routine) : '已暂停'}
      </span>
      {routine.statusReason && (
        <span className="routine-status-reason" role="status">
          {routine.statusReason}
        </span>
      )}
    </>
  );
}

function RoutineRunSummary({ routine, runs }: { routine: RoutineListItem; runs: RoutineRun[] }) {
  const ownRuns = runs.filter(run => run.routineId === routine.id).slice(0, 3);
  if (!ownRuns.length) return <small className="routine-run-empty">暂无运行记录</small>;
  return (
    <div className="routine-run-summary" aria-label={`${routine.title} 的运行记录`}>
      {ownRuns.map(run => <RoutineRunEntry key={run.id} run={run} />)}
    </div>
  );
}

function RoutineRunEntry({ run }: { run: RoutineRun }) {
  return (
    <details className="routine-run-entry">
      <summary>
        {routineRunStatusLabel(run.status)} · {timestampLabel(run.createdAt)}
        {run.summary ? ` · ${run.summary.slice(0, 80)}` : run.error ? ` · ${run.error.slice(0, 80)}` : ''}
      </summary>
      <dl>
        <div><dt>触发</dt><dd>{{
          schedule: '计划', catchUp: '补跑', manual: '手动', skip: '防重入跳过'
        }[run.trigger]}</dd></div>
        {run.startedAt && <div><dt>开始</dt><dd>{timestampLabel(run.startedAt)}</dd></div>}
        {run.completedAt && <div><dt>结束</dt><dd>{timestampLabel(run.completedAt)}</dd></div>}
        {run.process && <div><dt>过程</dt><dd>{run.process}</dd></div>}
        {run.summary && <div><dt>结果</dt><dd>{run.summary}</dd></div>}
        {run.error && <div className="routine-run-error"><dt>错误</dt><dd>{run.error}</dd></div>}
      </dl>
    </details>
  );
}

function routineRunStatusLabel(status: RoutineRun['status']): string {
  return {
    pending: '等待执行', running: '执行中', succeeded: '成功', failed: '失败',
    interrupted: '已中断', needs_user: '等待你确认', skipped: '已跳过', missed: '已错过'
  }[status];
}

function CreateGroupPage({
  bots,
  onCancel,
  onCreate
}: {
  bots: Bot[];
  onCancel: () => void;
  onCreate: (title: string, purpose: string, botIds: string[]) => Promise<GroupChat>;
}) {
  const [title, setTitle] = useState('新群聊');
  const [purpose, setPurpose] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleBot = (botId: string) => {
    setSelectedIds(current => current.includes(botId)
      ? current.filter(id => id !== botId)
      : [...current, botId]);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) { setError('请填写群聊名称'); return; }
    const normalizedPurpose = purpose.trim();
    if (!normalizedPurpose) { setError('请填写群聊职责'); return; }
    if (selectedIds.length < 2) { setError('请至少选择两个 Bot'); return; }
    setBusy(true);
    setError(null);
    try {
      await runGroupCreateAction({
        type: 'create',
        title: normalizedTitle,
        purpose: normalizedPurpose,
        botIds: selectedIds
      }, {
        cancel: onCancel,
        create: onCreate
      });
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-page group-page" aria-label="创建群聊">
      <div className="settings-page-heading">
        <div>
          <div className="eyebrow">本机群聊</div>
          <h1>创建群聊</h1>
          <p>选择至少两个 Bot，第一位自动成为群主。群主会在创建后发布群职责公告。</p>
        </div>
      </div>
      <form className="settings-form" onSubmit={event => void submit(event)}>
        <label className="settings-field">
          <span>群聊名称</span>
          <input className="text-input" value={title} maxLength={120} required
            onChange={event => setTitle(event.target.value)} />
        </label>
        <label className="settings-field">
          <span>群聊职责</span>
          <textarea className="text-input group-purpose-input" value={purpose} maxLength={4000} required
            placeholder="说明这个群共同要完成什么、边界是什么，以及成员如何协作。"
            onChange={event => setPurpose(event.target.value)} />
        </label>
        <fieldset className="group-member-picker">
          <legend>选择成员（按选择顺序）</legend>
          {bots.length === 0 ? (
            <div className="sidebar-hint">当前没有可加入的 Bot。</div>
          ) : bots.map(bot => {
            const selectedIndex = selectedIds.indexOf(bot.id);
            return (
            <label className={'group-member-option' + (selectedIndex >= 0 ? ' selected' : '')} key={bot.id}>
              <input type="checkbox" checked={selectedIndex >= 0} disabled={busy}
                onChange={() => toggleBot(bot.id)} />
              <Avatar value={bot.avatar} size="small" />
              <span className="group-member-copy">
                <strong>{bot.name}</strong>
                <small>{bot.role.trim() || '个人助手'}</small>
              </span>
              {selectedIndex === 0 && <span className="group-owner-badge">群主</span>}
              {selectedIndex > 0 && <span className="group-member-order">{selectedIndex + 1}</span>}
            </label>
          );})}
          <p className="group-selection-count">已选 {selectedIds.length} 个；第一位的 {selectedIds[0] ? bots.find(bot => bot.id === selectedIds[0])?.name : 'Bot'} 将成为群主。</p>
        </fieldset>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="settings-save-row">
          <button type="button" className="secondary-button" disabled={busy}
            onClick={() => void runGroupCreateAction({ type: 'cancel' }, { cancel: onCancel, create: onCreate })}>取消</button>
          <button type="submit" className="primary-button" disabled={busy || bots.length < 2 || selectedIds.length < 2 || !title.trim() || !purpose.trim()}>
            {busy ? '正在创建…' : '创建群聊'}
          </button>
        </div>
      </form>
    </section>
  );
}

function AddGroupMembersPage({
  group,
  bots,
  onCancel,
  onAdd,
  onUpdatePurpose,
  onRemove
}: {
  group: GroupChat;
  bots: Bot[];
  onCancel: () => void;
  onAdd: (botIds: string[]) => Promise<GroupChat>;
  onUpdatePurpose: (purpose: string) => Promise<GroupChat>;
  onRemove: (botIds: string[]) => Promise<GroupChat>;
}) {
  const existing = new Set(group.memberIds);
  const candidates = bots.filter(bot => !existing.has(bot.id) && !bot.archived);
  const members = group.memberIds
    .map(id => bots.find(bot => bot.id === id))
    .filter((bot): bot is Bot => Boolean(bot));
  const owner = bots.find(bot => bot.id === group.ownerBotId);
  const [purpose, setPurpose] = useState(group.purpose);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savePurpose = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const normalized = purpose.trim();
    if (!normalized) { setError('请填写群聊职责'); return; }
    setBusy(true);
    setError(null);
    try {
      await onUpdatePurpose(normalized);
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setBusy(false);
    }
  };

  const addMembers = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedIds.size || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd([...selectedIds]);
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (botId: string) => {
    if (busy || botId === group.ownerBotId) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove([botId]);
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-page group-members-page">
      <header className="settings-page-heading">
        <div>
          <div className="eyebrow">GROUP</div>
          <h1>群主与职责</h1>
          <p>「{group.title}」由 {owner?.name ?? '未知 Bot'} 担任群主，成员共同遵循群职责协作。</p>
        </div>
      </header>
      <form className="settings-form" onSubmit={event => void savePurpose(event)}>
        <div className="group-owner-summary">
          <span className="group-owner-badge">群主</span>
          {owner ? (
            <span className="group-owner-identity">
              <Avatar value={owner.avatar} size="small" />
              <strong>{owner.name}</strong>
              <small>{owner.role.trim() || '个人助手'}</small>
            </span>
          ) : <span className="sidebar-hint">当前群主不可用。</span>}
        </div>
        <label className="settings-field">
          <span>群聊职责</span>
          <textarea className="text-input group-purpose-input" value={purpose} maxLength={4000}
            onChange={event => { setPurpose(event.target.value); setError(null); }} />
        </label>
        <div className="settings-save-row">
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>返回群聊</button>
          <button type="submit" className="primary-button" disabled={busy || !purpose.trim() || purpose.trim() === group.purpose}>
            {busy ? '正在保存…' : '保存群聊职责'}
          </button>
        </div>
      </form>
      <div className="group-member-section">
        <div>
          <div className="eyebrow">MEMBERS</div>
          <h2>当前成员</h2>
          <p>成员按加入顺序排列；群主不能被直接移除。</p>
        </div>
        <div className="group-current-members">
          {members.map(bot => (
            <div className="group-current-member" key={bot.id}>
              <Avatar value={bot.avatar} size="small" />
              <span className="group-member-copy">
                <strong>{bot.name}{bot.id === group.ownerBotId ? ' · 群主' : ''}</strong>
                <small>{bot.role.trim() || '个人助手'}</small>
              </span>
              <button type="button" className="secondary-button compact-button"
                disabled={busy || bot.id === group.ownerBotId}
                onClick={() => void removeMember(bot.id)}>
                移除
              </button>
            </div>
          ))}
        </div>
      </div>
      <form className="settings-form" onSubmit={event => void addMembers(event)}>
        <fieldset className="group-member-picker">
          <legend>添加成员</legend>
          {candidates.length ? candidates.map(bot => (
            <label className="group-member-option" key={bot.id}>
              <input type="checkbox" checked={selectedIds.has(bot.id)}
                onChange={event => {
                  setSelectedIds(current => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(bot.id);
                    else next.delete(bot.id);
                    return next;
                  });
                  setError(null);
                }} />
              <Avatar value={bot.avatar} size="small" />
              <span className="group-member-copy">
                <strong>{bot.name}</strong>
                <small>{bot.role.trim() || '唯一私聊'}</small>
              </span>
            </label>
          )) : <p className="group-member-empty">没有可添加的 Bot。</p>}
        </fieldset>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="settings-save-row">
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>返回群聊</button>
          <button type="submit" className="primary-button" disabled={busy || !selectedIds.size}>
            {busy ? '正在添加…' : '添加到群聊'}
          </button>
        </div>
      </form>
    </section>
  );
}

function GroupChatPage({ group, bots, messages, runtime, enteringMessageIds, loading, onError, onSend, onStop }: {
  group: GroupChat; bots: Bot[]; messages: GroupMessage[]; runtime: GroupRuntimeState | null;
  enteringMessageIds: Set<string>;
  loading: boolean;
  onError: (error: string | null) => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const members = group.memberIds
    .map(id => bots.find(bot => bot.id === id))
    .filter((bot): bot is Bot => Boolean(bot));
  const owner = bots.find(bot => bot.id === group.ownerBotId);
  const activeMembers = members.filter(bot => !bot.archived);
  const hasUnreadyMembers = activeMembers.some(bot => botExecutionConfigError(bot) !== null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptFollowsLatestRef = useRef(true);
  const preservedScrollRef = useRef<{
    anchorId: string | null; anchorOffset: number | null;
  } | null>(null);

  const captureScrollAnchor = (element: HTMLDivElement) => {
    const containerTop = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>('.message-row[data-message-id]')]
      .find(row => row.getBoundingClientRect().bottom > containerTop);
    preservedScrollRef.current = anchor ? {
      anchorId: anchor.dataset.messageId ?? null,
      anchorOffset: anchor.getBoundingClientRect().top - containerTop
    } : null;
  };

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const previous = preservedScrollRef.current;
    if (!element) return;
    if (transcriptFollowsLatestRef.current) {
      element.scrollTop = element.scrollHeight;
    } else if (previous?.anchorId && previous.anchorOffset !== null) {
      const anchor = [...element.querySelectorAll<HTMLElement>('.message-row[data-message-id]')]
        .find(row => row.dataset.messageId === previous.anchorId);
      if (anchor) {
        const anchorOffset = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
        element.scrollTop += anchorOffset - previous.anchorOffset;
      }
    }
    captureScrollAnchor(element);
    return () => {
      const current = scrollRef.current;
      if (current) captureScrollAnchor(current);
    };
  }, [messages, runtime?.members]);

  const runningMembers = runtime?.members
    .map(member => ({ member, bot: bots.find(bot => bot.id === member.botId) }))
    .filter((item): item is { member: GroupRuntimeMember; bot: Bot } => Boolean(item.bot)) ?? [];
  const latestActivity = runningMembers
    .filter(item => item.member.phase === 'working' && item.member.activityKind)
    .sort((a, b) => (a.member.activityUpdatedAt ?? '').localeCompare(b.member.activityUpdatedAt ?? ''))
    .at(-1);
  const runningLabel = latestActivity?.member.activityKind
    ? ACTIVITY_LABELS[latestActivity.member.activityKind]
    : runningMembers.some(item => item.member.phase === 'starting')
      ? '正在读消息'
      : runningMembers.length > 0 && runningMembers.every(item => item.member.phase === 'judging')
        ? '正在判断'
        : '正在思考';

  return (
      <section className="chat-workspace group-workspace" aria-label={group.title}>
      <div className="group-purpose-banner">
        <span className="group-purpose-owner">群主 {owner?.name ?? '不可用'}</span>
        <p>{group.purpose || '尚未设置群职责'}</p>
      </div>
      <div className="transcript-scroll" ref={scrollRef} aria-label="群聊消息"
        onScroll={event => {
          const element = event.currentTarget;
          transcriptFollowsLatestRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 36;
          captureScrollAnchor(element);
        }}>
        {loading ? <div className="messages-loading" aria-label="正在读取群聊" /> : messages.length > 0 ? (
          <div className="message-column">
            {messages.map((message, index) => (
              <Fragment key={message.id}>
                {shouldShowMessageTimeDivider(messages, index) && (
                  <MessageTimeDivider value={message.createdAt} />
                )}
                <GroupMessageRow
                  message={message}
                  bots={bots}
                  entering={enteringMessageIds.has(message.id)}
                />
              </Fragment>
            ))}
          </div>
        ) : (
          <div className="conversation-empty-state">
            <strong>开始群聊</strong>
            <p>普通消息由成员各自判断是否回复；@名字 指定一个成员，@everyone 通知所有其他活跃成员自主判断。</p>
          </div>
        )}
      </div>
      <ChatScrollbar scrollRef={scrollRef} />
      <div className="chat-bottom-dock">
        <div className="chat-running-dock">
          <AgentRunningRow
            visible={runningMembers.length > 0}
            bots={runningMembers.map(item => item.bot)}
            autoAnimate
            label={runningLabel} />
        </div>
        <Composer groupBots={activeMembers} busy={runningMembers.length > 0}
          disabled={activeMembers.length === 0}
          disabledReason={activeMembers.length === 0 ? '群聊中没有活跃的 Bot' : null}
          placeholder="发送群聊消息…" ariaLabel="群聊消息输入框"
          onSend={async text => {
            transcriptFollowsLatestRef.current = true;
            await onSend(text);
          }}
          onStop={onStop} />
        {hasUnreadyMembers && (
          <div className="form-error composer-readiness-error" role="status">
            群聊中有 Bot 尚未完成“模型与权限”配置。普通消息和 @everyone 需要所有活跃成员配置完成；也可以 @名字 指定已配置的 Bot。
          </div>
        )}
      </div>
    </section>
  );
}

function GroupMessageRow({ message, bots, entering = false }: {
  message: GroupMessage;
  bots: Bot[];
  entering?: boolean;
}) {
  if (message.role === 'system') {
    return (
      <div className="chat-system-notice" role="status">
        <span className="chat-system-notice-icon"><Icon name="check" size={12} /></span>
        <strong>{message.text}</strong>
      </div>
    );
  }
  const sender = message.senderBotId ? bots.find(bot => bot.id === message.senderBotId) : undefined;
  const roleLabel = message.role === 'assistant' ? sender?.name ?? '已删除的 Bot' : '系统';
  return (
    <article
      className={'message-row message-' + message.role +
        (message.role === 'assistant' ? ' message-with-avatar' : '') +
        (entering ? ' message-entering' : '')}
      data-message-id={message.id}
    >
      {message.role === 'assistant' && (
        <span className="message-avatar" aria-hidden="true">
          {sender
            ? <Avatar value={sender.avatar} size="small" followOnHover={false} />
            : <span className="message-avatar-fallback"><Icon name="users" size={12} /></span>}
        </span>
      )}
      <div className={'message-content' + (message.content ? ' message-content-rich' : '')}>
        {message.role !== 'user' && <div className="message-author">{roleLabel}</div>}
        <div className="message-text"><StageAwareMessageContent message={message} /></div>
        {(message.status === 'failed' || message.status === 'interrupted') && (
          <div className="message-status">{message.status === 'failed' ? '未完成' : '已停止'}</div>
        )}
        <MessageHoverTime value={message.createdAt} align={message.role === 'user' ? 'right' : 'left'} />
      </div>
    </article>
  );
}

function runtimeLabel(status: RuntimeState['status']): string {
  if (status === 'ready') return 'Codex 已连接';
  if (status === 'starting') return '正在连接';
  if (status === 'error') return '连接异常';
  return 'Codex 未启动';
}

function timestampLabel(value: string | null): string {
  if (!value) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function MessageTimeDivider({ value }: { value: string }) {
  return (
    <div className="message-time-divider" role="separator" aria-label={`时间 ${formatMessageDivider(value)}`}>
      <time dateTime={value}>{formatMessageDivider(value)}</time>
    </div>
  );
}

function MessageHoverTime({ value, align }: { value: string; align: 'left' | 'right' }) {
  return (
    <time className={`message-hover-time message-hover-time-${align}`} dateTime={value}>
      {formatMessageHoverTime(value)}
    </time>
  );
}

const ACTIVITY_LABELS: Record<TurnActivity['kind'], string> = {
  reasoning: '正在思考',
  command: '正在运行命令',
  file: '正在处理文件',
  web: '正在搜索网页',
  mcp: '正在调用工具',
  tool: '正在调用工具',
  plan: '正在整理计划',
  image: '正在生成图片',
  collab: '正在协作',
  other: '正在处理'
};

function AgentRunningRow({
  bots,
  label,
  visible = true,
  autoAnimate = false
}: {
  bots: Bot[];
  label: string;
  visible?: boolean;
  autoAnimate?: boolean;
}) {
  const visibleBots = bots.slice(-3);
  const overflow = bots.slice(0, -3);
  return (
    <div
      className={'agent-running-row' + (visible ? '' : ' agent-running-row-hidden')}
      role="status"
      aria-live="polite"
      aria-label={label}
      aria-hidden={!visible}
    >
      <span className="agent-running-avatars" aria-hidden="true">
        {visibleBots.map(bot => (
          <span className="agent-running-avatar" key={bot.id} title={bot.name}>
            <Avatar
              value={bot.avatar}
              size="small"
              animated={autoAnimate}
              followOnHover={false}
            />
          </span>
        ))}
        {overflow.length > 0 && (
          <span className="agent-running-overflow" title={overflow.map(bot => bot.name).join('、')}>
            +{overflow.length}
          </span>
        )}
      </span>
      <span className="agent-running-shimmer" key={label}>{label}</span>
    </div>
  );
}

function VoiceWaveform({
  state = 'live',
  levels
}: {
  state?: 'live' | 'stopping';
  levels?: (barCount: number) => { levels: number[]; speech: boolean } | null;
}) {
  const barsRef = useRef<HTMLSpanElement>(null);
  const barCount = 13;

  useLayoutEffect(() => {
    const container = barsRef.current;
    if (!container) return;
    const bars = [...container.children] as HTMLElement[];
    const resetBars = () => {
      container.dataset.voiceActivity = 'idle';
      for (const bar of bars) bar.style.transform = '';
    };
    if (!levels || state !== 'live') {
      resetBars();
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      resetBars();
      return;
    }
    const smoother = createVoiceWaveformSmoother(barCount);
    let frame = 0;
    let retryTimer = 0;
    let metered = false;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const sampled = levels(bars.length);
      if (sampled === null) {
        if (!metered) {
          retryTimer = window.setTimeout(() => {
            frame = window.requestAnimationFrame(tick);
          }, 120);
        }
        return;
      }
      if (!metered) {
        metered = true;
        for (const bar of bars) bar.style.animation = 'none';
      }
      const delta = Math.min(48, Math.max(8, now - lastTime));
      lastTime = now;
      const next = smoother.next(sampled.levels, sampled.speech, delta);
      for (let index = 0; index < bars.length; index += 1) {
        bars[index].style.transform = `scaleY(${next.levels[index].toFixed(3)})`;
      }
      container.dataset.voiceActivity = next.activity;
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(retryTimer);
    };
  }, [levels, state]);

  return (
    <span
      ref={barsRef}
      className={`voice-waveform voice-waveform-call voice-waveform-${state}`}
      data-state={state}
      aria-hidden="true"
    >
      {Array.from({ length: barCount }, (_, index) => (
        <span
          className="voice-waveform-bar"
          key={index}
        />
      ))}
    </span>
  );
}

function ChatScrollbar({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const [metrics, setMetrics] = useState({ overflow: false, height: 0, offset: 0 });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    let resizeObserver: ResizeObserver | null = null;

    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { clientHeight, scrollHeight, scrollTop } = element;
        const overflow = scrollHeight > clientHeight + 1 && clientHeight > 0;
        const height = overflow
          ? Math.max(26, Math.round(clientHeight * (clientHeight / scrollHeight)))
          : 0;
        const maxOffset = Math.max(0, clientHeight - height);
        const offset = overflow && scrollHeight > clientHeight
          ? Math.round((scrollTop / (scrollHeight - clientHeight)) * maxOffset)
          : 0;
        setMetrics(current => current.overflow === overflow &&
          current.height === height && current.offset === offset
          ? current
          : { overflow, height, offset });
      });
    };

    const observeContent = () => {
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(measure);
      resizeObserver.observe(element);
      if (element.firstElementChild instanceof Element) {
        resizeObserver.observe(element.firstElementChild);
      }
      measure();
    };

    const mutationObserver = new MutationObserver(observeContent);
    mutationObserver.observe(element, { childList: true });
    element.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    observeContent();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      element.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [scrollRef]);

  return (
    <div className="chat-scrollbar" data-overflow={metrics.overflow ? 'true' : 'false'} aria-hidden="true">
      <span
        className="chat-scrollbar-thumb"
        style={metrics.overflow ? { height: metrics.height, transform: `translateY(${metrics.offset}px)` } : undefined}
      />
    </div>
  );
}

function MessageRow({
  message,
  entering = false
}: { message: Message; entering?: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const isVoiceTranscript = message.source === 'voice';
  const voiceStreaming = isVoiceTranscript && message.status === 'streaming';
  const voiceFragments = useVoiceTranscriptFragments(message.text, voiceStreaming);

  if (message.role === 'system') {
    return (
      <div className="chat-system-notice" role="status">
        <span className="chat-system-notice-icon"><Icon name="check" size={12} /></span>
        <strong>{message.text}</strong>
      </div>
    );
  }
  return (
    <article
      className={'message-row message-' + message.role +
        (entering ? ' message-entering' : '') +
        (voiceStreaming ? ' message-voice-streaming' : '')}
      data-message-id={message.id}
    >
      <div
        ref={contentRef}
        className={'message-content' + (message.content ? ' message-content-rich' : '')}
        data-voice-streaming={voiceStreaming ? 'true' : undefined}
      >
        <div className="message-text">
          {isVoiceTranscript
            ? <VoiceTranscriptText
                text={message.text}
                fragments={voiceFragments}
                loading={voiceStreaming}
                role={message.role}
              />
            : <StageAwareMessageContent message={message} />}
        </div>
        {(message.status === 'failed' || message.status === 'interrupted') && (
          <div className="message-status">
            {message.status === 'failed' ? '未完成' : '已停止'}
          </div>
        )}
        {message.role === 'user' && message.dispatchStatus && message.dispatchStatus !== 'dispatched' && (
          <div className="message-status">
            {message.dispatchStatus === 'queued' ? '排队中，等待派发' :
              message.dispatchStatus === 'needs_user' ? '发送结果未确认，请检查后决定是否重发' :
                message.dispatchStatus === 'failed' ? '发送失败' : null}
          </div>
        )}
        <MessageHoverTime value={message.createdAt} align={message.role === 'user' ? 'right' : 'left'} />
      </div>
    </article>
  );
}

function useVoiceTranscriptFragments(text: string, streaming: boolean): VoiceTranscriptFragment[] {
  const previousTextRef = useRef('');
  const sequenceRef = useRef(0);
  const fragmentsRef = useRef<VoiceTranscriptFragment[]>([]);
  if (!streaming) {
    previousTextRef.current = '';
    fragmentsRef.current = [];
    return fragmentsRef.current;
  }
  const previousText = previousTextRef.current;
  if (text === previousText) return fragmentsRef.current;
  const extendsPrevious = text.startsWith(previousText);
  const appendedText = extendsPrevious ? text.slice(previousText.length) : text;
  previousTextRef.current = text;
  if (!appendedText) return fragmentsRef.current;
  const fragment = { text: appendedText, sequence: ++sequenceRef.current };
  fragmentsRef.current = extendsPrevious
    ? [...fragmentsRef.current, fragment]
    : [fragment];
  return fragmentsRef.current;
}

function VoiceTranscriptText({ text, fragments, loading, role }: {
  text: string;
  fragments?: VoiceTranscriptFragment[];
  loading: boolean;
  role: 'user' | 'assistant';
}) {
  const animatedSuffix = fragments?.map(fragment => fragment.text).join('') ?? '';
  const visibleFragments = animatedSuffix && text.endsWith(animatedSuffix) ? fragments ?? [] : [];
  const prefix = visibleFragments.length ? text.slice(0, -animatedSuffix.length) : text;
  return (
    <span className="voice-transcript-text">
      {prefix}
      {visibleFragments.map(fragment => (
        <span key={fragment.sequence} className="voice-transcript-fragment">{fragment.text}</span>
      ))}
      {loading && (
        <span
          className="voice-transcript-progress"
          role="status"
          aria-label={role === 'assistant' ? '语音回复生成中' : '语音转写生成中'}
        >
          <span className="voice-transcript-caret" />
        </span>
      )}
    </span>
  );
}

function StageAwareMessageContent({ message }: { message: Message | GroupMessage }) {
  const stageKey = `${message.turnId ?? ''}:${message.itemId ?? message.id}:${message.phase ?? ''}`;
  const previousStageKeyRef = useRef(stageKey);
  const [animationSequence, setAnimationSequence] = useState(0);

  useLayoutEffect(() => {
    if (previousStageKeyRef.current === stageKey) return;
    previousStageKeyRef.current = stageKey;
    setAnimationSequence(current => current + 1);
  }, [stageKey]);

  return (
    <div
      key={animationSequence}
      className={animationSequence > 0 ? 'message-stage-transition' : undefined}
    >
      <MessageContentView message={message} />
    </div>
  );
}

function Composer({
  groupBots,
  busy,
  onSend,
  onStop,
  voiceState,
  onStartVoice,
  onStopVoice,
  disabled = false,
  disabledReason,
  placeholder = '发消息给机器人',
  ariaLabel = '消息'
}: {
  groupBots?: Bot[];
  busy: boolean;
  onSend: (text: string) => Promise<void>;
  onStop?: () => Promise<void>;
  voiceState?: VoiceState | null;
  onStartVoice?: () => void;
  onStopVoice?: () => void;
  disabled?: boolean;
  disabledReason?: string | null;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [selectingFiles, setSelectingFiles] = useState(false);
  const draftRef = useRef('');
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const attachmentOwnerId = useId();
  const [mention, setMention] = useState<ReturnType<typeof mentionRange>>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const mentionListId = useId();
  const canSend = Boolean(draft.trim() || attachments.length) && !sending && !disabled;
  const options = groupBots && mention ? mentionOptions(groupBots, mention.query) : [];
  const mentionOpen = Boolean(mention && options.length);
  const activeMentionIndex = options.length ? Math.min(mentionIndex, options.length - 1) : 0;

  useEffect(() => {
    // Keep the attachments occupied until the send IPC settles so cleanup
    // cannot race the message reference being committed.
    if (sending) return;
    void window.rambo.setComposerDraftAttachments(
      attachmentOwnerId,
      attachments.map(attachment => attachment.path)
    ).catch(error => {
      console.error('[Rambo] unable to report composer draft attachments', error);
    });
  }, [attachmentOwnerId, attachments, sending]);

  useEffect(() => () => {
    void window.rambo.releaseComposerDraftAttachments(attachmentOwnerId).catch(error => {
      console.error('[Rambo] unable to release composer draft attachments', error);
    });
  }, [attachmentOwnerId]);

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null || !textareaRef.current) return;
    pendingCaretRef.current = null;
    const element = textareaRef.current;
    element.focus();
    element.setSelectionRange(caret, caret);
    element.style.height = 'auto';
    element.style.height = Math.min(element.scrollHeight, 180) + 'px';
  }, [draft]);

  useEffect(() => {
    if (mentionIndex >= options.length) setMentionIndex(Math.max(0, options.length - 1));
  }, [mentionIndex, options.length]);

  const syncMention = (value: string, caret: number | null) => {
    if (!groupBots) {
      setMention(null);
      return;
    }
    setMention(mentionRange(value, caret));
    setMentionIndex(0);
  };

  const chooseMention = (option: MentionOption) => {
    if (!mention) return;
    const next = insertMention(draft, mention, option.name);
    pendingCaretRef.current = next.caret;
    setDraft(next.value);
    draftRef.current = next.value;
    setMention(null);
    setMentionIndex(0);
  };

  const updateAttachments = (
    update: (current: ComposerAttachment[]) => ComposerAttachment[]
  ) => {
    setAttachments(current => {
      const next = dedupeComposerAttachments(update(current));
      attachmentsRef.current = next;
      return next;
    });
  };

  const appendAttachments = (incoming: ComposerAttachment[]) => {
    if (!incoming.length) return;
    updateAttachments(current => [...current, ...incoming]);
  };

  const registerAttachmentPaths = async (paths: string[]) => {
    if (!paths.length || disabled || sending) return;
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (!uniquePaths.length) return;
    setAttachmentError(null);
    try {
      appendAttachments(await window.rambo.registerLocalAttachments(uniquePaths));
    } catch (error) {
      setAttachmentError(toError(error));
    }
  };

  const savePastedImage = async (dataUrl: string) => {
    if (disabled || sending || !parseImageDataUrl(dataUrl)) return false;
    setAttachmentError(null);
    try {
      appendAttachments([await window.rambo.savePastedImage(dataUrl)]);
      return true;
    } catch (error) {
      setAttachmentError(toError(error));
      return false;
    }
  };

  const addClipboardFiles = async (files: File[]) => {
    if (!files.length || disabled || sending) return false;
    try {
      const paths: string[] = [];
      const imageDataUrls: string[] = [];
      for (const file of files) {
        const path = window.rambo.pathForFile(file);
        if (path) paths.push(path);
        else if (file.type.startsWith('image/')) {
          imageDataUrls.push(await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onerror = () => reject(reader.error ?? new Error('无法读取剪贴板图片'));
            reader.readAsDataURL(file);
          }));
        }
      }
      if (paths.length) await registerAttachmentPaths(paths);
      let addedImage = false;
      for (const dataUrl of imageDataUrls) {
        addedImage = await savePastedImage(dataUrl) || addedImage;
      }
      return paths.length > 0 || addedImage;
    } catch (error) {
      setAttachmentError(toError(error));
      return false;
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const draftValue = event ? draft : draftRef.current;
    const text = draftValue.trim();
    const selectedAttachments = attachmentsRef.current;
    if ((!text && !selectedAttachments.length) || sending || disabled) return;
    const message = composeComposerMessage(
      text,
      selectedAttachments.map(attachment => attachment.path)
    );
    const textarea = textareaRef.current;
    setSending(true);
    setDraft('');
    draftRef.current = '';
    updateAttachments(() => []);
    setAttachmentError(null);
    setMention(null);
    if (textarea) textarea.style.height = 'auto';
    try {
      await onSend(message);
    } catch {
      // The draft stays in the composer so the user can review or retry it.
      setDraft(draftValue);
      draftRef.current = draftValue;
      updateAttachments(() => selectedAttachments);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 180) + 'px';
      }
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex(current => {
          const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
          return (next + options.length) % options.length;
        });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        chooseMention(options[activeMentionIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const selectLocalFiles = async () => {
    if (disabled || selectingFiles) return;
    setSelectingFiles(true);
    try {
      await registerAttachmentPaths(await window.rambo.selectLocalFiles());
    } catch (error) {
      setAttachmentError(toError(error));
    } finally {
      setSelectingFiles(false);
      textareaRef.current?.focus();
    }
  };

  const hasFilePayload = (event: ReactDragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const onDragEnter = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    if (!disabled) setDropActive(true);
  };

  const onDragOver = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  };

  const onDragLeave = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
  };

  const onDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    setDropActive(false);
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    const paths = Array.from(event.dataTransfer.files as FileList)
      .map(file => window.rambo.pathForFile(file))
      .filter(Boolean);
    void registerAttachmentPaths(paths);
  };

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardData = event.clipboardData;
    if (!clipboardData || disabled) return;
    const itemFiles = Array.from(clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const files = itemFiles.length ? itemFiles : Array.from(clipboardData.files);
    const hasPasteableFile = files.some(file =>
      Boolean(window.rambo.pathForFile(file)) || file.type.startsWith('image/')
    );
    if (hasPasteableFile) {
      event.preventDefault();
      void addClipboardFiles(files);
      return;
    }
    const imageDataUrl = clipboardData.getData('text/plain');
    if (parseImageDataUrl(imageDataUrl)) {
      event.preventDefault();
      void savePastedImage(imageDataUrl);
    }
  };

  return (
    <div className="composer-dock">
      <form className={'composer' + (focused ? ' composer-focused' : '') + (dropActive ? ' composer-drop-active' : '')}
        onSubmit={event => void submit(event)}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}>
        {(attachments.length > 0 || attachmentError) && (
          <div className="composer-attachment-region">
            {attachments.length > 0 && (
              <div className="composer-attachments" aria-label="附件区">
                {attachments.map(attachment => (
                  <div
                    className="composer-attachment"
                    data-composer-attachment
                    data-attachment-path={attachment.path}
                    key={attachment.path}
                  >
                    <span className="composer-attachment-visual" aria-hidden="true">
                      {attachment.kind === 'image' && attachment.previewUrl
                        ? <img src={attachment.previewUrl} alt="" loading="lazy" />
                        : <span>{attachment.kind === 'image' ? 'IMG' : extensionLabel(attachment.name)}</span>}
                    </span>
                    <span className="composer-attachment-copy">
                      <strong title={attachment.name}>{attachment.name}</strong>
                      <small title={attachment.path}>{attachment.path}</small>
                    </span>
                    <button
                      type="button"
                      className="composer-attachment-remove"
                      aria-label={`移除附件 ${attachment.name}`}
                      title="移除附件"
                      disabled={disabled}
                      onClick={() => {
                        setAttachmentError(null);
                        updateAttachments(current =>
                          current.filter(item => item.path !== attachment.path)
                        );
                        textareaRef.current?.focus();
                      }}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachmentError && (
              <div className="composer-attachment-error" role="alert">{attachmentError}</div>
            )}
          </div>
        )}
        <div className="composer-input-row">
          <button type="button" className="composer-add" aria-label="添加附件"
            title={disabled ? disabledReason ?? '当前配置尚未就绪' : '添加本机附件'}
            disabled={disabled || selectingFiles}
            onClick={() => void selectLocalFiles()}>
            <Icon name="paperclip" size={18} />
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={placeholder}
            aria-label={ariaLabel}
            role={groupBots ? 'combobox' : undefined}
            aria-autocomplete={groupBots ? 'list' : undefined}
            aria-controls={mentionOpen ? mentionListId : undefined}
            aria-expanded={groupBots ? mentionOpen : undefined}
            aria-activedescendant={mentionOpen ? `${mentionListId}-${activeMentionIndex}` : undefined}
            disabled={disabled}
            title={disabled ? disabledReason ?? undefined : undefined}
            onChange={event => {
              const value = event.target.value;
              setDraft(value);
              draftRef.current = value;
              syncMention(value, event.target.selectionStart);
              event.target.style.height = 'auto';
              event.target.style.height = Math.min(event.target.scrollHeight, 180) + 'px';
            }}
            onSelect={event => {
              if (mentionOpen) return;
              syncMention(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
          />
          <div className="composer-actions">
            {onStartVoice && onStopVoice && (
              <button type="button"
                className={'voice-button' + (voiceState === 'live' ? ' voice-button-live' : '')}
                aria-label={voiceState ? '结束语音' : '开始语音'}
                disabled={disabled || voiceState === 'connecting' || voiceState === 'stopping'}
                title={disabled
                  ? disabledReason ?? '当前配置尚未就绪'
                  : voiceState ? '结束语音' : '开始 Codex Live 语音'}
                onClick={voiceState ? onStopVoice : onStartVoice}>
                <Icon name="voice" size={17} />
              </button>
            )}
            {busy && onStop && (
              <button type="button" className="stop-button" aria-label="停止任务" title="停止"
                onClick={() => void onStop()}>
                <Icon name="stop" size={14} />
              </button>
            )}
            <button type="submit" className="send-button" disabled={!canSend}
              aria-label="发送" title="发送">
              <Icon name="send" size={17} />
            </button>
          </div>
        </div>
        {mentionOpen && (
          <div className="mention-menu" id={mentionListId} role="listbox" aria-label="选择要提及的群聊成员">
            {options.map((option, index) => (
              <button
                key={option.key}
                id={`${mentionListId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeMentionIndex}
                className={'mention-option' + (index === activeMentionIndex ? ' mention-option-active' : '')}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => chooseMention(option)}
              >
                <span className="mention-option-avatar" aria-hidden="true">
                  {option.kind === 'everyone'
                    ? <Icon name="users" size={15} />
                    : <Avatar
                        value={groupBots?.find(bot => bot.id === option.botId)?.avatar ?? ''}
                        size="small"
                        followOnHover={false}
                      />}
                </span>
                <span className="mention-option-copy">
                  <strong>@{option.name}</strong>
                  <span>{option.detail}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}

function NoChatWorkspace({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  return (
    <div className="no-chat-workspace">
      <Avatar value={bot.avatar} size="large" />
      <button type="button" className="primary-button" onClick={onOpen}>
        <span>打开聊天</span>
      </button>
    </div>
  );
}

function CreateBotDialog({
  busy,
  readinessError,
  onCancel,
  onCreate
}: {
  busy: boolean;
  readinessError: string | null;
  onCancel: () => void;
  onCreate: (name: string, avatar: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(createInitialAvatar);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('请输入 Bot 名称。');
      nameRef.current?.focus();
      return;
    }
    setError(null);
    try { await onCreate(name.trim(), avatar); }
    catch (issue) { setError(toError(issue)); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="dialog-header">
          <h2 id="create-title">创建新 Bot</h2>
          <button type="button" className="icon-button dialog-close" aria-label="关闭"
            disabled={busy} onClick={onCancel}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <form onSubmit={event => void submit(event)}>
          <div className="avatar-preview-stage" data-avatar-follow-region="">
            <Avatar value={avatar} size="preview" followOnHover />
          </div>
          <input
            ref={nameRef}
            id="new-bot-name"
            aria-label="Bot 名称"
            className="text-input"
            value={name}
            maxLength={255}
            placeholder="给你的 Bot 起个名字"
            disabled={busy}
            onChange={event => { setName(event.target.value); setError(null); }}
          />
          <AvatarPicker value={avatar} onChange={setAvatar} disabled={busy} />
          {readinessError && <div className="form-error" role="status">{readinessError}</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
            <button type="submit" className="primary-button"
              disabled={busy || !name.trim() || Boolean(readinessError)}>
              {busy ? '正在创建…' : '创建'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (confirmed: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await runAfterExplicitConfirmation(confirmed, onConfirm);
      onCancel();
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="create-dialog confirmation-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="dialog-header">
          <div><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div>
        </header>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void resolve(false)}>取消</button>
          <button type="button" className="danger-button" disabled={busy} onClick={() => void resolve(true)}>
            {busy ? '正在删除…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function McpElicitationDialog({
  prompt,
  busy,
  onAction
}: {
  prompt: McpElicitationPrompt;
  busy: boolean;
  onAction: (action: McpElicitationAction) => Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <div className="modal-backdrop">
      <section className="create-dialog mcp-elicitation-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">MCP 权限请求</span>
            <h2 id={titleId}>{prompt.message}</h2>
            <p id={descriptionId}>
              {prompt.serverName}{prompt.toolName ? ` · ${prompt.toolName}` : ''}
            </p>
          </div>
        </header>
        {prompt.detail && (
          <p className="mcp-elicitation-detail">{prompt.detail}</p>
        )}
        <p className="mcp-elicitation-note">
          只有在你明确同意后，插件才能继续访问该应用或执行本次工具调用。
        </p>
        <div className="dialog-actions mcp-elicitation-actions">
          <button type="button" className="secondary-button" disabled={busy}
            onClick={() => void onAction('cancel')}>取消</button>
          <button type="button" className="secondary-button" disabled={busy}
            onClick={() => void onAction('decline')}>拒绝</button>
          <button type="button" className="primary-button" disabled={busy}
            onClick={() => void onAction('accept')}>
            {busy ? '正在处理…' : '允许本次'}
          </button>
        </div>
      </section>
    </div>
  );
}

function SecretCaptureDialog({
  prompt,
  onCancel,
  onSave
}: {
  prompt: SecretCapturePrompt;
  onCancel: () => Promise<void>;
  onSave: (secret: string) => Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !secret) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(secret);
      setSecret('');
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCancel();
      setSecret('');
    } catch (issue) {
      setError(toError(issue));
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="create-dialog secret-capture-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">本机安全输入</span>
            <h2 id={titleId}>{prompt.operation === 'rotate' ? '轮换密钥' : '保存密钥'}</h2>
            <p id={descriptionId}>
              {prompt.botName} · {prompt.scope === 'global' ? '所有 Bot 可用' : '仅当前 Bot 可用'}
            </p>
          </div>
        </header>
        <div className="secret-capture-summary">
          <strong>{prompt.name}</strong>
          {prompt.description && <span>{prompt.description}</span>}
        </div>
        <form onSubmit={event => void submit(event)}>
          <label className="secret-capture-field">
            <span>{prompt.operation === 'rotate' ? '新密钥正文' : '密钥正文'}</span>
            <input
              className="text-input"
              type="password"
              value={secret}
              maxLength={65_536}
              autoComplete="new-password"
              spellCheck={false}
              autoFocus
              disabled={busy}
              onChange={event => {
                setSecret(event.target.value);
                setError(null);
              }}
            />
          </label>
          <p className="secret-capture-note">
            正文只从本窗口直接交给 Rambo 主进程并加密保存，不进入聊天消息、模型上下文或工具参数。
          </p>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" disabled={busy}
              onClick={() => void cancel()}>取消</button>
            <button type="submit" className="primary-button" disabled={busy || !secret}>
              {busy ? '正在确认…' : prompt.operation === 'rotate' ? '安全轮换' : '安全保存'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AutoSaveIndicator({ state, error }: { state: AutoSaveState; error?: string | null }) {
  if (error) return <span className="autosave-indicator autosave-error" role="alert">{error}</span>;
  if (state === 'idle') return null;
  const label = {
    pending: '等待保存…',
    saving: '正在自动保存…',
    saved: '已自动保存',
    error: '保存失败'
  }[state];
  return <span className={'autosave-indicator' + (state === 'saved' ? ' autosave-complete' : '')} role="status">{label}</span>;
}

function RuntimeProxySetting({
  value,
  busy,
  onChange
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!saving) setDraft(value);
  }, [value, saving]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const save = async () => {
    const proxy = draft.trim();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await onChange(proxy);
      setDraft(proxy);
      setNotice(proxy ? '代理已保存，Codex 已重启。' : '代理已清除，Codex 已重启。');
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="runtime-proxy-setting">
      <label className="settings-field" htmlFor="runtime-proxy">
        <span>代理地址</span>
        <input
          id="runtime-proxy"
          className="text-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="http://127.0.0.1:10808"
          value={draft}
          disabled={busy || saving}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void save();
            }
          }}
        />
        <span className="field-hint">可留空；填写后仅传给 Rambo 启动的 Codex，不影响系统代理。保存时会重启运行时。</span>
      </label>
      <div className="runtime-proxy-actions">
        <AutoSaveIndicator state={saving ? 'saving' : error ? 'error' : notice ? 'saved' : 'idle'} error={error} />
        {notice && !error && <span className="autosave-indicator autosave-complete" role="status">{notice}</span>}
        <button type="button" className="secondary-button" disabled={busy || saving || draft.trim() === value.trim()}
          onClick={() => void save()}>{saving ? '保存并重启…' : '保存代理'}</button>
      </div>
    </div>
  );
}

const RESOURCE_KIND_LABELS: Record<BotResource['kind'], string> = {
  skill: 'Skill',
  mcp: 'MCP',
  app: 'App',
  plugin: 'Plugin'
};

const RESOURCE_SECTIONS: Array<{ id: ResourceSection; label: string }> = [
  { id: 'skills', label: '技能' },
  { id: 'mcp', label: 'MCP 服务' },
  { id: 'plugins', label: '插件' }
];

function resourceMatchesSection(resource: BotResource, section: ResourceSection): boolean {
  if (section === 'skills') return resource.kind === 'skill';
  if (section === 'mcp') return resource.kind === 'mcp';
  // App is retained in the same packaged-capability area rather than being
  // hidden; its type badge still distinguishes it from Plugin.
  return resource.kind === 'plugin' || resource.kind === 'app';
}

function ResourceSectionTabs({
  value,
  resources,
  onChange
}: {
  value: ResourceSection;
  resources: BotResource[];
  onChange: (section: ResourceSection) => void;
}) {
  return (
    <div className="resource-subtabs" role="tablist" aria-label="资源分类">
      {RESOURCE_SECTIONS.map(section => {
        const count = resources.filter(resource =>
          resourceMatchesSection(resource, section.id)).length;
        return (
          <button type="button" role="tab" key={section.id}
            aria-selected={value === section.id}
            className={'resource-subtab' + (value === section.id ? ' selected' : '')}
            onClick={() => onChange(section.id)}>
            <span>{section.label}</span>
            <small>{count}</small>
          </button>
        );
      })}
    </div>
  );
}

function ResourceRows({
  resources,
  enabledIds = [],
  onToggle,
  action,
  onDelete,
  canDelete,
  deleteLabel = '删除',
  detail
}: {
  resources: BotResource[];
  enabledIds?: string[];
  onToggle?: (resourceId: string, enabled: boolean) => Promise<void>;
  action?: (resource: BotResource) => ReactNode;
  onDelete?: (resource: BotResource) => void;
  canDelete?: (resource: BotResource) => boolean;
  deleteLabel?: string;
  detail?: (resource: BotResource) => ReactNode;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  if (!resources.length) return <div className="memory-empty-state" role="status">目录中暂无资源。</div>;
  return (
    <>
      {error && <div className="form-error" role="alert">{error}</div>}
      <ul className="resource-list" aria-label="资源列表">
        {resources.map(resource => {
          const enabled = enabledIds.includes(resource.id);
          return (
            <li className="resource-row" data-resource-id={resource.id}
              data-enabled={enabled ? 'true' : 'false'} key={resource.id}>
              <div className="resource-copy">
                <div className="resource-title-line">
                  <strong>{resource.name}</strong>
                  <span className="resource-kind">{RESOURCE_KIND_LABELS[resource.kind]}</span>
                  {resource.bundled && <span className="resource-kind">内置</span>}
                </div>
                <span>{resource.description || '暂无说明'}</span>
                <small>来源：{resource.source}</small>
                {detail?.(resource)}
              </div>
              <span className="resource-row-actions">
                {onToggle && (
                  <label className="settings-toggle-row resource-toggle">
                    <span className="sr-only">启用 {resource.name}</span>
                    <input type="checkbox" aria-label={`启用 ${resource.name}`} checked={enabled}
                      disabled={busyId === resource.id}
                      onChange={event => {
                        const next = event.target.checked;
                        setBusyId(resource.id);
                        setError(null);
                        void onToggle(resource.id, next)
                          .catch(issue => setError(toError(issue)))
                          .finally(() => setBusyId(null));
                      }} />
                  </label>
                )}
                {action?.(resource)}
                {onDelete && (!canDelete || canDelete(resource)) && (
                  confirmingDeleteId === resource.id ? (
                    <span className="resource-delete-confirmation">
                      <span>删除后不可恢复</span>
                      <button type="button" className="danger-button resource-action"
                        onClick={() => {
                          setConfirmingDeleteId(null);
                          onDelete(resource);
                        }}>确认删除</button>
                      <button type="button" className="secondary-button resource-action"
                        onClick={() => setConfirmingDeleteId(null)}>取消</button>
                    </span>
                  ) : (
                    <button type="button" className="danger-button resource-action"
                      onClick={() => setConfirmingDeleteId(resource.id)}>{deleteLabel}</button>
                  )
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function BotResourceList({
  resources,
  enabledIds,
  onToggle
}: {
  resources: BotResource[];
  enabledIds: string[];
  onToggle: (resourceId: string, enabled: boolean) => Promise<void>;
}) {
  return <ResourceRows resources={resources} enabledIds={enabledIds} onToggle={onToggle} />;
}

function BotSettingsPage({
  bot,
  resources,
  models,
  modelError,
  routines,
  runs,
  onSave,
  onUpdateExecution,
  onSetResource,
  onSetArchived,
  onRequestDelete
}: {
  bot: Bot;
  resources: BotResource[];
  models: ModelOption[];
  modelError: string | null;
  routines: RoutineListItem[];
  runs: RoutineRun[];
  onSave: (id: string, patch: Partial<Pick<Bot, 'name' | 'avatar' | 'role' | 'instructions' | 'notificationsEnabled'>>) => Promise<void>;
  onUpdateExecution: (id: string, patch: { model: string; permission: PermissionMode }) => Promise<void>;
  onSetResource: (resourceId: string, enabled: boolean) => Promise<void>;
  onSetArchived: (id: string, archived: boolean) => Promise<void>;
  onRequestDelete: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [avatar, setAvatar] = useState(bot.avatar);
  const [role, setRole] = useState(bot.role);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [botModel, setBotModel] = useState(bot.model);
  const [botPermission, setBotPermission] = useState<PermissionMode>(bot.permission);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<AutoSaveState>('idle');
  const [saveScope, setSaveScope] = useState<'profile' | 'session' | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'profile' | 'model' | 'resources' | 'memory' | 'routines' | 'manage'>('profile');
  const [resourceSection, setResourceSection] = useState<ResourceSection>('skills');
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveVersionRef = useRef(0);
  const profileTimersRef = useRef<Partial<Record<'name' | 'role' | 'instructions', number>>>({});

  const enqueueSave = (write: () => Promise<void>, scope: 'profile' | 'session') => {
    const version = ++saveVersionRef.current;
    setSaveScope(scope);
    setSaving(true);
    setSaveStatus('saving');
    setError(null);
    const request = saveQueueRef.current.then(write);
    saveQueueRef.current = request.then(() => undefined, () => undefined);
    void request.then(() => {
      if (version !== saveVersionRef.current) return;
      setSaving(false);
      setSaveStatus('saved');
    }, issue => {
      if (version !== saveVersionRef.current) return;
      setSaving(false);
      setSaveStatus('error');
      setError(toError(issue));
    });
  };

  const saveBotChange = (patch: Partial<Pick<Bot, 'name' | 'avatar' | 'role' | 'instructions' | 'notificationsEnabled'>>) => {
    enqueueSave(() => onSave(bot.id, patch), 'profile');
  };

  const saveExecutionChange = (patch: { model?: string; permission?: PermissionMode }) => {
    const nextModel = patch.model ?? botModel;
    const nextPermission = patch.permission ?? botPermission;
    setBotModel(nextModel);
    setBotPermission(nextPermission);
    if (!nextModel.trim()) {
      setSaveStatus('error');
      setError('Bot 模型不能为空');
      return;
    }
    enqueueSave(() => onUpdateExecution(bot.id, {
      model: nextModel,
      permission: nextPermission
    }), 'session');
  };

  const scheduleProfileSave = (field: 'name' | 'role' | 'instructions', value: string) => {
    const previous = profileTimersRef.current[field];
    if (previous !== undefined) window.clearTimeout(previous);
    setSaveScope('profile');
    setError(null);
    if (field === 'name' && !value.trim()) {
      setSaveStatus('error');
      setError('Bot 名称不能为空，当前修改尚未保存。');
      delete profileTimersRef.current[field];
      return;
    }
    setSaveStatus('pending');
    profileTimersRef.current[field] = window.setTimeout(() => {
      delete profileTimersRef.current[field];
      saveBotChange({ [field]: field === 'name' ? value.trim() : value });
    }, 420);
  };

  const flushProfileSave = (field: 'name' | 'role' | 'instructions', value: string) => {
    const timer = profileTimersRef.current[field];
    if (timer === undefined) return;
    if (timer !== undefined) window.clearTimeout(timer);
    delete profileTimersRef.current[field];
    if (field === 'name' && !value.trim()) return;
    saveBotChange({ [field]: field === 'name' ? value.trim() : value });
  };

  useEffect(() => () => {
    for (const timer of Object.values(profileTimersRef.current)) {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    setBotModel(bot.model);
    setBotPermission(bot.permission);
  }, [bot.id, bot.model, bot.permission]);

  useEffect(() => {
    setName(bot.name);
    setAvatar(bot.avatar);
    setRole(bot.role);
    setInstructions(bot.instructions);
    setActiveTab('profile');
    setResourceSection('skills');
    setSaveStatus('idle');
    setSaveScope(null);
  }, [bot.id]);

  const changeArchived = async () => {
    setLifecycleBusy(true);
    setError(null);
    try { await onSetArchived(bot.id, !bot.archived); }
    catch (issue) { setError(toError(issue)); }
    finally { setLifecycleBusy(false); }
  };

  return (
    <section className="settings-page bot-settings-page">
      <div className="settings-page-heading">
        <div>
          <div className="eyebrow">BOT</div>
          <h1>{bot.name}</h1>
          <p>{bot.role.trim() || '管理这个 Bot 的资料、模型与权限、可用资源和长期记忆。'}</p>
        </div>
        <Avatar value={avatar} size="large" followOnHover />
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Bot 设置分类">
        {([
          ['profile', '基础资料'],
          ['model', '模型与权限'],
          ['resources', '资源管理'],
          ['memory', '长期记忆'],
          ['routines', '定时任务'],
          ['manage', 'Bot 管理']
        ] as const).map(([id, label]) => (
          <button type="button" role="tab" key={id} id={`bot-tab-${id}`}
            aria-selected={activeTab === id} aria-controls={`bot-panel-${id}`}
            className={'settings-tab' + (activeTab === id ? ' selected' : '')}
            onClick={() => setActiveTab(id)}>{label}</button>
        ))}
      </div>

      {activeTab === 'profile' && (
      <section className="settings-form settings-tab-panel" role="tabpanel"
        id="bot-panel-profile" aria-labelledby="bot-tab-profile">
        <label className="settings-field">
          <span>名称</span>
          <input className="text-input" value={name} maxLength={80} required
            onBlur={event => flushProfileSave('name', event.currentTarget.value)}
            onChange={event => {
              const value = event.target.value;
              setName(value);
              scheduleProfileSave('name', value);
            }} />
        </label>
        <div className="settings-field">
          <span>头像</span>
          <div className="avatar-preview-stage settings-avatar-preview-stage" data-avatar-follow-region="">
            <Avatar value={avatar} size="preview" followOnHover />
          </div>
          <AvatarPicker value={avatar} className="settings-avatar-picker"
            onChange={value => { setAvatar(value); saveBotChange({ avatar: value }); }} />
        </div>
        <label className="settings-field">
          <span>短职责</span>
          <input className="text-input" value={role} maxLength={160}
            placeholder="一句话说明这个 Bot 的职责"
            onBlur={event => flushProfileSave('role', event.currentTarget.value)}
            onChange={event => {
              const value = event.target.value;
              setRole(value);
              scheduleProfileSave('role', value);
            }} />
        </label>
        <label className="settings-field">
          <span>长期指令</span>
          <textarea className="text-input settings-textarea" value={instructions} rows={5}
            placeholder="描述这个 Bot 长期遵循的工作方式"
            onBlur={event => flushProfileSave('instructions', event.currentTarget.value)}
            onChange={event => {
              const value = event.target.value;
              setInstructions(value);
              scheduleProfileSave('instructions', value);
            }} />
        </label>
        <label className="settings-toggle-row" data-testid="bot-notifications-toggle">
          <span>
            <strong>新回复提醒</strong>
            <span>窗口未显示这条私聊时发送系统通知；正在查看的私聊不重复提醒。</span>
          </span>
          <input type="checkbox" aria-label="新回复提醒"
            checked={bot.notificationsEnabled}
            disabled={saving}
            onChange={event => saveBotChange({ notificationsEnabled: event.target.checked })} />
        </label>
        <div className="settings-autosave-row">
          <AutoSaveIndicator state={saveScope === 'profile' ? saveStatus : 'idle'}
            error={saveScope === 'profile' ? error : null} />
          <span className="field-hint">正在执行的轮次继续使用启动时的配置。</span>
        </div>
      </section>
      )}

      {activeTab === 'model' && (
      <section className="settings-form settings-tab-panel conversation-settings-form" role="tabpanel"
        id="bot-panel-model" aria-labelledby="bot-tab-model">
        <fieldset className="conversation-settings-card">
          <legend>Bot 执行配置</legend>
          <p className="field-hint">这个 Bot 的唯一私聊、群聊执行和定时任务都使用这里的模型与权限。修改只影响后续轮次。</p>
          <label className="settings-field">
            <span>Bot 模型</span>
            <span className="select-input-control">
                  <select className="text-input select-input" aria-label="Bot 模型" value={botModel}
                    disabled={!models.length}
                onChange={event => saveExecutionChange({ model: event.target.value })}>
                {!models.length && <option value="" disabled>模型列表暂不可用</option>}
                {botModel && !models.some(option => option.id === botModel) && (
                  <option value={botModel}>当前配置 · {botModel}</option>
                )}
                {models.map(option => (
                  <option value={option.id} key={option.id}>
                    {option.label}{option.isDefault ? ' · 产品默认' : ''}
                  </option>
                ))}
              </select>
              <span className="select-input-chevron" aria-hidden="true"><Icon name="chevron" size={14} /></span>
            </span>
            {modelError && <small className="field-hint">暂时无法读取模型列表：{modelError}</small>}
          </label>
          <fieldset className="permission-fieldset conversation-permission-fieldset">
            <legend>Bot 权限</legend>
            <div className="permission-choice-grid">
              <PermissionOption name="bot-permission" value="fullAccess" selected={botPermission}
                onSelect={value => saveExecutionChange({ permission: value })}
                title="完全访问" description="允许 Codex 在本机执行，不限制于 Bot 工作区。" />
              <PermissionOption name="bot-permission" value="workspaceWrite" selected={botPermission}
                onSelect={value => saveExecutionChange({ permission: value })}
                title="工作区写入" description="允许在 Bot 工作区读写，并使用网络。" />
              <PermissionOption name="bot-permission" value="readOnly" selected={botPermission}
                onSelect={value => saveExecutionChange({ permission: value })}
                title="只读" description="不允许写入文件。" />
            </div>
          </fieldset>
          <div className="conversation-settings-actions">
            <span className="field-hint">执行中的轮次继续使用启动时的配置。</span>
            <AutoSaveIndicator state={saveScope === 'session' ? saveStatus : 'idle'}
              error={saveScope === 'session' ? error : null} />
          </div>
        </fieldset>
      </section>
      )}

      {activeTab === 'resources' && (
      <section className="settings-form settings-tab-panel" role="tabpanel"
        id="bot-panel-resources" aria-labelledby="bot-tab-resources">
        <p className="field-hint">这里只显示系统全局可选目录中的资源。插件自带的 MCP 归在插件开关下，不再作为独立 MCP 出现。每个开关只作用于当前 Bot，创建时的状态复制自全局初值。</p>
        <ResourceSectionTabs value={resourceSection} resources={resources}
          onChange={setResourceSection} />
        <BotResourceList
          resources={resources.filter(resource => resourceMatchesSection(resource, resourceSection))}
          enabledIds={bot.resourceIds}
          onToggle={onSetResource} />
        <div className="settings-autosave-row">
          <AutoSaveIndicator state={saveScope === 'session' ? saveStatus : 'idle'}
            error={saveScope === 'session' ? error : null} />
        </div>
      </section>
      )}

      {activeTab === 'memory' && (
      <div className="settings-tab-panel" role="tabpanel"
        id="bot-panel-memory" aria-labelledby="bot-tab-memory">
        <MemoryManager botId={bot.id} title="Bot 专属长期记忆"
          description="这个 Bot 可自动整理保存自己的长期记忆；你也可以在这里查看、编辑或删除。其他 Bot 不会读取这些条目。" />
      </div>
      )}

      {activeTab === 'routines' && (
      <BotRoutineList routines={routines} runs={runs} />
      )}

      {activeTab === 'manage' && (
      <section className="bot-lifecycle-section settings-tab-panel" role="tabpanel"
        id="bot-panel-manage" aria-labelledby="bot-tab-manage"
        aria-label="Bot 归档和删除">
        <div>
          <h2>{bot.archived ? '已归档的 Bot' : 'Bot 管理'}</h2>
          <p>{bot.archived
            ? '恢复后会重新显示聊天和记忆；已暂停的例程保持暂停。'
            : '归档会从主列表隐藏此 Bot、保留聊天和记忆，并暂停它的自动例程。'}</p>
        </div>
        <div className="bot-lifecycle-actions">
          <button type="button" className="secondary-button" disabled={lifecycleBusy || saving}
            onClick={() => void changeArchived()}>
            {lifecycleBusy ? '正在更新…' : bot.archived ? '恢复 Bot' : '归档 Bot'}
          </button>
          <button type="button" className="danger-button" disabled={lifecycleBusy || saving}
            onClick={onRequestDelete}>永久删除 Bot…</button>
        </div>
      </section>
      )}
    </section>
  );
}

function BotRoutineList({ routines, runs }: { routines: RoutineListItem[]; runs: RoutineRun[] }) {
  return (
    <section className="settings-tab-panel bot-routines-section" role="tabpanel"
      id="bot-panel-routines" aria-labelledby="bot-tab-routines"
      data-routine-scope="bot">
      <div className="settings-section-title">
        <div>
          <h2 id="bot-routines-heading">当前 Bot 的定时任务</h2>
          <p>查看这个 Bot 的计划、执行内容、状态和最近运行记录；暂停、恢复和立即运行统一在系统设置中操作。</p>
        </div>
      </div>
      {routines.length === 0 ? (
        <div className="routine-empty-state" role="status">
          <span className="routine-empty-icon"><Icon name="calendar" size={21} /></span>
          <div>
            <h2>暂无定时任务</h2>
            <p>这个 Bot 创建的任务会自动出现在这里；全部任务仍可在系统设置中统一管理。</p>
          </div>
        </div>
      ) : (
        <ul className="routine-list" aria-label={`${routines.length} 个当前 Bot 的定时任务`}>
          {routines.map(routine => (
            <li className="routine-list-item" key={routine.id}>
              <div className="routine-list-copy">
                <strong>{routine.title}</strong>
                <div className="routine-list-meta">
                  <span>{routineScheduleLabel(routine)}</span>
                  <span className="routine-execution-mode">
                    {routineExecutionLabel(routine.definition.execution.mode)}
                  </span>
                </div>
                <p>{routine.definition.instruction}</p>
                <RoutineRunSummary routine={routine} runs={runs} />
              </div>
              <RoutineStatus routine={routine} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PermissionOption({
  name = 'permission',
  value,
  selected,
  onSelect,
  title,
  description
}: {
  name?: string;
  value: PermissionMode;
  selected: PermissionMode | '' | null;
  onSelect: (value: PermissionMode) => void;
  title: string;
  description: string;
}) {
  return (
    <label className={'permission-option' + (selected === value ? ' selected' : '')}>
      <input type="radio" name={name} value={value} checked={selected === value}
        onChange={() => onSelect(value)} />
      <span className="permission-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function MemoryManager({ botId, title, description }: { botId: string | null; title: string; description: string }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [draft, setDraft] = useState('');
  const [draftMemoryId, setDraftMemoryId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<AutoSaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);

  useEffect(() => {
    let active = true;
    const refresh = async (showLoading = false) => {
      if (showLoading) setLoading(true);
      try {
        const next = await window.rambo.memories(botId);
        if (active) { setMemories(next); setError(null); }
      } catch (issue) {
        if (active) setError(toError(issue));
      } finally {
        if (active && showLoading) setLoading(false);
      }
    };
    void refresh(true);
    const unsubscribe = window.rambo.onEvent(event => {
      if (event.type === 'changed') void refresh();
    });
    return () => { active = false; unsubscribe(); };
  }, [botId]);

  const saveDraft = async (text = draft, id = draftMemoryId) => {
    if (!text.trim() || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveStatus('saving');
    setError(null);
    setNotice(null);
    try {
      const memory = await window.rambo.saveMemory({ id: id ?? undefined, botId, text });
      setMemories(current => current.some(item => item.id === memory.id)
        ? current.map(item => item.id === memory.id ? memory : item)
        : [...current, memory].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      setDraftMemoryId(memory.id);
      if (draft === text) {
        setDraft('');
        setDraftMemoryId(null);
      }
      setSaveStatus('saved');
    } catch (issue) {
      setError(toError(issue));
      setSaveStatus('error');
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const saveEdit = async (memory: Memory, text = editText) => {
    if (!text.trim() || text === memory.text || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveStatus('saving');
    setError(null);
    setNotice(null);
    try {
      const updated = await window.rambo.saveMemory({ id: memory.id, botId, text });
      setMemories(current => current.map(item => item.id === updated.id ? updated : item));
      setSaveStatus('saved');
    } catch (issue) {
      setError(toError(issue));
      setSaveStatus('error');
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!draft.trim() || saving) return;
    const timer = window.setTimeout(() => void saveDraft(draft, draftMemoryId), 500);
    return () => window.clearTimeout(timer);
  }, [draft, draftMemoryId, saving, botId]);

  useEffect(() => {
    const memory = memories.find(item => item.id === editingId);
    if (!memory || !editText.trim() || editText === memory.text || saving) return;
    const timer = window.setTimeout(() => void saveEdit(memory, editText), 500);
    return () => window.clearTimeout(timer);
  }, [editingId, editText, memories, saving, botId]);

  const remove = async (memory: Memory) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await window.rambo.deleteMemory(memory.id);
      setMemories(current => current.filter(item => item.id !== memory.id));
      if (editingId === memory.id) { setEditingId(null); setEditText(''); }
      setSaveStatus('saved');
      setNotice('记忆已删除。');
    } catch (issue) {
      setError(toError(issue));
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="memory-manager" aria-label={title}>
      <div className="settings-page-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="memory-create-form">
        <label className="settings-field">
          <span>新增一条长期记忆</span>
          <textarea className="text-input memory-textarea" rows={3} maxLength={20_000} value={draft}
            placeholder="写下适合长期保留的偏好、事实或目标"
            onChange={event => {
              setDraft(event.target.value);
              setSaveStatus(event.target.value.trim() ? 'pending' : 'idle');
              setError(null);
            }}
            onBlur={() => { if (draft.trim()) void saveDraft(draft, draftMemoryId); }} />
        </label>
        <div className="memory-form-actions">
          <span className="field-hint">留空时不会创建条目。</span>
          {!editingId && <AutoSaveIndicator state={saveStatus} error={error} />}
        </div>
      </div>
      {notice && <div className="form-saved" role="status">{notice}</div>}
      {loading ? <div className="memory-empty-state" role="status">正在读取长期记忆…</div>
        : memories.length ? (
          <ul className="memory-list" aria-label={title + '条目'}>
            {memories.map(memory => (
              <li className="memory-item" key={memory.id}>
                {editingId === memory.id ? (
                  <div className="memory-edit-form">
                    <textarea className="text-input memory-textarea" rows={3} maxLength={20_000} value={editText}
                      aria-label="编辑长期记忆" onChange={event => {
                        setEditText(event.target.value);
                        setSaveStatus('pending');
                        setError(null);
                      }}
                      onBlur={() => {
                        const current = memories.find(item => item.id === editingId);
                        if (current) void saveEdit(current, editText);
                      }} />
                    <div className="memory-item-actions">
                      <button type="button" className="secondary-button" disabled={saving}
                        onClick={() => { setEditingId(null); setEditText(''); setSaveStatus('idle'); }}>完成编辑</button>
                      {editingId === memory.id && <AutoSaveIndicator state={saveStatus} error={error} />}
                    </div>
                  </div>
                ) : (
                  <>
                    <p>{memory.text}</p>
                    <div className="memory-item-footer">
                      <span>{timestampLabel(memory.createdAt)}</span>
                      <div className="memory-item-actions">
                        <button type="button" className="secondary-button" disabled={saving}
                          onClick={() => { setEditingId(memory.id); setEditText(memory.text); setNotice(null); }}>编辑</button>
                        <button type="button" className="danger-button" disabled={saving}
                          onClick={() => void remove(memory)}>删除</button>
                      </div>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : <div className="memory-empty-state" role="status">暂无长期记忆。</div>}
    </section>
  );
}

function AccountSettingsPage({
  activeTab,
  onTabChange,
  runtime,
  codexHome,
  runtimeProxy,
  modelSource,
  notificationUnavailable,
  launchAtLogin,
  globalModel,
  globalPermission,
  executionDefaultsReady,
  executionDefaultsError,
  resources,
  globalResourceIds,
  globalDefaultResourceIds,
  directMcpServers,
  playwrightVerifiedAt,
  models,
  modelError,
  bots,
  routines,
  runs,
  onSetGlobalModel,
  onSetGlobalPermission,
  onSetGlobalResource,
  onSetGlobalDefaultResource,
  onSetDirectMcpEnabled,
  onDeleteDirectMcp,
  onVerifyPlaywrightConnection,
  onCancelPlaywrightVerification,
  onSetLaunchAtLogin,
  onSetRuntimeProxy,
  onSetModelSource,
  onSaveManualModelSource,
  onTestModelConnection,
  onSetRoutineStatus,
  onRunRoutineNow,
  onStopRoutineRun
}: {
  activeTab: SystemSettingsTab;
  onTabChange: (tab: SystemSettingsTab) => void;
  runtime: RuntimeState;
  codexHome: string;
  runtimeProxy: string;
  modelSource: ModelSourceState;
  notificationUnavailable: string | null;
  launchAtLogin: boolean;
  globalModel: string;
  globalPermission: PermissionMode | null;
  executionDefaultsReady: boolean;
  executionDefaultsError: string | null;
  resources: BotResource[];
  globalResourceIds: string[];
  globalDefaultResourceIds: string[];
  directMcpServers: DirectMcpServer[];
  playwrightVerifiedAt: string;
  models: ModelOption[];
  modelError: string | null;
  bots: Bot[];
  routines: RoutineListItem[];
  runs: RoutineRun[];
  onSetGlobalModel: (model: string) => Promise<void>;
  onSetGlobalPermission: (permission: PermissionMode) => Promise<void>;
  onSetGlobalResource: (resourceId: string, included: boolean) => Promise<void>;
  onSetGlobalDefaultResource: (resourceId: string, enabled: boolean) => Promise<void>;
  onSetDirectMcpEnabled: (id: string, enabled: boolean) => Promise<DirectMcpServer>;
  onDeleteDirectMcp: (id: string) => Promise<void>;
  onVerifyPlaywrightConnection: () => Promise<PlaywrightVerificationResult>;
  onCancelPlaywrightVerification: () => Promise<void>;
  onSetLaunchAtLogin: (enabled: boolean) => Promise<void>;
  onSetRuntimeProxy: (value: string) => Promise<void>;
  onSetModelSource: (kind: ModelSourceKind) => Promise<ModelSourceState>;
  onSaveManualModelSource: (input: {
    serviceName: string; baseUrl: string; model: string; apiKey?: string;
  }) => Promise<ModelSourceState>;
  onTestModelConnection: (source?: ModelSourceKind) => Promise<ModelConnectionTestResult>;
  onSetRoutineStatus: (id: string, status: RoutineListItem['status']) => Promise<void>;
  onRunRoutineNow: (id: string) => Promise<RoutineRun>;
  onStopRoutineRun: (id: string) => Promise<RoutineRun>;
}) {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [appVersion, setAppVersion] = useState('未知');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [globalModelDraft, setGlobalModelDraft] = useState(globalModel);
  const [globalPermissionDraft, setGlobalPermissionDraft] = useState<PermissionMode | null>(globalPermission);
  const [modelSaveState, setModelSaveState] = useState<AutoSaveState>('idle');
  const [modelSaveError, setModelSaveError] = useState<string | null>(null);
  const [permissionSaveState, setPermissionSaveState] = useState<AutoSaveState>('idle');
  const [permissionSaveError, setPermissionSaveError] = useState<string | null>(null);
  const [resourceQuery, setResourceQuery] = useState('');
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [resourceSection, setResourceSection] = useState<ResourceSection>('skills');
  const [directMcpNotice, setDirectMcpNotice] = useState<string | null>(null);
  const [directMcpError, setDirectMcpError] = useState<string | null>(null);
  const [mcpBusyId, setMcpBusyId] = useState<string | null>(null);
  const [playwrightVerifying, setPlaywrightVerifying] = useState(false);
  const [playwrightProgress, setPlaywrightProgress] = useState('');
  const [playwrightVerificationError, setPlaywrightVerificationError] = useState<string | null>(null);
  const [manualServiceName, setManualServiceName] = useState(modelSource.manual.serviceName);
  const [manualBaseUrl, setManualBaseUrl] = useState(modelSource.manual.baseUrl);
  const [manualModel, setManualModel] = useState(modelSource.manual.model);
  const [manualApiKey, setManualApiKey] = useState('');
  const [draftModelSource, setDraftModelSource] = useState<ModelSourceKind>(modelSource.kind);
  const [manualEditorOpen, setManualEditorOpen] = useState(modelSource.kind === 'manualApi');
  const [modelSourceBusy, setModelSourceBusy] = useState(false);
  const [modelSourceNotice, setModelSourceNotice] = useState<string | null>(null);
  const [modelSourceError, setModelSourceError] = useState<string | null>(null);
  const [manualSaveState, setManualSaveState] = useState<AutoSaveState>('idle');
  const [connectionTest, setConnectionTest] = useState<ModelConnectionTestResult | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [runtimeRestartNotice, setRuntimeRestartNotice] = useState<string | null>(null);
  const [runtimeRestartError, setRuntimeRestartError] = useState<string | null>(null);
  const modelWriteSequenceRef = useRef(0);
  const modelWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const permissionWriteSequenceRef = useRef(0);
  const permissionWriteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const globalSaveError = modelSaveError ?? permissionSaveError;
  const globalSaveState: AutoSaveState = globalSaveError || modelSaveState === 'error' || permissionSaveState === 'error'
    ? 'error'
    : modelSaveState === 'saving' || permissionSaveState === 'saving'
      ? 'saving'
      : modelSaveState === 'saved' || permissionSaveState === 'saved'
        ? 'saved'
        : 'idle';

  useEffect(() => {
    if (modelWriteSequenceRef.current === 0) setGlobalModelDraft(globalModel);
  }, [globalModel]);

  useEffect(() => {
    if (permissionWriteSequenceRef.current === 0) setGlobalPermissionDraft(globalPermission);
  }, [globalPermission]);

  useEffect(() => {
    setManualServiceName(modelSource.manual.serviceName);
    setManualBaseUrl(modelSource.manual.baseUrl);
    setManualModel(modelSource.manual.model);
  }, [modelSource.manual.serviceName, modelSource.manual.baseUrl, modelSource.manual.model]);

  useEffect(() => {
    setDraftModelSource(modelSource.kind);
    if (modelSource.kind === 'manualApi') setManualEditorOpen(true);
  }, [modelSource.kind]);

  useEffect(() => {
    if (modelSaveState !== 'saved') return;
    const timer = window.setTimeout(() => setModelSaveState('idle'), 2400);
    return () => window.clearTimeout(timer);
  }, [modelSaveState]);

  useEffect(() => {
    if (permissionSaveState !== 'saved') return;
    const timer = window.setTimeout(() => setPermissionSaveState('idle'), 2400);
    return () => window.clearTimeout(timer);
  }, [permissionSaveState]);

  useEffect(() => window.rambo.onEvent(event => {
    if (event.type !== 'playwrightVerificationProgress') return;
    setPlaywrightProgress(event.message);
    if (event.phase === 'verified') setPlaywrightVerificationError(null);
  }), []);

  useEffect(() => {
    let active = true;
    window.rambo.appVersion().then(version => {
      if (active) setAppVersion(version);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const readAccount = () => {
      setLoading(true);
      window.rambo.account().then(result => {
        if (active) {
          setAccount(result);
          setError(null);
        }
      }).catch(issue => {
        if (active) setError(toError(issue));
      }).finally(() => {
        if (active) setLoading(false);
      });
    };
    readAccount();
    const unsubscribe = window.rambo.onEvent(event => {
      if (event.type === 'runtime') readAccount();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const updateGlobalModel = async (value: string) => {
    const sequence = ++modelWriteSequenceRef.current;
    setGlobalModelDraft(value);
    setModelSaveError(null);
    setModelSaveState('saving');
    try {
      const write = modelWriteQueueRef.current.then(() => onSetGlobalModel(value));
      modelWriteQueueRef.current = write.then(() => undefined, () => undefined);
      await write;
      if (sequence === modelWriteSequenceRef.current) {
        modelWriteSequenceRef.current = 0;
        setModelSaveState('saved');
      }
    } catch (issue) {
      if (sequence === modelWriteSequenceRef.current) {
        modelWriteSequenceRef.current = 0;
        setGlobalModelDraft(globalModel);
        setModelSaveState('error');
        setModelSaveError(toError(issue));
      }
    }
  };

  const updateGlobalPermission = async (value: PermissionMode) => {
    const sequence = ++permissionWriteSequenceRef.current;
    setGlobalPermissionDraft(value);
    setPermissionSaveError(null);
    setPermissionSaveState('saving');
    try {
      const write = permissionWriteQueueRef.current.then(() => onSetGlobalPermission(value));
      permissionWriteQueueRef.current = write.then(() => undefined, () => undefined);
      await write;
      if (sequence === permissionWriteSequenceRef.current) {
        permissionWriteSequenceRef.current = 0;
        setPermissionSaveState('saved');
      }
    } catch (issue) {
      if (sequence === permissionWriteSequenceRef.current) {
        permissionWriteSequenceRef.current = 0;
        setGlobalPermissionDraft(globalPermission);
        setPermissionSaveState('error');
        setPermissionSaveError(toError(issue));
      }
    }
  };

  const verifyPlaywrightConnection = async () => {
    setPlaywrightVerifying(true);
    setPlaywrightVerificationError(null);
    setPlaywrightProgress('正在启动 Playwright MCP 并连接 Chrome 扩展…');
    try {
      await onVerifyPlaywrightConnection();
      setPlaywrightProgress('Chrome 标签页连接与只读检查已完成；页面内容未保存。');
    } catch (issue) {
      setPlaywrightVerificationError(toError(issue));
      setPlaywrightProgress('');
    } finally {
      setPlaywrightVerifying(false);
    }
  };

  const cancelPlaywrightConnectionVerification = async () => {
    setPlaywrightProgress('正在取消 Chrome 连接验证…');
    await onCancelPlaywrightVerification().catch(() => {});
  };

  const login = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await window.rambo.login();
      setNotice('登录流程已启动。完成后可重新打开此页查看账号状态。');
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    setBusy(true);
    setRuntimeRestartError(null);
    setRuntimeRestartNotice(null);
    try {
      await window.rambo.restartRuntime();
      setRuntimeRestartNotice('已请求重启 Codex。');
    } catch (issue) {
      setRuntimeRestartError(toError(issue));
    } finally {
      setBusy(false);
    }
  };

  const switchModelSource = async (kind: ModelSourceKind) => {
    setDraftModelSource(kind);
    if (kind === 'manualApi') setManualEditorOpen(true);
    if (kind === modelSource.kind) return;
    if (kind === 'manualApi' && !(modelSource.manual.baseUrl && modelSource.manual.model && modelSource.hasApiKey)) {
      setModelSourceError(null);
      setModelSourceNotice(null);
      setConnectionTest(null);
      return;
    }
    setModelSourceBusy(true);
    setModelSourceError(null);
    setModelSourceNotice(null);
    setConnectionTest(null);
    try {
      await onSetModelSource(kind);
      setModelSourceNotice('模型来源已切换，Codex 运行时已重启。');
    } catch (issue) {
      setDraftModelSource(modelSource.kind);
      setModelSourceError(toError(issue));
    } finally {
      setModelSourceBusy(false);
    }
  };

  const saveManualSource = async (withTest: boolean) => {
    setManualSaveState('saving');
    setModelSourceError(null);
    setModelSourceNotice(null);
    setConnectionTest(null);
    try {
      await onSaveManualModelSource({
        serviceName: manualServiceName,
        baseUrl: manualBaseUrl,
        model: manualModel,
        ...(manualApiKey.trim() ? { apiKey: manualApiKey.trim() } : {})
      });
      setManualApiKey('');
      setManualSaveState('saved');
      setDraftModelSource('manualApi');
      setManualEditorOpen(true);
      setModelSourceNotice(modelSource.kind === 'manualApi'
        ? '手动 API 配置已加密保存。'
        : '手动 API 配置已加密保存；请切换“手动配置 API”使其生效。');
      if (withTest) {
        setTestingConnection(true);
        const result = await onTestModelConnection('manualApi');
        setConnectionTest(result);
      }
    } catch (issue) {
      setManualSaveState('error');
      setModelSourceError(toError(issue));
      if (withTest) {
        const result = await onTestModelConnection('manualApi').catch(() => null);
        if (result) setConnectionTest(result);
      }
    } finally {
      setTestingConnection(false);
      window.setTimeout(() => setManualSaveState('idle'), 2400);
    }
  };

  const testConnection = async () => {
    setTestingConnection(true);
    setModelSourceError(null);
    setModelSourceNotice(null);
    setConnectionTest(null);
    try {
      const result = await onTestModelConnection();
      setConnectionTest(result);
    } catch (issue) {
      setModelSourceError(toError(issue));
    } finally {
      setTestingConnection(false);
    }
  };

  const tabs: Array<[SystemSettingsTab, string]> = [
    ['general', '常规'],
    ['account', '账号'],
    ['model', '新建 Bot 初值'],
    ['resources', '资源管理'],
    ['routines', '定时任务']
  ];
  const sectionResources = resources.filter(resource =>
    resourceMatchesSection(resource, resourceSection));
  const globalSectionResources = sectionResources.filter(resource =>
    globalResourceIds.includes(resource.id));
  const discoveredSectionResources = sectionResources.filter(resource =>
    !globalResourceIds.includes(resource.id) &&
    (!resourceQuery.trim() || [
      resource.name, resource.description, resource.source,
      RESOURCE_KIND_LABELS[resource.kind]
    ].some(value => value.toLocaleLowerCase().includes(resourceQuery.trim().toLocaleLowerCase()))));

  return (
    <section className="settings-page system-settings-page" aria-label="系统设置">
      <div className="settings-page-heading">
        <div>
          <div className="eyebrow">RAMBO</div>
          <h1>系统设置</h1>
          <p>集中管理账号、模型与权限、全局资源和全部定时任务。</p>
        </div>
        <span className="app-version">Rambo {appVersion}</span>
      </div>
      <div className="settings-tabs system-settings-tabs" role="tablist" aria-label="系统设置分类">
        {tabs.map(([id, label]) => (
          <button type="button" role="tab" key={id} id={'system-tab-' + id}
            aria-selected={activeTab === id} aria-controls={'system-panel-' + id}
            className={'settings-tab' + (activeTab === id ? ' selected' : '')}
            onClick={() => onTabChange(id)}>{label}</button>
        ))}
      </div>

      {activeTab === 'general' && (
        <div className="system-settings-panel settings-tab-panel" role="tabpanel"
          id="system-panel-general" aria-labelledby="system-tab-general">
          <div className="settings-section">
            <div className="settings-section-title">
              <div><h2>启动</h2><p>登录 macOS 后启动 Rambo，让本机任务继续运行。</p></div>
            </div>
            <label className="settings-toggle-row">
              <span><strong>登录时启动</strong><span>关闭 Rambo 窗口不会停止任务；退出 Rambo 才会停止本机服务。</span></span>
              <input type="checkbox" aria-label="登录时启动" checked={launchAtLogin} disabled={busy}
                onChange={event => {
                  const enabled = event.target.checked;
                  setBusy(true);
                  setError(null);
                  setNotice(null);
                  void onSetLaunchAtLogin(enabled).then(() => {
                    setNotice(enabled ? '已开启登录时启动。' : '已关闭登录时启动。');
                  }).catch(issue => {
                    setError(toError(issue));
                  }).finally(() => {
                    setBusy(false);
                  });
                }} />
            </label>
          </div>
          <MemoryManager botId={null} title="关于我"
            description="所有 Bot 可参考的共用个人资料。此处条目与各 Bot 的专属记忆分开管理。" />
          <div className="settings-section">
            <div className="settings-section-title">
              <div><h2>Codex 运行时</h2><p>使用本机 Codex，登录态共用，会话独立保存。</p></div>
            </div>
            <div className="runtime-card">
              <div className="runtime-card-status">
                <span className={'status-dot status-' + runtime.status} />
                <strong>{runtimeLabel(runtime.status)}</strong>
                <span className="runtime-version">版本 {runtime.version || '未知'}</span>
                <button type="button" className="secondary-button runtime-restart-button" disabled={busy || runtime.status === 'starting'}
                  onClick={() => void restart()}>{busy ? '处理中…' : '重启运行时'}</button>
              </div>
              <div className="runtime-home-row" aria-label="Codex Home">
                <span className="runtime-home-label">Codex Home</span>
                <code className="runtime-home-path" title={codexHome}>{codexHome || '未知'}</code>
              </div>
              <RuntimeProxySetting
                value={runtimeProxy}
                busy={busy || runtime.status === 'starting'}
                onChange={onSetRuntimeProxy}
              />
              {notificationUnavailable && (
                <div className="runtime-notification-status" role="status">{notificationUnavailable}</div>
              )}
              {runtime.error && <div className="runtime-error">{runtime.error}</div>}
              {(runtimeRestartError || runtimeRestartNotice) && (
                <div className={runtimeRestartError ? 'form-error settings-message' : 'form-saved settings-message'} role="status">
                  {runtimeRestartError ?? runtimeRestartNotice}
                </div>
              )}
            </div>
          </div>
          {(error || notice) && (
            <div className={error ? 'form-error settings-message' : 'form-saved settings-message'} role="status">
              {error ?? notice}
            </div>
          )}
        </div>
      )}

      {activeTab === 'account' && (
        <div className="system-settings-panel settings-tab-panel" role="tabpanel"
          id="system-panel-account" aria-labelledby="system-tab-account">
          <div className="settings-section account-status-section">
            <div className="settings-section-title">
              <div><h2>账号状态</h2><p>Rambo 不创建产品账号；登录与凭证只在本机使用。</p></div>
            </div>
            <div className="account-card">
              <div className="account-avatar">C</div>
              <div className="account-copy">
                <strong>{loading ? '正在读取账号状态…' : error ? '无法读取账号状态' : account?.requiresLogin ? '尚未登录 ChatGPT' : account?.email || account?.type || (account?.localLoginDetected ? '检测到本机登录' : '已连接账号')}</strong>
                <span>{account?.type ? '登录方式：' + account.type : account?.localLoginDetected ? '账号状态：本机认证存在，在线状态暂不可用' : '账号状态来自本机 Codex'}</span>
                {account?.statusError && <small>在线账号状态读取失败：{account.statusError}</small>}
              </div>
              {account?.requiresLogin && (
                <button type="button" className="secondary-button" disabled={busy}
                  onClick={() => void login()}>登录 ChatGPT</button>
              )}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <div>
                <h2>模型来源</h2>
                <p>应用级三选一，同一时间只有一个来源生效。切换不会改写已有 Bot 的模型和权限。</p>
              </div>
            </div>
            <div className="model-source-options" role="radiogroup" aria-label="模型来源">
              {([
                ['local', '本机 Codex 配置', '沿用本机 config.toml 与认证，修改后由后续运行时启动生效。'],
                ['chatgpt', 'ChatGPT 登录', '使用本机共享的 ChatGPT 登录状态。'],
                ['manualApi', '手动配置 API', 'Rambo 启动的 Codex 使用独立 Responses API 配置。']
              ] as Array<[ModelSourceKind, string, string]>).map(([kind, title, description]) => (
                <label className={`model-source-option${draftModelSource === kind ? ' selected' : ''}`} key={kind}>
                  <input type="radio" name="model-source" value={kind}
                    checked={draftModelSource === kind}
                    disabled={modelSourceBusy || runtime.status === 'starting'}
                    onChange={() => void switchModelSource(kind)} />
                  <span className="model-source-copy">
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                  {modelSource.kind === kind && <span className="model-source-active">当前生效</span>}
                </label>
              ))}
            </div>
            <p className="field-hint model-source-compat-note">
              手动 API 仅按 Codex 的 Responses 兼容方式接入；不承诺第三方服务完整支持 Tool Calls、reasoning、MCP 或全部 Codex 能力。
            </p>
          </div>

          {manualEditorOpen && (
            <div className="settings-section">
              <div className="settings-section-title">
                <div><h2>手动 API 配置</h2><p>API Key 使用 Rambo 本地加密凭证库保存，不写入设置快照或日志。</p></div>
              </div>
              <div className="manual-model-form">
                <label className="settings-field">
                  <span>服务名称</span>
                  <input className="text-input" value={manualServiceName} maxLength={80}
                    placeholder="例如：公司网关"
                    disabled={modelSourceBusy || manualSaveState === 'saving'}
                    onChange={event => setManualServiceName(event.target.value)} />
                </label>
                <label className="settings-field">
                  <span>Base URL</span>
                  <input className="text-input" type="url" value={manualBaseUrl} maxLength={2_000}
                    placeholder="https://api.example.com/v1"
                    disabled={modelSourceBusy || manualSaveState === 'saving'}
                    onChange={event => setManualBaseUrl(event.target.value)} />
                </label>
                <label className="settings-field">
                  <span>模型 ID</span>
                  <input className="text-input" value={manualModel} maxLength={500}
                    placeholder="由服务商提供，例如 gpt-5"
                    disabled={modelSourceBusy || manualSaveState === 'saving'}
                    onChange={event => setManualModel(event.target.value)} />
                </label>
                <label className="settings-field">
                  <span>API Key</span>
                  <input className="text-input" type="password" value={manualApiKey} maxLength={16_384}
                    autoComplete="new-password" spellCheck={false}
                    placeholder={modelSource.hasApiKey ? '已保存；留空表示不修改' : 'sk-...'}
                    disabled={modelSourceBusy || manualSaveState === 'saving'}
                    onChange={event => setManualApiKey(event.target.value)} />
                </label>
                <div className="manual-model-actions">
                  <AutoSaveIndicator state={manualSaveState} error={modelSourceError} />
                  <button type="button" className="secondary-button"
                    disabled={modelSourceBusy || manualSaveState === 'saving' ||
                      !manualBaseUrl.trim() || !manualModel.trim() || (!modelSource.hasApiKey && !manualApiKey.trim())}
                    onClick={() => void saveManualSource(false)}>保存配置</button>
                  <button type="button" className="primary-button"
                    disabled={modelSourceBusy || manualSaveState === 'saving' || testingConnection ||
                      !manualBaseUrl.trim() || !manualModel.trim() || (!modelSource.hasApiKey && !manualApiKey.trim())}
                    onClick={() => void saveManualSource(true)}>
                    {testingConnection ? '正在测试…' : '保存并测试'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="settings-section">
            <div className="settings-section-title">
              <div><h2>连接测试</h2><p>使用当前生效来源发送真实最小请求，并记录首响应延迟。</p></div>
            </div>
            <div className="model-connection-test">
              <button type="button" className="secondary-button" disabled={testingConnection || modelSourceBusy}
                onClick={() => void testConnection()}>{testingConnection ? '正在测试…' : '测试连接与延迟'}</button>
              {connectionTest && (
                <div className={connectionTest.ok ? 'model-test-result success' : 'model-test-result error'} role="status">
                  <strong>{connectionTest.ok ? '连接可用' : '连接失败'} · 首响应 {connectionTest.latencyMs} ms</strong>
                  <span>{connectionTest.message}</span>
                  {connectionTest.ok && connectionTest.source === 'manualApi' &&
                    connectionTest.sourcePending && (
                    <button type="button" className="secondary-button"
                      disabled={modelSourceBusy}
                      onClick={() => void switchModelSource('manualApi')}>
                      切换为当前来源
                    </button>
                  )}
                  {connectionTest.configMayBeStale && connectionTest.source === 'local' && (
                    <button type="button" className="secondary-button" disabled={busy}
                      onClick={() => void restart()}>重启运行时后重试</button>
                  )}
                </div>
              )}
            </div>
            {(modelSourceError || modelSourceNotice) && modelSource.kind !== 'manualApi' && (
              <div className={modelSourceError ? 'form-error settings-message' : 'form-saved settings-message'} role="status">
                {modelSourceError ?? modelSourceNotice}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'model' && (
        <section className="system-settings-panel settings-tab-panel" role="tabpanel"
          id="system-panel-model" aria-labelledby="system-tab-model">
          <div className="settings-section-title">
            <div><h2>新建 Bot 初值</h2><p>只决定之后新建 Bot 复制到的具体模型与权限。已有 Bot 完全独立，修改这里不会影响它们。</p></div>
          </div>
          {!executionDefaultsReady && (
            <div className="form-error" role="status">
              {executionDefaultsError ?? '模型配置尚未就绪。'}
            </div>
          )}
          <div className="global-defaults-grid">
            <section className="global-default-card global-model-card">
              <label className="settings-field global-model-field">
                <span>新建 Bot 模型</span>
                <span className="select-input-control">
                  <select className="text-input select-input" aria-label="新建 Bot 模型" value={globalModelDraft}
                    disabled={!models.length}
                    onChange={event => void updateGlobalModel(event.target.value)}>
                    {!models.length && <option value="" disabled>模型列表暂不可用</option>}
                    {globalModelDraft && !models.some(option => option.id === globalModelDraft) && (
                      <option value={globalModelDraft}>当前配置 · {globalModelDraft}</option>
                    )}
                    {models.map(option => (
                      <option value={option.id} key={option.id}>
                        {option.label}{option.isDefault ? ' · 产品默认' : ''}
                      </option>
                    ))}
                  </select>
                  <span className="select-input-chevron" aria-hidden="true"><Icon name="chevron" size={14} /></span>
                </span>
                <small className="field-hint">创建 Bot 时复制为一个明确值，之后互不联动。</small>
                {modelError && <small className="field-hint">暂时无法读取模型列表：{modelError}</small>}
              </label>
            </section>
            <section className="global-default-card global-permission-card" aria-labelledby="global-permission-title">
              <div className="global-default-card-heading">
                <h3 id="global-permission-title">新建 Bot 权限</h3>
                <p className="field-hint">创建 Bot 时复制为一个明确权限，之后互不联动。</p>
              </div>
              <fieldset className="permission-fieldset global-permission-fieldset">
                <legend className="sr-only">新建 Bot 权限</legend>
                <div className="permission-choice-grid global-permission-options">
                  <PermissionOption name="global-permission" value="fullAccess" selected={globalPermissionDraft}
                    onSelect={value => void updateGlobalPermission(value)}
                    title="完全访问" description="允许 Codex 在本机执行，不限制于 Bot 工作区。" />
                  <PermissionOption name="global-permission" value="workspaceWrite" selected={globalPermissionDraft}
                    onSelect={value => void updateGlobalPermission(value)}
                    title="工作区写入" description="允许在 Bot 工作区读写，并使用网络。" />
                  <PermissionOption name="global-permission" value="readOnly" selected={globalPermissionDraft}
                    onSelect={value => void updateGlobalPermission(value)}
                    title="只读" description="不允许写入文件。" />
                </div>
              </fieldset>
            </section>
          </div>
          {(globalSaveState === 'saving' || globalSaveState === 'saved' || globalSaveState === 'error') && (
            <div className="settings-autosave-row global-default-save-status">
              <AutoSaveIndicator state={globalSaveState} error={globalSaveError} />
            </div>
          )}
        </section>
      )}

      {activeTab === 'resources' && (
        <section className="system-settings-panel settings-tab-panel" role="tabpanel"
          id="system-panel-resources" aria-labelledby="system-tab-resources">
          <div className="settings-section-title resource-section-title">
            <div>
              <h2>全局可选目录</h2>
              <p>这里集中查看所有 Bot 可见的资源，并设置新建 Bot 的默认开关。已有 Bot 仍保持独立，插件自带的 MCP 也继续随插件管理。</p>
              <p>导入技能或添加直连 MCP 由 Bot 管理，在私聊中明确说明需求即可。首次使用 Playwright 时，Chrome 扩展会请求一次标签页授权。</p>
            </div>
          </div>
          <ResourceSectionTabs value={resourceSection} resources={resources}
            onChange={setResourceSection} />
          {directMcpNotice && (
            <div className="form-saved settings-message resource-operation-message" role="status">
              {directMcpNotice}
            </div>
          )}
          {directMcpError && (
            <div className="form-error settings-message resource-operation-message" role="alert">
              {directMcpError}
            </div>
          )}
          <ResourceRows
            resources={globalSectionResources}
            enabledIds={globalDefaultResourceIds}
            onToggle={onSetGlobalDefaultResource}
            detail={resource => {
              const server = directMcpServers.find(item =>
                `mcp:${item.name.toLocaleLowerCase()}` === resource.id);
              if (!server) return null;
              const secretKeys = [...server.headerKeys, ...server.envKeys];
              return (
                <span className="direct-mcp-meta">
                  {server.transport === 'stdio'
                    ? `stdio · ${server.command}`
                    : `http · ${server.url}`}
                  {secretKeys.length ? ` · 已有安全凭证：${secretKeys.join('、')}` : ''}
                </span>
              );
            }}
            onDelete={resource => {
              const server = directMcpServers.find(item =>
                `mcp:${item.name.toLocaleLowerCase()}` === resource.id);
              if (!server) return;
              setMcpBusyId(resource.id);
              setDirectMcpError(null);
              setDirectMcpNotice(null);
              void onDeleteDirectMcp(server.id)
                .then(() => setDirectMcpNotice(`已删除直连 MCP ${server.name} 的定义。`))
                .catch(issue => setDirectMcpError(toError(issue)))
                .finally(() => setMcpBusyId(null));
            }}
            canDelete={resource => directMcpServers.some(server =>
              `mcp:${server.name.toLocaleLowerCase()}` === resource.id)}
            deleteLabel="删除定义"
            action={resource => (
              <>
                {resource.id === 'mcp:playwright' && (
                  <div className="playwright-resource-setup">
                    <span className={playwrightVerificationError ? 'playwright-setup-error' : ''}
                      role={playwrightVerificationError ? 'alert' : 'status'}>
                      {playwrightVerifying
                        ? playwrightProgress || '正在等待 Chrome 标签页…'
                        : playwrightVerificationError
                          ? playwrightVerificationError
                          : playwrightProgress || (playwrightVerifiedAt
                            ? '最近一次 Chrome 连接检查已通过'
                            : '尚未验证 Chrome 扩展连接')}
                    </span>
                    <button type="button" className="secondary-button resource-action"
                      onClick={() => void (playwrightVerifying
                        ? cancelPlaywrightConnectionVerification()
                        : verifyPlaywrightConnection())}>
                      {playwrightVerifying ? '取消验证' : '验证 Chrome 连接'}
                    </button>
                  </div>
                )}
                <button type="button" className="secondary-button resource-action"
                  disabled={playwrightVerifying || mcpBusyId === resource.id}
                  onClick={() => void onSetGlobalResource(resource.id, false)}>
                  移出可选
                </button>
                {directMcpServers.some(server =>
                  `mcp:${server.name.toLocaleLowerCase()}` === resource.id) && (
                  <>
                    {(() => {
                      const server = directMcpServers.find(item =>
                        `mcp:${item.name.toLocaleLowerCase()}` === resource.id)!;
                      return (
                        <button type="button" className="secondary-button resource-action"
                          disabled={mcpBusyId === resource.id}
                          onClick={() => {
                            setMcpBusyId(resource.id);
                            setDirectMcpError(null);
                            setDirectMcpNotice(null);
                            void onSetDirectMcpEnabled(server.id, !server.enabled)
                              .then(updated => setDirectMcpNotice(
                                `已${updated.enabled ? '启用' : '停用'}直连 MCP ${updated.name} 的定义。`))
                              .catch(issue => setDirectMcpError(toError(issue)))
                              .finally(() => setMcpBusyId(null));
                          }}>
                          {server.enabled ? '停用定义' : '启用定义'}
                        </button>
                      );
                    })()}
                  </>
                )}
              </>
            )} />
          <section className="resource-discovery">
            <button type="button" className="resource-discovery-toggle"
              aria-expanded={discoverOpen}
              onClick={() => setDiscoverOpen(value => !value)}>
              <span>发现目录</span>
              <span>{discoveredSectionResources.length} 项</span>
              <Icon name="chevron" size={14} />
            </button>
            {discoverOpen && (
              <div className="resource-discovery-body">
                <label className="settings-field">
                  <span>搜索资源</span>
                  <input className="text-input" value={resourceQuery}
                    placeholder="名称、说明、来源或类型"
                    onChange={event => setResourceQuery(event.target.value)} />
                </label>
                <ResourceRows
                  resources={discoveredSectionResources}
                  action={resource => (
                    <button type="button" className="secondary-button resource-action"
                      onClick={() => void onSetGlobalResource(resource.id, true)}>
                      加入可选目录
                    </button>
                  )} />
              </div>
            )}
          </section>
        </section>
      )}

      {activeTab === 'routines' && (
        <div className="system-settings-panel settings-tab-panel" role="tabpanel"
          id="system-panel-routines" aria-labelledby="system-tab-routines">
          <RoutineListPage routines={routines} runs={runs} bots={bots}
            onSetRoutineStatus={onSetRoutineStatus} onRunRoutineNow={onRunRoutineNow}
            onStopRoutineRun={onStopRoutineRun} />
        </div>
      )}

    </section>
  );
}

export default App;
