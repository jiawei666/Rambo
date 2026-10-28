import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, session, shell, Tray, utilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BOT_RESOURCE_IDS, Store } from './store';
import {
  beginConnectorAuth,
  connectorProvider,
  connectorProviders
} from './connectors';
import { ConnectorCredentials } from './connector-credentials';
import { SecureMailAdapterRegistry } from './mail-adapter';
import { MailRuntime } from './mail-runtime';
import { qqMailAdapterFactory } from './qq-mail-adapter';
import { gmailMailAdapterFactory } from './gmail-adapter';
import { gmailImapAdapterFactory } from './gmail-imap-adapter';
import { CodexRuntime } from './runtime';
import { Host } from './host';
import { assertWechatPageDatabasesReadable, SqlCipherWechatReader } from './wechat-adapter';
import { ElectronWechatWorkerTransport } from './wechat-worker-transport';
import { WechatConnectorWizard, WECHAT_CAPTURE_VERSION } from './wechat-connector-wizard';
import { WechatMediaContentProcessor } from './wechat-media-content';
import { PlaywrightExtensionVerifier } from './playwright-extension-verifier';
import { resourceIdsSetting } from './bot-resources';
import { DirectMcpRegistry } from './direct-mcp';
import { removeManagedBotDirectory } from './bot-data';
import {
  createElectronLoginItemAdapter,
  LoginItemController
} from './login-item';
import { SystemIndicators, type RunningBotIndicator } from './system-indicators';
import { cleanupComposerAttachments } from './composer-attachment-cleanup';
import {
  isMessageContent,
  type AppEvent,
  type ComposerAttachment,
  type GroupRuntimePhase,
  type McpElicitationAction,
  type MessageContent,
  type VoiceState,
  type ModelConnectionTestResult,
  type ModelSourceKind,
  type ModelSourceState
} from '../shared/contracts';
import {
  composerAttachmentKind,
  composerAttachmentName,
  parseImageDataUrl
} from '../shared/composer-attachments';
import {
  decideBotTurnFinishedNotification,
  decideRoutineFinishedNotification,
  notificationUnavailableMessage,
  type NotificationRuntimeState
} from '../shared/notifications';
import type { PermissionMode } from '../shared/contracts';
import {
  manualApiConfigFrom,
  manualModelSourceAvailable,
  manualProviderConfig,
  modelSourceKindFrom,
  modelSourceStateFrom,
  runtimeConfigOverrides,
  testManualModelApi,
  validateManualApiConfig
} from './model-source';

