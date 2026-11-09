import type { ModelSourceState } from './contracts';

export const VOICE_MODEL_UNSUPPORTED_PREFIX = '语音模型不支持：';

type VoiceModelSource = Pick<
  ModelSourceState,
  'kind' | 'manual' | 'standardProviderConfigured'
>;

function isOpenAiRealtimeBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

export function voiceModelPreflightError(source: VoiceModelSource): string | null {
  if (source.kind === 'local' && source.standardProviderConfigured) {
    return `${VOICE_MODEL_UNSUPPORTED_PREFIX}当前标准外部 Provider 未声明 Codex Live 所需的实时语音通道。请在“设置 → 模型配置”切换为 ChatGPT 登录或 OpenAI 官方 API 后再试。`;
  }
  if (source.kind !== 'manualApi' || isOpenAiRealtimeBaseUrl(source.manual.baseUrl)) return null;
  const service = source.manual.serviceName.trim() || '当前手动 API';
  return `${VOICE_MODEL_UNSUPPORTED_PREFIX}“${service}”未提供 Codex Live 所需的实时语音通道。请在“设置 → 账号 → 模型配置”切换为 ChatGPT 登录后再试。`;
}
