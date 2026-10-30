import { homedir } from 'node:os';
import { MacWechatConnector } from './wechat-connector-macos';
import { WindowsMemoryWechatConnector } from './wechat-connector-windows';
import type {
  WechatCaptureBackend,
  WechatCapturedAccount,
  WechatConnectorAdapter,
  WechatConnectorRuntime,
  WechatConnectorWizardOptions,
  WechatWizardPrompts,
  WechatWizardProgress
} from './wechat-platform-types';

export {
  WECHAT_CAPTURE_VERSION,
  type ExecOptions,
  type ExecResult,
  type WechatCaptureBackend,
  type WechatCapturedAccount,
  type WechatCaptureDriverStatus,
  type WechatConnectorRuntime,
  type WechatConnectorWizardOptions,
  type WechatWizardPhase,
  type WechatWizardPrompts,
  type WechatWizardProgress
} from './wechat-platform-types';
export {
  mapWechatKeyCandidatesToDatabases,
  mapWechatKeysToDatabases,
  parseCapturedWechatKeys,
  parseWechatCaptureStatuses,
  summarizeWechatDatabaseCoverage
} from './wechat-connector-common';

function backendForPlatform(platform: NodeJS.Platform): WechatCaptureBackend {
  if (platform === 'darwin') return 'managed-clone';
  if (platform === 'win32') return 'windows-memory';
  throw new Error('微信本机连接目前仅支持 macOS 和 Windows。');
}

export class WechatConnectorWizard {
  private readonly mac: MacWechatConnector;
  private readonly windows: WindowsMemoryWechatConnector;
  private readonly platform: NodeJS.Platform;
  readonly backend: WechatCaptureBackend;

  constructor(
    userDataDirectory: string,
    prompts: WechatWizardPrompts,
    homeDirectory: string = homedir(),
    private readonly runtime: WechatConnectorRuntime = {},
    private readonly options: WechatConnectorWizardOptions = {}
  ) {
    this.platform = runtime.platform ?? process.platform;
    this.backend = backendForPlatform(this.platform);
    if (options.backend && options.backend !== this.backend) {
      throw new Error('微信连接后端与当前操作系统不匹配。');
    }
    this.mac = new MacWechatConnector(userDataDirectory, prompts, homeDirectory, runtime, options);
    this.windows = new WindowsMemoryWechatConnector(prompts, runtime, options);
  }

  private adapter(): WechatConnectorAdapter {
    return this.platform === 'darwin' ? this.mac : this.windows;
  }

  capture(
    connectionId: string,
    onProgress: (value: WechatWizardProgress) => void
  ): Promise<WechatCapturedAccount> {
    return this.adapter().capture(connectionId, onProgress);
  }

  cancel(connectionId: string): void {
    this.mac.cancel(connectionId);
    this.windows.cancel(connectionId);
  }

  requestCaptureStop(connectionId: string): boolean {
    return this.adapter().requestCaptureStop(connectionId);
  }

  requestCaptureContinue(connectionId: string): boolean {
    return this.adapter().requestCaptureContinue(connectionId);
  }

  async cancelAll(): Promise<void> {
    await Promise.all([this.mac.cancelAll(), this.windows.cancelAll()]);
  }
}
