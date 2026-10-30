import type {
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions
} from 'electron';
import type { DesktopPlatform } from '../../shared/platform';

export function browserWindowOptions(
  platform: DesktopPlatform,
  base: BrowserWindowConstructorOptions
): BrowserWindowConstructorOptions {
  if (platform === 'darwin') {
    return {
      ...base,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 }
    };
  }
  return { ...base };
}

export function trayImageIsTemplate(platform: DesktopPlatform): boolean {
  return platform === 'darwin';
}

export function applicationMenuTemplate(
  platform: DesktopPlatform,
  showWindow: () => void
): MenuItemConstructorOptions[] {
  if (platform === 'darwin') {
    return [
      {
        label: 'Rambo',
        submenu: [
          { role: 'about' },
          { label: '显示 Rambo', click: showWindow },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { role: 'front' }
        ]
      }
    ];
  }
  return [
    {
      label: '文件',
      submenu: [
        { label: '显示 Rambo', click: showWindow },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' }
      ]
    }
  ];
}
