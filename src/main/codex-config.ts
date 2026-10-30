import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ManualApiConfig } from '../shared/contracts';
import { manualProviderToml } from './model-source';
import { renameWithRetry } from './platform/fs';

const MANUAL_PROVIDER_ID = 'rambo_manual';
const MANUAL_SECTION = `[model_providers.${MANUAL_PROVIDER_ID}]`;
const BACKUP_SUFFIX = '.rambo-base';
const MISSING_BACKUP_SUFFIX = '.rambo-base-missing';

function splitLines(source: string): string[] {
  const normalized = source.replace(/\r\n?/gu, '\n');
  if (!normalized) return [];
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function joinLines(lines: string[]): string {
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function sectionName(line: string): string | null {
  const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
  return match?.[1]?.trim() ?? null;
}

function isManualSection(line: string): boolean {
  return sectionName(line) === `model_providers.${MANUAL_PROVIDER_ID}`;
}

function topLevelStringValue(line: string, key: 'model' | 'model_provider'): string | null {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*(?:#.*)?$`, 'u'));
  if (!match) return null;
  const raw = match[1].trim();
  try {
    const value = JSON.parse(raw);
    return typeof value === 'string' ? value : null;
  } catch {
    const singleQuoted = raw.match(/^'([^']*)'$/u);
    return singleQuoted?.[1] ?? null;
  }
}

function providerValue(line: string): string | null {
  return topLevelStringValue(line, 'model_provider');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function manualSectionLines(config: ManualApiConfig): string[] {
  const provider = manualProviderToml(config);
  const name = String(provider.name);
  const baseUrl = String(provider.base_url);
  const wireApi = String(provider.wire_api);
  const envKey = String(provider.env_key);
  return [
    MANUAL_SECTION,
    `name = ${tomlString(name)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `wire_api = ${tomlString(wireApi)}`,
    `env_key = ${tomlString(envKey)}`,
    `requires_openai_auth = ${provider.requires_openai_auth ? 'true' : 'false'}`
  ];
}

/**
 * Keep the user's existing TOML intact while replacing only the managed
 * provider and the top-level provider selector used by Codex.
 */
export function mergeManualProviderConfig(source: string, config: ManualApiConfig): string {
  const lines = splitLines(source);
  const firstSection = lines.findIndex(line => sectionName(line) !== null);
  const topLevelEnd = firstSection === -1 ? lines.length : firstSection;
  const topLevel = lines.slice(0, topLevelEnd);
  const remainder = lines.slice(topLevelEnd);

  const setUniqueTopLevelValue = (
    key: 'model' | 'model_provider',
    line: string
  ) => {
    const existingIndex = topLevel.findIndex(candidate =>
      topLevelStringValue(candidate, key) !== null
    );
    if (existingIndex === -1) {
      topLevel.push(line);
      return;
    }
    topLevel[existingIndex] = line;
    for (let index = topLevel.length - 1; index > existingIndex; index -= 1) {
      if (topLevelStringValue(topLevel[index], key) !== null) {
        topLevel.splice(index, 1);
      }
    }
  };
  setUniqueTopLevelValue('model', `model = ${tomlString(config.model)}`);
  setUniqueTopLevelValue(
    'model_provider',
    `model_provider = ${tomlString(MANUAL_PROVIDER_ID)}`
  );

  let nextLines = [...topLevel, ...remainder];
  const start = nextLines.findIndex(isManualSection);
  const sectionLines = manualSectionLines(config);
  if (start === -1) {
    if (nextLines.length && nextLines.at(-1) !== '') nextLines.push('');
    nextLines.push(...sectionLines);
  } else {
    let end = nextLines.length;
    for (let index = start + 1; index < nextLines.length; index += 1) {
      if (sectionName(nextLines[index]) !== null) {
        end = index;
        break;
      }
    }
    nextLines.splice(start, end - start, ...sectionLines);
  }
  return joinLines(nextLines);
}

/** Remove only the provider entry Rambo owns; leave unrelated config untouched. */
export function removeManualProviderConfig(source: string): string {
  const lines = splitLines(source);
  const start = lines.findIndex(isManualSection);
  if (start !== -1) {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (sectionName(lines[index]) !== null) {
        end = index;
        break;
      }
    }
    lines.splice(start, end - start);
  }

  const firstSection = lines.findIndex(line => sectionName(line) !== null);
  const topLevelEnd = firstSection === -1 ? lines.length : firstSection;
  for (let index = topLevelEnd - 1; index >= 0; index -= 1) {
    if (providerValue(lines[index]) === MANUAL_PROVIDER_ID) lines.splice(index, 1);
  }
  return joinLines(lines);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await renameWithRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function backupPath(configPath: string): string {
  return `${configPath}${BACKUP_SUFFIX}`;
}

function missingBackupPath(configPath: string): string {
  return `${configPath}${MISSING_BACKUP_SUFFIX}`;
}

/**
 * Write the non-secret provider configuration into Rambo's Codex Home. The
 * original file is kept separately so switching back to local/ChatGPT can
 * restore it instead of leaving a stale manual provider behind.
 */
export async function applyManualProviderConfig(
  configPath: string,
  config: ManualApiConfig
): Promise<void> {
  const existing = await readOptional(configPath);
  const backup = backupPath(configPath);
  const missingBackup = missingBackupPath(configPath);
  if (
    await readOptional(backup) === null &&
    await readOptional(missingBackup) === null
  ) {
    if (existing === null) {
      await writeAtomic(missingBackup, '1');
    } else {
      await writeAtomic(backup, existing);
    }
  }
  await writeAtomic(configPath, mergeManualProviderConfig(existing ?? '', config));
}

export async function clearManualProviderConfig(configPath: string): Promise<void> {
  const backup = backupPath(configPath);
  const missingBackup = missingBackupPath(configPath);
  if (await readOptional(missingBackup) !== null) {
    await rm(configPath, { force: true });
    await rm(backup, { force: true });
    await rm(missingBackup, { force: true });
    return;
  }
  const original = await readOptional(backup);
  if (original !== null) {
    await writeAtomic(configPath, original);
    await rm(backup, { force: true });
    return;
  }
  const existing = await readOptional(configPath);
  if (existing === null) return;
  const next = removeManualProviderConfig(existing);
  if (next !== existing) await writeAtomic(configPath, next);
}
