import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type ConnectorCredentialPayload =
  | { kind: 'imap-password'; email: string; password: string }
  | {
      kind: 'mcp-secrets';
      serverName: string;
      /** Plain header values are encrypted as a group and never persisted in plaintext. */
      headers: Record<string, string>;
      /** Plain stdio environment values are encrypted as a group. */
      env: Record<string, string>;
    }
  | {
      kind: 'wechat-sqlcipher';
      accountId: string;
      /** One key per database path under the fixed account's db_storage. */
      keys: Record<string, { encKey: string; salt: string | null }>;
      dataDirectory: string;
      wechatVersion: string;
      wechatBuild: string;
    }
  | {
      kind: 'oauth-token';
      email: string;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: string | null;
      scope: string;
      tokenType: string;
      /** Per-connection Desktop OAuth client used for token refresh. */
      oauthClientId?: string;
      oauthClientSecret?: string;
    };

type StoredCredential = {
  schema: 'rambo.connector.credential.v1';
  nonce: string;
  tag: string;
  ciphertext: string;
};

export interface ConnectorCredentialStore {
  /** Creates a new encrypted record from a plaintext payload. */
  save(connectionId: string, payload: ConnectorCredentialPayload): string;
  /** Atomically replaces an existing encrypted record without changing its opaque reference. */
  replace(reference: string, payload: ConnectorCredentialPayload): void;
  /** Reads by the opaque reference persisted in SQLite. */
  load(reference: string): ConnectorCredentialPayload;
  delete(reference: string): void;
}

export type ConnectorCredentialCipher = {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
};

export class ConnectorCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorCredentialsError';
  }
}

/**
 * Encrypts connector secrets with a per-install AES-256-GCM key and stores the
 * ciphertext in SQLite. The local key file is mode 0600 and no macOS Keychain
 * access is required.
 */
export class ConnectorCredentials implements ConnectorCredentialStore {
  private readonly directory: string;
  private readonly cipher: ConnectorCredentialCipher;
  private readonly db: DatabaseSync;

