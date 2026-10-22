import type { Store } from './store';

export const LOGIN_AT_STARTUP_SETTING = 'launchAtLogin';

export interface LoginItemAdapter {
  readOpenAtLogin(): boolean;
  setOpenAtLogin(enabled: boolean): void;
}

export interface ElectronLoginItemApp {
  isPackaged: boolean;
  platform: string;
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export interface ElectronLoginItemOptions {
  allowSystemChanges?: boolean;
}

export function readLoginAtStartup(store: Store): boolean {
  return store.settings()[LOGIN_AT_STARTUP_SETTING] !== 'false';
}

/**
 * Keeps development and automated acceptance runs away from the user's real
 * macOS Login Items. Only a packaged app on macOS reaches Electron's system API,
 * and callers can explicitly disable system changes for automated runs.
 */
export function createElectronLoginItemAdapter(
  appLike: ElectronLoginItemApp,
  options: ElectronLoginItemOptions = {}
): LoginItemAdapter {
  const canUseSystemLoginItem =
    appLike.isPackaged &&
    appLike.platform === 'darwin' &&
    options.allowSystemChanges !== false;
  return {
    readOpenAtLogin: () => canUseSystemLoginItem ? appLike.getLoginItemSettings().openAtLogin : false,
    setOpenAtLogin: enabled => {
      if (canUseSystemLoginItem) appLike.setLoginItemSettings({ openAtLogin: enabled });
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
