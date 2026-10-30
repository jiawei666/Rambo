import type {
  ManualApiConfig,
  ModelOption,
  ModelSourceKind,
  ModelSourceState
} from '../shared/contracts';

const MODEL_SOURCE_KINDS = new Set<ModelSourceKind>(['local', 'chatgpt', 'manualApi']);

export function modelSourceKindFrom(value: unknown): ModelSourceKind {
  const source = typeof value === 'string' ? value.trim() : '';
  return MODEL_SOURCE_KINDS.has(source as ModelSourceKind)
    ? source as ModelSourceKind
    : 'local';
}

export function manualApiConfigFrom(value: {
  serviceName?: string;
  baseUrl?: string;
  model?: string;
}): ManualApiConfig {
  return {
    serviceName: boundedText(value.serviceName, 80, '服务名称'),
    baseUrl: normalizeBaseUrl(boundedText(value.baseUrl, 2_000, 'Base URL')),
    model: boundedText(value.model, 500, '模型 ID')
  };
}

export function validateManualApiConfig(
  input: ManualApiConfig,
  requireComplete = true
): ManualApiConfig {
  const config = manualApiConfigFrom(input);
  if (requireComplete) {
    if (!config.baseUrl) throw new Error('请填写手动 API 的 Base URL');
    if (!config.model) throw new Error('请填写手动 API 的模型 ID');
  }
  return config;
}

export function modelSourceStateFrom(
  settings: Record<string, string>,
  hasApiKey: boolean
): ModelSourceState {
  const kind = modelSourceKindFrom(settings.modelSource);
  const manual = manualApiConfigFrom({
    serviceName: settings.manualModelServiceName,
    baseUrl: settings.manualModelBaseUrl,
    model: settings.manualModelId
  });
  const catalogSetting = settings.manualModelCatalog?.trim()
    ? settings.manualModelCatalog
    : kind === 'manualApi'
      ? settings.defaultBotModels
      : '';
  const models = modelOptionsFromSetting(catalogSetting)
    .map(option => ({
      ...option,
      isDefault: option.id === manual.model
    }));
  return {
    kind,
    manual,
    models,
    hasApiKey
  };
}

export function needsInitialSetup(
  snapshot: Pick<ModelSourceState, 'kind' | 'manual' | 'hasApiKey'> & {
    runtimeReady: boolean;
    executionDefaultsReady: boolean;
    accountReady?: boolean | null;
  }
): boolean {
  if (!snapshot.runtimeReady) return true;
  if (snapshot.kind === 'manualApi') {
    return !(snapshot.manual.baseUrl && snapshot.manual.model && snapshot.hasApiKey);
  }
  if (snapshot.accountReady === false) return true;
  return !snapshot.executionDefaultsReady;
}

export function manualModelSourceAvailable(state: ModelSourceState): boolean {
  return Boolean(
    state.manual.baseUrl &&
    state.manual.model &&
    state.models.some(option => option.id === state.manual.model) &&
    state.hasApiKey
  );
}

export function normalizeModelOptions(value: unknown): ModelOption[] {
  const records = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as any).data)
      ? (value as any).data
      : value && typeof value === 'object' && Array.isArray((value as any).models)
        ? (value as any).models
        : null;
  if (!records) return [];

  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const record of records) {
    const id = typeof record === 'string'
      ? record.trim()
      : record && typeof record === 'object' && typeof record.id === 'string'
        ? record.id.trim()
        : '';
    if (!id || id.length > 500 || seen.has(id)) continue;
    seen.add(id);
    const label = record && typeof record === 'object'
      ? [record.display_name, record.displayName, record.name, record.label]
        .find(value => typeof value === 'string' && value.trim())
      : '';
    models.push({
      id,
      label: typeof label === 'string' ? label.trim().slice(0, 500) || id : id,
      isDefault: Boolean(record && typeof record === 'object' &&
        (record.is_default === true || record.isDefault === true || record.default === true))
    });
    if (models.length >= 1_000) break;
  }
  return models;
}

export function modelOptionsFromSetting(value: string | undefined): ModelOption[] {
  if (!value?.trim()) return [];
  try {
    return normalizeModelOptions(JSON.parse(value));
  } catch {
    return [];
  }
}

