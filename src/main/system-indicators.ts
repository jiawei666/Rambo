import { join } from 'node:path';

export type RunningBotIndicator = {
  botId: string;
  name: string;
  running: boolean;
};

export type SystemIndicatorDeps<TImage = unknown, TMenu = unknown> = {
  platform: NodeJS.Platform;
  assetsDirectory: string;
  loadImage: (path: string, template: boolean) => TImage;
  theme: {
    isDark: () => boolean;
    onChange: (listener: () => void) => () => void;
  };
  createTray: (image: TImage) => {
    setImage: (image: TImage) => void;
    setToolTip: (toolTip: string) => void;
    setContextMenu: (menu: TMenu) => void;
    setIgnoreDoubleClickEvents: (ignore: boolean) => void;
    destroy: () => void;
  };
  createMenu: (items: Array<Record<string, unknown>>) => TMenu;
  showApp: () => void;
  openBot: (botId: string) => void;
  quit: () => void;
};

export class SystemIndicators<TImage = unknown, TMenu = unknown> {
  private tray: ReturnType<SystemIndicatorDeps<TImage, TMenu>['createTray']> | null = null;
  private bots: RunningBotIndicator[] = [];
  private brand: TImage | null = null;
  private dark = false;
  private unsubscribeTheme: (() => void) | null = null;

  constructor(private readonly deps: SystemIndicatorDeps<TImage, TMenu>) {}

  start(): void {
    if ((this.deps.platform !== 'darwin' && this.deps.platform !== 'win32') || this.tray) return;
    this.dark = this.deps.theme.isDark();
    this.brand = this.loadBrand();
    this.tray = this.deps.createTray(this.brand);
    if (this.deps.platform === 'darwin') this.tray.setIgnoreDoubleClickEvents(true);
    if (this.deps.platform === 'win32') {
      this.unsubscribeTheme = this.deps.theme.onChange(() => this.refreshWindowsTheme());
    }
    this.tray.setToolTip('Rambo');
    this.renderMenu();
  }

  update(bots: RunningBotIndicator[]): void {
    this.bots = bots;
    this.renderMenu();
  }

  private renderMenu(): void {
    if (!this.tray) return;
    const items: Array<Record<string, unknown>> = [];
    if (this.bots.length) {
      items.push({ label: 'Bots', enabled: false });
      for (const bot of this.bots.slice(0, 5)) {
        items.push({
          label: `${bot.running ? '● ' : ''}${bot.name}`,
          icon: bot.running ? this.brand : undefined,
          click: () => this.deps.openBot(bot.botId)
        });
      }
      items.push({ type: 'separator' });
    }
    items.push(
      { label: '显示 Rambo', click: this.deps.showApp },
      { type: 'separator' },
      { label: '退出 Rambo', click: this.deps.quit }
    );
    this.tray.setContextMenu(this.deps.createMenu(items));
  }

  private loadBrand(): TImage {
    const template = this.deps.platform === 'darwin';
    const darkWindows = this.deps.platform === 'win32' && this.dark;
    const path = join(this.deps.assetsDirectory, darkWindows ? 'brand-dark.png' : 'brand.png');
    const image = this.deps.loadImage(path, template);
    if (!image) throw new Error(`无法读取系统托盘图标：${path}`);
    return image;
  }

  private refreshWindowsTheme(): void {
    if (this.deps.platform !== 'win32' || !this.tray) return;
    const dark = this.deps.theme.isDark();
    if (dark === this.dark) return;
    this.dark = dark;
    this.brand = this.loadBrand();
    this.tray.setImage(this.brand);
    this.renderMenu();
  }

  dispose(): void {
    this.unsubscribeTheme?.();
    this.unsubscribeTheme = null;
    this.tray?.destroy();
    this.tray = null;
  }
}
