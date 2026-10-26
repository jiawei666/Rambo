import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const sourcePath = new URL('../../src/main/system-indicators.ts', import.meta.url);
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

async function loadClass() {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-system-indicators-'));
  const path = join(directory, 'system-indicators.mjs');
  writeFileSync(path, compiled, { mode: 0o600 });
  const { SystemIndicators } = await import(`${pathToFileURL(path).href}?${Date.now()}-${Math.random()}`);
  return { SystemIndicators, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-tray-fixture-'));
  for (const name of [
    '00-rest.png', '01-blink-1.png', '02-blink-2.png', '03-blink-3.png', '04-blink-closed.png',
    '05-blink-open-1.png', '06-blink-open-2.png', '07-blink-overshoot.png',
    '08-glance-left-in.png', '09-glance-left-hold.png', '10-glance-left-out.png',
    '11-glance-right-in.png', '12-glance-right-hold.png', '13-glance-right-out.png',
    'brand.png', 'working.png', 'working-0.png', 'working-1.png', 'working-2.png', 'working-3.png'
  ]) writeFileSync(join(directory, name), name);
  return directory;
}

test('菜单栏空闲时播放多帧眨眼，运行态切换 working 且不显示 Dock 角标', async () => {
  const { SystemIndicators, cleanup } = await loadClass();
  const assetsDirectory = fixture();
  const images = [];
  const loaded = [];
  const menus = [];
  const timers = [];
  const tray = {
    images: [], tooltip: '', menu: null, ignored: false,
    setImage(image) { this.images.push(image); },
    setToolTip(value) { this.tooltip = value; },
    setContextMenu(value) { this.menu = value; menus.push(value); },
    setIgnoreDoubleClickEvents(value) { this.ignored = value; },
    destroy() {}
  };
  const indicators = new SystemIndicators({
    platform: 'darwin', assetsDirectory,
    loadImage: (path, template) => {
      loaded.push({ path, template });
      images.push(path);
      return path;
    },
    createTray: image => { assert.equal(image, join(assetsDirectory, 'brand.png')); return tray; },
    createMenu: items => items,
    showApp() {}, openBot() {}, quit() {},
    schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
    random: () => 0.25
  });
  try {
    indicators.start();
    assert.equal(loaded.length > 0, true);
    assert.equal(loaded.every(item => item.template === true), true);
    assert.equal(tray.tooltip, 'Rambo');
    assert.equal(timers[0].delay, 4_000);
    timers.shift().callback();
    assert.match(tray.images.at(-1), /00-rest\.png$/);
    assert.equal(timers[0].delay, 4_000);
    indicators.update([{ botId: 'bot-1', name: 'Pilot', running: true }]);
    const lastDelay = timers.at(-1).delay;
    assert.equal(lastDelay, 180);
    assert.match(tray.images.at(-1), /working-0\.png$/);
    assert.equal(menus.at(-1)[1].icon !== undefined, true);
    indicators.update([{ botId: 'bot-1', name: 'Pilot', running: false }]);
    assert.equal(timers.at(-1).delay, 0);
    timers.pop().callback();
    assert.match(tray.images.at(-1), /00-rest\.png$/);
    assert.equal(timers.at(-1).delay, 4_000);
  } finally {
    indicators.dispose();
    cleanup();
    rmSync(assetsDirectory, { recursive: true, force: true });
  }
});
