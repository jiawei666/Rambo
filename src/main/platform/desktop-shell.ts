import type {
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions
} from 'electron';
import type { DesktopPlatform } from '../../shared/platform';

export function browserWindowOptions(
  platform: DesktopPlatform,
  base: BrowserWindowConstructorOptions,
  darkMode = false
): BrowserWindowConstructorOptions {
  if (platform === 'darwin') {
    return {
      ...base,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 }
    };
  }
  return {
    ...base,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: darkMode ? '#121212' : '#fcfcfc',
      symbolColor: darkMode ? '#f5f5f5' : '#1c1c1c',
      height: 44
    }
  };
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
  // Windows uses the application-owned title bar. The tray menu remains the
  // explicit place to show, reopen, or quit Rambo.
  return [];
}
