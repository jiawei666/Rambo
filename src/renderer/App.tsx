import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type CSSProperties,
  type ReactNode
} from 'react';
import appAvatarUrl from '../../assets/branding/app-logo-source.png';
import { AVATAR_SVG_TEMPLATES } from './avatar-data';
import { runGroupCreateAction } from './group-create-actions';
import { partitionBots, privateChatForBot, selectedPrivateChat, shouldShowReturnToChat } from './chat-list-model';
import { GroupComposerSettings } from './group-composer-settings';
import { runAfterExplicitConfirmation } from './management-actions';
import type {
  AccountState,
  AppEvent,
  Bot,
  Chat,
  GroupChat,
  GroupMessage,
  Memory,
  Message,
  ModelOption,
  PermissionMode,
  RoutineListItem,
  RoutineRun,
  RuntimeState,
  Snapshot,
  TurnActivity,
  VoiceState
} from '../shared/contracts';

type View = 'chat' | 'settings' | 'bot-settings' | 'group-create' | 'group-chat' | 'group-members' | 'routines';
type AvatarShape =
  | 'blob' | 'pebble' | 'bean' | 'egg' | 'squircle' | 'tablet' | 'capsule' | 'cylinder'
  | 'hex' | 'gem' | 'crystal' | 'wedge' | 'shield' | 'dome' | 'arch' | 'cloud'
  | 'teardrop' | 'leaf' | 'square' | 'sparkle' | 'clover' | 'flower' | 'heart' | 'house'
  | 'star' | 'pumpkin';
type AvatarColor = 'black' | 'brown' | 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'violet' | 'magenta' | 'gray';
type AvatarSelection = { shape: AvatarShape; color: AvatarColor; legacy?: LegacyAvatar };
type LegacyAvatar = { id: string; symbol: string; tone: string; shape: AvatarShape; color: AvatarColor; label: string };
type LiveVoiceUi = {
  chatId: string;
  state: VoiceState;
  error: string | null;
  transcript: string;
};

const AVATAR_SHAPES: AvatarShape[] = [
  'blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem',
  'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle',
  'clover', 'flower', 'heart', 'house', 'star', 'pumpkin'
];
const AVATAR_PICKER_SHAPES = [
  'blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex'
] as const satisfies readonly AvatarShape[];
type AvatarPickerShape = typeof AVATAR_PICKER_SHAPES[number];
const AVATAR_SHAPE_LABELS: Record<AvatarPickerShape, string> = {
  blob: '团块', cloud: '云朵', square: '方形', sparkle: '星芒', clover: '四叶草', heart: '爱心', flower: '花朵',
  teardrop: '水滴', tablet: '药片', wedge: '楔形', house: '房子', star: '星形', hex: '六边形'
};
const AVATAR_COLORS: Array<{ id: AvatarColor; label: string; value: string }> = [
  { id: 'black', label: '黑色', value: '#000000' },
  { id: 'brown', label: '棕色', value: '#a06b39' },
  { id: 'red', label: '红色', value: '#fb2b3e' },
  { id: 'orange', label: '橙色', value: '#fd690f' },
  { id: 'yellow', label: '黄色', value: '#f59312' },
  { id: 'green', label: '绿色', value: '#14c16f' },
  { id: 'cyan', label: '青色', value: '#13b7a2' },
  { id: 'blue', label: '蓝色', value: '#1e86fc' },
  { id: 'violet', label: '紫色', value: '#8f59f9' },
  { id: 'magenta', label: '洋红', value: '#f93498' },
  { id: 'gray', label: '灰色', value: '#959595' }
];
const LEGACY_AVATARS: LegacyAvatar[] = [
  { id: 'spark', symbol: '✦', tone: 'coral', shape: 'sparkle', color: 'magenta', label: '星光' },
  { id: 'orbit', symbol: '◉', tone: 'blue', shape: 'blob', color: 'blue', label: '轨道' },
  { id: 'leaf', symbol: '✿', tone: 'green', shape: 'leaf', color: 'green', label: '花叶' },
  { id: 'sun', symbol: '☼', tone: 'yellow', shape: 'flower', color: 'yellow', label: '太阳' },
  { id: 'moon', symbol: '☾', tone: 'violet', shape: 'teardrop', color: 'violet', label: '月亮' },
  { id: 'wave', symbol: '≈', tone: 'teal', shape: 'cloud', color: 'cyan', label: '波纹' }
];

function avatarSeedHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function avatarShapeIndex(value: string): number {
  let hash = avatarSeedHash(value) | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 73244475);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash % AVATAR_PICKER_SHAPES.length;
}

function avatarColorIndex(value: string): number {
  const streamSeed = (avatarSeedHash(value) ^ Math.imul(1, 2654435769)) >>> 0;
  let state = (streamSeed ^ Math.imul(1, 2654435769)) >>> 0;
  state = (state + 1831565813) | 0;
  let sample = Math.imul(state ^ (state >>> 15), 1 | state);
  sample = (sample + Math.imul(sample ^ (sample >>> 7), 61 | sample)) ^ sample;
  const random = ((sample ^ (sample >>> 14)) >>> 0) / 4294967296;
  return Math.floor(random * (AVATAR_COLORS.length - 1));
}

function createInitialAvatar(): string {
  const seed = crypto.randomUUID();
  const shape = AVATAR_PICKER_SHAPES[avatarShapeIndex(seed)];
  const color = AVATAR_COLORS[avatarColorIndex(seed) + 1].id;
  return encodeAvatar(shape, color);
}

const EMPTY_SNAPSHOT: Snapshot = {
  bots: [],
  chats: [],
  groups: [],
  routines: [],
  routineRuns: [],
  runtime: { status: 'stopped', version: '', error: null },
  activeTurns: {},
  settings: {}
};

function encodeAvatar(shape: AvatarShape, color: AvatarColor): string {
  return `grok-avatar:v1:${shape}:${shape === 'pumpkin' ? 'orange' : color}`;
}

function parseAvatar(value: string): AvatarSelection {
  const legacy = LEGACY_AVATARS.find(item => item.id === value);
  if (legacy) return { shape: legacy.shape, color: legacy.color, legacy };

  const match = /^grok-avatar:v1:([a-z]+):([a-z]+)$/.exec(value);
  const shape = match?.[1] as AvatarShape | undefined;
  const color = match?.[2] as AvatarColor | undefined;
  if (shape && AVATAR_SHAPES.includes(shape) && color && AVATAR_COLORS.some(item => item.id === color)) {
    return { shape, color: shape === 'pumpkin' ? 'orange' : color };
  }
  return { shape: 'blob', color: 'black' };
}

