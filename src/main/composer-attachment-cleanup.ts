import {
  lstatSync,
  readdirSync,
  unlinkSync
} from 'node:fs';
import { join } from 'node:path';
import type { ComposerAttachmentCleanupResult } from '../shared/contracts';

export const COMPOSER_ATTACHMENT_UNREFERENCED_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const COMPOSER_ATTACHMENT_REFERENCED_RETENTION_MS = 30 * 24 * 60 * 60_000;

const PASTED_IMAGE_NAME =
  /^pasted-image-(\d{13})-([0-9a-f]{8})\.(?:png|jpe?g|webp|gif|avif|bmp)$/iu;

interface AttachmentStat {
  birthtimeMs: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface CleanupComposerAttachmentsOptions {
  directory: string;
  now?: () => number;
  draftPaths?: () => Iterable<string>;
  isReferenced?: (path: string) => boolean;
  statPath?: (path: string) => AttachmentStat;
  unreferencedRetentionMs?: number;
  referencedRetentionMs?: number;
}

function generatedAt(stat: AttachmentStat): number {
  const timestamps = [stat.birthtimeMs, stat.mtimeMs].filter(value => value > 0);
  return timestamps.length ? Math.min(...timestamps) : Number.POSITIVE_INFINITY;
}

export function cleanupComposerAttachments(
  options: CleanupComposerAttachmentsOptions
): ComposerAttachmentCleanupResult {
  const now = options.now?.() ?? Date.now();
  const statPath = options.statPath ?? lstatSync;
  const isReferenced = options.isReferenced ?? (() => false);
  const draftPaths = new Set(options.draftPaths?.() ?? []);
  const unreferencedRetentionMs =
    options.unreferencedRetentionMs ?? COMPOSER_ATTACHMENT_UNREFERENCED_RETENTION_MS;
  const referencedRetentionMs =
    options.referencedRetentionMs ?? COMPOSER_ATTACHMENT_REFERENCED_RETENTION_MS;
  const result: ComposerAttachmentCleanupResult = {
    deletedPaths: [],
    draftProtectedPaths: [],
    referencedPaths: [],
    errors: []
  };

  let directoryStat: AttachmentStat;
  try {
    directoryStat = statPath(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    result.errors.push({
      path: options.directory,
      message: error instanceof Error ? error.message : String(error)
    });
    return result;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return result;

  let entries;
  try {
    entries = readdirSync(options.directory, { withFileTypes: true });
  } catch (error) {
    result.errors.push({
      path: options.directory,
      message: error instanceof Error ? error.message : String(error)
    });
    return result;
  }

  for (const entry of entries) {
    if (!PASTED_IMAGE_NAME.test(entry.name)) continue;
    const path = join(options.directory, entry.name);
    let referenced = false;
    try {
      const stat = statPath(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const age = now - generatedAt(stat);
      if (draftPaths.has(path)) {
        result.draftProtectedPaths.push(path);
        continue;
      }
      referenced = isReferenced(path);
      if (referenced) result.referencedPaths.push(path);
      const retention = referenced
        ? referencedRetentionMs
        : unreferencedRetentionMs;
      if (age < retention) continue;
      unlinkSync(path);
      result.deletedPaths.push(path);
    } catch (error) {
      result.errors.push({
        path,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return result;
}
