import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';

const MAX_FILES = 512;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 12;

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
  return Boolean(value) && !value.startsWith('/') && !value.includes('\\') &&
    !value.includes('\0') && value.split(sep).every(part => part && part !== '.' && part !== '..');
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

export class ManagedSkillLibrary {
  readonly root: string;

  constructor(userDataDirectory: string) {
    this.root = join(resolve(userDataDirectory), 'skill-library');
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
