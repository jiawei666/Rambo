export type PermissionMode = 'fullAccess' | 'workspaceWrite' | 'readOnly';
export type MessageStatus = 'complete' | 'streaming' | 'failed' | 'interrupted';
export interface Bot {
  id: string; name: string; avatar: string; role: string; instructions: string;
  model: string | null; permission: PermissionMode; archived: boolean; createdAt: string;
}
export interface Chat {
  id: string; botId: string; title: string; threadId: string | null; groupChatId: string | null;
  /** Internal Routine execution chats are hidden from user-facing chat lists and search. */
  routineRunId: string | null;
  /** null means inherit the Bot's default, then the Codex global default. */
  model: string | null;
  /** null means inherit the Bot's permission. */
  permission: PermissionMode | null;
  archived: boolean; createdAt: string; updatedAt: string;
}
export interface GroupChat {
  id: string;
  title: string;
  /** Members are ordered by when they were added; retained defaultBotId is legacy data and is not a responder rule. */
  memberIds: string[];
  /** Legacy schema value. New groups leave this null and group dispatch ignores it. */
  defaultBotId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface GroupMessage {
  id: string; groupId: string; role: 'user' | 'assistant' | 'system';
  senderBotId: string | null; senderName: string | null; text: string;
  status: MessageStatus; itemId: string | null; createdAt: string;
}
export type RoutineStatus = 'active' | 'paused';
export type RoutineKind = 'recurring' | 'once';
export type RoutineFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly';
export type RoutineRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'skipped'
  | 'missed';
export interface RoutineDefinition {
  instruction: string;
  /** Human-readable schedule shown in the UI. */
  schedule: string;
  kind: RoutineKind;
  timezone: string;
  frequency: RoutineFrequency | null;
  weekday: number | null;
  dayOfMonth: number | null;
  time: string;
  runAt: string | null;
  catchUp: boolean;
  rememberLastResult: boolean;
  successNotification: boolean;
}
export interface RoutineListItem {
  id: string;
  title: string;
  botId: string;
  sourceChatId: string;
  definition: RoutineDefinition;
  status: RoutineStatus;
  nextRunAt: string | null;
  lastRun: RoutineRun | null;
  createdAt: string;
  updatedAt: string;
}
export interface RoutineRun {
  id: string;
  routineId: string;
  botId: string;
  routineTitle: string;
  instruction: string;
  scheduledFor: string;
  status: RoutineRunStatus;
  trigger: 'schedule' | 'catchUp' | 'manual' | 'skip';
  /** Hidden chat/thread used for this run's independent Codex context. */
  chatId: string | null;
  /** User-visible chat that receives only the short completion brief. */
  sourceChatId: string | null;
  turnId: string | null;
  summary: string | null;
  error: string | null;
  process: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
export interface Message {
  id: string; chatId: string; role: 'user' | 'assistant' | 'system'; text: string;
  status: MessageStatus; itemId: string | null; createdAt: string;
  /** Codex turn that produced this assistant message; null for legacy and user/system rows. */
  turnId: string | null;
  /** Null preserves compatibility for providers that do not classify assistant text. */
  phase: 'commentary' | 'partial_answer' | 'final_answer' | null;
}
export type ActivityKind =
  | 'reasoning'
  | 'command'
  | 'file'
  | 'web'
  | 'mcp'
  | 'tool'
  | 'plan'
  | 'image'
  | 'collab'
  | 'other';
export type ActivityStatus = 'running' | 'complete' | 'failed' | 'declined' | 'unknown';
export interface TurnActivity {
  id: string;
  chatId: string;
  turnId: string | null;
  itemId: string;
  kind: ActivityKind;
  status: ActivityStatus;
  title: string;
  detail: string;
  createdAt: string;
  updatedAt: string;
}
export interface RuntimeState {
  status: 'stopped' | 'starting' | 'ready' | 'error';
  version: string; error: string | null;
}
export type VoiceState = 'connecting' | 'live' | 'stopping' | 'error';
export interface VoiceSessionState {
  chatId: string;
  state: VoiceState;
  realtimeSessionId: string | null;
  error: string | null;
}
export interface VoiceTranscript {
  chatId: string;
  role: 'user' | 'assistant';
  text: string;
  itemId: string | null;
  done: boolean;
}
export interface AccountState { type: string | null; email: string | null; requiresLogin: boolean }
export interface ModelOption { id: string; label: string; isDefault: boolean }
export interface Memory { id: string; botId: string | null; text: string; approved: boolean; createdAt: string }
export type TurnModelSource = 'chat' | 'bot' | 'global' | 'unknown';
export type TurnResolutionSource = 'modelRerouted' | 'unknown';
export type ThreadModelSource = 'threadStartResponse' | 'threadResumeResponse' | 'unknown';
export type TurnStatus = 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export interface TurnReroute {
  fromModel: string; toModel: string; reason: string; receivedAt: string;
}
export type TurnSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly' }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean };
export interface TurnPermissionSnapshot {
  permission: PermissionMode;
  approvalPolicy: 'never' | 'on-request';
  sandboxPolicy: TurnSandboxPolicy;
}
/** Per-turn request metadata and protocol-confirmed model evidence. Null resolution means unknown. */
export interface TurnRecord {
  id: string;
  turnId: string | null;
  threadId: string;
  chatId: string;
  requestedModel: string | null;
  modelSource: TurnModelSource;
  /** Last thread-level model response observed before this request; not per-turn execution proof. */
  threadModelAtRequest: string | null;
  threadModelProviderAtRequest: string | null;
  threadModelSource: ThreadModelSource;
  threadModelObservedAt: string | null;
  serverResolvedModel: string | null;
  serverResolvedProvider: string | null;
  resolutionSource: TurnResolutionSource;
  reroutes: TurnReroute[];
  permissionSnapshot: TurnPermissionSnapshot;
  status: TurnStatus;
  startedAt: string;
  completedAt: string | null;
}
export interface Snapshot {
  bots: Bot[]; chats: Chat[]; groups: GroupChat[]; routines: RoutineListItem[]; routineRuns: RoutineRun[];
  runtime: RuntimeState;
  activeTurns: Record<string, string>; settings: Record<string, string>;
}
export type AppEvent =
  | { type: 'changed' }
  | { type: 'runtime'; state: RuntimeState }
  | { type: 'message'; message: Message }
  | { type: 'activity'; activity: TurnActivity }
  | { type: 'groupMessage'; groupId: string; message: GroupMessage }
  | { type: 'turn'; chatId: string; turnId: string | null }
  | { type: 'turnMetadata'; chatId: string; turnId: string | null }
  | { type: 'voiceState'; session: VoiceSessionState }
  | { type: 'voiceSdp'; chatId: string; sdp: string }
  | { type: 'voiceTranscript'; transcript: VoiceTranscript }
  | { type: 'voiceEndRequested'; chatId: string; reason: string }
  | { type: 'error'; chatId?: string; message: string };
export interface RamboAPI {
  snapshot(): Promise<Snapshot>;
  createBot(input: { name: string; avatar: string }): Promise<{ bot: Bot; chat: Chat }>;
  updateBot(id: string, patch: Partial<Pick<Bot, 'name' | 'avatar' | 'role' | 'instructions' | 'model' | 'permission'>>): Promise<Bot>;
  setBotArchived(id: string, archived: boolean): Promise<Bot>;
  deleteBot(id: string): Promise<void>;
  ensureBotChat(botId: string): Promise<Chat>;
  createGroup(input: { title: string; botIds: string[] }): Promise<GroupChat>;
  addGroupMembers(groupId: string, botIds: string[]): Promise<GroupChat>;
  groupMemberChats(groupId: string): Promise<Chat[]>;
  groupMessages(groupId: string): Promise<GroupMessage[]>;
  sendGroup(groupId: string, text: string): Promise<void>;
  updateChat(id: string, patch: { model?: string | null; permission?: PermissionMode | null }): Promise<void>;
  applyBotPermissionToChats(botId: string, permission: PermissionMode): Promise<void>;
  setRoutineStatus(id: string, status: RoutineStatus): Promise<RoutineListItem>;
  advanceRoutineScheduleForAcceptance(id: string): Promise<void>;
  runRoutineNow(id: string): Promise<RoutineRun>;
  stopRoutineRun(id: string): Promise<RoutineRun>;
  messages(chatId: string): Promise<Message[]>;
  activities(chatId: string): Promise<TurnActivity[]>;
  turns(chatId: string): Promise<TurnRecord[]>;
  send(chatId: string, text: string): Promise<void>;
  interrupt(chatId: string): Promise<void>;
  search(query: string, botId?: string | null): Promise<Array<{ message: Message; chat: Chat; bot: Bot }>>;
  memories(botId: string | null): Promise<Memory[]>;
  saveMemory(input: { id?: string; botId: string | null; text: string }): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;
  setSetting(key: string, value: string): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  loginItemSystemChangesAllowed(): Promise<boolean>;
  injectAcceptanceEvent(event: unknown): Promise<void>;
  account(): Promise<AccountState>;
  login(): Promise<void>;
  models(): Promise<ModelOption[]>;
  startVoice(chatId: string, offerSdp: string): Promise<{ chatId: string; threadId: string }>;
  stopVoice(chatId: string, reason?: string): Promise<void>;
  restartRuntime(): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global { interface Window { rambo: RamboAPI } }
