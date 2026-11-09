import type { RuntimeModelConfigurationDetails } from '../shared/contracts';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeBaseUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/u, '');
  } catch {
    return null;
  }
}

function hasTokens(auth: Record<string, unknown> | null): boolean {
  const tokens = record(auth?.tokens);
  return Boolean(tokens && Object.values(tokens).some(value =>
    typeof value === 'string' && value.trim()));
}

function hasCommandCredential(provider: Record<string, unknown> | null): boolean {
  const providerAuth = record(provider?.auth);
  return Boolean(text(providerAuth?.command));
}

export function runtimeModelConfigurationDetails(
  configValue: unknown,
  authValue: unknown,
  environment: NodeJS.ProcessEnv = process.env
): RuntimeModelConfigurationDetails {
  const config = record(configValue);
  const providerId = text(config?.model_provider);
  const providers = record(config?.model_providers);
  const provider = providerId ? record(providers?.[providerId]) : null;
  const baseUrl = safeBaseUrl(provider?.base_url);
  const configuredServiceName = text(provider?.name);
  const wireApi = text(provider?.wire_api);
  const auth = record(authValue);
  const authMode = text(auth?.auth_mode)?.toLocaleLowerCase() ?? '';
  const apiKeyPresent = Boolean(text(auth?.OPENAI_API_KEY));
  const chatgptAuthPresent = authMode === 'chatgpt' || hasTokens(auth);
  const envKey = text(provider?.env_key);
  const environmentKeyPresent = Boolean(envKey && text(environment[envKey]));
  const configuredApiKey = apiKeyPresent || environmentKeyPresent ||
    authMode === 'api_key' || authMode === 'apikey';
  const credentialConfigured = apiKeyPresent || environmentKeyPresent ||
    chatgptAuthPresent || hasCommandCredential(provider);

  let accessMethod: RuntimeModelConfigurationDetails['accessMethod'] = 'unknown';
  if (providerId || baseUrl) {
    accessMethod = baseUrl || (providerId && providerId !== 'openai')
      ? 'modelProvider'
      : chatgptAuthPresent
        ? 'chatgptLogin'
        : configuredApiKey ? 'apiKey' : 'unknown';
  } else if (chatgptAuthPresent) {
    accessMethod = 'chatgptLogin';
  } else if (configuredApiKey) {
    accessMethod = 'apiKey';
  }

  const serviceName = configuredServiceName ?? (accessMethod === 'chatgptLogin'
    ? 'ChatGPT'
    : providerId === 'openai' ? 'OpenAI' : providerId);

  return {
    accessMethod,
    providerId,
    serviceName: serviceName ?? (accessMethod === 'apiKey' ? 'OpenAI API' : null),
    baseUrl,
    wireApi,
    credentialConfigured: credentialConfigured ? true : null
  };
}
