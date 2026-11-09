import type {
  AccountState,
  ModelSourceKind,
  ModelSourceState
} from './contracts';

export type AccountSourceStatus = 'checking' | 'ready' | 'unavailable';

export interface AccountSettingsInput {
  localCopyAvailable: boolean;
  modelSource: ModelSourceState;
  account: AccountState | null;
  accountLoading: boolean;
  accountError: string | null;
}

export interface AccountSettingsState {
  activeSourceStatus: AccountSourceStatus;
  localCopyStatus: AccountSourceStatus;
  chatgptStatus: AccountSourceStatus;
  manualApiStatus: AccountSourceStatus;
  anySourceReady: boolean;
  /** The independent page only shows the direct login/API entry when every source is unusable. */
  showConfigurationEntry: boolean;
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
    modelSource.hasApiKey &&
    modelSource.models.some(model => model.id === modelSource.manual.model)
  );
}

export function deriveAccountSettingsState(
  input: AccountSettingsInput
): AccountSettingsState {
  const localCopyStatus = input.modelSource.kind === 'local' &&
    input.modelSource.standardProviderConfigured
    ? 'ready'
    : accountStatus(input.account, input.accountLoading, input.accountError);
  const chatgptStatus = accountStatus(input.account, input.accountLoading, input.accountError);
  const manualApiStatus: AccountSourceStatus = manualApiReady(input.modelSource)
    ? 'ready'
    : 'unavailable';
  const anySourceReady =
    (input.localCopyAvailable && localCopyStatus === 'ready') ||
    chatgptStatus === 'ready' ||
    manualApiStatus === 'ready';
  const showConfigurationEntry = !anySourceReady && !input.accountLoading;

  return {
    activeSourceStatus: input.modelSource.kind === 'local'
      ? localCopyStatus
      : input.modelSource.kind === 'chatgpt'
        ? chatgptStatus
        : manualApiStatus,
    localCopyStatus,
    chatgptStatus,
    manualApiStatus,
    anySourceReady,
    showConfigurationEntry
  };
}