function Avatar({ value, size = 'regular' }: { value: string; size?: 'small' | 'regular' | 'large' | 'picker' | 'preview' }) {
  const selection = parseAvatar(value);
  const instanceId = useId().replace(/:/g, '');
  if (selection.legacy) {
    return (
      <span className={'bot-avatar legacy-avatar avatar-' + selection.legacy.tone + ' avatar-' + size} aria-hidden="true">
        {selection.legacy.symbol}
      </span>
    );
  }
  const template = AVATAR_SVG_TEMPLATES[selection.shape] ?? AVATAR_SVG_TEMPLATES.blob;
  // Scope SVG IDs and fragment references without renaming the ink CSS variable.
  const markup = template.replace(/(["#])grok-bot-still(?=[-"])/g, `$1rambo-avatar-${instanceId}`);
  const color = AVATAR_COLORS.find(item => item.id === selection.color)?.value ?? '#000000';
  return (
    <span className={'bot-avatar avatar-' + (size === 'picker' ? 'shape-mark' : size)}
      style={{ '--grok-bot-still-ink': `var(--avatar-ink-${selection.color}, ${color})` } as CSSProperties} aria-hidden="true">
      <span className="avatar-art" dangerouslySetInnerHTML={{ __html: markup }} />
    </span>
  );
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

function AvatarPicker({
  value,
  onChange,
  disabled = false,
  className = ''
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const selected = parseAvatar(value);
  const rows: AvatarPickerShape[][] = [];
  for (let index = 0; index < AVATAR_PICKER_SHAPES.length; index += 5) {
    rows.push(AVATAR_PICKER_SHAPES.slice(index, index + 5));
  }

  return (
    <div className={'avatar-picker ' + className}>
      <div className="avatar-shape-rows" role="group" aria-label="角色形状">
        {rows.map((row, rowIndex) => (
          <div className="avatar-shape-row" key={rowIndex}>
            {row.map(shape => {
              const color = selected.color;
              const chosen = selected.shape === shape;
              return (
                <button type="button" key={shape} className={'avatar-shape-button' + (chosen ? ' chosen' : '')}
                  aria-label={AVATAR_SHAPE_LABELS[shape]} aria-pressed={chosen} title={AVATAR_SHAPE_LABELS[shape]} disabled={disabled}
                  onClick={() => onChange(encodeAvatar(shape, color))}>
                  <Avatar value={encodeAvatar(shape, color)} size="picker" />
                  <span className="avatar-shape-selection" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {selected.shape !== 'pumpkin' && (
        <div className="avatar-color-row" role="group" aria-label="角色颜色">
          {AVATAR_COLORS.map(color => (
            <button type="button" key={color.id}
              className={'avatar-color-cell' + (selected.color === color.id ? ' chosen' : '')}
              aria-label={color.label} aria-pressed={selected.color === color.id} title={color.label}
              disabled={disabled} onClick={() => onChange(encodeAvatar(selected.shape, color.id))}>
              <span className="avatar-color-swatch"
                style={{ backgroundColor: `var(--avatar-ink-${color.id}, ${color.value})` }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type IconName = 'plus' | 'settings' | 'chevron' | 'send' | 'stop' | 'close' | 'back' | 'check' | 'arrow' | 'panel' | 'search' | 'account' | 'users' | 'calendar' | 'more' | 'voice';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const shapes: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
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
    voice: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-3 0h6" /></>
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

class VoiceMediaSession {
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private channel: RTCDataChannel | null = null;

  constructor(readonly chatId: string) {}

  async start(): Promise<string> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.stream = stream;
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

  async close(): Promise<void> {
    const peer = this.peer;
    this.peer = null;
    try { this.channel?.close(); } catch { /* already closed */ }
    this.channel = null;
    for (const track of this.stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    this.stream = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = null;
    }
    try { peer?.close(); } catch { /* already closed */ }
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

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  fullAccess: '完全访问',
  workspaceWrite: '工作区写入',
  readOnly: '只读'
};

function modelSourceLabel(source: 'chat' | 'bot' | 'global' | 'localConfig' | 'unknown'): string {
  if (source === 'chat') return '当前聊天';
  if (source === 'bot') return 'Bot 默认';
  if (source === 'global') return '产品默认（model/list）';
  if (source === 'localConfig') return '本机配置，发送时解析';
  return '未知来源';
}

function modelLabel(modelId: string | null, options: ModelOption[]): string {
  if (!modelId) return '未知';
  return options.find(option => option.id === modelId)?.label ?? modelId;
}

function inheritedChatModel(bot: Bot): { id: string | null; source: 'bot' | 'localConfig' } {
  if (bot.model !== null) return { id: bot.model, source: 'bot' };
  return { id: null, source: 'localConfig' };
}

function selectedChatModel(chat: Chat, bot: Bot): { id: string | null; source: 'chat' | 'bot' | 'localConfig' } {
  if (chat.model !== null) return { id: chat.model, source: 'chat' };
  return inheritedChatModel(bot);
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
  const [loadingGroupMessages, setLoadingGroupMessages] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [view, setView] = useState<View>('chat');
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
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelOptionsError, setModelOptionsError] = useState<string | null>(null);
  const [elapsedRunSeconds, setElapsedRunSeconds] = useState(0);
  const [voice, setVoice] = useState<LiveVoiceUi | null>(null);
  const voiceRef = useRef<LiveVoiceUi | null>(null);
  const voiceSessionRef = useRef<VoiceMediaSession | null>(null);
  const selectedChatRef = useRef<string | null>(null);
  const selectedGroupRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRequestRef = useRef(0);
  const messageLoadSequenceRef = useRef(0);
  const pendingMessageLoadsRef = useRef(new Map<string, PendingMessageLoad>());
  const groupMessageLoadSequenceRef = useRef(0);
  const pendingGroupMessageLoadsRef = useRef(new Map<string, { requestId: number; streamed: Map<string, GroupMessage> }>());

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
      if (selectedChatRef.current === chatId) setActivities(result);
    } catch (error) {
      if (selectedChatRef.current === chatId) setAppError(toError(error));
    }
  }, []);

  const updateVoice = useCallback((next: LiveVoiceUi | null | ((current: LiveVoiceUi | null) => LiveVoiceUi | null)) => {
    setVoice(current => {
      const value = typeof next === 'function' ? next(current) : next;
      voiceRef.current = value;
      return value;
    });
  }, []);

  const startVoice = useCallback(async (chat: Chat) => {
    if (voiceSessionRef.current || voiceRef.current?.state === 'connecting' || voiceRef.current?.state === 'live') return;
    setAppError(null);
    const media = new VoiceMediaSession(chat.id);
    voiceSessionRef.current = media;
    updateVoice({ chatId: chat.id, state: 'connecting', error: null, transcript: '' });
    try {
      const offer = await media.start();
      await window.rambo.startVoice(chat.id, offer);
    } catch (error) {
      await media.close();
      if (voiceSessionRef.current === media) voiceSessionRef.current = null;
      updateVoice({ chatId: chat.id, state: 'error', error: toError(error), transcript: '' });
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
    } finally {
      updateVoice(null);
    }
  }, [updateVoice]);

  const loadGroupMessages = useCallback(async (groupId: string) => {
    const pending = { requestId: ++groupMessageLoadSequenceRef.current, streamed: new Map<string, GroupMessage>() };
    pendingGroupMessageLoadsRef.current.set(groupId, pending);
    try {
      const result = await window.rambo.groupMessages(groupId);
      if (selectedGroupRef.current === groupId && pendingGroupMessageLoadsRef.current.get(groupId) === pending) {
        const merged = new Map(result.map(message => [message.id, message]));
        for (const [id, message] of pending.streamed) merged.set(id, message);
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
    void loadActivities(chat.id);
    await loadMessages(chat.id, { clearCurrent: true, showLoading: true, resetStreamBuffer: true });
  }, [loadActivities, loadMessages]);

  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      try {
        const next = await window.rambo.snapshot();
        if (!alive) return;
        setSnapshot(next);
        if (!initializedRef.current) {
          initializedRef.current = true;
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

    const unsubscribe = window.rambo.onEvent((event: AppEvent) => {
      if (event.type === 'changed') {
        void refresh();
      } else if (event.type === 'message') {
        const pending = pendingMessageLoadsRef.current.get(event.message.chatId);
        pending?.streamed.set(event.message.id, event.message);
        if (selectedChatRef.current === event.message.chatId) {
          setMessages(current => upsertMessage(current, event.message));
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
      } else if (event.type === 'groupMessage') {
        const pending = pendingGroupMessageLoadsRef.current.get(event.groupId);
        pending?.streamed.set(event.message.id, event.message);
        if (selectedGroupRef.current === event.groupId) {
          setGroupMessages(current => {
            const next = new Map(current.map(message => [message.id, message]));
            next.set(event.message.id, event.message);
            return [...next.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          });
        }
      } else if (event.type === 'runtime') {
        setSnapshot(current => current ? { ...current, runtime: event.state } : current);
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
      } else if (event.type === 'turnMetadata') {
        // Turn metadata remains persisted by the Host for routine/audit records.
      } else if (event.type === 'voiceState') {
        const current = voiceRef.current;
        if (event.session.state === 'error') {
          void voiceSessionRef.current?.close();
          voiceSessionRef.current = null;
        }
        updateVoice({
          chatId: event.session.chatId,
          state: event.session.state,
          error: event.session.error,
          transcript: current?.chatId === event.session.chatId ? current.transcript : ''
        });
      } else if (event.type === 'voiceSdp') {
        void (async () => {
          try {
            await voiceSessionRef.current?.applyAnswer(event.sdp);
          } catch (error) {
            setAppError('语音媒体协商失败：' + toError(error));
            void voiceSessionRef.current?.close();
            voiceSessionRef.current = null;
            void window.rambo.stopVoice(event.chatId, '媒体协商失败');
          }
        })();
      } else if (event.type === 'voiceTranscript') {
        updateVoice(current => {
          const base = current?.chatId === event.transcript.chatId
            ? current
            : { chatId: event.transcript.chatId, state: 'live' as VoiceState, error: null, transcript: '' };
          if (event.transcript.done) return { ...base, transcript: '' };
          return {
            ...base,
            transcript: base.transcript + event.transcript.text
          };
        });
      } else if (event.type === 'voiceEndRequested') {
        if (voiceRef.current?.chatId === event.chatId) {
          updateVoice({ ...voiceRef.current, state: 'stopping' });
        }
        void voiceSessionRef.current?.close();
        voiceSessionRef.current = null;
        void loadMessages(event.chatId, { clearCurrent: false, resetStreamBuffer: true });
      } else if (event.type === 'error') {
        if (!event.chatId || event.chatId === selectedChatRef.current) setAppError(event.message);
      }
    });

    void refresh();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [loadActivities, loadMessages, openChat, updateVoice]);

  useEffect(() => {
    let active = true;
    window.rambo.models().then(options => {
      if (active) {
        setModelOptions(options);
        setModelOptionsError(null);
      }
    }).catch(error => {
      if (active) setModelOptionsError(toError(error));
    });
    return () => { active = false; };
  }, []);

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
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activities, messages, selectedChatId]);

  useEffect(() => () => {
    void voiceSessionRef.current?.close();
    voiceSessionRef.current = null;
  }, []);

  const currentSnapshot = snapshot ?? EMPTY_SNAPSHOT;
  const botSections = partitionBots(currentSnapshot.bots);
  const activeBots = botSections.active;
  const archivedBots = botSections.archived;
  const currentBot = activeBots.find(bot => bot.id === selectedBotId) ?? null;
  const settingsBot = currentSnapshot.bots.find(bot => bot.id === selectedBotId) ?? null;
  const currentChat = selectedPrivateChat(currentSnapshot.chats, selectedChatId, selectedBotId);
  const currentGroup = currentSnapshot.groups.find(group => group.id === selectedGroupId) ?? null;
  const isRunning = currentChat ? Boolean(currentSnapshot.activeTurns[currentChat.id]) : false;

  useEffect(() => {
    if (!currentChat || !currentSnapshot.activeTurns[currentChat.id]) {
      setElapsedRunSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedRunSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedRunSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [currentChat?.id, currentSnapshot.activeTurns]);

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

  const createGroup = async (title: string, botIds: string[]) => {
    const group = await window.rambo.createGroup({ title, botIds });
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
    setSelectedGroupId(null);
    selectedGroupRef.current = null;
    setView('chat');
    setSelectedBotId(bot.id);
    setAppError(null);
    try {
      const chat = sortChats(currentSnapshot.chats, bot.id)[0] ?? await window.rambo.ensureBotChat(bot.id);
      setSnapshot(current => current
        ? { ...current, chats: [chat, ...current.chats.filter(item => item.id !== chat.id)] }
        : current);
      await openChat(chat);
    } catch (error) {
      setAppError(toError(error));
    }
  };

  const saveBot = async (id: string, patch: Partial<Pick<Bot, 'name' | 'avatar' | 'role' | 'instructions' | 'model' | 'permission'>>) => {
    const updated = await window.rambo.updateBot(id, patch);
    setSnapshot(current => current
      ? { ...current, bots: current.bots.map(bot => bot.id === id ? updated : bot) }
      : current);
  };

  const applyBotPermissionToChats = async (botId: string, permission: PermissionMode) => {
    await window.rambo.applyBotPermissionToChats(botId, permission);
    setSnapshot(current => current
      ? {
          ...current,
          bots: current.bots.map(bot => bot.id === botId ? { ...bot, permission } : bot),
          chats: current.chats.map(chat => chat.botId === botId ? { ...chat, permission } : chat)
        }
      : current);
  };

  const openBotSettings = (bot: Bot) => {
    setSelectedGroupId(null);
    selectedGroupRef.current = null;
    setSelectedBotId(bot.id);
    setView('bot-settings');
    setAppError(null);
  };

  const openSettings = () => {
    setView('settings');
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
    setTurns([]);
    setTurnsError(null);
    setLoadingMessages(false);
    setLoadingTurns(false);
  };

  const setBotArchived = async (botId: string, archived: boolean) => {
    await window.rambo.setBotArchived(botId, archived);
    setSnapshot(await window.rambo.snapshot());
    if (archived) setSearchBotId(current => current === botId ? 'all' : current);
    setAppError(null);
  };

  const restoreBot = async (botId: string) => {
    try { await setBotArchived(botId, false); }
    catch (error) { setAppError(toError(error)); }
  };

  const updateChat = async (id: string, patch: { model?: string | null; permission?: PermissionMode | null }) => {
    await window.rambo.updateChat(id, patch);
    setSnapshot(current => current
      ? { ...current, chats: current.chats.map(chat => chat.id === id ? { ...chat, ...patch } : chat) }
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
                {activeBots.map(bot => {
                  return (
                    <div className="bot-group" key={bot.id}>
                      <div className={'bot-list-row' + (selectedBotId === bot.id && view === 'chat' ? ' selected' : '')}>
                        <button type="button" className="bot-select" onClick={() => void chooseBot(bot)}
                          aria-current={selectedBotId === bot.id && view === 'chat' ? 'true' : undefined}>
                          <Avatar value={bot.avatar} size="small" />
                          <span className="bot-card-copy">
                            <span className="bot-row-name">{bot.name}</span>
                            <span className="bot-row-summary">{bot.role.trim() || '唯一私聊'}</span>
                          </span>
                        </button>
                        <button type="button" className="icon-button bot-settings-shortcut"
                          aria-label={'设置 ' + bot.name} title="Bot 设置"
                          onClick={() => openBotSettings(bot)}>
                          <Icon name="settings" size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {currentSnapshot.groups.map(group => {
                  const members = group.memberIds.map(id => currentSnapshot.bots.find(bot => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
                  return (
                    <div className="bot-group" key={group.id}>
                      <div className={'bot-list-row' + (selectedGroupId === group.id && view === 'group-chat' ? ' selected' : '')}>
                        <button type="button" className="bot-select" onClick={() => openGroup(group)}
                          aria-current={selectedGroupId === group.id && view === 'group-chat' ? 'page' : undefined}>
                          <GroupAvatar group={group} bots={currentSnapshot.bots} />
                          <span className="bot-card-copy">
                            <span className="bot-row-name">{group.title}</span>
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
              <nav className="routine-navigation" aria-label="任务导航">
                <button type="button" className={'routine-navigation-row' + (view === 'routines' ? ' selected' : '')}
                  aria-current={view === 'routines' ? 'page' : undefined}
                  title="查看所有 Bot 的定时任务" onClick={() => setView('routines')}>
                  <span className="routine-navigation-icon"><Icon name="calendar" size={16} /></span>
                  <span className="routine-navigation-label">全部定时任务</span>
                </button>
              </nav>
            </>
          )}
        </div>

        <div className="sidebar-footer">
          <button type="button" className={'account-button' + (view === 'settings' ? ' selected' : '')}
            aria-label="设置" title="设置" onClick={openSettings}>
            <span className="account-dot"><img className="app-brand-avatar" src={appAvatarUrl} alt="Rambo" /></span>
          </button>
          <div className="runtime-mini" title={runtimeLabel(currentSnapshot.runtime.status)}>
            <span className={'status-dot status-' + (currentSnapshot.runtime.status || 'stopped')} />
            <span>Codex</span>
          </div>
        </div>
      </aside>

      <main className="main-pane">
        <div className="main-titlebar-spacer" aria-hidden="true" />
        <header className="chat-header">
          {shouldShowReturnToChat(view) && (
            <button type="button" className="back-button" onClick={() => void returnToChat()}>
              <Icon name="back" size={16} />
              <span>返回聊天</span>
            </button>
          )}
          {view === 'chat' && currentBot && (
            <div className="current-bot-pill">
              <Avatar value={currentBot.avatar} size="small" />
              <span>{currentBot.name}</span>
              <span className="current-bot-pill-chevron"><Icon name="chevron" size={13} /></span>
            </div>
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
            bots={activeBots}
            onCancel={() => setView('group-chat')}
            onAdd={botIds => addGroupMembers(currentGroup.id, botIds)}
          />
        ) : view === 'group-chat' && currentGroup ? (
          <GroupChatPage key={currentGroup.id} group={currentGroup} bots={currentSnapshot.bots} messages={groupMessages}
            loading={loadingGroupMessages} models={modelOptions} modelError={modelOptionsError}
            onUpdateChat={(chatId, patch) => window.rambo.updateChat(chatId, patch)}
            onError={error => setAppError(error)} onSend={async text => {
              setAppError(null);
              try { await window.rambo.sendGroup(currentGroup.id, text); }
              catch (error) { setAppError(toError(error)); throw error; }
            }} />
        ) : view === 'group-chat' ? (
          <div className="page-loading">找不到这个群聊</div>
        ) : view === 'settings' ? (
          <AccountSettingsPage
            runtime={currentSnapshot.runtime}
            launchAtLogin={currentSnapshot.settings.launchAtLogin !== 'false'}
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
          />
        ) : view === 'routines' ? (
          <RoutineListPage routines={currentSnapshot.routines} runs={currentSnapshot.routineRuns} bots={currentSnapshot.bots} />
        ) : view === 'bot-settings' && settingsBot ? (
          <BotSettingsPage bot={settingsBot} routines={currentSnapshot.routines} runs={currentSnapshot.routineRuns}
            models={modelOptions} modelError={modelOptionsError}
            onSave={saveBot} onApplyPermission={applyBotPermissionToChats}
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
            onSetArchived={setBotArchived} onRequestDelete={() => setDeletingBot(settingsBot)} />
        ) : view === 'chat' && !loading && !currentBot ? (
          <div className="empty-chat-workspace" />
        ) : view === 'chat' && currentBot && !currentChat ? (
          <NoChatWorkspace bot={currentBot} onOpen={() => void chooseBot(currentBot)} />
        ) : view === 'chat' ? (
          <div className="chat-workspace">
            <div className="transcript-scroll" ref={scrollRef}>
              {loadingMessages ? (
                <div className="messages-loading" aria-label="正在读取聊天" />
              ) : (
                <div className="message-column">
                  {messages.map(message => {
                    const turnMessages = message.turnId
                      ? messages.filter(item => item.role === 'assistant' && item.turnId === message.turnId)
                      : [];
                    const hasFinal = turnMessages.some(item => item.phase === 'final_answer');
                    const ownsTurnDetails = message.role === 'assistant' && !!message.turnId && (
                      message.phase === 'final_answer' ||
                      (!hasFinal && turnMessages[turnMessages.length - 1]?.id === message.id)
                    );
                    return (
                      <MessageRow
                        key={message.id}
                        message={message}
                        activities={ownsTurnDetails
                          ? activities.filter(activity => activity.turnId === message.turnId)
                          : []}
                      />
                    );
                  })}
                  {currentChat && currentBot && isRunning && (
                    <AgentRunningRow
                      bot={currentBot}
                      activities={activities.filter(activity =>
                        activity.turnId === currentSnapshot.activeTurns[currentChat.id]
                      )}
                      elapsedSeconds={elapsedRunSeconds}
                    />
                  )}
                </div>
              )}
            </div>
            {currentChat && voice?.chatId === currentChat.id && (
              <VoicePanel
                voice={voice}
                onStop={() => void stopVoice(currentChat.id, '用户点击了结束语音')}
              />
            )}
            {currentChat && (
              <Composer
                key={currentChat.id}
                chat={currentChat}
                bot={currentBot!}
                models={modelOptions}
                modelsError={modelOptionsError}
                busy={isRunning}
                onUpdateChat={patch => updateChat(currentChat.id, patch)}
                onSend={async text => {
                  setAppError(null);
                  try {
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
            )}
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
          onCancel={() => setCreateOpen(false)}
          onCreate={createBot}
        />
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
    </div>
  );
}

function RoutineListPage({ routines, runs, bots }: { routines: RoutineListItem[]; runs: RoutineRun[]; bots: Bot[] }) {
  const botNames = new Map(bots.map(bot => [bot.id, bot.name]));
  return (
      <section className="settings-page routine-page" aria-label="所有 Bot 的定时任务">
      <div className="settings-page-heading">
        <div>
          <div className="eyebrow">自动化</div>
          <h1>全部 Bot 的定时任务</h1>
          <p>查看每个 Bot 管理的任务。</p>
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
        <ul className="routine-list" aria-label="已保存的定时任务">
          {routines.map(routine => (
            <li className="routine-list-item" key={routine.id}>
              <div className="routine-list-copy">
                <strong>{routine.title}</strong>
                <span>{botNames.get(routine.botId) ?? 'Bot 已不存在'} · {routine.definition.schedule}</span>
                <p>{routine.definition.instruction}</p>
                <RoutineRunSummary routine={routine} runs={runs} />
              </div>
              <span className={'routine-status routine-status-' + routine.status}>
                {routine.status === 'active' ? routineLabel(routine) : '已暂停'}
              </span>
            </li>
          ))}
        </ul>
      )}
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
    interrupted: '已中断', skipped: '已跳过', missed: '已错过'
  }[status];
}

function CreateGroupPage({
  bots,
  onCancel,
  onCreate
}: {
  bots: Bot[];
  onCancel: () => void;
  onCreate: (title: string, botIds: string[]) => Promise<GroupChat>;
}) {
  const [title, setTitle] = useState('新群聊');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleBot = (botId: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(botId)) next.delete(botId);
      else next.add(botId);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) { setError('请填写群聊名称'); return; }
    if (selectedIds.size < 2) { setError('请至少选择两个 Bot'); return; }
    setBusy(true);
    setError(null);
    try {
      await runGroupCreateAction({ type: 'create', title: normalizedTitle, botIds: [...selectedIds] }, {
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
          <p>选择至少两个 Bot。群聊和成员会保存在此设备。</p>
        </div>
      </div>
      <form className="settings-form" onSubmit={event => void submit(event)}>
        <label className="settings-field">
          <span>群聊名称</span>
          <input className="text-input" value={title} maxLength={120} required
            onChange={event => setTitle(event.target.value)} />
        </label>
        <fieldset className="group-member-picker">
          <legend>选择成员</legend>
          {bots.length === 0 ? (
            <div className="sidebar-hint">当前没有可加入的 Bot。</div>
          ) : bots.map(bot => (
            <label className={'group-member-option' + (selectedIds.has(bot.id) ? ' selected' : '')} key={bot.id}>
              <input type="checkbox" checked={selectedIds.has(bot.id)} disabled={busy}
                onChange={() => toggleBot(bot.id)} />
              <Avatar value={bot.avatar} size="small" />
              <span className="group-member-copy">
                <strong>{bot.name}</strong>
                <small>{bot.role.trim() || '个人助手'}</small>
              </span>
            </label>
          ))}
          <p className="group-selection-count">已选 {selectedIds.size} 个；普通消息由成员各自判断，明确点名时仅对应 Bot 回复。</p>
        </fieldset>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="settings-save-row">
          <button type="button" className="secondary-button" disabled={busy}
            onClick={() => void runGroupCreateAction({ type: 'cancel' }, { cancel: onCancel, create: onCreate })}>取消</button>
          <button type="submit" className="primary-button" disabled={busy || bots.length < 2 || selectedIds.size < 2 || !title.trim()}>
            {busy ? '正在创建…' : '创建群聊'}
          </button>
        </div>
      </form>
    </section>
  );
}

function AddGroupMembersPage({ group, bots, onCancel, onAdd }: {
  group: GroupChat;
  bots: Bot[];
  onCancel: () => void;
  onAdd: (botIds: string[]) => Promise<GroupChat>;
}) {
  const existing = new Set(group.memberIds);
  const candidates = bots.filter(bot => !existing.has(bot.id) && !bot.archived);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
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

  return (
    <section className="settings-page group-members-page">
      <header className="settings-page-heading">
        <div>
          <div className="eyebrow">GROUP</div>
          <h1>群聊成员</h1>
          <p>「{group.title}」已加入的 Bot 会保留原顺序；新成员可以读取加入前的本群历史，不会带入其他 Bot 私聊。</p>
        </div>
      </header>
      <form className="settings-form" onSubmit={event => void submit(event)}>
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
          <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
          <button type="submit" className="primary-button" disabled={busy || !selectedIds.size}>
            {busy ? '正在添加…' : '添加到群聊'}
          </button>
        </div>
      </form>
    </section>
  );
}

function GroupChatPage({ group, bots, messages, loading, models, modelError, onUpdateChat, onError, onSend }: {
  group: GroupChat; bots: Bot[]; messages: GroupMessage[]; loading: boolean; models: ModelOption[];
  modelError: string | null;
  onUpdateChat: (chatId: string, patch: { model?: string | null; permission?: PermissionMode | null }) => Promise<void>;
  onError: (error: string | null) => void;
  onSend: (text: string) => Promise<void>;
}) {
  const members = group.memberIds
    .map(id => bots.find(bot => bot.id === id))
    .filter((bot): bot is Bot => Boolean(bot));
  const activeMembers = members.filter(bot => !bot.archived);
  const [memberChats, setMemberChats] = useState<Chat[]>([]);
  const [memberChatsLoading, setMemberChatsLoading] = useState(true);
  const memberIdsKey = group.memberIds.join(':');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    setMemberChatsLoading(true);
    window.rambo.groupMemberChats(group.id).then(chats => {
      if (!current) return;
      setMemberChats(chats);
      onError(null);
    }).catch(error => {
      if (current) onError(toError(error));
    }).finally(() => {
      if (current) setMemberChatsLoading(false);
    });
    return () => { current = false; };
  }, [group.id, memberIdsKey]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const updateMemberChat = async (chatId: string, patch: { model?: string | null; permission?: PermissionMode | null }) => {
    await onUpdateChat(chatId, patch);
    setMemberChats(current => current.map(chat => chat.id === chatId ? { ...chat, ...patch } : chat));
  };

  return (
    <section className="chat-workspace" aria-label={group.title}>
      <div className="transcript-scroll" ref={scrollRef} aria-label="群聊消息">
        {loading ? <div className="messages-loading" aria-label="正在读取群聊" /> : messages.length > 0 ? (
          <div className="message-column">
            {messages.map(message => <GroupMessageRow key={message.id} message={message} bots={bots} />)}
          </div>
        ) : (
          <div className="conversation-empty-state">
            <strong>开始群聊</strong>
            <p>普通消息由成员各自判断是否回复；@名字 指定一个成员，@everyone 邀请所有活跃成员回复。</p>
          </div>
        )}
      </div>
      <Composer chat={null} bot={null} groupId={group.id} groupBots={activeMembers} groupChats={memberChats}
        groupSettingsDisabled={memberChatsLoading} onUpdateGroupChat={updateMemberChat}
        models={models} modelsError={modelError} busy={false}
        disabled={activeMembers.length === 0} placeholder="发送群聊消息…" ariaLabel="群聊消息输入框"
        settingsNote={activeMembers.length === 0 ? '请恢复至少一个成员 Bot 后再发送。' : '每个成员 Bot 使用自己的模型和权限设置。'}
        onSend={onSend} />
    </section>
  );
}

function GroupMessageRow({ message, bots }: { message: GroupMessage; bots: Bot[] }) {
  const sender = message.senderBotId ? bots.find(bot => bot.id === message.senderBotId) : undefined;
  const roleLabel = message.role === 'assistant' ? sender?.name ?? message.senderName ?? '已删除的 Bot' : '系统';
  return (
    <article className={'message-row message-' + message.role}>
      <div className="message-content">
        {message.role !== 'user' && <div className="message-author">{roleLabel}</div>}
        <div className="message-text">{message.text}</div>
        {(message.status === 'failed' || message.status === 'interrupted') && (
          <div className="message-status">{message.status === 'failed' ? '未完成' : '已停止'}</div>
        )}
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
  bot,
  activities,
  elapsedSeconds
}: {
  bot: Bot;
  activities: TurnActivity[];
  elapsedSeconds: number;
}) {
  const latest = activities[activities.length - 1];
  const label = latest ? ACTIVITY_LABELS[latest.kind] : '正在思考';
  return (
    <div className="agent-running-row" role="status" aria-live="polite" aria-label={label}>
      <span className="agent-running-avatar">
        <Avatar value={bot.avatar} size="regular" />
        <span className="agent-running-ring" aria-hidden="true" />
      </span>
      <span className="agent-running-copy">
        <span className="agent-running-shimmer">{label}</span>
        <span className="agent-running-meta">{bot.name}{elapsedSeconds > 0 ? ` · ${elapsedSeconds} 秒` : ''}</span>
      </span>
    </div>
  );
}

function activityTitle(activity: TurnActivity): string {
  if (activity.title.trim()) return activity.title;
  return activity.kind === 'reasoning' ? '思考过程' : '操作';
}

function activityDetailLabel(activity: TurnActivity): string {
  if (activity.status === 'running') return '进行中';
  if (activity.status === 'failed') return '失败';
  if (activity.status === 'declined') return '已拒绝';
  if (activity.status === 'unknown') return '未知状态';
  return '已完成';
}

function MessageRow({ message, activities }: { message: Message; activities: TurnActivity[] }) {
  const roleLabel = message.role === 'user' ? '你' : message.role === 'assistant' ? 'Bot' : '系统';
  return (
    <article className={'message-row message-' + message.role}>
      <div className="message-content">
        {message.role !== 'user' && <div className="message-author">{roleLabel}</div>}
        <div className="message-text">{message.text}</div>
        {(message.status === 'failed' || message.status === 'interrupted') && (
          <div className="message-status">
            {message.status === 'failed' ? '未完成' : '已停止'}
          </div>
        )}
        {activities.length > 0 && (
          <details className="message-activities">
            <summary>
              思考与操作
              <span>{activities.length}</span>
            </summary>
            <div className="message-activity-list">
              {activities.map(activity => (
                <section className={`message-activity activity-${activity.kind}`} key={activity.id}>
                  <div className="message-activity-heading">
                    <strong>{activityTitle(activity)}</strong>
                    <span>{activityDetailLabel(activity)}</span>
                  </div>
                  {activity.detail.trim() && (
                    <pre className="message-activity-detail">{activity.detail}</pre>
                  )}
                </section>
              ))}
            </div>
          </details>
        )}
      </div>
    </article>
  );
}

function VoicePanel({ voice, onStop }: { voice: LiveVoiceUi; onStop: () => void }) {
  const label = voice.state === 'connecting'
    ? '正在连接 Live'
    : voice.state === 'live'
      ? 'Live · 正在聆听'
      : voice.state === 'stopping'
        ? '正在结束语音'
        : '语音连接异常';
  return (
    <section className={'voice-panel voice-panel-' + voice.state} aria-label={label}>
      <div className="voice-panel-main">
        <span className="voice-pulse" aria-hidden="true" />
        <div className="voice-panel-copy">
          <strong>{label}</strong>
          <span>
            {voice.error
              ? voice.error
              : voice.transcript
                ? voice.transcript
                : voice.state === 'live'
                  ? '说话即可，Bot 会在本聊天中回答。'
                  : '麦克风与音频只用于当前私聊。'}
          </span>
        </div>
        <button type="button" className="voice-end-button" onClick={onStop}
          disabled={voice.state === 'stopping'} aria-label="结束语音">
          <Icon name="close" size={14} />
          <span>{voice.state === 'stopping' ? '结束中' : '结束'}</span>
        </button>
      </div>
    </section>
  );
}

function Composer({
  chat,
  bot,
  groupId,
  groupBots,
  groupChats,
  groupSettingsDisabled = false,
  models,
  modelsError,
  busy,
  onUpdateChat,
  onUpdateGroupChat,
  onSend,
  onStop,
  voiceState,
  onStartVoice,
  onStopVoice,
  disabled = false,
  placeholder = '发消息给 Bot',
  ariaLabel = '消息',
  settingsNote = '下轮生效'
}: {
  chat: Chat | null;
  bot: Bot | null;
  groupId?: string;
  groupBots?: Bot[];
  groupChats?: Chat[];
  groupSettingsDisabled?: boolean;
  models: ModelOption[];
  modelsError: string | null;
  busy: boolean;
  onUpdateChat?: (patch: { model?: string | null; permission?: PermissionMode | null }) => Promise<void>;
  onUpdateGroupChat?: (chatId: string, patch: { model?: string | null; permission?: PermissionMode | null }) => Promise<void>;
  onSend: (text: string) => Promise<void>;
  onStop?: () => Promise<void>;
  voiceState?: VoiceState | null;
  onStartVoice?: () => void;
  onStopVoice?: () => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  settingsNote?: string;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [updatingSettings, setUpdatingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = Boolean(draft.trim()) && !sending && !disabled;
  const inheritedModel = chat && bot ? inheritedChatModel(bot) : null;
  const selectedModel = chat && bot ? selectedChatModel(chat, bot) : null;

  const updateSettings = async (patch: { model?: string | null; permission?: PermissionMode | null }) => {
    if (!onUpdateChat) return;
    setUpdatingSettings(true);
    setSettingsError(null);
    try { await onUpdateChat(patch); }
    catch (error) { setSettingsError(toError(error)); }
    finally { setUpdatingSettings(false); }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSend(text);
      setDraft('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    } catch {
      // The draft stays in the composer so the user can review or retry it.
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer-dock">
      <form className="composer" onSubmit={event => void submit(event)}>
        <div className="composer-settings-row">
          {chat && bot && inheritedModel && selectedModel ? <>
            <label className="composer-setting">
              <span>权限</span>
              <select aria-label="当前聊天权限" disabled={updatingSettings} value={chat.permission ?? ''}
                title={chat.permission === null ? `继承 Bot · ${PERMISSION_LABELS[bot.permission]}` : '仅此聊天的权限覆盖'}
                onChange={event => void updateSettings({ permission: event.target.value === '' ? null : event.target.value as PermissionMode })}>
                <option value="">继承 Bot · {PERMISSION_LABELS[bot.permission]}</option>
                <option value="fullAccess">完全访问</option>
                <option value="workspaceWrite">工作区写入</option>
                <option value="readOnly">只读</option>
              </select>
            </label>
            <label className="composer-setting model-setting">
              <span>模型</span>
              <select aria-label="当前聊天模型" disabled={updatingSettings} value={chat.model ?? ''}
                title={`下轮生效 · ${modelSourceLabel(selectedModel.source)} · ${modelLabel(selectedModel.id, models)}`}
                onChange={event => void updateSettings({ model: event.target.value || null })}>
                <option value="">
                  {inheritedModel.source === 'bot'
                    ? `继承 · ${modelLabel(inheritedModel.id, models)} · Bot 默认`
                    : `继承 · ${modelSourceLabel(inheritedModel.source)}`}
                </option>
                {chat.model && !models.some(option => option.id === chat.model) && (
                  <option value={chat.model}>当前聊天 · {chat.model}</option>
                )}
                {models.map(option => (
                  <option value={option.id} key={option.id}>{option.label}{option.isDefault ? ' · 产品默认' : ''}</option>
                ))}
              </select>
            </label>
            <span className="composer-setting-hint">{settingsNote}</span>
          </> : groupBots && groupChats && onUpdateGroupChat ? (
            <GroupComposerSettings groupId={groupId ?? ''} bots={groupBots} chats={groupChats}
              models={models} disabled={disabled || groupSettingsDisabled}
              onUpdateChat={onUpdateGroupChat} onError={setSettingsError} />
          ) : <span className="composer-setting-hint">{settingsNote}</span>}
        </div>
        <div className="composer-input-row">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={placeholder}
            aria-label={ariaLabel}
            disabled={disabled}
            onChange={event => {
              setDraft(event.target.value);
              event.target.style.height = 'auto';
              event.target.style.height = Math.min(event.target.scrollHeight, 180) + 'px';
            }}
            onKeyDown={onKeyDown}
          />
          <div className="composer-actions">
            {onStartVoice && onStopVoice && (
              <button type="button"
                className={'voice-button' + (voiceState === 'live' ? ' voice-button-live' : '')}
                aria-label={voiceState ? '结束语音' : '开始语音'}
                title={voiceState ? '结束语音' : '开始 Codex Live 语音'}
                disabled={voiceState === 'connecting' || voiceState === 'stopping'}
                onClick={voiceState ? onStopVoice : onStartVoice}>
                <Icon name="voice" size={17} />
              </button>
            )}
            {busy && onStop && (
              <button type="button" className="stop-button" aria-label="停止任务" title="停止"
                onClick={() => void onStop()}>
                <Icon name="stop" size={14} />
                <span>停止</span>
              </button>
            )}
            <button type="submit" className="send-button" disabled={!canSend}
              aria-label="发送" title="发送">
              <Icon name="send" size={17} />
            </button>
          </div>
        </div>
      </form>
      <div className="composer-caption">Enter 发送 · Shift + Enter 换行</div>
      {(settingsError || modelsError) && (
        <div className="composer-setting-error" role="status">
          {settingsError ?? `暂时无法读取模型目录：${modelsError}`}
        </div>
      )}
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
  onCancel,
  onCreate
}: {
  busy: boolean;
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
          <Avatar value={avatar} size="preview" />
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
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
            <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
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

function BotSettingsPage({
  bot,
  routines,
  runs,
  models,
  modelError,
  onSave,
  onApplyPermission,
  onSetRoutineStatus,
  onRunRoutineNow,
  onStopRoutineRun,
  onSetArchived,
  onRequestDelete
}: {
  bot: Bot;
  routines: RoutineListItem[];
  runs: RoutineRun[];
  models: ModelOption[];
  modelError: string | null;
  onSave: (id: string, patch: Partial<Pick<Bot, 'name' | 'avatar' | 'role' | 'instructions' | 'model' | 'permission'>>) => Promise<void>;
  onApplyPermission: (id: string, permission: PermissionMode) => Promise<void>;
  onSetRoutineStatus: (id: string, status: RoutineListItem['status']) => Promise<void>;
  onRunRoutineNow: (id: string) => Promise<RoutineRun>;
  onStopRoutineRun: (id: string) => Promise<RoutineRun>;
  onSetArchived: (id: string, archived: boolean) => Promise<void>;
  onRequestDelete: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [avatar, setAvatar] = useState(bot.avatar);
  const [role, setRole] = useState(bot.role);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [model, setModel] = useState(bot.model ?? '');
  const [permission, setPermission] = useState<PermissionMode>(bot.permission);
  const [saving, setSaving] = useState(false);
  const [applyingPermission, setApplyingPermission] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [permissionApplied, setPermissionApplied] = useState(false);
  const [routineBusy, setRoutineBusy] = useState<string | null>(null);
  const [routineMessage, setRoutineMessage] = useState<string | null>(null);
  const botRoutines = routines.filter(routine => routine.botId === bot.id);

  useEffect(() => {
    setName(bot.name);
    setAvatar(bot.avatar);
    setRole(bot.role);
    setInstructions(bot.instructions);
    setModel(bot.model ?? '');
    setPermission(bot.permission);
    setSaved(false);
    setPermissionApplied(false);
  }, [bot.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    setPermissionApplied(false);
    try {
      await onSave(bot.id, {
        name: name.trim() || bot.name,
        avatar,
        role,
        instructions,
        model: model || null,
        permission
      });
      setSaved(true);
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setSaving(false);
    }
  };

  const applyPermission = async () => {
    setApplyingPermission(true);
    setError(null);
    setSaved(false);
    setPermissionApplied(false);
    try {
      await onApplyPermission(bot.id, permission);
      setPermissionApplied(true);
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setApplyingPermission(false);
    }
  };

  const changeArchived = async () => {
    setLifecycleBusy(true);
    setError(null);
    try { await onSetArchived(bot.id, !bot.archived); }
    catch (issue) { setError(toError(issue)); }
    finally { setLifecycleBusy(false); }
  };

  const changeRoutine = async (routine: RoutineListItem) => {
    setRoutineBusy(routine.id);
    setRoutineMessage(null);
    try {
      await onSetRoutineStatus(routine.id, routine.status === 'active' ? 'paused' : 'active');
      setRoutineMessage(routine.status === 'active' ? '定时计划已暂停' : '定时计划已恢复');
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
    const run = runs.find(item =>
      item.routineId === routine.id && (item.status === 'running' || item.status === 'pending')
    );
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
    const run = runs.find(item =>
      item.routineId === routine.id && (item.status === 'running' || item.status === 'pending')
    );
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
    <section className="settings-page bot-settings-page">
      <div className="settings-page-heading">
        <div>
          <div className="eyebrow">BOT</div>
          <h1>Bot 资料</h1>
          <p>名称、职责、默认模型与权限会用于这个 Bot 后续的新轮次。</p>
        </div>
        <Avatar value={bot.avatar} size="large" />
      </div>
      <form className="settings-form" onSubmit={event => void save(event)}>
        <label className="settings-field">
          <span>名称</span>
          <input className="text-input" value={name} maxLength={80} required
            onChange={event => { setName(event.target.value); setSaved(false); setPermissionApplied(false); }} />
        </label>
        <div className="settings-field">
          <span>头像</span>
          <AvatarPicker value={avatar} className="settings-avatar-picker"
            onChange={value => { setAvatar(value); setSaved(false); setPermissionApplied(false); }} />
        </div>
        <label className="settings-field">
          <span>短职责</span>
          <input className="text-input" value={role} maxLength={160}
            placeholder="一句话说明这个 Bot 的职责"
            onChange={event => { setRole(event.target.value); setSaved(false); setPermissionApplied(false); }} />
        </label>
        <label className="settings-field">
          <span>长期指令</span>
          <textarea className="text-input settings-textarea" value={instructions} rows={5}
            placeholder="描述这个 Bot 长期遵循的工作方式"
            onChange={event => { setInstructions(event.target.value); setSaved(false); setPermissionApplied(false); }} />
        </label>
        <label className="settings-field">
          <span>默认模型</span>
          <select className="text-input select-input" value={model}
            onChange={event => { setModel(event.target.value); setSaved(false); setPermissionApplied(false); }}>
            <option value="">使用本机配置，发送时解析</option>
            {models.map(option => (
              <option value={option.id} key={option.id}>
                {option.label}{option.isDefault ? ' · 产品默认' : ''}
              </option>
            ))}
          </select>
          <small className="field-hint">“产品默认”来自模型目录标记；Bot 为空时实际请求模型在发送时解析。</small>
          {modelError && <small className="field-hint">暂时无法读取模型列表：{modelError}</small>}
        </label>
        <fieldset className="permission-fieldset" disabled={saving || applyingPermission}>
          <legend>权限</legend>
          <PermissionOption value="fullAccess" selected={permission} onSelect={value => { setPermission(value); setSaved(false); setPermissionApplied(false); }}
            title="完全访问" description="允许 Codex 在本机执行，不限制于 Bot 工作区。" />
          <PermissionOption value="workspaceWrite" selected={permission} onSelect={value => { setPermission(value); setSaved(false); setPermissionApplied(false); }}
            title="工作区写入" description="允许在 Bot 工作区读写，并使用网络。" />
          <PermissionOption value="readOnly" selected={permission} onSelect={value => { setPermission(value); setSaved(false); setPermissionApplied(false); }}
            title="只读" description="不允许写入文件。" />
          <div className="apply-permission-row">
            <span className="field-hint">将当前权限保存为 Bot 默认，并覆盖此 Bot 的全部已有聊天。</span>
            <button type="button" className="secondary-button" disabled={saving || applyingPermission}
              onClick={() => void applyPermission()}>
              {applyingPermission ? '正在应用…' : '保存权限并应用到全部聊天'}
            </button>
          </div>
        </fieldset>
        {(error || saved || permissionApplied) && (
          <div className={error ? 'form-error' : 'form-saved'} role="status">
            {error ?? (permissionApplied ? 'Bot 默认权限已保存，并已应用到全部已有聊天。执行中的轮次仍按启动时权限继续。' : '已保存')}
          </div>
        )}
        <div className="settings-save-row">
          <span className="field-hint">正在执行的轮次继续使用启动时的配置。</span>
          <button type="submit" className="primary-button" disabled={saving || applyingPermission}>
            {saving ? '正在保存…' : '保存资料'}
          </button>
        </div>
      </form>
      <section className="bot-routines-section" aria-label={bot.name + ' 的定时任务'}>
        <div className="settings-page-heading">
          <div>
            <h2>定时任务</h2>
            <p>此 Bot 管理的任务。</p>
          </div>
        </div>
        {botRoutines.length ? (
          <ul className="routine-list" aria-label={bot.name + ' 管理的定时任务'}>
            {botRoutines.map(routine => (
              <li className="routine-list-item" key={routine.id}>
                <div className="routine-list-copy">
                  <strong>{routine.title}</strong>
                  <span>{routine.definition.schedule}</span>
                  <p>{routine.definition.instruction}</p>
                  <RoutineRunSummary routine={routine} runs={runs} />
                </div>
                <div className="routine-actions">
                  <span className={'routine-status routine-status-' + routine.status}>
                    {routine.status === 'active' ? routineLabel(routine) : '已暂停'}
                  </span>
                  {routine.definition.kind === 'recurring' && (
                    <button type="button" className="routine-action-button" disabled={routineBusy === routine.id}
                      onClick={() => void changeRoutine(routine)}>
                      {routineBusy === routine.id ? '处理中…' : routine.status === 'active' ? '暂停' : '恢复'}
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
                    disabled={routineBusy === routine.id || routine.status === 'paused' ||
                      routine.lastRun?.status === 'running' || routine.lastRun?.status === 'pending'}
                    onClick={() => void runRoutine(routine)}>立即运行</button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="routine-empty-state" role="status">
            <span className="routine-empty-icon"><Icon name="calendar" size={21} /></span>
            <div><h2>暂无定时任务</h2><p>该 Bot 创建的定时任务会显示在这里。</p></div>
          </div>
        )}
        {routineMessage && <div className="routine-message" role="status">{routineMessage}</div>}
      </section>
      <MemoryManager botId={bot.id} title="Bot 专属长期记忆"
        description="这个 Bot 可自动整理保存自己的长期记忆；你也可以在这里查看、编辑或删除。其他 Bot 不会读取这些条目。" />
      <section className="bot-lifecycle-section" aria-label="Bot 归档和删除">
        <div>
          <h2>{bot.archived ? '已归档的 Bot' : 'Bot 管理'}</h2>
          <p>{bot.archived
            ? '恢复后会重新显示聊天和记忆；已暂停的例程保持暂停。'
            : '归档会从主列表隐藏此 Bot、保留聊天和记忆，并暂停它的自动例程。'}</p>
        </div>
        <div className="bot-lifecycle-actions">
          <button type="button" className="secondary-button" disabled={lifecycleBusy || saving || applyingPermission}
            onClick={() => void changeArchived()}>
            {lifecycleBusy ? '正在更新…' : bot.archived ? '恢复 Bot' : '归档 Bot'}
          </button>
          <button type="button" className="danger-button" disabled={lifecycleBusy || saving || applyingPermission}
            onClick={onRequestDelete}>永久删除 Bot…</button>
        </div>
      </section>
    </section>
  );
}

function PermissionOption({
  value,
  selected,
  onSelect,
  title,
  description
}: {
  value: PermissionMode;
  selected: PermissionMode;
  onSelect: (value: PermissionMode) => void;
  title: string;
  description: string;
}) {
  return (
    <label className={'permission-option' + (selected === value ? ' selected' : '')}>
      <input type="radio" name="permission" value={value} checked={selected === value}
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const memory = await window.rambo.saveMemory({ botId, text: draft });
      setMemories(current => current.some(item => item.id === memory.id)
        ? current.map(item => item.id === memory.id ? memory : item)
        : [...current, memory].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      setDraft('');
      setNotice('已保存到长期记忆。');
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (memory: Memory) => {
    if (!editText.trim() || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await window.rambo.saveMemory({ id: memory.id, botId, text: editText });
      setMemories(current => current.map(item => item.id === updated.id ? updated : item));
      setEditingId(null);
      setEditText('');
      setNotice('记忆已更新。');
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (memory: Memory) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await window.rambo.deleteMemory(memory.id);
      setMemories(current => current.filter(item => item.id !== memory.id));
      if (editingId === memory.id) { setEditingId(null); setEditText(''); }
      setNotice('记忆已删除。');
    } catch (issue) {
      setError(toError(issue));
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
      <form className="memory-create-form" onSubmit={event => void save(event)}>
        <label className="settings-field">
          <span>新增一条长期记忆</span>
          <textarea className="text-input memory-textarea" rows={3} maxLength={20_000} value={draft}
            placeholder="写下适合长期保留的偏好、事实或目标"
            onChange={event => setDraft(event.target.value)} />
        </label>
        <div className="memory-form-actions">
          <span className="field-hint">Bot 自动整理保存无需逐项批准；删除后不提供历史或撤销。</span>
          <button type="submit" className="secondary-button" disabled={saving || !draft.trim()}>
            {saving ? '正在保存…' : '保存记忆'}
          </button>
        </div>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="form-saved" role="status">{notice}</div>}
      {loading ? <div className="memory-empty-state" role="status">正在读取长期记忆…</div>
        : memories.length ? (
          <ul className="memory-list" aria-label={title + '条目'}>
            {memories.map(memory => (
              <li className="memory-item" key={memory.id}>
                {editingId === memory.id ? (
                  <div className="memory-edit-form">
                    <textarea className="text-input memory-textarea" rows={3} maxLength={20_000} value={editText}
                      aria-label="编辑长期记忆" onChange={event => setEditText(event.target.value)} />
                    <div className="memory-item-actions">
                      <button type="button" className="secondary-button" disabled={saving}
                        onClick={() => { setEditingId(null); setEditText(''); }}>取消</button>
                      <button type="button" className="primary-button" disabled={saving || !editText.trim()}
                        onClick={() => void saveEdit(memory)}>{saving ? '正在保存…' : '保存修改'}</button>
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

function AccountSettingsPage({ runtime, launchAtLogin, onSetLaunchAtLogin }: {
  runtime: RuntimeState;
  launchAtLogin: boolean;
  onSetLaunchAtLogin: (enabled: boolean) => Promise<void>;
}) {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
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
    return () => { active = false; };
  }, []);

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
    setError(null);
    setNotice(null);
    try {
      await window.rambo.restartRuntime();
      setNotice('已请求重启 Codex。');
    } catch (issue) {
      setError(toError(issue));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-page">
      <div className="settings-page-heading">
        <div>
          <div className="eyebrow">RAMBO</div>
          <h1>设置</h1>
          <p>查看本机 Codex 连接和账号状态。</p>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">
          <div>
            <h2>账号</h2>
            <p>Rambo 使用本机 Codex 登录状态。</p>
          </div>
        </div>
        <div className="account-card">
          <div className="account-avatar">C</div>
          <div className="account-copy">
            <strong>{loading ? '正在读取账号状态…' : error ? '无法读取账号状态' : account?.requiresLogin ? '尚未登录' : account?.email || account?.type || '已连接账号'}</strong>
            <span>{account?.type ? '登录方式：' + account.type : '账号状态来自本机 Codex'}</span>
          </div>
          {account?.requiresLogin && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void login()}>
              登录
            </button>
          )}
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">
          <div>
            <h2>启动</h2>
            <p>登录 macOS 后启动 Rambo，让本机任务继续运行。</p>
          </div>
        </div>
        <label className="settings-toggle-row">
          <span>
            <strong>登录时启动</strong>
            <span>关闭 Rambo 窗口不会停止任务；退出 Rambo 才会停止本机服务。</span>
          </span>
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
          <div>
            <h2>Codex 运行时</h2>
            <p>Bot 的文字聊天通过本机随包运行时处理。</p>
          </div>
        </div>
        <div className="runtime-card">
          <div className="runtime-card-status">
            <span className={'status-dot status-' + runtime.status} />
            <strong>{runtimeLabel(runtime.status)}</strong>
            <span className="runtime-version">版本 {runtime.version || '未知'}</span>
          </div>
          {runtime.error && <div className="runtime-error">{runtime.error}</div>}
          <button type="button" className="secondary-button" disabled={busy || runtime.status === 'starting'}
            onClick={() => void restart()}>
            {busy ? '处理中…' : '重启运行时'}
          </button>
        </div>
      </div>
      {(error || notice) && (
        <div className={error ? 'form-error settings-message' : 'form-saved settings-message'} role="status">
          {error ?? notice}
        </div>
      )}
    </section>
  );
}

export default App;