  constructor(userDataDirectory: string, cipher?: ConnectorCredentialCipher) {
    this.directory = join(userDataDirectory, 'connector-credentials');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.cipher = cipher ?? new LocalAesCredentialCipher(this.directory);
    const databasePath = join(this.directory, 'credentials.sqlite');
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS connector_credentials (
        reference TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    protectIfPresent(databasePath);
    protectIfPresent(`${databasePath}-wal`);
    protectIfPresent(`${databasePath}-shm`);
  }

  save(connectionId: string, payload: ConnectorCredentialPayload): string {
    validateConnectionId(connectionId);
    validatePayload(payload);
    if (!this.cipher.available()) {
      throw new ConnectorCredentialsError('本机凭证存储不可用，未保存连接凭证');
    }
    const reference = `db:${randomUUID()}`;
    const body: StoredCredential = {
      schema: 'rambo.connector.credential.v1',
      ...encodeSealedValue(this.cipher.encrypt(JSON.stringify(payload)))
    };
    const date = new Date().toISOString();
    this.db.prepare(`INSERT INTO connector_credentials(reference,body,createdAt,updatedAt)
      VALUES(?,?,?,?)`).run(reference, JSON.stringify(body), date, date);
    if (!this.db.prepare(
      'SELECT 1 AS present FROM connector_credentials WHERE reference=?'
    ).get(reference)) {
      throw new ConnectorCredentialsError('连接凭证写入失败，未保存连接凭证');
    }
    this.protectDatabaseFiles();
    return reference;
  }

  replace(reference: string, payload: ConnectorCredentialPayload): void {
    if (/^safe:[a-f0-9-]{36}$/u.test(reference)) {
      throw new ConnectorCredentialsError('旧版连接凭证需要重新授权');
    }
    validatePayload(payload);
    if (!this.cipher.available()) {
      throw new ConnectorCredentialsError('本机凭证存储不可用，未保存连接凭证');
    }
    const body: StoredCredential = {
      schema: 'rambo.connector.credential.v1',
      ...encodeSealedValue(this.cipher.encrypt(JSON.stringify(payload)))
    };
    const before = this.db.prepare(
      'SELECT 1 AS present FROM connector_credentials WHERE reference=?'
    ).get(reference);
    if (!before) throw new ConnectorCredentialsError('连接凭证不存在，请重新授权');
    this.db.prepare(
      'UPDATE connector_credentials SET body=?,updatedAt=? WHERE reference=?'
    ).run(JSON.stringify(body), new Date().toISOString(), reference);
    this.protectDatabaseFiles();
  }

  load(reference: string): ConnectorCredentialPayload {
    if (/^safe:[a-f0-9-]{36}$/u.test(reference)) {
      throw new ConnectorCredentialsError('旧版连接凭证需要重新授权');
    }
    validateReference(reference);
    const row = this.db.prepare(
      'SELECT body FROM connector_credentials WHERE reference=?'
    ).get(reference) as { body?: unknown } | undefined;
    if (!row || typeof row.body !== 'string') {
      throw new ConnectorCredentialsError('连接凭证不存在或无法读取，请重新授权');
    }
    let body: StoredCredential;
    try { body = JSON.parse(row.body) as StoredCredential; }
    catch { throw new ConnectorCredentialsError('连接凭证格式无效，请重新授权'); }
    if (body.schema !== 'rambo.connector.credential.v1' ||
        typeof body.nonce !== 'string' || !body.nonce ||
        typeof body.tag !== 'string' || !body.tag ||
        typeof body.ciphertext !== 'string' || !body.ciphertext) {
      throw new ConnectorCredentialsError('连接凭证格式无效，请重新授权');
    }
    if (!this.cipher.available()) {
      throw new ConnectorCredentialsError('本机凭证存储不可用，无法读取连接凭证');
    }
    try {
      const payload = JSON.parse(
        this.cipher.decrypt(decodeSealedValue(body))
      ) as ConnectorCredentialPayload;
      validatePayload(payload);
      return payload;
    } catch (error) {
      if (error instanceof ConnectorCredentialsError) throw error;
      throw new ConnectorCredentialsError('连接凭证解密失败，请重新授权');
    }
  }

  delete(reference: string): void {
    try { this.db.prepare('DELETE FROM connector_credentials WHERE reference=?').run(reference); }
    catch { /* the connection record remains authoritative */ }
  }

  close(): void {
    this.db.close();
  }

  private protectDatabaseFiles(): void {
    const databasePath = join(this.directory, 'credentials.sqlite');
    protectIfPresent(databasePath);
    protectIfPresent(`${databasePath}-wal`);
    protectIfPresent(`${databasePath}-shm`);
  }
}

class LocalAesCredentialCipher implements ConnectorCredentialCipher {
  private readonly keyPath: string;
  private key: Buffer | null = null;

  constructor(directory: string) {
    this.keyPath = join(directory, 'credential-key');
  }

  available(): boolean { return true; }

  encrypt(value: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), nonce);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(value: Buffer): string {
    if (value.length <= 28) throw new ConnectorCredentialsError('连接凭证解密失败，请重新授权');
    const nonce = value.subarray(0, 12);
    const tag = value.subarray(12, 28);
    const ciphertext = value.subarray(28);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      if (error instanceof ConnectorCredentialsError) throw error;
      throw new ConnectorCredentialsError('连接凭证解密失败，请重新授权');
    }
  }

  private encryptionKey(): Buffer {
    if (this.key) return this.key;
    try {
      const stored = readFileSync(this.keyPath);
      if (stored.length !== 32) throw new Error('credential key length');
      chmodSync(this.keyPath, 0o600);
      this.key = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ConnectorCredentialsError('连接凭证密钥无法读取，请删除应用数据后重新连接');
      }
      const created = randomBytes(32);
      writeFileSync(this.keyPath, created, { mode: 0o600, flag: 'wx' });
      this.key = created;
    }
    return this.key;
  }
}

function validateConnectionId(value: string): void {
  if (!/^[a-f0-9-]{36}$/.test(value)) {
    throw new ConnectorCredentialsError('连接 ID 无效');
  }
}

function validateReference(value: string): void {
  if (!/^db:[a-f0-9-]{36}$/u.test(value)) {
    throw new ConnectorCredentialsError('连接凭证引用无效');
  }
}

function protectIfPresent(path: string): void {
  if (existsSync(path)) chmodSync(path, 0o600);
}

function encodeSealedValue(sealed: Buffer): Pick<StoredCredential, 'nonce' | 'tag' | 'ciphertext'> {
  if (sealed.length < 29) throw new ConnectorCredentialsError('连接凭证加密失败');
  return {
    nonce: sealed.subarray(0, 12).toString('base64'),
    tag: sealed.subarray(12, 28).toString('base64'),
    ciphertext: sealed.subarray(28).toString('base64')
  };
}

