import type {
  WechatWorkerResponse
} from './wechat-worker';
import type {
  WechatWorkerTransport,
  WechatWorkerTransportRequest
} from './wechat-adapter';

export interface WechatWorkerProcess {
  pid?: number;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'error', listener: (...args: unknown[]) => void): this;
  off?(event: 'message', listener: (message: unknown) => void): this;
  off?(event: 'exit', listener: (code: number) => void): this;
  off?(event: 'error', listener: (...args: unknown[]) => void): this;
}

export type WechatWorkerProcessFactory = (
  modulePath: string,
  args: string[],
  options: {
    serviceName: string;
    stdio: ['ignore', 'ignore', 'ignore'];
  }
) => WechatWorkerProcess;

interface PendingRequest {
  resolve(value: WechatWorkerResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerSession {
  process: WechatWorkerProcess;
  pending: Map<string, PendingRequest>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

export class ElectronWechatWorkerTransport implements WechatWorkerTransport {
  private readonly workers = new Map<string, WorkerSession>();
  private disposed = false;

  constructor(
    private readonly workerPath: string,
    private readonly forkWorker: WechatWorkerProcessFactory
  ) {}

  send(input: WechatWorkerTransportRequest): Promise<WechatWorkerResponse> {
    if (this.disposed) {
      return Promise.reject(new Error('微信本机读取服务已停止'));
    }
    if (!input || typeof input.connectionId !== 'string' || !input.connectionId ||
        !input.request || typeof input.request.id !== 'string' || !input.request.id) {
      return Promise.reject(new Error('微信 Worker 请求无效'));
    }
    let session: WorkerSession;
    try {
      session = this.ensureWorker(input.connectionId);
    } catch {
      return Promise.reject(new Error('无法启动微信本机读取服务'));
    }
    if (session.pending.has(input.request.id)) {
      return Promise.reject(new Error('微信 Worker 请求标识重复'));
    }
    const timeoutMs = Number.isInteger(input.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, input.timeoutMs!))
      : DEFAULT_TIMEOUT_MS;
    return new Promise<WechatWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = session.pending.get(input.request.id);
        if (!pending) return;
        session.pending.delete(input.request.id);
        pending.reject(new Error('微信本机数据读取超时'));
        this.terminate(input.connectionId);
      }, timeoutMs);
      session.pending.set(input.request.id, { resolve, reject, timer });
      try {
        session.process.postMessage(input.request);
      } catch {
        this.rejectPending(session, new Error('无法向微信本机读取服务发送请求'));
        this.terminate(input.connectionId);
      }
    });
  }

  terminate(connectionId: string): void {
    const session = this.workers.get(connectionId);
    if (!session) return;
    this.workers.delete(connectionId);
    this.rejectPending(session, new Error('微信连接已关闭，本机读取服务已停止'));
    try { session.process.kill(); } catch { /* process already stopped */ }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const connectionId of [...this.workers.keys()]) this.terminate(connectionId);
  }

  private ensureWorker(connectionId: string): WorkerSession {
    const existing = this.workers.get(connectionId);
    if (existing) return existing;
    const child = this.forkWorker(this.workerPath, [], {
      serviceName: 'Rambo WeChat Reader',
      stdio: ['ignore', 'ignore', 'ignore']
    });
    const session: WorkerSession = { process: child, pending: new Map() };
    this.workers.set(connectionId, session);
    const onMessage = (value: unknown) => this.handleMessage(connectionId, session, value);
    const onExit = () => this.handleProcessEnd(connectionId, session);
    const onError = () => this.handleProcessEnd(connectionId, session);
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
    return session;
  }

  private handleMessage(connectionId: string, session: WorkerSession, value: unknown): void {
    if (this.workers.get(connectionId) !== session) return;
    const response = workerResponse(value);
    if (!response) {
      this.rejectPending(session, new Error('微信本机读取服务返回了无效响应'));
      this.terminate(connectionId);
      return;
    }
    const pending = session.pending.get(response.id);
    if (!pending) return;
    session.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private handleProcessEnd(connectionId: string, session: WorkerSession): void {
    if (this.workers.get(connectionId) !== session) return;
    this.workers.delete(connectionId);
    this.rejectPending(session, new Error('微信本机读取服务意外停止'));
  }

  private rejectPending(session: WorkerSession, error: Error): void {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
  }
}

function workerResponse(value: unknown): WechatWorkerResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (typeof response.id !== 'string' || !response.id || typeof response.ok !== 'boolean') return null;
  if (response.ok) {
    return 'result' in response
      ? {
          id: response.id,
          ok: true,
          result: response.result as Extract<WechatWorkerResponse, { ok: true }>['result']
        }
      : null;
  }
  const error = response.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const detail = error as Record<string, unknown>;
  if (typeof detail.code !== 'string' || typeof detail.message !== 'string') return null;
  return {
    id: response.id,
    ok: false,
    error: { code: detail.code.slice(0, 120), message: detail.message.slice(0, 500) }
  };
}
