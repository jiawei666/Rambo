import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import type { BotSecret } from '../shared/contracts';

export const BOT_SECRET_TOOL_NAMESPACE = 'rambo_secrets';

const SAVE_SECRET_TOOL = {
  type: 'function',
  name: 'save_secret',
  description: '为当前 Bot 发起一项全局或 Bot 私有密钥的保存。宿主会弹出本机安全输入框，由用户直接输入正文；模型只提供名称、说明和作用域。只在当前 Bot 唯一私聊中可用。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120, description: '便于识别的密钥名称，例如 GitHub Personal Access Token。' },
      description: { type: 'string', maxLength: 1000, description: '可选用途说明，不包含密钥正文。' },
      scope: {
        type: 'string',
        enum: ['global', 'bot'],
        description: 'global 表示所有 Bot 可使用；bot 表示仅当前 Bot、其 Routine 和其群成员执行会话可使用。'
      }
    },
    required: ['name', 'scope'],
    additionalProperties: false
  }
} as const;

const LIST_SECRETS_TOOL = {
  type: 'function',
  name: 'list_secrets',
  description: '列出当前身份可使用的全局密钥和当前 Bot 私有密钥。只返回 ID、名称、作用域和用途说明，不返回密钥正文。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  }
} as const;

const ROTATE_SECRET_TOOL = {
  type: 'function',
  name: 'rotate_secret',
  description: '为当前 Bot 可管理的一项密钥发起轮换。宿主会弹出本机安全输入框，由用户直接输入新正文并保留稳定 secret_id；模型不会接触正文。只在当前 Bot 唯一私聊中可用。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'list_secrets 返回的稳定密钥 ID。' }
    },
    required: ['id'],
    additionalProperties: false
  }
} as const;

const DELETE_SECRET_TOOL = {
  type: 'function',
  name: 'delete_secret',
  description: '删除当前 Bot 可管理的一项密钥。只在当前 Bot 唯一私聊中可用。删除后正文和元数据都不能继续使用。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'list_secrets 返回的稳定密钥 ID。' }
    },
    required: ['id'],
    additionalProperties: false
  }
} as const;

const RUN_WITH_SECRET_TOOL = {
  type: 'function',
  name: 'run_with_secret',
  description: '由宿主解密一项或多项当前 Bot 可使用的密钥，临时注入子进程环境后运行命令。密钥正文不会返回给模型；stdout、stderr 和错误会做精确值脱敏。当前只允许 Full Access，且命令不经过 shell。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, maxLength: 4096, description: '可执行文件路径或 PATH 中的命令名。' },
      args: {
        type: 'array',
        maxItems: 128,
        items: { type: 'string', maxLength: 8192 },
        description: '参数数组，不拼接 shell 字符串。'
      },
      secret_env: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        items: {
          type: 'object',
          properties: {
            secret_id: { type: 'string', description: 'list_secrets 返回的稳定密钥 ID。' },
            env_name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$', description: '子进程中的环境变量名。' }
          },
          required: ['secret_id', 'env_name'],
          additionalProperties: false
        }
      },
      cwd: { type: 'string', maxLength: 4096, description: '可选工作目录；省略时为当前 Bot 工作区，指定目录必须位于该工作区内。' },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, description: '超时毫秒数，默认 30000。' }
    },
    required: ['command', 'secret_env'],
    additionalProperties: false
  }
} as const;

export const BOT_SECRETS_TOOLS = {
  type: 'namespace',
  name: BOT_SECRET_TOOL_NAMESPACE,
  description: '宿主管理的全局与 Bot 私有密钥 Tools。密钥正文加密保存且不会作为工具结果返回；业务执行通过 run_with_secret 临时注入。',
  tools: [SAVE_SECRET_TOOL, LIST_SECRETS_TOOL, ROTATE_SECRET_TOOL, DELETE_SECRET_TOOL, RUN_WITH_SECRET_TOOL]
} as const;

export const BOT_SECRETS_RUNTIME_TOOLS = {
  type: 'namespace',
  name: BOT_SECRET_TOOL_NAMESPACE,
  description: '使用当前 Bot 可访问的全局与私有密钥。Routine 和群成员执行继承所属 Bot 的密钥范围，但不能新增、轮换或删除密钥。',
  tools: [LIST_SECRETS_TOOL, RUN_WITH_SECRET_TOOL]
} as const;

export interface SaveSecretInput {
  name: string;
  description: string;
  scope: 'global' | 'bot';
}

export interface RotateSecretInput {
  id: string;
}

export interface SecretEnvironmentInput {
  secretId: string;
  envName: string;
}

export interface RunWithSecretInput {
  command: string;
  args: string[];
  secretEnv: SecretEnvironmentInput[];
  cwd: string | null;
  timeoutMs: number;
}

export interface SecretCommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface SecretCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type SecretCommandRunner = (request: SecretCommandRequest) => Promise<SecretCommandResult>;

export class BotSecretInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotSecretInputError';
  }
}

export function normalizeSaveSecretInput(value: unknown): SaveSecretInput {
  const input = inputObject(value);
  assertOnlyKeys(input, ['name', 'description', 'scope']);
  const scope = input.scope;
  if (scope !== 'global' && scope !== 'bot') throw new BotSecretInputError('密钥作用域必须是 global 或 bot。');
  return {
    name: boundedText(input.name, 120, '密钥名称'),
    description: optionalText(input.description, 1_000, '密钥用途说明') ?? '',
    scope
  };
}

