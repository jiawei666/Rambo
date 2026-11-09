import { constants } from 'node:fs';
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rmdir,
  rename,
  rm,
  stat
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';

const MAX_FILES = 512;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 12;
const RESOURCE_SCAN_DEPTH = 3;

export class ManagedSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedSkillError';
  }
}

export interface ManagedSkill {
  id: string;
  name: string;
  description: string;
  directory: string;
}

interface FileRecord {
  absolute: string;
  relative: string;
  size: number;
}

function safeRelativePath(value: string): boolean {
  return Boolean(value) && !isAbsolute(value) && !win32.isAbsolute(value) &&
    !value.includes('\0') &&
    value.split(/[\\/]+/u).every(part => part && part !== '.' && part !== '..');
}

function boundedDescription(text: string): string {
  const frontMatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? '';
  const line = frontMatter.split(/\r?\n/u).find(item => /^description\s*:/u.test(item));
  if (!line) return '';
  return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/gu, '').slice(0, 240);
}

function skillName(text: string, fallback: string): string {
  const frontMatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? '';
  const line = frontMatter.split(/\r?\n/u).find(item => /^name\s*:/u.test(item));
  const value = line?.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/gu, '') ?? '';
  return (value || fallback).slice(0, 120);
}

async function assertDirectory(root: string): Promise<void> {
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ManagedSkillError('请选择普通文件夹，不能使用符号链接。');
  }
}

async function collectFiles(root: string): Promise<FileRecord[]> {
  const canonicalRoot = await realpath(root);
  const files: FileRecord[] = [];
  let total = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new ManagedSkillError('Skill 目录层级过深。');
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (name === '.git' || name === 'node_modules') continue;
      const absolute = join(directory, name);
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) {
        throw new ManagedSkillError(`Skill 目录包含符号链接，未导入：${name}`);
      }
      const pathRelative = relative(canonicalRoot, await realpath(absolute));
      if (!safeRelativePath(pathRelative)) throw new ManagedSkillError('Skill 路径越界，未导入。');
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new ManagedSkillError(`Skill 目录包含不支持的文件类型：${name}`);
      if (entry.size > MAX_FILE_BYTES) throw new ManagedSkillError(`Skill 文件过大，未导入：${name}`);
      total += entry.size;
      if (total > MAX_TOTAL_BYTES) throw new ManagedSkillError('Skill 总大小超过 32 MB，未导入。');
      files.push({ absolute, relative: pathRelative, size: entry.size });
      if (files.length > MAX_FILES) throw new ManagedSkillError('Skill 文件数超过 512，未导入。');
    }
  };

  await visit(root, 0);
  if (!files.some(file => file.relative === 'SKILL.md')) {
    throw new ManagedSkillError('所选文件夹根目录必须包含 SKILL.md。');
  }
  return files;
}

function normalizeId(value: string): string {
  const id = value.trim().toLocaleLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!id || id.length > 80 || id === '.' || id === '..') {
    throw new ManagedSkillError('Skill 名称无法转换为稳定 ID。');
  }
  return id;
}

interface DiscoveredSkillDirectory {
  directory: string;
  relativeDirectory: string;
}

async function discoveredSkillDirectories(root: string): Promise<DiscoveredSkillDirectory[]> {
  const results: DiscoveredSkillDirectory[] = [];
  const seen = new Set<string>();
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > RESOURCE_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      const info = await stat(path);
      if (info.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.name === 'SKILL.md' && info.isFile()) {
        const skillDirectory = dirname(path);
        if (seen.has(skillDirectory)) continue;
        seen.add(skillDirectory);
        results.push({
          directory: skillDirectory,
          relativeDirectory: relative(root, skillDirectory)
        });
      }
    }
  };
  await visit(root, 0);
  return results;
}

async function treeFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory)).sort();
    for (const name of entries) {
      if (name === '.git' || name === 'node_modules') continue;
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = await stat(path);
      if (info.isDirectory()) {
        hash.update(`directory:${relativePath}\0`);
        await visit(path, relativePath);
      } else if (info.isFile()) {
        hash.update(`file:${relativePath}:${info.size}\0`);
        hash.update(await readFile(path));
      } else {
        throw new ManagedSkillError(`Skill 包含不支持的文件类型：${relativePath}`);
      }
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}

function uniqueSkillDirectoryName(name: string, suffix: string, index: number): string {
  return `${name}--${suffix}${index > 1 ? `-${index}` : ''}`;
}