function decodeSealedValue(body: StoredCredential): Buffer {
  try {
    return Buffer.concat([
      Buffer.from(body.nonce, 'base64'),
      Buffer.from(body.tag, 'base64'),
      Buffer.from(body.ciphertext, 'base64')
    ]);
  } catch {
    throw new ConnectorCredentialsError('连接凭证格式无效，请重新授权');
  }
}

function validatePayload(payload: ConnectorCredentialPayload): void {
  if (!payload || typeof payload !== 'object') {
    throw new ConnectorCredentialsError('连接凭证内容无效');
  }
  if (payload.kind === 'imap-password') {
    if (payload.kind !== 'imap-password' || typeof payload.email !== 'string' ||
        typeof payload.password !== 'string' || !payload.password ||
        payload.email.length > 320 || payload.password.length > 16_384) {
      throw new ConnectorCredentialsError('邮箱授权凭证格式无效');
    }
    return;
  }
  if (payload.kind === 'oauth-token') {
    if (payload.kind !== 'oauth-token' || typeof payload.email !== 'string' ||
        typeof payload.accessToken !== 'string' || !payload.accessToken ||
        (payload.refreshToken !== null && typeof payload.refreshToken !== 'string') ||
        (payload.expiresAt !== null && typeof payload.expiresAt !== 'string') ||
        typeof payload.scope !== 'string' || typeof payload.tokenType !== 'string' ||
        (payload.oauthClientId !== undefined && (
          typeof payload.oauthClientId !== 'string' ||
          !/^[\w.-]+\.apps\.googleusercontent\.com$/u.test(payload.oauthClientId)
        )) ||
        (payload.oauthClientSecret !== undefined &&
          (typeof payload.oauthClientSecret !== 'string' || !payload.oauthClientSecret)) ||
        ((payload.oauthClientId === undefined) !== (payload.oauthClientSecret === undefined))) {
      throw new ConnectorCredentialsError('OAuth 凭证格式无效');
    }
    return;
  }
  if (payload.kind === 'mcp-secrets') {
    if (typeof payload.serverName !== 'string' || !payload.serverName.trim() ||
        payload.serverName.length > 200 ||
        !payload.headers || typeof payload.headers !== 'object' || Array.isArray(payload.headers) ||
        !payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) {
      throw new ConnectorCredentialsError('MCP 凭证格式无效');
    }
    for (const [key, value] of [
      ...Object.entries(payload.headers),
      ...Object.entries(payload.env)
    ]) {
      if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/u.test(key) ||
          typeof value !== 'string' || value.length > 65_536 || value.includes('\0')) {
        throw new ConnectorCredentialsError('MCP 凭证字段格式无效');
      }
    }
    return;
  }
  if (payload.kind === 'wechat-sqlcipher') {
    if (typeof payload.accountId !== 'string' || !payload.accountId.trim() ||
        payload.accountId.length > 320 ||
        !payload.keys || typeof payload.keys !== 'object' || Array.isArray(payload.keys) ||
        Object.keys(payload.keys).length === 0 ||
        Object.keys(payload.keys).length > 50_000 ||
        typeof payload.dataDirectory !== 'string' || !isAbsolute(payload.dataDirectory) ||
        payload.dataDirectory.length > 4_096 ||
        typeof payload.wechatVersion !== 'string' || !payload.wechatVersion.trim() ||
        payload.wechatVersion.length > 100 ||
        typeof payload.wechatBuild !== 'string' || !payload.wechatBuild.trim()) {
      throw new ConnectorCredentialsError('微信 SQLCipher 凭证格式无效');
    }
    for (const [path, key] of Object.entries(payload.keys)) {
      if (!safeWechatDatabasePath(path) || !key || typeof key !== 'object' ||
          !/^[a-f0-9]{64}$/iu.test(key.encKey) ||
          (key.salt !== null && !/^[a-f0-9]{32}$/iu.test(key.salt))) {
        throw new ConnectorCredentialsError('微信数据库密钥格式无效');
      }
    }
    return;
  }
  throw new ConnectorCredentialsError('不支持的连接凭证类型');
}

function safeWechatDatabasePath(value: string): boolean {
  return value.length > 0 && value.length <= 500 &&
    !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
    value.split('/').every(part => part && part !== '.' && part !== '..') &&
    value.endsWith('.db');
}
