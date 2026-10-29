import type {
  AccountState,
  CodexHomeSyncMode,
  ModelSourceKind,
  ModelSourceState
} from './contracts';

export type AccountSourceStatus = 'checking' | 'ready' | 'unavailable';

export interface AccountSettingsInput {
  syncMode: CodexHomeSyncMode;
  sourceDetected: boolean;
  modelSource: ModelSourceState;
  account: AccountState | null;
  accountLoading: boolean;
  accountError: string | null;
}

export interface AccountSettingsState {
  /** Follow is unavailable without a native Codex Home, so the effective mode falls back to independent. */
  effectiveMode: CodexHomeSyncMode;
  followAvailable: boolean;
  followUnavailableReason: string | null;
  activeSource: ModelSourceKind;
  activeSourceStatus: AccountSourceStatus;
  localCopyStatus: AccountSourceStatus;
  chatgptStatus: AccountSourceStatus;
  manualApiStatus: AccountSourceStatus;
  anySourceReady: boolean;
  /** The independent page only shows the direct login/API entry when every source is unusable. */
  showConfigurationEntry: boolean;
  /** Account identity is only meaningful for the local copy or a ChatGPT source. */
  showAccountStatus: boolean;
}

const SOURCE_LABELS: Record<ModelSourceKind, string> = {
  local: '本机 Codex 配置副本',
  chatgpt: 'ChatGPT 登录',
  manualApi: '手动配置 API'
};

export function accountSourceLabel(source: ModelSourceKind): string {
  return SOURCE_LABELS[source];
}

function accountStatus(
  account: AccountState | null,
  loading: boolean,
  error: string | null
): AccountSourceStatus {
  if (loading) return 'checking';
  if (error) return 'unavailable';
  return account && (!account.requiresLogin || account.localLoginDetected)
    ? 'ready'
    : 'unavailable';
}

function manualApiReady(modelSource: ModelSourceState): boolean {
  return Boolean(
    modelSource.manual.baseUrl.trim() &&
    modelSource.manual.model.trim() &&
    modelSource.hasApiKey
  );
}

export function deriveAccountSettingsState(
  input: AccountSettingsInput
): AccountSettingsState {
  const followAvailable = input.sourceDetected;
  const effectiveMode: CodexHomeSyncMode = followAvailable
    ? input.syncMode
    : 'independent';
  const localCopyStatus = accountStatus(input.account, input.accountLoading, input.accountError);
  const chatgptStatus = accountStatus(input.account, input.accountLoading, input.accountError);
  const manualApiStatus: AccountSourceStatus = manualApiReady(input.modelSource)
    ? 'ready'
    : 'unavailable';
  const activeSource: ModelSourceKind = effectiveMode === 'follow'
    ? 'local'
    : input.modelSource.kind;
  const sourceStatuses: Record<ModelSourceKind, AccountSourceStatus> = {
    local: localCopyStatus,
    chatgpt: chatgptStatus,
    manualApi: manualApiStatus
  };
  const anySourceReady = Object.values(sourceStatuses).some(status => status === 'ready');
  const showConfigurationEntry =
    effectiveMode === 'independent' &&
    !anySourceReady &&
    !input.accountLoading;

  return {
    effectiveMode,
    followAvailable,
    followUnavailableReason: followAvailable ? null : '未检测到本机 Codex',
    activeSource,
    activeSourceStatus: sourceStatuses[activeSource],
    localCopyStatus,
    chatgptStatus,
    manualApiStatus,
    anySourceReady,
    showConfigurationEntry,
    showAccountStatus: activeSource === 'local' || activeSource === 'chatgpt'
  };
}
