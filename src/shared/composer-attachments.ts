import type { ComposerAttachment } from './contracts';

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'webp']);
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

export function composerAttachmentName(path: string): string {
  const name = path.split(/[\\/]/u).filter(Boolean).at(-1);
  return name || path;
}

export function composerAttachmentKind(path: string): ComposerAttachment['kind'] {
  const match = /\.([^.\\/]+)$/u.exec(path);
  return match && IMAGE_EXTENSIONS.has(match[1].toLowerCase()) ? 'image' : 'file';
}

export function dedupeComposerAttachmentPaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

export function dedupeComposerAttachments(attachments: ComposerAttachment[]): ComposerAttachment[] {
  const seen = new Set<string>();
  return attachments.filter(attachment => {
    if (seen.has(attachment.path)) return false;
    seen.add(attachment.path);
    return true;
  });
}

export function composeComposerMessage(draft: string, paths: string[]): string {
  const body = draft.trimEnd();
  return [body, ...dedupeComposerAttachmentPaths(paths)].filter(Boolean).join('\n');
}

export function imageExtensionForMime(mimeType: string): string | null {
  return IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()] ?? null;
}

export function parseImageDataUrl(value: string): {
  mimeType: string;
  extension: string;
  base64: string;
} | null {
  const match = /^data:(image\/(?:avif|bmp|gif|jpeg|png|webp));base64,([a-z\d+/=\r\n]+)$/iu.exec(value.trim());
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const extension = imageExtensionForMime(mimeType);
  const base64 = match[2].replace(/\s+/gu, '');
  if (!extension || !base64 || base64.length % 4 === 1) return null;
  return { mimeType, extension, base64 };
}