function relativeWithDirectoryName(path: string, directoryName: string): string {
  const parent = dirname(path);
  return parent === '.' ? directoryName : join(parent, directoryName);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class ManagedSkillLibrary {
  readonly root: string;
  readonly legacyRoot: string;
  private readonly userDataDirectory: string;

  constructor(userDataDirectory: string) {
    this.userDataDirectory = resolve(userDataDirectory);
    this.root = join(this.userDataDirectory, 'codex-home', 'skills');
    this.legacyRoot = join(this.userDataDirectory, 'skill-library');
  }

  async hasResources(): Promise<boolean> {
    for (const root of [this.root, this.legacyRoot]) {
      if ((await discoveredSkillDirectories(root)).length) return true;
    }
    return false;
  }

  /** Move the legacy library into Codex Home without replacing existing Skills. */
  async migrateLegacyRoot(): Promise<void> {
    let legacyInfo;
    try {
      legacyInfo = await lstat(this.legacyRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!legacyInfo.isDirectory() || legacyInfo.isSymbolicLink()) {
      throw new ManagedSkillError('旧 Skill 库不是普通目录，无法安全迁移。');
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const scanExistingById = async () => {
      const found = new Map<string, Array<{ directory: string; fingerprint: string }>>();
      for (const skill of await discoveredSkillDirectories(this.root)) {
        const id = basename(skill.directory).toLocaleLowerCase();
        const entries = found.get(id) ?? [];
        entries.push({ directory: skill.directory, fingerprint: await treeFingerprint(skill.directory) });
        found.set(id, entries);
      }
      return found;
    };
    let existingById = await scanExistingById();

    for (const entry of (await readdir(this.legacyRoot, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const source = join(this.legacyRoot, entry.name);
      const sourceInfo = await lstat(source);
      if (sourceInfo.isSymbolicLink()) {
        throw new ManagedSkillError(`旧 Skill 库包含符号链接，未迁移：${entry.name}`);
      }
      const id = entry.name.toLocaleLowerCase();
      const existing = existingById.get(id) ?? [];
      if (sourceInfo.isDirectory() && existing.length) {
        const sourceFingerprint = await treeFingerprint(source);
        if (existing.some(item => item.fingerprint === sourceFingerprint)) {
          await rm(source, { recursive: true, force: true });
          continue;
        }
        // The legacy library owns the established `skill:<basename>` grants.
        // Keep that ID for the legacy folder and move each conflicting Home
        // copy to a stable, separately discoverable ID before moving it in.
        for (const current of existing) {
          let index = 1;
          let displaced = '';
          while (true) {
            const name = uniqueSkillDirectoryName(basename(current.directory), 'codex', index++);
            const candidate = join(dirname(current.directory), name);
            if (existingById.has(name.toLocaleLowerCase()) || await exists(candidate)) continue;
            displaced = candidate;
            break;
          }
          await rename(current.directory, displaced);
          existingById = await scanExistingById();
        }
      }

      let destination = join(this.root, entry.name);
      if (await exists(destination)) {
        let index = 1;
        while (await exists(destination)) {
          const name = uniqueSkillDirectoryName(entry.name, 'codex', index++);
          const candidate = join(this.root, name);
          if (existingById.has(name.toLocaleLowerCase()) || await exists(candidate)) continue;
          await rename(destination, candidate);
          existingById = await scanExistingById();
          destination = join(this.root, entry.name);
        }
      }
      await rename(source, destination);
      existingById = await scanExistingById();
    }
    await rmdir(this.legacyRoot).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  /** Import only Skills discoverable by the existing Codex and Agent scanners. */
  async importNativeRoots(
    roots: ReadonlyArray<{ path: string; source: 'codex' | 'agents' }>
  ): Promise<string[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stageRoot = join(this.userDataDirectory, `.codex-skills-import-${randomUUID()}`);
    const existingById = new Map<string, Array<{ directory: string; fingerprint: string }>>();
    for (const skill of await discoveredSkillDirectories(this.root)) {
      const id = basename(skill.directory).toLocaleLowerCase();
      const entries = existingById.get(id) ?? [];
      entries.push({ directory: skill.directory, fingerprint: await treeFingerprint(skill.directory) });
      existingById.set(id, entries);
    }

    const plans: Array<{ staged: string; destination: string }> = [];
    const imported: string[] = [];
    try {
      await mkdir(stageRoot, { recursive: true, mode: 0o700 });
      for (const root of roots) {
        const sourceRoot = resolve(root.path);
        for (const skill of await discoveredSkillDirectories(sourceRoot)) {
          const baseName = basename(skill.directory);
          const baseId = baseName.toLocaleLowerCase();
          const fingerprint = await treeFingerprint(skill.directory);
          const matching = existingById.get(baseId) ?? [];
          if (matching.some(item => item.fingerprint === fingerprint)) continue;

          let directoryName = baseName;
          let destinationRelative = skill.relativeDirectory;
          let id = baseId;
          if (matching.length || await exists(join(this.root, destinationRelative))) {
            const suffix = root.source === 'agents' ? 'agents' : 'codex';
            let index = 1;
            while (true) {
              directoryName = uniqueSkillDirectoryName(baseName, suffix, index++);
              id = directoryName.toLocaleLowerCase();
              const sameId = existingById.get(id) ?? [];
              if (sameId.some(item => item.fingerprint === fingerprint)) {
                destinationRelative = '';
                break;
              }
              if (sameId.length) continue;
              destinationRelative = relativeWithDirectoryName(skill.relativeDirectory, directoryName);
              if (!(await exists(join(this.root, destinationRelative)))) break;
            }
            if (!destinationRelative) continue;
          }

          const destination = join(this.root, destinationRelative);
          const staged = join(stageRoot, String(plans.length));
          await cp(skill.directory, staged, {
            recursive: true,
            dereference: true,
            preserveTimestamps: true,
            filter: path => !['.git', 'node_modules'].includes(basename(path))
          });
          plans.push({ staged, destination });
          const entries = existingById.get(id) ?? [];
          entries.push({ directory: destination, fingerprint });
          existingById.set(id, entries);
        }
      }

      for (const plan of plans) {
        await mkdir(dirname(plan.destination), { recursive: true, mode: 0o700 });
        if (await exists(plan.destination)) {
          throw new ManagedSkillError(`目标 Skill 已存在，未覆盖：${plan.destination}`);
        }
        await rename(plan.staged, plan.destination);
        imported.push(plan.destination);
      }
      return imported;
    } catch (error) {
      for (const directory of imported.reverse()) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      if (error instanceof ManagedSkillError) throw error;
      throw new ManagedSkillError(error instanceof Error ? error.message : '导入本机 Skills 失败。');
    } finally {
      await rm(stageRoot, { recursive: true, force: true });
    }
  }

  async list(): Promise<ManagedSkill[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const skills: ManagedSkill[] = [];
    for (const name of (await readdir(this.root)).sort()) {
      if (name.startsWith('.')) continue;
      const directory = join(this.root, name);
      try {
        const entry = await lstat(directory);
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const skillPath = join(directory, 'SKILL.md');
        const text = (await readFile(skillPath, 'utf8')).slice(0, 16_000);
        skills.push({
          id: name,
          name: skillName(text, name),
          description: boundedDescription(text),
          directory
        });
      } catch {
        // Incomplete imported directories stay invisible and cannot be enabled.
      }
    }
    return skills;
  }

  async import(sourceDirectory: string): Promise<ManagedSkill> {
    const source = resolve(sourceDirectory);
    await assertDirectory(source);
    const files = await collectFiles(source);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rawName = basename(source);
    const id = normalizeId(rawName);
    const destination = join(this.root, id);
    try {
      await access(destination);
      throw new ManagedSkillError(`技能库中已有同名 Skill：${id}`);
    } catch (error) {
      if (error instanceof ManagedSkillError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporary = join(this.root, `.${id}.${randomUUID()}.import`);
    try {
      await mkdir(temporary, { mode: 0o700 });
      for (const file of files) {
        const target = resolve(temporary, file.relative);
        const rel = relative(temporary, target);
        if (!safeRelativePath(rel)) throw new ManagedSkillError('Skill 复制路径越界，未导入。');
        await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
        await copyFile(file.absolute, target, constants.COPYFILE_EXCL);
      }
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (error instanceof ManagedSkillError) throw error;
      throw new ManagedSkillError(error instanceof Error ? error.message : '导入 Skill 失败。');
    }

    const text = (await readFile(join(destination, 'SKILL.md'), 'utf8')).slice(0, 16_000);
    return {
      id,
      name: skillName(text, id),
      description: boundedDescription(text),
      directory: destination
    };
  }
}
