import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CodexHomeSyncState } from '../shared/contracts';
import { ManagedSkillLibrary } from './managed-skills';
import { renameWithRetry } from './platform/fs';

/** Local Codex Home resources eligible for the one-time Rambo import. */
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
const INITIAL_IMPORT_FILE = 'codex-home-initial-import.json';
const INITIAL_IMPORT_SCHEMA = 'rambo.codex-home-initial-import.v1';

interface StoredSyncState {
  schema: typeof SYNC_SCHEMA;
  mode: 'follow' | 'independent';
  lastSyncedAt: string | null;
  decisionRequired: boolean;
}

interface StoredInitialImport {
  schema: typeof INITIAL_IMPORT_SCHEMA;
  completedAt: string;
  result: 'imported' | 'skipped-existing' | 'skipped-no-native-home' | 'skipped-previous-profile';
}

export interface RuntimeHomeManagerOptions {
  /** Retained for constructor compatibility. Native Home watching is disabled. */
  watch?: boolean;
  debounceMs?: number;
  nativeAgentSkillsRoot?: string;
  now?: () => Date;
}

function initialState(): CodexHomeSyncState {
  return {
    mode: 'independent',
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

async function hasContent(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.isDirectory()) return (await readdir(path)).length > 0;
    return entry.isFile() || entry.isSymbolicLink();
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

/** Owns Rambo's independent Codex Home and performs at most one local import. */
export class RuntimeHomeManager {
  readonly home: string;
  private readonly nativeHome: string;
  private readonly nativeAgentSkillsRoot: string;
  private readonly storeDirectory: string;
  private readonly stateFile: string;
  private readonly initialImportFile: string;
  private readonly getOwnedThreadIds: () => readonly string[];
  private readonly now: () => Date;
  private state = initialState();

  constructor(
    nativeHome: string,
    storeDirectory: string,
    getOwnedThreadIds: () => readonly string[] = () => [],
    options: RuntimeHomeManagerOptions = {}
  ) {
    this.nativeHome = resolve(nativeHome);
    this.nativeAgentSkillsRoot = resolve(options.nativeAgentSkillsRoot ?? join(
      process.env.USERPROFILE || process.env.HOME || homedir(), '.agents', 'skills'
    ));
    this.storeDirectory = resolve(storeDirectory);
    this.home = join(this.storeDirectory, 'codex-home');
    this.stateFile = join(this.storeDirectory, SYNC_STATE_FILE);
    this.initialImportFile = join(this.storeDirectory, INITIAL_IMPORT_FILE);
    this.getOwnedThreadIds = getOwnedThreadIds;
    this.now = options.now ?? (() => new Date());
  }

  snapshot(): CodexHomeSyncState {
    return { ...this.state };
  }

  async prepare(): Promise<string> {
    await this.ensureIsolatedHome();
    const stored = await this.readStoredState();
    await this.refreshSourceOnce();
    this.state.lastSyncedAt = stored?.lastSyncedAt ?? null;
    const managedSkills = new ManagedSkillLibrary(this.storeDirectory);
    const hadExistingConfiguration = await this.hasExistingConfiguration(managedSkills);

    try {
      await managedSkills.migrateLegacyRoot();
      const imported = await this.readInitialImportState();
      if (!imported) {
        if (!this.state.sourceDetected || !this.state.sourcePath) {
          await this.writeInitialImportState('skipped-no-native-home');
        } else if (stored?.mode === 'independent' ||
            (stored?.mode === 'follow' && stored.lastSyncedAt) || hadExistingConfiguration) {
          await this.writeInitialImportState(
            stored ? 'skipped-previous-profile' : 'skipped-existing'
          );
        } else {
          await this.importInitialResources(managedSkills);
          this.state.lastSyncedAt = this.now().toISOString();
        }
      }

      // Existing Rambo threads created while the old follow mode was active
      // may need their owned rollout files copied once during this migration.
      if (stored?.mode === 'follow' && this.state.sourceDetected && this.state.sourcePath) {
        await this.migrateOwnedSessions();
      }
      await this.refreshWarning();
      this.state.mode = 'independent';
      this.state.pending = false;
      this.state.syncing = false;
      this.state.decisionRequired = false;
      this.state.error = null;
      await this.persist();
      return this.home;
    } catch (error) {
      this.state.mode = 'independent';
      this.state.pending = false;
      this.state.syncing = false;
      this.state.decisionRequired = false;
      this.state.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  dispose(): void {
    // Runtime Home is intentionally independent after startup; there are no
    // filesystem watchers, polling timers, or deferred sync jobs to dispose.
  }

  private async ensureIsolatedHome(): Promise<void> {
    await mkdir(this.storeDirectory, { recursive: true });
    try {
      const existing = await lstat(this.home);
      if (existing.isSymbolicLink()) throw new Error('Rambo Codex Home 不能是符号链接');
      if (!existing.isDirectory()) throw new Error('Rambo Codex Home 必须是普通目录');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    if (resolve(this.home) === this.nativeHome) {
      throw new Error('Rambo 会话目录不能与本机 Codex 目录相同');
    }
    for (const section of ['sessions', 'archived_sessions']) {
      const directory = join(this.home, section);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const entry = await lstat(directory);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Rambo 会话目录不能通过链接共享：${directory}`);
      }
    }
  }

  private async refreshSourceOnce(): Promise<void> {
    try {
      const entry = await lstat(this.nativeHome);
      this.state.sourceDetected = entry.isDirectory();
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.state.sourceDetected = false;
    }
    this.state.sourcePath = this.state.sourceDetected ? this.nativeHome : null;
  }

  private async hasExistingConfiguration(skills: ManagedSkillLibrary): Promise<boolean> {
    for (const name of CODEX_HOME_SYNC_RESOURCES) {
      if (name === 'skills') continue;
      if (await hasContent(join(this.home, name))) return true;
    }
    return skills.hasResources();
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
    } catch {
      return null;
    }
  }

  private async readInitialImportState(): Promise<StoredInitialImport | null> {
    try {
      const value = JSON.parse(await readFile(this.initialImportFile, 'utf8'));
      if (
        value?.schema !== INITIAL_IMPORT_SCHEMA ||
        typeof value.completedAt !== 'string' ||
        !['imported', 'skipped-existing', 'skipped-no-native-home', 'skipped-previous-profile']
          .includes(value.result)
      ) return null;
      return value as StoredInitialImport;
    } catch {
      return null;
    }
  }

  private async writeInitialImportState(
    result: StoredInitialImport['result']
  ): Promise<void> {
    const value: StoredInitialImport = {
      schema: INITIAL_IMPORT_SCHEMA,
      completedAt: this.now().toISOString(),
      result
    };
    const temporary = `${this.initialImportFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      await renameWithRetry(temporary, this.initialImportFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async importInitialResources(skills: ManagedSkillLibrary): Promise<void> {
    if (!this.state.sourcePath) return;
    const stage = join(this.storeDirectory, `.codex-home-initial-import-${randomUUID()}`);
    const stagedNames: string[] = [];
    const committed: string[] = [];
    let importedSkills: string[] = [];
    try {
      await mkdir(stage, { recursive: true, mode: 0o700 });
      for (const name of CODEX_HOME_SYNC_RESOURCES) {
        if (name === 'skills') continue;
        const source = join(this.state.sourcePath, name);
        if (!(await exists(source))) continue;
        await cp(source, join(stage, name), {
          recursive: true,
          dereference: true,
          preserveTimestamps: true
        });
        stagedNames.push(name);
      }

      for (const name of stagedNames) {
        const destination = join(this.home, name);
        if (await exists(destination)) continue;
        await renameWithRetry(join(stage, name), destination);
        committed.push(destination);
      }

      importedSkills = await skills.importNativeRoots([
        { path: join(this.state.sourcePath, 'skills'), source: 'codex' },
        { path: this.nativeAgentSkillsRoot, source: 'agents' }
      ]);
      await this.writeInitialImportState('imported');
    } catch (error) {
      for (const directory of importedSkills.reverse()) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      for (const path of committed.reverse()) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  private async refreshWarning(): Promise<void> {
    this.state.warning = null;
    if (!this.state.sourcePath) return;
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

  private async persist(): Promise<void> {
    const value: StoredSyncState = {
      schema: SYNC_SCHEMA,
      mode: 'independent',
      lastSyncedAt: this.state.lastSyncedAt,
      decisionRequired: false
    };
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
      await renameWithRetry(temporary, this.stateFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async migrateOwnedSessions(): Promise<void> {
    const owned = new Set(
      this.getOwnedThreadIds().filter(id =>
        /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)
      )
    );
    if (!owned.size || !this.state.sourcePath) return;
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
        const relativePath = join(section, source.slice(sourceRoot.length + 1));
        const destination = join(this.home, relativePath);
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
