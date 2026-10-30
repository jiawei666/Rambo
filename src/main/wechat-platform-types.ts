import type { spawn } from 'node:child_process';

export const WECHAT_CAPTURE_VERSION = 'rambo-wechat-platform-v3';

export type WechatWizardPhase =
  | 'checking'
  | 'closing'
  | 'selecting-account'
  | 'copying'
  | 'signing'
  | 'launching'
  | 'capturing'
  | 'finishing-capture'
  | 'awaiting-recapture'
  | 'resuming-capture'
  | 'verifying'
  | 'complete';

export type WechatCaptureBackend = 'managed-clone' | 'windows-memory';

export interface WechatWizardProgress {
  phase: WechatWizardPhase;
  message: string;
  canFinishCapture?: boolean;
  canContinueCapture?: boolean;
}

export interface WechatCaptureDriverStatus {
  phase:
    | 'attaching'
    | 'attached'
    | 'hook-ready'
    | 'key-count'
    | 'round-complete'
    | 'round-start'
    | 'complete'
    | 'failed'
    | 'cancelled';
  keyCount: number;
}

export interface WechatCapturedAccount {
  accountId: string;
  dataDirectory: string;
  wechatVersion: string;
  wechatBuild: string;
  keys: Record<string, { encKey: string; salt: string | null }>;
}

export interface WechatWizardPrompts {
  confirmCloseWechat(): Promise<boolean>;
  chooseAccountDirectory(defaultDirectory: string): Promise<string | null>;
}

export interface WechatConnectorWizardOptions {
  backend?: WechatCaptureBackend;
  captureSeconds?: number;
  manualStopOnly?: boolean;
  reuseManagedClone?: boolean;
  beforeCapture?(signal: AbortSignal): Promise<void>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface WechatConnectorRuntime {
  runFile?: (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
  spawn?: typeof spawn;
  processIds?: () => Promise<number[]>;
  processCommand?: (pid: number) => Promise<string>;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  stopClone?: (pid: number, captureRoot: string) => Promise<void>;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  resourcesDirectory?: string;
  windowsScannerPath?: string;
  windowsDocumentsDirectory?: string;
  windowsAppDataDirectory?: string;
  windowsWechatVersionInfo?: {
    version: string;
    build: string;
  };
}

export interface WechatCaptureContext {
  connectionId: string;
  signal: AbortSignal;
  onProgress: (value: WechatWizardProgress) => void;
  prompts: WechatWizardPrompts;
  options: WechatConnectorWizardOptions;
  runtime: WechatConnectorRuntime;
  homeDirectory: string;
  userDataDirectory: string;
  resourcesDirectory: string;
}

export interface WechatPlatformConnector {
  readonly backend: WechatCaptureBackend;
  capture(context: WechatCaptureContext): Promise<WechatCapturedAccount>;
  cancel(connectionId: string): void;
  requestCaptureStop(connectionId: string): boolean;
  requestCaptureContinue(connectionId: string): boolean;
  cancelAll(): Promise<void>;
}

export interface WechatConnectorAdapter {
  readonly backend: WechatCaptureBackend;
  capture(
    connectionId: string,
    onProgress: (value: WechatWizardProgress) => void
  ): Promise<WechatCapturedAccount>;
  cancel(connectionId: string): void;
  requestCaptureStop(connectionId: string): boolean;
  requestCaptureContinue(connectionId: string): boolean;
  cancelAll(): Promise<void>;
}
