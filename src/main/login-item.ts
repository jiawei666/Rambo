import type { Store } from './store';

export const LOGIN_AT_STARTUP_SETTING = 'launchAtLogin';

export interface LoginItemAdapter {
  readOpenAtLogin(): boolean;
  setOpenAtLogin(enabled: boolean): void;
}

export interface ElectronLoginItemApp {
  isPackaged: boolean;
  platform: string;
  getLoginItemSettings(settings?: { path?: string; args?: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    path?: string;
    args?: string[];
  }): void;
  getPath?: (name: 'exe') => string;
}

export interface ElectronLoginItemOptions {
  allowSystemChanges?: boolean;
  /** Windows launches through an explicit executable path and hidden startup argument. */
  windowsArgs?: string[];
}

export function readLoginAtStartup(store: Store): boolean {
  return store.settings()[LOGIN_AT_STARTUP_SETTING] !== 'false';
}

/**
 * Keeps development and automated acceptance runs away from the user's real
 * macOS Login Items and Windows startup registration. Only a packaged desktop
 * app reaches Electron's system API, and automated runs can disable changes.
 */
export function createElectronLoginItemAdapter(
  appLike: ElectronLoginItemApp,
  options: ElectronLoginItemOptions = {}
): LoginItemAdapter {
  const canUseSystemLoginItem =
    appLike.isPackaged &&
    (appLike.platform === 'darwin' || appLike.platform === 'win32') &&
    options.allowSystemChanges !== false;
  const windowsSettings = appLike.platform === 'win32'
    ? {
        path: appLike.getPath?.('exe'),
        args: options.windowsArgs ?? ['--hidden']
      }
    : {};
  return {
    readOpenAtLogin: () => canUseSystemLoginItem
      ? appLike.getLoginItemSettings(windowsSettings).openAtLogin
      : false,
    setOpenAtLogin: enabled => {
      if (canUseSystemLoginItem) {
        appLike.setLoginItemSettings({ openAtLogin: enabled, ...windowsSettings });
      }
    }
  };
}

export class LoginItemController {
  constructor(private readonly store: Store, private readonly adapter: LoginItemAdapter) {}

  applyStoredPreference(): void {
    const enabled = readLoginAtStartup(this.store);
    if (this.adapter.readOpenAtLogin() !== enabled) this.adapter.setOpenAtLogin(enabled);
  }

  setEnabled(enabled: boolean): void {
    this.store.setSetting(LOGIN_AT_STARTUP_SETTING, String(enabled));
    this.adapter.setOpenAtLogin(enabled);
  }
}
