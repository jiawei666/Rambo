import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Shared resources only. Never link session directories or state databases. */
const SHARED_RESOURCES = ['auth.json', 'config.toml', 'skills', 'plugins', 'rules', 'AGENTS.md', 'managed_config.toml', 'mcp-auth.json'];

async function linkResource(source: string, destination: string): Promise<void> {
  try {
    const entry = await lstat(destination);
    if (!entry.isSymbolicLink() || resolve(dirname(destination), await readlink(destination)) !== resolve(source)) {
      throw new Error(`Codex 共享资源路径冲突，未覆盖：${destination}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await symlink(source, destination);
  }
}

async function sessionFiles(root: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
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

export async function prepareRuntimeHome(
  nativeHome: string,
  storeDirectory: string,
  ownedThreadIds: readonly string[] = []
): Promise<string> {
  nativeHome = resolve(nativeHome);
  const home = join(resolve(storeDirectory), 'codex-home');
  await mkdir(nativeHome, { recursive: true });
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (await realpath(home) === await realpath(nativeHome)) throw new Error('Rambo 会话目录不能与本机 Codex 目录相同');
  // Do not silently bypass a configured keyring or read an obsolete file fallback.
  let config = '';
  try { config = await readFile(join(nativeHome, 'config.toml'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const topLevel = config.split(/^\s*\[/m)[0];
  if (/^\s*cli_auth_credentials_store\s*=\s*["'](?:keyring|auto)["']/m.test(topLevel)) {
    throw new Error('本机 Codex 使用 Keychain/auto 认证，当前共享认证文件方案不兼容；未修改本机登录态。');
  }
  for (const name of SHARED_RESOURCES) {
    const source = join(nativeHome, name);
    // Auth/config links remain stable even before first login/config creation.
    if (name !== 'auth.json' && name !== 'config.toml') {
      try { await lstat(source); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    await linkResource(source, join(home, name));
  }
  for (const section of ['sessions', 'archived_sessions']) {
    const directory = join(home, section);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== join(await realpath(home), section)) {
      throw new Error(`Rambo 会话目录不能通过链接共享：${directory}`);
    }
  }
  const owned = new Set(ownedThreadIds.filter(id => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)));
  if (!owned.size) return home;
  const marker = join(home, 'rambo-imported-thread-ids.json');
  let imported: string[] = [];
  try {
    const value = JSON.parse(await readFile(marker, 'utf8'));
    if (!Array.isArray(value) || value.some(path => typeof path !== 'string')) throw new Error('Rambo 会话迁移记录无效');
    imported = value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const completed = new Set(imported);
  const migrated = new Set<string>();
  // Copies preserve the originals as rollback data. Never overwrite a resumed copy.
  for (const section of ['sessions', 'archived_sessions']) {
    const sourceRoot = join(nativeHome, section);
    for (const source of await sessionFiles(sourceRoot)) {
      const match = source.match(/-([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.jsonl(?:\.zst)?$/i);
      if (!match || !owned.has(match[1])) continue;
      const relative = join(section, source.slice(sourceRoot.length + 1));
      if (completed.has(match[1])) continue;
      const destination = join(home, relative);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      if (!(await realpath(dirname(destination))).startsWith(`${await realpath(home)}/`)) throw new Error('Rambo 会话迁移路径越界');
      try { await lstat(destination); migrated.add(match[1]); continue; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const temporary = `${destination}.${randomUUID()}.rambo-import`;
      try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
      migrated.add(match[1]);
    }
  }
  const markerTemporary = `${marker}.${randomUUID()}`;
  try {
    await writeFile(markerTemporary, JSON.stringify([...new Set([...completed, ...migrated])]), { mode: 0o600, flag: 'wx' });
    await rename(markerTemporary, marker);
  } finally { await rm(markerTemporary, { force: true }); }
  return home;
}