export function validateManualApiModelCatalog(
  modelsValue: unknown,
  defaultModelValue: string
): ModelOption[] {
  const defaultModel = defaultModelValue.trim();
  if (!defaultModel) throw new Error('请从全局模型池选择一个默认模型');
  const models = normalizeModelOptions(modelsValue);
  if (!models.length) throw new Error('请至少勾选一个模型后再保存');
  if (!models.some(option => option.id === defaultModel)) {
    throw new Error('默认模型必须来自已勾选的全局模型池');
  }
  return models.map(option => ({
    ...option,
    isDefault: option.id === defaultModel
  }));
}

export function manualProviderConfig(config: ManualApiConfig): {
  providerId: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
} {
  const validated = validateManualApiConfig(config);
  return {
    providerId: 'rambo_manual',
    name: validated.serviceName || '手动 API',
    baseUrl: validated.baseUrl,
    apiKeyEnv: 'RAMBO_MANUAL_API_KEY'
  };
}

export function manualProviderToml(config: ManualApiConfig): Record<string, unknown> {
  const provider = manualProviderConfig(config);
  return {
    name: provider.name,
    base_url: provider.baseUrl,
    wire_api: 'responses',
    env_key: provider.apiKeyEnv,
    requires_openai_auth: false
  };
}

export function runtimeConfigOverrides(
  kind: ModelSourceKind,
  config: ManualApiConfig
): string[] {
  if (kind !== 'manualApi') return [];
  const provider = manualProviderToml(config);
  return [
    '-c', `model_provider=${JSON.stringify('rambo_manual')}`,
    '-c', `model_providers.rambo_manual=${JSON.stringify(provider)}`
  ];
}

export type ManualApiTestOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export async function listManualApiModels(
  config: ManualApiConfig,
  apiKey: string,
  options: Pick<ManualApiTestOptions, 'fetchImpl' | 'timeoutMs'> = {}
): Promise<ModelOption[]> {
  const validated = validateManualApiConfig(config, false);
  if (!validated.baseUrl) throw new Error('请填写手动 API 的 Base URL');
  if (!apiKey.trim()) throw new Error('请先填写 API Key 再获取模型列表');

  const endpoint = `${validated.baseUrl.replace(/\/+$/u, '')}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await safeResponseError(response);
      throw new Error(`获取模型列表失败：HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    const body = await response.json().catch(() => null) as unknown;
    const records = Array.isArray(body)
      ? body
      : body && typeof body === 'object' && Array.isArray((body as any).data)
        ? (body as any).data
        : body && typeof body === 'object' && Array.isArray((body as any).models)
          ? (body as any).models
          : null;
    if (!records) throw new Error('模型列表接口没有返回 data 数组');
    const models = normalizeModelOptions(records);
    if (!models.length) throw new Error('模型列表为空，请确认 Base URL 与 API Key');
    return models;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('获取模型列表超时');
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

export async function testManualModelApi(
  config: ManualApiConfig,
  apiKey: string,
  options: ManualApiTestOptions = {}
): Promise<{ latencyMs: number; message: string }> {
  const validated = validateManualApiConfig(config);
  if (!apiKey.trim()) throw new Error('尚未保存手动 API 的 API Key');
  const endpoint = `${validated.baseUrl.replace(/\/+$/u, '')}/responses`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: validated.model,
        input: 'Reply with OK.',
        max_output_tokens: 8,
        stream: false
      }),
      signal: controller.signal
    });
    const latencyMs = Math.max(0, Math.round(now() - startedAt));
    if (!response.ok) {
      const detail = await safeResponseError(response);
      throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    const body = await response.json().catch(() => null) as unknown;
    if (!body || typeof body !== 'object') {
      throw new Error('接口没有返回 JSON 数据');
    }
    return {
      latencyMs,
      message: `连接成功，${validated.serviceName || '手动 API'} 已返回 Responses 响应。`
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接测试超时');
    throw new Error(
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBaseUrl(value: string): string {
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Base URL 格式无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL 必须使用 http:// 或 https://');
  }
  if (!url.hostname) throw new Error('Base URL 缺少主机名');
  if (url.username || url.password) throw new Error('Base URL 不能包含用户名或密码');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

function boundedText(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
  return text;
}

async function safeResponseError(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.replace(/\s+/gu, ' ').slice(0, 300);
  } catch {
    return '';
  }
}
