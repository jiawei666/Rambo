export type DesktopPlatform = 'darwin' | 'win32';

export function isDesktopPlatform(value: string): value is DesktopPlatform {
  return value === 'darwin' || value === 'win32';
}

export function desktopPlatform(value: string): DesktopPlatform {
  if (!isDesktopPlatform(value)) {
    throw new Error(`Rambo 当前只支持 macOS 和 Windows，不支持 ${value}`);
  }
  return value;
}

export function nativeExecutableName(name: string, platform: DesktopPlatform): string {
  return `${name}${platform === 'win32' ? '.exe' : ''}`;
}

/**
 * Remove the account segment from user-home paths before showing diagnostics
 * or logs. This intentionally handles both path styles because a Windows
 * diagnostic can contain a path copied from a cross-platform helper.
 */
export function redactDesktopPaths(value: string, replacement = '~'): string {
  return value
    .replace(
      /([A-Za-z]:[\\/]Users[\\/])([^\\/\s"'<>|]+)/giu,
      (_match, prefix: string) => `${prefix}${replacement}`
    )
    // Avoid matching the tail of an already-redacted Windows path such as
    // C:/Users/alice, which would otherwise become C:~/alice.
    .replace(/(?<![A-Za-z]:)\/Users\/[^/\s"'<>|]+/gu, replacement);
}

export function platformDisplayName(platform: DesktopPlatform): 'macOS' | 'Windows' {
  return platform === 'darwin' ? 'macOS' : 'Windows';
}

export function fileManagerName(platform: DesktopPlatform): 'Finder' | '文件资源管理器' {
  return platform === 'darwin' ? 'Finder' : '文件资源管理器';
}

export function revealInFileManagerLabel(platform: DesktopPlatform): string {
  return platform === 'darwin' ? '在 Finder 中显示' : '在文件资源管理器中显示';
}

export function revealInFileManagerDoneLabel(platform: DesktopPlatform): string {
  return platform === 'darwin' ? '已在 Finder 中显示' : '已在文件资源管理器中显示';
}

export function otherPlatformPathsLabel(platform: DesktopPlatform): string {
  return platform === 'darwin' ? '其他 Mac 路径' : '其他 Windows 路径';
}

export function loginAtStartupDescription(platform: DesktopPlatform): string {
  return platform === 'darwin'
    ? '登录 macOS 后启动 Rambo，让本机任务继续运行。'
    : '登录 Windows 后启动 Rambo，并在后台保持本机任务运行。';
}

export function wechatConnectorDescription(platform: DesktopPlatform): {
  summary: string;
  process: string;
  detail: string;
} {
  if (platform === 'darwin') {
    return {
      summary: 'Rambo 将读取这台 Mac 上微信已保存的聊天消息。macOS 使用 Rambo 管理的临时微信副本，原微信应用不会被修改。',
      process: '连接时会先退出当前微信，创建独立副本并加入调试附加权限后重签，再通过 Frida 捕获本机数据库密钥。完成后会清理临时副本，并在原微信当时处于打开状态时重新启动它。',
      detail: '密钥只在本机内存中处理，不会交给 Bot，也不会写入日志。请保持捕获进程运行并打开聊天、图片或语音；缺少数据库时可继续补抓。'
    };
  }
  return {
    summary: 'Rambo 将读取这台 Windows 电脑上微信已保存的聊天消息，不会复制、重签或修改微信。',
    process: '连接时直接扫描 Weixin.exe 进程内存中的数据库密钥候选，并用数据库首页 HMAC 在本机验证。读取进程内存通常需要以管理员身份运行 Rambo。',
    detail: '密钥只在本机内存中处理，不会交给 Bot，也不会写入日志。若权限不足、没有候选密钥或微信升级后密钥失效，向导会显示具体诊断并允许重试。'
  };
}
