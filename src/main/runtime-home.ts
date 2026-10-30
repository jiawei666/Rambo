import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { watch as watchFileSystem, type FSWatcher } from 'node:fs';
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { CodexHomeSyncMode, CodexHomeSyncState } from '../shared/contracts';
import { renameWithRetry } from './platform/fs';

/** Resources copied from the local Codex Home into Rambo's isolated copy. */
export const CODEX_HOME_SYNC_RESOURCES = [
  'config.toml',
  'auth.json',
  'skills',
  'plugins',
  'rules',
  'AGENTS.md',
  'managed_config.toml',
  'mcp-auth.json'
] as const;

const SYNC_STATE_FILE = 'codex-home-sync.json';
const SYNC_SCHEMA = 'rambo.codex-home-sync.v1';
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_DEBOUNCE_MS = 700;

interface StoredSyncState {
  schema: typeof SYNC_SCHEMA;
  mode: CodexHomeSyncMode;
  lastSyncedAt: string | null;
  decisionRequired: boolean;
}

export interface RuntimeHomeManagerOptions {
  watch?: boolean;
  debounceMs?: number;
  now?: () => Date;
  onState?: (state: CodexHomeSyncState) => void;
}

function initialState(): CodexHomeSyncState {
  return {
    mode: 'follow',
    sourceDetected: false,
    sourcePath: null,
    lastSyncedAt: null,
    pending: false,
    syncing: false,
    decisionRequired: false,
    warning: null,
    error: null
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function sessionFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await sessionFiles(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

function isRelevantResource(filename: string | null): boolean {
  if (!filename) return true;
  const normalized = filename.replaceAll('\\', '/');
  const first = normalized.split('/')[0];
  return CODEX_HOME_SYNC_RESOURCES.includes(first as typeof CODEX_HOME_SYNC_RESOURCES[number]);
}

/**
 * Owns Rambo's isolated Codex Home. The local Codex Home is only a read-only
 * source for the explicit follow mode; no session or state database is copied.
 */
export class RuntimeHomeManager {
  readonly home: string;
  private readonly nativeHome: string;
  private readonly storeDirectory: string;
  private readonly stateFile: string;
  private readonly getOwnedThreadIds: () => readonly string[];
  private readonly watchEnabled: boolean;
  private readonly debounceMs: number;
  private readonly now: () => Date;
  private readonly onState?: (state: CodexHomeSyncState) => void;
  private state = initialState();
  private prepared = false;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncPromise: Promise<CodexHomeSyncState> | null = null;

  constructor(
    nativeHome: string,
    storeDirectory: string,
    getOwnedThreadIds: () => readonly string[] = () => [],
    options: RuntimeHomeManagerOptions = {}
  ) {
    this.nativeHome = resolve(nativeHome);
    this.storeDirectory = resolve(storeDirectory);
    this.home = join(this.storeDirectory, 'codex-home');
    this.stateFile = join(this.storeDirectory, SYNC_STATE_FILE);
    this.getOwnedThreadIds = getOwnedThreadIds;
    this.watchEnabled = options.watch !== false;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = options.now ?? (() => new Date());
    this.onState = options.onState;
  }

  snapshot(): CodexHomeSyncState {
    return { ...this.state };
  }

  async prepare(): Promise<string> {
    await this.ensureIsolatedHome();
    await this.refreshSource();
    const stored = await this.readStoredState();
    const localConfig = await this.hasLocalConfig();

    if (stored) {
      this.state.mode = stored.mode;
      this.state.lastSyncedAt = stored.lastSyncedAt;
      this.state.decisionRequired = stored.decisionRequired;
    } else if (this.state.sourceDetected && localConfig) {
      // A pre-existing Rambo profile must not be silently overwritten just
      // because a local Codex Home appears after the app was configured.
      this.state.mode = 'independent';
      this.state.decisionRequired = true;
      this.state.pending = true;
    } else {
      this.state.mode = 'follow';
      this.state.decisionRequired = false;
    }

    if (
      stored?.mode === 'follow' &&
      !stored.lastSyncedAt &&
      this.state.sourceDetected &&
      localConfig
    ) {
      this.state.mode = 'independent';
      this.state.decisionRequired = true;
      this.state.pending = true;
    }

    // Follow is only meaningful when a native Codex Home exists. Without it,
    // persist the effective independent mode so a later-appearing source does
    // not silently take over a profile the user configured independently.
    if (!this.state.sourceDetected) {
      this.state.mode = 'independent';
      this.state.pending = false;
      this.state.decisionRequired = false;
    }

    await this.migrateOwnedSessions();
    await this.refreshWarning();

    if (
      this.state.mode === 'follow' &&
      this.state.sourceDetected &&
      !this.state.decisionRequired
    ) {
      await this.syncSnapshot();
    } else {
      await this.persist();
      this.emitState();
    }

    this.prepared = true;
    this.startWatching();
    return this.home;
  }

  async setMode(mode: CodexHomeSyncMode): Promise<CodexHomeSyncState> {
    if (mode !== 'follow' && mode !== 'independent') throw new Error('无效的 Codex Home 同步模式');
    await this.refreshSource();
    if (mode === 'follow' && !this.state.sourceDetected) {
      throw new Error('未检测到本机 Codex，不能开启持续跟随');
    }
    this.state.mode = mode;
    this.state.decisionRequired = false;
    this.state.error = null;
    this.state.pending = mode === 'follow' && this.state.sourceDetected;
    await this.persist();
    this.emitState();
    if (mode === 'follow' && this.state.sourceDetected) {
      return this.syncSnapshot();
    }
    return this.snapshot();
  }

  async applyPending(): Promise<CodexHomeSyncState> {
    if (this.state.mode !== 'follow' || !this.state.pending) return this.snapshot();
    return this.syncSnapshot();
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private emitState(): void {
    this.onState?.(this.snapshot());
  }

  private async ensureIsolatedHome(): Promise<void> {
    await mkdir(this.storeDirectory, { recursive: true });
    try {
      const existing = await lstat(this.home);
      if (existing.isSymbolicLink()) throw new Error('Rambo Codex Home 不能是符号链接');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const resolvedHome = resolve(this.home);
    if (resolvedHome === this.nativeHome) {
      throw new Error('Rambo 会话目录不能与本机 Codex 目录相同');
    }
    for (const section of ['sessions', 'archived_sessions']) {
      const directory = join(this.home, section);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const entry = await lstat(directory);
      if (entry.isSymbolicLink()) throw new Error(`Rambo 会话目录不能通过链接共享：${directory}`);
    }
  }

  private async refreshSource(): Promise<boolean> {
    const previousPath = this.state.sourcePath;
    let detected = false;
    try {
      const entry = await lstat(this.nativeHome);
      detected = entry.isDirectory();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    this.state.sourceDetected = detected;
    this.state.sourcePath = detected ? this.nativeHome : null;
    if (previousPath !== this.state.sourcePath) this.restartWatcher();
    return detected;
  }

  private async refreshWarning(): Promise<void> {
    this.state.warning = null;
    if (!this.state.sourceDetected || !this.state.sourcePath) return;
    let config = '';
    try {
      config = await readFile(join(this.state.sourcePath, 'config.toml'), 'utf8');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const keyring = /^\s*cli_auth_credentials_store\s*=\s*["'](?:keyring|auto)["']/m.test(config);
    const authFile = await exists(join(this.state.sourcePath, 'auth.json'));
    if (keyring && !authFile) {
      this.state.warning = '本机 Codex 使用系统凭证库/auto 认证，无法复制 auth.json；请在 Rambo 内独立登录 ChatGPT 或配置 API。';
    }
  }

  private async hasLocalConfig(): Promise<boolean> {
    for (const name of CODEX_HOME_SYNC_RESOURCES) {
      if (await exists(join(this.home, name))) return true;
    }
    return false;
  }

  private async readStoredState(): Promise<StoredSyncState | null> {
    try {
      const value = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (
        value?.schema !== SYNC_SCHEMA ||
        (value.mode !== 'follow' && value.mode !== 'independent') ||
        (value.lastSyncedAt !== null && typeof value.lastSyncedAt !== 'string')
      ) return null;
      return {
        schema: SYNC_SCHEMA,
        mode: value.mode,
        lastSyncedAt: value.lastSyncedAt,
        decisionRequired: value.decisionRequired === true
      };
    } catch (error) {
      if (isMissing(error)) return null;
      return null;
    }
  }

  private async persist(): Promise<void> {
    const value: StoredSyncState = {
      schema: SYNC_SCHEMA,
      mode: this.state.mode,
      lastSyncedAt: this.state.lastSyncedAt,
      decisionRequired: this.state.decisionRequired
    };
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      await renameWithRetry(temporary, this.stateFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async syncSnapshot(): Promise<CodexHomeSyncState> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync();
    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  private async performSync(): Promise<CodexHomeSyncState> {
    await this.refreshSource();
    if (!this.state.sourceDetected || !this.state.sourcePath) {
      this.state.pending = false;
      this.state.error = null;
      await this.persist();
      this.emitState();
      return this.snapshot();
    }
    if (this.state.decisionRequired) throw new Error('请先选择是否持续跟随本机 Codex');

    this.state.syncing = true;
    this.state.pending = true;
    this.state.error = null;
    this.emitState();
    const stage = join(this.storeDirectory, `.codex-home-sync-${randomUUID()}`);
    const backup = join(this.storeDirectory, `.codex-home-backup-${randomUUID()}`);
    try {
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await mkdir(backup, { recursive: true, mode: 0o700 });
      for (const name of CODEX_HOME_SYNC_RESOURCES) {
        const source = join(this.state.sourcePath, name);
        if (!(await exists(source))) continue;
        await cp(source, join(stage, name), {
          recursive: true,
          dereference: true,
          preserveTimestamps: true
        });
      }
      await this.commitStage(stage, backup);
      this.state.lastSyncedAt = this.now().toISOString();
      this.state.pending = false;
      this.state.decisionRequired = false;
      await this.refreshWarning();
      await this.persist();
      return this.snapshot();
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
      this.state.pending = true;
      await this.persist().catch(() => {});
      throw error;
    } finally {
      this.state.syncing = false;
      await rm(stage, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true });
      this.emitState();
    }
  }

  private async commitStage(stage: string, backup: string): Promise<void> {
    const applied: Array<{
      destination: string;
      backup: string;
      hadBackup: boolean;
    }> = [];
    try {
      for (const name of CODEX_HOME_SYNC_RESOURCES) {
        const destination = join(this.home, name);
        const staged = join(stage, name);
        const backupPath = join(backup, name);
        const destinationExists = await exists(destination);
        const stagedExists = await exists(staged);
        applied.push({
          destination,
          backup: backupPath,
          hadBackup: destinationExists
        });
        if (destinationExists) await renameWithRetry(destination, backupPath);
        if (stagedExists) await renameWithRetry(staged, destination);
      }
    } catch (error) {
      for (const item of applied.reverse()) {
        await rm(item.destination, { recursive: true, force: true }).catch(() => {});
        if (item.hadBackup) {
          await renameWithRetry(item.backup, item.destination).catch(() => {});
        }
      }
      throw error;
    }
  }

  private async migrateOwnedSessions(): Promise<void> {
    const owned = new Set(
      this.getOwnedThreadIds().filter(id =>
        /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)
      )
    );
    if (!owned.size || !this.state.sourceDetected || !this.state.sourcePath) return;
    const marker = join(this.home, 'rambo-imported-thread-ids.json');
    let imported: string[] = [];
    try {
      const value = JSON.parse(await readFile(marker, 'utf8'));
      if (!Array.isArray(value) || value.some(path => typeof path !== 'string')) {
        throw new Error('Rambo 会话迁移记录无效');
      }
      imported = value;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const completed = new Set(imported);
    const migrated = new Set<string>();
    for (const section of ['sessions', 'archived_sessions']) {
      const sourceRoot = join(this.state.sourcePath, section);
      for (const source of await sessionFiles(sourceRoot)) {
        const match = source.match(/-([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.jsonl(?:\.zst)?$/i);
        if (!match || !owned.has(match[1]) || completed.has(match[1])) continue;
        const relative = join(section, source.slice(sourceRoot.length + 1));
        const destination = join(this.home, relative);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        if (!(await exists(destination))) {
          const temporary = `${destination}.${randomUUID()}.rambo-import`;
          try {
            await copyFile(source, temporary, constants.COPYFILE_EXCL);
            await renameWithRetry(temporary, destination);
          } finally {
            await rm(temporary, { force: true });
          }
        }
        migrated.add(match[1]);
      }
    }
    const temporary = `${marker}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify([...new Set([...completed, ...migrated])]), {
        mode: 0o600,
        flag: 'wx'
      });
      await renameWithRetry(temporary, marker);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private startWatching(): void {
    if (!this.watchEnabled || !this.prepared) return;
    this.restartWatcher();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.pollSource();
      }, POLL_INTERVAL_MS);
      this.pollTimer.unref?.();
    }
  }

  private restartWatcher(): void {
    if (!this.watchEnabled || !this.prepared) return;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (!this.state.sourceDetected || !this.state.sourcePath) return;
    try {
      this.watcher = watchFileSystem(this.state.sourcePath, { recursive: true }, (_event, filename) => {
        if (isRelevantResource(filename)) this.scheduleSync();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  private async pollSource(): Promise<void> {
    const before = this.state.sourceDetected;
    await this.refreshSource();
    if (before !== this.state.sourceDetected) {
      if (
        this.state.sourceDetected &&
        !this.state.lastSyncedAt &&
        await this.hasLocalConfig()
      ) {
        this.state.mode = 'independent';
        this.state.decisionRequired = true;
        this.state.pending = true;
        this.state.error = null;
        await this.persist();
      }
      this.emitState();
      if (
        this.state.sourceDetected &&
        this.state.mode === 'follow' &&
        !this.state.decisionRequired
      ) this.scheduleSync();
    }
  }

  private scheduleSync(): void {
    if (this.state.mode !== 'follow' || this.state.decisionRequired) return;
    this.state.pending = true;
    this.state.error = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.state.mode === 'follow' && !this.state.decisionRequired) {
        this.emitState();
      }
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }
}

/** Compatibility helper for callers that only need the prepared home path. */
export async function prepareRuntimeHome(
  nativeHome: string,
  storeDirectory: string,
  ownedThreadIds: readonly string[] = []
): Promise<string> {
  const manager = new RuntimeHomeManager(
    nativeHome,
    storeDirectory,
    () => ownedThreadIds,
    { watch: false }
  );
  try {
    return await manager.prepare();
  } finally {
    manager.dispose();
  }
}
