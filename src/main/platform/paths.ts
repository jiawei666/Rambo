import { posix, win32 } from 'node:path';

function platformPath(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function stripTrailingSeparators(value: string, platform: NodeJS.Platform): string {
  const api = platformPath(platform);
  const root = api.parse(value).root;
  let normalized = api.normalize(value);
  while (normalized.length > root.length &&
      (normalized.endsWith('/') || normalized.endsWith('\\'))) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/** Canonical comparison key for paths; Windows paths are case-insensitive. */
export function pathKey(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = stripTrailingSeparators(value, platform);
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return pathKey(left, platform) === pathKey(right, platform);
}

export function isPathInside(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const api = platformPath(platform);
  const normalizedRoot = stripTrailingSeparators(root, platform);
  const normalizedCandidate = stripTrailingSeparators(candidate, platform);
  const comparisonRoot = platform === 'win32'
    ? normalizedRoot.toLocaleLowerCase('en-US')
    : normalizedRoot;
  const comparisonCandidate = platform === 'win32'
    ? normalizedCandidate.toLocaleLowerCase('en-US')
    : normalizedCandidate;
  const relative = api.relative(comparisonRoot, comparisonCandidate);
  return Boolean(relative) && relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

export function isPathInsideOrEqual(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return samePath(root, candidate, platform) || isPathInside(root, candidate, platform);
}
