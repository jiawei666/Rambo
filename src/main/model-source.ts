import type {
  ManualApiConfig,
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
  return {
    kind: modelSourceKindFrom(settings.modelSource),
    manual: manualApiConfigFrom({
      serviceName: settings.manualModelServiceName,
      baseUrl: settings.manualModelBaseUrl,
      model: settings.manualModelId
    }),
    hasApiKey
  };
}

export function needsInitialSetup(
  snapshot: Pick<ModelSourceState, 'kind' | 'manual' | 'hasApiKey'> & {
    runtimeReady: boolean;
    executionDefaultsReady: boolean;
  }
): boolean {
  if (snapshot.runtimeReady) return false;
  if (snapshot.kind === 'manualApi') {
    return !(snapshot.manual.baseUrl && snapshot.manual.model && snapshot.hasApiKey);
  }
  return snapshot.kind !== 'chatgpt' && !snapshot.executionDefaultsReady;
}

export function manualModelSourceAvailable(state: ModelSourceState): boolean {
  return Boolean(state.manual.baseUrl && state.manual.model && state.hasApiKey);
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
