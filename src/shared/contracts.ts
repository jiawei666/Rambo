import type { DesktopPlatform } from './platform';

export type PermissionMode = 'fullAccess' | 'workspaceWrite' | 'readOnly';
export type MessageStatus = 'complete' | 'streaming' | 'failed' | 'interrupted';
export type TurnDispatchStatus = 'queued' | 'dispatching' | 'dispatched' | 'needs_user' | 'failed';
export type MessagePhase = 'commentary' | 'partial_answer' | 'final_answer';
export type MessageSource = 'text' | 'voice';
export type ModelSourceKind = 'local' | 'chatgpt' | 'manualApi';
export type BotResourceKind = 'app' | 'plugin' | 'skill' | 'mcp';
export interface DirectMcpServer {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  headerKeys: string[];
  envKeys: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface BotResource {
  id: string;
  kind: BotResourceKind;
  name: string;
  description: string;
  source: string;
  /** Bundled resources come from Rambo/Codex itself rather than a user config file. */
  bundled: boolean;
  /** MCP server name or Plugin `name@marketplace` runtime key. */
  configKey: string | null;
}
export type McpElicitationAction = 'accept' | 'decline' | 'cancel';
export interface McpElicitationPrompt {
  requestId: string;
  serverName: string;
  threadId: string;
  turnId: string | null;
  message: string;
  detail: string | null;
  toolName: string | null;
}
export interface Bot {
  id: string; name: string; avatar: string; role: string; instructions: string;
  model: string; permission: PermissionMode; archived: boolean; createdAt: string;
  /** Timestamp of the latest pin action; null means not pinned. */
  pinnedAt: string | null;
  resourceIds: string[];
  /** Whether completed Bot replies may show a desktop system notification. */
  notificationsEnabled: boolean;
}
export type SecretScope = 'global' | 'bot';
export interface BotSecret {
  id: string;
  name: string;
  description: string;
  scope: SecretScope;
  /** Owning Bot for a Bot-private secret; null for a global secret. */
  botId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface SecretCapturePrompt {
  requestId: string;
  chatId: string;
  botId: string;
  botName: string;
  operation: 'save' | 'rotate';
  name: string;
  description: string;
  scope: SecretScope;
}
export type ConnectorCategory =
  | 'email'
  | 'calendar'
  | 'files'
  | 'communication'
  | 'productivity'
  | 'developer'
  | 'data'
  | 'other';
export type ConnectorAuthKind = 'oauth-desktop' | 'credentials' | 'local-key-capture';
export type ConnectionStatus = 'ready' | 'needsReconnect' | 'expired' | 'disabled';
export type ConnectorCapabilityStatus = 'ready' | 'unavailable';
export interface ConnectorProvider {
  id: string; name: string; description: string; category: ConnectorCategory;
  authKind: ConnectorAuthKind; capabilities: string[]; brandColor: string; monogram: string; available: boolean;
}
export interface ConnectorConnection {
  id: string; providerId: string; displayName: string; accountLabel: string;
  authKind: ConnectorAuthKind; status: ConnectionStatus; createdAt: string; updatedAt: string;
  capabilities?: Record<string, ConnectorCapabilityStatus>;
}
export interface ConnectorCredentialInput {
  challenge: ConnectorAuthChallenge; providerId: string; displayName: string; email: string; secret: string;
}
export interface ConnectorGrant { id: string; botId: string; connectionId: string; createdAt: string }
export interface ConnectorAuthChallenge {
  connectionId: string; providerId: string; authKind: ConnectorAuthKind; displayName: string;
  /** A localhost URL or local URI. Never contains a credential. */
  url: string;
}
export interface ConnectorAuthStartResult {
  challenge: ConnectorAuthChallenge;
  /** OAuth authorization URL. Opening it is always an explicit user action. */
  authorizationUrl: string | null;
}
export interface Chat {
  id: string; botId: string; title: string; threadId: string | null; groupChatId: string | null;
  /** Internal Routine execution chats are hidden from user-facing chat lists and search. */
  routineRunId: string | null;
  /** Legacy compatibility column; model execution always uses the Bot's explicit value. */
  model: string | null;
  /** Legacy compatibility column; permission always uses the Bot's explicit value. */
  permission: PermissionMode | null;
  /** Timestamp of the latest message the user has viewed in this chat. */
  lastReadAt: string | null;
  /** Internal row watermark used to disambiguate messages written in the same millisecond. */
  lastReadRowId: number | null;
  archived: boolean; createdAt: string; updatedAt: string;
}
export interface GroupChat {
  id: string; title: string; archived: boolean;
  /** Timestamp of the latest pin action; null means not pinned. */
  pinnedAt: string | null;
  /** Unique group owner. Null only for legacy groups whose owner Bot no longer exists. */
  ownerBotId: string | null;
  /** Shared responsibility used as collaboration context, never as an authorization source. */
  purpose: string;
  /** Members are ordered by when they were added; retained defaultBotId is legacy data and is not a responder rule. */
  memberIds: string[];
  /** Legacy schema value. New groups leave this null and group dispatch ignores it. */
  defaultBotId: string | null;
  createdAt: string; updatedAt: string;
}
export interface GroupMessage {
  id: string; groupId: string; role: 'user' | 'assistant' | 'system';
  senderBotId: string | null; senderName: string | null; text: string;
  status: MessageStatus; itemId: string | null; createdAt: string;
  turnId: string | null; phase: MessagePhase | null; content?: MessageContent | null;
}
export type GroupRuntimePhase = 'starting' | 'judging' | 'working';
export interface GroupRuntimeMember {
  botId: string; chatId: string; phase: GroupRuntimePhase;
  enteredAt: string; activityKind: ActivityKind | null; activityUpdatedAt: string | null;
}
export interface GroupRuntimeState {
  groupId: string; runId: string; members: GroupRuntimeMember[];
}
export type RoutineStatus = 'active' | 'paused';
export type RoutineKind = 'recurring' | 'once';
export type RoutineExecutionMode = 'chat' | 'script' | 'hybrid';
export type RoutineFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly';
export type RoutineRunStatus =
  | 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'needs_user' | 'skipped' | 'missed';
export interface RoutineDefinition {
  instruction: string;
  execution: {
    mode: RoutineExecutionMode;
    /** Optional instruction for preparing or running a deterministic script-backed task. */
    template?: string;
  };
  /** Human-readable schedule shown in the UI. */
  schedule: string;
  kind: RoutineKind;
  timezone: string;
  frequency: RoutineFrequency | null;
  weekday: number | null;
  dayOfMonth: number | null;
  /** Ordered, de-duplicated local trigger times for recurring routines. */
  times: string[];
  time: string;
  runAt: string | null;
  catchUp: boolean;
  rememberLastResult: boolean;
  successNotification: boolean;
}
export interface RoutineListItem {
  id: string; title: string; botId: string; sourceChatId: string;
  definition: RoutineDefinition; status: RoutineStatus; nextRunAt: string | null;
  lastRun: RoutineRun | null; createdAt: string; updatedAt: string;
  /** Why an otherwise stored definition cannot be scheduled. */
  statusReason?: string;
}
export interface RoutineRun {
  id: string; routineId: string; botId: string; routineTitle: string; instruction: string;
  /** Immutable definition captured when this occurrence was claimed. */
  definition: RoutineDefinition;
  /** Stable version of the captured definition, used to tell edited plans apart. */
  definitionVersion: string;
  scheduledFor: string; status: RoutineRunStatus; trigger: 'schedule' | 'catchUp' | 'manual' | 'skip';
  /** Hidden chat/thread used for this run's independent Codex context. */
  chatId: string | null;
  /** User-visible chat that receives only the short completion brief. */
  sourceChatId: string | null;
  turnId: string | null; summary: string | null; error: string | null; process: string | null;
  startedAt: string | null; completedAt: string | null; createdAt: string;
  /** Number of automatic post-restart recoveries already claimed for this run. */
  recoveryCount: number;
  needsUserReason: string | null;
}
export interface Message {
  id: string; chatId: string; role: 'user' | 'assistant' | 'system'; text: string;
  status: MessageStatus; itemId: string | null; createdAt: string;
  dispatchStatus?: TurnDispatchStatus | null; dispatchError?: string | null;
  /** Codex turn that produced this assistant message; null for legacy and user/system rows. */
  turnId: string | null;
  /** Null preserves compatibility for providers that do not classify assistant text. */
  phase: MessagePhase | null;
  /** Voice transcript rows are replaced by a formal reply from the same live request. */
  source: MessageSource;
  /** Structured chat content emitted by Rambo tools; older rows remain plain Markdown. */
  content?: MessageContent | null;
}
export interface MessageOption { label: string; value?: string; description?: string }
export interface MessageFormField {
  name: string; label: string;
  type: 'text' | 'textarea' | 'email' | 'number' | 'date' | 'select' | 'checkbox';
  placeholder?: string; required?: boolean; options?: string[];
}
export interface QuestionMessageContent {
  kind: 'question'; prompt: string; options: MessageOption[]; allowMultiple: boolean; allowCustom: boolean;
  customPlaceholder?: string; state: 'pending' | 'answered'; answer?: string;
}
export interface ResultCardMessageContent {
  kind: 'card';
  template: 'generic' | 'weather' | 'shopping' | 'form' | 'approval' | 'connector' | 'email' | 'calendar';
  title: string; subtitle?: string; summary?: string;
  fields?: Array<{ label: string; value: string }>;
  sections?: Array<{ title?: string; body: string }>;
  items?: Array<{ title: string; description?: string; metadata?: string; imageUrl?: string }>;
  actions?: MessageOption[]; formFields?: MessageFormField[];
  state?: 'pending' | 'answered'; answer?: string;
}
export interface MediaMessageContent {
  kind: 'media'; mediaType: 'image' | 'video' | 'audio' | 'file'; url: string;
  title?: string; alt?: string; caption?: string; mimeType?: string;
  /** Host-managed imageGeneration result; render it after the assistant's text. */
  generated?: boolean;
}
export interface VoiceMessageContent {
  kind: 'voice'; transcript: string; audioUrl?: string; speaker?: string; durationSeconds?: number;
}
export interface McpEmbedMessageContent {
  kind: 'mcp_embed'; appName: string; title?: string; description?: string; url: string;
}
export interface VisualizationMessageContent {
  kind: 'visualization'; chartType: 'bar' | 'line' | 'pie' | 'table'; title?: string;
  labels: string[]; series: Array<{ name: string; values: number[] }>; unit?: string;
}
export type MessageContent =
  | QuestionMessageContent | ResultCardMessageContent | MediaMessageContent
  | VoiceMessageContent | McpEmbedMessageContent | VisualizationMessageContent;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isOptionalText = (value: unknown): boolean => value === undefined || isText(value);
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isOption = (value: unknown): value is MessageOption => isRecord(value) &&
  isText(value.label) && isOptionalText(value.value) && isOptionalText(value.description);
const isFormField = (value: unknown): value is MessageFormField => isRecord(value) &&
  isText(value.name) && isText(value.label) &&
  ['text', 'textarea', 'email', 'number', 'date', 'select', 'checkbox'].includes(String(value.type)) &&
  isOptionalText(value.placeholder) && (value.required === undefined || typeof value.required === 'boolean') &&
  (value.options === undefined || isTextList(value.options));
const isVisualizationSeries = (value: unknown): value is { name: string; values: number[] } => isRecord(value) &&
  isText(value.name) && Array.isArray(value.values) && value.values.every(isFiniteNumber);

export function isMessageContent(value: unknown): value is MessageContent {
  if (!isRecord(value) || !isText(value.kind)) return false;
  if (value.kind === 'question') {
    return isText(value.prompt) && Array.isArray(value.options) && value.options.every(isOption) &&
      typeof value.allowMultiple === 'boolean' && typeof value.allowCustom === 'boolean' &&
      isOptionalText(value.customPlaceholder) && (value.state === 'pending' || value.state === 'answered') &&
      isOptionalText(value.answer);
  }
  if (value.kind === 'card') {
    return ['generic', 'weather', 'shopping', 'form', 'approval', 'connector', 'email', 'calendar'].includes(String(value.template)) &&
      isText(value.title) && isOptionalText(value.subtitle) && isOptionalText(value.summary) &&
      (value.fields === undefined || (Array.isArray(value.fields) && value.fields.every(item =>
        isRecord(item) && isText(item.label) && isText(item.value)))) &&
      (value.sections === undefined || (Array.isArray(value.sections) && value.sections.every(item =>
        isRecord(item) && isOptionalText(item.title) && isText(item.body)))) &&
      (value.items === undefined || (Array.isArray(value.items) && value.items.every(item =>
        isRecord(item) && isText(item.title) && isOptionalText(item.description) &&
        isOptionalText(item.metadata) && isOptionalText(item.imageUrl)))) &&
      (value.actions === undefined || (Array.isArray(value.actions) && value.actions.every(isOption))) &&
      (value.formFields === undefined || (Array.isArray(value.formFields) && value.formFields.every(isFormField))) &&
      (value.state === undefined || value.state === 'pending' || value.state === 'answered') &&
      isOptionalText(value.answer);
  }
  if (value.kind === 'media') {
    return ['image', 'video', 'audio', 'file'].includes(String(value.mediaType)) && isText(value.url) &&
      isOptionalText(value.title) && isOptionalText(value.alt) && isOptionalText(value.caption) &&
      isOptionalText(value.mimeType) && (value.generated === undefined || typeof value.generated === 'boolean');
  }
  if (value.kind === 'voice') {
    return isText(value.transcript) && isOptionalText(value.audioUrl) && isOptionalText(value.speaker) &&
      (value.durationSeconds === undefined || isFiniteNumber(value.durationSeconds));
  }
  if (value.kind === 'mcp_embed') {
    return isText(value.appName) && isText(value.url) && isOptionalText(value.title) && isOptionalText(value.description);
  }
  if (value.kind === 'visualization') {
    return ['bar', 'line', 'pie', 'table'].includes(String(value.chartType)) && isTextList(value.labels) &&
      Array.isArray(value.series) && value.series.every(isVisualizationSeries) && isOptionalText(value.title) &&
      isOptionalText(value.unit);
  }
  return false;
}
export type ActivityKind =
  | 'reasoning' | 'command' | 'file' | 'web' | 'mcp' | 'tool' | 'plan' | 'image' | 'collab' | 'other';
export type ActivityStatus = 'running' | 'complete' | 'failed' | 'declined' | 'unknown';
export interface TurnActivity {
  id: string; chatId: string; turnId: string | null; itemId: string; kind: ActivityKind;
  status: ActivityStatus; title: string; detail: string; createdAt: string; updatedAt: string;
}
export interface RuntimeProgress {
  phase: 'downloading';
  downloadedBytes: number;
  totalBytes: number | null;
}
export type RuntimeSource = 'cache' | 'packaged';
export interface RuntimeState {
  status: 'stopped' | 'starting' | 'ready' | 'error';
  version: string;
  source?: RuntimeSource | null;
  error: string | null;
  progress?: RuntimeProgress | null;
}
export interface RuntimeUpdateResult {
  status: 'updated' | 'up-to-date';
  previousVersion: string;
  version: string;
  source: RuntimeSource;
}
export type CodexHomeSyncMode = 'follow' | 'independent';
export interface CodexHomeSyncState {
  mode: CodexHomeSyncMode;
  sourceDetected: boolean;
  sourcePath: string | null;
  lastSyncedAt: string | null;
  pending: boolean;
  syncing: boolean;
  decisionRequired: boolean;
  warning: string | null;
  error: string | null;
}
export interface ModelOption { id: string; label: string; isDefault: boolean }
export interface ManualApiConfig {
  serviceName: string;
  baseUrl: string;
  model: string;
}
export interface ManualApiSaveInput extends ManualApiConfig {
  apiKey?: string;
  /** Checked model tags that form the global model pool for manual API mode. */
  models: ModelOption[];
}
export interface ModelSourceState {
  kind: ModelSourceKind;
  manual: ManualApiConfig;
  /** Persisted manual API model pool, retained while another source is active. */
  models: ModelOption[];
  /** Whether an encrypted API key is already available for the manual source. */
  hasApiKey: boolean;
}
export interface RefreshedBotModel {
  id: string;
  name: string;
  previousModel: string;
  model: string;
}
export interface ModelCatalogRefresh {
  models: ModelOption[];
  defaultModel: string;
  refreshedBots: RefreshedBotModel[];
}
export interface ModelSourceChangeResult extends ModelSourceState {
  /** Null while ChatGPT login is still required before the model catalog can be read. */
  catalogRefresh: ModelCatalogRefresh | null;
}
export interface CodexHomeSyncChangeResult extends CodexHomeSyncState {
  catalogRefresh: ModelCatalogRefresh | null;
}
export interface ModelConnectionTestResult {
  ok: boolean;
  source: ModelSourceKind;
  latencyMs: number;
  message: string;
  testedAt: string;
  /** True when the tested source is not yet the persisted active source. */
  sourcePending?: boolean;
  /** True when the runtime was already loaded and the local config may have changed on disk. */
  configMayBeStale?: boolean;
}
export type VoiceState = 'connecting' | 'live' | 'stopping' | 'error';
export interface VoiceSessionState { chatId: string; state: VoiceState; realtimeSessionId: string | null; error: string | null }
export interface VoiceTranscript { chatId: string; role: 'user' | 'assistant'; text: string; itemId: string | null; done: boolean }
export interface VoiceAudioChunk {
  /** Base64-encoded signed 16-bit little-endian PCM. */
  data: string;
  sampleRate: number;
  numChannels: number;
}
export interface AccountState {
  type: string | null;
  email: string | null;
  requiresLogin: boolean;
  /** True when the persisted Codex auth file indicates a login, even if online status is unavailable. */
  localLoginDetected?: boolean;
  /** Online account lookup failure. Local auth may still be usable. */
  statusError?: string | null;
}
export interface AccountLoginStart {
  authUrl: string;
  loginId: string | null;
  browserOpened?: boolean;
  browserOpenError?: string | null;
}
export interface PlaywrightVerificationResult { verifiedAt: string }
export interface Memory { id: string; botId: string | null; text: string; approved: boolean; createdAt: string }
export type TurnModelSource = 'chat' | 'bot' | 'global' | 'unknown';
export type TurnResolutionSource = 'modelRerouted' | 'unknown';
export type ThreadModelSource = 'threadStartResponse' | 'threadResumeResponse' | 'unknown';
export type TurnStatus = 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export interface TurnReroute { fromModel: string; toModel: string; reason: string; receivedAt: string }
export type TurnSandboxPolicy =
  | { type: 'dangerFullAccess' } | { type: 'readOnly' }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean };
export interface TurnPermissionSnapshot {
  permission: PermissionMode; approvalPolicy: 'never' | 'on-request'; sandboxPolicy: TurnSandboxPolicy;
}
/** Per-turn request metadata and protocol-confirmed model evidence. Null resolution means unknown. */
export interface TurnRecord {
  id: string; turnId: string | null; threadId: string; chatId: string;
  userMessageId: string | null; dispatchStatus: TurnDispatchStatus; dispatchError: string | null;
  requestedModel: string | null; modelSource: TurnModelSource;
  /** Last thread-level model response observed before this request; not per-turn execution proof. */
  threadModelAtRequest: string | null; threadModelProviderAtRequest: string | null;
  threadModelSource: ThreadModelSource; threadModelObservedAt: string | null;
  serverResolvedModel: string | null; serverResolvedProvider: string | null;
  resolutionSource: TurnResolutionSource; reroutes: TurnReroute[];
  permissionSnapshot: TurnPermissionSnapshot; status: TurnStatus;
  startedAt: string; completedAt: string | null;
}
export interface Snapshot {
  /** Dedicated Codex home used by the Rambo-owned App Server process. */
  codexHome: string;
  /** Independent Codex Home copy/follow state. */
  codexHomeSync: CodexHomeSyncState;
  /** Manual proxy applied to the Rambo-owned Codex App Server process. */
  runtimeProxy: string;
  /** Application-level model service selection. It never contains secrets. */
  modelSource: ModelSourceState;
  bots: Bot[]; chats: Chat[]; groups: GroupChat[]; archivedGroups: GroupChat[];
  routines: RoutineListItem[]; routineRuns: RoutineRun[]; runtime: RuntimeState;
  connectorProviders: ConnectorProvider[]; connections: ConnectorConnection[]; connectorGrants: ConnectorGrant[];
  botResources: BotResource[]; globalResourceIds: string[]; globalDefaultResourceIds: string[];
  directMcpServers: DirectMcpServer[];
  activeTurns: Record<string, string>;
  /** Private or group-member chats whose user message is committed and whose turn start is still pending. */
  startingTurns: Record<string, boolean>;
  /** Counts behind hasPendingWork, used for accurate UI copy and diagnostics. */
  pendingWork: {
    activeTurns: number;
    startingTurns: number;
    busyChats: number;
    busyGroups: number;
    unknownOperations: number;
    voiceSessions: number;
  };
  /** True while a turn is starting/running or another in-process task operation is unsettled. */
  hasPendingWork: boolean;
  /** Transient per-group member activity for the current process. */
  groupRuntimes: Record<string, GroupRuntimeState>;
  settings: Record<string, string>;
  /** Readiness of the persisted global execution defaults used when creating Bots. */
  executionDefaults: {
    ready: boolean;
    model: string;
    permission: PermissionMode | null;
    error: string | null;
  };
  /** Latest visible private-chat message per chat, used by the sidebar preview. */
  recentMessages: Record<string, string>;
  /** Number of unread user-visible Bot messages per private chat. */
  unreadCounts: Record<string, number>;
  /** Runtime desktop notification support/permission state and acceptance-only notification evidence. */
  notifications: {
    runtimeState: 'unknown' | 'not-determined' | 'denied' | 'authorized' | 'provisional';
    unavailableMessage: string | null;
    recentBotReplies: Array<{
      chatId: string;
      botId: string;
      preview: string;
      notificationId: string;
      decision: 'enabled' | 'disabled' | 'visible' | 'ineligible';
      createdAt: string;
    }>;
  };
}
export type AppEvent =
  | { type: 'changed' }
  | { type: 'connectorAuthProgress'; connectionId: string; phase: string; message: string; canFinishCapture?: boolean; canContinueCapture?: boolean }
  | { type: 'playwrightVerificationProgress'; phase: string; message: string }
  | { type: 'runtime'; state: RuntimeState }
  | { type: 'codexHomeSync'; state: CodexHomeSyncState }
  | { type: 'message'; message: Message }
  | { type: 'botReplyNotification'; chatId: string; botId: string; preview: string; notificationId?: string; visibleAndFocused?: boolean }
  | { type: 'routineRunFinished'; runId: string }
  | { type: 'routineResultDeliveryStarted'; runId: string; chatId: string }
  | { type: 'routineResultDeliveryFinished'; runId: string; chatId: string }
  | { type: 'messageRemoved'; chatId: string; messageId: string }
  | { type: 'activity'; activity: TurnActivity }
  | { type: 'groupRuntime'; groupId: string; runtime: GroupRuntimeState | null }
  | { type: 'groupMessage'; groupId: string; message: GroupMessage }
  | { type: 'groupMessageRemoved'; groupId: string; messageId: string }
  | { type: 'turn'; chatId: string; turnId: string | null }
  | { type: 'startingTurn'; chatId: string; starting: boolean }
  | { type: 'turnMetadata'; chatId: string; turnId: string | null }
  | { type: 'voiceState'; session: VoiceSessionState }
  | { type: 'voiceStopFinished'; chatId: string; error: string | null }
  | { type: 'voiceSdp'; chatId: string; sdp: string }
  | { type: 'voiceAudio'; chatId: string; audio: VoiceAudioChunk }
  | { type: 'voiceTranscript'; transcript: VoiceTranscript }
  | { type: 'voiceEndRequested'; chatId: string; reason: string }
  | { type: 'mcpElicitation'; prompt: McpElicitationPrompt }
  | { type: 'mcpElicitationResolved'; requestId: string }
  | { type: 'secretCapture'; prompt: SecretCapturePrompt }
  | { type: 'secretCaptureResolved'; requestId: string }
  | { type: 'focusBot'; botId: string }
  | { type: 'groupCreated'; group: GroupChat }
  | { type: 'error'; chatId?: string; message: string };
export interface ComposerAttachment {
  path: string;
  name: string;
  kind: 'image' | 'file';
  previewUrl: string | null;
}

export interface ComposerAttachmentCleanupResult {
  deletedPaths: string[];
  draftProtectedPaths: string[];
  referencedPaths: string[];
  errors: Array<{ path: string; message: string }>;
}

export interface RamboAPI {
  /** Synchronous desktop platform for platform-specific labels and layout. */
  platform: DesktopPlatform;
  pathForFile(file: File): string;
  appVersion(): Promise<string>;
  snapshot(): Promise<Snapshot>;
  selectLocalFiles(): Promise<string[]>;
  registerLocalAttachments(paths: string[]): Promise<ComposerAttachment[]>;
  savePastedImage(dataUrl: string): Promise<ComposerAttachment>;
  setComposerDraftAttachments(ownerId: string, paths: string[]): Promise<void>;
  releaseComposerDraftAttachments(ownerId: string): Promise<void>;
  runComposerAttachmentCleanupForAcceptance(): Promise<ComposerAttachmentCleanupResult>;
  setVisibleChat(chatId: string | null): Promise<string | null>;
  setVisibleChatFocus(focused: boolean): Promise<void>;
  botResources(refresh?: boolean): Promise<{ resources: BotResource[]; errors: string[] }>;
  setDirectMcpEnabled(id: string, enabled: boolean): Promise<DirectMcpServer>;
  deleteDirectMcp(id: string): Promise<void>;
  setGlobalResource(resourceId: string, included: boolean): Promise<{ globalResourceIds: string[]; globalDefaultResourceIds: string[] }>;
  setGlobalDefaultResource(resourceId: string, enabled: boolean): Promise<{ globalResourceIds: string[]; globalDefaultResourceIds: string[] }>;
  setBotResource(botId: string, resourceId: string, enabled: boolean): Promise<Bot>;
  respondMcpElicitation(requestId: string, action: McpElicitationAction): Promise<void>;
  verifyPlaywrightConnection(): Promise<PlaywrightVerificationResult>;
  cancelPlaywrightVerification(): Promise<void>;
  completeSecretCapture(requestId: string, secret: string): Promise<void>;
  cancelSecretCapture(requestId: string): Promise<void>;
  connectorProviders(): Promise<ConnectorProvider[]>;
  beginConnectorAuth(providerId: string, displayName?: string): Promise<ConnectorAuthStartResult>;
  openConnectorAuth(challenge: ConnectorAuthChallenge): Promise<ConnectorConnection>;
  finishWechatCapture(challenge: ConnectorAuthChallenge): Promise<boolean>;
  continueWechatCapture(challenge: ConnectorAuthChallenge): Promise<boolean>;
  cancelConnectorAuth(challenge: ConnectorAuthChallenge): Promise<void>;
  completeConnectorAuth(input: ConnectorCredentialInput): Promise<ConnectorConnection>;
  setConnectionStatus(id: string, status: ConnectionStatus): Promise<ConnectorConnection>;
  removeConnection(id: string): Promise<void>;
  setConnectorGrant(botId: string, connectionId: string, granted: boolean): Promise<ConnectorGrant[]>;
  createBot(input: { name: string; avatar: string }): Promise<{ bot: Bot; chat: Chat }>;
  copyBot(id: string): Promise<{ bot: Bot; chat: Chat }>;
  updateBot(id: string, patch: Partial<Pick<Bot, 'name' | 'avatar' | 'role' | 'instructions' | 'notificationsEnabled'>>): Promise<Bot>;
  updateBotExecutionConfig(id: string, patch: { model: string; permission: PermissionMode }): Promise<Bot>;
  setBotArchived(id: string, archived: boolean): Promise<Bot>;
  setBotPinned(id: string, pinned: boolean): Promise<Bot>;
  deleteBot(id: string): Promise<void>;
  ensureBotChat(botId: string): Promise<Chat>;
  createGroup(input: { title: string; purpose: string; botIds: string[] }): Promise<GroupChat>;
  updateGroupPurpose(groupId: string, purpose: string): Promise<GroupChat>;
  addGroupMembers(groupId: string, botIds: string[]): Promise<GroupChat>;
  removeGroupMembers(groupId: string, botIds: string[]): Promise<GroupChat>;
  setGroupArchived(groupId: string, archived: boolean): Promise<GroupChat>;
  setGroupPinned(groupId: string, pinned: boolean): Promise<GroupChat>;
  deleteGroup(groupId: string): Promise<void>;
  groupMemberChats(groupId: string): Promise<Chat[]>;
  groupMessages(groupId: string): Promise<GroupMessage[]>;
  sendGroup(groupId: string, text: string): Promise<void>;
  interruptGroup(groupId: string): Promise<void>;
  markChatRead(id: string): Promise<void>;
  setRoutineStatus(id: string, status: RoutineStatus): Promise<RoutineListItem>;
  advanceRoutineScheduleForAcceptance(id: string): Promise<void>;
  runRoutineNow(id: string): Promise<RoutineRun>;
  stopRoutineRun(id: string): Promise<RoutineRun>;
  messages(chatId: string): Promise<Message[]>;
  copyText(text: string): Promise<void>;
  answerCard(messageId: string, answer: string): Promise<void>;
  resolveMessageAsset(messageId: string, source: string): Promise<string | null>;
  openMessageAsset(messageId: string, source: string): Promise<void>;
  revealMessageAsset(messageId: string, source: string): Promise<void>;
  saveMessageAsset(messageId: string, source: string, fileName: string): Promise<string | null>;
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
  login(): Promise<AccountLoginStart>;
  models(): Promise<ModelOption[]>;
  manualModels(input: Pick<ManualApiConfig, 'serviceName' | 'baseUrl'> & {
    apiKey?: string;
  }): Promise<ModelOption[]>;
  setModelSource(kind: ModelSourceKind): Promise<ModelSourceChangeResult>;
  saveManualModelSource(input: ManualApiSaveInput): Promise<ModelSourceChangeResult>;
  syncModelCatalogForCurrentSource(): Promise<ModelCatalogRefresh>;
  testModelConnection(source?: ModelSourceKind): Promise<ModelConnectionTestResult>;
  setCodexHomeSyncMode(mode: CodexHomeSyncMode): Promise<CodexHomeSyncChangeResult>;
  startVoice(chatId: string, offerSdp: string): Promise<{ chatId: string; threadId: string }>;
  stopVoice(chatId: string, reason?: string): Promise<void>;
  restartRuntime(): Promise<void>;
  updateRuntime(): Promise<RuntimeUpdateResult>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global { interface Window { rambo: RamboAPI } }
