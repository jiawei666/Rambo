const TARGET_PATTERN = /^(darwin|win32)-(arm64|x64)$/u;

export function parseBuildTarget(value) {
  const key = String(value ?? '').trim();
  const match = TARGET_PATTERN.exec(key);
  if (!match) {
    throw new Error(
      `不支持的构建目标：${key || '(空)'}。只支持 darwin-arm64、darwin-x64、win32-x64、win32-arm64。`
    );
  }
  return {
    key,
    platform: match[1],
    arch: match[2]
  };
}

export function currentBuildTarget(environment = process.env) {
  return parseBuildTarget(
    environment.RAMBO_BUILD_TARGET?.trim() ||
      environment.RAMBO_RUNTIME_TARGET?.trim() ||
      `${process.platform}-${process.arch}`
  );
}

export function assertNativeBuildTarget(target, action = '构建') {
  if (process.platform !== target.platform || process.arch !== target.arch) {
    throw new Error(
      `${action} ${target.key} 必须在目标平台上用匹配的 Node/Electron 架构执行；` +
      `当前是 ${process.platform}-${process.arch}。` +
      '请在对应的 macOS/Windows 构建机上执行，避免把宿主平台二进制混入安装包。'
    );
  }
}

export function executableSuffix(platform) {
  return platform === 'win32' ? '.exe' : '';
}

export function pathDelimiter(platform) {
  return platform === 'win32' ? ';' : ':';
}

export function isSafeArchiveEntry(entry) {
  if (!entry || entry.includes('\0')) return false;
  const normalized = entry.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized)) return false;
  return !normalized.split('/').some(part => part === '..');
}
