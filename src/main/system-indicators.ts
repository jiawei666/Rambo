import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export type RunningBotIndicator = {
  botId: string;
  name: string;
  running: boolean;
};

type Timer = ReturnType<typeof setTimeout>;

export type SystemIndicatorDeps<TImage = unknown, TMenu = unknown> = {
  platform: NodeJS.Platform;
  assetsDirectory: string;
  loadImage: (path: string, template: boolean) => TImage;
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
  schedule: (callback: () => void, delay: number) => Timer;
  cancel: (timer: Timer) => void;
  random: () => number;
};

type TrayMode = 'idle' | 'working';

const BLINK_HOLDS = [18, 18, 18, 35, 75, 75, 75, 50];
const WORKING_HOLDS = [180, 180, 180, 180];
const REST_HOLD_MS = 4_000;
const GLANCE_HOLD_MS = 700;
function readPngNames(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter(name => /^\d\d-.*\.png$/.test(name) && !name.startsWith('99-') && !name.includes('@2x'))
      .sort();
  } catch {
    return [];
  }
}

export class SystemIndicators<TImage = unknown, TMenu = unknown> {
  private tray: ReturnType<SystemIndicatorDeps<TImage, TMenu>['createTray']> | null = null;
  private timer: Timer | null = null;
  private mode: TrayMode = 'idle';
  private bots: RunningBotIndicator[] = [];
  private idleFrames = new Map<string, TImage>();
  private workingFrames: TImage[] = [];
  private brand: TImage | null = null;
  private disposed = false;

  constructor(private readonly deps: SystemIndicatorDeps<TImage, TMenu>) {}

  start(): void {
    if ((this.deps.platform !== 'darwin' && this.deps.platform !== 'win32') || this.tray) return;
    const directory = this.deps.assetsDirectory;
    const names = readPngNames(directory);
    if (!names.length) {
      // A packaged build must keep the menu-bar indicator visible; a missing
      // resource is a packaging error, not a reason to silently disappear.
      throw new Error(`系统托盘图标资源缺失：${directory}`);
    }
    const load = (name: string) => {
      // Template mode is macOS-only. Windows uses the colored source image.
      const image = this.deps.loadImage(join(directory, name), this.deps.platform === 'darwin');
      if (!image) throw new Error(`无法读取系统托盘图标：${name}`);
      return image;
    };
    this.brand = load('brand.png');
    for (const name of names) this.idleFrames.set(name.replace(/^\d\d-/, '').replace(/\.png$/, ''), load(name));
    const filenames = new Set(readdirSync(directory));
    this.workingFrames = Array.from({ length: 4 }, (_, index) =>
      load(filenames.has(`working-${index}.png`) ? `working-${index}.png` : 'working.png')
    );
    this.tray = this.deps.createTray(this.brand);
    if (this.deps.platform === 'darwin') this.tray.setIgnoreDoubleClickEvents(true);
    this.tray.setToolTip('Rambo');
    this.renderMenu();
    this.scheduleIdle();
  }

  update(bots: RunningBotIndicator[]): void {
    this.bots = bots;
    const running = bots.some(bot => bot.running);
    const nextMode: TrayMode = running ? 'working' : 'idle';
    if (this.tray) {
      this.renderMenu();
      if (nextMode !== this.mode) {
        this.mode = nextMode;
        this.restartAnimation();
      }
    }
  }

  private renderMenu(): void {
    if (!this.tray) return;
    const items: Array<Record<string, unknown>> = [];
    if (this.bots.length) {
      items.push({ label: 'Bots', enabled: false });
      for (const bot of this.bots.slice(0, 5)) {
        items.push({
          label: `${bot.running ? '● ' : ''}${bot.name}`,
          icon: bot.running ? this.workingFrames[0] : undefined,
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

  private restartAnimation(): void {
    if (this.timer) { this.deps.cancel(this.timer); this.timer = null; }
    if (this.mode === 'working') this.scheduleWorking(0);
    else this.scheduleIdle(0);
  }

  private scheduleIdle(delay = REST_HOLD_MS): void {
    if (this.disposed || this.mode !== 'idle') return;
    this.timer = this.deps.schedule(() => this.paintIdle(), delay);
  }

  private paintIdle(): void {
    if (this.disposed || this.mode !== 'idle' || !this.tray) return;
    const sequence: Array<{ name: string; hold: number }> = [];
    const rest = this.idleFrames.get('rest');
    if (rest) sequence.push({ name: 'rest', hold: REST_HOLD_MS });
    const blinkNames = ['blink-1', 'blink-2', 'blink-3', 'blink-closed', 'blink-open-1', 'blink-open-2', 'blink-overshoot'];
    if (blinkNames.every(name => this.idleFrames.has(name))) {
      sequence.push(...blinkNames.map((name, index) => ({ name, hold: BLINK_HOLDS[index] })));
      sequence.push({ name: 'rest', hold: REST_HOLD_MS });
    }
    const glance = this.deps.random() < 0.5 ? 'glance-left' : 'glance-right';
    if (this.idleFrames.has(`${glance}-in`)) {
      sequence.push(
        { name: `${glance}-in`, hold: 45 },
        { name: `${glance}-hold`, hold: GLANCE_HOLD_MS },
        { name: `${glance}-out`, hold: 45 }
      );
    }
    sequence.push({ name: 'rest', hold: REST_HOLD_MS });
    this.playIdleSequence(sequence, 0);
  }

  private playIdleSequence(sequence: Array<{ name: string; hold: number }>, index: number): void {
    if (this.disposed || this.mode !== 'idle' || !this.tray) return;
    if (index >= sequence.length) {
      this.scheduleIdle();
      return;
    }
    const frame = sequence[index];
    const image = this.idleFrames.get(frame.name);
    if (image) this.tray.setImage(image);
    this.timer = this.deps.schedule(() => this.playIdleSequence(sequence, index + 1), frame.hold);
  }

  private scheduleWorking(index = 0): void {
    if (this.disposed || this.mode !== 'working' || !this.tray) return;
    const image = this.workingFrames[index % this.workingFrames.length];
    if (image) this.tray.setImage(image);
    this.timer = this.deps.schedule(() => this.scheduleWorking((index + 1) % this.workingFrames.length),
      WORKING_HOLDS[index % WORKING_HOLDS.length]);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) this.deps.cancel(this.timer);
    this.timer = null;
    this.tray?.destroy();
    this.tray = null;
  }
}