export function normalizeRotateSecretInput(value: unknown): RotateSecretInput {
  const input = inputObject(value);
  assertOnlyKeys(input, ['id']);
  return {
    id: secretId(input.id)
  };
}

export function normalizeCapturedSecretValue(value: unknown): string {
  return secretText(value);
}

export function normalizeSecretIdInput(value: unknown): string {
  const input = inputObject(value);
  assertOnlyKeys(input, ['id']);
  return secretId(input.id);
}

export function normalizeListSecretsInput(value: unknown): void {
  const input = inputObject(value ?? {});
  assertOnlyKeys(input, []);
}

export function normalizeRunWithSecretInput(value: unknown): RunWithSecretInput {
  const input = inputObject(value);
  assertOnlyKeys(input, ['command', 'args', 'secret_env', 'cwd', 'timeout_ms']);
  const command = boundedText(input.command, 4_096, '命令');
  if (command.includes('\0')) throw new BotSecretInputError('命令不能包含空字符。');
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || args.length > 128) throw new BotSecretInputError('命令参数格式无效。');
  const normalizedArgs = args.map((arg, index) => {
    if (typeof arg !== 'string' || arg.length > 8_192 || arg.includes('\0')) {
      throw new BotSecretInputError(`第 ${index + 1} 个命令参数无效。`);
    }
    return arg;
  });
  if (!Array.isArray(input.secret_env) || input.secret_env.length < 1 || input.secret_env.length > 16) {
    throw new BotSecretInputError('请提供 1–16 项密钥环境变量映射。');
  }
  const seenSecretIds = new Set<string>();
  const seenEnvNames = new Set<string>();
  const secretEnv = input.secret_env.map(item => {
    const mapping = inputObject(item);
    assertOnlyKeys(mapping, ['secret_id', 'env_name']);
    const id = secretId(mapping.secret_id);
    const envName = typeof mapping.env_name === 'string' ? mapping.env_name.trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(envName)) {
      throw new BotSecretInputError('密钥环境变量名无效。');
    }
    if (seenSecretIds.has(id)) throw new BotSecretInputError('同一密钥不能在一次命令中重复注入。');
    if (seenEnvNames.has(envName)) throw new BotSecretInputError('密钥环境变量名不能重复。');
    seenSecretIds.add(id);
    seenEnvNames.add(envName);
    return { secretId: id, envName };
  });
  const cwd = optionalText(input.cwd, 4_096, '工作目录');
  const timeout = input.timeout_ms ?? 30_000;
  if (!Number.isInteger(timeout) || (timeout as number) < 100 || (timeout as number) > 120_000) {
    throw new BotSecretInputError('命令超时必须是 100–120000 毫秒的整数。');
  }
  return {
    command,
    args: normalizedArgs,
    secretEnv,
    cwd,
    timeoutMs: timeout as number
  };
}

export function secretMetadataForModel(secrets: readonly BotSecret[]) {
  return secrets.map(secret => ({
    secret_id: secret.id,
    name: secret.name,
    description: secret.description,
    scope: secret.scope
  }));
}

export function redactSecretValues(value: string, secrets: readonly string[]): string {
  let output = value;
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    variants.add(encodeURIComponent(secret));
    variants.add(Buffer.from(secret, 'utf8').toString('base64'));
    variants.add(Buffer.from(secret, 'utf8').toString('base64url'));
    variants.add(Buffer.from(secret, 'utf8').toString('hex'));
  }
  for (const variant of [...variants].filter(Boolean).sort((left, right) => right.length - left.length)) {
    output = output.split(variant).join('[已隐藏]');
  }
  return output;
}

export const runSecretCommand: SecretCommandRunner = async request => {
  const maxCaptureBytes = 256 * 1024;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  return new Promise((resolve, reject) => {
    let child;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: commandEnvironment(request.env),
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(error);
      return;
    }
    const capture = (chunk: Buffer, target: Buffer[], kind: 'stdout' | 'stderr') => {
      const used = kind === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = maxCaptureBytes - used;
      if (remaining <= 0) {
        if (kind === 'stdout') stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(slice);
      if (kind === 'stdout') {
        stdoutBytes += slice.length;
        if (slice.length < chunk.length) stdoutTruncated = true;
      } else {
        stderrBytes += slice.length;
        if (slice.length < chunk.length) stderrTruncated = true;
      }
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, stdoutChunks, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, stderrChunks, 'stderr'));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
    }, request.timeoutMs);
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
};

function terminateProcess(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid!, value);
      else child.kill(value);
    } catch { /* the process may have exited between timeout and signal delivery */ }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 500).unref();
}

function commandEnvironment(secretEnvironment: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? homedir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? 'zh_CN.UTF-8',
    TZ: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  return { ...base, ...secretEnvironment };
}

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BotSecretInputError('密钥工具参数格式无效。');
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(input: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new BotSecretInputError(`不支持密钥工具字段：${key}`);
  }
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BotSecretInputError(`请提供${label}。`);
  const text = value.trim();
  if (text.length > max) throw new BotSecretInputError(`${label}超过长度限制。`);
  if (text.includes('\0')) throw new BotSecretInputError(`${label}包含无效字符。`);
  return text;
}

function optionalText(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return boundedText(value, max, label);
}

function secretText(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new BotSecretInputError('请提供密钥正文。');
  if (value.length > 65_536) throw new BotSecretInputError('密钥正文超过长度限制。');
  if (value.includes('\0')) throw new BotSecretInputError('密钥正文包含无效字符。');
  return value;
}

function secretId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/u.test(value)) {
    throw new BotSecretInputError('密钥 ID 无效。');
  }
  return value;
}