protocol.registerSchemesAsPrivileged([{
  scheme: 'rambo-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);
app.setName('Rambo');
// 验收模式只接受台账创建的目录；出错就拒绝启动，不能回退到日常数据。
let acceptanceRunId: string | null = null;
if (process.env.RAMBO_ACCEPTANCE_RUN) {
  const requested = resolve(process.env.RAMBO_ACCEPTANCE_RUN);
  const root = realpathSync(requested);
  if (root !== requested) throw new Error('验收目录不能包含符号链接');
  const markerPath = join(root, 'run.json');
  if (lstatSync(markerPath).isSymbolicLink()) throw new Error('验收标记不能是符号链接');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (marker.schema !== 'rambo.acceptance.run.v1' || typeof marker.runId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(marker.runId) || typeof marker.project !== 'string' ||
      join(realpathSync(marker.project), 'acceptance-runs', marker.runId) !== root) {
    throw new Error('验收目录标记无效');
  }
  for (const directory of ['profile', 'chromium']) {
    const path = join(root, directory);
    mkdirSync(path, { recursive: true });
    if (realpathSync(path) !== path) throw new Error('验收数据目录不能包含符号链接');
    app.setPath(directory === 'profile' ? 'userData' : 'sessionData', path);
  }
  acceptanceRunId = marker.runId;
}
if (process.env.RAMBO_ACCEPTANCE_CDP_PORT !== undefined) {
  if (!acceptanceRunId) throw new Error('CDP 仅允许在独立验收实例中启用');
  const port = Number(process.env.RAMBO_ACCEPTANCE_CDP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('验收 CDP 端口无效');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
}
let window: BrowserWindow | null = null;
let quitting = false;
let store: Store;
let host: Host;
let runtime: CodexRuntime;
let connectorCredentials: ConnectorCredentials;
let wechatReader: SqlCipherWechatReader | null = null;
let wechatConnectorWizard: WechatConnectorWizard | null = null;
let playwrightExtensionVerifier: PlaywrightExtensionVerifier | null = null;
const wechatAuthControllers = new Map<string, AbortController>();
let mailRuntime: MailRuntime;
let directMcpRegistry: DirectMcpRegistry;
let loginItem: LoginItemController;
let systemIndicators: SystemIndicators<Electron.NativeImage, Electron.Menu> | null = null;
let manualModelCredentials: ConnectorCredentials;
let composerAttachmentCleanupTimer: ReturnType<typeof setInterval> | null = null;
const messageAssetGrants = new Map<string, { messageId: string; source: string; expiresAt: number }>();
const composerAttachmentGrants = new Map<string, { path: string; mimeType: string; expiresAt: number }>();
const composerDraftAttachmentPaths = new Map<string, Set<string>>();
function resolvedDefaultPermission(value: string | undefined): PermissionMode {
  if (value === undefined || value === '') return 'fullAccess';
  if (value === 'fullAccess' || value === 'workspaceWrite' || value === 'readOnly') return value;
  throw new Error('新建 Bot 的全局权限配置无效，请在系统设置中重新选择一个权限。');
}

function wechatMediaToolPaths(): { ffmpegPath: string | null; silkDecoderPath: string | null } {
  const appRoot = app.getAppPath();
  const packagedMedia = join(process.resourcesPath, 'media-tools');
  const developmentMedia = join(appRoot, 'out/media-tools');
  const ffmpegCandidates = app.isPackaged
    ? [join(packagedMedia, 'ffmpeg')]
    : [join(developmentMedia, 'ffmpeg')];
  if (!app.isPackaged) {
    try {
      const require = createRequire(join(appRoot, 'package.json'));
      const installed = require('ffmpeg-static');
      if (typeof installed === 'string') ffmpegCandidates.push(installed);
    } catch { /* report a localized tool error when a video is requested */ }
  }
  const decoderCandidates = app.isPackaged
    ? [join(packagedMedia, 'rambo-wechat-silk-decoder')]
    : [
        join(developmentMedia, 'rambo-wechat-silk-decoder'),
        join(appRoot, 'native/wechat-silk-decoder/target/release/rambo-wechat-silk-decoder')
      ];
  return {
    ffmpegPath: ffmpegCandidates.find(path => existsSync(path)) ?? null,
    silkDecoderPath: decoderCandidates.find(path => existsSync(path)) ?? null
  };
}

function modelSourceState(): ModelSourceState {
  const settings = store.settings();
  const reference = settings.manualModelCredentialRef?.trim() ?? '';
  let hasApiKey = false;
  if (reference) {
    try {
      const credential = manualModelCredentials.load(reference);
      hasApiKey = credential.kind === 'model-api-key' && Boolean(credential.apiKey.trim());
    } catch {
      hasApiKey = false;
    }
  }
  return modelSourceStateFrom(settings, hasApiKey);
}

function manualModelApiKey(): string {
  const reference = store.settings().manualModelCredentialRef?.trim() ?? '';
  if (!reference) throw new Error('尚未保存手动 API 的 API Key');
  const credential = manualModelCredentials.load(reference);
  if (credential.kind !== 'model-api-key' || !credential.apiKey.trim()) {
    throw new Error('手动 API 凭证无效，请重新保存');
  }
  return credential.apiKey;
}

function applyModelSourceRuntimeConfig(): void {
  const source = modelSourceState();
  if (source.kind === 'manualApi') {
    const config = validateManualApiConfig(source.manual);
    runtime.setModelSourceConfig(runtimeConfigOverrides(source.kind, config), {
      [manualProviderConfig(config).apiKeyEnv]: manualModelApiKey()
    });
    return;
  }
  runtime.setModelSourceConfig([], {});
}

function persistModelSourceConfig(input: {
  serviceName?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): { previousKind: ModelSourceKind; previousSettings: Record<string, string> } {
  const config = validateManualApiConfig(manualApiConfigFrom({
    serviceName: typeof input.serviceName === 'string' ? input.serviceName : '',
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : '',
    model: typeof input.model === 'string' ? input.model : ''
  }));
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const settings = store.settings();
  const previousKind = modelSourceKindFrom(settings.modelSource);
  const previousSettings = {
    manualModelServiceName: settings.manualModelServiceName ?? '',
    manualModelBaseUrl: settings.manualModelBaseUrl ?? '',
    manualModelId: settings.manualModelId ?? '',
    manualModelCredentialRef: settings.manualModelCredentialRef ?? ''
  };
  const previousRef = previousSettings.manualModelCredentialRef.trim();
  if (!apiKey && !previousRef) throw new Error('请填写手动 API 的 API Key');
  let reference = previousRef;
  if (apiKey) {
    const payload = { kind: 'model-api-key' as const, providerId: manualProviderConfig(config).providerId, apiKey };
    if (previousRef) {
      try {
        manualModelCredentials.replace(previousRef, payload);
      } catch {
        reference = manualModelCredentials.save(randomUUID(), payload);
      }
    } else {
      reference = manualModelCredentials.save(randomUUID(), payload);
    }
  }
  store.setSetting('manualModelServiceName', config.serviceName);
  store.setSetting('manualModelBaseUrl', config.baseUrl);
  store.setSetting('manualModelId', config.model);
  store.setSetting('manualModelCredentialRef', reference);
  return { previousKind, previousSettings };
}

function restoreManualModelSettings(previous: Record<string, string>): void {
  store.setSetting('manualModelServiceName', previous.manualModelServiceName!);
  store.setSetting('manualModelBaseUrl', previous.manualModelBaseUrl!);
  store.setSetting('manualModelId', previous.manualModelId!);
  store.setSetting('manualModelCredentialRef', previous.manualModelCredentialRef!);
}

async function restartRuntimeForModelSource(): Promise<void> {
  if (host.activeTurns.size) throw new Error('有任务执行中，请先停止任务再切换模型来源');
  await runtime.stop();
  try {
    await runtime.start();
    await host.syncMcpMetadata();
  } catch (error) {
    await runtime.stop().catch(() => {});
    await runtime.start().catch(() => {});
    throw error;
  }
}

async function testModelConnection(
  requestedSource?: ModelSourceKind
): Promise<ModelConnectionTestResult> {
  if (requestedSource !== undefined && modelSourceKindFrom(requestedSource) !== requestedSource) {
    throw new Error('无效的模型来源');
  }
  const current = modelSourceState();
  const sourceKind = requestedSource ?? current.kind;
  const sourcePending = sourceKind !== current.kind;
  const testedAt = new Date().toISOString();
  if (sourceKind === 'manualApi') {
    const startedAt = performance.now();
    const failed = (message: string): ModelConnectionTestResult => ({
      ok: false,
      source: sourceKind,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      message,
      testedAt,
      sourcePending
    });
    try {
      const config = validateManualApiConfig(current.manual);
      const apiKey = manualModelApiKey();
      const result = await testManualModelApi(config, apiKey);
      return {
        ok: true,
        source: sourceKind,
        latencyMs: result.latencyMs,
        message: result.message,
        testedAt,
        sourcePending
      };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  }
  await runtime.start();
  const startedAt = performance.now();
  const failed = (message: string): {
    ok: false; source: ModelSourceKind; latencyMs: number; message: string;
    testedAt: string; sourcePending?: boolean; configMayBeStale?: boolean;
  } => ({
    ok: false,
    source: sourceKind,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    message,
    testedAt,
    sourcePending,
    configMayBeStale: true
  });
  try {
    if (sourceKind === 'chatgpt') {
      const account = await host.account();
      return account.requiresLogin
        ? failed('尚未登录 ChatGPT，请先完成登录')
        : {
            ok: true,
            source: sourceKind,
            latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
            message: 'ChatGPT 登录状态可用。',
            testedAt,
            sourcePending
          };
    }
    const [models, config] = await Promise.all([
      host.modelsWithoutStart(),
      runtime.request('config/read', { includeLayers: false })
    ]);
    const configuredModel = typeof config?.config?.model === 'string' ? config.config.model.trim() : '';
    if (!configuredModel && !models.length) return failed('没有读取到可用模型配置');
    return {
      ok: true,
      source: sourceKind,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      message: configuredModel
        ? `本机 Codex 配置可用：${configuredModel}`
        : `本机 Codex 模型目录可用（${models.length} 个模型）`,
      testedAt,
      sourcePending,
      configMayBeStale: true
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

const text = (value: unknown, max = 200_000): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('无效的文字参数');
  return value;
};

function issueMessageAssetUrl(messageId: string, source: string): string | null {
  const asset = host.openMessageAsset(messageId, source);
  if (!asset) return null;
  closeSync(asset.descriptor);
  const now = Date.now();
  for (const [token, grant] of messageAssetGrants) {
    if (grant.expiresAt <= now) messageAssetGrants.delete(token);
  }
  const token = randomUUID();
  messageAssetGrants.set(token, { messageId, source, expiresAt: now + 30 * 60_000 });
  return `rambo-asset://asset/${token}`;
}

const composerImageMimeTypes: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};

function composerImageMimeType(path: string): string | null {
  const extension = /\.([^.\\/]+)$/u.exec(path)?.[1]?.toLowerCase();
  return extension ? composerImageMimeTypes[extension] ?? null : null;
}

function openComposerImage(path: string): {
  path: string; size: number; mimeType: string; descriptor: number;
} | null {
  if (!isAbsolute(path) || path.includes('\0')) return null;
  const mimeType = composerImageMimeType(path);
  if (!mimeType) return null;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, 'r');
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      closeSync(descriptor);
      return null;
    }
    return { path, size: stat.size, mimeType, descriptor };
  } catch {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* 已关闭 */ }
    }
    return null;
  }
}

function issueComposerAttachmentUrl(path: string): string | null {
  const mimeType = composerImageMimeType(path);
  if (!mimeType) return null;
  const asset = openComposerImage(path);
  if (!asset) return null;
  closeSync(asset.descriptor);
  const now = Date.now();
  for (const [token, grant] of composerAttachmentGrants) {
    if (grant.expiresAt <= now) composerAttachmentGrants.delete(token);
  }
  const token = randomUUID();
  composerAttachmentGrants.set(token, { path, mimeType, expiresAt: now + 24 * 60 * 60_000 });
  return `rambo-asset://asset/${token}`;
}

function composerAttachmentFromPath(path: string): ComposerAttachment {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('附件必须使用绝对路径');
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, 'r');
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('只能添加普通文件');
  } catch (error) {
    if (error instanceof Error && error.message === '只能添加普通文件') throw error;
    throw new Error(`附件不存在或不可读取：${composerAttachmentName(path)}`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return {
    path,
    name: composerAttachmentName(path),
    kind: composerAttachmentKind(path),
    previewUrl: issueComposerAttachmentUrl(path)
  };
}

function savePastedImage(dataUrl: unknown): ComposerAttachment {
  const parsed = parseImageDataUrl(text(dataUrl, 72_000_000));
  if (!parsed) throw new Error('剪贴板图片格式不受支持');
  const estimatedBytes = Math.ceil(parsed.base64.length * 3 / 4);
  if (estimatedBytes > 50 * 1024 * 1024) throw new Error('剪贴板图片不能超过 50 MiB');
  const bytes = Buffer.from(parsed.base64, 'base64');
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('剪贴板图片不能超过 50 MiB');
  const directory = join(app.getPath('userData'), 'composer-attachments');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(
    directory,
    `pasted-image-${Date.now()}-${randomUUID().slice(0, 8)}.${parsed.extension}`
  );
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  return {
    path: target,
    name: composerAttachmentName(target),
    kind: 'image',
    previewUrl: issueComposerAttachmentUrl(target)
  };
}

function activeComposerDraftAttachmentPaths(): Set<string> {
  return new Set([...composerDraftAttachmentPaths.values()].flatMap(paths => [...paths]));
}

function runComposerAttachmentCleanup() {
  return Promise.resolve().then(() => cleanupComposerAttachments({
    directory: join(app.getPath('userData'), 'composer-attachments'),
    draftPaths: activeComposerDraftAttachmentPaths,
    isReferenced: path => store.composerAttachmentReferenced(path)
  }));
}

function startComposerAttachmentCleanup(): void {
  const run = () => {
    void runComposerAttachmentCleanup().then(result => {
      if (result.errors.length) {
        console.error('[Rambo] composer attachment cleanup failed for some files', result.errors);
      }
    }).catch(error => {
      console.error('[Rambo] composer attachment cleanup failed', error);
    });
  };
  run();
  composerAttachmentCleanupTimer = setInterval(run, 24 * 60 * 60_000);
  composerAttachmentCleanupTimer.unref?.();
}

function serveComposerAsset(asset: {
  path: string; size: number; mimeType: string; descriptor: number;
}, request: Request): Response {
  const baseHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
    'Cache-Control': 'no-store',
    'Content-Length': String(asset.size),
    'Content-Type': asset.mimeType,
    'X-Content-Type-Options': 'nosniff'
  };
  if (request.method === 'HEAD') {
    closeSync(asset.descriptor);
    return new Response(null, { status: 200, headers: baseHeaders });
  }
  let start = 0;
  let end = asset.size - 1;
  let status = 200;
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
    if (!match || asset.size === 0 || !match[1] && !match[2]) {
      closeSync(asset.descriptor);
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${asset.size}`, 'Content-Length': '0' }
      });
    }
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        closeSync(asset.descriptor);
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${asset.size}`, 'Content-Length': '0' }
        });
      }
      start = Math.max(0, asset.size - suffixLength);
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : asset.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= asset.size || end < start) {
      closeSync(asset.descriptor);
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${asset.size}`, 'Content-Length': '0' }
      });
    }
    end = Math.min(end, asset.size - 1);
    status = 206;
    baseHeaders['Content-Range'] = `bytes ${start}-${end}/${asset.size}`;
    baseHeaders['Content-Length'] = String(end - start + 1);
  }
  const stream = createReadStream(asset.path, {
    fd: asset.descriptor,
    autoClose: true,
    start,
    end
  });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers: baseHeaders });
}

function installMessageAssetProtocol(): void {
  protocol.handle('rambo-asset', request => {
    const parsed = new URL(request.url);
    const token = parsed.hostname === 'asset' && /^\/[a-f\d-]{36}$/iu.test(parsed.pathname)
      ? parsed.pathname.slice(1)
      : '';
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    const messageGrant = messageAssetGrants.get(token);
    if (!messageGrant || messageGrant.expiresAt <= Date.now()) {
      messageAssetGrants.delete(token);
    }
    if (messageGrant) {
      const asset = host.openMessageAsset(messageGrant.messageId, messageGrant.source);
      if (!asset) {
        messageAssetGrants.delete(token);
        return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      }
      return serveComposerAsset(asset, request);
    }
    const composerGrant = composerAttachmentGrants.get(token);
    if (!composerGrant || composerGrant.expiresAt <= Date.now()) {
      composerAttachmentGrants.delete(token);
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    const asset = openComposerImage(composerGrant.path);
    if (!asset) {
      composerAttachmentGrants.delete(token);
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    return serveComposerAsset(asset, request);
  });
}
const id = (value: unknown) => text(value, 100);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的参数');
  return value as Record<string, unknown>;
};
const connectorChallenge = (value: unknown): import('../shared/contracts').ConnectorAuthChallenge => {
  const source = object(value);
  const providerId = text(source.providerId, 80);
  const authKind = text(source.authKind, 40);
  if (!['oauth-desktop', 'credentials', 'local-key-capture'].includes(authKind)) {
    throw new Error('无效的授权类型');
  }
  return {
    connectionId: text(source.connectionId, 120),
    providerId,
    authKind: authKind as import('../shared/contracts').ConnectorAuthKind,
    displayName: text(source.displayName, 120),
    url: text(source.url, 4_096)
  };
};
const notifiedReplyItems = new Set<string>();
const activeSystemNotifications = new Set<Notification>();
let visibleChatId: string | null = null;
let windowFocused = false;
let notificationRuntimeState: NotificationRuntimeState = Notification.isSupported() ? 'authorized' : 'unknown';
const routineResultDeliveries = new Set<string>();
const notifiedRoutineRuns = new Set<string>();
function markReplyNotificationSent(key: string): void {
  notifiedReplyItems.add(key);
  while (notifiedReplyItems.size > 1_000) {
    notifiedReplyItems.delete(notifiedReplyItems.values().next().value as string);
  }
}
function publishBotTurnFinishedNotification(chatId: string): void {
  if (!store || !host) return;
  let chat: ReturnType<Store['chat']>;
  try { chat = store.chat(chatId); }
  catch { return; }
  if (chat.groupChatId || chat.routineRunId || chat.archived) return;
  const turn = store.turns(chat.id).at(-1);
  if (!turn) return;
  const notificationId = turn.turnId ? `turn:${turn.turnId}` : `turn-record:${turn.id}`;
  if (notifiedReplyItems.has(notificationId)) return;
  const finalReply = store.messages(chat.id)
    .filter(message =>
      message.role === 'assistant' &&
      message.phase !== 'commentary' &&
      message.text.trim() &&
      (!turn.turnId || message.turnId === turn.turnId)
    )
    .at(-1);
  const text = finalReply?.text?.trim() ?? '';
  const bot = store.bot(chat.botId);
  const isVisibleAndFocused = Boolean(windowFocused && visibleChatId === chat.id);
  const decision = decideBotTurnFinishedNotification({
    status: turn.status,
    text,
    enabled: bot.notificationsEnabled,
    archived: bot.archived,
    visibleAndFocused: isVisibleAndFocused
  });
  host.recordBotReplyNotification({
    chatId: chat.id,
    botId: bot.id,
    preview: (text || '任务执行失败').replace(/\s+/gu, ' ').trim().slice(0, 160),
    notificationId,
    decision: decision.reason,
    createdAt: new Date().toISOString()
  });
  if (!decision.notify) return;
  markReplyNotificationSent(notificationId);
  if (routineResultDeliveries.has(chat.id)) {
    notifiedReplyItems.delete(notificationId);
    return;
  }
  emit({
    type: 'botReplyNotification',
    chatId: chat.id,
    botId: bot.id,
    preview: (text || '任务执行失败').replace(/\s+/gu, ' ').trim().slice(0, 160),
    notificationId,
    visibleAndFocused: isVisibleAndFocused
  });
}
async function refreshNotificationRuntimeState(): Promise<void> {
  notificationRuntimeState = Notification.isSupported() ? 'authorized' : 'unknown';
}
function syncNotificationRuntimeState(): void {
  if (!host) return;
  host.notificationRuntimeState = notificationRuntimeState;
  host.showNotificationRuntimeNote = Boolean(acceptanceRunId);
  host.notificationUnavailableMessage = acceptanceRunId
    ? notificationUnavailableMessage('unknown')
    : null;
}
function showBotReplyNotification(event: Extract<AppEvent, { type: 'botReplyNotification' }>): void {
  if (acceptanceRunId || !Notification.isSupported() ||
      event.visibleAndFocused) return;
  const notificationId = `rambo-reply-${event.notificationId ?? event.chatId}`;
  console.info('[Rambo] system notification requested', notificationId);
  const notification = new Notification({
    id: notificationId,
    groupId: 'rambo-bot-replies',
    title: event.botId ? store.bot(event.botId).name : 'Rambo',
    body: event.preview,
    silent: false
  });
  activeSystemNotifications.add(notification);
  const release = () => {
    activeSystemNotifications.delete(notification);
  };
  notification.on('click', () => {
    showWindow();
    window?.webContents.send('rambo:event', { type: 'focusBot', botId: event.botId } satisfies AppEvent);
  });
  notification.on('show', () => {
    console.info('[Rambo] system notification shown', notificationId);
  });
  notification.on('failed', (_event, error) => {
    console.error('[Rambo] system notification failed', notificationId, error);
    release();
  });
  notification.on('close', () => {
    console.info('[Rambo] system notification closed', notificationId);
    release();
  });
  notification.show();
}
function showRoutineFinishedNotification(runId: string): void {
  if (acceptanceRunId || notifiedRoutineRuns.has(runId) || !Notification.isSupported()) return;
  const run = store.routineRun(runId);
  const bot = store.bot(run.botId);
  const sourceChatId = run.sourceChatId;
  const visibleAndFocused = Boolean(windowFocused && sourceChatId && visibleChatId === sourceChatId);
  const decision = decideRoutineFinishedNotification({
    status: run.status,
    successNotification: run.definition.successNotification,
    enabled: bot.notificationsEnabled,
    archived: bot.archived,
    visibleAndFocused
  });
  if (!decision.notify) return;
  const notification = new Notification({
    id: `rambo-routine-${runId}`,
    groupId: 'rambo-bot-replies',
    title: 'Rambo · 定时任务',
    subtitle: bot.name,
    body: run.status === 'succeeded'
      ? `${run.routineTitle} 已完成`
      : `${run.routineTitle} 需要你处理`,
    silent: false
  });
  // Mark only at the native boundary, after every eligibility check passes.
  notifiedRoutineRuns.add(runId);
  while (notifiedRoutineRuns.size > 1_000) {
    notifiedRoutineRuns.delete(notifiedRoutineRuns.values().next().value as string);
  }
  notification.on('click', () => {
    showWindow();
    window?.webContents.send('rambo:event', { type: 'focusBot', botId: bot.id } satisfies AppEvent);
  });
  notification.show();
}
const emit = (event: AppEvent) => {
  if (event.type === 'turn' || event.type === 'changed') queueSystemIndicators();
  if (event.type === 'turn' && !event.turnId) publishBotTurnFinishedNotification(event.chatId);
  if (event.type === 'botReplyNotification') showBotReplyNotification(event);
  if (event.type === 'routineRunFinished') {
    const run = store.routineRun(event.runId);
    // Successful, failed and interrupted results with a source chat wait for
    // the hidden handoff to finish. A needs-user run stays parked, so it has
    // no result handoff to wait for.
    if (!run.sourceChatId || run.status === 'needs_user') {
      showRoutineFinishedNotification(event.runId);
    }
  }
  if (event.type === 'routineResultDeliveryStarted') routineResultDeliveries.add(event.chatId);
  if (event.type === 'routineResultDeliveryFinished') {
    routineResultDeliveries.delete(event.chatId);
    showRoutineFinishedNotification(event.runId);
  }
  if (window && !window.isDestroyed()) window.webContents.send('rambo:event', event);
};
let indicatorUpdateQueued = false;
function queueSystemIndicators(): void {
  if (!systemIndicators || indicatorUpdateQueued) return;
  indicatorUpdateQueued = true;
  queueMicrotask(() => {
    indicatorUpdateQueued = false;
    if (!systemIndicators) return;
    try {
      systemIndicators.update(runningBots());
    } catch (error) {
      console.error('[Rambo] system indicator update failed', error);
    }
  });
}
function runningBots(): RunningBotIndicator[] {
  if (!store || !host) return [];
  const chats = store.allChats();
  return store.bots()
    .filter(bot => !bot.archived)
    .slice(0, 5)
    .map(bot => {
      const chat = chats.find(item => item.botId === bot.id && item.routineRunId === null);
      return { botId: bot.id, name: bot.name, running: Boolean(chat && host.activeTurns.has(chat.id)) };
    });
}
const rendererFile = join(__dirname, '../renderer/index.html');
const devURL = process.env.ELECTRON_RENDERER_URL;

function registerIPC(): void {
  const resourceIdFromRequest = async (value: unknown): Promise<string> => {
    const resourceId = id(value);
    const discovery = await host.botResources();
    const resource = discovery.resources.find(item => item.id === resourceId);
    if (!resource) throw new Error('未知的 Bot 资源');
    return resource.id;
  };
  const methods: Record<string, (...args: any[]) => unknown> = {
    appVersion: () => app.getVersion(),
    snapshot: () => host.snapshot(),
    selectLocalFiles: async (): Promise<string[]> => {
      if (!window) throw new Error('窗口尚未准备好');
      const result = await dialog.showOpenDialog(window, {
        title: '选择要添加到消息的本机文件',
        buttonLabel: '添加附件',
        properties: ['openFile', 'multiSelections']
      });
      return result.canceled ? [] : result.filePaths;
    },
    registerLocalAttachments: (paths: unknown): ComposerAttachment[] => {
      if (!Array.isArray(paths)) throw new Error('无效的附件列表');
      const errorMessages: string[] = [];
      const attachments = [...new Set(paths.map(value => text(value, 8_000)))]
        .map(path => {
          try {
            return composerAttachmentFromPath(path);
          } catch (error) {
            errorMessages.push(error instanceof Error ? error.message : String(error));
            return null;
          }
        })
        .filter((attachment): attachment is ComposerAttachment => attachment !== null);
      if (!attachments.length && errorMessages.length) throw new Error(errorMessages[0]);
      return attachments;
    },
    savePastedImage,
    setComposerDraftAttachments: (ownerValue: unknown, pathValues: unknown) => {
      const ownerId = text(ownerValue, 200);
      if (!ownerId) throw new Error('无效的草稿附件归属');
      if (!Array.isArray(pathValues) || pathValues.length > 200) {
        throw new Error('无效的草稿附件列表');
      }
      const paths = [...new Set(pathValues.map(path => text(path, 8_000)).filter(Boolean))];
      if (paths.length) composerDraftAttachmentPaths.set(ownerId, new Set(paths));
      else composerDraftAttachmentPaths.delete(ownerId);
    },
    releaseComposerDraftAttachments: (ownerValue: unknown) => {
      const ownerId = text(ownerValue, 200);
      if (!ownerId) throw new Error('无效的草稿附件归属');
      composerDraftAttachmentPaths.delete(ownerId);
    },
    runComposerAttachmentCleanupForAcceptance: async () => {
      if (!acceptanceRunId) throw new Error('仅验收实例允许触发附件清理');
      return runComposerAttachmentCleanup();
    },
    setVisibleChat: chatId => {
      if (chatId === null) visibleChatId = null;
      else {
        const value = id(chatId);
        if (!store.chat(value)) throw new Error('聊天不存在');
        visibleChatId = value;
      }
      return visibleChatId;
    },
    setVisibleChatFocus: focused => {
      if (typeof focused !== 'boolean') throw new Error('无效的窗口焦点状态');
      windowFocused = focused;
    },
    botResources: refresh => host.botResources(refresh === true),
    setDirectMcpEnabled: (serverId, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('无效的 MCP 启用状态');
      const current = directMcpRegistry.get(id(serverId));
      if (!current) throw new Error('MCP Server 不存在');
      const updated = directMcpRegistry.setEnabled(current.id, enabled);
      if (enabled) {
        store.setGlobalResourceIncluded(`mcp:${updated.name.toLocaleLowerCase()}`, true);
      }
      host.changed();
      return updated;
    },
    deleteDirectMcp: serverId => {
      const current = directMcpRegistry.get(id(serverId));
      if (!current) throw new Error('MCP Server 不存在');
      directMcpRegistry.remove(current.id);
      store.setGlobalResourceIncluded(`mcp:${current.name.toLocaleLowerCase()}`, false);
      host.changed();
    },
    setGlobalResource: async (resourceIdValue, included) => {
      if (typeof included !== 'boolean') throw new Error('无效的资源目录状态');
      const resourceId = await resourceIdFromRequest(resourceIdValue);
      const current = resourceIdsSetting(store.settings().globalResourceIds);
      const next = included
        ? [...new Set([...current, resourceId])]
        : current.filter(item => item !== resourceId);
      const defaults = resourceIdsSetting(store.settings().globalDefaultResourceIds)
        .filter(item => next.includes(item));
      store.syncBotResources(next, defaults);
      if (!included && resourceId === 'mcp:playwright') {
        playwrightExtensionVerifier?.cancel();
        store.setSetting('playwrightVerifiedAt', '');
      }
      host.changed();
      return {
        globalResourceIds: next,
        globalDefaultResourceIds: defaults
      };
    },
    setGlobalDefaultResource: (resourceIdValue, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('无效的新 Bot 资源初值');
      const resourceId = id(resourceIdValue);
      const global = resourceIdsSetting(store.settings().globalResourceIds);
      if (!global.includes(resourceId)) throw new Error('资源必须先加入全局可选目录');
      const current = resourceIdsSetting(store.settings().globalDefaultResourceIds)
        .filter(item => global.includes(item));
      const next = enabled
        ? [...new Set([...current, resourceId])]
        : current.filter(item => item !== resourceId);
      store.syncBotResources(global, next);
      host.changed();
      return { globalResourceIds: global, globalDefaultResourceIds: next };
    },
    setBotResource: async (botIdValue, resourceIdValue, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('无效的 Bot 资源状态');
      const resourceId = await resourceIdFromRequest(resourceIdValue);
      const bot = store.setBotResource(id(botIdValue), resourceId, enabled);
      host.changed();
      return bot;
    },
    respondMcpElicitation: (requestIdValue, actionValue) => {
      if (actionValue !== 'accept' && actionValue !== 'decline' && actionValue !== 'cancel') {
        throw new Error('无效的 MCP 权限操作');
      }
      host.respondMcpElicitation(id(requestIdValue), actionValue as McpElicitationAction);
    },
    completeSecretCapture: (requestIdValue, secretValue) => {
      host.completeSecretCapture(id(requestIdValue), text(secretValue, 65_536));
    },
    cancelSecretCapture: requestIdValue => {
      host.cancelSecretCapture(id(requestIdValue));
    },
    verifyPlaywrightConnection: async () => {
      if (!playwrightExtensionVerifier) throw new Error('Playwright 连接验证器尚未启动，请重启 Rambo 后重试。');
      const global = resourceIdsSetting(store.settings().globalResourceIds);
      if (!global.includes('mcp:playwright')) throw new Error('请先将 Playwright 加入全局可选目录。');
      store.setSetting('playwrightVerifiedAt', '');
      host.changed();
      try {
        const result = await playwrightExtensionVerifier.verify(progress => emit({
          type: 'playwrightVerificationProgress',
          phase: progress.phase,
          message: progress.message
        }));
        if (!resourceIdsSetting(store.settings().globalResourceIds).includes('mcp:playwright')) {
          throw new Error('Playwright 已移出全局可选目录，请重新加入后验证。');
        }
        store.setSetting('playwrightVerifiedAt', result.verifiedAt);
        host.changed();
        return result;
      } catch (error) {
        store.setSetting('playwrightVerifiedAt', '');
        host.changed();
        throw error;
      }
    },
    cancelPlaywrightVerification: () => playwrightExtensionVerifier?.cancel(),
    connectorProviders: () => connectorProviders(),
    beginConnectorAuth: async (providerId, displayName) => {
      const provider = connectorProvider(text(providerId, 80));
      const label = displayName === undefined ? undefined : text(displayName, 120).trim();
      const challenge = beginConnectorAuth(provider.id, label);
      if (provider.id === 'wechat') {
        return {
          challenge: {
            ...challenge,
            url: `rambo-connector://wechat-local?connection=${encodeURIComponent(challenge.connectionId)}`
          },
          authorizationUrl: null
        };
      }
      return { challenge, authorizationUrl: null };
    },
    openConnectorAuth: async challengeValue => {
      const challenge = connectorChallenge(challengeValue);
      if (challenge.providerId === 'wechat') {
        if (!wechatConnectorWizard || !wechatReader) throw new Error('微信本机连接向导尚未启动，请重启 Rambo 后重试。');
        const connectionId = challenge.connectionId.slice('pending:wechat:'.length);
        if (!/^[a-f0-9-]{36}$/iu.test(connectionId)) throw new Error('微信授权挑战已失效，请重新开始连接。');
        const flowController = new AbortController();
        wechatAuthControllers.set(challenge.connectionId, flowController);
        const ensureFlowActive = () => {
          if (flowController.signal.aborted) throw new Error('微信连接已取消');
        };
        try {
        const captured = await wechatConnectorWizard.capture(challenge.connectionId, state => emit({
          type: 'connectorAuthProgress',
          connectionId: challenge.connectionId,
          phase: state.phase,
          message: state.message,
          ...(state.canFinishCapture ? { canFinishCapture: true } : {}),
          ...(state.canContinueCapture ? { canContinueCapture: true } : {})
        }));
        ensureFlowActive();
        emit({
          type: 'connectorAuthProgress',
          connectionId: challenge.connectionId,
          phase: 'verifying',
          message: '临时副本已清理，正在用本机读取服务验证聊天数据库。'
        });
        const payload = {
          kind: 'wechat-sqlcipher' as const,
          accountId: captured.accountId,
          keys: captured.keys,
          dataDirectory: captured.dataDirectory,
          wechatVersion: captured.wechatVersion,
          wechatBuild: captured.wechatBuild
        };
        const credentialRef = connectorCredentials.save(connectionId, payload);
        emit({
          type: 'connectorAuthProgress',
          connectionId: challenge.connectionId,
          phase: 'verifying',
          message: '密钥已加密保存；正在检查会话数据库。'
        });
        let connection: ReturnType<Store['createConnectorConnection']> | null = null;
        try {
          const capabilities = Object.fromEntries(
            connectorProvider('wechat').capabilities.map(capability => [capability, 'ready' as const])
          );
          connection = store.createConnectorConnection({
            id: connectionId,
            providerId: 'wechat',
            displayName: challenge.displayName,
            accountLabel: captured.accountId,
            authKind: 'local-key-capture',
            credentialRef,
            capabilities
          });
          const end = new Date();
          const start = new Date(end.getTime() - 365 * 86_400_000);
          const sessions = await wechatReader.sessions(connection, payload);
          ensureFlowActive();
          assertWechatPageDatabasesReadable('会话', sessions);
          emit({
            type: 'connectorAuthProgress',
            connectionId: challenge.connectionId,
            phase: 'verifying',
            message: `会话数据库读取通过：返回 ${sessions.returnedCount} 个会话${sessions.hasMore ? '，剩余会话可分页读取' : ''}；正在检查聊天消息。`
          });
          if (sessions.items.length) {
            const messages = await wechatReader.messages(connection, payload, {
              sessionIds: [sessions.items[0].sessionId],
              start: start.toISOString(), end: end.toISOString()
            });
            ensureFlowActive();
            assertWechatPageDatabasesReadable('聊天或媒体', messages);
          }
          ensureFlowActive();
          emit({
            type: 'connectorAuthProgress',
            connectionId: challenge.connectionId,
            phase: 'verifying',
            message: '聊天数据库读取通过；正在保存连接。'
          });
          store.saveWechatConnectionBinding({
            connectionId,
            accountId: captured.accountId,
            dataDirectory: captured.dataDirectory,
            wechatVersion: captured.wechatVersion,
            wechatBuild: captured.wechatBuild,
            captureVersion: WECHAT_CAPTURE_VERSION
          });
          store.setConnectorConnectionCapabilities(connectionId, capabilities);
          host.changed();
          emit({
            type: 'connectorAuthProgress',
            connectionId: challenge.connectionId,
            phase: 'complete',
            message: '微信数据库验证完成，连接已安全保存。'
          });
          return store.connectorConnection(connectionId);
        } catch (error) {
          if (connection) {
            try { store.deleteConnectorConnection(connectionId); } catch { /* already removed */ }
          }
          connectorCredentials.delete(credentialRef);
          wechatReader.invalidate(connectionId);
          throw new Error(`微信本机数据库验证失败，未保存连接：${error instanceof Error ? error.message : '请重新连接'}`);
        }
        } finally {
          wechatAuthControllers.delete(challenge.connectionId);
        }
      }
      throw new Error('该连接应用不使用浏览器授权');
    },
    finishWechatCapture: challengeValue => {
      const challenge = connectorChallenge(challengeValue);
      if (challenge.providerId !== 'wechat' || !challenge.connectionId.startsWith('pending:wechat:')) {
        throw new Error('无效的微信捕获请求');
      }
      if (!wechatAuthControllers.has(challenge.connectionId)) return false;
      const requested = wechatConnectorWizard?.requestCaptureStop(challenge.connectionId) ?? false;
      if (requested) emit({
        type: 'connectorAuthProgress',
        connectionId: challenge.connectionId,
        phase: 'finishing-capture',
        message: '本轮已结束，正在验证候选密钥；微信副本与授权进程会保持运行，缺少密钥时可继续补抓。',
        canFinishCapture: false
      });
      return requested;
    },
    continueWechatCapture: challengeValue => {
      const challenge = connectorChallenge(challengeValue);
      if (challenge.providerId !== 'wechat' || !challenge.connectionId.startsWith('pending:wechat:')) {
        throw new Error('无效的微信捕获请求');
      }
      if (!wechatAuthControllers.has(challenge.connectionId)) return false;
      const requested = wechatConnectorWizard?.requestCaptureContinue(challenge.connectionId) ?? false;
      return requested;
    },
    cancelConnectorAuth: challengeValue => {
      const challenge = connectorChallenge(challengeValue);
      if (challenge.providerId === 'wechat') {
        wechatAuthControllers.get(challenge.connectionId)?.abort();
        wechatConnectorWizard?.cancel(challenge.connectionId);
        const connectionId = challenge.connectionId.slice('pending:wechat:'.length);
        if (/^[a-f0-9-]{36}$/iu.test(connectionId)) wechatReader?.invalidate(connectionId);
      }
    },
    completeConnectorAuth: async inputValue => {
      const input = object(inputValue);
      const challenge = object(input.challenge);
      const provider = connectorProvider(text(input.providerId, 80));
      const email = text(input.email, 320).trim().toLowerCase();
      const rawSecret = text(input.secret, 16_384).trim();
      const secret = provider.id === 'gmail' ? rawSecret.replace(/\s+/gu, '') : rawSecret;
      const displayName = text(input.displayName, 120).trim();
      if (text(challenge.providerId, 80) !== provider.id) throw new Error('授权挑战与连接应用不匹配');
      if (text(challenge.authKind, 40) !== provider.authKind) throw new Error('连接授权方式已变化，请重新开始连接');
      const challengeConnectionId = text(challenge.connectionId, 120);
      if (!challengeConnectionId.startsWith(`pending:${provider.id}:`)) {
        throw new Error('授权挑战已失效，请重新开始连接');
      }
      if (!email || !email.includes('@')) throw new Error('请输入有效的邮箱地址');
      if (!secret) throw new Error('授权信息不能为空');
      if (!displayName) throw new Error('连接名称不能为空');
      if (provider.id === 'wechat') {
        throw new Error('微信不能通过邮箱凭据连接，请使用本机密钥捕获向导');
      }
      if (provider.id === 'qqmail' || provider.id === 'gmail') {
        const connectionId = challengeConnectionId.slice(`pending:${provider.id}:`.length);
        if (!/^[a-f0-9-]{36}$/.test(connectionId)) throw new Error('授权挑战无效');
        const credentialRef = connectorCredentials.save(connectionId, {
          kind: 'imap-password',
          email,
          password: secret
        });
        let connection: ReturnType<Store['createConnectorConnection']> | null = null;
        try {
          const createdConnection = store.createConnectorConnection({
            id: connectionId,
            providerId: provider.id,
            displayName,
            accountLabel: email,
            authKind: provider.authKind,
            credentialRef
          });
          connection = createdConnection;
          await mailRuntime.withAdapter(createdConnection, async current => { await current.verify(createdConnection); });
        } catch (error) {
          if (connection) {
            try { store.deleteConnectorConnection(connection.id); } catch { /* already absent */ }
          }
          connectorCredentials.delete(credentialRef);
          mailRuntime.invalidate(connectionId);
          throw new Error(
            `${provider.name}连接验证失败，未保存连接：${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (!connection) throw new Error(`${provider.name}连接没有保存`);
        host.changed();
        return connection;
      }
      throw new Error(`${provider.name} 尚未接入`);
    },
    setConnectionStatus: (connectionId, statusValue) => {
      const status = text(statusValue, 40);
      if (!['ready', 'needsReconnect', 'expired', 'disabled'].includes(status)) throw new Error('无效的连接状态');
      const connection = store.setConnectorConnectionStatus(id(connectionId), status as any);
      host.changed();
      return connection;
    },
    removeConnection: connectionId => {
      const existing = store.connectorConnection(id(connectionId));
      const reference = store.connectorCredentialRef(existing.id);
      host.invalidateConnection(existing.id);
      store.deleteConnectorConnection(existing.id);
      connectorCredentials.delete(reference);
      mailRuntime.invalidate(existing.id);
      host.changed();
    },
    setConnectorGrant: (botId, connectionId, granted) => {
      if (typeof granted !== 'boolean') throw new Error('无效的授权参数');
      const grants = store.setConnectorGrant(id(botId), id(connectionId), granted);
      host.changed();
      return grants;
    },
    createBot: value => {
      const input = object(value), name = text(input.name, 255).trim(), avatar = text(input.avatar, 200);
      if (!name) throw new Error('请填写机器人名称');
      const readiness = host.snapshot().executionDefaults;
      if (!readiness.ready) throw new Error(readiness.error ?? '模型配置尚未就绪，暂时不能新建 Bot');
      const result = store.createBot(name, avatar);
      host.changed();
      host.startBotGreeting(result.bot.id);
      return result;
    },
    copyBot: botId => {
      const source = store.bot(id(botId));
      if (host.isBotBusy(source.id)) throw new Error('请先停止该 Bot 的任务，再复制 Bot');
      const targetBotId = randomUUID();
      const secretCopies: Array<{
        sourceSecretId: string;
        id: string;
        credentialRef: string;
      }> = [];
      try {
        for (const secret of store.ownedBotSecrets(source.id)) {
          const payload = connectorCredentials.load(secret.credentialRef);
          const secretId = randomUUID();
          const credentialRef = connectorCredentials.save(secretId, payload);
          secretCopies.push({
            sourceSecretId: secret.id,
            id: secretId,
            credentialRef
          });
        }
        const result = store.copyBot(source.id, targetBotId, secretCopies);
        host.changed();
        host.startBotGreeting(result.bot.id);
        return result;
      } catch (error) {
        for (const copy of secretCopies) connectorCredentials.delete(copy.credentialRef);
        throw error;
      }
    },
    updateBot: (botId, input) => {
      const patch = object(input);
      for (const [key, value] of Object.entries(patch)) {
        if (!['name', 'avatar', 'role', 'instructions', 'notificationsEnabled'].includes(key)) {
          throw new Error(`不支持修改 Bot 字段：${key}`);
        }
        if (key === 'archived') throw new Error('请使用专用的 Bot 归档操作');
        else if (key === 'notificationsEnabled') {
          if (typeof value !== 'boolean') throw new Error('无效的通知开关状态');
        } else text(value, key === 'instructions' ? 50_000 : 500);
      }
      if ('name' in patch && !String(patch.name).trim()) throw new Error('名称不能为空');
      const bot = store.updateBot(id(botId), patch); host.changed(); return bot;
    },
    setBotArchived: (botId, archived) => {
      if (typeof archived !== 'boolean') throw new Error('无效的归档状态');
      const bot = store.setBotArchived(id(botId), archived);
      host.changed();
      return bot;
    },
    setBotPinned: (botId, pinned) => {
      if (typeof pinned !== 'boolean') throw new Error('无效的置顶状态');
      const bot = store.setBotPinned(id(botId), pinned);
      host.changed();
      return bot;
    },
    setGroupArchived: (groupId, archived) => {
      if (typeof archived !== 'boolean') throw new Error('无效的归档状态');
      const group = store.setGroupArchived(id(groupId), archived);
      host.changed();
      return group;
    },
    setGroupPinned: (groupId, pinned) => {
      if (typeof pinned !== 'boolean') throw new Error('无效的置顶状态');
      const group = store.setGroupPinned(id(groupId), pinned);
      host.changed();
      return group;
    },
    deleteGroup: async groupId => {
      const group = store.group(id(groupId));
      if (host.isGroupBusy(group.id)) throw new Error('请先停止该群聊的任务，再永久删除');
      const threadIds = [...new Set(store.groupSessionChats(group.id)
        .flatMap(chat => chat.threadId ? [chat.threadId] : []))];
      if (threadIds.length) {
        await runtime.start();
        for (const threadId of threadIds) await runtime.request('thread/delete', { threadId });
      }
      store.deleteGroup(group.id);
      host.changed();
    },
    deleteBot: async botId => {
      const bot = store.bot(id(botId));
      const chats = store.botChats(bot.id);
      const secretRefs = store.ownedBotSecrets(bot.id).map(secret => secret.credentialRef);
      if (chats.some(chat => host.activeTurns.has(chat.id))) throw new Error('请先停止该 Bot 的任务，再永久删除');
      const threadIds = [...new Set(chats.flatMap(chat => chat.threadId ? [chat.threadId] : []))];
      if (threadIds.length) {
        await runtime.start();
        for (const threadId of threadIds) await runtime.request('thread/delete', { threadId });
      }
      store.deleteBot(bot.id);
      for (const credentialRef of secretRefs) connectorCredentials.delete(credentialRef);
      try {
        removeManagedBotDirectory(store.directory, bot.id);
      } catch (error) {
        host.changed();
        throw new Error(`Bot 已从 Rambo 移除，但专属工作区清理失败：${error instanceof Error ? error.message : String(error)}`);
      }
      host.changed();
    },
    ensureBotChat: botId => { const chat = store.ensureBotChat(id(botId)); host.changed(); return chat; },
    createGroup: value => {
      const input = object(value);
      const title = text(input.title, 120).trim();
      if (!title) throw new Error('请填写群聊名称');
      const purpose = text(input.purpose, 4_000).trim();
      if (!purpose) throw new Error('请填写群聊职责');
      if (!Array.isArray(input.botIds)) throw new Error('无效的群聊成员');
      const botIds = input.botIds.map(id);
      return host.createGroup(title, purpose, botIds);
    },
    updateGroupPurpose: (groupId, purpose) => {
      return host.updateGroupPurpose(id(groupId), text(purpose, 4_000));
    },
    addGroupMembers: (groupId, botIds) => {
      if (!Array.isArray(botIds)) throw new Error('无效的群聊成员');
      return host.addGroupMembers(id(groupId), botIds.map(id));
    },
    removeGroupMembers: (groupId, botIds) => {
      if (!Array.isArray(botIds)) throw new Error('无效的群聊成员');
      return host.removeGroupMembers(id(groupId), botIds.map(id));
    },
    groupMemberChats: groupId => store.groupMemberChats(id(groupId)),
    groupMessages: groupId => store.groupMessages(id(groupId)),
    sendGroup: (groupId, content) => host.sendGroup(id(groupId), text(content)),
    interruptGroup: groupId => host.interruptGroup(id(groupId)),
    answerCard: (messageId, answer) => host.answerCard(id(messageId), text(answer, 20_000)),
    resolveMessageAsset: (messageId, source) => issueMessageAssetUrl(id(messageId), text(source, 8_000)),
    openMessageAsset: async (messageId, source) => {
      const path = host.messageAssetPath(id(messageId), text(source, 8_000));
      if (!path) throw new Error('文件地址无效或文件不可用');
      const error = await shell.openPath(path);
      if (error) throw new Error(`系统无法打开文件：${error}`);
    },
    revealMessageAsset: (messageId, source) => {
      const path = host.messageAssetPath(id(messageId), text(source, 8_000));
      if (!path) throw new Error('文件地址无效或文件不可用');
      shell.showItemInFolder(path);
    },
    saveMessageAsset: async (messageId, source, requestedName) => {
      const fileName = basename(text(requestedName, 255)).trim();
      if (!fileName || fileName === '.' || fileName === '..') {
        throw new Error('文件名无效');
      }
      const asset = host.openMessageAsset(id(messageId), text(source, 8_000));
      if (!asset) throw new Error('文件地址无效或文件不可用');
      let destination: string;
      try {
        if (acceptanceRunId) {
          const downloadDirectory = join(dirname(app.getPath('userData')), 'downloads');
          mkdirSync(downloadDirectory, { recursive: true });
          destination = join(downloadDirectory, fileName);
        } else {
          if (!window) throw new Error('当前窗口不可用，无法保存附件');
          const result = await dialog.showSaveDialog(window, {
            title: '保存附件',
            defaultPath: fileName
          });
          if (result.canceled || !result.filePath) {
            closeSync(asset.descriptor);
            return null;
          }
          destination = result.filePath;
        }
      } catch (error) {
        try { closeSync(asset.descriptor); } catch { /* descriptor already closed */ }
        throw error;
      }
      let resolvedDestination = resolve(destination);
      try {
        resolvedDestination = realpathSync(destination);
      } catch { /* new target */ }
      if (resolvedDestination === asset.path) {
        closeSync(asset.descriptor);
        throw new Error('保存位置不能覆盖原文件');
      }
      try {
        await pipeline(
          createReadStream(asset.path, { fd: asset.descriptor, autoClose: true }),
          createWriteStream(destination, { flags: 'w' })
        );
        return destination;
      } catch (error) {
        try { unlinkSync(destination); } catch { /* no partial target */ }
        throw error;
      }
    },
    updateBotExecutionConfig: (botId, input) => {
      const patch = object(input);
      if (!('model' in patch) || !('permission' in patch)) {
        throw new Error('Bot 模型和权限必须同时更新');
      }
      const bot = store.updateBotExecutionConfig(id(botId), {
        model: text(patch.model, 500).trim(),
        permission: text(patch.permission, 40) as import('../shared/contracts').PermissionMode
      });
      host.changed();
      return bot;
    },
    markChatRead: chatId => host.markChatRead(id(chatId)),
    setRoutineStatus: (routineId, status) => {
      if (status !== 'active' && status !== 'paused') throw new Error('无效的定时任务状态');
      const routineIdValue = id(routineId);
      const current = store.routine(routineIdValue);
      const routine = status === 'active' && current.lastRun?.status === 'needs_user'
        ? store.resolveRoutineRunAndResume(routineIdValue)
        : store.setRoutineStatus(routineIdValue, status);
      if (status === 'paused') host.routineScheduler.stopPending(routine.id, '用户暂停了定时计划');
      host.changed();
      return routine;
    },
    advanceRoutineScheduleForAcceptance: routineId => {
      if (!acceptanceRunId) throw new Error('仅验收实例允许推进定时任务时钟');
      const routine = store.routine(id(routineId));
      store.setRoutineNextRunForAcceptance(
        routine.id,
        routine.definition.kind === 'once'
          ? new Date(Date.now() - 2 * 60_000).toISOString()
          : new Date().toISOString()
      );
      host.changed();
    },
    runRoutineNow: routineId => host.runRoutineNow(id(routineId)),
    stopRoutineRun: routineId => host.stopRoutineRun(id(routineId)),
    messages: chatId => store.messages(id(chatId)),
    copyText: content => {
      const value = text(content, 20_000);
      if (!value) throw new Error('没有可复制的内容');
      clipboard.writeText(value);
    },
    activities: chatId => store.activities(id(chatId)),
    turns: chatId => store.turns(id(chatId)),
    send: (chatId, content) => host.send(id(chatId), text(content)),
    interrupt: chatId => host.interrupt(id(chatId)),
    search: (query, botId) => store.search(text(query, 500), botId === undefined || botId === null ? null : id(botId)),
    memories: botId => store.memories(botId === null ? null : id(botId)),
    saveMemory: value => {
      const input = object(value);
      const memory = store.saveMemory({ id: input.id === undefined ? undefined : id(input.id), botId: input.botId === null ? null : id(input.botId), text: text(input.text, 20_000) });
      host.changed();
      return memory;
    },
    deleteMemory: memoryId => { store.deleteMemory(id(memoryId)); host.changed(); },
    setSetting: async (keyValue, value) => {
      const key = text(keyValue, 100);
      const settingValue = text(value, 20_000);
      if (key !== 'defaultBotModel' && key !== 'defaultBotPermission' &&
          key !== 'runtimeProxy' && key !== 'initialSetupPrompted') {
        throw new Error('不支持的应用设置');
      }
      if (key === 'initialSetupPrompted' && settingValue !== 'true' && settingValue !== 'false') {
        throw new Error('无效的首次设置状态');
      }
      if (key === 'defaultBotPermission' &&
          !['fullAccess', 'workspaceWrite', 'readOnly'].includes(settingValue)) {
        throw new Error('无效的全局权限模式');
      }
      if (key === 'defaultBotModel' && !settingValue.trim()) {
        throw new Error('新建 Bot 的模型不能为空');
      }
      if (key === 'runtimeProxy') {
        const proxy = settingValue.trim();
        if (proxy) {
          let url: URL;
          try { url = new URL(proxy); }
          catch { throw new Error('代理地址格式无效'); }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('代理地址必须使用 http:// 或 https://');
          }
          if (!url.hostname) throw new Error('代理地址缺少主机名');
        }
        if (host.activeTurns.size) throw new Error('有任务执行中，请先停止任务再修改代理');
        const previous = store.settings().runtimeProxy?.trim() ?? '';
        store.setSetting(key, proxy);
        runtime.setProxyUrl(proxy);
        await runtime.stop();
        try {
          await runtime.start();
          await host.syncMcpMetadata();
        } catch (error) {
          store.setSetting(key, previous);
          runtime.setProxyUrl(previous);
          await runtime.stop();
          await runtime.start().catch(() => {});
          throw error;
        }
      } else if (key === 'defaultBotModel') store.setExecutionDefaultModel(settingValue);
      else store.setSetting(key, settingValue);
      host.changed();
    },
    setLaunchAtLogin: enabled => {
      if (typeof enabled !== 'boolean') throw new Error('无效的登录启动状态');
      loginItem.setEnabled(enabled);
      host.changed();
    },
    loginItemSystemChangesAllowed: () => !acceptanceRunId,
    injectAcceptanceEvent: event => {
      if (!acceptanceRunId) throw new Error('仅验收实例允许注入测试事件');
      const value = object(event);
      if (value.type === 'turn') {
        const chatId = id(value.chatId);
        if (!store.chat(chatId)) throw new Error('验收事件引用了不存在的聊天');
        const turnId = value.turnId === null ? null : id(value.turnId);
        emit({ type: 'turn', chatId, turnId });
        return;
      }
      if (value.type === 'groupRuntime') {
        const groupId = id(value.groupId);
        store.group(groupId);
        if (value.runtime === null) {
          emit({ type: 'groupRuntime', groupId, runtime: null });
          return;
        }
        const runtime = object(value.runtime);
        if (!Array.isArray(runtime.members)) throw new Error('验收群聊运行状态缺少成员');
        const members = runtime.members.map(item => {
          const member = object(item);
          const chatId = id(member.chatId);
          const chat = store.chat(chatId);
          if (chat.groupChatId !== groupId) throw new Error('验收群聊运行成员不属于当前群聊');
          if (!['starting', 'judging', 'working'].includes(String(member.phase))) {
            throw new Error('验收群聊运行阶段无效');
          }
          return {
            botId: chat.botId,
            chatId,
            phase: member.phase as GroupRuntimePhase,
            enteredAt: text(member.enteredAt, 100),
            activityKind: member.activityKind === null ? null : text(member.activityKind, 30) as any,
            activityUpdatedAt: member.activityUpdatedAt === null
              ? null
              : text(member.activityUpdatedAt, 100)
          };
        });
        emit({
          type: 'groupRuntime',
          groupId,
          runtime: { groupId, runId: text(runtime.runId, 100), members }
        });
        return;
      }
      if (value.type === 'groupMessage') {
        const groupId = id(value.groupId);
        const message = object(value.message);
        if (message.groupId !== groupId) throw new Error('验收群聊消息不属于当前群聊');
        emit({ type: 'groupMessage', groupId, message: message as any });
        return;
      }
      if (value.type === 'groupMessageRemoved') {
        const groupId = id(value.groupId);
        store.group(groupId);
        emit({ type: 'groupMessageRemoved', groupId, messageId: id(value.messageId) });
        return;
      }
      if (value.type === 'visibilityFocus') {
        if (!window || window.isDestroyed()) throw new Error('窗口不存在');
        if (typeof value.focused !== 'boolean') throw new Error('验收事件缺少有效的焦点状态');
        windowFocused = value.focused;
        return;
      }
      if (value.type === 'startingTurn') {
        const chatId = id(value.chatId);
        if (!store.chat(chatId)) throw new Error('验收事件引用了不存在的聊天');
        if (typeof value.starting !== 'boolean') throw new Error('验收事件缺少有效的运行阶段');
        emit({ type: 'startingTurn', chatId, starting: value.starting });
        return;
      }
      if (value.type === 'voiceState') {
        const session = object(value.session);
        const chatId = id(session.chatId);
        if (!store.chat(chatId)) throw new Error('验收事件引用了不存在的聊天');
        const state = text(session.state, 20) as VoiceState;
        if (!['connecting', 'live', 'stopping', 'error'].includes(state)) {
          throw new Error('验收语音状态无效');
        }
        emit({
          type: 'voiceState',
          session: {
            chatId,
            state,
            realtimeSessionId: null,
            error: session.error === null || session.error === undefined ? null : text(session.error, 500)
          }
        });
        return;
      }
      if (value.type === 'voiceStopFinished') {
        const chatId = id(value.chatId);
        if (!store.chat(chatId)) throw new Error('验收事件引用了不存在的聊天');
        emit({
          type: 'voiceStopFinished',
          chatId,
          error: value.error === null || value.error === undefined ? null : text(value.error, 500)
        });
        return;
      }
      if (value.type === 'mcpElicitation') {
        const requestId = id(value.requestId);
        const prompt = {
          requestId,
          serverName: text(value.serverName, 200),
          threadId: id(value.threadId),
          turnId: value.turnId === null || value.turnId === undefined ? null : id(value.turnId),
          message: text(value.message, 4_000),
          detail: value.detail === null || value.detail === undefined ? null : text(value.detail, 4_000),
          toolName: value.toolName === null || value.toolName === undefined ? null : text(value.toolName, 200)
        };
        if (!prompt.requestId || !prompt.serverName || !prompt.threadId || !prompt.message) {
          throw new Error('验收 MCP 权限请求缺少必要字段');
        }
        host.acceptMcpElicitationForAcceptance(prompt);
        return;
      }
      if (value.type === 'secretCapture') {
        const requestId = id(value.requestId);
        const chatId = id(value.chatId);
        const botId = id(value.botId);
        const chat = store.chat(chatId);
        const bot = store.bot(botId);
        if (chat.botId !== botId) throw new Error('验收密钥请求的 Bot 与聊天不匹配');
        const operation = String(value.operation);
        const scope = String(value.scope);
        if (!['save', 'rotate'].includes(operation) || !['global', 'bot'].includes(scope)) {
          throw new Error('验收密钥请求的操作或范围无效');
        }
        const prompt = {
          requestId,
          chatId,
          botId,
          botName: text(value.botName, 200),
          operation: operation as 'save' | 'rotate',
          name: text(value.name, 120),
          description: text(value.description ?? '', 1_000),
          scope: scope as 'global' | 'bot'
        };
        if (!prompt.requestId || !prompt.botName || !prompt.name) {
          throw new Error('验收密钥请求缺少必要字段');
        }
        host.acceptSecretCaptureForAcceptance(prompt);
        return;
      }
      if (value.type === 'message') {
        const message = object(value.message);
        const chatId = id(message.chatId);
        if (!store.chat(chatId)) throw new Error('验收事件引用了不存在的聊天');
        if (!['user', 'assistant', 'system'].includes(String(message.role))) {
          throw new Error('验收消息角色无效');
        }
        if (message.status !== undefined &&
            !['streaming', 'complete', 'failed', 'interrupted'].includes(String(message.status))) {
          throw new Error('验收消息状态无效');
        }
        const source = message.source === undefined ? 'text' : text(message.source, 20);
        if (!['text', 'voice'].includes(source)) throw new Error('验收消息来源无效');
        emit({
          type: 'message',
          message: {
            id: id(message.id),
            chatId,
            role: message.role,
            text: text(message.text),
            status: message.status,
            itemId: message.itemId === undefined || message.itemId === null ? null : id(message.itemId),
            createdAt: text(message.createdAt, 100),
            turnId: message.turnId === undefined || message.turnId === null ? null : id(message.turnId),
            phase: message.phase === undefined ? null : message.phase,
            source
          } as any
        });
        return;
      }
      if (value.type === 'previewMessage') {
        const message = object(value.message);
        const chatId = id(message.chatId);
        if (!store.chat(chatId)) throw new Error('验收消息引用了不存在的聊天');
        const content = message.content;
        if (content !== undefined && !isMessageContent(content)) throw new Error('验收预览消息内容无效');
        const saved = store.addMessage(
          chatId,
          'assistant',
          text(message.text ?? ''),
          'complete',
          null,
          null,
          null,
          content === undefined ? null : content as MessageContent
        );
        emit({ type: 'message', message: saved });
        return saved;
      }
      if (value.type === 'activity') {
        const activity = object(value.activity);
        const chatId = id(activity.chatId);
        if (!store.chat(chatId)) throw new Error('验收事件引用了不存在的聊天');
        emit({ type: 'activity', activity: activity as any });
        return;
      }
      if (value.type === 'routineTool') {
        const request = object(value);
        delete request.type;
        if (object(request.params).namespace !== 'rambo_routines') {
          throw new Error('验收事件只能提交 Routine 工具请求');
        }
        return host.submitAcceptanceRoutineTool(request);
      }
      if (value.type === 'acceptanceTool') {
        const request = object(value);
        delete request.type;
        const namespace = object(request.params).namespace;
        if (namespace === 'rambo_routines') return host.submitAcceptanceRoutineTool(request);
        if (namespace === 'rambo_bot') return host.submitAcceptanceBotTool(request);
        if (namespace === 'rambo_resources') return host.submitAcceptanceBotResourceTool(request);
        if (namespace === 'rambo_credentials') return host.submitAcceptanceBotCredentialTool(request);
        if (namespace === 'rambo_secrets') return host.submitAcceptanceBotSecretTool(request);
        if (namespace === 'rambo_memories') return host.submitAcceptanceMemoryTool(request);
        if (namespace === 'rambo_group_history') return host.submitAcceptanceGroupHistoryTool(request);
        if (namespace === 'rambo_groups') return host.submitAcceptanceGroupManagementTool(request);
        if (namespace === 'rambo_mail') return host.submitAcceptanceMailTool(request);
        if (namespace === 'rambo_wechat') return host.submitAcceptanceWechatTool(request);
        throw new Error('验收事件提交了不支持的工具命名空间');
      }
      if (value.type === 'acceptanceNotification') {
        return host.acceptNotification(
          text(value.method, 100),
          value.params
        );
      }
      if (value.type === 'acceptanceRoutineTick') return host.acceptRoutineTick();
      throw new Error('不支持的验收事件');
    },
    account: () => host.account(),
    login: async () => { const url = await host.login(); if (url) { if (!url.startsWith('https://')) throw new Error('登录地址协议无效'); await shell.openExternal(url); } },
    models: () => host.models(),
    setModelSource: async kindValue => {
      const kind = modelSourceKindFrom(kindValue);
      if (kind !== kindValue) throw new Error('无效的模型来源');
      const current = modelSourceState();
      if (kind === 'manualApi' && !manualModelSourceAvailable(current)) {
        throw new Error('请先填写并保存手动 API 的服务名称、Base URL、模型 ID 和 API Key');
      }
      store.setSetting('modelSource', kind);
      applyModelSourceRuntimeConfig();
      try {
        await restartRuntimeForModelSource();
      } catch (error) {
        store.setSetting('modelSource', current.kind);
        applyModelSourceRuntimeConfig();
        throw new Error(`模型来源切换失败，已保留原来源：${
          error instanceof Error ? error.message : String(error)
        }`);
      }
      host.changed();
      return modelSourceState();
    },
    saveManualModelSource: async inputValue => {
      const input = object(inputValue);
      const { previousKind, previousSettings } = persistModelSourceConfig(input);
      if (store.settings().modelSource === 'manualApi' && host.activeTurns.size === 0) {
        applyModelSourceRuntimeConfig();
        try {
          await restartRuntimeForModelSource();
        } catch (error) {
          restoreManualModelSettings(previousSettings);
          store.setSetting('modelSource', previousKind);
          applyModelSourceRuntimeConfig();
          throw new Error(`手动 API 配置保存失败，已保留原来源：${
            error instanceof Error ? error.message : String(error)
          }`);
        }
      }
      host.changed();
      return modelSourceState();
    },
    testModelConnection: source => testModelConnection(source),
    startVoice: (chatId, offerSdp) => host.startVoice(id(chatId), text(offerSdp, 128_000)),
    stopVoice: (chatId, reason) => host.stopVoice(
      id(chatId),
      reason === undefined ? undefined : text(reason, 2_000)
    ),
    restartRuntime: async () => {
      if (host.activeTurns.size) throw new Error('有任务执行中，请先停止任务');
      await runtime.stop(); await runtime.start();
      try {
        await host.syncMcpMetadata();
      } catch (error) {
        console.error('[Rambo] MCP metadata refresh failed after runtime restart', error);
      }
    }
  };
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`rambo:${name}`, (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝未知界面请求');
    return method(...args);
  });
}

function showWindow(): void {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    title: acceptanceRunId ? `Rambo · 验收 ${acceptanceRunId}` : 'Rambo', width: 1100, height: 760, minWidth: 760, minHeight: 560,
    backgroundColor: '#ffffff', titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (acceptanceRunId) window.on('page-title-updated', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = devURL ? url.startsWith(new URL(devURL).origin + '/') : url === pathToFileURL(rendererFile).href;
    if (!allowed) event.preventDefault();
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  window.on('focus', () => { windowFocused = true; });
  window.on('blur', () => { windowFocused = false; });
  window.on('hide', () => { windowFocused = false; });
  window.webContents.on('render-process-gone', () => composerDraftAttachmentPaths.clear());
  window.webContents.on('did-start-loading', () => composerDraftAttachmentPaths.clear());
  window.on('closed', () => {
    window = null;
    windowFocused = false;
    visibleChatId = null;
    composerDraftAttachmentPaths.clear();
  });
  if (devURL) void window.loadURL(devURL); else void window.loadFile(rendererFile);
}

function installSystemIndicators(): void {
  if (process.platform !== 'darwin' || acceptanceRunId) return;
  const assetsDirectory = join(app.getAppPath(), 'assets/branding/tray-frames');
  const indicators = new SystemIndicators<Electron.NativeImage, Electron.Menu>({
    platform: process.platform,
    assetsDirectory,
    loadImage: (path, template) => {
      const image = nativeImage.createFromPath(path);
      if (image.isEmpty()) throw new Error(`菜单栏图标为空：${path}`);
      if (template) image.setTemplateImage(true);
      return image;
    },
    createTray: image => new Tray(image as Electron.NativeImage),
    createMenu: items => Menu.buildFromTemplate(items as Electron.MenuItemConstructorOptions[]),
    showApp: showWindow,
    openBot: botId => {
      showWindow();
      window?.webContents.send('rambo:event', { type: 'focusBot', botId } satisfies AppEvent);
    },
    quit: () => app.quit(),
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: timer => clearTimeout(timer),
    random: Math.random
  });
  systemIndicators = indicators;
  indicators.start();
  indicators.update(runningBots());
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = permission === 'media' && window?.webContents === webContents;
      callback(allowed);
    });
    if (acceptanceRunId) {
      const downloadDirectory = join(dirname(app.getPath('userData')), 'downloads');
      mkdirSync(downloadDirectory, { recursive: true });
      if (realpathSync(downloadDirectory) !== downloadDirectory) throw new Error('验收下载目录不能包含符号链接');
      session.defaultSession.on('will-download', (_event, item) => {
        item.setSavePath(join(downloadDirectory, basename(item.getFilename())));
      });
    }
    // The packaged ICNS is already declared as the app icon in its bundle.
    // Electron's dock image loader cannot decode that ICNS path; use the source PNG only in dev.
    if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'assets/branding/app-logo-source.png'));
    store = new Store(app.getPath('userData'));
    startComposerAttachmentCleanup();
    connectorCredentials = new ConnectorCredentials(app.getPath('userData'));
    manualModelCredentials = connectorCredentials;
    directMcpRegistry = new DirectMcpRegistry(store, connectorCredentials);
    const initialSettings = store.settings();
    mailRuntime = new MailRuntime(new SecureMailAdapterRegistry(
      connectorCredentials,
      connectionId => store.connectorCredentialRef(connectionId),
      {
        qqmail: qqMailAdapterFactory,
        gmail: (connection, credentials) => {
          if (credentials.kind === 'imap-password') {
            return gmailImapAdapterFactory(connection, credentials);
          }
          if (credentials.kind === 'oauth-token') {
            return gmailMailAdapterFactory(connection, credentials, {
              saveToken: (connectionId, token) => {
                connectorCredentials.replace(store.connectorCredentialRef(connectionId), token);
              }
            });
          }
          throw new Error('Gmail 凭证类型无效，请重新连接');
        }
      }
    ));
    const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
    runtime = new CodexRuntime(root, store.directory, undefined, {
      ownedThreadIds: () => store.ownedCodexThreadIds(),
      proxyUrl: initialSettings.runtimeProxy?.trim() || null
    });
    const workerTransport = new ElectronWechatWorkerTransport(
      join(__dirname, 'wechat-worker.js'),
      (modulePath, args, options) => utilityProcess.fork(modulePath, args, options)
    );
    wechatReader = new SqlCipherWechatReader(workerTransport);
    playwrightExtensionVerifier = new PlaywrightExtensionVerifier();
    wechatConnectorWizard = new WechatConnectorWizard(app.getPath('userData'), {
      confirmCloseWechat: async () => {
        const result = await dialog.showMessageBox({
          type: 'warning',
          title: '准备连接微信',
          message: '首次连接需要暂时退出微信，并启动 Rambo 管理的临时副本。',
          detail: '请先保存微信中的未发送内容。连接完成后会删除副本，并在原微信当时处于打开状态时重新启动它。',
          buttons: ['取消', '继续'],
          defaultId: 1,
          cancelId: 0
        });
        return result.response === 1;
      },
      chooseAccountDirectory: async defaultDirectory => {
        const result = await dialog.showOpenDialog({
          title: '选择微信账号目录',
          message: '选择 xwechat_files 中以 wxid_ 开头的账号目录。',
          defaultPath: defaultDirectory,
          properties: ['openDirectory']
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      }
    }, app.getPath('home'), undefined, { manualStopOnly: true });
    const wechatMediaProcessor = new WechatMediaContentProcessor(wechatMediaToolPaths());
    host = new Host(
      store, runtime, emit, mailRuntime, connectorCredentials,
      undefined, undefined, wechatReader, wechatMediaProcessor,
      () => modelSourceState(),
      () => testModelConnection()
    );
    try {
      applyModelSourceRuntimeConfig();
    } catch (error) {
      console.error('[Rambo] model source configuration is unavailable', error);
    }
    void refreshNotificationRuntimeState().then(syncNotificationRuntimeState);
    if (!initialSettings.globalResourceIds) {
      const discovered = new Set(host.snapshot().botResources.map(resource => resource.id));
      const initialResources = DEFAULT_BOT_RESOURCE_IDS.filter(id => discovered.has(id));
      store.syncBotResources(initialResources, initialResources);
    } else if (!initialSettings.globalDefaultResourceIds) {
      const global = resourceIdsSetting(initialSettings.globalResourceIds);
      const defaults = global.filter(id =>
        DEFAULT_BOT_RESOURCE_IDS.includes(id as typeof DEFAULT_BOT_RESOURCE_IDS[number])
      );
      store.syncBotResources(global, defaults);
    }
    if (!initialSettings.defaultBotModel?.trim()) {
      void runtime.start().then(async () => {
        try {
          const configuredModel = await (async (): Promise<string | null> => {
            const response: any = await runtime.request('config/read', { includeLayers: false });
            const value = response?.config?.model;
            if (value === null || value === undefined || value === '') return null;
            if (typeof value !== 'string' || !value.trim()) {
              throw new Error('Codex 全局模型配置格式无效');
            }
            return value.trim();
          })();
          let model = configuredModel;
          if (!model) {
          const defaults = (await host.modelsWithoutStart()).filter(option => option.isDefault);
            if (defaults.length !== 1) {
              throw new Error(defaults.length === 0
                ? 'Codex 模型目录没有唯一的产品默认模型'
                : 'Codex 模型目录返回了多个产品默认模型');
            }
            model = defaults[0].id;
          }
          const permission = resolvedDefaultPermission(store.settings().defaultBotPermission);
          store.materializeBotExecutionDefaults(model, permission, permission);
          store.setExecutionDefaults({ model, permission });
          host.changed();
        } catch (error) {
          const message = error instanceof Error ? error.message : '无法初始化模型配置';
          store.setSetting('modelInitializationError', message);
          host.changed();
          console.error('[Rambo] unable to initialize Bot execution defaults', message);
        }
      });
    } else if (!initialSettings.botExecutionDefaultsMigratedV1) {
      try {
        const permission = resolvedDefaultPermission(initialSettings.defaultBotPermission);
        store.materializeBotExecutionDefaults(
          initialSettings.defaultBotModel.trim(),
          permission,
          permission
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法迁移 Bot 执行配置';
        store.setSetting('modelInitializationError', message);
        console.error('[Rambo] unable to migrate Bot execution defaults', message);
      }
    }
    powerMonitor.on('resume', () => {
      void host.routineScheduler.tick().catch(error => {
        console.error('[Rambo] Routine wake reconciliation failed', error);
      });
    });
    installMessageAssetProtocol();
    loginItem = new LoginItemController(store, createElectronLoginItemAdapter({
      isPackaged: app.isPackaged,
      platform: process.platform,
      getLoginItemSettings: () => app.getLoginItemSettings(),
      setLoginItemSettings: settings => app.setLoginItemSettings(settings)
    }, {
      // Automated acceptance uses an isolated profile, but macOS Login Items
      // are still a machine-global user setting. Never mutate them from a run.
      allowSystemChanges: !acceptanceRunId
    }));
    loginItem.applyStoredPreference();
    registerIPC();
    installSystemIndicators();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Rambo', submenu: [{ role: 'about' }, { label: '显示 Rambo', click: showWindow }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
    ]));
    showWindow();
    void runtime.start().then(() => {
      void host.syncMcpMetadata().catch(error => {
        console.error('[Rambo] MCP metadata refresh failed after runtime start', error);
      });
    }).catch(error => {
      console.error('[Rambo] Codex runtime start failed', error);
      emit({ type: 'runtime', state: runtime.state });
    });
  }).catch(error => {
    console.error('[Rambo] startup failed', error);
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('Rambo 启动失败', message);
    app.quit();
  });
  app.on('activate', () => { if (app.isReady() && store) showWindow(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; event.preventDefault();
    if (composerAttachmentCleanupTimer) clearInterval(composerAttachmentCleanupTimer);
    composerAttachmentCleanupTimer = null;
    void (async () => {
      for (const [challengeId, controller] of wechatAuthControllers) {
        controller.abort();
        wechatConnectorWizard?.cancel(challengeId);
        const connectionId = challengeId.slice('pending:wechat:'.length);
        if (/^[a-f0-9-]{36}$/iu.test(connectionId)) wechatReader?.invalidate(connectionId);
      }
      await wechatConnectorWizard?.cancelAll();
      playwrightExtensionVerifier?.cancel();
      while (wechatAuthControllers.size) await new Promise(resolve => setTimeout(resolve, 25));
      systemIndicators?.dispose();
      systemIndicators = null;
      host?.dispose();
      wechatReader?.dispose();
      wechatReader = null;
      await runtime?.stop();
      connectorCredentials?.close();
      store?.close();
      app.quit();
    })();
  });
}
